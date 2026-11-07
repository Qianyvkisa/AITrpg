// ---------------------------------------------------------------------------
// 实测便携版「双击 → 动画出现」的耗时（开发用）
//
// 两条时间线一起量，才能证明缓存真的生效：
//   A. 启动器阶段：双击 → 解压目录里出现 app.asar（不需要 GUI 也能测）
//   B. Electron 阶段：进程启动 → splash 窗口出现（读 COCO_STARTUP_LOG）
//
// 用法：
//   node tools/verify-startup.mjs            自动跑「首次」和「二次」两轮
//   node tools/verify-startup.mjs --keep     测完保留缓存目录
// ---------------------------------------------------------------------------

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = 'D:\\Tool\\AIrpg\\COC跑团.exe';
// 缓存位置必须和 build/portable.nsi 里 StrCpy $INSTDIR 的目标一致，
// 否则测到的不是真实缓存命中情况
const cacheDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'coc-keeper-ai-app'
);
const startupLog = path.join(os.tmpdir(), 'coco-verify-startup.log');

function killAll() {
  return new Promise((res) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*COC*' } | Stop-Process -Force"
    ], { stdio: 'ignore' });
    ps.on('close', () => res());
  });
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 文件可能被占用 */ }
}

// 等 app.asar 就位 = 启动器解压完成，Electron 即将被拉起
async function waitAsar(t0, budgetMs) {
  const asar = path.join(cacheDir, 'resources', 'app.asar');
  while (Number(process.hrtime.bigint() - t0) / 1e6 < budgetMs) {
    if (fs.existsSync(asar)) return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(40);
  }
  return null;
}

// 从 COCO_STARTUP_LOG 里取 splash 出现的时间点
function readSplashMs() {
  try {
    const txt = fs.readFileSync(startupLog, 'utf8');
    const m = txt.match(/^\+?\s*(\d+)ms\s+splash 窗口已创建并显示/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

async function runOnce(label, expectCached) {
  await killAll();
  await sleep(600);
  try { fs.unlinkSync(startupLog); } catch { /* 不存在就算了 */ }

  const t0 = process.hrtime.bigint();

  // 清掉 COCO_STARTUP_LOG 之外的环境干扰：
  // 本机 ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node，窗口永远不出现
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.COCO_STARTUP_LOG = startupLog;

  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  child.unref();

  const tAsar = await waitAsar(t0, 30000);
  // 给 Electron 一点时间写日志
  let tSplash = null;
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    tSplash = readSplashMs();
    if (tSplash !== null) break;
  }

  const total = tSplash !== null && tAsar !== null ? tAsar + tSplash : null;

  console.log(`${label}`);
  console.log(`  启动器解压完成   ${tAsar === null ? '★ 超时未完成' : '+' + tAsar + 'ms'}`);
  console.log(`  动画窗口出现     ${tSplash === null ? '★ 未出现' : '进程启动后 +' + tSplash + 'ms'}`);
  console.log(`  双击到看见动画   ${total === null ? '★ 无法计算' : '≈ ' + total + 'ms'}`);
  console.log(`  缓存命中         ${expectCached ? '（本轮应为命中）' : '（本轮应为首次解压）'}`);

  await killAll();
  await sleep(400);
  return { tAsar, tSplash, total };
}

console.log('目标: ' + exe + '\n');

// 首次：清空缓存，走完整解压
rmrf(cacheDir);
await sleep(300);
console.log('=== 第一轮：全新机器（无缓存）===');
const first = await runOnce('首次启动', false);

// 二次：缓存应已建立，直接复用
console.log('\n=== 第二轮：再次双击（缓存已存在）===');
const second = await runOnce('二次启动', true);

console.log('\n=== 结论 ===');
if (first.total !== null && second.total !== null) {
  const saved = first.total - second.total;
  console.log(`  首次 ${first.total}ms → 二次 ${second.total}ms，省下约 ${saved}ms`);
  console.log(second.total < 1000
    ? '  ✔ 二次启动已进入「秒开」范围，动画几乎立刻可见'
    : '  ✘ 二次启动仍偏慢，缓存可能没生效');
} else {
  console.log('  ✘ 有环节没测到，见上面的 ★ 项');
}

if (!process.argv.includes('--keep')) {
  await killAll();
  rmrf(cacheDir);
  console.log('\n已清理缓存目录（加 --keep 可保留）');
}
