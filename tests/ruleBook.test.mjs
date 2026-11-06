// ---------------------------------------------------------------------------
// 规则书测试
//
// 覆盖三件事：
//   1) 章节索引数据本身没问题（页码递增、层级合法、条目数对得上）
//   2) rulebook:path / rulebook:openExternal 两个 IPC 的行为（含文件缺失）
//   3) 索引里每个页码都落在 PDF 总页数范围内
//
// 直接 node tests/ruleBook.test.mjs
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failed++;
  failures.push(name + (detail ? `（${detail}）` : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${actual}，期望 ${expected}`);
}

// ---------------------------------------------------------------------------
// 1) 索引数据
// ---------------------------------------------------------------------------
const idx = await import('../src/core/ruleBookIndex.js');
const PAGES = idx.RULE_BOOK_PAGES;
const TOTAL = idx.RULE_BOOK_TOTAL;

ok('索引非空', Array.isArray(PAGES) && PAGES.length > 0, `实际 ${PAGES.length} 条`);
eq('总页数为 418', TOTAL, 418);

// 每条必须是 [string, number, number] 的三元组
let shapeBad = [];
for (const it of PAGES) {
  const good = Array.isArray(it) && it.length === 3
    && typeof it[0] === 'string' && it[0].trim().length > 0
    && Number.isInteger(it[1]) && it[1] >= 1 && it[1] <= TOTAL
    && Number.isInteger(it[2]) && it[2] >= 0 && it[2] <= 2;
  if (!good) shapeBad.push(JSON.stringify(it));
}
ok('每条都是合法的 [标题, 页码, 层级]', shapeBad.length === 0, shapeBad.slice(0, 3).join(' / '));

// 页码必须落在 1..TOTAL 内（越界会导致阅读器跳页失败）
const outOfRange = PAGES.filter(([, p]) => p < 1 || p > TOTAL);
ok('所有页码都在总页数范围内', outOfRange.length === 0, outOfRange.map((x) => x[0]).join(', '));

// 页码整体应单调不减：PDF 书签是按顺序排的，乱序说明提取出了问题
let nonMono = [];
for (let i = 1; i < PAGES.length; i++) {
  if (PAGES[i][1] < PAGES[i - 1][1]) nonMono.push(`${PAGES[i - 1][0]}(${PAGES[i - 1][1]}) → ${PAGES[i][0]}(${PAGES[i][1]})`);
}
ok('页码单调不减', nonMono.length === 0, nonMono.slice(0, 2).join(' / '));

// 层级不能凭空跳级（0 → 2 说明中间少了一层）
let jump = [];
for (let i = 1; i < PAGES.length; i++) {
  if (PAGES[i][2] - PAGES[i - 1][2] > 1) jump.push(`${PAGES[i - 1][0]} → ${PAGES[i][0]}`);
}
ok('层级不跳级', jump.length === 0, jump.slice(0, 2).join(' / '));

// 一级章节数量：这份 PDF 有 21 个顶级书签
const top = PAGES.filter(([, , d]) => d === 0);
eq('一级章节数为 21', top.length, 21);

// 抽查几个关键章节的页码，防止提取错位
const findPage = (kw) => {
  const hit = PAGES.find(([t]) => t.includes(kw));
  return hit ? hit[1] : null;
};
eq('「第五章 游戏系统」在第 73 页', findPage('第五章 游戏系统'), 73);
eq('「第八章 理智」在第 137 页', findPage('第八章 理智'), 137);
eq('「第六章 战斗」在第 87 页', findPage('第六章 战斗'), 87);

// 标题不应带明显脏字符
const dirty = PAGES.filter(([t]) => /[\u0000-\u001f]/.test(t));
ok('标题不含控制字符', dirty.length === 0, dirty.slice(0, 2).map((x) => x[0]).join(' / '));

// ---------------------------------------------------------------------------
// 2) IPC 行为
//
// 注意：ruleBookPath() 是基于 electron/ 的真实目录算出来的，
// 不能用临时目录伪造"文件缺失"场景——那样测的是假路径，不是真代码。
// 所以这里直接验证真实文件的处理，外加一条可伪造的失败路径（openPath 报错）。
// ---------------------------------------------------------------------------
const handlers = {};
const opened = [];
const fakeElectron = {
  app: { getPath: () => path.join(process.cwd(), '.tmp-rulebook') },
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async (p) => { opened.push(p); return ''; } }
};

// 让 ipc-files.js 里的 require('electron') 拿到假模块
// 只拦 _load 就够了；再拦 _resolveFilename 会把模块名当文件路径去读，反而报错
const Module = (await import('module')).default;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const ipcFiles = require('../electron/ipc-files.js');
ipcFiles.registerRuleBookIpc();

// rulebook:path 指向真实存在的 PDF
const info = await handlers['rulebook:path']();
ok('rulebook:path 返回 ok:true', info.ok === true, JSON.stringify(info));
ok('返回的是 file:// URL', String(info.url || '').startsWith('file://'), info.url);
ok('URL 指向 coc-kp.pdf', String(info.url || '').includes('coc-kp.pdf'), info.url);
ok('返回的 path 真实存在', fs.existsSync(info.path), info.path);
// 打包后应优先取 app.asar.unpacked 里的那份（Chromium 的 PDF 插件读不了 asar）
ok('开发态路径不含 app.asar', !String(info.path).includes('app.asar'), info.path);

// openExternal 成功路径：真的把路径交给了 shell
const ext1 = await handlers['rulebook:openExternal']();
ok('文件存在时 openExternal 成功', ext1.ok === true, JSON.stringify(ext1));
ok('openExternal 调用了 shell.openPath', opened.length === 1, `调用 ${opened.length} 次`);
ok('交给 shell 的是同一个 PDF', String(opened[0] || '').includes('coc-kp.pdf'), opened[0]);

// openPath 失败（返回非空字符串）时应转成 ok:false
fakeElectron.shell.openPath = async () => '拒绝访问';
const denied = await handlers['rulebook:openExternal']();
ok('openPath 失败时转成 ok:false', denied.ok === false, JSON.stringify(denied));
ok('失败原因被带出来', String(denied.error || '').includes('拒绝访问'), denied.error);

// ---------------------------------------------------------------------------
// 3) 项目里真有这份 PDF
// ---------------------------------------------------------------------------
const realPdf = path.join(process.cwd(), 'assets', 'coc-kp.pdf');
ok('assets/coc-kp.pdf 存在', fs.existsSync(realPdf), realPdf);
if (fs.existsSync(realPdf)) {
  const size = fs.statSync(realPdf).size;
  ok('PDF 大小在合理范围（>1MB）', size > 1024 * 1024, `${Math.round(size / 1024 / 1024)} MB`);
  const head = fs.readFileSync(realPdf, { encoding: 'latin1', flag: 'r' }).slice(0, 5);
  ok('PDF 文件头正确', head.startsWith('%PDF'), head);
}

// 还原 Module 钩子，避免影响后续
Module._load = origLoad;

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(50));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项，共 ' + (passed + failed) + ' 项');
if (failed > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
