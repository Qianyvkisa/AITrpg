// ---------------------------------------------------------------------------
// 美术风格主题 · 纯逻辑与 CSS 契约测试
//
// 这一层要守住的是「换主题不会让界面花掉」：
//   1) 归一化必须能吃掉任何脏值（配置是用户可手改的）
//   2) 每套主题必须把全部变量定义齐——漏一个，那个元素就会变成
//      浏览器默认色（通常是黑色或白色），在暗色主题里格外刺眼
//   3) styles.css 里不能再有硬编码色值，否则那处颜色不跟主题走
//   4) theme.js 里的主题 id 必须和 themes.css 里的选择器逐字一致
//      拼错不会报错，只会静默回落——表现是「点了没反应」，最难查
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

eq(THEME_IDS.join(','), 'tentacle,pixel', '设置只提供触手和像素写实备份');
eq(DEFAULT_THEME, 'tentacle', '新配置默认启用触手主题');
eq(new Set(THEME_IDS).size, THEMES.length, '主题 id 不重复');
ok(THEME_IDS.includes(DEFAULT_THEME), '默认主题在清单里');

for (const t of THEMES) {
  ok(typeof t.id === 'string' && t.id.length > 0, `${t.id}: id 非空`);
  ok(typeof t.name === 'string' && t.name.length > 0, `${t.id}: 有名称`);
  ok(typeof t.desc === 'string' && t.desc.length > 0, `${t.id}: 有描述`);
  ok(typeof t.motif === 'string' && t.motif.length > 0, `${t.id}: 有母题名称`);
  ok(Array.isArray(t.swatch) && t.swatch.length === 3, `${t.id}: 有 3 个色块`);
  for (const c of t.swatch) {
    ok(/^#[0-9a-fA-F]{6}$/.test(c), `${t.id}: 色块 ${c} 是合法 hex`);
  }
  if (t.id === 'pixel') {
    ok(typeof t.preview?.mask === 'string', '像素写实保留母题缩略图');
  }
}

eq(READ_WIDTHS.length, 3, '共 3 档阅读宽度');
eq(new Set(READ_WIDTH_IDS).size, READ_WIDTHS.length, '宽度 id 不重复');
ok(READ_WIDTH_IDS.includes(DEFAULT_READ_WIDTH), '默认宽度在清单里');

// 主题 id 只允许小写字母：写 CSS 选择器时要拼进去，
// 大小写混用会让选择器匹配不上而没有任何提示。
for (const id of THEME_IDS) {
  ok(/^[a-z][a-z0-9-]*$/.test(id), `${id}: id 只含小写字母数字连字符`);
}

// ---------------------------------------------------------------------------
console.log('\n== 归一化：脏值一律回落，不抛错 ==');

for (const id of THEME_IDS) {
  eq(normalizeTheme(id), id, `合法主题 ${id} 原样返回`);
}
for (const bad of [null, undefined, '', 'nope', 0, 1, false, {}, [], 'PIXEL', ' pixel ', 'brass']) {
  eq(normalizeTheme(bad), DEFAULT_THEME, `非法主题 ${JSON.stringify(bad)} 回落默认`);
}
// 大小写与空格不做宽容处理：配置里只该存我们自己写进去的值，
// 出现了说明被人手改过，此时回落比「猜他想选哪个」更安全。
//
// 这里要用**非默认**主题的大写形式来验：默认主题的大写（'PIXEL'）
// 回落之后正好等于 'pixel'，看起来像「纠正成功」，
// 实际是回落到了默认值，什么也证明不了。
{
  const nonDefault = THEME_IDS.find((x) => x !== DEFAULT_THEME);
  if (nonDefault) {
    eq(normalizeTheme(nonDefault.toUpperCase()), DEFAULT_THEME,
      '大写不自动纠正（回落到默认，而不是猜成对应主题）');
  }
}
// 旧主题名必须被当成非法值：老配置里存着 brass/abyss 这些，
// 升级后要静默回落到新默认主题，而不是让界面停留在不存在的主题上。
for (const legacy of ['engraving', 'acrylic', 'vhs', 'brass', 'abyss', 'phosphor', 'blood']) {
  eq(normalizeTheme(legacy), DEFAULT_THEME, `旧主题名 ${legacy} 回落新默认`);
}

eq(normalizeReadWidth('wide'), 'wide', '合法宽度原样返回');
for (const bad of [null, undefined, '', 'huge', 0, {}, 'WIDE']) {
  eq(normalizeReadWidth(bad), DEFAULT_READ_WIDTH, `非法宽度 ${JSON.stringify(bad)} 回落默认`);
}

// ---------------------------------------------------------------------------
console.log('\n== applyTheme / applyReadWidth：无 document 时不崩 ==');

// node 环境没有 document，这两个函数必须安静地返回归一化结果，
// 而不是抛 ReferenceError——否则纯逻辑测试根本没法跑。
eq(applyTheme('pixel'), 'pixel', '无 DOM 时返回归一化主题');
eq(applyReadWidth('narrow'), 'narrow', '无 DOM 时返回归一化宽度');
eq(applyTheme('bogus'), DEFAULT_THEME, '无 DOM 时脏值也回落');

// ---------------------------------------------------------------------------
console.log('\n== applyAppearance：一次应用两项 ==');

{
  const r = applyAppearance({ uiTheme: 'pixel', readWidth: 'wide' });
  eq(r.theme, 'pixel', 'theme 生效');
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
  const r = applyAppearance({ uiTheme: 'pixel' });
  eq(r.theme, 'pixel', '只给主题时主题生效');
  eq(r.readWidth, DEFAULT_READ_WIDTH, '没给的宽度回落默认');
}

// ---------------------------------------------------------------------------
console.log('\n== themeById / readWidthById ==');

eq(themeById('pixel').name, '像素写实', '按 id 取到正确主题');
eq(themeById('bogus').id, DEFAULT_THEME, '脏 id 取到默认主题');
eq(readWidthById('wide').name, '宽', '按 id 取到正确宽度');
eq(readWidthById('bogus').id, DEFAULT_READ_WIDTH, '脏 id 取到默认宽度');

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：theme.js 的 id 与 themes.css 的选择器一致 ==');

const themesCss = await readFile(new URL('../src/themes.css', import.meta.url), 'utf8');
const stylesCss = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const tentacleCss = await readFile(new URL('../src/tentacle.css', import.meta.url), 'utf8');
const motifCss = await readFile(new URL('../src/motif-art.css', import.meta.url), 'utf8');

// 这条是防「拼错一个字母」的：id 写错了不会报错，
// 浏览器找不到匹配的选择器，就静默用 :root 的值，
// 表现出来只是「点了那个主题没反应」。
for (const id of THEME_IDS) {
  ok(
    themesCss.includes(`[data-theme="${id}"]`),
    `themes.css 里有 [data-theme="${id}"] 选择器（theme.js 的 id 必须逐字一致）`
  );
}
// 反向：themes.css 里不该有 theme.js 不知道的主题
{
  const declared = new Set();
  for (const m of themesCss.matchAll(/\[data-theme="([a-z0-9-]+)"\]/g)) declared.add(m[1]);
  const unknown = [...declared].filter((x) => !THEME_IDS.includes(x));
  ok(
    unknown.length === 0,
    `themes.css 没有 theme.js 不认识的主题${unknown.length ? `（多出 ${unknown.join(', ')}）` : ''}`
  );
}

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：themes.css 是否定义齐全部变量 ==');

// 必需变量清单。新增主题时必须全部定义，否则界面对应元素会失色。
// 这份清单与 themes.css 顶部注释里的列表必须保持一致。
const REQUIRED_VARS = [
  // 底色
  '--bg-deep', '--bg', '--bg-panel', '--bg-raised', '--bg-hover',
  '--bg-bar', '--bg-input', '--bg-selected', '--bg-keeper',
  // 带 alpha 的底色（半透明面板用）
  '--bg-rgb', '--bg-panel-rgb',
  // 边框
  '--border', '--border-soft', '--border-strong',
  // 文字
  '--ink', '--ink-dim', '--ink-faint', '--ink-strong', '--ink-num',
  // 强调
  '--accent', '--accent-soft', '--accent-rgb', '--accent2', '--accent2-rgb',
  '--edge-rgb',
  // 语义
  '--danger', '--danger-ink', '--ok-ink', '--san', '--hp', '--clue',
  '--clue-bg', '--clue-ink', '--clue-accent',
  '--danger-bg', '--accent-bg', '--edge-solid',
  '--ok-rgb', '--danger-rgb', '--clue-rgb', '--san-rgb', '--hp-rgb',
  // 圆角（四档：像素主题全是 0，亚克力是 4/8/12/16）
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg',
  // 材质
  '--shadow-rgb', '--shadow-modal', '--shadow-pop',
  '--panel-alpha', '--panel-blur', '--border-w', '--hard-edge',
  '--sheen-rgb', '--sheen-opacity',
  // 质感层强度
  '--scan-opacity', '--noise-opacity',
  // 母题
  '--motif-mask', '--motif-size',
  // 字体
  '--font-serif', '--font-sans', '--font-mono', '--reading-size'
];

/**
 * 取出某个主题块内的全部自定义属性名。
 *
 * 注意块的范围要用「大括号配平」来算，不能用 indexOf('}')：
 * 主题块里可能有嵌套（比如 @media 或注释里的花括号），
 * 简单找第一个 } 会截断，导致后面的变量全部漏检。
 */
function varsInThemeBlock(css, themeId) {
  const start = css.indexOf(`[data-theme="${themeId}"] {`);
  if (start === -1) return null;

  const open = css.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  let close = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;

  const body = css.slice(open + 1, close);
  const names = new Set();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]);
  return names;
}

