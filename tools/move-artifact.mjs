// ---------------------------------------------------------------------------
// 打包收尾：把 portable exe 从 dist\ 移到项目根目录，重命名为无版本号的名字
//
// 为什么不直接把 package.json 的 directories.output 改成根目录：
// electron-builder 打包前会清空 output 目录，output 指向项目根目录时
// 会把 src\、main.js、package.json 一起删掉。本项目没有 git 兜底，
// 一旦发生不可恢复。所以打包仍输出到 dist\，再由本脚本搬运。
//
// dist\win-unpacked\ 保留在原地：start.ps1 开发模式会用它里面的
// electron 二进制，搬走会让开发启动失效。
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import * as fsSync from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

function fail(msg) {
  console.error('\n[移动产物失败] ' + msg);
  process.exit(1);
}

if (!existsSync(distDir)) fail('dist 目录不存在，先跑打包');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;
const version = pkg.version;

// 候选文件名：优先无版本号（artifactName 固定后的形态），
// 其次带版本号（electron-builder 默认命名）
const candidates = [
  `${productName}.exe`,
  `${productName} ${version}.exe`
];

let src = null;
for (const name of candidates) {
  const p = join(distDir, name);
  if (existsSync(p)) { src = p; break; }
}

if (!src) {
  const found = readdirSync(distDir).filter((f) => f.toLowerCase().endsWith('.exe'));
  if (!found.length) fail('dist 里没有找到任何 exe，打包可能没成功');
  src = join(distDir, found[0]);
  console.log(`[提示] 没找到预期的文件名，改用 ${found[0]}`);
}

const dest = join(root, `${productName}.exe`);

// 目标被正在运行的程序占用时，Windows 会拒绝删除/覆盖。
// 注意：只读打开（readFileSync）不会被占用阻止，必须用读写独占方式探测，
// 否则这个预检形同虚设，最终只会抛出一个难懂的 EBUSY。
function isLocked(path) {
  try {
    const { openSync, closeSync } = fsSync;
    const fd = openSync(path, 'r+');
    closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

const sizeMB = (statSync(src).size / 1024 / 1024).toFixed(1);

try {
  if (existsSync(dest)) {
    if (isLocked(dest)) {
      fail(`根目录的 ${productName}.exe 正在运行，无法覆盖。\n  请先关闭正在运行的程序，再重新打包。`);
    }
    unlinkSync(dest);
  }
  renameSync(src, dest);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    fail(`根目录的 ${productName}.exe 正在运行，无法覆盖。\n  请先关闭正在运行的程序，再重新打包。`);
  }
  fail(`移动失败: ${e.message}`);
}

console.log(`\n[产物已就位] ${productName}.exe  (${sizeMB} MB)`);
console.log(`  位置: ${dest}`);
console.log(`  dist\\win-unpacked\\ 仍保留，供 start.ps1 开发模式使用`);
