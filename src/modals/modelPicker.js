// ---------------------------------------------------------------------------
// 模型下拉的纯逻辑：填充 datalist、生成提示文案
// 不碰网络也不碰 IPC，方便单测
// ---------------------------------------------------------------------------

/**
 * 把模型列表填进 <datalist>。
 * 保留给需要原生下拉的场合；设置界面用的是可搜索面板。
 * @param {HTMLDataListElement} datalist
 * @param {Array<{id:string}>} models
 */
export function fillModelDatalist(datalist, models) {
  if (!datalist) return;
  datalist.innerHTML = '';
  for (const m of models || []) {
    const opt = document.createElement('option');
    opt.value = m.id;
    if (m.ownedBy) opt.label = m.ownedBy;
    datalist.appendChild(opt);
  }
}

/**
 * 获取成功后的提示文案。
 * @param {Array} models
 * @param {string} current 当前填在输入框里的模型名
 */
export function modelsHintText(models, current = '') {
  const n = (models || []).length;
  if (!n) return '';
  const inList = (models || []).some((m) => m.id === current);
  const tail = current && !inList ? ' · 当前填写的模型不在列表中' : '';
  return `已获取 ${n} 个模型，可在下方列表搜索选择${tail}`;
}

/** 获取失败时的提示文案，尽量把常见错误说得像人话 */
export function modelsErrorText(error) {
  const raw = String(error || '').trim();
  if (!raw) return '获取失败';

  if (/HTTP 401|HTTP 403/.test(raw)) {
    return 'API Key 无效或没有权限（401/403）';
  }
  if (/HTTP 404/.test(raw)) {
    return '该地址没有 /models 接口（404）。有些服务商不提供模型列表，直接手填模型名即可。';
  }
  if (/HTTP 429/.test(raw)) {
    return '请求太频繁，被服务商限流了（429）';
  }
  if (/超时|timeout|aborted|AbortError/i.test(raw)) {
    return '请求超时，检查网络或 API 地址是否正确';
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|Failed to fetch/i.test(raw)) {
    return '连不上这个地址，检查 API 地址是否拼错、网络是否可达';
  }
  if (/空的模型列表/.test(raw)) {
    return '接口返回了空的模型列表';
  }
  return raw.slice(0, 160);
}

/**
 * 按关键词过滤模型。
 * 模型多的时候（有的服务商一次返回几十个），用户靠打字缩小范围比翻列表快。
 * @param {Array<{id:string}>} models
 * @param {string} query
 */
export function filterModels(models, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return models || [];
  return (models || []).filter((m) => m.id.toLowerCase().includes(q));
}

/**
 * 把模型列表按前缀分组，方便分块浏览。
 * 例如 trae/deepseek-V3、qoder_cn/auto → { trae: [...], qoder_cn: [...] }
 * 没有前缀的归到 '' 组。
 */
export function groupModelsByPrefix(models) {
  const groups = new Map();
  for (const m of models || []) {
    const slash = m.id.indexOf('/');
    const prefix = slash >= 0 ? m.id.slice(0, slash) : '';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(m);
  }
  return groups;
}
