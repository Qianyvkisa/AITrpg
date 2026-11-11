// ---------------------------------------------------------------------------
// 跑团记录导出（replay）
//
// 目标：导出的 txt 要能直接拿去做 replay / 视频脚本 / 存档留底，所以
// **谁说了什么、谁做了什么、掷了什么骰** 必须一目了然，不能只是把 text
// 字段按顺序堆在一起。
//
// 三类信息要区分清楚：
//   1) KP 的旁白        → 纯叙述，不加前缀（加了反而像旁白在说话）
//   2) NPC / 队友的台词 → 必须标出说话人，否则读起来分不清谁在说
//   3) 检定结果         → 从 msg.data 里取结构化字段，还原成「目标值/掷骰/成败」
//
// 为什么不直接拼 msg.text：
//   roll 消息的 text 是给界面看的一句话（"【检定结果】何九 · 聆听\n目标值 80，
//   掷骰 66 → 常规成功"），但 replay 里更需要「谁、什么技能、难度、目标值、
//   掷了什么、什么结果」的结构化呈现。data 里有这些字段，用它拼更准确，
//   也才能在界面文案变化时保持导出稳定。
// ---------------------------------------------------------------------------

/** 每行的时间戳格式：HH:MM */
function hhmm(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把掷骰细节还原成一行可读文本 */
function describeRoll(m) {
  const d = m.data;
  if (!d || d.kind !== 'check') {
    // 没有结构化数据时退回原始文案（去掉它自带的前缀，避免重复）
    return String(m.text || '').replace(/^【检定结果】\s*/, '').replace(/\n+/g, ' / ');
  }

  const who = d.who || '？';
  const skill = d.skill || '？';
  const diff = d.difficulty && d.difficulty !== '常规' ? `（${d.difficulty}）` : '';
  const target = Number.isFinite(d.adjusted) ? d.adjusted
    : (Number.isFinite(d.baseSkill) ? d.baseSkill : null);

  const r = d.roll || {};
  const value = Number.isFinite(r.value) ? r.value : null;
  const bonusPenalty = r.bonusPenaltyLabel ? ` ${r.bonusPenaltyLabel}` : '';

  // level.label 才是中文（"常规成功"/"大失败"），level.level 是英文枚举
  // （"regular"/"fumble"）。用 label，别把英文枚举漏到导出文本里。
  const level = d.level?.label || '';
  // 大成功/大失败这类特殊结果值得单独标出来
  const special = (d.level?.level === 'critical' || d.level?.level === 'fumble') ? ' ★' : '';

  const parts = [`🎲 ${who} 掷 ${skill}${diff}`];
  if (target !== null) parts.push(`目标 ${target}`);
  if (value !== null) parts.push(`掷出 ${value}${bonusPenalty}`);
  if (level) parts.push(`→ ${level}`);
  return parts.join('，') + special;
}

/**
 * 把一条消息转成 replay 里的若干行。
 * @returns {string[]}
 */
function linesOfMessage(m) {
  const t = hhmm(m.ts);
  const time = t ? `[${t}] ` : '';
  const text = String(m.clean ?? m.text ?? '').trim();

  switch (m.role) {
    case 'user':
      // 玩家行动。旁观模式的默认推进语是程序加的，标出来免得被当成玩家原话
      if (/^（继续推进剧情/.test(text)) return [`${time}▶ 玩家：（继续推进）`];
      return [`${time}▶ 玩家：${text}`];

    case 'keeper': {
      if (!text) return [];      // 失败的空占位消息，跳过
      // KP 旁白：不加「KP：」前缀会更像小说，但 replay 需要明确这是 KP 说的。
      // 折中：正文原样输出，靠缩进和「KP」标记区分。
      const body = text.split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n');
      return [`${time}KP：`, body];
    }

    case 'teammate': {
      if (!text) return [];
      const who = m.name || '队友';
      return [`${time}💬 ${who}：${text}`];
    }

    case 'teammate-action': {
      if (!text) return [];
      const who = m.name || '队友';
      return [`${time}🎬 ${who}（行动）：${text}`];
    }

    case 'roll':
      return [`${time}${describeRoll(m)}`];

    case 'clue':
      return [`${time}🔍 ${text.replace(/^【线索】\s*/, '线索：')}`];

    case 'scene':
      return [`${time}📍 ${text.replace(/^【场景】\s*/, '场景：')}`];

    case 'system-result':
    case 'system':
      // 系统提示默认跳过：混在 replay 里会打断阅读。
      // 但「找不到角色」这类真的影响剧情走向的，值得保留。
      if (m.hidden && !/找不到角色|无法|失败/.test(text)) return [];
      if (/正在自动重试|连接不稳定/.test(text)) return [];   // 网络重试噪音
      return [`${time}⚙ ${text.replace(/^【(系统|提示)】\s*/, '')}`];

    default:
      return text ? [`${time}${text}`] : [];
  }
}

/**
 * 生成 replay 文本。
 *
 * @param {object} state 全局 state
 * @param {object} [opts]
 * @param {boolean} [opts.withTime=true]  是否带每行时间
 * @param {boolean} [opts.withSystem=false] 是否包含全部系统消息
 * @returns {string}
 */
export function buildReplay(state, opts = {}) {
  const { withTime = true } = opts;
  const messages = state?.messages || [];

  const head = [];
  const title = state?.module?.title || '自由创作';
  head.push('═'.repeat(52));
  head.push(`  ${title} — 跑团记录`);
  head.push('═'.repeat(52));

  const meta = [];
  const charName = state?.playerChar?.name;
  if (charName) meta.push(`玩家角色：${charName}`);
  const mates = (state?.teammates || []).map((t) => t?.name).filter(Boolean);
  if (mates.length) meta.push(`AI 队友：${mates.join('、')}`);
  if (state?.mode === 'spectator') meta.push('模式：旁观');
  const turns = (messages || []).filter((m) => m.role === 'user').length || state?.turns || 0;
  if (turns) meta.push(`推进轮数：${turns}`);
  if (state?.scenario?.scene) meta.push(`当前场景：${state.scenario.scene}`);
  const firstTs = messages.find((m) => Number.isFinite(m.ts))?.ts;
  if (firstTs) meta.push(`开始时间：${stamp(firstTs)}`);
  meta.push(`导出时间：${stamp(Date.now())}`);
  if (meta.length) {
    head.push('');
    for (const line of meta) head.push(`  ${line}`);
  }
  head.push('');

  const body = [];
  for (const m of messages) {
    let lines = linesOfMessage(m);
    if (!withTime) lines = lines.map((l) => l.replace(/^\[\d{2}:\d{2}\] /, ''));
    if (lines.length) body.push(...lines);
  }

  // 结尾附上当前状态快照：做 replay 时常需要知道「最后大家是什么状态」
  const tail = [];
  const chars = [state?.playerChar, ...(state?.teammates || [])].filter(Boolean);
  if (chars.length) {
    tail.push('', '─'.repeat(52), '  结束时状态', '─'.repeat(52));
    for (const c of chars) {
      const hp = c.hp ? `${c.hp.current}/${c.hp.max}` : '?';
      const san = c.san ? `${c.san.current}/${c.san.temp}` : '?';
      const mp = c.mp ? `${c.mp.current}/${c.mp.max}` : '?';
      // 做 replay 时「谁倒下了」是关键信息，光看 HP 0/12 容易漏掉
      let flag = '';
      if (c.hp && Number(c.hp.current) <= 0) flag = '　【已倒下】';
      else if (c.san && Number(c.san.current) <= 0) flag = '　【永久疯狂】';
      else if (c.hp && Number(c.hp.current) <= Number(c.hp.max) / 3) flag = '　【重伤】';
      tail.push(`  ${c.name || '?'}　HP ${hp}　MP ${mp}　SAN ${san}${flag}`);
    }
  }
  const clues = state?.scenario?.clues || [];
  if (clues.length) {
    tail.push('', '  已发现的线索：');
    for (const c of clues) tail.push(`   · ${c}`);
  }
  if (state?.scenario?.ending) {
    tail.push('', `  结局：${state.scenario.ending}`);
  }

  return [...head, ...body, ...tail].join('\n') + '\n';
}

/**
 * 生成导出用的文件名。
 * 用模组名 + 日期，避免重复导出时互相覆盖。
 */
export function replayFileName(state, now = new Date()) {
  const raw = state?.module?.title || '自由创作';
  // 去掉文件名非法字符（Windows 禁 \ / : * ? " < > |）
  const safe = String(raw).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `跑团记录-${safe}-${d}.txt`;
}
