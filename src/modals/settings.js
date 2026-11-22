// ---------------------------------------------------------------------------
// 设置弹窗：KP 模型 / 队友模型 / 叙事基调 / 外观
//
// 结构说明：
//   原来是一个长滚动列表，加了「外观」之后要滚三屏才找得到，所以改成 tab。
//   tab 只切 hidden 属性，**所有面板始终留在 DOM 里**——
//   这样 collect() 里 querySelector('#cfgBaseUrl') 之类的取值逻辑完全不用改
//   （hidden 不影响 input.value），也避免了「切走再切回来输入丢失」。
//
// 外观的即时预览与回滚：
//   点主题卡片立刻 applyTheme，不写盘——用户要能看到效果才决定。
//   点「取消 / × / 遮罩」时回滚到打开面板时的值；
//   只有点「保存」才写进 config.json。
//   弹窗的 onClose 回调负责统一回滚。
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';
import { modelsHintText, modelsErrorText, filterModels } from './modelPicker.js';
import {
  THEMES,
  READ_WIDTHS,
  applyTheme,
  applyReadWidth,
  normalizeTheme,
  normalizeReadWidth
} from '../ui/theme.js';

const TONES = ['经典恐怖', '调查悬疑', '硬核生存', '黑色幽默'];

/** tab 定义：id 与 data-pane 对应 */
const TABS = [
  { id: 'model', name: '模型' },
  { id: 'story', name: '叙事' },
  { id: 'theme', name: '外观' }
];

