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

/** 单轮最多自动续跑几次，防止 AI 反复请求检定导致无限循环 */
const MAX_CHAIN = 3;

/** 喂给 KP 的历史消息条数上限，控制 token 消耗 */
const HISTORY_LIMIT = 24;

export class GameEngine {
  constructor(state, api) {
    this.state = state;   // 全局游戏状态
    this.api = api;       // window.api
    this.listeners = new Set();
    this.requestId = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(event) { for (const fn of this.listeners) fn(event); }

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
      mode: s.mode || 'player'
    });

    const messages = [{ role: 'system', content: sys }];

    const recent = s.messages
      .filter((m) => m.role === 'user' || m.role === 'keeper' || m.role === 'system-result')
      .slice(-HISTORY_LIMIT);

    for (const m of recent) {
      // 历史 KP 消息用 clean 版本（去掉指令），否则 AI 会以为指令还没结算
      const keeperText = m.clean ?? m.text ?? '';

      if (m.role === 'user') {
        if (m.text) messages.push({ role: 'user', content: m.text });
      } else if (m.role === 'keeper') {
        if (keeperText) messages.push({ role: 'assistant', content: keeperText });  // 跳过空占位
      } else if (m.role === 'system-result') {
        if (m.text) messages.push({ role: 'user', content: `[系统] ${m.text}` });
      }
    }

    return messages;
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
      msg.text = res.canceled ? '【已取消】' : `【KP 连接失败】${res.error}`;
      msg.error = true;
      this.emit({ type: 'stream-end', messageId: msg.id });
      // 返回 false 让上层知道「这一轮其实没跑成」。
      // 自动推进依赖这个信号：API 挂了却当成正常轮次，会一路空转 200 次失败请求。
      return false;
    }

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
   * 一轮完整交互：玩家行动 → KP 叙述 → 若产生检定则自动续跑叙述结果。
   * 续跑有次数上限。之后按配置让队友自发接话。
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
      return { chain: 0, ok: firstOk !== false };
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

    // KP 说完之后，让队友自发接一句，避免整场只有 KP 在输出
    if (ok) await this.autoTeammateChatter();

    return { chain, ok };
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
