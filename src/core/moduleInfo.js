// ---------------------------------------------------------------------------
// 模组的「公开简介」：只给玩家看的、绝不剧透的那部分信息
//
// 车卡时需要知道的东西：什么时代、什么地方、大概是什么味道的故事、
// 队伍里适合什么职业。不需要知道：真相、结局、NPC 的秘密、怪物是什么。
//
// 内置模组手写一份；AI 导入的模组由 understandMaterials 生成 summary 等字段。
// 老模组没有这些字段时，回退成「没有公开简介」，绝不把 raw 正文露给玩家。
// ---------------------------------------------------------------------------

/** 不选模组时的简介 */
export const FREE_PLAY_INFO = Object.freeze({
  title: '不选模组（自由创作）',
  era: '由 KP 现场决定',
  location: '由 KP 现场决定',
  summary:
    '没有预设剧本。KP 会现场创作一段短篇调查：一个可以查下去的谜团、几条能查到的线索、几个各有秘密的人，和一个可能走向死亡的终局。' +
    '适合想试试手感、或者懒得挑模组的时候。',
  suggestions: [],
  tags: ['默认', '现场创作'],
  hasSummary: true,
  isFree: true
});

/**
 * 从剧本正文里抓「时代：」「地点：」这类行。
 *
 * 手工粘贴的模组、以及「不经过 AI 直接存为模组」的导入都没有 understanding，
 * 但正文开头通常就写着时代和地点。抓出来能让设定界面至少显示这两项，
 * 而不是一片「未标注」。只读这两行，不碰剧情内容。
 */
export function extractFactsFromRaw(raw) {
  const text = String(raw || '');
  const out = { era: '', location: '' };

  const grab = (keys) => {
    for (const k of keys) {
      // 支持「时代：1920 年代」以及全角冒号，取到行尾
      const m = text.match(new RegExp(`^[\\s>*#-]*${k}\\s*[：:]\\s*(.+)$`, 'm'));
      if (m) {
        const v = m[1].trim();
        if (v && v.length <= 60) return v;
      }
    }
    return '';
  };

  out.era = grab(['时代', '年代', '时期', 'Era']);
  out.location = grab(['地点', '主要地点', '场景', 'Location']);
  return out;
}

/**
 * 取一个模组的公开信息。
 *
 * @param {object|null} module 模组记录（内置模组或 modules.json 里的一条）
 * @returns {{title, era, location, summary, suggestions, tags, hasSummary, isFree}}
 */
export function moduleInfoFor(module) {
  if (!module) return { ...FREE_PLAY_INFO, tags: [...FREE_PLAY_INFO.tags], suggestions: [] };

  const u = module.understanding || {};
  const fromRaw = extractFactsFromRaw(module.raw);

  const title = String(module.title || u.title || '未命名模组');
  const era = String(u.era || module.era || fromRaw.era || '').trim();
  const location = String(u.location || module.location || fromRaw.location || '').trim();
  const summary = String(u.summary || module.summary || '').trim();

  // 车卡建议：优先用 AI 给的，其次用模组自带的
  const rawSuggestions = Array.isArray(u.suggestions)
    ? u.suggestions
    : Array.isArray(module.suggestions)
      ? module.suggestions
      : [];
  const suggestions = rawSuggestions
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  const tags = [];
  if (module.builtin) tags.push('内置');
  else tags.push('已导入');
  if (u.summary || module.understanding) tags.push('AI 整理');
  if (module.visionUsed) tags.push('含图片解读');

  const chars = (module.raw || '').length;
  if (chars) tags.push(`${chars} 字`);

  return {
    title,
    era: era || '未标注',
    location: location || '未标注',
    summary,
    suggestions,
    tags,
    hasSummary: !!summary,
    isFree: false
  };
}

/**
 * 列表行上的一行小字（不放简介，避免列表被撑长）。
 * @param {object|null} module
 */
export function moduleRowMeta(module) {
  if (!module) return '由 KP 现场创作一段短篇调查';
  const info = moduleInfoFor(module);
  const when = module.importedAt ? new Date(module.importedAt).toLocaleDateString() : '';
  return [info.era, when].filter(Boolean).join(' · ');
}
