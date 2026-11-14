// ---------------------------------------------------------------------------
// 美术风格：主题与阅读宽度
//
// 这一层只做三件事：
//   1) 列出可选档位（供设置面板渲染）
//   2) 校验并归一化用户传入的值（脏配置不能把界面搞花）
//   3) 把结果写到 <html> 的 data 属性上
//
// 为什么用 data 属性而不是直接改 CSS 变量：
// 变量散在 600 多处，逐个 setProperty 既慢又容易漏；
// 一个 data-theme 让浏览器自己重算层叠，切换是原子性的，
// 不会出现「换到一半颜色混合」的中间态。
//
// 为什么不在这里 import 任何 DOM 之外的东西：
// 这个模块要能在测试里直接跑（node 环境没有 document），
// 所以所有 DOM 访问都做了存在性判断。
// ---------------------------------------------------------------------------

/** 可选主题。顺序即设置面板里的显示顺序 */
export const THEMES = [
  {
    id: 'brass',
    name: '黄铜档案',
    desc: '陈旧黄铜与深墨底，衬线标题。档案柜里压着的一张禁忌拓片。',
    // 母题名称：设置面板里显示，让玩家知道「这套风格长什么样」
    motif: '缠绕触手',
    // 三个色块：强调色 / 深底 / 面板底（供需要纯色块的场合使用）
    swatch: ['#b8894a', '#0a0b0f', '#171b24'],
    // 缩略预览：图案形状（SVG data URI）、平铺尺寸、底色、强调色
    preview: {
      mask: "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><g fill='none' stroke='black' stroke-width='7' stroke-linecap='round'><path d='M-6 14 C16 16 30 26 32 46 C34 62 22 72 24 88 C25 100 36 108 50 110'/><path d='M126 26 C104 28 92 40 90 58 C88 74 98 84 96 98'/></g><g fill='black'><circle cx='20' cy='22' r='2.6'/><circle cx='31' cy='40' r='3'/><circle cx='26' cy='66' r='2.4'/><circle cx='102' cy='36' r='3'/><circle cx='92' cy='58' r='2.6'/></g></svg>\")",
      size: '60px 60px',
      bg: '#0a0b0f',
      accent: '#b8894a'
    }
  },
  {
    id: 'abyss',
    name: '深海幽蓝',
    desc: '冷青蓝底与青绿强调，圆角放大，像潜水器的操作界面。',
    motif: '水波气泡',
    swatch: ['#3fa8b8', '#06090f', '#131b26'],
    preview: {
      mask: "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><g fill='none' stroke='black' stroke-width='1.6'><circle cx='60' cy='60' r='14'/><circle cx='60' cy='60' r='28'/><circle cx='60' cy='60' r='42'/><circle cx='60' cy='60' r='55'/></g><g fill='black'><circle cx='18' cy='22' r='3'/><circle cx='100' cy='16' r='2.2'/><circle cx='34' cy='98' r='2.6'/></g></svg>\")",
      size: '60px 60px',
      bg: '#06090f',
      accent: '#3fa8b8'
    }
  },
  {
    id: 'phosphor',
    name: '磷光终端',
    desc: '单色磷光绿、全等宽字体、零圆角，叠一层 CRT 扫描线。',
    motif: '点阵字符',
    swatch: ['#4fd47f', '#040604', '#0d130d'],
    preview: {
      mask: "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><g fill='black'><circle cx='2' cy='2' r='.9'/><circle cx='8' cy='2' r='.9'/><circle cx='5' cy='6' r='.9'/><circle cx='11' cy='6' r='.9'/><circle cx='2' cy='10' r='.9'/><circle cx='8' cy='10' r='.9'/></g></svg>\")",
      size: '12px 12px',
      bg: '#040604',
      accent: '#4fd47f'
    }
  },
  {
    id: 'blood',
    name: '血月绯红',
    desc: '暗红紫底与陶土金强调，圆角最大。被什么东西从内部撑裂的岩壁。',
    motif: '蛛网裂纹',
    swatch: ['#c47a5a', '#0c0708', '#1b1216'],
    preview: {
      mask: "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'><g fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M60 60 L48 32 L52 8'/><path d='M60 60 L88 48 L106 52'/><path d='M60 60 L82 84 L86 106'/><path d='M60 60 L32 74 L12 70'/><path d='M48 32 L34 26 M88 48 L96 32 M82 84 L64 96'/></g></svg>\")",
      size: '60px 60px',
      bg: '#0c0708',
      accent: '#c47a5a'
    }
  }
];

export const DEFAULT_THEME = 'brass';

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
