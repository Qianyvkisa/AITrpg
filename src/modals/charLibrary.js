// ---------------------------------------------------------------------------
// 角色卡库：玩家 / AI 两栏分开管理已保存的调查员
//
// 为什么要分两栏：
//   玩家卡是「我自己要扮演的人」，一局只能选一张；
//   AI 卡是「让 AI 扮演的队友或支援伙伴」，一局可以选多位。
//   两者用途不同，混在一起找卡会很累，所以物理上就分成两个库。
//
// 每张卡可以：编辑 / 重命名 / 复制一份 / 删除 / 导出到另一个库。
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';
import { openCharEditor } from './charEditor.js';
import { createCharacter } from '../core/character.js';

/** 两个库的展示配置 */
const KINDS = [
  { key: 'player', label: '玩家角色卡', desc: '你自己要扮演的调查员，开局时选一张' },
  { key: 'ai', label: 'AI 队友角色卡', desc: '交给 AI 扮演的队友，也可以作为模组里的支援伙伴' }
];

/**
 * 打开角色卡库。
 * @param {{state?: object, api?: object}} opts
 */
export async function openCharLibrary({ state = null, api = null } = {}) {
  // 两个库的内容各存一份，渲染时用
  const libs = { player: [], ai: [] };
  let activeKind = 'player';

  const { backdrop, close } = openModal(`
    <div class="modal charlib-modal">
      <div class="modal-head">
        <h2>角色卡库</h2>
        <button class="icon-btn" data-close>×</button>
      </div>

      <div class="modal-body">
        <div class="charlib-tabs" id="charlibTabs">
          ${KINDS.map(
            (k) => `<button class="charlib-tab ${k.key === activeKind ? 'on' : ''}" data-kind="${k.key}">
              ${escapeHtml(k.label)}<span class="ct-count" data-count="${k.key}">0</span>
            </button>`
          ).join('')}
        </div>

        <div class="charlib-desc" id="charlibDesc"></div>

        <div class="charlib-list" id="charlibList"></div>
      </div>

      <div class="modal-foot">
        <button class="btn ghost" id="btnNewCharInLib">新建角色卡</button>
        <button class="btn ghost" data-close>关闭</button>
      </div>
    </div>
  `);

  const listBox = backdrop.querySelector('#charlibList');
  const descBox = backdrop.querySelector('#charlibDesc');

  // -------------------------------------------------------------------------
  // 读取与渲染
  // -------------------------------------------------------------------------
  const loadAll = async () => {
    for (const k of KINDS) {
      try {
        libs[k.key] = (await window.api.listChars(k.key)) || [];
      } catch (_) {
        libs[k.key] = [];
      }
    }
  };

  /** 更新两个 tab 上的数量角标 */
  const refreshCounts = () => {
    for (const k of KINDS) {
      const el = backdrop.querySelector(`[data-count="${k.key}"]`);
      if (el) el.textContent = String(libs[k.key].length);
    }
  };

  /** 一张卡的摘要行 */
  const charCardEl = (entry, kind) => {
    const ch = entry.char || {};
    const d = ch.derived || {};
    const el = document.createElement('div');
    el.className = 'charlib-card';

    const savedDate = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : '';
    el.innerHTML = `
      <div class="clc-main">
        <div class="clc-top">
          <span class="clc-name">${escapeHtml(entry.name || ch.name || '未命名')}</span>
          <span class="clc-occ">${escapeHtml(ch.occupation || '无职业')}</span>
        </div>
        <div class="clc-meta">
          HP ${d.HP ?? '?'} · SAN ${d.SAN ?? '?'} · MP ${d.MP ?? '?'} · 幸运 ${d.LUCK ?? '?'}
        </div>
        ${savedDate ? `<div class="clc-date">保存于 ${escapeHtml(savedDate)}</div>` : ''}
      </div>
      <div class="clc-actions">
        <button class="btn ghost sm" data-act="edit">编辑</button>
        <button class="btn ghost sm" data-act="copy">复制到${kind === 'player' ? ' AI 库' : '玩家库'}</button>
        <button class="icon-btn danger" data-act="del" title="从库中删除">×</button>
      </div>
    `;

    el.querySelector('[data-act="edit"]').onclick = async () => {
      // 用库里的卡打开编辑器；保存时写回同一个 id，等于更新这张卡
      openCharEditor(ch, {
        title: `编辑：${entry.name || ch.name}`,
        state, api,
        onSaved: async () => {
          await window.api.saveChar(kind, ch, { id: entry.id, name: ch.name });
          await loadAll();
          render();
        }
      });
    };

    el.querySelector('[data-act="copy"]').onclick = async () => {
      const target = kind === 'player' ? 'ai' : 'player';
      await window.api.saveChar(target, ch, { name: entry.name || ch.name });
      await loadAll();
      render();
    };

    el.querySelector('[data-act="del"]').onclick = async () => {
      await window.api.deleteChar(kind, entry.id);
      await loadAll();
      render();
    };

    return el;
  };

  const render = () => {
    refreshCounts();

    const cfg = KINDS.find((k) => k.key === activeKind);
    descBox.textContent = cfg.desc;

    backdrop.querySelectorAll('.charlib-tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.kind === activeKind);
    });

    const list = libs[activeKind];
    listBox.innerHTML = '';

    if (!list.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = activeKind === 'player'
        ? '还没有玩家角色卡。点下方「新建角色卡」造一张，或在游戏设定界面把车好的卡存进库。'
        : '还没有 AI 队友角色卡。可以新建一张，或把存档里的队友提取进来。';
      listBox.appendChild(hint);
      return;
    }

    for (const entry of list) listBox.appendChild(charCardEl(entry, activeKind));
  };

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------
  backdrop.querySelectorAll('.charlib-tab').forEach((t) => {
    t.onclick = () => {
      activeKind = t.dataset.kind;
      render();
    };
  });

  backdrop.querySelector('#btnNewCharInLib').onclick = () => {
    // 新建的卡先不进库，等用户点保存才落库，避免半成品占位
    const fresh = createCharacter({
      name: activeKind === 'player' ? '调查员' : '队友',
      isPlayer: activeKind === 'player'
    });
    openCharEditor(fresh, {
      title: '新建角色卡',
      state, api,
      onSaved: async () => {
        await window.api.saveChar(activeKind, fresh, { name: fresh.name });
        await loadAll();
        render();
      }
    });
  };

  await loadAll();
  render();
}

