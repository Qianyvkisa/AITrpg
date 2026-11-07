// ---------------------------------------------------------------------------
// 打包前把 build/portable.nsi 覆盖到 electron-builder 的模板目录
//
// 为什么需要「覆盖」这种手段：
//   electron-builder 的 portable 目标在 NsisTarget.js 里写死了
//   path.join(nsisTemplatesDir, "portable.nsi")，没有 customScript 入口
//   （只有 installer 目标支持 nsis.script）。要定制启动器，只能落到这个文件上。
//
// 这个脚本做三件事：
//   1) 找到 app-builder-lib 实际被解析到的模板目录（pnpm 下路径带 hash，不能写死）
//   2) 备份原模板一次（.orig），便于回滚和对照
//   3) 把 @@CACHE_STAMP@@ 替换成「源码内容指纹」再写入，并校验结果
//
// 为什么需要指纹而不是只用版本号：
//   缓存命中后启动器直接跑缓存目录里的旧程序。
//   如果只按版本号判断，改了代码但没升版本时，用户机器上会一直跑旧代码，
//   而且完全无感——这是比启动慢严重得多的问题。
//   指纹取自「会被打进 exe 的所有源码 + package.json 版本」，任何实质改动都会让它变化。
//
// 用法：node tools/patch-portable-nsi.mjs
// 幂等：同一份源码重复执行得到同一个指纹
// ---------------------------------------------------------------------------

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SRC = path.join(root, 'build', 'portable.nsi');

function fail(msg) {
  console.error('[patch-portable-nsi] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SRC)) fail(`找不到自定义模板：${SRC}`);

// ---------------------------------------------------------------------------
// 计算构建指纹
// 覆盖 package.json 里 build.files 会打进去的源码目录，外加版本号。
// 用「路径 + 内容」逐个喂给哈希，保证只改文件内容或增删文件都能反映出来。
// ---------------------------------------------------------------------------
function computeStamp() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const hash = crypto.createHash('sha256');
  hash.update('version:' + pkg.version + '\n');

  // 这些目录/文件会被打进 app.asar，改动它们就必须让缓存失效
  const targets = [
    'main.js',
    'preload.js',
    'package.json',
  ];
  const dirs = [
    'electron',
    'src',
    'assets',
  ];

  const files = [];
  for (const t of targets) {
    const p = path.join(root, t);
    if (fs.existsSync(p)) files.push(p);
  }
  for (const d of dirs) {
    const base = path.join(root, d);
    if (!fs.existsSync(base)) continue;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(base);
  }

  // 排除「运行时产物」：它们不属于源码，且每次运行都会变。
  // 典型例子是 electron/coc-keeper-crash.log——它每次启动都会追加内容，
  // 若算进指纹，每启动一次指纹就变一次，缓存永远无法命中，
  // 启动又会退回每次都解压 10 秒。
  // 规则：只要是不会被打进 asar 的日志/临时文件，就不该参与指纹。
  const EXCLUDE = [
    /\.log$/i,
    /\.tmp$/i,
    /\.bak$/i,
    /\.orig$/i,
  ];

  const counted = files.filter((f) => !EXCLUDE.some((re) => re.test(f)));
  const skipped = files.filter((f) => EXCLUDE.some((re) => re.test(f)));

  counted.sort();
  for (const f of counted) {
    hash.update(path.relative(root, f).replace(/\\/g, '/') + '\n');
    hash.update(fs.readFileSync(f));
    hash.update('\n');
  }

  // 取前 12 位十六进制足够区分，也短到能写进文件
  const stamp = hash.digest('hex').slice(0, 12);
  return { stamp, counted: counted.length, skipped };
}

const stampInfo = computeStamp();
const stamp = stampInfo.stamp;

// 通过 require.resolve 拿真实路径，pnpm 的 .pnpm 目录名带 hash，不能硬编码
let templatesDir;
try {
  const nsisUtil = require.resolve('app-builder-lib/out/targets/nsis/nsisUtil.js');
  const pkgRoot = nsisUtil.slice(0, nsisUtil.indexOf(`${path.sep}out${path.sep}`));
  templatesDir = path.join(pkgRoot, 'templates', 'nsis');
} catch (e) {
  fail('解析不到 app-builder-lib：' + e.message);
}

const target = path.join(templatesDir, 'portable.nsi');
if (!fs.existsSync(target)) fail(`模板目录里没有 portable.nsi：${target}`);

// 备份一次原始模板，之后重复打包不会把备份覆盖成我们的版本
const backup = target + '.orig';
if (!fs.existsSync(backup)) {
  fs.copyFileSync(target, backup);
  console.log('已备份原模板 -> ' + backup);
}

const content = fs.readFileSync(SRC, 'utf8').replaceAll('@@CACHE_STAMP@@', stamp);
if (content.includes('@@CACHE_STAMP@@')) fail('占位符替换不完整');

fs.writeFileSync(target, content, 'utf8');

// 校验：确认写进去的确实是我们的版本（防止路径算错、写到了别处）
const written = fs.readFileSync(target, 'utf8');
if (!written.includes('.unpack-stamp')) fail('覆盖后内容不符合预期，模板可能没被正确替换');
if (written.includes('@@CACHE_STAMP@@')) fail('写入的模板仍含未替换的占位符');

console.log('已应用自定义便携版模板：');
console.log('  源       ' + SRC);
console.log('  目标     ' + target);
console.log('  构建指纹 ' + stamp + `（参与计算的源码文件 ${stampInfo.counted} 个）`);
if (stampInfo.skipped.length) {
  console.log('  已排除运行时文件 ' + stampInfo.skipped.length + ' 个（日志/临时文件不参与指纹）');
}
