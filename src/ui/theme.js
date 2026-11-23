/* 主题定义。保存的是稳定的主题 id，旧 id 回落到当前默认主题。 */
export const THEMES = [
  {
    id: 'tentacle',
    name: '触手 · 深海遗迹',
    motif: '旧金与暗潮',
    desc: '像素海底插画、旧金操作件与深色调查卷宗。',
    swatch: ['#f1c47e', '#100c16', '#1c1624']
  },
  {
    id: 'ritual',
    name: '仪式 · 烛火祭坛',
    motif: '黄铜与铜绿',
    desc: '烛光祭坛、手刻符阵与铜绿描边。',
    swatch: ['#efc37a', '#110e0b', '#251e15']
  },
  {
    id: 'pixel',
    name: '像素写实',
    motif: '经典备份',
    desc: '原默认主题。琥珀金、像素石纹与硬边描框。',
    swatch: ['#e8b04a', '#0a0812', '#13101d'],
    preview: {
      mask: 'var(--art-stone)',
      size: '64px 64px',
      bg: '#0a0812',
      accent: '#e8b04a'
    }
  }
];

export const DEFAULT_THEME = 'tentacle';

/** 可选阅读宽度。数值在 themes.css 里定义（--read-width） */
export const READ_WIDTHS = [
  { id: 'narrow', name: '窄', desc: '720px · 长文最省眼' },
  { id: 'normal', name: '中', desc: '880px · 默认' },
  { id: 'wide', name: '宽', desc: '1080px · 宽屏少留白' }
];

export const DEFAULT_READ_WIDTH = 'normal';

/** 全部合法主题 id，供校验与测试使用 */
export const THEME_IDS = THEMES.map((t) => t.id);

/** 全部合法阅读宽度 id */
export const READ_WIDTH_IDS = READ_WIDTHS.map((w) => w.id);

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 归一化主题 id。
 * 任何不认识的值（null / undefined / 空串 / 手改配置写错）都回落到默认主题，
 * 而不是抛错——配置文件是用户可以手改的，界面不能因为一个字段写错就白屏。
 * @param {unknown} id
 * @returns {string} 合法的主题 id
 */
export function normalizeTheme(id) {
  if (typeof id === 'string' && THEME_IDS.includes(id)) return id;
  return DEFAULT_THEME;
}

/**
 * 归一化阅读宽度 id。规则同上。
 * @param {unknown} id
 * @returns {string}
 */
export function normalizeReadWidth(id) {
  if (typeof id === 'string' && READ_WIDTH_IDS.includes(id)) return id;
  return DEFAULT_READ_WIDTH;
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

/** 取 <html>；没有 document（纯 node 测试环境）时返回 null */
function root() {
  return typeof document !== 'undefined' && document.documentElement
    ? document.documentElement
    : null;
}

/**
 * 把主题写到 <html data-theme>。
 * 幂等：重复调用同一主题不产生任何副作用，也不会触发额外的样式重算
 * （值没变就不写，省掉一次无谓的样式失效）。
 * @param {unknown} id
 * @returns {string} 实际生效的主题 id
 */
export function applyTheme(id) {
  const theme = normalizeTheme(id);
  const el = root();
  if (el && el.dataset.theme !== theme) {
    el.dataset.theme = theme;
  }
  return theme;
}

/**
 * 把阅读宽度写到 <html data-read-width>。幂等，规则同 applyTheme。
 * @param {unknown} id
 * @returns {string} 实际生效的档位 id
 */
export function applyReadWidth(id) {
  const width = normalizeReadWidth(id);
  const el = root();
  if (el && el.dataset.readWidth !== width) {
    el.dataset.readWidth = width;
  }
  return width;
}

/**
 * 一次性应用主题与阅读宽度。
 * 启动时用：配置可能只改了其中一项，分开调用容易漏。
 * @param {{ uiTheme?: unknown, readWidth?: unknown }} cfg
 * @returns {{ theme: string, readWidth: string }}
 */
export function applyAppearance(cfg) {
  const c = cfg || {};
  return {
    theme: applyTheme(c.uiTheme),
    readWidth: applyReadWidth(c.readWidth)
  };
}

/** 按 id 取主题定义，取不到返回默认主题的定义 */
export function themeById(id) {
  const key = normalizeTheme(id);
  return THEMES.find((t) => t.id === key) || THEMES[0];
}

/** 按 id 取阅读宽度定义，取不到返回默认档 */
export function readWidthById(id) {
  const key = normalizeReadWidth(id);
  return READ_WIDTHS.find((w) => w.id === key) || READ_WIDTHS[1];
}
