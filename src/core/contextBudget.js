// ---------------------------------------------------------------------------
// 上下文压缩：给 AI 看的「提炼版」历史
//
// 为什么需要它：
//
// 存档本身是精确的（每条消息、每次掷骰、每个状态都存），这不能动——
// 玩家要能回看、能导出 replay、能精确读档。但**喂给 AI 的上下文**不需要
// 那么多细节：跑团几百轮后，历史消息会占满窗口，既烧 token 又让模型抓不住
// 重点（早期细节反而干扰它对当前局势的判断）。
//
// 所以拆成两层：
//   存档  = 精确、完整、可回放（persistence.js 负责，不动）
//   上下文 = 提炼、有损、只留剧情要点（本模块负责）
//
// 压缩策略（从轻到重，逐级启用）：
//   1) 只保留「有信息量」的消息（跳过空占位、重试噪音、重复的默认推进语）
//   2) 远端历史折叠成「剧情纪要」：把老的 KP 叙述压成一句话摘要
//   3) 超过预算才真正丢弃最早的部分（并保留一条「前情提要」占位）
//
// 关键取舍：**宁可丢细节，不能丢线索和因果**。
// 玩家不知道「为什么现在在这个房间」，模型就编不下去。所以线索、场景、
// 关键事件（clue/scene/roll 结果）优先级最高，宁可留着也不压缩。
// ---------------------------------------------------------------------------

/**
 * 估算一段文本的 token 数。
 *
 * 不引入 tiktoken 这类依赖（体积大、且不同模型分词器不同，算了也不准）。
 * 中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token，这里按字符类型加权估算。
 * 只需要「量级正确」来触发压缩，不需要精确到个位。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // CJK 统一表意文字 / 全角标点 / 假名 / 谚文
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  // 中文 1 字≈1 token；英文/数字/空格 约 4 字符≈1 token
  return Math.ceil(cjk + other / 4);
}

/** 估算一组 messages（OpenAI 格式）的 token 总量，含每条的结构开销 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    total += estimateTokens(m.content) + 4;   // 4 ≈ role/分隔符开销
  }
  return total;
}

/** 默认预算：给历史留多少 token。system prompt 与回复另有开销，故不设太高。 */
export const DEFAULT_HISTORY_BUDGET = 6000;

/** 压缩后每条「剧情纪要」最多保留多少字 */
const SUMMARY_MAX_CHARS = 160;

/** 这类消息没有信息量，直接跳过（不占预算） */
function isNoise(m) {
  const t = String(m.text || '').trim();
  if (!t) return true;                                   // 空占位（失败的 KP 回复）
  if (m.role === 'keeper' && !m.clean && !t) return true;
  if (/正在自动重试|连接不稳定|【自动推进/.test(t)) return true;   // 网络/调度噪音
  if (m.role === 'system' && /^【提示】/.test(t)) return false;   // 提示可能有用，保留
  return false;
}

/**
 * 把一条老消息压成一句话纪要。
 *
 * 目标是「保留发生了什么」，不保留文采。KP 的长篇描写压成首句，
 * 通常首句就交代了场景和动作。
 */
