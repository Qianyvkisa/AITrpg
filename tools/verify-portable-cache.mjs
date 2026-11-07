// ---------------------------------------------------------------------------
// 便携版缓存机制端到端验证（开发用）
//
// 验证四件事，每件都有明确的通过/失败判据：
//   1. 首次启动：缓存目录被建立，戳文件内容 = 版本-指纹
//   2. 二次启动：走缓存，启动器阶段应 < 1 秒（对比首次 ~10 秒）
//   3. 戳不匹配：人为改坏戳，下次必须重新解压（保证升级时不会跑旧代码）
//   4. 程序运行中再双击：不能把正在运行的文件删坏
//
// 用法：node tools/verify-portable-cache.mjs
// 注意：会真实启动/关闭程序若干次
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = 'D:\\Tool\\AIrpg\\COC跑团.exe';
const localAppData = process.env.LOCALAPPDATA;
const cacheDir = path.join(localAppData, 'coc-keeper-ai-app');
const stampFile = path.join(cacheDir, '.unpack-stamp');
const startupLog = path.join(process.env.TEMP, 'coco-e2e.log');

let pass = 0, fail = 0;
// 期望的戳值：设了就等到戳被改写成这个值，用来验证「戳不匹配会重新解压」
let stampExpected = null;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`);
  cond ? pass++ : fail++;
}

function killAll() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*COC*' } | Stop-Process -Force"
  ], { stdio: 'ignore' });
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// 启动一次，返回「双击 → 可判定解压完成」的毫秒数
//
// 判据必须同时看 asar 和戳文件：
//   只看 asar 会在「缓存已存在」时立刻返回，把二次启动误测成首次；
//   而戳是在 asar 之后才写的，只看 asar 又会抢在戳之前读取，造成竞态。
async function launchAndTime(budgetMs = 40000) {
  try { fs.unlinkSync(startupLog); } catch {}
  const asar = path.join(cacheDir, 'resources', 'app.asar');
  const wantStamp = stampExpected || null;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 Electron 退化成纯 Node，窗口不出现
  env.COCO_STARTUP_LOG = startupLog;

  const t0 = process.hrtime.bigint();
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  child.unref();

  while (Number(process.hrtime.bigint() - t0) / 1e6 < budgetMs) {
    if (fs.existsSync(asar) && fs.existsSync(stampFile)) {
      const cur = fs.readFileSync(stampFile, 'utf8').trim();
      // 没有期望值时，只要求戳看起来合法；有期望值时要求完全一致
      const ok = wantStamp ? cur === wantStamp : /^[0-9.]+\-[0-9a-f]+$/.test(cur);
      if (ok) return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    await sleep(40);
  }
  return null;
}

function readSplashMs() {
  try {
    const m = fs.readFileSync(startupLog, 'utf8').match(/^\+?\s*(\d+)ms\s+splash 窗口已创建并显示/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// 等 splash 日志出现。
// 不能「测完时间就立刻读」：那时 Electron 可能刚被拉起，
// 窗口还没创建，日志自然还没写——之前就是这样误判成「动画未出现」。
async function waitSplash(budgetMs = 15000) {
  const t0 = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - t0) / 1e6 < budgetMs) {
    const v = readSplashMs();
    if (v !== null) return v;
    await sleep(80);
  }
  return null;
}

const main = async () => {
  killAll();
  rmrf(cacheDir);
  await sleep(600);

  console.log('=== 1. 首次启动（无缓存）===');
  const t1 = await launchAndTime();
  check('首次完成解压', t1 !== null, t1 === null ? '超时' : `+${t1}ms`);
  check('缓存目录已建立', fs.existsSync(path.join(cacheDir, 'resources', 'app.asar')));
  check('戳文件已写入', fs.existsSync(stampFile));
  const stamp1 = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  check('戳内容含版本与指纹', /^[0-9.]+\-[0-9a-f]+$/.test(stamp1), stamp1);
  const splash1 = await waitSplash();
  check('动画窗口出现', splash1 !== null, splash1 === null ? '未出现' : `进程启动后 +${splash1}ms`);

  killAll();
  await sleep(1200);

  console.log('\n=== 2. 二次启动（应走缓存）===');
  const t2 = await launchAndTime();
  check('二次启动明显更快', t2 !== null && t1 !== null && t2 < t1 / 3,
    t2 === null ? '超时' : `+${t2}ms（首次 +${t1}ms）`);
  const splash2 = await waitSplash();
  check('动画仍正常出现', splash2 !== null, splash2 === null ? '未出现' : `+${splash2}ms`);
  if (t2 !== null && splash2 !== null) {
    const total = t2 + splash2;
    check('双击到看见动画 < 1 秒', total < 1000, `≈${total}ms`);
  }

  killAll();
  await sleep(1200);

  console.log('\n=== 3. 戳不匹配时必须重新解压（防跑旧代码）===');
  fs.writeFileSync(stampFile, 'tampered-stamp-000', 'utf8');
  // 要求等到戳被重写回正确值，才能确认真的重新解压过
  stampExpected = stamp1;
  const t3 = await launchAndTime();
  stampExpected = null;
  check('戳被改坏后重新解压', t3 !== null && t2 !== null && t3 > t2 * 3,
    t3 === null ? '超时（说明没重写戳）' : `+${t3}ms（应接近首次的 +${t1}ms）`);
  const stamp3 = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  check('戳被重写为正确值', stamp3 === stamp1, `${stamp3}`);

  killAll();
  await sleep(1200);

  console.log('\n=== 4. 程序运行中再双击，不能删坏文件 ===');
  // 先正常启动并等它稳定
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const first = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  first.unref();
  await sleep(4000);

  // 此时缓存有效，第二次双击会走缓存路径，不应该动任何文件
  check('测试前缓存有效', fs.existsSync(stampFile));
  const before = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  const second = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  second.unref();
  await sleep(4000);

  const after = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  check('缓存未被破坏', after === before && after !== '', after);
  check('主程序文件仍在', fs.existsSync(path.join(cacheDir, 'COC跑团.exe')));

  killAll();
  await sleep(500);

  console.log('\n=== 结果 ===');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail === 0) console.log('  ✔ 缓存机制工作正常');
  else console.log('  ✘ 有项目未通过，见上面 ✘ 项');

  // 测完把缓存清掉，避免留下测试痕迹
  rmrf(cacheDir);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('验证脚本异常：' + e.stack);
  killAll();
  process.exit(1);
});
