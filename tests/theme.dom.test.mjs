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
  DEFAULT_READ_WIDTH
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

// ---------------------------------------------------------------------------
console.log('\n== applyTheme 写入 dataset.theme ==');

reset();
eq(applyTheme('abyss'), 'abyss', '返回值是生效的主题');
eq(documentElement.dataset.theme, 'abyss', '<html data-theme> 被设为 abyss');

reset();
applyTheme('phosphor');
eq(documentElement.dataset.theme, 'phosphor', 'phosphor 写入成功');

reset();
applyTheme('blood');
eq(documentElement.dataset.theme, 'blood', 'blood 写入成功');

reset();
applyTheme('brass');
eq(documentElement.dataset.theme, 'brass', 'brass 写入成功');

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
applyTheme('abyss');
const first = documentElement.dataset.theme;
applyTheme('abyss');
applyTheme('abyss');
eq(documentElement.dataset.theme, first, '重复设置主题结果一致');
eq(first, 'abyss', '结果仍是 abyss');

reset();
applyReadWidth('wide');
applyReadWidth('wide');
eq(documentElement.dataset.readWidth, 'wide', '重复设置宽度结果一致');

// ---------------------------------------------------------------------------
console.log('\n== 切换主题：旧值被覆盖，不残留 ==');

reset();
applyTheme('abyss');
applyTheme('phosphor');
eq(documentElement.dataset.theme, 'phosphor', '第二次设置覆盖第一次');
ok(documentElement.dataset.theme !== 'abyss', '不残留旧主题');

// ---------------------------------------------------------------------------
console.log('\n== applyAppearance 同时写两个属性 ==');

reset();
{
  const r = applyAppearance({ uiTheme: 'blood', readWidth: 'narrow' });
  eq(r.theme, 'blood', '返回 theme');
  eq(r.readWidth, 'narrow', '返回 readWidth');
  eq(documentElement.dataset.theme, 'blood', 'dataset.theme 写入');
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

// ---------------------------------------------------------------------------
console.log('\n== 没有 document 时不崩（浏览器外的调用路径）==');

{
  delete globalThis.document;
  let threw = false;
  let r;
  try {
    r = applyTheme('abyss');
  } catch {
    threw = true;
  }
  ok(!threw, '无 document 时 applyTheme 不抛错');
  eq(r, 'abyss', '无 document 时仍返回归一化结果');

  threw = false;
  try {
    applyReadWidth('wide');
    applyAppearance({ uiTheme: 'blood' });
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
    applyTheme('abyss');
  } catch {
    threw = true;
  }
  ok(!threw, 'documentElement 为 null 时不抛错');

  globalThis.document = { documentElement: { dataset: {} } };
  applyTheme('blood');
  eq(globalThis.document.documentElement.dataset.theme, 'blood', '恢复后能正常写入');
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
