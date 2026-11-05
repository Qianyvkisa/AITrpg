// ---------------------------------------------------------------------------
// AI ↔ 规则引擎 协议
// AI 只能"请求检定"，不能自己出结果。所有骰点由本地引擎掷。
// ---------------------------------------------------------------------------

/**
 * 指令语法（写在 AI 回复里，独占一行）：
 *
 *   [[CHECK: 技能名 | 角色=名字 | 难度=常规|困难|极难 | 原因=一句话]]
 *   [[SAN: 损失表达式 | 角色=名字 | 原因=一句话]]        例 [[SAN: 1/1d6 | 角色=林默 | 原因=看见尸体]]
 *   [[DAMAGE: 1d6+db | 角色=名字 | 原因=一句话]]
 *   [[HP: -3 | 角色=名字 | 原因=...]]                   直接改 HP
 *   [[ITEM: +手电筒 | 角色=名字]]                        获得/失去物品（- 表示失去）
 *   [[FLAG: 关键线索=名字叫唤者 ]]                        记录剧情标记
 *   [[SCENE: 场景名]]                                    进入新场景
 *   [[END: 结局描述]]                                    模组结束
 */

const DIRECTIVE_RE = /\[\[(CHECK|SAN|DAMAGE|HP|MP|ITEM|FLAG|SCENE|END|NPC|TIME|CLUE):([^\]]*)\]\]/g;

/**
 * NPC 台词指令：[[SAY: 角色名 | 台词]]
 *
 * KP 扮演的 NPC（酒保、警长、老教授……）用它说话，
 * 渲染时单独成一条气泡，和 KP 的旁白分开，读起来像群里几个人在对话，
 * 而不是 KP 一个人写满屏。
 *
 * 台词里允许出现 |，所以只有第一个 | 用来分隔角色名和内容。
 * 角色名可以带前缀区分身份：
 *   [[SAY: 酒保 | ...]]      普通 NPC
 *   [[SAY: NPC·旅店老板 | ...]] 显式标注
 */
const SAY_RE = /\[\[SAY:([^\]]*)\]\]/g;

/** 解析一条 SAY 指令的正文，返回 { name, text } 或 null */
function parseSayBody(body) {
  const raw = String(body || '').trim();
  if (!raw) return null;

  const bar = raw.indexOf('|');
  // 没有分隔符时整段当台词，角色名留空由调用方兜底
  if (bar === -1) return { name: '', text: raw };

  const name = raw.slice(0, bar).trim();
  const text = raw.slice(bar + 1).trim();
  if (!text) return null;
  return { name, text };
}

export function parseDirectives(text) {
  const directives = [];
  const says = [];
  let clean = String(text ?? '');

  // 先抽 NPC 台词：它要单独成气泡，不属于「指令结算」
  for (const m of clean.matchAll(SAY_RE)) {
    const [full, body] = m;
    const parsed = parseSayBody(body);
    if (parsed) says.push(parsed);
    clean = clean.replace(full, '');
  }

  for (const m of clean.matchAll(DIRECTIVE_RE)) {
    const [full, type, bodyRaw] = m;
    const body = bodyRaw.trim();
    const parts = body.split('|').map((s) => s.trim());

    const head = parts[0] ?? '';
    const opts = {};
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      const eq = seg.indexOf('=');
      if (eq === -1) {
        opts[seg] = true;
      } else {
        opts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
      }
    }

    // FLAG 允许写成 [[FLAG: 键=值]]，此时把键值拆开，head 只留内容
    let finalHead = head;
    let finalOpts = opts;
    if (type === 'FLAG' && !opts['关键线索']) {
      const kv = head.match(/^([^=]{1,20})=(.+)$/);
      if (kv) {
        finalHead = kv[2].trim();
        finalOpts = { ...opts, 关键线索: kv[1].trim() };
      }
    }

    directives.push({ type, head: finalHead, opts: finalOpts, raw: full });
    clean = clean.replace(full, '');
  }

  clean = clean.replace(/\n{3,}/g, '\n\n').trim();
  return { directives, clean, says };
}

/** 难度 → 技能值调整 */
export function difficultyToSkill(baseSkill, difficulty) {
  const d = String(difficulty || '常规');
  if (d.includes('极难')) return Math.floor(baseSkill / 5);
  if (d.includes('困难')) return Math.floor(baseSkill / 2);
  return baseSkill;
}

/** 把检定指令翻译成给玩家看的文字 */
export function describeCheck(c) {
  const who = c.opts['角色'] || '调查员';
  const diff = c.opts['难度'] || '常规';
  const reason = c.opts['原因'] || '';
  const diffText = diff === '常规' ? '' : `（${diff}难度）`;
  return `${who} 进行 ${c.head} 检定${diffText}${reason ? '：' + reason : ''}`;
}

