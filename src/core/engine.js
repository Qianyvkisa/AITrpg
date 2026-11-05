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
import { getHandler, summarizeResults } from './directives.js';

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

  // -------------------------------------------------------------------------
  // 组装给 KP 的上下文
  // -------------------------------------------------------------------------
  buildKeeperMessages() {
    const s = this.state;
    const playerChar = s.playerChar ? characterToPrompt(s.playerChar, { full: true }) : '';
    const teammates = (s.teammates || []).map((t) => characterToPrompt(t, { full: true }));

    const sys = keeperSystemPrompt({
      module: s.module?.raw || '',
      scenario: s.scenario,
      playerChar,
      teammates,
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
    await this.runKeeper();
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
      return;
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

    // 把结算结果回喂给 KP（下一轮它才知道骰点）
    const summary = summarizeResults(results);
    if (summary) {
      this.pushMessage({ role: 'system-result', text: summary, hidden: true });
    }

    // 任何指令（包括线索、场景切换）都要刷新界面
    this.emit({ type: 'state-changed' });
  }

  /** 给指令处理器用的上下文，避免它们直接依赖 engine 实例 */
  context() {
    return {
      state: this.state,
      findChar: (name) => this.findChar(name),
      pushMessage: (msg) => this.pushMessage(msg)
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
   */
  async takeTurn(text) {
    const before = this.state.messages.length;
    await this.playerAction(text);

    let chain = 0;
    while (chain < MAX_CHAIN) {
      const newRolls = this.state.messages.slice(before).filter((m) => m.role === 'roll');
      const pending = newRolls.filter((m) => !m.fedBack);
      if (!pending.length) break;

      for (const r of pending) r.fedBack = true;
      chain++;
      await this.runKeeper();
    }

    // KP 说完之后，让队友自发接一句，避免整场只有 KP 在输出
    await this.autoTeammateChatter();

    return chain;
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
