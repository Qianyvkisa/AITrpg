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
import { pickCharFromLibrary, saveCharToLibrary } from './charLibrary.js';

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

  // 调查员伙伴：从角色卡库挑来的后备力量。
  // 跟「队友」不同——队友全程跟着队伍，伙伴留在外面，
  // 需要时由 KP 判断能不能赶来支援。
  let companions = [];

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
            <h3>角色卡 <span class="hint">手动填写 / 随机骰点 / 让 AI 生成 / 从库导入</span></h3>
            <div class="char-card-list" id="charCardList"></div>
            <div class="hint">点「编辑」打开完整角色卡（含技能表、背景故事、装备与经历）</div>
          </section>

          <section class="field-group" id="companionSection">
            <h3>
              调查员伙伴
              <span class="hint">从角色卡库挑人，需要时赶来支援</span>
            </h3>
            <div class="companion-list" id="companionList"></div>
            <div class="companion-actions">
              <button class="btn ghost sm" id="btnAddCompanion">+ 添加伙伴</button>
            </div>
            <div class="hint">
              伙伴不随队行动。剧情上需要人手时，KP 会判断他们能否及时赶到
              （看距离、处境和他们的状态），能来就让他们登场支援。
            </div>
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
  const charRow = (ch, { label, onEdit, onRandom, onImport, onSaveToLib, onRemove }) => {
    const d = ch.derived || {};
    // 空白卡：没职业、也没加过任何技能点。
    //
    // 玩家默认卡按产品约定就是空白（等玩家自己点 AI 生成 / 随机 / 导入），
    // 但界面上原来只显示「无职业 · HP 10 SAN 50」，看起来像一张正常的卡，
    // 玩家很容易直接开团，上桌才发现技能全是初始值。
    // 这里给一条明确的提示，把「这张卡还没车」说出来。
    const isEmpty = !String(ch.occupation || '').trim();
    const el = document.createElement('div');
    el.className = 'char-row' + (isEmpty ? ' is-empty' : '');
    el.innerHTML = `
      <div class="cr-main">
        <span class="cr-label">${escapeHtml(label)}</span>
        <span class="cr-name">${escapeHtml(ch.name)}</span>
        <span class="cr-meta">${escapeHtml(ch.occupation || '无职业')} · HP ${d.HP ?? '?'} SAN ${d.SAN ?? '?'} MP ${d.MP ?? '?'}</span>
        ${isEmpty ? '<span class="cr-empty-tip">这张卡还没车：点「编辑」后选「AI 生成」，或直接点「随机」</span>' : ''}
      </div>
      <div class="cr-actions">
        <button class="btn ghost sm" data-act="edit">编辑</button>
        <button class="btn ghost sm" data-act="random">随机</button>
        ${onImport ? '<button class="btn ghost sm" data-act="import" title="从角色卡库挑一张">导入</button>' : ''}
        ${onSaveToLib ? '<button class="btn ghost sm" data-act="save" title="把这张卡存进角色卡库">存库</button>' : ''}
        ${onRemove ? '<button class="icon-btn danger" data-act="remove">×</button>' : ''}
      </div>
    `;
    el.querySelector('[data-act="edit"]').onclick = onEdit;
    el.querySelector('[data-act="random"]').onclick = onRandom;
    if (onImport) el.querySelector('[data-act="import"]').onclick = onImport;
    if (onSaveToLib) el.querySelector('[data-act="save"]').onclick = onSaveToLib;
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
        },
        // 玩家只能从「玩家角色卡」库里挑
        onImport: async () => {
          const picked = await pickCharFromLibrary('player', { title: '导入玩家角色卡' });
          if (picked) { Object.assign(playerChar, picked); renderChars(); }
        },
        onSaveToLib: async () => {
          // 同一张卡重复点「存库」应当更新库里的那一份，而不是又加一张。
          // 覆盖判定由主进程按角色卡自带的 char.id 完成（见 ipc-files.js char:save）。
          const r = await saveCharToLibrary('player', playerChar, { name: playerChar.name });
          flashSaved(r && r.updated ? '已更新库里的玩家角色卡' : '已存进玩家角色卡库');
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
        // 队友从「AI 角色卡」库里挑
        onImport: async () => {
          const picked = await pickCharFromLibrary('ai', { title: `导入队友 ${i + 1} 的角色卡` });
          if (picked) { Object.assign(t, picked); renderChars(); }
        },
        onSaveToLib: async () => {
          const r = await saveCharToLibrary('ai', t, { name: t.name });
          flashSaved(r && r.updated
            ? `已更新库里的队友角色卡：${t.name}`
            : `已存进 AI 角色卡库：${t.name}`);
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

  // -------------------------------------------------------------------------
  // 调查员伙伴
  // -------------------------------------------------------------------------
  /** 短暂提示，用于「存库」这类没有可见结果的操作 */
  let flashTimer = null;
  const flashSaved = (msg) => {
    const box = backdrop.querySelector('#companionFlash') || (() => {
      const el = document.createElement('div');
      el.id = 'companionFlash';
      el.className = 'setup-flash';
      backdrop.querySelector('#companionSection')?.appendChild(el);
      return el;
    })();
    box.textContent = msg;
    box.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => box.classList.remove('on'), 2000);
  };

  const renderCompanions = () => {
    const box = backdrop.querySelector('#companionList');
    if (!box) return;
    box.innerHTML = '';

    if (!companions.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '还没有添加伙伴。点下面「添加伙伴」从角色卡库挑人。';
      box.appendChild(hint);
      return;
    }

    companions.forEach((c, i) => {
      const d = c.derived || {};
      const el = document.createElement('div');
      el.className = 'companion-row';
      el.innerHTML = `
        <div class="cp-main">
          <span class="cp-name">${escapeHtml(c.name)}</span>
          <span class="cp-meta">${escapeHtml(c.occupation || '无职业')} · HP ${d.HP ?? '?'} SAN ${d.SAN ?? '?'}</span>
        </div>
        <div class="cp-actions">
          <button class="btn ghost sm" data-act="view">查看</button>
          <button class="icon-btn danger" data-act="remove" title="移除">×</button>
        </div>
      `;
      // 伙伴只读查看：这一局里他们不在队中，改卡会让人困惑
      el.querySelector('[data-act="view"]').onclick = () => openCharEditor(c, {
        title: `伙伴：${c.name}`,
        state, api,
        onSaved: () => renderCompanions()
      });
      el.querySelector('[data-act="remove"]').onclick = () => {
        companions.splice(i, 1);
        renderCompanions();
      };
      box.appendChild(el);
    });
  };

  const addCompanionBtn = backdrop.querySelector('#btnAddCompanion');
  if (addCompanionBtn) {
    addCompanionBtn.onclick = async () => {
      const picked = await pickCharFromLibrary('ai', { title: '选择调查员伙伴' });
      if (!picked) return;
      // 同一张卡别重复添加
      if (companions.some((c) => c.name === picked.name && c.occupation === picked.occupation)) {
        flashSaved('这张卡已经在伙伴列表里了');
        return;
      }
      companions.push(picked);
      renderCompanions();
    };
  }

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
  renderCompanions();
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
      teammates: teammates.slice(0, count),
      // 调查员伙伴：不随队，需要时由 KP 判断能否赶来支援
      companions: companions.slice()
    });
  };
}
