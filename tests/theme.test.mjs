// ---------------------------------------------------------------------------
// 美术风格主题 · 纯逻辑与 CSS 契约测试
//
// 这一层要守住的是「换主题不会让界面花掉」：
//   1) 归一化必须能吃掉任何脏值（配置是用户可手改的）
//   2) 每套主题必须把全部变量定义齐——漏一个，那个元素就会变成
//      浏览器默认色（通常是黑色或白色），在暗色主题里格外刺眼
//   3) styles.css 里不能再有硬编码色值，否则那处颜色不跟主题走
//
// 第 2 条是最容易踩的坑：新增一套主题时复制粘贴前一套，改了几个主色
// 就以为完事，漏掉的变量在浅色元素上才看得出来。所以这里逐个断言。
//
// 直接 node tests/theme.test.mjs
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import {
  THEMES,
  READ_WIDTHS,
  DEFAULT_THEME,
  DEFAULT_READ_WIDTH,
  THEME_IDS,
  READ_WIDTH_IDS,
  normalizeTheme,
  normalizeReadWidth,
  applyTheme,
  applyReadWidth,
  applyAppearance,
  themeById,
  readWidthById
} from '../src/ui/theme.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
console.log('\n== 主题清单 ==');

eq(THEMES.length, 4, '共 4 套主题');
eq(new Set(THEME_IDS).size, THEMES.length, '主题 id 不重复');
ok(THEME_IDS.includes(DEFAULT_THEME), '默认主题在清单里');