export async function openSettings(state, onChanged) {
  const trigger = document.activeElement;
  const cfg = await window.api.getConfig();

  // 打开面板时的外观值，用于「未保存就关闭」时回滚
  const originTheme = normalizeTheme(cfg.uiTheme ?? state.uiTheme);
  const originWidth = normalizeReadWidth(cfg.readWidth ?? state.readWidth);

  // 面板内当前选中的外观值（点卡片改这个，保存时写它）
  let pickedTheme = originTheme;
  let pickedWidth = originWidth;

  // 主题卡片：左边是该主题的母题缩略图（形状 + 强调色），
  // 右边是名称、母题名、描述。三色块换成了图案预览，
  // 因为「换风格」的差异主要在图案和形态语言，纯色块看不出区别。
  //
  // ⚠ 图案的 data URI 里带单引号（SVG 属性用单引号避免和 HTML 双引号打架），
  //   所以不能塞进 style="..." 属性——单双引号会互相截断，
  //   浏览器把剩下的 `motif-...` 当成属性名，卡片上直接显示成文字（踩过）。
  //   这里只写 data-theme-id，使用像素纹理的卡片通过 element.style 设置变量。
  const themeCards = THEMES.map((t) => `
    <button class="theme-opt ${t.id === pickedTheme ? 'on' : ''}" data-theme-id="${t.id}" type="button" aria-pressed="${t.id === pickedTheme}">
      <span class="theme-swatch" data-swatch-for="${t.id}" aria-hidden="true"></span>
      <span class="theme-body">
        <span class="theme-name">${escapeHtml(t.name)}</span>
        <span class="theme-motif">${escapeHtml(t.motif || '')}</span>
        <span class="theme-desc">${escapeHtml(t.desc)}</span>
      </span>
    </button>
  `).join('');

  const widthCards = READ_WIDTHS.map((w) => `
    <button class="rw-opt ${w.id === pickedWidth ? 'on' : ''}" data-rw-id="${w.id}" type="button" aria-pressed="${w.id === pickedWidth}">
      <span class="rw-name">${escapeHtml(w.name)}</span>
      <span class="rw-desc">${escapeHtml(w.desc)}</span>
    </button>
  `).join('');

  const tabsHtml = TABS.map((t, i) => `
    <button class="st-tab ${i === 0 ? 'on' : ''}" data-tab="${t.id}" id="settings-tab-${t.id}" type="button" role="tab" aria-controls="settings-pane-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${t.name}</button>
  `).join('');

  let saved = false;
  const { backdrop, close: closeModal } = openModal(`
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="modal-head">
        <h2 id="settings-title">设置</h2>
        <button class="icon-btn" data-close aria-label="关闭设置">×</button>
      </div>
      <div class="st-tabs" role="tablist" aria-label="设置分类">${tabsHtml}</div>
      <div class="modal-body">
        <!-- ================= 模型 ================= -->
        <div class="st-pane" data-pane="model" id="settings-pane-model" role="tabpanel" aria-labelledby="settings-tab-model">
          <section class="field-group">
            <h3>KP（守密人）模型</h3>
            <label class="field">
              <span>API 地址</span>
              <input id="cfgBaseUrl" type="text" value="${escapeHtml(cfg.baseUrl)}" placeholder="https://api.deepseek.com/v1">
              <em>OpenAI 兼容接口 · DeepSeek: https://api.deepseek.com/v1 · Ollama: http://localhost:11434/v1</em>
            </label>
            <label class="field">
              <span>API Key</span>
              <input id="cfgApiKey" type="password" value="${escapeHtml(cfg.apiKey)}" placeholder="sk-...">
              <em>本地模型（Ollama / LM Studio）可留空</em>
            </label>
            <label class="field">
              <span>模型名</span>
              <div class="model-row">
                <input id="cfgModel" type="text" value="${escapeHtml(cfg.model)}" placeholder="deepseek-chat">
                <button class="btn ghost model-fetch" id="btnFetchModels" type="button">获取模型</button>
              </div>
              <em id="modelHint">DeepSeek: deepseek-chat · Ollama: qwen2.5:14b</em>
              <div class="model-panel" id="modelPanel" hidden>
                <input class="model-search" id="modelSearch" type="text" placeholder="搜索模型名…">
                <div class="model-list" id="modelList"></div>
              </div>
            </label>
            <div class="field-row">
              <label class="field">
                <span>温度</span>
                <input id="cfgTemp" type="number" step="0.1" min="0" max="2" value="${cfg.temperature}">
              </label>
              <label class="field">
                <span>最大 Token</span>
                <input id="cfgMaxTokens" type="number" step="128" min="256" value="${cfg.maxTokens}">
              </label>
            </div>
          </section>

          <section class="field-group">
            <h3>队友模型（可选 · 留空则用上面同一套）</h3>
            <label class="field">
              <span>API 地址</span>
              <input id="cfgTeamBaseUrl" type="text" value="${escapeHtml(cfg.teammateBaseUrl || '')}" placeholder="留空 = 同上">
            </label>
            <label class="field">
              <span>API Key</span>
              <input id="cfgTeamApiKey" type="password" value="${escapeHtml(cfg.teammateApiKey || '')}" placeholder="留空 = 同上">
            </label>
            <label class="field">
              <span>模型名</span>
              <div class="model-row">
                <input id="cfgTeamModel" type="text" value="${escapeHtml(cfg.teammateModel || '')}" placeholder="留空 = 同上">
                <button class="btn ghost model-fetch" id="btnFetchTeamModels" type="button">获取模型</button>
              </div>
              <em id="teamModelHint">留空则用上面同一套</em>
              <div class="model-panel" id="teamModelPanel" hidden>
                <input class="model-search" id="teamModelSearch" type="text" placeholder="搜索模型名…">
                <div class="model-list" id="teamModelList"></div>
              </div>
            </label>
            <em class="hint">可以把队友交给本地小模型，省 API 费用</em>
          </section>
        </div>

        <!-- ================= 叙事 ================= -->
        <div class="st-pane" data-pane="story" id="settings-pane-story" role="tabpanel" aria-labelledby="settings-tab-story" hidden>
          <section class="field-group">
            <h3>叙事基调</h3>
            <div class="tone-picker" id="tonePicker">
              ${TONES.map((t) => `<button class="tone-opt ${state.tone === t ? 'on' : ''}" data-tone="${t}" type="button">${t}</button>`).join('')}
            </div>
          </section>

          <section class="field-group">
            <h3>队友行动方式</h3>
            <label class="field-check">
              <input id="cfgTeammateAutonomous" type="checkbox" ${state.teammateAutonomous === false ? '' : 'checked'}>
              <span>队友由自己的 AI 决定行动（推荐）</span>
            </label>
            <em class="hint">
              开启后，每位队友各自独立思考这一轮要做什么，彼此会有真正的分歧；<br>
              代价是每位队友每轮多一次 API 调用。关掉则退回旧行为：队友的行动和台词全由 KP 一人代演。
            </em>
          </section>

          <section class="field-group">
            <h3>队友自动发言</h3>
            <label class="field-check">
              <input id="cfgAutoTeammate" type="checkbox" ${state.autoTeammate === false ? '' : 'checked'}>
              <span>KP 说完后，让队友自己接话</span>
            </label>
            <label class="field">
              <span>接话概率</span>
              <div class="range-row">
                <input id="cfgTeammateChance" type="range" min="0" max="100" step="10" value="${Math.round((state.teammateChance ?? 0.7) * 100)}">
                <em id="chanceHint">${Math.round((state.teammateChance ?? 0.7) * 100)}%</em>
              </div>
              <em class="hint">越高队友越活跃；100% 则每轮都有人接话</em>
            </label>
          </section>
        </div>

        <!-- ================= 外观 ================= -->
        <div class="st-pane" data-pane="theme" id="settings-pane-theme" role="tabpanel" aria-labelledby="settings-tab-theme" hidden>
          <section class="field-group">
            <h3>美术风格</h3>
            <div class="theme-picker">${themeCards}</div>
            <em class="hint">选择即可预览，保存后应用。</em>
          </section>

          <section class="field-group">
            <h3>阅读宽度</h3>
            <div class="rw-picker">${widthCards}</div>
            <em class="hint">叙事区的最大行宽。宽屏下拉得太长会让眼睛回行时串行，窄一点更好读。</em>
          </section>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="btnTest">测试连接</button>
        <span class="test-result" id="testRes" role="status"></span>
        <button class="btn" id="btnSaveCfg">保存</button>
      </div>
    </div>
  `, { onClose: () => {
    if (!saved) {
      applyTheme(originTheme);
      applyReadWidth(originWidth);
      state.uiTheme = originTheme;
      state.readWidth = originWidth;
    }
    if (trigger?.isConnected) trigger.focus();
  } });

  // -------------------------------------------------------------------------
  // tab 切换
  // -------------------------------------------------------------------------
  const panes = backdrop.querySelectorAll('.st-pane');
  const tabs = [...backdrop.querySelectorAll('.st-tab')];
  const testButton = backdrop.querySelector('#btnTest');
  const testStatus = backdrop.querySelector('#testRes');
  function selectTab(tab) {
    tabs.forEach((item) => {
      item.classList.toggle('on', item === tab);
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== tab.dataset.tab; });
    testButton.hidden = testStatus.hidden = tab.dataset.tab !== 'model';
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab);
    tab.onkeydown = (event) => {
      const last = tabs.length - 1;
      const next = { ArrowLeft: (index + last) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    };
  });
  tabs[0].focus();
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...backdrop.querySelectorAll('button, input, select, textarea, a[href]')]
      .filter((item) => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length);
    const edge = event.shiftKey ? focusable[0] : focusable.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
    }
  });

  // -------------------------------------------------------------------------
  // 外观：即时预览
  // -------------------------------------------------------------------------

  // 母题缩略图：把每个主题的图案变量设到对应的 .theme-swatch 上。
  //
  // 为什么不用内联 style 属性写：图案的 SVG data URI 里是单引号，
  // 塞进 style="..." 会截断属性（截图里直接显示出 `motif-` 文字）。
  // 用 element.style.setProperty 走 CSSOM，完全不经过 HTML 解析，引号无所谓。
  backdrop.querySelectorAll('.theme-swatch[data-swatch-for]').forEach((el) => {
    const t = THEMES.find((x) => x.id === el.dataset.swatchFor);
    const p = t && t.preview;
    if (!p) return;
    if (p.mask) el.style.setProperty('--motif-swatch-mask', p.mask);
    if (p.size) el.style.setProperty('--motif-swatch-size', p.size);
    if (p.bg) el.style.setProperty('--motif-swatch-bg', p.bg);
    if (p.accent) el.style.setProperty('--motif-swatch-accent', p.accent);
  });

  backdrop.querySelectorAll('.theme-opt').forEach((card) => {
    card.onclick = () => {
      pickedTheme = normalizeTheme(card.dataset.themeId);
      backdrop.querySelectorAll('.theme-opt').forEach((option) => {
        option.classList.toggle('on', option === card);
        option.setAttribute('aria-pressed', String(option === card));
      });
      applyTheme(pickedTheme);
    };
  });

  backdrop.querySelectorAll('.rw-opt').forEach((card) => {
    card.onclick = () => {
      pickedWidth = normalizeReadWidth(card.dataset.rwId);
      backdrop.querySelectorAll('.rw-opt').forEach((option) => {
        option.classList.toggle('on', option === card);
        option.setAttribute('aria-pressed', String(option === card));
      });
      applyReadWidth(pickedWidth);
    };
  });

  // -------------------------------------------------------------------------
  // 叙事基调
  // -------------------------------------------------------------------------
  let tone = state.tone;
  backdrop.querySelectorAll('.tone-opt').forEach((b) => {
    b.onclick = () => {
      tone = b.dataset.tone;
      backdrop.querySelectorAll('.tone-opt').forEach((x) => x.classList.toggle('on', x === b));
    };
  });

  /**
   * 绑定一个「获取模型」按钮 + 搜索面板。
   * 用可搜索面板而不是原生 datalist：有的服务商一次返回几十个模型，
   * datalist 只能靠输入框前缀匹配，翻起来很痛苦。
   */
  const bindFetchModels = (btnSel, panelSel, searchSel, listSel, hintSel, modelSel, getCreds) => {
    const btn = backdrop.querySelector(btnSel);
    const panel = backdrop.querySelector(panelSel);
    const search = backdrop.querySelector(searchSel);
    const list = backdrop.querySelector(listSel);
    const hint = backdrop.querySelector(hintSel);
    const input = backdrop.querySelector(modelSel);
    if (!btn || !panel || !list || !hint) return;

    /** 当前拿到的全部模型（过滤前） */
    let all = [];

    /** 按搜索词重绘列表 */
    const renderList = () => {
      const shown = filterModels(all, search?.value || '');
      list.innerHTML = '';

      if (!shown.length) {
        list.innerHTML = '<div class="model-empty">没有匹配的模型</div>';
        return;
      }

      for (const m of shown) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'model-item' + (input?.value.trim() === m.id ? ' on' : '');
        row.textContent = m.id;
        if (m.ownedBy) row.title = m.ownedBy;
        row.onclick = () => {
          if (input) input.value = m.id;
          panel.hidden = true;
          hint.className = 'model-hint ok';
          hint.textContent = `已选择 ${m.id}`;
        };
        list.appendChild(row);
      }
    };

    if (search) {
      search.oninput = renderList;
      search.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); renderList(); }
      };
    }

    btn.onclick = async () => {
      const { url, key } = getCreds();

      if (!url) {
        hint.className = 'model-hint bad';
        hint.textContent = '请先填写 API 地址';
        return;
      }

      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '获取中…';
      hint.className = 'model-hint';
      hint.textContent = '正在请求模型列表…';
      panel.hidden = true;

      let r;
      try {
        r = await window.api.listModels({ baseUrl: url, apiKey: key });
      } catch (e) {
        r = { ok: false, error: e?.message || String(e) };
      }

      btn.disabled = false;
      btn.textContent = oldText;

      if (!r || !r.ok) {
        hint.className = 'model-hint bad';
        hint.textContent = modelsErrorText(r?.error);
        return;
      }

      all = r.models || [];
      if (search) search.value = '';
      renderList();

      panel.hidden = false;
      hint.className = 'model-hint ok';
      hint.textContent = modelsHintText(all, input?.value?.trim() || '');

      if (input && !input.value.trim() && all.length) {
        input.value = all[0].id;
        renderList();
        hint.textContent = `已获取 ${all.length} 个模型，已自动填入 ${all[0].id}`;
      }
      search?.focus();
    };
  };

  bindFetchModels(
    '#btnFetchModels', '#modelPanel', '#modelSearch', '#modelList', '#modelHint', '#cfgModel',
    () => ({
      url: backdrop.querySelector('#cfgBaseUrl').value.trim(),
      key: backdrop.querySelector('#cfgApiKey').value.trim()
    })
  );

  bindFetchModels(
    '#btnFetchTeamModels', '#teamModelPanel', '#teamModelSearch', '#teamModelList', '#teamModelHint', '#cfgTeamModel',
    () => ({
      url: backdrop.querySelector('#cfgTeamBaseUrl').value.trim() ||
           backdrop.querySelector('#cfgBaseUrl').value.trim(),
      key: backdrop.querySelector('#cfgTeamApiKey').value.trim() ||
           backdrop.querySelector('#cfgApiKey').value.trim()
    })
  );

  // 接话概率滑块：实时更新百分比，并跟随复选框启停
  const chanceInput = backdrop.querySelector('#cfgTeammateChance');
  const chanceHint = backdrop.querySelector('#chanceHint');
  const autoBox = backdrop.querySelector('#cfgAutoTeammate');
  const syncChance = () => {
    chanceHint.textContent = `${chanceInput.value}%`;
    chanceInput.disabled = !autoBox.checked;
    chanceHint.style.opacity = autoBox.checked ? '' : '0.45';
  };
  chanceInput.oninput = syncChance;
  autoBox.onchange = syncChance;
  syncChance();

  /**
   * 收集面板上的全部设置。
   *
   * 注意 config:set 是**整体覆盖**而不是 patch 合并（见 electron/config.js），
   * 所以这里必须把 uiTheme / readWidth 也带上。
   * 漏掉的话保存模型配置时会把主题一起重置回默认值——
   * 表现就是「改完 API 地址，配色也变回黄铜了」。
   */
  const collect = () => ({
    baseUrl: backdrop.querySelector('#cfgBaseUrl').value.trim(),
    apiKey: backdrop.querySelector('#cfgApiKey').value.trim(),
    model: backdrop.querySelector('#cfgModel').value.trim(),
    temperature: parseFloat(backdrop.querySelector('#cfgTemp').value) || 0.8,
    maxTokens: parseInt(backdrop.querySelector('#cfgMaxTokens').value, 10) || 2048,
    teammateBaseUrl: backdrop.querySelector('#cfgTeamBaseUrl').value.trim(),
    teammateApiKey: backdrop.querySelector('#cfgTeamApiKey').value.trim(),
    teammateModel: backdrop.querySelector('#cfgTeamModel').value.trim(),
    tone,
    uiTheme: pickedTheme,
    readWidth: pickedWidth
  });

  backdrop.querySelector('#btnTest').onclick = async () => {
    const res = backdrop.querySelector('#testRes');
    const c = collect();
    res.className = 'test-result';
    res.textContent = '测试中…';

    const r = await window.api.chat({
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      temperature: 0.5,
      maxTokens: 60,
      stream: false,
      messages: [{ role: 'user', content: '用一句话回应：连接成功。' }]
    });

    if (r.ok) {
      res.className = 'test-result ok';
      res.textContent = `✓ 连接成功：${(r.text || '').slice(0, 40)}`;
    } else {
      res.className = 'test-result bad';
      res.textContent = `✗ ${String(r.error).slice(0, 120)}`;
    }
  };

  backdrop.querySelector('#btnSaveCfg').onclick = async () => {
    const c = collect();
    await window.api.setConfig(c);

    Object.assign(state.apiConfig, {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      temperature: c.temperature,
      maxTokens: c.maxTokens
    });
    state.tone = c.tone;
    state.autoTeammate = backdrop.querySelector('#cfgAutoTeammate').checked;
    state.teammateChance =
      (parseInt(backdrop.querySelector('#cfgTeammateChance').value, 10) || 0) / 100;
    state.teammateAutonomous = backdrop.querySelector('#cfgTeammateAutonomous').checked;

    state.uiTheme = c.uiTheme;
    state.readWidth = c.readWidth;
    applyTheme(c.uiTheme);
    applyReadWidth(c.readWidth);
    saved = true;

    onChanged?.();
    closeModal();
  };
}
