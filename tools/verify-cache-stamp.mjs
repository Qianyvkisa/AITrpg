// ---------------------------------------------------------------------------
// 便携版缓存机制的三项验证（开发用）
//
// 缓存一旦算错，后果比「启动慢」严重得多——用户机器会一直跑旧代码而毫无察觉。
// 所以这里不测「快不快」，只测三件必须有确定答案的事：
//
//   1. 指纹稳定：同一份源码重复计算，指纹必须完全一致
//   2. 指纹敏感：源码内容变一个字节，指纹必须变
//   3. 指纹纯净：运行时日志变化，指纹必须不变
//
// 用法：node tools/verify-cache-stamp.mjs
// 全部通过退出码 0，否则非 0
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nodeBin = process.execPath;

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`);
    pass++;
  } else {
    console.log(`  ✘ ${name}${detail ? '  ' + detail : ''}`);
    fail++;
  }
}

// 直接复用补丁脚本的指纹算法：调它一次，从输出里取指纹
function getStamp() {
  const out = execFileSync(nodeBin, [path.join(root, 'tools', 'patch-portable-nsi.mjs')], {
    cwd: root, encoding: 'utf8',
  });
  const m = out.match(/构建指纹\s+([0-9a-f]+)/);
  if (!m) throw new Error('没能从补丁脚本输出里取到指纹：' + out);
  return m[1];
}

console.log('=== 1. 指纹稳定性 ===');
const s1 = getStamp();
const s2 = getStamp();
check('连续两次计算一致', s1 === s2, `${s1} / ${s2}`);

console.log('\n=== 2. 指纹对源码敏感 ===');
// 挑一个确实会被打进 asar 的源码文件做扰动，避免误判
const probe = path.join(root, 'electron', 'config.js');
if (!fs.existsSync(probe)) {
  check('探测文件存在', false, probe);
} else {
  const original = fs.readFileSync(probe);
  const backup = original.toString('base64');
  try {
    // 只改一个字节，模拟最小改动
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = mutated[mutated.length - 1] ^ 0x01;
    fs.writeFileSync(probe, mutated);
    const s3 = getStamp();
    check('改一个字节后指纹变化', s3 !== s1, `${s1} -> ${s3}`);
  } finally {
    // 无论成败都必须还原，否则会把源码改坏
    fs.writeFileSync(probe, Buffer.from(backup, 'base64'));
  }
  const restored = fs.readFileSync(probe);
  check('源码已完整还原', restored.equals(original));
  const s4 = getStamp();
  check('还原后指纹回到原值', s4 === s1, `${s4}`);
}

console.log('\n=== 3. 指纹不受运行时日志影响 ===');
const logFile = path.join(root, 'electron', 'coc-keeper-crash.log');
if (fs.existsSync(logFile)) {
  const before = fs.readFileSync(logFile);
  const s5 = getStamp();
  fs.appendFileSync(logFile, `[stamp-test] ${Date.now()}\n`);
  const s6 = getStamp();
  check('日志追加后指纹不变', s5 === s6, `${s5} / ${s6}`);
  // 日志是运行时产物，追加的内容留着无妨，但这里仍还原成干净状态
  fs.writeFileSync(logFile, before);
} else {
  console.log('  - 没有日志文件，跳过');
}

console.log('\n=== 结果 ===');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
