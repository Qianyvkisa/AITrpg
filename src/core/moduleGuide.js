const SOURCE_MARKER = '===== 以下为原始素材（供查阅）=====';
const ENDING_HEADING = /^(?:#{1,6}[ \t]+)?(?:终局|结局|收束条件|结束条件)(?:[：:][ \t]*|[ \t]*$)/;
const OPENING_HEADING = /^(?:#{1,6}[ \t]+)?(?:开场白|开场叙事)(?:[：:][ \t]*|[ \t]*$)/;

function sceneName(name) {
  return String(name || '').trim().replace(/[（(](?:开场|终局|结局)[）)]$/, '').trim();
}

function readSection(lines, heading, limit) {
  const index = lines.findIndex(line => heading.test(line.trim()));
  if (index < 0) return '';
  const section = [lines[index].trim().replace(heading, '')];
  for (const line of lines.slice(index + 1)) {
    if (/^#{1,6}\s|^(?:场景流程|场景顺序|场景|终局|结局|收束条件|结束条件|开场白|开场叙事)[：:]|^[^：:\n]{1,24}[：:]\s*$/.test(line.trim())) break;
    section.push(line);
  }
  return section.join('\n').trim().slice(0, limit);
}

/** 只把原稿明确使用箭头写出的流程当作顺序约束。 */
export function readModuleGuide(module) {
  const raw = typeof module?.raw === 'string' ? module.raw.trim() : '';
  if (!raw) return null;

  const marker = module.understanding ? raw.indexOf(SOURCE_MARKER) : -1;
  const hasOriginal = marker >= 0;
  const original = (hasOriginal ? raw.slice(marker + SOURCE_MARKER.length) : raw).trim();
  const reference = hasOriginal ? raw.slice(0, marker).trim() : '';
  // 旧版 AI 整理档可能只剩整理稿。整理稿的场景列表不能充当原作者的路线。
  const authored = hasOriginal || !module.understanding || module.builtin ? original : '';
  const routes = new Map();
  for (const match of authored.matchAll(/^(?:#{1,6}[ \t]+)?(?:场景流程|场景顺序|场景)[：:][ \t]*(.+)$/gm)) {
    const names = match[1].split('→').map(sceneName);
    if (names.length < 2 || names.some(name => !name || name.length > 48)) continue;
    if (new Set(names).size !== names.length) continue;
    routes.set(names.join('→'), names);
  }
  const route = routes.size === 1 ? routes.values().next().value : [];
  const first = route[0];
  // 旧宅的存档标题曾用「旧宅书房」，原稿流程里只写了「书房」。
  const start = sceneName(module.scene);
  const openingAlias = first && start !== first && start.endsWith(first) ? start : '';

  const lines = authored.split(/\r?\n/);
  return {
    source: original || reference, reference: original ? reference : '', route, openingAlias,
    ending: readSection(lines, ENDING_HEADING, 2400),
    opening: readSection(lines, OPENING_HEADING, 1600)
  };
}

export function openingSceneFor(module) {
  const guide = readModuleGuide(module);
  return guide?.openingAlias || guide?.route[0] || module?.scene || '未知之处';
}

function sceneIndex(guide, name) {
  const normalized = sceneName(name);
  if (guide.openingAlias && normalized === guide.openingAlias) return 0;
  return guide.route.indexOf(normalized);
}

export function describeModuleProgress(guide, scene) {
  if (!guide) return '';
  const index = sceneIndex(guide, scene);
  const lines = [];
  if (guide.route.length) {
    lines.push(`原稿路线：${guide.route.join(' → ')}`);
    if (index >= 0) {
      const exits = [guide.route[index - 1], guide.route[index + 1]].filter(Boolean);
      lines.push(`已确认阶段：第 ${index + 1}/${guide.route.length} 段「${scene}」。允许换场：${exits.join('、')}。`);
    } else {
      lines.push('当前场景来自旧进度或尚未进入路线。仅在行动与原稿支持时回到一个已列出的场景。');
    }
    lines.push('使用路线原名登记换场；每次最多换一处。阶段切换应源于行动，上一场的未决检定需先结算。进入末段后，在后续回复中按原稿条件结团。');
  }
  if (guide.ending) lines.push(`原稿终局条件（内部信息）：\n${guide.ending}`);
  return lines.join('\n');
}

/** 校验整份草稿，调用方须在任何剧情指令落地前执行。 */
export function checkModuleReply(guide, scene, { clean, says, directives }) {
  if (!clean && !says.length && !directives.length) return '回复为空。请根据本轮行动提供一段具体的裁定。';
  if (/\[\[|\]\]/.test(clean)) return '存在无法识别或未闭合的指令。请使用已定义格式并补全指令。';
  const moves = directives.filter(d => d.type === 'SCENE');
  const endings = directives.filter(d => d.type === 'END');
  if (moves.length > 1) return '同一份回复只能登记一次换场。';
  if (moves.some(move => !move.head)) return '换场指令需要注明目的地。';
  if (endings.length) {
    if (endings.length > 1 || !endings[0].head) return '请只给出一个带结果的结局指令。';
    if (directives.some(d => d.type === 'CHECK' || d.type === 'SAN')) return '先等待本轮检定结果，再决定结局。';
  }
  if (!guide.route.length) return '';

  const index = sceneIndex(guide, scene);
  if (moves.length) {
    const target = sceneIndex(guide, moves[0].head);
    if (target < 0) return '目的地不在原稿路线里。保留当前场景，或使用允许的场景原名。';
    if (index >= 0 && Math.abs(target - index) > 1) return '这次换场跳过了中间阶段。请留在当前场景或前往相邻阶段。';
    moves[0].head = target === 0 && guide.openingAlias ? guide.openingAlias : guide.route[target];
  }
  if (endings.length && (index !== guide.route.length - 1 || moves.length)) {
    return '还未在终局场景完成调查，请按原稿推进当前阶段。';
  }
  return '';
}