function summarize(m) {
  const raw = String(m.clean ?? m.text ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';

  // 检定结果：保留谁、什么技能、成败——这是因果链上最关键的一环
  if (m.role === 'roll') {
    const d = m.data;
    if (d?.kind === 'check') {
      // level.label 是中文（"常规成功"/"失败"），level.level 是英文枚举
      // （"regular"/"failure"）。用 label，否则摘要里会混进英文枚举，
      // 模型读到 "检定：failure" 也能懂，但中文提示词里突然夹英文更容易误读。
      const lvl = d.level?.label || '';
      return `${d.who || '?'} 的 ${d.skill || '?'} 检定${lvl ? '：' + lvl : ''}`;
    }
    return raw.replace(/^【检定结果】\s*/, '').slice(0, 60);
  }

  if (m.role === 'user') {
    if (/^（继续推进剧情/.test(raw)) return '';   // 默认推进语没有信息量
    return `玩家：${raw.slice(0, 60)}`;
  }
  if (m.role === 'teammate-action') return `${m.name || '队友'}行动：${raw.slice(0, 50)}`;
  if (m.role === 'teammate') return `${m.name || '队友'}说：${raw.slice(0, 50)}`;
  if (m.role === 'clue') return raw.replace(/^【线索】\s*/, '线索：').slice(0, 80);
  if (m.role === 'scene') return raw.replace(/^【场景】\s*/, '场景：');

  // KP 叙述：取第一个句子（通常交代了场景与进展）
  const firstSentence = raw.split(/(?<=[。！？!?\n])/)[0] || raw;
  return firstSentence.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * 压缩历史消息，使总 token 落在预算内。
 *
 * 返回的对象里同时给出统计，便于界面显示「省了多少」。
 *
 * @param {object[]} messages 已转成 OpenAI 格式的消息数组（含 role/content），
 *   另可带 _src 指向原始消息（用于按角色做摘要）
 * @param {object} [opts]
 * @param {number} [opts.budget] 历史部分的 token 预算
 * @returns {{messages: object[], stats: object}}
 */
export function compactHistory(messages, opts = {}) {
  const budget = Number.isFinite(opts.budget) ? opts.budget : DEFAULT_HISTORY_BUDGET;
  const list = Array.isArray(messages) ? messages : [];

  const beforeTokens = estimateMessagesTokens(list);

  // ---- 第一级：过滤噪音 ----
  const kept = list.filter((m) => !(m._src && isNoise(m._src)));
  const afterNoise = estimateMessagesTokens(kept);

  if (afterNoise <= budget) {
    return {
      messages: kept,
      stats: {
        beforeTokens, afterTokens: afterNoise, budget,
        dropped: list.length - kept.length, summarized: 0, compacted: false
      }
    };
  }

  // ---- 第二级：远端历史折叠成纪要 ----
  //
  // 保留最近一部分原样（近处上下文对连贯性最重要），更早的压成纪要。
  // 从末尾往前累计，直到用掉约 60% 预算；剩下的 40% 留给纪要。
  const keepRecent = [];
  let recentTokens = 0;
  const recentBudget = Math.floor(budget * 0.6);

  for (let i = kept.length - 1; i >= 0; i--) {
    const t = estimateMessagesTokens([kept[i]]);
    if (recentTokens + t > recentBudget) break;
    keepRecent.unshift(kept[i]);
    recentTokens += t;
  }

  const older = kept.slice(0, kept.length - keepRecent.length);

  // 老消息压成纪要行。合并成**一条** user 消息，比每条都发更省 token
  // （每条消息都有固定的 role 开销）。
  const summaryLines = [];
  for (const m of older) {
    const src = m._src;
    if (!src) {
      // 没有原始消息可依据时，退而求其次截断内容
      const brief = String(m.content || '').replace(/\s+/g, ' ').slice(0, 60);
      if (brief) summaryLines.push(brief);
      continue;
    }
    const line = summarize(src);
    if (line) summaryLines.push(line);
  }

  const compacted = [];
  if (summaryLines.length) {
    // 纪要本身也可能很长，按剩余预算截断
    const head = '【前情提要】（以下是更早剧情的要点，细节已省略）\n';
    let acc = head;
    const summaryBudget = budget - recentTokens - 32;
    for (const line of summaryLines) {
      const next = acc + '· ' + line + '\n';
      if (estimateTokens(next) > summaryBudget) break;
      acc = next;
    }
    compacted.push({ role: 'user', content: acc.trimEnd() });
  }
  compacted.push(...keepRecent);

  const afterTokens = estimateMessagesTokens(compacted);

  return {
    messages: compacted,
    stats: {
      beforeTokens,
      afterTokens,
      budget,
      dropped: list.length - kept.length,
      summarized: older.length,
      compacted: true
    }
  };
}
