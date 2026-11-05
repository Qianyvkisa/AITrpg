// ---------------------------------------------------------------------------
// 角色卡编辑器：对齐《COC7空白卡23（粉）-坪改.xlsx》的分区
//
// 标签页：基本信息 / 属性 / 技能 / 状态与资产 / 背景 / 装备与经历
// 支持手动填写、随机骰点、AI 一键生成。
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import {
  ATTRS, SKILL_DEFS, baseSkillValue, refreshDerived, rollAttributes, skillLevels,
  normalizeCharacter
} from '../core/character.js';
import { isOccupationalSkill, skillPointBudget, suggestOccupations } from '../core/occupations.js';
import { escapeHtml } from '../shared/text.js';
import { randomCharacter } from '../services/charGen.js';

/** 属性对应的评价文字（与 Excel 的 AU 列一致） */
const ATTR_HINTS = {
  STR: ['虚弱，孱弱', '力量弱小', '普通', '结实有力', '力大无穷'],
  CON: ['常年患病在身', '体弱多病', '还算健康', '体魄强健', '钢铁之躯'],
  SIZ: ['孩童，身短体瘦', '偏瘦小', '中等身材', '高大魁梧', '巨人般的存在'],
  DEX: ['笨手笨脚', '不是很灵活', '中规中矩', '身手敏捷', '快如闪电'],
  APP: ['用脸就能吓跑队友', '有些难看', '普通长相', '相貌出众', '惊艳全场'],
  INT: ['脑子是个好东西', '理解知识要花时间', '正常智力', '头脑灵活', '天才'],
  POW: ['意志薄弱', '容易动摇', '意志尚可', '意志坚定', '心如铁石'],
  EDU: ['目不识丁', '小学毕业', '中学水平', '大学毕业', '学识渊博'],
  LUCK: ['霉运连连', '运气不佳', '运气一般', '幸运儿', '命运的宠儿']
};

function attrHint(key, v) {
  const idx = v <= 20 ? 0 : v <= 40 ? 1 : v <= 60 ? 2 : v <= 80 ? 3 : 4;
  return ATTR_HINTS[key]?.[idx] || '';
}

/**
 * 打开角色卡编辑器。
 *
 * 兼容两种调用方式：
 *   openCharEditor(state, ch, onChanged)      —— 旧签名，游戏内编辑用
 *   openCharEditor(ch, { title, onSaved, ... })—— 新签名，设定界面用
 *
 * @param {object} a 角色卡，或旧的 state
 * @param {object|Function} b 角色卡 / 选项 / 回调
 * @param {Function} [c] 旧签名的 onChanged
 */