// 取某主题块里某个变量的数值（用于检查强度类变量）
function varValueIn(css, themeId, varName) {
  const start = css.indexOf(`[data-theme="${themeId}"] {`);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) return null;
  const body = css.slice(open + 1, close);
  const m = body.match(new RegExp(varName.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+);'));
  return m ? m[1].trim() : null;
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

// 各主题的变量集合必须完全一致。
// 只查「必需变量有没有」是不够的：A 主题多定义一个、B 主题少定义一个，
// 两边都不在必需清单里时就查不出来，但换主题时那处会静默失效。
{
  const sets = THEMES.map((t) => ({ id: t.id, set: varsInThemeBlock(themesCss, t.id) }));
  const base = sets[0];
  for (const s of sets.slice(1)) {
    if (!base.set || !s.set) continue;
    const onlyBase = [...base.set].filter((v) => !s.set.has(v));
    const onlyThis = [...s.set].filter((v) => !base.set.has(v));
    ok(
      onlyBase.length === 0 && onlyThis.length === 0,
      `${s.id} 与 ${base.id} 的变量集合完全一致` +
        (onlyBase.length ? `（${base.id} 独有 ${onlyBase.join(', ')}）` : '') +
        (onlyThis.length ? `（${s.id} 独有 ${onlyThis.join(', ')}）` : '')
    );
  }
}

// 阅读宽度三档都必须定义 --read-width
for (const w of READ_WIDTHS) {
  const has =
    themesCss.includes(`[data-read-width="${w.id}"]`) ||
    (w.id === DEFAULT_READ_WIDTH && themesCss.includes(':root,'));
  ok(has, `阅读宽度 ${w.id}: 在 themes.css 里有对应块`);
}
ok(themesCss.includes('--read-width'), 'themes.css 定义了 --read-width');

// 三档宽度必须是递增的（窄 < 中 < 宽），否则「宽」比「中」还窄就没意义
{
  const px = {};
  for (const w of READ_WIDTHS) {
    const m = themesCss.match(
      new RegExp(`\\[data-read-width="${w.id}"\\][^{]*\\{[^}]*--read-width:\\s*(\\d+)px`)
    );
    if (m) px[w.id] = parseInt(m[1], 10);
  }
  // normal 在 :root 块里，单独抓
  if (!px.normal) {
    const m = themesCss.match(/:root,[^{]*\{[^}]*--read-width:\s*(\d+)px/);
    if (m) px.normal = parseInt(m[1], 10);
  }
  ok(px.narrow && px.normal && px.wide, '三档阅读宽度都有 px 数值');
  if (px.narrow && px.normal && px.wide) {
    ok(px.narrow < px.normal && px.normal < px.wide,
      `阅读宽度递增（${px.narrow} < ${px.normal} < ${px.wide}）`);
  }
}

// 像素主题必须是零圆角 + 2px 硬边，这是它成立的前提。
// 值写成 0px 还是 0 都算零圆角，所以按数值比较而不是字符串比较。
{
  for (const rv of ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg']) {
    const v = varValueIn(themesCss, 'pixel', rv);
    ok(v !== null && parseFloat(v) === 0, `pixel: ${rv} 为 0（像素风不能有圆角）`);
  }
  eq(varValueIn(themesCss, 'pixel', '--border-w'), '2px', 'pixel: 边框 2px（1px 会灰掉）');
  ok(
    (varValueIn(themesCss, 'pixel', '--hard-edge') || '').includes('var(--border)'),
    'pixel: 有硬边阴影 --hard-edge'
  );
}

for (const id of THEME_IDS) {
  eq(varValueIn(themesCss, id, '--panel-alpha'), '1', `${id}: 阅读面板为实色`);
  eq(parseFloat(varValueIn(themesCss, id, '--panel-blur')), 0, `${id}: 面板关闭背景模糊`);
}

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：styles.css 不能再有硬编码色值 ==');

// 残留的 #rrggbb / #rgb 会让那处颜色不跟主题走。
// 唯一允许的是注释里的说明文字，所以先剥掉注释再检查。
const stripped = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
const hexLeft = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok(
  hexLeft.length === 0,
  `styles.css 无残留硬编码色值${hexLeft.length ? `（剩 ${[...new Set(hexLeft)].join(', ')}）` : ''}`
);

// 旧默认主题的黄铜 rgba 三元组也必须全部改成变量
const brassRgba = stripped.match(/rgba\(\s*184\s*,\s*137\s*,\s*74/g) || [];
ok(brassRgba.length === 0, `styles.css 无残留黄铜 rgba${brassRgba.length ? `（${brassRgba.length} 处）` : ''}`);

// 纯黑阴影也必须改成 --shadow-rgb：
// 亚克力的阴影偏冷（2,6,16），纯黑会让玻璃质感消失。
const blackShadow = stripped.match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/g) || [];
ok(blackShadow.length === 0, `styles.css 无残留纯黑阴影${blackShadow.length ? `（${blackShadow.length} 处）` : ''}`);

// 硬编码圆角 px 会让像素主题出现圆角（它的四档全是 0）
const radiusPx = stripped.match(/border-radius:\s*[^;]*\d+px/g) || [];
ok(radiusPx.length === 0, `styles.css 无残留硬编码圆角${radiusPx.length ? `（${radiusPx.join(' | ')}）` : ''}`);

// 反向验证：确实用了变量（否则上面几条「没残留」可能只是因为文件是空的）
ok(/var\(--accent-rgb\)/.test(stripped), 'styles.css 使用了 var(--accent-rgb)');
ok(/var\(--read-width/.test(stripped), 'styles.css 使用了 var(--read-width)');
ok(/var\(--bg-input\)/.test(stripped), 'styles.css 使用了 var(--bg-input)');
ok(/var\(--radius-xs\)/.test(stripped), 'styles.css 使用了 var(--radius-xs)');
ok(/var\(--shadow-rgb\)/.test(stripped), 'styles.css 使用了 var(--shadow-rgb)');

// ---------------------------------------------------------------------------
console.log('\n== CSS 契约：styles.css 用到的每个变量，各主题都得有 ==');

// 这一条是真正能抓到「换主题后某处失色」的检查。
//
// REQUIRED_VARS 是手工列的清单，漏项属于我自己的疏忽；
// 而这里反过来做：把 styles.css 里**实际引用**的变量全抓出来，
// 逐个回各主题里查。只要有人给某个元素写了个新变量、
// 又只在 pixel 里定义了它，其他主题下那处就会掉回浏览器默认色
// （通常是黑色或白色），在暗色界面里一眼就能看出毛病。
const referenced = new Set();
for (const m of stripped.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) referenced.add(m[1]);
console.log(`     styles.css 引用了 ${referenced.size} 个变量`);

// 带兜底值的引用（var(--x, fallback)）缺定义也能工作，不算缺失
const withFallback = new Set();
for (const m of stripped.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,[^)]+\)/gi)) withFallback.add(m[1]);

