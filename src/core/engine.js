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
import { cancelPendingRoll, getHandler, pendingCharacter, rollBlocker, rollPending, summarizeResults, waitsForWoundCheck } from './directives.js';
import { incapacity, partyEnding } from './vitals.js';
import { compactHistory, DEFAULT_HISTORY_BUDGET } from './contextBudget.js';
import { rememberInvestigation, selectInvestigation, selectModuleText } from './investigation.js';
import { checkModuleReply, describeModuleProgress, readModuleGuide } from './moduleGuide.js';

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
    this.activeNarration = null;
    this.narrationCanceled = false;
    this.narrationTimedOut = false;
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
  buildKeeperMessages(guide = readModuleGuide(this.state.module), correction = '') {
    const s = this.state;
    const playerChar = s.playerChar ? characterToPrompt(s.playerChar, { full: true }) : '';
    const aiTeammates = (s.teammates || []).filter((t) => !this.rollOwner?.(t));
    const teammates = aiTeammates.map((t) => characterToPrompt(t, { full: true }));
    const guests = (s.teammates || []).filter((t) => !aiTeammates.includes(t));
    const investigator = [s.playerChar, ...guests].find((ch) => ch?.id === s.turnActorId);
    const lastAction = s.messages.findLast((m) => m.role === 'user' && !m.hidden);
    const focus = [s.scenario.scene, lastAction?.text, ...(s.scenario.events || []).slice(-3)].join('\n');
    // 伙伴不在队里，只给精简档案：KP 需要知道「外面还有谁能赶来」，
    // 但不需要他们的完整技能表占满上下文
    const companions = (s.companions || []).map((c) => characterToPrompt(c, { full: false }));

    const sys = keeperSystemPrompt({
      module: guide ? selectModuleText(guide.source, focus) : '',
      moduleReference: guide?.reference.slice(0, 3200),
      moduleProgress: describeModuleProgress(guide, s.scenario.scene),
      moduleCorrection: correction || s.keeperContinuation?.moduleCorrection,
      investigation: selectInvestigation(s.scenario, focus),
      scenario: s.scenario,
      playerChar,
      guests: guests.map((t) => characterToPrompt({ ...t, isPlayer: true }, { full: true })),
      actingInvestigator: investigator?.name,
      teammates,
      companions,
      tone: s.tone,
      mode: s.mode === 'spectator' || (!investigator && incapacity(s.playerChar)) ? 'spectator' : 'player',
      // 自主模式下 KP 不代演队友，提示词要相应改写（否则两边打架）
      teammateAutonomous: s.teammateAutonomous !== false
    });

    const messages = [{ role: 'system', content: sys }];

    const recent = s.messages
      .filter((m) =>
        m.role === 'user' || (m.role === 'keeper' && !m.error && !m.streaming) || m.role === 'system-result' ||
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
    // 续跑的整批骰点要原样交还给守密人，即使历史需要压缩。
    const feedbackId = s.keeperContinuation?.feedbackId;
    const feedbackIndex = feedbackId ? messages.findIndex((m) => m._src?.id === feedbackId) : -1;
    const feedback = feedbackIndex >= 0 ? messages.splice(feedbackIndex, 1)[0] : null;
    const { messages: compacted, stats } = compactHistory(messages, {
      budget: this.historyBudget
    });
    if (feedback) compacted.push(feedback);
    this.lastCompactStats = stats;

    // 剥掉 _src：这是本地用的引用，不该发到上游（多传字段有些服务端会报错）
    for (const m of compacted) delete m._src;

    return [sysMsg, ...compacted];
  }

  // -------------------------------------------------------------------------
  // 主流程：玩家行动 → KP 回复（流式）
  // -------------------------------------------------------------------------
  /**
   * @param {string} text 玩家行动
   * @param {{hidden?: boolean}} [opts]
   *   hidden=true：这条消息**不显示在界面上**，但仍然留在上下文里喂给 AI。
   *   自动推进用的「继续推进」是程序生成的占位语，不是玩家真的打了字；
   *   把它当成玩家发言显示出来很出戏（玩家会看到自己"说"了句没说过的话）。
   *   但它必须留在上下文里，否则 AI 不知道这一轮是要它往下推。
   */
  async playerAction(text, opts = {}) {
    if (!text.trim()) return;
    this.state.turnActorId = opts.actorId || (opts.hidden ? '' : this.state.playerChar?.id) || '';
    this.pushMessage(opts.hidden ? { role: 'user', text, hidden: true } : { role: 'user', text });
    // 场景事件记录同理：自动推进不记成「玩家做了什么」，
    // 否则场景摘要里会堆满「玩家：继续推进剧情」这种无信息量的条目。
    if (!opts.hidden) this.state.scenario.events.push(`玩家：${text.slice(0, 60)}`);
    this.state.keeperContinuation = { retryAction: true };
    return this.runKeeper();
  }

  async requestNarration(payload, label, onChunk) {
    const request = { id: ++this.requestId, canceled: false };
    this.activeNarration = request;
    this.emit({ type: 'narration-status', label });
    let draft = '';
    const off = onChunk && this.api.onChunk(({ requestId, delta }) => {
      if (requestId !== request.id || request.canceled) return;
      if (!draft) this.emit({ type: 'narration-status', label: '守密人正在生成正文' });
      draft += delta;
      onChunk(draft);
    });
    try {
      const res = await this.api.chat({ ...payload, requestId: request.id });
      if (request.canceled) return { ok: false, canceled: true, error: '已停止等待' };
      if (res.timedOut) this.narrationTimedOut = true;
      if (res.ok && payload.purpose === 'keeper') this.recordUsage(res.usage);
      return { ...res, text: res.text || draft };
    } catch (e) {
      if (request.canceled) return { ok: false, canceled: true, error: '已停止等待' };
      return { ok: false, error: e?.message || String(e) };
    } finally {
      if (off) off();
      this.activeNarration = null;
      this.emit({ type: 'narration-status', label: '' });
    }
  }

  async cancelNarration() {
    const request = this.activeNarration;
    if (!request || request.canceled) return;
    request.canceled = this.narrationCanceled = true;
    this.emit({ type: 'narration-status', label: '正在停止', stopping: true });
    await this.api.cancel?.(request.id);
  }

  async runKeeper() {
    const s = this.state;
    if (s.scenario.ended) return false;
    const guide = readModuleGuide(s.module);
    const live = guide ? null : this.pushMessage({ role: 'keeper', text: '', streaming: true });
    if (live) this.emit({ type: 'stream-start', messageId: live.id });

    let res;
    let parsed;
    let correction = '';
    const deadline = Date.now() + 50000;
    // 模组草稿验证通过前只显示等待状态。失败只重写一次，避免消耗失控。
    for (let attempt = 0; attempt < (guide ? 2 : 1); attempt++) {
      const messages = this.buildKeeperMessages(guide, correction);
      res = await this.requestNarration({
        ...s.apiConfig, stream: true, messages, purpose: 'keeper',
        timeoutMs: Math.max(1, deadline - Date.now())
      }, attempt ? '守密人正在按模组重写' : '等待守密人响应', draft => {
        if (!live) return;
        live.text = draft;
        this.emit({ type: 'stream-chunk', messageId: live.id });
      });
      if (!res.ok) break;
      parsed = parseDirectives(res.text);
      correction = guide ? checkModuleReply(guide, s.scenario.scene, parsed) : '';
      if (!correction) break;
    }
    if (res.ok && correction) {
      s.keeperContinuation = { ...s.keeperContinuation, moduleCorrection: correction };
      this.lastError = '守密人回复未通过模组流程校验。';
      this.pushMessage({ role: 'keeper', error: true, text: '【叙事已暂停】守密人回复未通过模组流程校验。已保留本轮行动与检定结果，可点击「继续叙事」。' });
      return false;
    }

    if (!res.ok) {
      // 优先用主进程给出的「人话」说明（friendly），它会把 HTTP 502 这类
      // 网关故障翻译成玩家看得懂的话；没有就退回原始错误。
      const text = res.canceled
        ? '【已停止等待】本轮进度已保留，可以继续叙事。'
        : `【KP 连接失败】${res.friendly || res.error}`;
      // 记在实例上，让 takeTurn 能把「人话」一路带到界面层。
      // 用字段而不是改返回值，是为了不破坏 playerAction 返回 boolean 的既有契约。
      this.lastError = res.friendly || res.error || '';
      if (live) {
        Object.assign(live, { text, error: true, streaming: false });
        this.emit({ type: 'stream-end', messageId: live.id });
      } else {
        this.pushMessage({ role: 'keeper', text, error: true });
      }
      // 返回 false 让上层知道「这一轮其实没跑成」。
      // 自动推进依赖这个信号：API 挂了却当成正常轮次，会一路空转失败请求。
      return false;
    }
    // 成功了就把上一次的错误清掉，避免后续失败沿用到旧信息
    this.lastError = '';
    s.keeperContinuation = null;

    const { directives, clean, says } = parsed;
    // 切成旁白 / NPC 台词片段，渲染层按它拆气泡
    const settled = { text: res.text, clean, directives, says, segments: splitNarration(res.text), streaming: false };
    const msg = live ? Object.assign(live, settled) : this.pushMessage({ role: 'keeper', ...settled });
    if (live) {
      this.emit({ type: 'stream-end', messageId: msg.id });
      this.emit({ type: 'message-updated', message: msg });
    }

    // 同一条消息里的指令只结算一次（防止重复扣血 / 扣 SAN）
    const scene = s.scenario.scene;
    const clueCount = s.scenario.clues.length;
    if (directives.length && !msg.resolved) {
      msg.resolved = true;
      await this.resolveDirectives(directives);
    }
    const action = s.messages.findLast((message) => message.role === 'user' && !message.hidden)?.text;
    rememberInvestigation(s.scenario, scene, msg, s.scenario.clues.slice(clueCount), action);

    return true;
  }

  // -------------------------------------------------------------------------
  // 指令结算：按类型分发到 directives.js 的处理器
  // -------------------------------------------------------------------------
  async resolveDirectives(directives) {
    const results = [];

    for (const d of directives) {
      if (this.state.scenario.ended) break;
      const handler = getHandler(d.type);
      if (!handler) continue;
      try {
        const result = handler(this.context(), d);
        if (result?.followUp) {
          const { followUp, ...damage } = result;
          results.push(damage, followUp);
        } else {
          results.push(result);
        }
      } catch (e) {
        results.push({ text: `【系统】指令 ${d.type} 结算失败：${e.message}`, kind: 'error' });
      }
    }

    // 有待玩家掷骰的检定时，先不把结果回喂给 KP。
    // 否则 KP 会在玩家还没掷骰时就「叙述」一个还没发生的结果，
    // 造成叙事和真实骰点对不上。等玩家掷完再由 rollAndResume 续跑。
    this.reconcileParty({ settleBatch: false });
    const pending = this.pendingRolls();
    if (pending.length) {
      this.state.rollBatch = results.filter(Boolean).map((result) => result.status === 'pending'
        ? { pendingId: result.id } : { result });
      this.state.awaitingRoll = true;
      this.emit({ type: 'state-changed' });
      this.emit({ type: 'roll-pending', pending });
      return;
    }

    const feedback = this.feedBackResults(results);
    if (!this.state.scenario.ended && results.some((r) => r?.status === 'rolled' || (r?.kind === 'damage' && r.dmg > 0))) {
      this.state.keeperContinuation = { feedbackId: feedback?.id };
    }
    this.emit({ type: 'state-changed' });
  }

  /** 把结算结果回喂给 KP */
  feedBackResults(results) {
    const summary = summarizeResults(results);
    if (summary) {
      return this.pushMessage({ role: 'system-result', text: summary, hidden: true });
    }
  }

  /** 当前所有等待玩家掷骰的检定 */
  pendingRolls() {
    return this.state.messages
      .filter((m) => m.role === 'roll' && m.data && m.data.status === 'pending')
      .map((m) => m.data);
  }

  /** 终局和读档共用同一套清理逻辑，过期的掷骰不能锁住后续行动。 */
  reconcileParty({ settleBatch = true } = {}) {
    const s = this.state;
    const context = this.context();
    const ending = !s.scenario.ended && partyEnding(s);
    if (ending) getHandler('END')(context, { head: ending });

    const cancelled = [];
    for (const message of s.messages) {
      const roll = message.data;
      if (message.role !== 'roll' || roll?.status !== 'pending') continue;
      roll.messageId ??= message.id;
      const reason = s.scenario.ended ? '调查已经结束' : rollBlocker(pendingCharacter(context, roll), roll);
      if (reason) cancelled.push(cancelPendingRoll(context, roll, reason));
    }

    s.awaitingRoll = this.pendingRolls().length > 0;
    const staleEnd = s.scenario.ended && (s.rollBatch || s.keeperContinuation);
    if (s.scenario.ended) {
      s.rollBatch = null;
      s.keeperContinuation = null;
    } else if (cancelled.length && s.rollBatch) {
      for (const roll of cancelled) {
        const entry = s.rollBatch.find(({ pendingId }) => pendingId === roll.id);
        if (entry) entry.result = roll;
      }
    }
    if (settleBatch && !s.awaitingRoll && !s.scenario.ended) this.finishRollBatch();
    return !!(ending || cancelled.length || staleEnd);
  }

  finishRollBatch() {
    const s = this.state;
    if (!s.rollBatch) return;
    const feedback = this.feedBackResults(s.rollBatch.map((item) => item.result));
    s.rollBatch = null;
    s.keeperContinuation = { feedbackId: feedback?.id };
  }

  /**
   * 玩家点「掷骰」后调用：掷骰、结算、把结果回喂 KP 并续跑叙述。
   * @param {string} pendingId 待掷骰的 id
   */
  async rollAndResume(pendingId) {
    this.reconcileParty();
    const pending = this.pendingRolls();
    const target = pending.find((p) => p.id === pendingId);
    if (!target || waitsForWoundCheck(target, pending)) return null;

    const s = this.state;
    // 旧存档的待掷骰没有批次信息，仍可继续结算。
    if (!s.rollBatch) {
      const keeperIndex = s.messages.findLastIndex((message) => message.role === 'keeper');
      const recentRolls = s.messages.slice(keeperIndex + 1)
        .filter((message) => message.role === 'roll' && message.data && message.data.status !== 'pending');
      s.rollBatch = [
        ...recentRolls.map((message) => ({ result: message.data })),
        ...pending.map((p) => ({ pendingId: p.id }))
      ];
    }
    const r = rollPending(this.context(), target);
    if (!r) return null;
    const entry = s.rollBatch.find((item) => item.pendingId === pendingId);
    if (entry) entry.result = r;
    else s.rollBatch.push({ result: r });

    this.reconcileParty({ settleBatch: false });
    if (!s.awaitingRoll && !s.scenario.ended) this.finishRollBatch();
    this.emit({ type: 'state-changed' });

    if (s.keeperContinuation) await this.resumeKeeper();
    else await this.checkpoint?.();
    return r;
  }

  /** 先落盘结算，再续写。失败时保留续写标记供下次重试。 */
  async resumeKeeper() {
    if (this.state.scenario.ended) return { chain: 0, ok: false, error: '本次调查已结束。' };
    let chain = 0;
    while (this.state.keeperContinuation && !this.pendingRolls().length && chain < MAX_CHAIN) {
      await this.checkpoint?.();
      chain++;
      if (!await this.runKeeper()) return { chain, ok: false, error: this.lastError };
    }
    if (this.state.keeperContinuation && !this.pendingRolls().length) {
      await this.checkpoint?.();
      return { chain, ok: false, error: '本轮检定次数较多，请手动继续叙事。' };
    }
    return { chain, ok: true, error: '' };
  }

  /** 给指令处理器用的上下文，避免它们直接依赖 engine 实例 */
  context() {
    return {
      state: this.state,
      findChar: (name) => this.findChar(name),
      findCharById: (id) => this.findCharById(id),
      rollOwner: this.rollOwner,
      pushMessage: (msg) => this.pushMessage(msg),
      updateMessage: (id, patch) => this.updateMessage(id, patch)
    };
  }

  findChar(name) {
    const s = this.state;
    if (!name) return s.playerChar;
    const active = this.findCharById(s.turnActorId);
    if (active?.name === name) return active;
    if (s.playerChar && s.playerChar.name === name) return s.playerChar;
    return (s.teammates || []).find((t) => t.name === name) || null;
  }

  findCharById(id) {
    if (!id) return null;
    if (this.state.playerChar?.id === id) return this.state.playerChar;
    return (this.state.teammates || []).find((character) => character.id === id) || null;
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
  async takeTurn(text, opts = {}) {
    this.narrationCanceled = false;
    this.narrationTimedOut = false;
    this.reconcileParty();
    const s = this.state;
    if (s.scenario.ended) return { chain: 0, ok: false, error: '本次调查已结束。' };
    if (this.pendingRolls().length) return { chain: 0, ok: false, error: '请先完成待掷骰。' };
    const retry = s.keeperContinuation;
    if (retry && !retry.retryAction) return this.resumeKeeper();
    const actor = opts.actorId ? this.findCharById(opts.actorId) : s.playerChar;
    const blocked = incapacity(actor);
    if (!retry && ((opts.actorId && !actor) || (blocked && (opts.actorId || !opts.hidden)))) {
      return { chain: 0, ok: false, error: blocked ? `${actor.name}（${blocked}）无法行动。` : '找不到行动中的调查员。' };
    }
    if (!retry && !text.trim()) return { chain: 0, ok: false, error: '请输入调查行动。' };
    const firstOk = retry ? await this.runKeeper() : await this.playerAction(text, opts);
    if (firstOk === false) return { chain: 0, ok: false, error: this.lastError };
    s.turns = (Number(s.turns) || 0) + 1;
    if (s.scenario.ended) return { chain: 0, ok: true, error: '' };
    const result = await this.resumeKeeper();
    if (!result.ok || this.pendingRolls().length || this.state.scenario.ended) return result;
    const acted = await this.runTeammateActions();
    if (s.keeperContinuation && !s.awaitingRoll) {
      return { chain: result.chain, ok: false, error: this.lastError || '队友行动尚未完成续写。' };
    }
    if (!acted && !this.narrationCanceled && !this.narrationTimedOut &&
        !this.pendingRolls().length && !this.state.keeperContinuation) {
      await this.autoTeammateChatter();
    }
    return result;
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
      const performer = plan.charId ? this.findCharById(plan.charId) : this.findChar(plan.name);
      if (incapacity(performer)) continue;

      // 行动消息通常已由注入方推送过了（因为它要让后续队友看到前面的行动，
      // 必须边生成边落进消息流）。只有没推过的才在这里补推，避免出现两条一样的。
      if (!plan.alreadyPushed) {
        this.pushMessage({
          role: 'teammate-action',
          name: plan.name,
          text: plan.text
        });
      }
      s.scenario.events.push(`队友·${plan.name}：${String(plan.text).slice(0, 60)}`);
      anyActed = true;

      // 结算它请求的检定。指令里的角色名已在生成阶段补好，
      // 这里直接复用 directives 的统一结算链路。
      if (plan.directives?.length) {
        await this.resolveDirectives(plan.directives);
      }

      // 出现待玩家掷骰就停下，别继续推进——否则后面的队友行动
      // 会建立在一个还没掷出的骰点之上
      if (s.scenario.ended || this.pendingRolls().length) {
        this.emit({ type: 'state-changed' });
        break;
      }
    }

    // 有队友行动过、且没在等骰，就让 KP 裁定这些行动的后果
    if (anyActed && !this.pendingRolls().length) {
      if (!s.scenario.ended) s.keeperContinuation ??= {};
      await this.resumeKeeper();
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

    if (!(s.teammates || []).some((character) => !incapacity(character) && !this.rollOwner?.(character))) return;

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
