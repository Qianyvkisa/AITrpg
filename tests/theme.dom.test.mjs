// ---------------------------------------------------------------------------
// 美术风格 · DOM 层测试
//
// theme.test.mjs 测的是「逻辑对不对、CSS 写没写齐」，这一层测的是
// 「真的把属性写到 <html> 上了没有」——两件事都可能单独出错：
//   逻辑算对了但忘了写 DOM → 界面不变
//   写了 DOM 但写错属性名 → 界面也不变
// 所以用一个极简 document 桩，验证 applyTheme / applyReadWidth 的副作用。
//
// 直接 node tests/theme.dom.test.mjs
// ---------------------------------------------------------------------------
import {
  applyTheme,
  applyReadWidth,
  applyAppearance,
  DEFAULT_THEME,
  DEFAULT_READ_WIDTH,
  THEME_IDS
} from '../src/ui/theme.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

// ---------------------------------------------------------------------------
// document 桩：只需要 documentElement.dataset
// ---------------------------------------------------------------------------
const documentElement = { dataset: {} };
globalThis.document = { documentElement };

/** 重置到「什么都没设」的状态，每个用例独立 */
function reset() {
  documentElement.dataset = {};
}

// 取一个非默认主题，避免「默认主题的大写回落」和「正确写入」看起来一样
const OTHER = THEME_IDS.find((x) => x !== DEFAULT_THEME) || DEFAULT_THEME;
const OTHER2 = DEFAULT_THEME;

// ---------------------------------------------------------------------------
console.log('\n== applyTheme 写入 dataset.theme ==');

reset();
eq(applyTheme(OTHER), OTHER, '返回值是生效的主题');
eq(documentElement.dataset.theme, OTHER, `<html data-theme> 被设为 ${OTHER}`);

// 各主题逐个写一遍：只要有一套路写不进去，
// 说明 normalizeTheme 的白名单漏了它（用户点了那个卡片没反应）
for (const id of THEME_IDS) {
  reset();
  eq(applyTheme(id), id, `${id}: 返回值正确`);
  eq(documentElement.dataset.theme, id, `${id}: 写入成功`);
}

// ---------------------------------------------------------------------------
console.log('\n== 脏值回落到默认主题 ==');

reset();
eq(applyTheme('nonexistent'), DEFAULT_THEME, '非法主题返回默认');
eq(documentElement.dataset.theme, DEFAULT_THEME, '非法主题写入的是默认值');

reset();
eq(applyTheme(null), DEFAULT_THEME, 'null 回落');
eq(documentElement.dataset.theme, DEFAULT_THEME, 'null 也写入默认值');

reset();
eq(applyTheme(undefined), DEFAULT_THEME, 'undefined 回落');
reset();
eq(applyTheme(''), DEFAULT_THEME, '空串回落');

// 旧主题名（老配置文件里存的）必须回落到新默认，
// 而不是把 dataset 设成一个 CSS 里不存在的值——
// 那样界面会停在 :root 的兜底配色上，看起来「换主题完全失效」
for (const legacy of ['engraving', 'acrylic', 'vhs', 'brass', 'abyss', 'phosphor', 'blood']) {
  reset();
  eq(applyTheme(legacy), DEFAULT_THEME, `旧主题名 ${legacy} 回落默认`);
  eq(documentElement.dataset.theme, DEFAULT_THEME, `旧主题名 ${legacy} 不会写进 DOM`);
}

// ---------------------------------------------------------------------------
console.log('\n== applyReadWidth 写入 dataset.readWidth ==');

reset();
eq(applyReadWidth('wide'), 'wide', '返回值是生效的档位');
// 注意属性名：CSS 里写的是 [data-read-width="wide"]，
// 对应 dataset 上的 readWidth（连字符转驼峰）。
// 写成 dataset.read_width 或 dataset['read-width'] 都不会生效，
// 界面看起来「点了没反应」。
eq(documentElement.dataset.readWidth, 'wide', '<html data-read-width> 被设为 wide');

reset();
applyReadWidth('narrow');
eq(documentElement.dataset.readWidth, 'narrow', 'narrow 写入成功');

reset();
applyReadWidth('bogus');
eq(documentElement.dataset.readWidth, DEFAULT_READ_WIDTH, '非法档位写入默认值');

// ---------------------------------------------------------------------------
console.log('\n== 幂等：重复设置同一值不产生副作用 ==');

reset();
applyTheme(OTHER);
const first = documentElement.dataset.theme;
applyTheme(OTHER);
applyTheme(OTHER);
eq(documentElement.dataset.theme, first, '重复设置主题结果一致');
eq(first, OTHER, `结果仍是 ${OTHER}`);

