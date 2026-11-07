// ---------------------------------------------------------------------------
// 便携包解压耗时实测（开发用）
//
// 目的：portable exe 每次启动都先把 235MB 解压到 %TEMP% 再拉起 Electron。
// 这段发生在 main.js 执行之前，窗口/splash 都还不存在，用户看到的是"毫无反应"。
// 本脚本不依赖窗口，直接监控临时目录增长，测出这段到底花多久。
//
// 用法：node tools/measure-extract.mjs [轮数]
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rounds = Number(process.argv[2] || 2);
const exe = resolve(root, 'COC跑团.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  return new Promise((res) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'COC|跑团' } | Stop-Process -Force`
    ], { stdio: 'ignore' });
    ps.on('close', () => res());
  });
}

/** 列出 %TEMP% 下所有含 COC跑团.exe 的目录 */
function findExtractDirs() {
  const out = [];
  let names = [];
  try { names = readdirSync(tmpdir()); } catch { return out; }
  for (const n of names) {
    const p = join(tmpdir(), n);
    try {
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'COC跑团.exe'))) out.push(p);
    } catch { /* 忽略 */ }
  }
  return out;
}

/** 目录总大小（MB） */
function dirSizeMB(p) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try { items = readdirSync(d); } catch { return; }
    for (const it of items) {
      const q = join(d, it);
      try {
        const st = statSync(q);
        if (st.isDirectory()) walk(q);
        else total += st.size;
      } catch { /* 忽略 */ }
    }
  };
  walk(p);
  return total / 1024 / 1024;
}

const before = new Set(findExtractDirs());

for (let i = 1; i <= rounds; i++) {
  await killAll();
  await sleep(1000);

  const t0 = process.hrtime.bigint();
  const el = () => Number(process.hrtime.bigint() - t0) / 1e6;

  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();

  // 等到出现新的解压目录
  let dir = null;
  let appearedAt = null;
  while (el() < 40000) {
    const now = findExtractDirs().filter((d) => !before.has(d));
    if (now.length) { dir = now[0]; appearedAt = el(); break; }
    await sleep(50);
  }

  if (!dir) { console.log(`  第 ${i} 轮：★ 没看到解压目录`); continue; }

  // 监控目录增长，直到连续 1.5 秒体积不再变化（解压完成）
  let lastSize = -1;
  let stableSince = null;
  let doneAt = null;
  let peakMB = 0;
  while (el() < 60000) {
    const mb = dirSizeMB(dir);
    if (mb > peakMB) peakMB = mb;
    if (Math.abs(mb - lastSize) < 0.5) {
      if (stableSince === null) stableSince = el();
      else if (el() - stableSince > 1500) { doneAt = el(); break; }
    } else {
      stableSince = null;
    }
    lastSize = mb;
    await sleep(100);
  }

  console.log(`  第 ${i} 轮：解压目录出现 +${Math.round(appearedAt)}ms，` +
    `解压完成 +${Math.round(doneAt ?? el())}ms，体积 ${peakMB.toFixed(1)} MB`);

  await killAll();
  await sleep(1500);
}

await killAll();
