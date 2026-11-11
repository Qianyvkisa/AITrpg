// ---------------------------------------------------------------------------
// 游戏引擎：驱动一次完整的「玩家输入 → KP 叙述 → 检定结算 → 结果回喂」
//
// 职责边界：
//   - 这里只负责流程编排（构建上下文、发起请求、分发指令、续跑）
//   - 具体指令如何结算，交给 directives.js 的处理器
//   - 骰点随机性只在 dice.js 里发生
// ---------------------------------------------------------------------------
import { parseDirectives, splitNarration } from './protocol.js';
import { keeperSystemPrompt } from './prompts.js';
import { characterToPrompt } from './character.js';
import { getHandler, summarizeResults, rollPending } from './directives.js';
import { compactHistory, DEFAULT_HISTORY_BUDGET } from './contextBudget.js';

/** 单轮最多自动续跑几次，防止 AI 反复请求检定导致无限循环 */
const MAX_CHAIN = 3;

/**
 * 喂给 KP 的历史消息条数上限。
 *
 * 这是**第一道**闸门（按条数），第二道是按 token 预算压缩（contextBudget.js）。
 * 两道都要：条数限制防单条超长，token 预算防多条累积超限。
 * 24 条在正常叙述长度下远低于预算，只有超长回复才会触发压缩。
 */
const HISTORY_LIMIT = 24;

export class GameEngine {
  constructor(state, api) {
    this.state = state;   // 全局游戏状态
    this.api = api;       // window.api
    this.listeners = new Set();
    this.requestId = 0;
    // 上一次 KP 请求失败时主进程给出的「人话」说明（如「模型服务暂时不可用」），
    // 供界面层拿来提示玩家，而不是甩一段 HTTP 原文。
    this.lastError = '';
    // 历史部分的 token 预算。超过就压缩（见 contextBudget.js）。
    this.historyBudget = DEFAULT_HISTORY_BUDGET;
    // 上一次构建上下文时的压缩统计，界面拿它显示「省了多少 token」
    this.lastCompactStats = null;
    // 累计 token 用量（来自上游每次响应自报的 usage）
    this.usage = { prompt: 0, completion: 0, total: 0, calls: 0, lastTotal: 0 };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(event) { for (const fn of this.listeners) fn(event); }

  /**
   * 累计一次请求的 token 用量。
   *
   * usage 来自上游流末尾自报（prompt_tokens / completion_tokens / total_tokens）。
   * 不是所有网关都会给——不支持时 usage 为 null，这里就只把 calls 加一，
   * 界面会显示「用量未知」而不是假装 0。
   */
  recordUsage(usage) {
    if (!this.usage) this.usage = { prompt: 0, completion: 0, total: 0, calls: 0, lastTotal: 0 };
    this.usage.calls += 1;

    if (!usage || typeof usage !== 'object') return this.usage;

    const p = Number(usage.prompt_tokens) || 0;
    const c = Number(usage.completion_tokens) || 0;
    const t = Number(usage.total_tokens) || (p + c);

    this.usage.prompt += p;
    this.usage.completion += c;
    this.usage.total += t;
    this.usage.lastTotal = t;
    return this.usage;
  }

  /** 重置累计用量（开新局时调用） */
  resetUsage() {
    this.usage = { prompt: 0, completion: 0, total: 0, calls: 0, lastTotal: 0 };
  }

  // -------------------------------------------------------------------------
  // 消息日志
  // -------------------------------------------------------------------------
  pushMessage(msg) {
    const m = {
      id: 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      ...msg
    };
    this.state.messages.push(m);
    this.emit({ type: 'message', message: m });
    return m;
  }

  /**
   * 就地更新一条已有消息（玩家掷骰后把「待掷骰」占位换成真实结果）。
   * 只改传入的字段，其余保留，避免把 id / ts 冲掉。
   */
  updateMessage(id, patch) {
    const m = this.state.messages.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, patch);
    this.emit({ type: 'message-updated', message: m });
    return m;
  }