for (const t of THEMES) {
  ok(typeof t.id === 'string' && t.id.length > 0, `${t.id}: id 非空`);
  ok(typeof t.name === 'string' && t.name.length > 0, `${t.id}: 有名称`);
  ok(typeof t.desc === 'string' && t.desc.length > 0, `${t.id}: 有描述`);
  ok(Array.isArray(t.swatch) && t.swatch.length === 3, `${t.id}: 有 3 个色块`);
  for (const c of t.swatch) {
    ok(/^#[0-9a-fA-F]{6}$/.test(c), `${t.id}: 色块 ${c} 是合法 hex`);
  }
}

eq(READ_WIDTHS.length, 3, '共 3 档阅读宽度');
eq(new Set(READ_WIDTH_IDS).size, READ_WIDTHS.length, '宽度 id 不重复');
ok(READ_WIDTH_IDS.includes(DEFAULT_READ_WIDTH), '默认宽度在清单里');

// ---------------------------------------------------------------------------
console.log('\n== 归一化：脏值一律回落，不抛错 ==');

eq(normalizeTheme('abyss'), 'abyss', '合法主题原样返回');
eq(normalizeTheme('phosphor'), 'phosphor', '合法主题原样返回 2');
for (const bad of [null, undefined, '', 'nope', 0, 1, false, {}, [], 'ABYSS', ' abyss ']) {
  eq(normalizeTheme(bad), DEFAULT_THEME, `非法主题 ${JSON.stringify(bad)} 回落默认`);
}
// 大小写与空格不做宽容处理：配置里只该存我们自己写进去的值，
// 出现了说明被人手改过，此时回落比「猜他想选哪个」更安全。
ok(normalizeTheme('ABYSS') !== 'abyss', '大写不自动纠正（避免误判手改配置）');

eq(normalizeReadWidth('wide'), 'wide', '合法宽度原样返回');
for (const bad of [null, undefined, '', 'huge', 0, {}, 'WIDE']) {
  eq(normalizeReadWidth(bad), DEFAULT_READ_WIDTH, `非法宽度 ${JSON.stringify(bad)} 回落默认`);
}

// ---------------------------------------------------------------------------
console.log('\n== applyTheme / applyReadWidth：无 document 时不崩 ==');

// node 环境没有 document，这两个函数必须安静地返回归一化结果，
// 而不是抛 ReferenceError——否则纯逻辑测试根本没法跑。
eq(applyTheme('blood'), 'blood', '无 DOM 时返回归一化主题');
eq(applyReadWidth('narrow'), 'narrow', '无 DOM 时返回归一化宽度');
eq(applyTheme('bogus'), DEFAULT_THEME, '无 DOM 时脏值也回落');

// ---------------------------------------------------------------------------
console.log('\n== applyAppearance：一次应用两项 ==');

{
  const r = applyAppearance({ uiTheme: 'abyss', readWidth: 'wide' });
  eq(r.theme, 'abyss', 'theme 生效');
  eq(r.readWidth, 'wide', 'readWidth 生效');
}
{
  const r = applyAppearance({});
  eq(r.theme, DEFAULT_THEME, '空配置回落默认主题');
  eq(r.readWidth, DEFAULT_READ_WIDTH, '空配置回落默认宽度');
}
{
  const r = applyAppearance(null);
  eq(r.theme, DEFAULT_THEME, 'null 配置不崩');
}
{
  // 只改一项：另一项应保持默认，而不是变成 undefined
  const r = applyAppearance({ uiTheme: 'phosphor' });
  eq(r.theme, 'phosphor', '只给主题时主题生效');
  eq(r.readWidth, DEFAULT_READ_WIDTH, '没给的宽度回落默认');
}

// ---------------------------------------------------------------------------
console.log('\n== themeById / readWidthById ==');

eq(themeById('abyss').name, '深海幽蓝', '按 id 取到正确主题');
eq(themeById('bogus').id, DEFAULT_THEME, '脏 id 取到默认主题');
eq(readWidthById('wide').name, '宽', '按 id 取到正确宽度');
eq(readWidthById('bogus').id, DEFAULT_READ_WIDTH, '脏 id 取到默认宽度');

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：themes.css 是否定义齐全部变量 ==');

const themesCss = await readFile(new URL('../src/themes.css', import.meta.url), 'utf8');

// 必需变量清单。新增主题时必须全部定义，否则界面对应元素会失色。
// 这份清单与 themes.css 顶部注释里的列表必须保持一致。
const REQUIRED_VARS = [
  // 底色
  '--bg-deep', '--bg', '--bg-panel', '--bg-raised', '--bg-hover',
  '--bg-bar', '--bg-input', '--bg-selected', '--bg-keeper',
  // 边框
  '--border', '--border-soft', '--border-strong',
  // 文字
  '--ink', '--ink-dim', '--ink-faint', '--ink-strong', '--ink-num',
  // 强调
  '--accent', '--accent-soft', '--accent-rgb', '--edge-rgb',
  // 语义
  '--danger', '--danger-ink', '--ok-ink', '--san', '--hp', '--clue',
  '--clue-bg', '--clue-ink', '--clue-accent',
  '--danger-bg', '--accent-bg', '--edge-solid',
  '--ok-rgb', '--danger-rgb', '--clue-rgb', '--san-rgb', '--hp-rgb',
  // 质感
  '--radius-sm', '--radius-md', '--radius-lg',
  '--shadow-modal', '--shadow-pop', '--scan-opacity',
  // 字体
  '--font-serif', '--font-sans', '--font-mono', '--reading-size'
];

/**
 * 取出某个主题块内的全部自定义属性名。
 * 块的范围：从 [data-theme="x"] 或 :root 到下一个顶层 } 结束。
 */
function varsInThemeBlock(css, themeId) {
  // :root 与 [data-theme="brass"] 写在同一个选择器组里（用逗号分隔），
  // 所以 brass 的变量要从「:root,」那个块里取。
  let start = -1;
  if (themeId === 'brass') {
    start = css.indexOf(':root,');
    if (start === -1) start = css.indexOf(':root {');
  } else {
    start = css.indexOf(`[data-theme="${themeId}"]`);
  }
  if (start === -1) return null;

  const open = css.indexOf('{', start);
  if (open === -1) return null;
  const close = css.indexOf('}', open);
  if (close === -1) return null;

  const body = css.slice(open + 1, close);
  const names = new Set();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]);
  return names;
}

for (const t of THEMES) {
  const vars = varsInThemeBlock(themesCss, t.id);
  ok(vars !== null, `${t.id}: 在 themes.css 里找到主题块`);
  if (!vars) continue;

  const missing = REQUIRED_VARS.filter((v) => !vars.has(v));
  ok(
    missing.length === 0,
    `${t.id}: 变量定义齐全${missing.length ? `（缺 ${missing.join(', ')}）` : ''}`
  );
}

// 阅读宽度三档都必须定义 --read-width
for (const w of READ_WIDTHS) {
  const has =
    themesCss.includes(`[data-read-width="${w.id}"]`) ||
    (w.id === 'normal' && themesCss.includes(':root,'));
  ok(has, `阅读宽度 ${w.id}: 在 themes.css 里有对应块`);
}
ok(themesCss.includes('--read-width'), 'themes.css 定义了 --read-width');

