// ---------------------------------------------------------------------------
// 存档弹窗：列表 / 读取 / 删除 / 手动保存 / 提取角色卡
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';
import { saveCharToLibrary } from './charLibrary.js';

export async function openSaves({ getSnapshot, onLoad, allowSave = true }) {
  const saves = await window.api.listSaves();

  const { backdrop, close } = openModal(`
    <div class="modal">
      <div class="modal-head">
        <h2>存档</h2>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body">
        <section class="field-group">
          <h3>存档列表 <span class="hint">「提卡」可把存档里的调查员存进角色卡库</span></h3>
          <div class="mod-list" id="saveList"></div>
        </section>
      </div>
      <div class="modal-foot">
        ${allowSave ? '<button class="btn" id="btnManualSave">保存当前进度</button>' : ''}
      </div>
    </div>
  `);

  /**
   * 提卡弹窗：列出一个存档里的玩家角色与队友，勾选后存进对应的库。
   * 这是「从旧存档里捞回角色卡」的入口——玩家换了一局，
   * 想拿回上一局那位调查员时用。
   */
  const openExtract = async (slot) => {
    const data = await window.api.readSave(slot);
    if (!data) return;
    const s = data.state || data;

    const playerChar = s.playerChar || null;
    const mates = Array.isArray(s.teammates) ? s.teammates : [];

    if (!playerChar && !mates.length) {
      return; // 这个存档里没有角色卡可提
    }

    // 每项：{ kind, char, label }
    const items = [];
    if (playerChar) items.push({ kind: 'player', char: playerChar, label: `玩家：${playerChar.name || '调查员'}` });
    mates.forEach((t, i) => {
      items.push({ kind: 'ai', char: t, label: `队友 ${i + 1}：${t.name || '队友'}` });
    });

    const { backdrop: bd, close: cl } = openModal(`
      <div class="modal extract-modal">
        <div class="modal-head">
          <h2>从存档提取角色卡</h2>
          <button class="icon-btn" data-close>×</button>
        </div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:10px">
            玩家角色存进「玩家角色卡库」，队友存进「AI 队友角色卡库」。
          </div>
          <div class="extract-list" id="extractList"></div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
          <button class="btn" id="btnDoExtract">全部存进库</button>
        </div>
      </div>
    `);

    const listBox = bd.querySelector('#extractList');
    const checks = [];

    items.forEach((it) => {
      const d = it.char.derived || {};
      const row = document.createElement('label');
      row.className = 'extract-row';
      row.innerHTML = `
        <input type="checkbox" checked>
        <span class="ex-main">
          <span class="ex-name">${escapeHtml(it.label)}</span>
          <span class="ex-meta">${escapeHtml(it.char.occupation || '无职业')} · HP ${d.HP ?? '?'} SAN ${d.SAN ?? '?'}</span>
        </span>
        <span class="ex-kind">${it.kind === 'player' ? '玩家库' : 'AI 库'}</span>
      `;
      const cb = row.querySelector('input');
      checks.push({ cb, item: it });
      listBox.appendChild(row);
    });

    bd.querySelector('#btnDoExtract').onclick = async () => {
      let n = 0;
      for (const { cb, item } of checks) {
        if (!cb.checked) continue;
        await saveCharToLibrary(item.kind, item.char, { name: item.char.name });
        n++;
      }
      cl();
      if (n > 0) alert(`已存进角色卡库：${n} 张`);
    };
  };

  const render = (list) => {
    const box = backdrop.querySelector('#saveList');
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">还没有存档</div>';
      return;
    }
    box.innerHTML = '';

    for (const sv of list) {
      const slot = sv.file.replace(/^save-/, '').replace(/\.json$/, '');
      const row = document.createElement('div');
      row.className = 'save-row';

      const d = new Date(sv.savedAt || sv.mtime);
      const autoTag = slot === 'auto' ? ' <span style="color:#7f8697;font-size:10px">· 自动</span>' : '';
      row.innerHTML = `
        <div>
          <div class="s-title">${escapeHtml(sv.title || slot)}${autoTag}</div>
          <div class="s-meta">${escapeHtml(sv.charName || '')} · ${escapeHtml(sv.scene || '')} · 第${sv.turns || 0}轮 · ${d.toLocaleString()}</div>
        </div>
      `;

      const acts = document.createElement('div');
      acts.className = 's-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn ghost';
      loadBtn.textContent = '读取';
      loadBtn.onclick = async () => {
        const data = await window.api.readSave(slot);
        if (data) { onLoad(data); close(); }
      };

      // 提卡：把这一局的调查员捞进角色卡库
      const extBtn = document.createElement('button');
      extBtn.className = 'btn ghost';
      extBtn.textContent = '提卡';
      extBtn.title = '从这个存档里提取玩家/队友角色卡，存进角色卡库';
      extBtn.onclick = () => openExtract(slot);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn ghost';
      delBtn.textContent = '删除';
      delBtn.onclick = async () => {
        await window.api.deleteSave(slot);
        const idx = list.findIndex((x) => x.file === sv.file);
        if (idx >= 0) list.splice(idx, 1);
        render(list);
      };

      acts.append(loadBtn, extBtn, delBtn);
      row.appendChild(acts);
      box.appendChild(row);
    }
  };
  render(saves);

  const saveBtn = backdrop.querySelector('#btnManualSave');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const slot = 'manual-' + Date.now();
      await window.api.writeSave(slot, getSnapshot());
      render(await window.api.listSaves());
    };
  }
}
