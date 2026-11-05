'use strict';

// ---------------------------------------------------------------------------
// 纯逻辑部分：默认配置与请求目标解析
// 不依赖 electron，可被单元测试直接加载
// ---------------------------------------------------------------------------

/** 配置默认值唯一来源：渲染层不再自己维护一份 */
const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxTokens: 2048,
  stream: true,
  tone: '经典恐怖',
  // 队友 AI 可用不同模型（例如本地小模型跑队友，省 token）
  teammateBaseUrl: '',
  teammateApiKey: '',
  teammateModel: '',
  teammateTemperature: 0.9
};

/**
 * 按用途（keeper / teammate）决定走哪套端点、密钥、模型。
 * 优先级：payload 显式值 > 对应用途的配置 > 主配置默认值
 */
function resolveTarget(cfg, payload = {}) {
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';

  if (payload.purpose === 'teammate') {
    return {
      url: pick(cfg.teammateBaseUrl, payload.baseUrl, cfg.baseUrl, DEFAULT_CONFIG.baseUrl),
      key: pick(cfg.teammateApiKey, payload.apiKey, cfg.apiKey),
      model: pick(cfg.teammateModel, payload.model, cfg.model),
      temperature: cfg.teammateTemperature ?? payload.temperature
    };
  }

  return {
    url: pick(payload.baseUrl, cfg.baseUrl, DEFAULT_CONFIG.baseUrl),
    key: pick(payload.apiKey, cfg.apiKey),
    model: pick(payload.model, cfg.model),
    temperature: payload.temperature
  };
}

/** 补全 OpenAI 兼容接口路径 */
function buildEndpoint(url) {
  const base = String(url || '').replace(/\/+$/, '');
  return base.includes('/chat/completions') ? base : base + '/chat/completions';
}

/**
 * 补全 /models 端点。
 * 用户可能填 https://api.x.com/v1 、https://api.x.com/v1/ ，
 * 甚至直接粘贴了完整的 /chat/completions，都要能落到 /models。
 */
function buildModelsEndpoint(url) {
  let base = String(url || '').replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/, '');
  return base.includes('/models') ? base : base + '/models';
}

/**
 * 把各家的 /models 返回统一成 [{ id, ownedBy }]。
 * 兼容：OpenAI 的 data[]、Ollama 的 models[]、以及纯字符串数组。
 */
function normalizeModels(json) {
  const arr = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : Array.isArray(json)
        ? json
        : [];

  const seen = new Set();
  const out = [];

  for (const m of arr) {
    const id =
      typeof m === 'string' ? m : m?.id ?? m?.name ?? m?.model;
    if (!id) continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    out.push({
      id: sid,
      ownedBy: typeof m === 'string' ? '' : String(m?.owned_by ?? m?.ownedBy ?? '')
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** 本地模型（Ollama / LM Studio）不校验 key，地址里带本机名即视为本地 */
function isLocalEndpoint(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ''));
}

module.exports = {
  DEFAULT_CONFIG,
  resolveTarget,
  buildEndpoint,
  buildModelsEndpoint,
  normalizeModels,
  isLocalEndpoint
};