// 素材变量定义在 motif-art.css，由 themes.css 的 --motif-mask 等中转，
// styles.css 不直接引用它们。所以检查对象是 themes.css，不是 styles.css。
{
  const artRefs = new Set();
  for (const m of themesCss.matchAll(/var\(\s*(--art-[a-z0-9-]+)/gi)) artRefs.add(m[1]);
  ok(artRefs.size > 0, 'themes.css 引用了 motif-art.css 的素材变量');
  for (const v of artRefs) {
    ok(
      new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(motifCss),
      `${v} 在 motif-art.css 里有定义`
    );
  }
  const mask = varValueIn(themesCss, 'pixel', '--motif-mask');
  ok(mask?.includes('var(--art-'), '像素写实保留纹理母题');
}

for (const t of THEMES) {
  const vars = varsInThemeBlock(themesCss, t.id);
  if (!vars) continue;
  const missing = [...referenced].filter(
    (v) => !vars.has(v) && !withFallback.has(v)
  );
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

// 面板材质：半透明 + 模糊必须落在 .panel 和 .modal 上
ok(/\.panel\s*\{[^}]*var\(--bg-panel-rgb\)/.test(stripped), '.panel 用 --bg-panel-rgb 做半透明底');
ok(/\.panel\s*\{[^}]*backdrop-filter:\s*blur\(var\(--panel-blur/.test(stripped), '.panel 有背景模糊');
ok(/\.modal\s*\{[^}]*backdrop-filter:\s*blur\(var\(--panel-blur/.test(stripped), '.modal 有背景模糊');

// 主题专用补丁块必须存在：那些用变量表达不了的差异都在里面
for (const [id, css] of [['pixel', stripped], ['tentacle', tentacleCss]]) {
  ok(new RegExp(`\\[data-theme="${id}"\\][^{]*\\{`).test(css),
    `布局样式有 [data-theme="${id}"] 的专用补丁`);
}
ok(stripped.includes('image-rendering: pixelated'), '像素主题关掉了位图平滑插值');
ok(stripped.includes('repeating-linear-gradient'), '像素写实保留断续线细节');
ok(tentacleCss.includes('prefers-reduced-motion: reduce'), '触手主题遵循减少动态效果偏好');

// 高频出现的队友发言不能用语义绿底：
// 一局几十条绿块会把视线从 KP 叙述上抢走。
// 「队友自主行动」是低频事件，保留绿底做区分。
{
  const m = stripped.match(/\.msg\.teammate\s+\.bubble\s*\{[^}]*\}/);
  ok(m !== null, '定义了 .msg.teammate .bubble');
  ok(m && !m[0].includes('var(--clue-bg)'), '普通队友发言用中性底，不用语义绿底');
  ok(m && m[0].includes('border-left'), '普通队友发言靠左侧色条区分身份');
  const ma = stripped.match(/\.msg\.teammate-action\s+\.bubble\s*\{[^}]*\}/);
  ok(ma && ma[0].includes('var(--clue-bg)'), '队友自主行动保留绿底（低频、需要醒目）');
}

// ---------------------------------------------------------------------------
console.log('\n== 可读性：文字对比度必须够 ==');

// 这一条守住的是「主题好看但不能看不清」。
//
// 暗色界面上最容易出的事：主题做得越暗越有气氛，次要文字就越是
// 灰到读不出来。而截图看起来往往「还行」，因为显示器 gamma 各不相同，
// 眼睛也会自适应。所以这里按 WCAG 的相对亮度公式实算，
// 拿最不利的背景（--bg-raised，最亮的卡片层）做分母。
//
// 阈值：正文 7:1（AAA）、次要文字 4.5:1（AA）、极弱提示 3:1。
// 极弱提示（占位符、单位、时间戳）本来就该淡，按 AA 的正文标准要求它
// 会把界面搞得一片亮，3:1 是这类文字的通行下限。
function hexToRgb(hex) {
  const h = hex.trim().replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(f.slice(0, 2), 16),
    parseInt(f.slice(2, 4), 16),
    parseInt(f.slice(4, 6), 16)
  ];
}
function relLuminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(fg, bg) {
  const a = relLuminance(hexToRgb(fg));
  const b = relLuminance(hexToRgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const CONTRAST_RULES = [
  ['--ink', 7.0, '正文'],
  ['--ink-strong', 7.0, '强调正文'],
  ['--ink-dim', 4.5, '次要文字'],
  ['--ink-faint', 3.0, '极弱提示'],
  ['--accent', 4.5, '强调色当文字']
];

for (const t of THEMES) {
  const bgHex = varValueIn(themesCss, t.id, '--bg-raised');
  ok(bgHex !== null, `${t.id}: 有 --bg-raised（对比度计算的分母）`);
  if (!bgHex) continue;
  for (const [v, target, label] of CONTRAST_RULES) {
    const fg = varValueIn(themesCss, t.id, v);
    if (!fg || !/^#[0-9a-fA-F]{6}$/.test(fg)) {
      ok(false, `${t.id} ${v}: 必须是 6 位 hex（当前 ${fg}）`);
      continue;
    }
    const r = contrastRatio(fg, bgHex);
    ok(r >= target, `${t.id} ${label} ${v} 对比度 ${r.toFixed(2)}:1 ≥ ${target}:1`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== HTML 接入 ==');

const indexHtml = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
ok(indexHtml.includes('themes.css'), 'index.html 引入了 themes.css');
ok(indexHtml.indexOf('tentacle.css') > indexHtml.indexOf('styles.css'), '触手样式加载在共用样式之后');
ok(indexHtml.includes('motif-art.css'), 'index.html 引入了 motif-art.css（--art-* 素材的来源）');
ok(/<html[^>]*data-theme=/.test(indexHtml), 'index.html 的 <html> 有 data-theme 兜底');
ok(/<html[^>]*data-read-width=/.test(indexHtml), 'index.html 的 <html> 有 data-read-width 兜底');
ok(new RegExp(`<html[^>]*data-theme="${DEFAULT_THEME}"`).test(indexHtml),
  `index.html 的兜底主题就是默认主题 ${DEFAULT_THEME}（否则首帧会闪一下别的配色）`);

// 顺序：motif-art.css < themes.css < styles.css
{
  const iArt = indexHtml.indexOf('motif-art.css');
  const iThemes = indexHtml.indexOf('themes.css');
  const iStyles = indexHtml.indexOf('styles.css');
  ok(iArt !== -1 && iArt < iThemes, 'motif-art.css 在 themes.css 之前（themes.css 引用 --art-*）');
  ok(iThemes !== -1 && iStyles !== -1 && iThemes < iStyles,
    'themes.css 在 styles.css 之前加载（否则变量取不到值）');
}

const rbHtml = await readFile(new URL('../src/rulebook.html', import.meta.url), 'utf8');
ok(rbHtml.includes('themes.css'), 'rulebook.html 引入了 themes.css');
ok(rbHtml.includes('motif-art.css'), 'rulebook.html 引入了 motif-art.css');
ok(rbHtml.includes(`data-theme="${DEFAULT_THEME}"`), '规则书使用同一默认色板');

// ---------------------------------------------------------------------------
console.log('\n== 配置默认值 ==');

const defaultsJs = await readFile(new URL('../electron/defaults.js', import.meta.url), 'utf8');
ok(new RegExp(`uiTheme:\\s*'${DEFAULT_THEME}'`).test(defaultsJs),
  `defaults.js 的 uiTheme 默认值是 ${DEFAULT_THEME}`);
ok(/readWidth:\s*'normal'/.test(defaultsJs), 'defaults.js 有 readWidth 默认值');

const stateJs = await readFile(new URL('../src/state.js', import.meta.url), 'utf8');
ok(new RegExp(`uiTheme:\\s*'${DEFAULT_THEME}'`).test(stateJs),
  `state.js 的 uiTheme 初始值是 ${DEFAULT_THEME}`);
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
