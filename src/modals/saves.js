// ---------------------------------------------------------------------------
// 存档弹窗：列表 / 读取 / 删除 / 手动保存
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';

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
          <h3>存档列表</h3>
          <div class="mod-list" id="saveList"></div>
        </section>
      </div>
      <div class="modal-foot">
        ${allowSave ? '<button class="btn" id="btnManualSave">保存当前进度</button>' : ''}
      </div>
    </div>
  `);

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

      const delBtn = document.createElement('button');
      delBtn.className = 'btn ghost';
      delBtn.textContent = '删除';
      delBtn.onclick = async () => {
        await window.api.deleteSave(slot);
        const idx = list.findIndex((x) => x.file === sv.file);
        if (idx >= 0) list.splice(idx, 1);
        render(list);
      };

      acts.append(loadBtn, delBtn);
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
