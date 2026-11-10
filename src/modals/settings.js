// ---------------------------------------------------------------------------
// 设置弹窗：KP 模型 / 队友模型 / 叙事基调 / 连接测试
// ---------------------------------------------------------------------------
import { openModal } from './shell.js';
import { escapeHtml } from '../shared/text.js';
import { modelsHintText, modelsErrorText, filterModels } from './modelPicker.js';

const TONES = ['经典恐怖', '调查悬疑', '硬核生存', '黑色幽默'];

export async function openSettings(state, onChanged) {
  const cfg = await window.api.getConfig();

  const { backdrop, close } = openModal(`
    <div class="modal">
      <div class="modal-head">
        <h2>设置</h2>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body">
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

        <section class="field-group">
          <h3>叙事基调</h3>
          <div class="tone-picker" id="tonePicker">
            ${TONES.map((t) => `<button class="tone-opt ${state.tone === t ? 'on' : ''}" data-tone="${t}">${t}</button>`).join('')}
          </div>
        </section>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="btnTest">测试连接</button>
        <span class="test-result" id="testRes"></span>
        <button class="btn" id="btnSaveCfg">保存</button>
      </div>
    </div>
  `);

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
   *
   * @param {string} btnSel     按钮选择器
   * @param {string} panelSel   面板选择器
   * @param {string} searchSel  搜索框选择器
   * @param {string} listSel    列表容器选择器
   * @param {string} hintSel    提示文案选择器
   * @param {string} modelSel   模型输入框选择器
   * @param {() => {url,key}} 取当前要用的地址与密钥
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

    // 搜索框实时过滤
    if (search) {
      search.oninput = renderList;
      // 防止在搜索框里按 Enter 触发外层表单行为
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

      // 当前没填模型时，自动填第一个，省得再点一次
      if (input && !input.value.trim() && all.length) {
        input.value = all[0].id;
        renderList();
        hint.textContent = `已获取 ${all.length} 个模型，已自动填入 ${all[0].id}`;
      }
      search?.focus();
    };
  };

  // KP 模型：用主地址 + 主密钥
  bindFetchModels(
    '#btnFetchModels', '#modelPanel', '#modelSearch', '#modelList', '#modelHint', '#cfgModel',
    () => ({
      url: backdrop.querySelector('#cfgBaseUrl').value.trim(),
      key: backdrop.querySelector('#cfgApiKey').value.trim()
    })
  );

  // 队友模型：优先用队友自己的地址/密钥，留空则回落到主配置
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

  const collect = () => ({    baseUrl: backdrop.querySelector('#cfgBaseUrl').value.trim(),
    apiKey: backdrop.querySelector('#cfgApiKey').value.trim(),
    model: backdrop.querySelector('#cfgModel').value.trim(),
    temperature: parseFloat(backdrop.querySelector('#cfgTemp').value) || 0.8,
    maxTokens: parseInt(backdrop.querySelector('#cfgMaxTokens').value, 10) || 2048,
    teammateBaseUrl: backdrop.querySelector('#cfgTeamBaseUrl').value.trim(),
    teammateApiKey: backdrop.querySelector('#cfgTeamApiKey').value.trim(),
    teammateModel: backdrop.querySelector('#cfgTeamModel').value.trim(),
    tone
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

    onChanged?.();
    close();
  };
}
