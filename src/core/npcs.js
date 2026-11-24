import { splitNarration } from './protocol.js';

const MAX_NPCS = 64;
const STATUSES = new Set(['未登场', '已提及', '在场', '离场', '失联', '死亡']);

function line(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function npcName(value) {
  return line(line(value, 60).replace(/^NPC\s*[·:：]\s*/i, ''), 48);
}

function nameKey(name) {
  return npcName(name).normalize('NFKC').toLowerCase();
}

function matches(npc, key) {
  return nameKey(npc.name) === key || (npc.aliases || []).some((alias) => nameKey(alias) === key);
}

function record(list, protectedNames, { name, options = {}, speech = '', scene }) {
  name = npcName(name);
  const key = nameKey(name);
  if (!key || protectedNames.has(key) || /^(?:npc|守密人|旁白|未知)$/.test(key)) return false;

  const status = STATUSES.has(options['状态']) ? options['状态'] : '';
  const named = list.find((npc) => matches(npc, key));
  const alias = nameKey(options['原称']);
  const former = status !== '未登场' && alias && !protectedNames.has(alias)
    ? list.find((npc) => matches(npc, alias)) : null;
  const previous = named?.status !== '未登场' ? named || former : former || named;
  const discovered = [named, former].some((npc) => npc && npc.status !== '未登场');
  const nextStatus = status === '未登场' && discovered ? previous.status
    : status || (speech && previous?.status !== '死亡' ? '在场' : previous?.status || '在场');
  const publicInfo = status !== '未登场' && nextStatus !== '未登场';
  const moved = nextStatus === '在场' && (speech || status === '在场' || !discovered);
  const previousScene = previous?.scene || former?.scene || '';
  const activeScene = line(scene, 64);
  const canonical = former ? name : named?.name || name;
  const aliases = [...new Set([named?.name, ...(named?.aliases || []), former?.name, ...(former?.aliases || [])]
    .filter((entry) => entry && nameKey(entry) !== nameKey(canonical)))].slice(0, 4);
  const next = {
    name: canonical,
    aliases,
    status: nextStatus,
    scene: (status !== '未登场' && line(options['地点'], 64)) || (moved ? activeScene || previousScene : previousScene),
    identity: (publicInfo && line(options['身份'], 64)) || previous?.identity || former?.identity || '',
    publicNote: (publicInfo && line(options['公开'], 160)) || previous?.publicNote || former?.publicNote || '',
    keeperNote: line(options['守密人'], 220) || previous?.keeperNote || former?.keeperNote || '',
    lastLine: line(speech, 120) || previous?.lastLine || former?.lastLine || ''
  };

  if ((!former || former === named) && JSON.stringify(previous) === JSON.stringify(next)) return false;
  if (named) list.splice(list.indexOf(named), 1);
  if (former && former !== named) list.splice(list.indexOf(former), 1);
  list.unshift(next);
  if (list.length > MAX_NPCS) list.length = MAX_NPCS;
  return true;
}

/** 只收录已经定稿的守密人发言与摆在正文之外的档案更新。 */
export function recordNpcActivity(state, activity, scene) {
  if (!activity.length) return false;
  const protectedNames = new Set([state.playerChar, ...state.teammates, ...(state.companions || [])]
    .filter(Boolean).map((ch) => nameKey(ch.name)));
  const list = state.scenario.npcs ??= [];
  let changed = false;
  for (const entry of activity) {
    if (entry.type === 'END') break;
    if (entry.type === 'SCENE') scene = entry.head || scene;
    if (entry.type === 'SAY' && record(list, protectedNames, { name: entry.name, speech: entry.text, scene })) changed = true;
    if (entry.type === 'NPC' && record(list, protectedNames, {
      name: entry.head, options: entry.opts, scene
    })) changed = true;
  }
  return changed;
}

/** 旧档只恢复有明确说话人的记录，不从旁白里推测人物身份。 */
export function restoreNpcRoster(state, openingScene) {
  state.scenario.npcs = [];
  let scene = openingScene;
  for (const message of state.messages) {
    if (message.hidden || message.error || message.streaming) continue;
    if (message.role === 'scene' && message.text?.startsWith('【场景】')) {
      scene = message.text.slice('【场景】'.length);
    } else if (message.role === 'npc') {
      recordNpcActivity(state, [{ type: 'SAY', name: message.name, text: message.text }], scene);
    } else if (message.role === 'keeper') {
      const segments = message.segments || (message.text?.includes('[[SAY:') ? splitNarration(message.text) : []);
      const speeches = segments.filter((segment) => segment.kind === 'say')
        .map(({ name, text }) => ({ type: 'SAY', name, text }));
      recordNpcActivity(state, speeches, scene);
    }
  }
}

/** 公开投影同时用于单机人物档案和联机快照。 */
export function publicNpcRoster(npcs = []) {
  return npcs.filter((npc) => npc.status !== '未登场')
    .map(({ name, status, scene, identity, publicNote, lastLine }) => ({
      name, status, scene, identity, publicNote, lastLine
    }));
}

/** 优先提供本轮提到的人和在场人物，再补最近更新的档案。 */
export function describeNpcRoster(npcs = [], scene, focus = '') {
  const here = (npc) => npc.status === '在场' && npc.scene === scene;
  const terms = focus.normalize('NFKC').toLowerCase();
  const priority = (npc) => Number(here(npc)) + 2 * Number(
    [npc.name, ...(npc.aliases || [])].some((name) => terms.includes(nameKey(name)))
  );
  return [...npcs].sort((a, b) => priority(b) - priority(a))
    .slice(0, 12)
    .map((npc) => {
      const status = npc.status === '在场' && !here(npc) ? '上次在场' : npc.status;
      const alias = npc.aliases?.length ? '原称 ' + npc.aliases.join('、') : '';
      return '- ' + [npc.name, alias, npc.identity, status, npc.scene, npc.publicNote,
        npc.keeperNote && '内部 ' + npc.keeperNote, npc.lastLine && '最近发言 ' + npc.lastLine]
        .filter(Boolean).join(' · ');
    }).join('\n').slice(0, 3000);
}