/** 构造检定结果回喂给 AI 的文本 */
export function formatCheckResult({ who, skill, difficulty, adjusted, roll, level }) {
  const lines = [
    `【检定结果】${who} · ${skill}${difficulty !== '常规' ? `（${difficulty}）` : ''}`,
    `目标值 ${adjusted}，掷骰 ${roll.value}${roll.bonusPenaltyLabel ? ' ' + roll.bonusPenaltyLabel : ''} → ${level.label}`
  ];
  if (level.level === 'critical') lines.push('※ 大成功：应给予额外线索或超预期效果');
  if (level.level === 'fumble') lines.push('※ 大失败：应加入额外恶果');
  return lines.join('\n');
}

/** SAN 结果回喂 */
export function formatSanResult({ who, loss, before, after, tempMadness, indefinite, bout }) {
  const lines = [
    `【理智检定】${who}：损失 ${loss} 点 SAN（${before} → ${after}）`
  ];
  if (bout) lines.push('※ 单次损失≥5，触发临时疯狂，需要 INT 检定决定是否陷入疯狂发作');
  if (indefinite) lines.push('※ 单次损失达当前 SAN 的 1/5，构成不定时疯狂');
  if (after <= 0) lines.push('※ SAN 归零：永久疯狂');
  else if (after <= 20) lines.push('※ SAN ≤20：濒临疯狂');
  return lines.join('\n');
}

/** 从一段文本里提取所有 [[...]] 指令的类型，便于 UI 折叠展示 */
export function summarizeDirectives(directives) {
  return directives.map((d) => {
    switch (d.type) {
      case 'CHECK': return `检定 ${d.head}`;
      case 'SAN': return `理智 ${d.head}`;
      case 'DAMAGE': return `伤害 ${d.head}`;
      case 'HP': return `HP ${d.head}`;
      case 'ITEM': return `物品 ${d.head}`;
      case 'FLAG': return `标记 ${d.head}`;
      case 'SCENE': return `场景 ${d.head}`;
      case 'END': return '结束';
      default: return d.type;
    }
  });
}

export { parseSayBody };

/**
 * 把一段 KP 回复切成「旁白 / NPC 台词」交替的片段，保持原文顺序。
 *
 * 例：`他擦着杯子。[[SAY: 酒保 | 要来点什么？]]窗外雨还在下。`
 *  → [{kind:'prose', text:'他擦着杯子。'},
 *     {kind:'say', name:'酒保', text:'要来点什么？'},
 *     {kind:'prose', text:'窗外雨还在下。'}]
 *
 * 空片段会被丢掉，避免出现空气泡。
 */
export function splitNarration(text) {
  const raw = String(text ?? '');
  const out = [];
  let last = 0;

  for (const m of raw.matchAll(SAY_RE)) {
    const [full, body] = m;
    const at = m.index ?? 0;
    const parsed = parseSayBody(body);
    const prose = raw.slice(last, at).trim();
    if (prose) out.push({ kind: 'prose', text: prose });
    if (parsed) out.push({ kind: 'say', name: parsed.name, text: parsed.text });
    last = at + full.length;
  }

  const tail = raw.slice(last).trim();
  if (tail) out.push({ kind: 'prose', text: tail });

  // 旁白里可能还留着 [[CHECK]] 之类的结算指令，展示前统一剥掉
  return out
    .map((seg) =>
      seg.kind === 'prose'
        ? { ...seg, text: stripPartialDirective(seg.text).replace(/\n{3,}/g, '\n\n').trim() }
        : seg
    )
    .filter((seg) => seg.text);
}

/**
 * 剥掉未闭合的指令残片。
 *
 * 流式输出时，`[[SAY: 酒保 | 要来` 这种半截指令会短暂出现在气泡里，
 * 玩家会看到一堆 [[SAY 之类的乱码。这里把从 `[[` 开始、
 * 还没等到 `]]` 的尾巴整段丢掉，等指令闭合后再正常解析。
 */
function stripPartialDirective(text) {
  const s = String(text ?? '');
  // 完整指令先剥干净
  let out = s.replace(/\[\[[^\]]*\]\]/g, '');
  // 再砍掉未闭合的尾巴：最后一个 [[ 之后没有 ]]
  const open = out.lastIndexOf('[[');
  if (open !== -1 && out.indexOf(']]', open) === -1) {
    out = out.slice(0, open);
  }
  return out;
}
