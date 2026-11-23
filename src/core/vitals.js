export function incapacity(character) {
  if (!character) return '';
  const status = character.status || [];
  if (status.includes('死亡')) return '死亡';
  if (character.san?.current <= 0 || status.includes('永久疯狂')) return '永久疯狂';
  if (status.includes('濒死')) return '濒死';
  if (character.hp?.current <= 0 || status.includes('昏迷')) return '昏迷';
  return '';
}

export function partyEnding({ playerChar, teammates }) {
  const party = [playerChar, ...(teammates || [])].filter(Boolean);
  if (!party.length || !party.every(incapacity)) return '';
  if (party.length === 1) return `${party[0].name}（${incapacity(party[0])}）已无法继续调查。`;
  return '调查队已无人能够行动，本次调查结束。';
}

export function markDead(character) {
  character.hp.current = 0;
  character.status = (character.status || []).filter((s) => s !== '濒死' && s !== '昏迷');
  if (!character.status.includes('死亡')) character.status.push('死亡');
}

export function applyDamage(character, damage) {
  const { hp } = character;
  const status = character.status ??= [];
  if (damage <= 0 || status.includes('死亡')) return { majorWound: false, outcome: '' };

  const before = hp.current;
  hp.current = Math.max(0, before - damage);
  if (damage >= hp.max) {
    markDead(character);
    return { majorWound: false, outcome: '死亡' };
  }

  const majorWound = damage >= Math.ceil(hp.max / 2);
  if (majorWound && !status.includes('重伤')) status.push('重伤');
  if (hp.current === 0) {
    if (!status.includes('昏迷')) status.push('昏迷');
    const dying = status.includes('重伤') && !status.includes('濒死');
    if (dying) status.push('濒死');
    return { majorWound, outcome: dying ? '濒死' : before > 0 ? '昏迷' : '' };
  }
  return { majorWound, outcome: '' };
}

export function recoverHp(character, amount) {
  if (character.status?.includes('死亡')) return 0;
  const before = character.hp.current;
  character.hp.current = Math.min(character.hp.max, before + amount);
  if (amount > 0 && character.hp.current > 0) {
    character.status = (character.status || []).filter((s) => s !== '昏迷' && s !== '濒死');
  }
  return character.hp.current - before;
}