// 只有 phosphor 开扫描线，其余必须为 0（否则每套主题都带条纹）
{
  const phosphorVars = varsInThemeBlock(themesCss, 'phosphor');
  ok(phosphorVars?.has('--scan-opacity'), 'phosphor 定义了扫描线强度');
  const m = themesCss.match(/\[data-theme="phosphor"\][\s\S]*?--scan-opacity:\s*([\d.]+)/);
  ok(m && parseFloat(m[1]) > 0, 'phosphor 的扫描线强度大于 0');
}
{
  for (const id of ['brass', 'abyss', 'blood']) {
    const start = id === 'brass' ? themesCss.indexOf(':root,') : themesCss.indexOf(`[data-theme="${id}"]`);
    const open = themesCss.indexOf('{', start);
    const close = themesCss.indexOf('}', open);
    const body = themesCss.slice(open + 1, close);
    const m = body.match(/--scan-opacity:\s*([\d.]+)/);
    ok(m && parseFloat(m[1]) === 0, `${id}: 扫描线关闭（0）`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：styles.css 不能再有硬编码色值 ==');

const stylesCss = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

// 残留的 #rrggbb / #rgb 会让那处颜色不跟主题走。
// 唯一允许的是注释里的说明文字，所以先剥掉注释再检查。
const stripped = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
const hexLeft = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok(
  hexLeft.length === 0,
  `styles.css 无残留硬编码色值${hexLeft.length ? `（剩 ${[...new Set(hexLeft)].join(', ')}）` : ''}`
);

// 黄铜色的 rgba 三元组也必须改成变量，否则换主题后半透明强调色还是黄铜
const brassRgba = stripped.match(/rgba\(\s*184\s*,\s*137\s*,\s*74/g) || [];
ok(brassRgba.length === 0, `styles.css 无残留黄铜 rgba${brassRgba.length ? `（${brassRgba.length} 处）` : ''}`);

// 反向验证：确实用了变量（否则上面两条「没残留」可能只是因为文件是空的）
ok(/var\(--accent-rgb\)/.test(stripped), 'styles.css 使用了 var(--accent-rgb)');
ok(/var\(--read-width/.test(stripped), 'styles.css 使用了 var(--read-width)');
ok(/var\(--bg-input\)/.test(stripped), 'styles.css 使用了 var(--bg-input)');

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：styles.css 用到的每个变量，四套主题都得有 ==');

// 这一条是真正能抓到「换主题后某处失色」的检查。
//
// REQUIRED_VARS 是手工列的清单，漏项属于我自己的疏忽；
// 而这里反过来做：把 styles.css 里**实际引用**的变量全抓出来，
// 逐个回四套主题里查。只要有人给某个元素写了个新变量、
// 又只在 brass 里定义了它，另外三套主题下那处就会掉回浏览器默认色
// （通常是黑色或白色），在暗色界面里一眼就能看出毛病。
const referenced = new Set();
for (const m of stripped.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) referenced.add(m[1]);
console.log(`     styles.css 引用了 ${referenced.size} 个变量`);

// 带兜底值的引用（var(--x, fallback)）缺定义也能工作，不算缺失
const withFallback = new Set();
for (const m of stripped.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,[^)]+\)/gi)) withFallback.add(m[1]);

for (const t of THEMES) {
  const vars = varsInThemeBlock(themesCss, t.id);
  if (!vars) continue;
  const missing = [...referenced].filter((v) => !vars.has(v) && !withFallback.has(v));
  ok(
    missing.length === 0,
    `${t.id}: styles.css 引用的变量全部有定义${missing.length ? `（缺 ${missing.join(', ')}）` : ''}`
  );
}

// 反向：themes.css 里定义但没人用的变量，只打印提示不判失败
{
  const allDefined = new Set();
  for (const t of THEMES) {
    const v = varsInThemeBlock(themesCss, t.id);
    if (v) for (const x of v) allDefined.add(x);
  }
  const unused = [...allDefined].filter((v) => !referenced.has(v));
  if (unused.length) {
    console.log(`     （themes.css 中未被子样式引用的变量：${unused.join(', ')}）`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：布局改造是否到位 ==');

// 折叠态必须真的能隐藏侧栏
ok(/\.layout\.hide-left\s+\.left-panel\s*\{\s*display:\s*none/.test(stripped),
  '折叠左侧栏用 display:none');
ok(/\.layout\.hide-right\s+\.right-panel\s*\{\s*display:\s*none/.test(stripped),
  '折叠右侧栏用 display:none');

// 三个面板必须显式指定列号。
// 这是实测踩到的 bug：grid 自动放置按文档顺序填未被占用的列，
// 某一栏 display:none 后不再参与放置，后面的面板整体前移一格，
// 折叠左栏时 center-panel 落到宽度为 0 的第 1 列，中间叙事区直接消失
// （实测 center 宽 0px）。显式列号后各归其位。
for (const [cls, col] of [['left-panel', 1], ['center-panel', 2], ['right-panel', 3]]) {
  const re = new RegExp(`\\.layout\\s*>\\s*\\.${cls}\\s*\\{\\s*grid-column:\\s*${col}\\s*;`);
  ok(re.test(stripped), `.${cls} 显式指定 grid-column: ${col}（否则折叠后列错位）`);
}

// 折叠开关图标必须用 CSS 画，不能依赖 ◧ ◨ 这类字符。
// 它们在 Windows 常见字体里没有字形，实测渲染成豆腐块。
{
  const htmlRaw = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  ok(!/◧|◨/.test(htmlRaw), 'HTML 里不再用 ◧ ◨ 字符做图标');
}
ok(/\.top-toggle::before/.test(stripped), '.top-toggle 用伪元素画图标');

// 折叠态的高亮必须写成 .btn.top-toggle，
// 否则同特异性下会被后定义的 .btn.ghost 覆盖，鼠标悬停看不出强调色。
ok(/\.btn\.top-toggle\.off\s*\{/.test(stripped), '折叠态高亮用 .btn.top-toggle.off（压得住 .btn.ghost）');
ok(/\.btn\.top-toggle:hover/.test(stripped), '悬停色用 .btn.top-toggle:hover');
ok(/\.layout\.hide-left\.hide-right/.test(stripped), '两栏同时折叠有独立规则');
// 分隔线交给 border，不能再用 gap:1px 画
ok(!/\.layout\s*\{[^}]*gap:\s*1px/.test(stripped), '三栏不再用 gap:1px 画分隔线');
ok(/\.left-panel\s*\{\s*border-right/.test(stripped), '左栏用 border-right 做分隔线');

// 阅读列限宽加在 .msg 上
ok(/\.msg\s*\{[^}]*max-width:\s*var\(--read-width/.test(stripped), '.msg 使用 --read-width 限宽');

// 设置面板的新样式
ok(/\.st-tabs/.test(stripped), '定义了 .st-tabs');
ok(/\.theme-opt/.test(stripped), '定义了 .theme-opt');
ok(/\.theme-swatch/.test(stripped), '定义了 .theme-swatch');
ok(/\.rw-opt/.test(stripped), '定义了 .rw-opt');

// ---------------------------------------------------------------------------
console.log('\n== HTML 接入 ==');

const indexHtml = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
ok(indexHtml.includes('themes.css'), 'index.html 引入了 themes.css');
ok(/<html[^>]*data-theme=/.test(indexHtml), 'index.html 的 <html> 有 data-theme 兜底');
ok(/<html[^>]*data-read-width=/.test(indexHtml), 'index.html 的 <html> 有 data-read-width 兜底');
// 顺序：themes.css 必须在 styles.css 之前
{
  const iThemes = indexHtml.indexOf('themes.css');
  const iStyles = indexHtml.indexOf('styles.css');
  ok(iThemes !== -1 && iStyles !== -1 && iThemes < iStyles,
    'themes.css 在 styles.css 之前加载（否则变量取不到值）');
}

const rbHtml = await readFile(new URL('../src/rulebook.html', import.meta.url), 'utf8');
ok(rbHtml.includes('themes.css'), 'rulebook.html 引入了 themes.css');
ok(/<html[^>]*data-theme=/.test(rbHtml), 'rulebook.html 的 <html> 有 data-theme 兜底');

// ---------------------------------------------------------------------------
console.log('\n== 配置默认值 ==');

const defaultsJs = await readFile(new URL('../electron/defaults.js', import.meta.url), 'utf8');
ok(/uiTheme:\s*'brass'/.test(defaultsJs), 'defaults.js 有 uiTheme 默认值');
ok(/readWidth:\s*'normal'/.test(defaultsJs), 'defaults.js 有 readWidth 默认值');

const stateJs = await readFile(new URL('../src/state.js', import.meta.url), 'utf8');
ok(/uiTheme:\s*'brass'/.test(stateJs), 'state.js 有 uiTheme 初始值');
ok(/readWidth:\s*'normal'/.test(stateJs), 'state.js 有 readWidth 初始值');
ok(/hideLeftPanel:\s*false/.test(stateJs), 'state.js 有折叠状态（默认展开）');

// 设置面板必须把外观字段一起提交：
// config:set 是整体覆盖，漏了就会把主题重置回默认
const settingsJs = await readFile(new URL('../src/modals/settings.js', import.meta.url), 'utf8');
ok(/uiTheme:\s*pickedTheme/.test(settingsJs), '设置面板保存时带上 uiTheme');
ok(/readWidth:\s*pickedWidth/.test(settingsJs), '设置面板保存时带上 readWidth');
ok(/applyTheme\(originTheme\)/.test(settingsJs), '设置面板未保存时回滚主题');

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
