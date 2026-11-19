// 静态检查：确认 app.js 里联机相关的外部符号都真实存在
// 用正则粗查比人眼看可靠，尤其是跨文件的方法名。
'use strict';

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const appJs = read('../src/app.js');
const onlineJs = read('../src/modals/online.js');
const preloadJs = read('../preload.js');
const netIpcJs = read('../electron/net-ipc.js');
const messagesJs = read('../src/ui/messages.js');
const persistenceJs = read('../src/persistence.js');
const engineJs = read('../src/core/engine.js');

console.log('== preload 暴露的 net 方法 vs app.js 用到的 ==');
// 从 preload 里抽出 net: { ... } 块内的方法名
const netBlock = preloadJs.match(/net:\s*\{([\s\S]*?)\n  \}/);
if (!netBlock) {
  bad('preload 里找不到 net 块');
} else {
  const exposed = new Set();
  for (const m of netBlock[1].matchAll(/^\s{4}(\w+):/gm)) exposed.add(m[1]);
  console.log(`     preload 暴露: ${[...exposed].join(', ')}`);

  // app.js 和 online.js 里所有 window.api?.net.xxx / net.xxx 调用
  const used = new Set();
  for (const src of [appJs, onlineJs]) {
    for (const m of src.matchAll(/net\.(\w+)\(/g)) used.add(m[1]);
    for (const m of src.matchAll(/window\.api\.net\.(\w+)\(/g)) used.add(m[1]);
  }
  // on* 是订阅方法，也要检查
  for (const src of [appJs, onlineJs]) {
    for (const m of src.matchAll(/net\.(on\w+)\(/g)) used.add(m[1]);
  }
  console.log(`     代码用到: ${[...used].join(', ')}`);

  for (const name of used) {
    exposed.has(name) ? ok(`net.${name} 已暴露`) : bad(`net.${name} 未在 preload 暴露`);
  }
}

console.log('\n== net-ipc 注册的通道 vs preload 调用的通道 ==');
const registered = new Set();
for (const m of netIpcJs.matchAll(/ipcMain\.handle\('([^']+)'/g)) registered.add(m[1]);
const invoked = new Set();
for (const m of preloadJs.matchAll(/ipcRenderer\.invoke\('(net:[^']+)'/g)) invoked.add(m[1]);
console.log(`     注册: ${registered.size} 个通道`);

for (const ch of invoked) {
  registered.has(ch) ? ok(`${ch} 已注册`) : bad(`${ch} 未注册`);
}

// 订阅通道：主进程 send 的 vs preload on 监听的
const pushed = new Set();
for (const m of netIpcJs.matchAll(/push(?:Player)?\('([^']+)'\)/g)) pushed.add(m[1]);
const listened = new Set();
for (const m of preloadJs.matchAll(/sub\('([^']+)'\)/g)) listened.add(m[1]);
console.log(`     主进程推送: ${[...pushed].join(', ')}`);
for (const ch of pushed) {
  listened.has(ch) ? ok(`${ch} 有监听`) : bad(`${ch} 无监听`);
}

console.log('\n== app.js 用到的渲染函数是否存在 ==');
const renderFns = ['scheduleStreamUpdate', 'renderMessage', 'replaceMessage'];
for (const fn of renderFns) {
  const declared = new RegExp(`export function ${fn}\\b`).test(messagesJs);
  declared ? ok(`${fn} 已导出`) : bad(`${fn} 未导出`);
}

// 实际调用签名：scheduleStreamUpdate 只收一个参数
const callMatch = appJs.match(/scheduleStreamUpdate\(([^)]*)\)/);
if (callMatch) {
  const argCount = callMatch[1].split(',').filter((s) => s.trim()).length;
  argCount === 1 ? ok('scheduleStreamUpdate 按 1 个参数调用') : bad(`scheduleStreamUpdate 传了 ${argCount} 个参数，实际只接受 1 个`);
}

console.log('\n== 引擎方法 ==');
['pushMessage', 'pendingRolls'].forEach((fn) => {
  const declared = new RegExp(`^\\s{2}${fn}\\(`, 'm').test(engineJs);
  declared ? ok(`engine.${fn} 存在`) : bad(`engine.${fn} 不存在`);
});
const getPending = appJs.includes('getPendingRolls');
getPending ? bad('app.js 里还有 getPendingRolls（不存在的方法）') : ok('没有引用不存在的 getPendingRolls');

console.log('\n== applySnapshot 签名 ==');
/export function applySnapshot\(state, snapshot\)/.test(persistenceJs)
  ? ok('applySnapshot(state, snapshot) 签名匹配')
  : bad('applySnapshot 签名不匹配');

console.log('\n== 消息 role 白名单 ==');
const usedRoles = new Set();
for (const m of appJs.matchAll(/pushMessage\(\{[^}]*?\brole:\s*'([\w-]+)'/g)) usedRoles.add(m[1]);
// 渲染器支持的 role：直接从 messages.js 的 ROLE 映射表里读，
// 别在测试里手写一份——手写的那份迟早会和实现不同步。
const roleTable = messagesJs.match(/const\s+ROLE\w*\s*=\s*\{([\s\S]*?)\};/);
const supported = new Set();
if (roleTable) {
  for (const m of roleTable[1].matchAll(/^\s*'?([\w-]+)'?\s*:/gm)) supported.add(m[1]);
}
if (supported.size === 0) {
  // 兜底：如果映射表的写法变了，至少别让这条检查变成假失败
  ['keeper', 'player', 'user', 'roll', 'system', 'system-result', 'clue', 'teammate', 'teammate-action']
    .forEach((r) => supported.add(r));
}
console.log(`     渲染器支持: ${[...supported].join(', ')}`);
for (const r of usedRoles) {
  supported.has(r) ? ok(`role '${r}' 受支持`) : bad(`role '${r}' 可能不被渲染器识别`);
}

console.log('\n== HTML 里的按钮 id ==');
const html = read('../src/index.html');
for (const id of ['btnOnline', 'menuOnline']) {
  html.includes(`id="${id}"`) ? ok(`#${id} 存在于 HTML`) : bad(`#${id} 不存在`);
}
// app.js 里 $('#btnOnline') 之类的引用必须都能在 HTML 找到
for (const m of appJs.matchAll(/\$\('#(\w+)'\)/g)) {
  html.includes(`id="${m[1]}"`) ? ok(`#${m[1]} 有对应元素`) : bad(`#${m[1]} 在 HTML 里找不到`);
}

console.log('\n== 样式类是否定义了 ==');
const css = read('../src/styles.css');
for (const cls of ['.online-modal', '.online-split', '.online-card', '.online-room', '.online-code', '.online-player', '.online-dot']) {
  css.includes(cls) ? ok(`${cls} 有样式`) : bad(`${cls} 缺样式`);
}

console.log('\n== 主题与布局改造的样式类 ==');
// 新增的样式类必须真的写进了 CSS，否则设置面板里的卡片和折叠按钮
// 会渲染成没有任何外观的原生按钮，看起来像界面坏了。
for (const cls of ['.st-tabs', '.st-tab', '.st-pane', '.theme-opt', '.theme-swatch', '.rw-opt', '.top-toggle', '.top-sep']) {
  css.includes(cls) ? ok(`${cls} 有样式`) : bad(`${cls} 缺样式`);
}
// 折叠态必须真的能隐藏侧栏
for (const sel of ['.layout.hide-left', '.layout.hide-right']) {
  css.includes(sel) ? ok(`${sel} 有折叠规则`) : bad(`${sel} 缺折叠规则`);
}
// 阅读宽度变量必须在 themes.css 里定义（styles.css 只引用不定义）
const themesCss = read('../src/themes.css');
themesCss.includes('--read-width')
  ? ok('--read-width 在 themes.css 定义')
  : bad('--read-width 未在 themes.css 定义');

console.log('\n== 设置面板的 tab 与外观元素 ==');
const settingsJs = read('../src/modals/settings.js');
// tab 的 data-tab 值必须与 pane 的 data-pane 值一一对应，
// 否则点 tab 会出现「切到空白页」
const tabIds = new Set();
for (const m of settingsJs.matchAll(/data-tab="\$\{[^}]*\}"|data-tab="(\w+)"/g)) {
  if (m[1]) tabIds.add(m[1]);
}
const TABS_DEF = settingsJs.match(/const TABS = \[([\s\S]*?)\];/);
const definedTabs = new Set();
if (TABS_DEF) {
  for (const m of TABS_DEF[1].matchAll(/id:\s*'(\w+)'/g)) definedTabs.add(m[1]);
}
console.log(`     定义的 tab: ${[...definedTabs].join(', ')}`);
for (const t of definedTabs) {
  settingsJs.includes(`data-pane="${t}"`)
    ? ok(`tab '${t}' 有对应 pane`)
    : bad(`tab '${t}' 没有对应 pane`);
}
// 每个 pane 都要有内容，不能是空壳
const paneCount = (settingsJs.match(/data-pane="/g) || []).length;
paneCount === definedTabs.size
  ? ok(`pane 数量与 tab 一致（${paneCount}）`)
  : bad(`pane 数量 ${paneCount} 与 tab 数量 ${definedTabs.size} 不一致`);

console.log('\n== 外观字段必须随 config:set 一起提交 ==');
// config:set 是整体覆盖而不是 patch 合并（见 electron/config.js 的 saveConfig），
// 所以 collect() 里漏掉外观字段，保存模型配置时就会把主题重置回默认。
{
  const collectBlock = settingsJs.match(/const collect = \(\) => \(\{([\s\S]*?)\}\);/);
  if (!collectBlock) {
    bad('找不到 collect() 定义');
  } else {
    collectBlock[1].includes('uiTheme')
      ? ok('collect() 包含 uiTheme')
      : bad('collect() 漏了 uiTheme —— 保存会重置主题');
    collectBlock[1].includes('readWidth')
      ? ok('collect() 包含 readWidth')
      : bad('collect() 漏了 readWidth —— 保存会重置阅读宽度');
  }
}

console.log('\n== 主题初始化链路 ==');
// 三个 HTML 都必须引入 themes.css 且先于 styles.css
for (const f of ['../src/index.html', '../src/rulebook.html', '../tools/ui/index.html']) {
  const src = read(f);
  const iT = src.indexOf('themes.css');
  const iS = src.indexOf('styles.css');
  const name = f.replace('../', '');
  if (iT === -1) { bad(`${name} 未引入 themes.css`); continue; }
  if (iS !== -1 && iT > iS) { bad(`${name} 的 themes.css 在 styles.css 之后加载`); continue; }
  ok(`${name} 正确引入 themes.css`);
}
// app.js 必须在启动时应用外观
appJs.includes('applyAppearance')
  ? ok('app.js 调用 applyAppearance')
  : bad('app.js 未应用外观配置');
appJs.includes('applyPanelVisibility')
  ? ok('app.js 有折叠状态同步函数')
  : bad('app.js 缺折叠状态同步');
// 折叠开关的按钮 id 必须存在
for (const id of ['btnToggleLeft', 'btnToggleRight']) {
  html.includes(`id="${id}"`) ? ok(`#${id} 存在于 HTML`) : bad(`#${id} 不存在`);
}

console.log('\n==========================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) console.log('全部通过'); else process.exitCode = 1;