export function openCharEditor(a, b, c) {
  let ch, state = null, onSaved = null;
  let title = '调查员档案';
  let allowAIGen = true;
  let api = null;

  // 旧签名判定：第一个参数是游戏 state（含 playerChar 且没有 attrs），
  // 第二个参数才是角色卡。角色卡自身不会有 playerChar 字段。
  const looksLikeState =
    a && typeof a === 'object' && !Array.isArray(a) &&
    !('attrs' in a) && ('playerChar' in a) &&
    b && typeof b === 'object' && 'attrs' in b;

  if (looksLikeState) {
    // 旧签名：openCharEditor(state, ch, onChanged)
    state = a;
    ch = b;
    onSaved = typeof c === 'function' ? c : null;
  } else {
    // 新签名：openCharEditor(ch, opts)
    ch = a;
    const opts = (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
    onSaved = opts.onSaved || (typeof b === 'function' ? b : null);
    title = opts.title || title;
    allowAIGen = opts.allowAIGen !== false;
    state = opts.state || null;
    api = opts.api || null;
  }

  return openCharEditorImpl(ch, { title, onSaved, allowAIGen, state, api });
}

function openCharEditorImpl(ch, opts = {}) {
  const { title = '调查员档案', onSaved, allowAIGen = true, state = null, api = null } = opts;

  // 编辑副本，取消时不污染原卡
  const work = normalizeCharacter(JSON.parse(JSON.stringify(ch)));
  let activeTab = 'basic';

  const TABS = [
    { key: 'basic', label: '基本信息' },
    { key: 'attrs', label: '属性' },
    { key: 'skills', label: '技能' },
    { key: 'status', label: '状态 / 资产' },
    { key: 'bg', label: '背景故事' },
    { key: 'gear', label: '装备 / 经历' }
  ];

  const { backdrop, close } = openModal(`
    <div class="modal xwide char-editor">
      <div class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <div class="ce-head-actions">
          <button class="btn ghost sm" id="btnRollAttrs">随机属性</button>
          <button class="btn ghost sm" id="btnRandomAll">随机整卡</button>
          ${allowAIGen ? '<button class="btn ghost sm ai" id="btnAIGen">AI 生成</button>' : ''}
          <button class="icon-btn" data-close>×</button>
        </div>
      </div>

      <div class="ce-tabs" id="ceTabs">
        ${TABS.map((t) => `<button class="ce-tab ${t.key === activeTab ? 'on' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>

      <div class="modal-body ce-body" id="ceBody"></div>

      <div class="modal-foot">
        <span class="hint" id="ceSummary"></span>
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="btnSaveChar">保存角色卡</button>
      </div>
    </div>
  `);

  const body = backdrop.querySelector('#ceBody');

  // -------------------------------------------------------------------------
  // 各标签页渲染
  // -------------------------------------------------------------------------
  const renderBasic = () => `
    <section class="field-group">
      <h3>调查员信息</h3>
      <div class="field-grid-3">
        <label class="field"><span>姓名</span><input id="fName" type="text" value="${escapeHtml(work.name)}"></label>
        <label class="field"><span>玩家</span><input id="fPlayer" type="text" value="${escapeHtml(work.player || '')}" placeholder="留空即可"></label>
        <label class="field"><span>职业</span><input id="fOcc" type="text" value="${escapeHtml(work.occupation)}" placeholder="记者 / 医生 / 私家侦探"></label>
        <label class="field"><span>年龄</span><input id="fAge" type="number" min="15" max="90" value="${work.age}"></label>
        <label class="field"><span>性别</span><input id="fGender" type="text" value="${escapeHtml(work.gender || '')}"></label>
        <label class="field"><span>时代</span><input id="fEra" type="text" value="${escapeHtml(work.era || '1920s')}"></label>
        <label class="field"><span>故乡</span><input id="fHometown" type="text" value="${escapeHtml(work.hometown || '')}"></label>
        <label class="field"><span>住地</span><input id="fResidence" type="text" value="${escapeHtml(work.residence || '')}"></label>
      </div>
    </section>

    <section class="field-group">
      <h3>性格设定（给 KP 与 AI 看）</h3>
      <label class="field">
        <span>一句话性格概括</span>
        <input id="fPersona" type="text" value="${escapeHtml(work.persona || '')}" placeholder="例如：沉默寡言的老兵，遇到危险反而冷静">
      </label>
    </section>
  `;

  const renderAttrs = () => {
    const rows = ATTRS.map((a) => {
      const v = work.attrs[a.key];
      return `
        <div class="attr-cell">
          <div class="ac-head"><span class="ac-name">${a.name}</span><span class="ac-en">${a.en}</span></div>
          <input type="number" min="1" max="99" step="5" data-attr="${a.key}" value="${v}">
          <div class="ac-hint" data-hint="${a.key}">${escapeHtml(attrHint(a.key, v))}</div>
        </div>`;
    }).join('');

    const d = work.derived;
    return `
      <section class="field-group">
        <h3>属性 <span class="hint">3d6×5，SIZ/INT/EDU 用 (2d6+6)×5</span></h3>
        <div class="attr-edit-grid">${rows}</div>
      </section>

      <section class="field-group">
        <h3>派生值（自动计算）</h3>
        <div class="derived-grid">
          <div class="dv"><span>生命值 HP</span><b>${d.HP}</b><small>(CON+SIZ)/10</small></div>
          <div class="dv"><span>理智 SAN</span><b>${d.SAN}</b><small>= POW</small></div>
          <div class="dv"><span>魔法 MP</span><b>${d.MP}</b><small>POW/5</small></div>
          <div class="dv"><span>体格 Build</span><b>${d.build}</b><small>STR+SIZ</small></div>
          <div class="dv"><span>伤害加值</span><b>${d.db}</b><small>STR+SIZ</small></div>
          <div class="dv"><span>移动力 MOV</span><b>${d.MOV}</b><small>DEX/STR/SIZ</small></div>
        </div>
      </section>
    `;
  };

  // -------------------------------------------------------------------------
  // 技能点账目
  //
  // 规则来自 COC7 空白卡那张 Excel（详见 core/occupations.js 顶部注释）：
  //   剩余职业点 = 职业公式结果 − 加到本职技能上的点
  //   剩余兴趣点 = 智力×2     − 加到非本职技能上的点
  // 只有「超过初始值」的部分才算加点，所以先要能取到每个技能的初始值。
  // -------------------------------------------------------------------------
  const baseOf = (skillName) => {
    const def = SKILL_DEFS.find((d) => d.name === skillName);
    return def ? baseSkillValue(def, work.attrs) : 0;
  };
  const displayOf = (skillName) => work.customNames?.[skillName] || '';
  const isOccSkill = (skillName) => isOccupationalSkill(work, skillName, displayOf);
  const budget = () => skillPointBudget(work, baseOf, isOccSkill);

  /** 把账目渲染成一行文字，供技能页顶部显示 */
  const budgetLine = () => {
    const b = budget();

    // 没填职业
    if (!b.occupation) {
      const filled = String(work.occupation || '').trim();
      if (!filled) {
        return '<div class="sk-budget empty">还没填职业，职业点无法计算。去「基本信息」填一个职业名，比如「会计师」「记者」。</div>';
      }
      // 填了但职业表里没有：给候选，别让玩家以为程序坏了
      const sugg = suggestOccupations(filled);
      const tail = sugg.length
        ? `<div class="sk-suggest">最接近的标准职业：${sugg.map((s) => `<button type="button" class="sk-suggest-item" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join(' ')}</div>`
        : '';
      return `<div class="sk-budget empty" data-budget-unknown>
        <div>「${escapeHtml(filled)}」不在职业表里，职业点无法计算。</div>
        <div class="sk-suggest-hint">去「基本信息」改成标准职业名，或点下面任意一个替换。</div>
        ${tail}
      </div>`;
    }

    const over = b.occLeft < 0 || b.intLeft < 0;
    const cls = over ? 'sk-budget over' : 'sk-budget';
    return `
      <div class="${cls}" data-budget="occ">
        <div class="sk-budget-item" data-budget-occ>
          <span>职业点</span>
          <b>${b.occUsed} / ${b.occTotal}</b>
          <em>剩 ${b.occLeft}</em>
        </div>
        <div class="sk-budget-item" data-budget-int>
          <span>兴趣点</span>
          <b>${b.intUsed} / ${b.intTotal}</b>
          <em>剩 ${b.intLeft}</em>
        </div>
        <div class="sk-budget-occ">${escapeHtml(b.occupation.name)}（${escapeHtml(b.occupation.credit)}）· ${escapeHtml(b.occupation.pts)}</div>
      </div>`;
  };

  const renderSkills = () => {
    const rows = SKILL_DEFS.map((def) => {
      const val = work.skills[def.name] ?? def.base;
      const lv = skillLevels(val);
      const customName = def.custom
        ? `<input class="sk-custom" type="text" data-custom="${escapeHtml(def.name)}"
             value="${escapeHtml(work.customNames[def.name] || '')}" placeholder="具体名称">`
        // 非自定义技能没有输入框，但网格是 4 列，留个空位保证列对齐
        : '<span class="sk-custom-gap"></span>';
      const occ = isOccSkill(def.name);

      // 克苏鲁神话：车卡阶段不给加点（原版规则只能靠游戏内遭遇增长）。
      // 但游戏进行中打开这个编辑器时（带 state），神话值要能改，
      // 否则玩家没法结算遭遇带来的增长。
      if (def.mythos && !state) {
        return `
        <div class="ce-skill-row is-locked" data-skillrow="${escapeHtml(def.name)}">
          <span class="sk-name">${escapeHtml(def.name)} <em class="sk-warn">⚠</em></span>
          <span class="sk-lock-hint">不可加点</span>
          <span class="sk-val-readonly" data-skill="${escapeHtml(def.name)}">${val}</span>
          <span class="sk-levels" data-levels="${escapeHtml(def.name)}">${lv.hard} / ${lv.extreme}</span>
        </div>`;
      }

      return `
        <div class="ce-skill-row ${occ ? 'is-occ' : ''}" data-skillrow="${escapeHtml(def.name)}">
          <span class="sk-name">${escapeHtml(def.name)}</span>
          ${customName}
          <div class="sk-stepper">
            <button type="button" class="sk-step" data-step-down="${escapeHtml(def.name)}" aria-label="减少">−</button>
            <input class="sk-val" type="number" min="0" max="99" data-skill="${escapeHtml(def.name)}" value="${val}">
            <button type="button" class="sk-step" data-step-up="${escapeHtml(def.name)}" aria-label="增加">＋</button>
            <button type="button" class="sk-step sk-reset" data-reset-skill="${escapeHtml(def.name)}" title="重置为初始值 ${baseOf(def.name)}" aria-label="重置">↺</button>
          </div>
          <span class="sk-levels" data-levels="${escapeHtml(def.name)}">${lv.hard} / ${lv.extreme}</span>
        </div>`;
    }).join('');

    return `
      <section class="field-group">
        <h3>技能点 <span class="hint">本职技能加点走职业点，其余走兴趣点</span></h3>
        <div id="skBudget">${budgetLine()}</div>
      </section>

      <section class="field-group">
        <h3 class="sk-head">
          技能表
          <span class="hint">右列显示 困难值 / 极难值</span>
          <button type="button" class="sk-reset-all" id="btnResetAllSkills"
                  title="把所有技能退回初始值，等于清空加点">全部重置</button>
        </h3>
        <div class="ce-skill-grid">${rows}</div>
      </section>
    `;
  };

  const renderStatus = () => `
    <section class="field-group">
      <h3>当前状态</h3>
      <div class="field-grid-3">
        <label class="field"><span>HP 当前 / 上限</span>
          <div class="pair">
            <input id="fHp" type="number" min="0" value="${work.hp.current}">
            <span class="sep">/</span><b id="fHpMax">${work.hp.max}</b>
          </div>
        </label>
        <label class="field"><span>MP 当前 / 上限</span>
          <div class="pair">
            <input id="fMp" type="number" min="0" value="${work.mp.current}">
            <span class="sep">/</span><b id="fMpMax">${work.mp.max}</b>
          </div>
        </label>
        <label class="field"><span>SAN 当前 / 上限</span>
          <div class="pair">
            <input id="fSan" type="number" min="0" value="${work.san.current}">
            <span class="sep">/</span><b id="fSanMax">${work.san.temp}</b>
          </div>
        </label>
        <label class="field"><span>幸运</span><input id="fLuck" type="number" min="0" max="99" value="${work.luck.current}"></label>
      </div>
      <label class="field">
        <span>状态标签（逗号分隔，如：重伤、昏迷、临时疯狂）</span>
        <input id="fStatus" type="text" value="${escapeHtml((work.status || []).join('、'))}">
      </label>
    </section>

    <section class="field-group">
      <h3>资产</h3>
      <div class="field-grid-3">
        <label class="field"><span>信用评级</span><input id="fCredit" type="number" min="0" max="99" value="${work.assets.creditRating}"></label>
        <label class="field"><span>生活水平</span><input id="fLiving" type="text" value="${escapeHtml(work.assets.livingStandard || '')}" placeholder="贫穷 / 普通 / 富裕"></label>
        <label class="field"><span>当前现金</span><input id="fCash" type="number" min="0" value="${work.assets.cash}"></label>
      </div>
      <label class="field"><span>其他资产</span>
        <textarea id="fAssets" rows="2" placeholder="房产、车辆、股票等">${escapeHtml(work.assets.otherAssets || '')}</textarea>
      </label>
    </section>
  `;

  const BG_FIELDS = [
    ['description', '形象描述', '例如：瘦高个，西装总是皱的，右眼有点斜'],
    ['ideology', '思想与信念', '例如：相信证据胜过相信人'],
    ['significantPeople', '重要之人', '例如：妹妹，三年没联系了'],
    ['meaningfulLocations', '意义非凡之地', '例如：大学图书馆三楼'],
    ['treasuredPossessions', '宝贵之物', '例如：父亲留下的怀表'],
    ['traits', '特质', '例如：习惯性撒谎，但讨厌别人撒谎'],
    ['wounds', '伤口和疤痕', '例如：左臂一道旧刀伤'],
    ['phobias', '恐惧症和躁狂症', '例如：怕水']
  ];

  const renderBg = () => `
    <section class="field-group">
      <h3>背景故事</h3>
      <div class="field-grid-2">
        ${BG_FIELDS.map(
          ([k, label, ph]) => `
          <label class="field"><span>${label}</span>
            <input data-bg="${k}" type="text" value="${escapeHtml(work.background[k] || '')}" placeholder="${escapeHtml(ph)}">
          </label>`
        ).join('')}
      </div>
      <label class="field">
        <span>完整背景故事</span>
        <textarea data-bg="story" rows="6" placeholder="他/她为什么会在调查这些事？">${escapeHtml(work.background.story || '')}</textarea>
      </label>
    </section>
  `;

  const renderGear = () => `
    <section class="field-group">
      <h3>武器</h3>
      <div class="table-list" id="weaponList">
        ${(work.weapons || []).map((w, i) => `
          <div class="tl-row" data-wi="${i}">
            <input type="text" data-w="name" value="${escapeHtml(w.name || '')}" placeholder="武器名">
            <input type="text" data-w="skill" value="${escapeHtml(w.skill || '')}" placeholder="使用技能">
            <input type="text" data-w="damage" value="${escapeHtml(w.damage || '')}" placeholder="伤害">
            <input type="text" data-w="range" value="${escapeHtml(w.range || '')}" placeholder="射程">
            <button class="icon-btn danger" data-delweapon="${i}">×</button>
          </div>`).join('')}
      </div>
      <button class="btn ghost sm" id="btnAddWeapon">+ 添加武器</button>
    </section>

    <section class="field-group">
      <h3>随身物品</h3>
      <label class="field">
        <textarea id="fInventory" rows="4" placeholder="每行一件">${escapeHtml((work.inventory || []).join('\n'))}</textarea>
      </label>
    </section>

    <section class="field-group">
      <h3>调查员经历</h3>
      <div class="table-list" id="expList">
        ${(work.experiences || []).map((e, i) => `
          <div class="tl-row" data-ei="${i}">
            <input type="text" data-e="module" value="${escapeHtml(e.module || '')}" placeholder="经历模组">
            <input type="text" data-e="change" value="${escapeHtml(e.change || '')}" placeholder="人物变化（如 SAN-3、侦查+2）">
            <button class="icon-btn danger" data-delexp="${i}">×</button>
          </div>`).join('')}
      </div>
      <button class="btn ghost sm" id="btnAddExp">+ 添加经历</button>
    </section>

    <section class="field-group">
      <h3>法术一览</h3>
      <div class="table-list" id="spellList">
        ${(work.spells || []).map((s, i) => `
          <div class="tl-row" data-si="${i}">
            <input type="text" data-s="name" value="${escapeHtml(s.name || '')}" placeholder="法术名">
            <input type="text" data-s="cost" value="${escapeHtml(s.cost || '')}" placeholder="代价（如 8mp 1d6san）">
            <input type="text" data-s="effect" value="${escapeHtml(s.effect || '')}" placeholder="作用">
            <button class="icon-btn danger" data-delspell="${i}">×</button>
          </div>`).join('')}
      </div>
      <button class="btn ghost sm" id="btnAddSpell">+ 添加法术</button>
    </section>
  `;

  // -------------------------------------------------------------------------
  // 收集当前页面的输入（切标签页前必须做，否则内容会丢）
  // -------------------------------------------------------------------------
  const collect = () => {
    const q = (sel) => backdrop.querySelector(sel);

    // 基本信息
    if (q('#fName')) {
      work.name = q('#fName').value.trim().slice(0, 20) || '调查员';
      work.player = q('#fPlayer').value.trim();
      work.occupation = q('#fOcc').value.trim();
      const age = parseInt(q('#fAge').value, 10);
      if (!isNaN(age)) work.age = Math.max(15, Math.min(90, age));
      work.gender = q('#fGender').value.trim();
      work.era = q('#fEra').value.trim();
      work.hometown = q('#fHometown').value.trim();
      work.residence = q('#fResidence').value.trim();
      work.persona = q('#fPersona').value.trim();
    }

    // 属性
    backdrop.querySelectorAll('[data-attr]').forEach((inp) => {
      const v = parseInt(inp.value, 10);
      if (!isNaN(v)) work.attrs[inp.dataset.attr] = Math.max(1, Math.min(99, v));
    });

    // 技能
    backdrop.querySelectorAll('[data-skill]').forEach((inp) => {
      // 只读的（克苏鲁神话）是 span，没有 value 可读，跳过
      if (inp.tagName !== 'INPUT') return;
      const v = parseInt(inp.value, 10);
      if (!isNaN(v)) work.skills[inp.dataset.skill] = Math.max(0, Math.min(99, v));
    });
    backdrop.querySelectorAll('[data-custom]').forEach((inp) => {
      const k = inp.dataset.custom;
      const v = inp.value.trim();
      if (v) work.customNames[k] = v;
      else delete work.customNames[k];
    });

    // 状态 / 资产
    if (q('#fHp')) {
      const num = (sel, def) => {
        const v = parseInt(q(sel).value, 10);
        return isNaN(v) ? def : v;
      };
      work.hp.current = num('#fHp', work.hp.current);
      work.mp.current = num('#fMp', work.mp.current);
      work.san.current = num('#fSan', work.san.current);
      work.luck.current = num('#fLuck', work.luck.current);

      const st = q('#fStatus').value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      work.status = st;

      work.assets.creditRating = num('#fCredit', work.assets.creditRating);
      work.assets.livingStandard = q('#fLiving').value.trim();
      work.assets.cash = num('#fCash', work.assets.cash);
      work.assets.otherAssets = q('#fAssets').value.trim();
    }

    // 背景
    backdrop.querySelectorAll('[data-bg]').forEach((inp) => {
      work.background[inp.dataset.bg] = inp.value.trim();
    });

    // 装备 / 经历
    if (q('#fInventory')) {
      work.inventory = q('#fInventory').value.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const collectRows = (rowSel, attrSel, fields, out) => {
      const rows = [];
      let blank = null;
      backdrop.querySelectorAll(rowSel).forEach((row) => {
        const item = {};
        fields.forEach((f) => {
          const inp = row.querySelector(`[${attrSel}="${f}"]`);
          if (inp) item[f] = inp.value.trim();
        });
        if (Object.values(item).some((v) => v)) {
          rows.push(item);
        } else {
          // 完全空白的行：只保留最后一行（通常就是用户刚点「+」新建、还没填的那行）
          blank = item;
        }
      });
      out.length = 0;
      out.push(...rows);
      // 保留一个空行，避免用户刚添加的行被下一次 collect 吞掉
      if (blank && !rows.length) out.push(blank);
    };
    collectRows('[data-wi]', 'data-w', ['name', 'skill', 'damage', 'range'], work.weapons);
    collectRows('[data-ei]', 'data-e', ['module', 'change'], work.experiences);
    collectRows('[data-si]', 'data-s', ['name', 'cost', 'effect'], work.spells);

    // 夹紧状态值
    refreshDerived(work);
    work.hp.current = Math.max(0, Math.min(work.hp.max, work.hp.current));
    work.mp.current = Math.max(0, Math.min(work.mp.max, work.mp.current));
    work.san.current = Math.max(0, Math.min(work.san.temp, work.san.current));
  };

  /** 摘要行：保存前一眼能看清这卡的关键值 */
  const refreshSummary = () => {
    const d = work.derived;
    const el = backdrop.querySelector('#ceSummary');
    if (el) {
      el.textContent = `${work.name} · ${work.occupation || '无职业'} · HP ${d.HP} SAN ${d.SAN} MP ${d.MP} · 伤害加值 ${d.db}`;
    }
  };

  /** 渲染当前标签页 */
  const renderTab = () => {
    const map = {
      basic: renderBasic, attrs: renderAttrs, skills: renderSkills,
      status: renderStatus, bg: renderBg, gear: renderGear
    };
    body.innerHTML = (map[activeTab] || renderBasic)();
    backdrop.querySelectorAll('.ce-tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.tab === activeTab);
    });
    bindTab();
    refreshSummary();
  };

  // -------------------------------------------------------------------------
  // 各标签页的即时联动
  // -------------------------------------------------------------------------
  const bindTab = () => {
    // 基本信息页：职业改动要立刻写回 work，
    // 否则直接切到「技能」页时，点数账目还是按旧职业算的。
    if (activeTab === 'basic') {
      const occ = backdrop.querySelector('#fOcc');
      if (occ) occ.oninput = () => { work.occupation = occ.value.trim(); refreshSummary(); };
    }

    if (activeTab === 'attrs') {
      backdrop.querySelectorAll('[data-attr]').forEach((inp) => {
        inp.oninput = () => {
          const v = parseInt(inp.value, 10);
          if (!isNaN(v)) {
            work.attrs[inp.dataset.attr] = Math.max(1, Math.min(99, v));
            const hint = backdrop.querySelector(`[data-hint="${inp.dataset.attr}"]`);
            if (hint) hint.textContent = attrHint(inp.dataset.attr, v);
            refreshDerived(work);
            refreshSummary();
          }
        };
      });
    }

    if (activeTab === 'skills') {
      /** 技能值变了要同时刷新困难/极难值和顶部点数账目 */
      const refreshBudget = () => {
        const el = backdrop.querySelector('#skBudget');
        if (el) el.innerHTML = budgetLine();
      };

      /**
       * 统一改技能值：夹到 0~99，同步输入框、困难/极难值、点数账目。
       * 输入框直接改和点 −/＋ 都走这里，避免两条路径行为不一致。
       */
      const setSkill = (name, next) => {
        const v = Math.max(0, Math.min(99, Math.round(Number(next) || 0)));
        work.skills[name] = v;

        const inp = backdrop.querySelector(`[data-skill="${name}"]`);
        if (inp && inp.value !== String(v)) inp.value = v;

        const lv = skillLevels(v);
        const el = backdrop.querySelector(`[data-levels="${name}"]`);
        if (el) el.textContent = `${lv.hard} / ${lv.extreme}`;

        refreshBudget();
      };

      backdrop.querySelectorAll('[data-skill]').forEach((inp) => {
        // 只读的（克苏鲁神话）没有输入框，这里是 number input
        if (inp.tagName !== 'INPUT') return;
        inp.oninput = () => setSkill(inp.dataset.skill, inp.value);
      });

      // − / ＋ 步进按钮
      backdrop.querySelectorAll('[data-step-up]').forEach((btn) => {
        btn.onclick = (ev) => {
          const name = btn.dataset.stepUp;
          const cur = Number(work.skills[name] ?? 0);
          // 按住 Shift 一次加 10，方便快速拉到目标值
          setSkill(name, cur + (ev.shiftKey ? 10 : 1));
        };
      });
      backdrop.querySelectorAll('[data-step-down]').forEach((btn) => {
        btn.onclick = (ev) => {
          const name = btn.dataset.stepDown;
          const cur = Number(work.skills[name] ?? 0);
          setSkill(name, cur - (ev.shiftKey ? 10 : 1));
        };
      });

      // ↺ 单个技能重置：退回该技能的初始值（侦查 25、闪避按 DEX/2 算……），
      // 等于只清掉这一个技能的加点，基础值保留。
      backdrop.querySelectorAll('[data-reset-skill]').forEach((btn) => {
        btn.onclick = () => {
          const name = btn.dataset.resetSkill;
          setSkill(name, baseOf(name));
        };
      });

      // 「全部重置」：所有可加点技能一起退回初始值。
      // 克苏鲁神话在车卡阶段本来就锁着，这里也跳过它，别去动它的值。
      const resetAllBtn = backdrop.querySelector('#btnResetAllSkills');
      if (resetAllBtn) {
        resetAllBtn.onclick = () => {
          SKILL_DEFS.forEach((def) => {
            if (def.mythos && !state) return;
            const inp = backdrop.querySelector(`[data-skill="${def.name}"]`);
            if (inp && inp.tagName !== 'INPUT') return;   // 只读行没有输入框
            setSkill(def.name, baseOf(def.name));
          });
        };
      }

      // 自定义子技能名会改变「是否算本职」的判断（任意特长），要一并重算
      backdrop.querySelectorAll('[data-custom]').forEach((inp) => {
        inp.oninput = () => {
          work.customNames[inp.dataset.custom] = inp.value;
          const row = backdrop.querySelector(`[data-skillrow="${inp.dataset.custom}"]`);
          if (row) row.classList.toggle('is-occ', isOccSkill(inp.dataset.custom));
          refreshBudget();
        };
      });

      // 点了「最接近的标准职业」就用它替换掉识别不了的职业名
      backdrop.querySelectorAll('[data-suggest]').forEach((btn) => {
        btn.onclick = () => {
          work.occupation = btn.dataset.suggest;
          const occInput = backdrop.querySelector('#fOcc');
          if (occInput) occInput.value = work.occupation;
          renderTab();
        };
      });
    }

    if (activeTab === 'gear') {
      backdrop.querySelector('#btnAddWeapon').onclick = () => {
        collect();
        work.weapons.push({ name: '', skill: '', damage: '', range: '' });
        renderTab();
      };
      backdrop.querySelector('#btnAddExp').onclick = () => {
        collect();
        work.experiences.push({ module: '', change: '' });
        renderTab();
      };
      backdrop.querySelector('#btnAddSpell').onclick = () => {
        collect();
        work.spells.push({ name: '', cost: '', effect: '' });
        renderTab();
      };
      backdrop.querySelectorAll('[data-delweapon]').forEach((b) => {
        b.onclick = () => { collect(); work.weapons.splice(Number(b.dataset.delweapon), 1); renderTab(); };
      });
      backdrop.querySelectorAll('[data-delexp]').forEach((b) => {
        b.onclick = () => { collect(); work.experiences.splice(Number(b.dataset.delexp), 1); renderTab(); };
      });
      backdrop.querySelectorAll('[data-delspell]').forEach((b) => {
        b.onclick = () => { collect(); work.spells.splice(Number(b.dataset.delspell), 1); renderTab(); };
      });
    }
  };

  // 标签页切换
  backdrop.querySelectorAll('.ce-tab').forEach((t) => {
    t.onclick = () => {
      collect();
      activeTab = t.dataset.tab;
      renderTab();
    };
  });

  // -------------------------------------------------------------------------
  // 顶部快捷操作
  // -------------------------------------------------------------------------
  backdrop.querySelector('#btnRollAttrs').onclick = () => {
    collect();
    work.attrs = rollAttributes();
    refreshDerived(work);
    work.hp.current = work.hp.max;
    work.mp.current = work.mp.max;
    work.san.current = work.san.temp;
    work.luck.current = work.attrs.LUCK;
    // 骰完属性跳到属性页，让用户马上看到
    activeTab = 'attrs';
    renderTab();
  };

  backdrop.querySelector('#btnRandomAll').onclick = () => {
    const fresh = randomCharacter({
      name: work.name || '调查员',
      isPlayer: work.isPlayer,
      occupation: work.occupation
    });
    Object.assign(work, fresh);
    activeTab = 'basic';
    renderTab();
  };

  if (allowAIGen) {
    const aiBtn = backdrop.querySelector('#btnAIGen');
    if (aiBtn) {
      aiBtn.onclick = async () => {
        if (!state?.apiConfig || !api?.chat) {
          alert('AI 未配置，请先到「设置」里填好 API。');
          return;
        }
        collect();

        // 弹个小表单收集创作方向
        const brief = prompt(
          '想让 AI 生成什么样的调查员？\n（可以直接回车留空，让 AI 自由发挥）\n\n例如：1920s 的华裔记者，胆小但执着',
          ''
        );
        if (brief === null) return; // 取消

        aiBtn.disabled = true;
        aiBtn.textContent = '生成中…';
        try {
          const { generateCharacter } = await import('../services/charGen.js');
          const res = await generateCharacter(state.apiConfig, {
            brief: brief.trim(),
            occupation: work.occupation || '',
            era: work.era || '1920s',
            tone: state.tone || '经典恐怖',
            role: work.isPlayer ? 'player' : 'teammate',
            existingNames: (state.teammates || []).map((t) => t.name).filter(Boolean)
          }, api);

          if (!res.ok) {
            alert(`生成失败：${res.error}`);
            return;
          }
          Object.assign(work, res.char);
          activeTab = 'basic';
          renderTab();
        } catch (e) {
          alert(`生成失败：${e?.message || e}`);
        } finally {
          aiBtn.disabled = false;
          aiBtn.textContent = 'AI 生成';
        }
      };
    }
  }

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------
  backdrop.querySelector('#btnSaveChar').onclick = () => {
    collect();
    const final = normalizeCharacter(work);
    // 克苏鲁神话在车卡阶段恒为 0（原版规则不给加点）。
    //
    // 但游戏进行中也能从这个编辑器改卡（旧签名带 state 的入口），
    // 那时神话值是玩家靠遭遇一点点攒下来的，绝不能清掉。
    // 所以只在「车卡阶段」（没有 state）才归零。
    if (!state) {
      final.skills['克苏鲁神话'] = 0;
    }
    // 原地写回，保持外部引用
    for (const k of Object.keys(final)) ch[k] = final[k];
    onSaved?.(ch);
    close();
  };

  // 初始渲染
  renderTab();
}