// 幂等的真正意义：值没变就不该再写一次。
// 这里用一个 setter 计数验证「没变化时确实没碰 DOM」，
// 因为每次写 dataset 都会让浏览器做一次样式重算，长列表滚动时会掉帧。
{
  let writes = 0;
  const el = { dataset: {} };
  Object.defineProperty(el.dataset, 'theme', {
    get() { return el._t; },
    set(v) { writes++; el._t = v; }
  });
  globalThis.document = { documentElement: el };

  applyTheme(OTHER);          // 第一次：必须写
  const after1 = writes;
  applyTheme(OTHER);          // 第二次：值相同，不该写
  applyTheme(OTHER);          // 第三次：同上
  ok(after1 >= 1, '首次设置确实写入了 DOM');
  eq(writes, after1, '值未变化时不再重复写 DOM（省一次样式重算）');

  globalThis.document = { documentElement };
}

reset();
applyReadWidth('wide');
applyReadWidth('wide');
eq(documentElement.dataset.readWidth, 'wide', '重复设置宽度结果一致');

// ---------------------------------------------------------------------------
console.log('\n== 切换主题：旧值被覆盖，不残留 ==');

reset();
applyTheme(OTHER);
applyTheme(OTHER2);
eq(documentElement.dataset.theme, OTHER2, '第二次设置覆盖第一次');
ok(documentElement.dataset.theme !== OTHER, '不残留旧主题');

// ---------------------------------------------------------------------------
console.log('\n== applyAppearance 同时写两个属性 ==');

reset();
{
  const r = applyAppearance({ uiTheme: OTHER, readWidth: 'narrow' });
  eq(r.theme, OTHER, '返回 theme');
  eq(r.readWidth, 'narrow', '返回 readWidth');
  eq(documentElement.dataset.theme, OTHER, 'dataset.theme 写入');
  eq(documentElement.dataset.readWidth, 'narrow', 'dataset.readWidth 写入');
}

reset();
{
  // 真实场景：config.json 里只有旧的模型配置，没有外观字段
  const r = applyAppearance({ baseUrl: 'x', apiKey: 'y', model: 'z' });
  eq(r.theme, DEFAULT_THEME, '没有外观字段时用默认主题');
  eq(r.readWidth, DEFAULT_READ_WIDTH, '没有外观字段时用默认宽度');
  eq(documentElement.dataset.theme, DEFAULT_THEME, '默认主题确实写进了 DOM');
}

reset();
{
  // 用户手改了配置，把主题写错
  const r = applyAppearance({ uiTheme: 'rainbow', readWidth: 'huge' });
  eq(r.theme, DEFAULT_THEME, '手改错的主题回落');
  eq(r.readWidth, DEFAULT_READ_WIDTH, '手改错的宽度回落');
  eq(documentElement.dataset.theme, DEFAULT_THEME, 'DOM 上是回落后的值');
}

// 老配置：uiTheme 存着旧主题名，readWidth 正常。
// 主题回落默认，但宽度不能被连带重置——两个字段互相独立。
reset();
{
  const r = applyAppearance({ uiTheme: 'brass', readWidth: 'wide' });
  eq(r.theme, DEFAULT_THEME, '旧主题名回落默认');
  eq(r.readWidth, 'wide', '旧的合法宽度不受影响（两字段独立）');
  eq(documentElement.dataset.theme, DEFAULT_THEME, '主题写默认值');
  eq(documentElement.dataset.readWidth, 'wide', '宽度写用户选的值');
}

// ---------------------------------------------------------------------------
console.log('\n== 没有 document 时不崩（浏览器外的调用路径）==');

{
  delete globalThis.document;
  let threw = false;
  let r;
  try {
    r = applyTheme(OTHER);
  } catch {
    threw = true;
  }
  ok(!threw, '无 document 时 applyTheme 不抛错');
  eq(r, OTHER, '无 document 时仍返回归一化结果');

  threw = false;
  try {
    applyReadWidth('wide');
    applyAppearance({ uiTheme: OTHER2 });
  } catch {
    threw = true;
  }
  ok(!threw, '无 document 时 applyReadWidth / applyAppearance 不抛错');
}

// ---------------------------------------------------------------------------
console.log('\n== documentElement 存在但 dataset 缺失时不崩 ==');

{
  // 极端情况：某个环境里 document 在但 documentElement 是 null
  globalThis.document = { documentElement: null };
  let threw = false;
  try {
    applyTheme(OTHER);
  } catch {
    threw = true;
  }
  ok(!threw, 'documentElement 为 null 时不抛错');

  globalThis.document = { documentElement: { dataset: {} } };
  applyTheme(OTHER2);
  eq(globalThis.document.documentElement.dataset.theme, OTHER2, '恢复后能正常写入');
}

// ---------------------------------------------------------------------------
// 收尾：把桩恢复成可用的形态，避免影响后续（本文件是独立进程，仅作保险）
globalThis.document = { documentElement };

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
