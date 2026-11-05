// ---------------------------------------------------------------------------
// 游戏设定界面：点击「开始」后、正式进入游戏前的一层
//
// 在这里决定：
//   1) 参与方式：成为调查员 / 旁观
//   2) 选哪个模组（内置模组 / 已导入的模组 / 不选 = 自由创作）
//   3) 带几个 AI 队友
//   4) 车角色卡：玩家自己的 + 每位队友的（手动填 / 随机骰 / AI 生成）
//
// 布局：宽屏时左右分栏（左边选项、右边模组简介），窄屏时退回单列。
// 模组简介只展示公开信息（时代 / 地点 / 概述 / 车卡建议），绝不剧透正文。
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';
import { MODES, TEAMMATE_COUNT_OPTIONS, MAX_TEAMMATES, createTeammate } from '../core/session.js';
import { BUILTIN_MODULES } from '../core/builtinModules.js';
import { moduleInfoFor } from '../core/moduleInfo.js';
import { createDefaultCharacter } from '../state.js';
import { openCharEditor } from './charEditor.js';
import { randomCharacter } from '../services/charGen.js';

/**
 * 打开设定界面。
 * @param {{onStart: (cfg) => void, state?: object, api?: object}} opts
 *   onStart 收到 {mode, module, teammateCount, playerChar, teammates}
 */
