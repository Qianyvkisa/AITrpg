// ---------------------------------------------------------------------------
// 角色卡库 IPC 测试
//
// 用临时目录 + 假 electron 模块真正跑一遍 registerCharIpc，
// 验证增删改查、玩家库/AI 库互不干扰、坏数据不炸。
// 直接 node tests/charStore.test.mjs
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// ---- 假 electron：把 userData 指到临时目录，并收集注册的 handler ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-charlib-'));

const handlers = {};
const fakeElectron = {
  app: { getPath: () => tmpDir },
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
};

// 拦下 require('electron')，换成假的
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const { registerCharIpc } = require('../electron/ipc-files.js');
registerCharIpc();
Module._load = origLoad;

// ---- 迷你断言 ----
let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

const call = (name, ...args) => handlers[name]({}, ...args);

// ---- 用例 ----
(async () => {
  console.log('== 角色卡库 IPC ==');

  // 空库
  eq((await call('char:list', 'player')).length, 0, '初始玩家库为空');
  eq((await call('char:list', 'ai')).length, 0, '初始 AI 库为空');

  // 存一张玩家卡
  const p1 = await call('char:save', {
    kind: 'player', char: { name: '阿远', occupation: '记者', attrs: { DEX: 60 } }
  });
  ok(p1.ok, '玩家卡保存成功');
  ok(typeof p1.id === 'string' && p1.id.length > 0, '返回了 id');

  const plist = await call('char:list', 'player');
  eq(plist.length, 1, '玩家库有 1 张');
  eq(plist[0].name, '阿远', '卡片名字正确');
  eq(plist[0].char.occupation, '记者', '卡片内容被完整保留');

  // 两个库必须分开：存玩家卡不该污染 AI 库
  eq((await call('char:list', 'ai')).length, 0, '存玩家卡不影响 AI 库');

  // 存一张 AI 卡
  const a1 = await call('char:save', { kind: 'ai', char: { name: '老周', occupation: '退伍军人' } });
  ok(a1.ok, 'AI 卡保存成功');
  eq((await call('char:list', 'ai')).length, 1, 'AI 库有 1 张');
  eq((await call('char:list', 'player')).length, 1, '玩家库仍是 1 张');

  // 用同一 id 覆盖，不该产生第二张
  await call('char:save', {
    kind: 'player', id: p1.id, char: { name: '阿远改', occupation: '作家' }
  });
  const after = await call('char:list', 'player');
  eq(after.length, 1, '同 id 覆盖不新增');
  eq(after[0].char.name, '阿远改', '覆盖后内容已更新');

  // 不传 name 时用角色卡里的名字兜底
  const a2 = await call('char:save', { kind: 'ai', char: { name: '小满' } });
  const aiList = await call('char:list', 'ai');
  const hit = aiList.find((c) => c.id === a2.id);
  ok(hit && hit.name === '小满', '没传 name 时用角色卡名兜底');

  // 没名字的卡给个默认名，别显示成空白
  const a3 = await call('char:save', { kind: 'ai', char: { occupation: '流浪汉' } });
  const hit3 = (await call('char:list', 'ai')).find((c) => c.id === a3.id);
  eq(hit3.name, '未命名调查员', '无名字时用默认名');

  // 删除
  await call('char:delete', { kind: 'ai', id: a1.id });
  eq((await call('char:list', 'ai')).length, 2, '删除后 AI 库少一张');
  // 删 AI 卡不影响玩家库
  eq((await call('char:list', 'player')).length, 1, '删 AI 卡不影响玩家库');

  // 删不存在的 id 不该炸
  await call('char:delete', { kind: 'ai', id: 'not-exist' });
  ok(true, '删除不存在的 id 不抛异常');

  // 改名
  await call('char:rename', { kind: 'player', id: p1.id, name: '远哥' });
  eq((await call('char:list', 'player'))[0].name, '远哥', '改名生效');

  // 空名字改名保持原名，不该被清空
  await call('char:rename', { kind: 'player', id: p1.id, name: '   ' });
  eq((await call('char:list', 'player'))[0].name, '远哥', '空名字不改动');

  // 非法 kind 落到玩家库，不崩
  const bad = await call('char:save', { kind: 'garbage', char: { name: 'X' } });
  ok(bad.ok, '非法 kind 仍能保存（落到玩家库）');

  // 空角色卡拒绝保存
  const empty = await call('char:save', { kind: 'player', char: null });
  eq(empty.ok, false, '空角色卡被拒绝');

  // 文件损坏时 list 返回空数组而不是抛异常
  fs.writeFileSync(path.join(tmpDir, 'data', 'characters-ai.json'), '{ broken json', 'utf8');
  const broken = await call('char:list', 'ai');
  ok(Array.isArray(broken), '坏文件时返回数组');
  eq(broken.length, 0, '坏文件时按空库处理');

  // 排序：新存的排前面
  fs.writeFileSync(path.join(tmpDir, 'data', 'characters-ai.json'), '[]', 'utf8');
  await call('char:save', { kind: 'ai', char: { name: '先' } });
  await new Promise((r) => setTimeout(r, 10));
  await call('char:save', { kind: 'ai', char: { name: '后' } });
  const sorted = await call('char:list', 'ai');
  eq(sorted[0].name, '后', '最近保存的排在前面');

  // -------------------------------------------------------------------------
  // 回归：开始界面「存库」连点会存出多份一模一样的卡
  //
  // 真实 bug：设定界面每次点「存库」都调 char:save 且不传库条目 id，
  // 而原实现"不传 id 就新建"，于是同一张卡存了几份就有几条。
  // 修复后按角色卡自带的 char.id 判定为同一张卡，覆盖而不是新增。
  // -------------------------------------------------------------------------
  fs.writeFileSync(path.join(tmpDir, 'data', 'characters-player.json'), '[]', 'utf8');
  const sameChar = { id: 'pc-same001', name: '阿远', occupation: '记者' };

  const r1 = await call('char:save', { kind: 'player', char: sameChar, id: null, name: '阿远' });
  eq(r1.updated, false, '首次存库算新增');
  const r2 = await call('char:save', { kind: 'player', char: sameChar, id: null, name: '阿远' });
  eq(r2.updated, true, '再存同一张卡算更新');
  const r3 = await call('char:save', { kind: 'player', char: sameChar, id: null, name: '阿远' });
  eq(r3.updated, true, '第三次仍是更新');

  const dedup = await call('char:list', 'player');
  eq(dedup.length, 1, '同一张卡连存 3 次只保留 1 份');
  eq(dedup[0].id, r1.id, '覆盖时沿用首次的库条目 id');
  eq(dedup[0].char.id, 'pc-same001', '角色卡自身 id 保持不变');

  // 内容更新也要写进去，不能只是"不新增"却保留旧内容
  await call('char:save', {
    kind: 'player',
    char: { id: 'pc-same001', name: '阿远', occupation: '作家' },
    id: null, name: '阿远'
  });
  eq((await call('char:list', 'player'))[0].char.occupation, '作家', '覆盖时内容确实更新');

  // 不同 char.id 是不同的人，必须各自新建
  await call('char:save', { kind: 'player', char: { id: 'pc-other002', name: '老周' }, id: null });
  eq((await call('char:list', 'player')).length, 2, '不同 char.id 各自独立保存');

  // 没有 char.id 的卡（老数据 / 手写对象）保持原语义：每次新建
  await call('char:save', { kind: 'player', char: { name: '无 id 甲' }, id: null });
  await call('char:save', { kind: 'player', char: { name: '无 id 甲' }, id: null });
  const noId = (await call('char:list', 'player')).filter((e) => e.name === '无 id 甲');
  eq(noId.length, 2, '无 char.id 时仍按新建处理，不会被误合并');

  // 收尾
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n' + '='.repeat(42));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  } else {
    console.log('全部通过');
  }
})();