  // -------------------------------------------------------------------------
  // 组装给 KP 的上下文
  // -------------------------------------------------------------------------
  buildKeeperMessages() {
    const s = this.state;
    const playerChar = s.playerChar ? characterToPrompt(s.playerChar, { full: true }) : '';
    const teammates = (s.teammates || []).map((t) => characterToPrompt(t, { full: true }));
    // 伙伴不在队里，只给精简档案：KP 需要知道「外面还有谁能赶来」，
    // 但不需要他们的完整技能表占满上下文
    const companions = (s.companions || []).map((c) => characterToPrompt(c, { full: false }));

    const sys = keeperSystemPrompt({
      module: s.module?.raw || '',
      scenario: s.scenario,
      playerChar,
      teammates,
      companions,
      tone: s.tone,
      mode: s.mode || 'player',
      // 自主模式下 KP 不代演队友，提示词要相应改写（否则两边打架）
      teammateAutonomous: s.teammateAutonomous !== false
    });

    const messages = [{ role: 'system', content: sys }];

    const recent = s.messages
      .filter((m) =>
        m.role === 'user' || m.role === 'keeper' || m.role === 'system-result' ||
        // 队友自主行动也要进 KP 的上下文，否则 KP 不知道队友做了什么，
        // 会自己再编一套队友行动——那正是要消灭的「一人分饰多角」
        m.role === 'teammate-action'
      )
      .slice(-HISTORY_LIMIT);

    for (const m of recent) {
      // 历史 KP 消息用 clean 版本（去掉指令），否则 AI 会以为指令还没结算
      const keeperText = m.clean ?? m.text ?? '';

      // _src 指回原始消息：压缩模块要按角色做摘要（检定要知道是谁掷的什么），
      // 只靠 OpenAI 格式的 role/content 分不清「队友行动」和「玩家输入」。
      // 这个字段不会被发给上游（发之前会剥掉，见 compactHistory 的调用处）。
      if (m.role === 'user') {
        if (m.text) messages.push({ role: 'user', content: m.text, _src: m });
      } else if (m.role === 'keeper') {
        if (keeperText) messages.push({ role: 'assistant', content: keeperText, _src: m });  // 跳过空占位
      } else if (m.role === 'system-result') {
        if (m.text) messages.push({ role: 'user', content: `[系统] ${m.text}`, _src: m });
      } else if (m.role === 'teammate-action') {
        // 用 user 角色传入，并显式标注「队友行动」。
        // 若用 assistant，KP 会以为是自己写的，进而以为自己已经代演过队友了。
        messages.push({ role: 'user', content: `[队友行动] ${m.name}：${m.text}`, _src: m });
      }
    }

    // -------------------------------------------------------------------
    // 上下文压缩：存档是精确的，但喂给 AI 的这份要提炼
    //
    // 跑团几百轮后历史会占满窗口，既烧 token 又干扰模型对当前局势的判断。
    // 压缩策略见 contextBudget.js：先滤噪音，再把远端历史折成「前情提要」，
    // 最后才按预算丢最早的。
    //
    // 注意 system prompt（含模组与线索）在 messages[0]，**不参与压缩**——
    // 线索和场景是模型推进剧情的依据，压掉就会开始编。
    // -------------------------------------------------------------------
    const sysMsg = messages.shift();
    const { messages: compacted, stats } = compactHistory(messages, {
      budget: this.historyBudget
    });
    this.lastCompactStats = stats;

    // 剥掉 _src：这是本地用的引用，不该发到上游（多传字段有些服务端会报错）
    for (const m of compacted) delete m._src;

    return [sysMsg, ...compacted];
  }

  // -------------------------------------------------------------------------
  // 主流程：玩家行动 → KP 回复（流式）
  // -------------------------------------------------------------------------
  async playerAction(text) {
    if (!text.trim()) return;
    this.pushMessage({ role: 'user', text });
    this.state.scenario.events.push(`玩家：${text.slice(0, 60)}`);
    return this.runKeeper();
  }

