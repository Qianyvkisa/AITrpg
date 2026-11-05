// ---------------------------------------------------------------------------
// 模组弹窗：导入 / 粘贴 / 选用 / 删除
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';

export async function openModules(state, onChanged) {
  const mods = await window.api.listModules();

  const { backdrop, close } = openModal(`
    <div class="modal wide">
      <div class="modal-head">
        <h2>模组</h2>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body">
        <section class="field-group">
          <h3>已导入的模组</h3>
          <div class="mod-list" id="modList"></div>
        </section>

        <section class="field-group">
          <h3>从文件夹导入（推荐）</h3>
          <p class="hint" style="margin:0;line-height:1.7">
            选一个文件夹，程序会递归读取里面的
            <b>.docx / .pdf / .txt / .md / 图片</b>，
            再交给 AI 理解并整理成模组。
            适合把「正文 + 地图 + NPC 立绘 + 手写笔记」放在同一个文件夹里。
          </p>
          <div class="module-actions">
            <button class="btn" id="btnImportFolder">选择文件夹并让 AI 理解</button>
            <button class="btn ghost" id="btnImportFolderRaw">不经过 AI，直接存为模组</button>
          </div>
          <div class="import-status" id="folderStatus" hidden></div>
        </section>

        <section class="field-group">
          <h3>导入单个文件</h3>
          <div class="module-actions">
            <button class="btn ghost" id="btnImportFile">选择文件（文档 / 图片）</button>
            <span class="hint">支持 .docx .pdf .txt .md .html 与图片</span>
          </div>
        </section>

        <section class="field-group">
          <h3>手动粘贴模组</h3>
          <label class="field">
            <span>标题</span>
            <input id="modTitle" type="text" placeholder="例如：鬼屋疑云">
          </label>
          <label class="field">
            <span>正文</span>
            <textarea id="modRaw" rows="9" placeholder="把模组内容粘贴到这里。可以是完整剧本，也可以是剧情大纲、关键线索、NPC 设定。"></textarea>
          </label>
          <div class="module-actions">
            <button class="btn" id="btnAddModText">保存为模组</button>
          </div>
        </section>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>完成</button>
      </div>
    </div>
  `);

  const renderMods = () => {
    const box = backdrop.querySelector('#modList');
    if (!mods.length) {
      box.innerHTML = '<div class="empty-hint">还没有模组。导入一个，或者留空让 KP 现场创作。</div>';
      return;
    }
    box.innerHTML = '';
    for (const m of mods) {
      const row = document.createElement('div');
      row.className = 'mod-row';
      const active = state.module?.id === m.id;

      // 素材构成标签：让用户一眼看出这份模组是怎么来的
      const tags = [];
      if (m.understanding) tags.push('<span class="m-tag ai">AI 理解</span>');
      if (m.visionUsed) tags.push('<span class="m-tag ai">含图片解读</span>');
      const docs = m.materials?.docs?.length ?? (Array.isArray(m.materials) ? m.materials.length : 0);
      if (docs) tags.push(`<span class="m-tag">${docs} 份文档</span>`);
      const imgs = m.materials?.images?.length ?? 0;
      if (imgs) tags.push(`<span class="m-tag">${imgs} 张图片</span>`);
      const skipped = m.materials?.skipped?.length ?? 0;
      if (skipped) tags.push(`<span class="m-tag">跳过 ${skipped} 个</span>`);

      row.innerHTML = `
        <div>
          <div class="m-title">${escapeHtml(m.title)} ${active ? '<span style="color:#b8894a">· 当前</span>' : ''}</div>
          <div class="m-meta">${(m.raw || '').length} 字 · ${new Date(m.importedAt).toLocaleDateString()}</div>
          ${tags.length ? `<div class="m-tags">${tags.join('')}</div>` : ''}
        </div>
      `;
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';

      const useBtn = document.createElement('button');
      useBtn.className = 'btn ghost';
      useBtn.textContent = active ? '取消使用' : '使用';
      useBtn.onclick = () => {
        state.module = active ? null : m;
        renderMods();
        onChanged?.();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn ghost';
      delBtn.textContent = '删除';
      delBtn.onclick = async () => {
        await window.api.deleteModule(m.id);
        const idx = mods.findIndex((x) => x.id === m.id);
        if (idx >= 0) mods.splice(idx, 1);
        if (state.module?.id === m.id) state.module = null;
        renderMods();
        onChanged?.();
      };

      actions.append(useBtn, delBtn);
      row.appendChild(actions);
      box.appendChild(row);
    }
  };
  renderMods();

  // ---- 进度与状态提示 ----
  const status = backdrop.querySelector('#folderStatus');
  const setStatus = (text, cls = '') => {
    if (!status) return;
    status.hidden = false;
    status.className = 'import-status ' + cls;
    status.textContent = text;
  };
  const clearStatus = () => { if (status) status.hidden = true; };

  // 主进程逐个文件推送进度。
  // 注意：监听只注册一次，弹窗关闭时才解绑，不能每次导入都解绑。
  const offProgress = window.api.onModuleProgress?.(({ rel }) => {
    setStatus(`正在读取：${rel}`, 'busy');
  });
  // 弹窗从 DOM 上移除时清理监听，避免泄漏
  const watcher = new MutationObserver(() => {
    if (!backdrop.isConnected) {
      offProgress?.();
      watcher.disconnect();
    }
  });
  watcher.observe(document.body, { childList: true, subtree: true });

  /** 统一的文件夹导入入口 */
  const importFolder = async (understand) => {
    const btnAi = backdrop.querySelector('#btnImportFolder');
    const btnRaw = backdrop.querySelector('#btnImportFolderRaw');
    btnAi.disabled = true;
    btnRaw.disabled = true;

    setStatus(
      understand ? '正在读取文件夹，随后交给 AI 理解…（大文件夹可能要等一会儿）' : '正在读取文件夹…',
      'busy'
    );

    try {
      const m = await window.api.importModuleFolder({ understand });

      if (!m) { clearStatus(); return; }          // 用户取消
      if (m.error) { setStatus(m.error, 'bad'); return; }

      mods.push(m);
      renderMods();

      const mat = m.materials;
      const docN = mat?.docs?.length ?? 0;
      const imgN = mat?.images?.length ?? 0;
      const skipN = mat?.skipped?.length ?? 0;
      const parts = [`已导入《${m.title}》`, `${docN} 份文档`, imgN ? `${imgN} 张图片` : '', skipN ? `${skipN} 个文件被跳过` : '']
        .filter(Boolean)
        .join(' · ');
      setStatus(parts + (m.visionUsed ? '（图片已交给 AI 解读）' : ''), 'ok');
    } catch (e) {
      setStatus(`导入失败：${e?.message || e}`, 'bad');
    } finally {
      btnAi.disabled = false;
      btnRaw.disabled = false;
      // 监听不在这里解绑：弹窗可能还要再导一次，交给 watcher 统一清理
    }
  };

  backdrop.querySelector('#btnImportFolder').onclick = () => importFolder(true);
  backdrop.querySelector('#btnImportFolderRaw').onclick = () => importFolder(false);

  backdrop.querySelector('#btnImportFile').onclick = async () => {
    const btn = backdrop.querySelector('#btnImportFile');
    btn.disabled = true;
    setStatus('正在读取文件…', 'busy');
    try {
      const m = await window.api.importModule();
      if (!m) { clearStatus(); return; }
      if (m.error) { setStatus(m.error, 'bad'); return; }
      mods.push(m);
      renderMods();
      setStatus(`已导入《${m.title}》`, 'ok');
    } catch (e) {
      setStatus(`导入失败：${e?.message || e}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  };

  backdrop.querySelector('#btnAddModText').onclick = async () => {
    const title = backdrop.querySelector('#modTitle').value.trim();
    const raw = backdrop.querySelector('#modRaw').value.trim();
    if (!raw) { alert('正文不能为空'); return; }

    const m = await window.api.addModuleText(title, raw);
    mods.push(m);
    backdrop.querySelector('#modTitle').value = '';
    backdrop.querySelector('#modRaw').value = '';
    renderMods();
  };
}
