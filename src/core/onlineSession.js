import { stripDirectivesForDisplay } from '../shared/text.js';
import { publicNpcRoster } from './npcs.js';

export function rollOwner(state, character) {
  return state.net.role === 'host' && character
    ? state.net.players.find((player) => player.charId === character.id)?.id || '' : '';
}

export function claimedCharacter(state, playerId) {
  const claim = state.net.players.find((player) => player.id === playerId);
  const teammates = state.net.role === 'client' ? state.net.room?.teammates : state.teammates;
  return teammates?.find((character) => character.id === claim?.charId);
}

export function publicMessage(state, message) {
  if (message.hidden || message.streaming) return null;
  const { id, ts, role, name } = message;
  if (role === 'keeper') {
    if (message.error) return { id, ts, role, name, text: '【守密人暂时无法继续叙事】' };
    const text = message.clean ?? stripDirectivesForDisplay(message.text);
    const segments = message.segments?.map(({ kind, name, text }) => ({ kind, name, text }));
    return { id, ts, role, name, text, clean: text, segments };
  }
  if (role === 'roll' && message.data) {
    const { charId, who } = message.data;
    const character = [state.playerChar, ...state.teammates].find((ch) => ch && (charId ? ch.id === charId : ch.name === who));
    return { id, ts, role, text: message.text, data: { ...message.data, ownerId: rollOwner(state, character) } };
  }
  return { id, ts, role, name, text: message.text };
}

export function publicRoomState(state, { ready, busy }) {
  const { scene, clues, ended, ending, npcs } = state.scenario;
  return {
    ready, busy,
    continuation: ready && !!state.keeperContinuation,
    turns: ready ? state.turns : 0,
    playerChar: ready && state.playerChar ? publicCharacter(state.playerChar) : null,
    teammates: ready ? state.teammates.map(publicCharacter) : [],
    scenario: ready ? { scene, clues, ended, ending, npcs: publicNpcRoster(npcs) }
      : { scene: '', clues: [], ended: false, ending: '', npcs: [] }
  };
}

function publicCharacter({ id, name, occupation, attrs, skills, hp, san, mp, luck, derived, status }) {
  return { id, name, occupation, attrs, skills, hp, san, mp, luck, derived, status };
}

/** 加入或重连只补发一段可见历史，所有现存待掷骰都随快照发出。 */
export function roomHistory(state) {
  const encoder = new TextEncoder();
  const messages = [];
  let bytes = 0;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const source = state.messages[i];
    const pending = source.role === 'roll' && source.data?.status === 'pending';
    if (!pending && (messages.length >= 60 || bytes >= 110000)) continue;
    const message = publicMessage(state, source);
    if (!message) continue;
    if (pending) {
      messages.push(message);
    } else {
      const length = encoder.encode(JSON.stringify(message)).length;
      if (bytes + length < 110000) {
        bytes += length;
        messages.push(message);
      }
    }
  }
  return messages.reverse();
}

export function applyRoomState(state, room) {
  state.net.room = room;
  const own = claimedCharacter(state, state.net.myPlayerId);
  state.mode = 'player';
  state.turns = room.turns;
  state.playerChar = own || room.playerChar;
  state.teammates = own
    ? [room.playerChar, ...room.teammates].filter((ch) => ch && ch.id !== own.id)
    : room.teammates;
  state.scenario = { ...room.scenario, events: [] };
}

/** 客户端按消息 ID 增量合并，重发或落后一条更新都能恢复。 */
export function mergeRoomMessages(state, messages, reset) {
  if (reset) state.messages = [];
  return (messages || []).map((message) => {
    const index = state.messages.findIndex((known) => known.id === message.id);
    if (index < 0) state.messages.push(message);
    else state.messages[index] = message;
    return { message, updated: index >= 0 };
  });
}