  async runKeeper() {
    const s = this.state;
    const rid = ++this.requestId;

    // 先构建上下文，再把占位消息放进历史，
    // 否则这条还是空字符串的 keeper 消息会被当成历史喂给 AI。
    const messages = this.buildKeeperMessages();

    const msg = this.pushMessage({ role: 'keeper', text: '', streaming: true });
    this.emit({ type: 'stream-start', messageId: msg.id });

    const off = this.api.onChunk(({ requestId, delta }) => {
      if (requestId !== rid) return;
      msg.text += delta;
      this.emit({ type: 'stream-chunk', messageId: msg.id });
    });

    let res;
    try {
      res = await this.api.chat({
        ...s.apiConfig,
        stream: true,
        messages,
        purpose: 'keeper',
        requestId: rid
      });
    } finally {
      off();
      msg.streaming = false;
    }

    if (!res.ok) {
      // 优先用主进程给出的「人话」说明（friendly），它会把 HTTP 502 这类
      // 网关故障翻译成玩家看得懂的话；没有就退回原始错误。
      msg.text = res.canceled
        ? '【已取消】'
        : `【KP 连接失败】${res.friendly || res.error}`;
      msg.error = true;
      // 记在实例上，让 takeTurn 能把「人话」一路带到界面层。
      // 用字段而不是改返回值，是为了不破坏 playerAction 返回 boolean 的既有契约。
      this.lastError = res.friendly || res.error || '';
      this.emit({ type: 'stream-end', messageId: msg.id });
      // 返回 false 让上层知道「这一轮其实没跑成」。
      // 自动推进依赖这个信号：API 挂了却当成正常轮次，会一路空转失败请求。
      return false;
    }
    // 成功了就把上一次的错误清掉，避免后续失败沿用到旧信息
    this.lastError = '';

    // 累计 token 用量。上游在流末尾自报 usage（见 llm.js readStream），
    // 这是唯一能拿到真实消耗的途径——网关没有余额查询接口。
    this.recordUsage(res.usage);

    msg.text = res.text || msg.text;
    this.emit({ type: 'stream-end', messageId: msg.id });

    const { directives, clean, says } = parseDirectives(msg.text);
    msg.clean = clean;
    msg.directives = directives;
    msg.says = says;
    // 切成旁白 / NPC 台词片段，渲染层按它拆气泡
    msg.segments = splitNarration(msg.text);
    this.emit({ type: 'message-updated', message: msg });

    // 同一条消息里的指令只结算一次（防止重复扣血 / 扣 SAN）
    if (directives.length && !msg.resolved) {
      msg.resolved = true;
      await this.resolveDirectives(directives);
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // 指令结算：按类型分发到 directives.js 的处理器
  // -------------------------------------------------------------------------
  async resolveDirectives(directives) {
    const results = [];

    for (const d of directives) {
      const handler = getHandler(d.type);
      if (!handler) continue;
      try {
        results.push(handler(this.context(), d));
      } catch (e) {
        results.push({ text: `【系统】指令 ${d.type} 结算失败：${e.message}`, kind: 'error' });
      }
    }

    // 有待玩家掷骰的检定时，先不把结果回喂给 KP。
    // 否则 KP 会在玩家还没掷骰时就「叙述」一个还没发生的结果，
    // 造成叙事和真实骰点对不上。等玩家掷完再由 rollAndResume 续跑。
    const pending = this.pendingRolls();
    if (pending.length) {
      this.state.awaitingRoll = true;
      this.emit({ type: 'state-changed' });
      this.emit({ type: 'roll-pending', pending });
      return;
    }

    this.feedBackResults(results);
    this.emit({ type: 'state-changed' });
  }

  /** 把结算结果回喂给 KP */
  feedBackResults(results) {
    const summary = summarizeResults(results);
    if (summary) {
      this.pushMessage({ role: 'system-result', text: summary, hidden: true });
    }
  }

  /** 当前所有等待玩家掷骰的检定 */
  pendingRolls() {
    return this.state.messages
      .filter((m) => m.role === 'roll' && m.data && m.data.status === 'pending')
      .map((m) => m.data);
  }

  /**
   * 玩家点「掷骰」后调用：掷骰、结算、把结果回喂 KP 并续跑叙述。
   * @param {string} pendingId 待掷骰的 id
   */
  async rollAndResume(pendingId) {
    const target = this.pendingRolls().find((p) => p.id === pendingId);
    if (!target) return null;

    const r = rollPending(this.context(), target);
    this.emit({ type: 'state-changed' });

    // 还有别的待掷骰就继续等，不要提前续跑
    if (this.pendingRolls().length) return r;

    this.state.awaitingRoll = false;
    this.feedBackResults([r]);
    this.emit({ type: 'state-changed' });

    // 让 KP 接着叙述这次检定的后果
    await this.runKeeper();
    return r;
  }

  /** 给指令处理器用的上下文，避免它们直接依赖 engine 实例 */
  context() {
    return {
      state: this.state,
      findChar: (name) => this.findChar(name),
      pushMessage: (msg) => this.pushMessage(msg),
      updateMessage: (id, patch) => this.updateMessage(id, patch)
    };
  }

  findChar(name) {
    const s = this.state;
    if (!name) return s.playerChar;
    if (s.playerChar && s.playerChar.name === name) return s.playerChar;
    return (s.teammates || []).find((t) => t.name === name) || null;
  }

  /**
   * 一轮完整交互。
   *
   * 流程（自主模式下）：
   *   玩家行动 → KP 叙述 → 队友各自决定行动（每人一次独立 LLM 调用）
   *   → 队友的检定由系统掷骰 → 结果回喂 KP 裁定后果 → 队友补台词
   *
   * 注意：如果产生了「等待玩家掷骰」的检定，本轮到此为止，
   * 不再自动续跑，也不再让队友插话——否则 KP 会在骰点还没掷出时
   * 就叙述一个虚构的结果。玩家掷完骰后由 rollAndResume 接着跑。
   */
  async takeTurn(text) {
    const before = this.state.messages.length;
    // playerAction 会返回 runKeeper 的成败；KP 连不上时不必再往下续跑
    const firstOk = await this.playerAction(text);

    // 有玩家待掷骰：交给界面等玩家点按钮
    if (this.pendingRolls().length) {
      this.emit({ type: 'state-changed' });
      return {
        chain: 0,
        ok: firstOk !== false,
        error: firstOk === false ? (this.lastError || '') : ''
      };
    }

    let chain = 0;
    let ok = firstOk !== false;
    while (chain < MAX_CHAIN) {
      const newRolls = this.state.messages.slice(before).filter((m) => m.role === 'roll');
      const pending = newRolls.filter((m) => !m.fedBack);
      if (!pending.length) break;

      for (const r of pending) r.fedBack = true;
      chain++;
      const stepOk = await this.runKeeper();
      if (stepOk === false) { ok = false; break; }
    }

    // ---------------------------------------------------------------------
    // 队友自主行动
    //
    // 放在 KP 叙述之后、队友补台词之前：先让队友对**刚发生的局面**做出
    // 行动决策，再让 KP 裁定后果，最后才是可有可无的插话。
    //
    // 顺序不能反：若先插话再行动，队友会先评论一句、再回头去做事，
    // 读起来像先表态后思考，很不自然。
    // ---------------------------------------------------------------------
    if (ok) {
      const acted = await this.runTeammateActions();
      if (acted) ok = true;   // 队友行动失败不影响本轮整体成败
    }

    // KP 说完之后，让队友自发接一句，避免整场只有 KP 在输出
    if (ok) await this.autoTeammateChatter();

    return { chain, ok, error: ok ? '' : (this.lastError || '') };
  }

  /**
   * 让队友自主行动一轮。
   *
   * 由外部注入 actor（要调 LLM，引擎不直接依赖 api 细节），
   * 与 teammateSpeaker 同样的注入思路。
   *
   * 每条队友行动的处理顺序：
   *   1) 记录「[队友行动]」消息（会进 KP 上下文，KP 据此裁定）
   *   2) 结算它请求的检定（骰点由本地掷，AI 不能编）
   *   3) 若产生待掷骰，停下来交给界面
   *
   * @returns {Promise<boolean>} 是否真的有人行动了
   */
  async runTeammateActions() {
    const s = this.state;
    const actor = this.teammateActor;
    if (!actor) return false;

    // 开关 / 概率 / 剧情结束 等判断都在注入的实现里，
    // 引擎只负责「拿到谁要行动，就编排谁」。
    let plans;
    try {
      plans = await actor();
    } catch (e) {
      this.pushMessage({
        role: 'system',
        text: `【队友 AI 失败】${e.message}`,
        hidden: true
      });
      return false;
    }

    if (!Array.isArray(plans) || !plans.length) return false;

    let anyActed = false;

    for (const plan of plans) {
      if (!plan?.ok) continue;

      // 行动消息通常已由注入方推送过了（因为它要让后续队友看到前面的行动，
      // 必须边生成边落进消息流）。只有没推过的才在这里补推，避免出现两条一样的。
      if (!plan.alreadyPushed) {
        this.pushMessage({
          role: 'teammate-action',
          name: plan.name,
          text: plan.text
        });
        s.scenario.events.push(`队友·${plan.name}：${String(plan.text).slice(0, 60)}`);
      }
      anyActed = true;

      // 结算它请求的检定。指令里的角色名已在生成阶段补好，
      // 这里直接复用 directives 的统一结算链路。
      if (plan.directives?.length) {
        await this.resolveDirectives(plan.directives);
      }

      // 出现待玩家掷骰就停下，别继续推进——否则后面的队友行动
      // 会建立在一个还没掷出的骰点之上
      if (this.pendingRolls().length) {
        this.emit({ type: 'state-changed' });
        break;
      }
    }

    // 有队友行动过、且没在等骰，就让 KP 裁定这些行动的后果
    if (anyActed && !this.pendingRolls().length) {
      await this.runKeeper();
    }

    return anyActed;
  }

  /** 注入队友行动实现（app.js 里绑定，避免引擎直接调 LLM） */
  setTeammateActor(fn) {
    this.teammateActor = fn;
  }

  /**
   * 自动队友发言。
   *
   * 由外部注入 speaker（因为要调 LLM，引擎不该直接依赖 api 细节），
   * 这里只负责「该不该说」的判断，避免每轮都刷屏。
   */
  async autoTeammateChatter() {
    const s = this.state;
    const speaker = this.teammateSpeaker;
    if (!speaker) return;

    const teammates = s.teammates || [];
    if (!teammates.length) return;

    // 设置里关掉了就不说
    if (s.autoTeammate === false) return;

    // 剧情已经结束就别再说了
    if (s.scenario?.ended) return;

    // 按概率决定说不说：默认 0.7，让对话有节奏而不是每轮必插
    const rate = Number.isFinite(s.teammateChance) ? s.teammateChance : 0.7;
    if (Math.random() > rate) return;

    // 上一轮已经连续插了很多句就歇一下（最多连 2 句）
    const recent = s.messages.slice(-4).filter((m) => m.role === 'teammate');
    if (recent.length >= 2) return;

    try {
      await speaker();
    } catch (e) {
      // 队友说崩了不该影响主流程
      this.pushMessage({ role: 'system', text: `【队友 AI 失败】${e.message}`, hidden: true });
    }
  }

  /** 注入队友发言实现（app.js 里绑定，避免引擎直接调 LLM） */
  setTeammateSpeaker(fn) {
    this.teammateSpeaker = fn;
  }
}