/**
 * 从一张角色卡直接存进库（供设定界面「存进库」按钮、存档提取等处复用）。
 * @param {'player'|'ai'} kind
 * @param {object} char 角色卡
 * @param {{id?: string, name?: string}} opts
 */
export async function saveCharToLibrary(kind, char, opts = {}) {
  return window.api.saveChar(kind, char, opts);
}

/**
 * 选卡弹窗：从某个库里挑一张卡，交给调用方使用。
 * 用于设定界面「从库导入」、伙伴添加等场景。
 *
 * @param {'player'|'ai'} kind 从哪个库挑
 * @param {{title?: string}} opts
 * @returns {Promise<object|null>} 选中的角色卡（深拷贝），取消返回 null
 */
export async function pickCharFromLibrary(kind, { title = '从角色卡库选择' } = {}) {
  const list = (await window.api.listChars(kind)) || [];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const { backdrop, close } = openModal(`
      <div class="modal pick-modal">
        <div class="modal-head">
          <h2>${escapeHtml(title)}</h2>
          <button class="icon-btn" data-close>×</button>
        </div>
        <div class="modal-body">
          <div class="pick-list" id="pickList"></div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
        </div>
      </div>
    `);

    // 弹窗关掉时若还没选，按取消处理
    const obs = new MutationObserver(() => {
      if (!backdrop.isConnected) { obs.disconnect(); finish(null); }
    });
    obs.observe(document.querySelector('#modalRoot'), { childList: true });

    const box = backdrop.querySelector('#pickList');

    if (!list.length) {
      box.innerHTML = `<div class="empty-hint">这个库里还没有角色卡。先去「角色卡」页面新建一张。</div>`;
      return;
    }

    for (const entry of list) {
      const ch = entry.char || {};
      const d = ch.derived || {};
      const row = document.createElement('button');
      row.className = 'pick-row';
      row.innerHTML = `
        <span class="pr-name">${escapeHtml(entry.name || ch.name || '未命名')}</span>
        <span class="pr-meta">${escapeHtml(ch.occupation || '无职业')} · HP ${d.HP ?? '?'} SAN ${d.SAN ?? '?'}</span>
      `;
      row.onclick = () => {
        // 深拷贝，避免选中的卡跟库里那份共享引用
        finish(JSON.parse(JSON.stringify(ch)));
        close();
      };
      box.appendChild(row);
    }
  });
}
