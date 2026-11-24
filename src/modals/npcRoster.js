import { publicNpcRoster } from '../core/npcs.js';
import { escapeHtml as esc } from '../shared/text.js';
import { openModal } from './shell.js';

function renderCard(npc, scene) {
  const here = npc.status === '在场' && npc.scene === scene;
  const status = npc.status === '在场' && !here ? '上次在场' : npc.status;
  return `
    <article class="npc-file">
      <header class="npc-file-head">
        <h3>${esc(npc.name)}</h3>
        <span class="npc-file-status${here ? ' here' : ''}">${esc(status)}</span>
      </header>
      <div class="npc-file-meta">${[npc.identity, npc.scene].filter(Boolean).map(esc).join(' · ')}</div>
      ${npc.publicNote ? `<p>${esc(npc.publicNote)}</p>` : ''}
      ${npc.lastLine ? `<blockquote>${esc(npc.lastLine)}</blockquote>` : ''}
    </article>`;
}

export function openNpcRoster(state, opener, onClose) {
  const { backdrop, close } = openModal(`
    <div class="modal wide npc-roster" role="dialog" aria-modal="true" aria-labelledby="npcRosterTitle">
      <div class="modal-head">
        <h2 id="npcRosterTitle">人物档案</h2>
        <button class="icon-btn" type="button" data-close aria-label="关闭人物档案">×</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span>查找人物</span>
          <input type="search" placeholder="姓名、身份或地点">
        </label>
        <div class="npc-roster-grid"></div>
      </div>
    </div>`, { onClose: () => { onClose?.(); opener.focus(); } });

  const search = backdrop.querySelector('input[type="search"]');
  const list = backdrop.querySelector('.npc-roster-grid');
  let lastMarkup = '';
  const refresh = () => {
    const { npcs, scene } = state.scenario;
    const query = search.value.trim().toLowerCase();
    const entries = publicNpcRoster(npcs);
    const here = (npc) => npc.status === '在场' && npc.scene === scene;
    const results = entries.filter((npc) =>
      [npc.name, npc.identity, npc.scene].some((field) => field?.toLowerCase().includes(query))
    ).sort((a, b) => Number(here(b)) - Number(here(a)));
    const empty = entries.length ? '没有匹配的人物。' : '遇见剧情人物或听到有关他们的消息后，档案会在这里更新。';
    const markup = results.length ? results.map((npc) => renderCard(npc, scene)).join('')
      : `<p class="empty-hint">${empty}</p>`;
    if (markup !== lastMarkup) {
      list.innerHTML = markup;
      lastMarkup = markup;
    }
  };
  search.addEventListener('input', refresh);
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  refresh();
  search.focus();
  return refresh;
}