export async function openGameSetup({ onStart, state = null, api = null }) {
  const imported = (await window.api.listModules()) || [];

  // 本地选择状态
  let mode = 'player';
  // 默认「不选模组（自由创作）」。
  // 之前默认选中内置模组「旧宅疑影」，导致每次新开局都看到那段旧宅开场白。
  let moduleId = null;
  let teammateCount = 1;

  // 角色卡：玩家 1 张 + 最多 4 位队友
  let playerChar = createDefaultCharacter();
  let teammates = [createTeammate(0)];

  const { backdrop, close } = openModal(`
    <div class="modal setup-modal">
      <div class="modal-head">
        <h2>游戏设定</h2>
        <button class="icon-btn" data-close>×</button>
      </div>

      <div class="setup-grid">
        <!-- 左栏：选项 -->
        <div class="setup-col setup-col-main">

          <section class="field-group">
            <h3>参与方式</h3>
            <div class="mode-picker" id="modePicker">
              ${MODES.map(
                (m) => `
                <button class="mode-opt ${m.key === mode ? 'on' : ''}" data-mode="${m.key}">
                  <span class="mo-label">${escapeHtml(m.label)}</span>
                  <span class="mo-desc">${escapeHtml(m.desc)}</span>
                </button>`
              ).join('')}
            </div>
            <div class="hint" id="modeHint"></div>
          </section>

          <section class="field-group">
            <h3>模组</h3>
            <div class="setup-mod-list" id="setupModList"></div>
          </section>

          <section class="field-group">
            <h3>AI 队友</h3>
            <div class="tm-picker" id="tmPicker">
              ${TEAMMATE_COUNT_OPTIONS.map(
                (n) => `<button class="tm-opt ${n === teammateCount ? 'on' : ''}" data-count="${n}">${n === 0 ? '无' : n + ' 位'}</button>`
              ).join('')}
            </div>
            <div class="hint" id="tmHint"></div>
          </section>

        </div>

        <!-- 右栏：模组简介 + 角色卡 -->
        <div class="setup-col setup-col-side">

          <section class="field-group setup-brief-group">
            <h3>模组简介 <span class="hint" id="briefSpoilerTag">不含剧透，放心看</span></h3>
            <div class="setup-brief" id="setupBrief"></div>
          </section>

          <section class="field-group" id="charSection">
            <h3>角色卡 <span class="hint">手动填写 / 随机骰点 / 让 AI 生成</span></h3>
            <div class="char-card-list" id="charCardList"></div>
            <div class="hint">点「编辑」打开完整角色卡（含技能表、背景故事、装备与经历）</div>
          </section>

        </div>
      </div>

      <div class="modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="btnBeginGame">开始游戏</button>
      </div>
    </div>
  `);

  const modBox = backdrop.querySelector('#setupModList');
  const charBox = backdrop.querySelector('#charCardList');
  const briefBox = backdrop.querySelector('#setupBrief');

  /** 当前选中的模组对象（内置 / 已导入 / null） */
  const selectedModule = () =>
    BUILTIN_MODULES.find((m) => m.id === moduleId) ||
    imported.find((m) => m.id === moduleId) ||
    null;

  // -------------------------------------------------------------------------
  // 模组简介面板
  // -------------------------------------------------------------------------
  /** 渲染右栏的公开简介：只给时代 / 地点 / 概述 / 车卡建议 */
  const renderBrief = () => {
    const info = moduleInfoFor(selectedModule());

    const tagHtml = info.tags.length
      ? `<div class="sb-tags">${info.tags.map((t) => `<span class="m-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    const facts = [
      ['时代', info.era],
      ['地点', info.location]
    ];

    const summaryHtml = info.hasSummary
      ? `<p class="sb-summary">${escapeHtml(info.summary)}</p>`
      : `<p class="sb-summary empty">这份模组没有公开简介，只保留了剧本正文。` +
        `不影响开局，KP 会按正文带团；只是车卡时少了一些参考。</p>`;

    const suggHtml = info.suggestions.length
      ? `<div class="sb-block">
           <div class="sb-label">车卡建议</div>
           <ul class="sb-sugg">${info.suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
         </div>`
      : '';

    briefBox.innerHTML = `
      <div class="sb-title">${escapeHtml(info.title)}</div>
      ${tagHtml}
      <div class="sb-facts">
        ${facts.map(([k, v]) => `<div class="sb-fact"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('')}
      </div>
      ${summaryHtml}
      ${suggHtml}
    `;
  };

  // -------------------------------------------------------------------------
  // 模组列表
  // -------------------------------------------------------------------------
  /** 渲染模组列表（内置 + 已导入 + 自由创作） */
  const renderModules = () => {
    modBox.innerHTML = '';

    const makeRow = ({ id, title, meta, badge }) => {
      const row = document.createElement('button');
      row.className = 'setup-mod-row' + (moduleId === id ? ' on' : '');
      row.dataset.modId = id ?? '';
      row.innerHTML = `
        <span class="sm-title">${escapeHtml(title)}${badge ? `<span class="sm-badge">${escapeHtml(badge)}</span>` : ''}</span>
        <span class="sm-meta">${escapeHtml(meta)}</span>
      `;
      row.onclick = () => {
        moduleId = id;
        renderModules();
        renderBrief();
      };
      modBox.appendChild(row);
    };

    // 自由创作放第一位：它是默认选项，也让「不选模组」一眼可见
    makeRow({
      id: null,
      title: '不选模组（自由创作）',
      meta: '由 KP 现场创作一段短篇调查',
      badge: '默认'
    });

    for (const m of BUILTIN_MODULES) {
      const info = moduleInfoFor(m);
      makeRow({
        id: m.id,
        title: m.title,
        meta: [info.era, info.location].filter(Boolean).join(' · ') || '内置模组',
        badge: '内置'
      });
    }

    for (const m of imported) {
      const info = moduleInfoFor(m);
      const date = m.importedAt ? new Date(m.importedAt).toLocaleDateString() : '';
      makeRow({
        id: m.id,
        title: m.title || '未命名模组',
        meta: [info.era, date].filter(Boolean).join(' · ') || `${(m.raw || '').length} 字`,
        badge: info.hasSummary ? '' : ''
      });
    }
  };

  // -------------------------------------------------------------------------
  // 角色卡列表
  // -------------------------------------------------------------------------
  /** 一张卡的摘要行 */
  const charRow = (ch, { label, onEdit, onRandom, onRemove }) => {
    const d = ch.derived || {};
    const el = document.createElement('div');
    el.className = 'char-row';
    el.innerHTML = `
      <div class="cr-main">
        <span class="cr-label">${escapeHtml(label)}</span>
        <span class="cr-name">${escapeHtml(ch.name)}</span>
        <span class="cr-meta">${escapeHtml(ch.occupation || '无职业')} · HP ${d.HP ?? '?'} SAN ${d.SAN ?? '?'} MP ${d.MP ?? '?'}</span>
      </div>
      <div class="cr-actions">
        <button class="btn ghost sm" data-act="edit">编辑</button>
        <button class="btn ghost sm" data-act="random">随机</button>
        ${onRemove ? '<button class="icon-btn danger" data-act="remove">×</button>' : ''}
      </div>
    `;
    el.querySelector('[data-act="edit"]').onclick = onEdit;
    el.querySelector('[data-act="random"]').onclick = onRandom;
    if (onRemove) el.querySelector('[data-act="remove"]').onclick = onRemove;
    return el;
  };

  const renderChars = () => {
    charBox.innerHTML = '';

    // 玩家角色（旁观模式不显示）
    if (mode === 'player') {
      charBox.appendChild(charRow(playerChar, {
        label: '你扮演',
        onEdit: () => openCharEditor(playerChar, {
          title: '你的角色卡',
          state, api,
          onSaved: () => renderChars()
        }),
        onRandom: () => {
          const fresh = randomCharacter({
            name: playerChar.name,
            isPlayer: true,
            occupation: playerChar.occupation
          });
          Object.assign(playerChar, fresh);
          renderChars();
        }
      }));
    }

    // 队友角色卡
    teammates.forEach((t, i) => {
      charBox.appendChild(charRow(t, {
        label: `队友 ${i + 1}`,
        onEdit: () => openCharEditor(t, {
          title: `队友 ${i + 1} 的角色卡`,
          state, api,
          onSaved: () => renderChars()
        }),
        onRandom: () => {
          const fresh = randomCharacter({ name: t.name, isPlayer: false });
          Object.assign(t, fresh);
          renderChars();
        },
        onRemove: teammates.length > 1
          ? () => {
              teammates.splice(i, 1);
              teammateCount = teammates.length;
              syncTmPicker();
              renderChars();
              refreshHints();
            }
          : null
      }));
    });

    if (mode === 'spectator' && !teammates.length) {
      const tip = document.createElement('div');
      tip.className = 'hint';
      tip.textContent = '旁观模式且没有队友时，这一局将没有调查员。';
      charBox.appendChild(tip);
    }
  };

  /** 队友数变化时，补齐或裁掉角色卡 */
  const syncTeammates = (count) => {
    while (teammates.length < count) teammates.push(createTeammate(teammates.length));
    while (teammates.length > count) teammates.pop();
  };

  const syncTmPicker = () => {
    backdrop.querySelectorAll('.tm-opt').forEach((x) => {
      x.classList.toggle('on', Number(x.dataset.count) === teammateCount);
    });
  };

  /** 参与方式与队友数的联动提示 */
  const refreshHints = () => {
    const modeHint = backdrop.querySelector('#modeHint');
    modeHint.textContent =
      mode === 'spectator'
        ? '旁观模式下你不扮演任何人，由 AI 把这一局演完。'
        : '你会扮演自己车的这位调查员，进入游戏后仍可在左侧面板编辑。';

    const tmHint = backdrop.querySelector('#tmHint');
    tmHint.textContent =
      teammateCount === 0
        ? mode === 'spectator'
          ? '没有队友也没有玩家角色，这一局将没有调查员，只剩 KP 独自叙述。'
          : '没有队友，只有你一个人调查。'
        : `将加入 ${teammateCount} 位 AI 扮演的调查员队友，可以逐位车卡。`;
  };

  renderModules();
  renderBrief();
  renderChars();
  refreshHints();

  backdrop.querySelectorAll('.mode-opt').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode;
      backdrop.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('on', x === b));
      renderChars();
      refreshHints();
    };
  });

  backdrop.querySelectorAll('.tm-opt').forEach((b) => {
    b.onclick = () => {
      teammateCount = Number(b.dataset.count);
      syncTeammates(teammateCount);
      syncTmPicker();
      renderChars();
      refreshHints();
    };
  });

  backdrop.querySelector('#btnBeginGame').onclick = () => {
    const module = selectedModule();
    const count = Math.min(teammateCount, MAX_TEAMMATES);

    close();
    onStart({
      mode,
      module,
      teammateCount: count,
      // 把车好的卡交给开局流程；没有的让 session 自己补
      playerChar: mode === 'player' ? playerChar : null,
      teammates: teammates.slice(0, count)
    });
  };
}
