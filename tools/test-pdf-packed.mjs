// ---------------------------------------------------------------------------
// 验证打包产物里的 PDF 文字提取（裁剪后）
//
// 前两个验证脚本跑的是开发目录 node_modules，测不出「打包后 asar 里」
// 到底有没有缺文件。这个脚本直接加载 dist 里 app.asar 内的 materials 模块，
// 用真实 PDF 走一遍提取，确保裁剪没打断打包产物。
//
// 用法：node tools/test-pdf-packed.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packed = join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const pdfPath = join(root, 'assets', 'coc-kp.pdf');

console.log('asar 存在: ' + existsSync(packed));
console.log('PDF 存在: ' + existsSync(pdfPath));

if (!existsSync(packed)) { console.error('★ 没打包产物'); process.exit(1); }

// Electron 的 asar 支持由 @electron/asar 提供读取能力；
// 在纯 node 下直接 require 进 asar 会失败，所以这里改用 asar 解包到临时目录验证。
const { extractAll } = await import('@electron/asar');
const tmp = join(root, 'dist', '_asar_check');
try { extractAll(packed, tmp); } catch (e) { console.error('★ 解包失败: ' + e.message); process.exit(1); }

const req = createRequire(join(tmp, 'noop.js'));
const { readPdf } = req(join(tmp, 'electron', 'materials.js'));

const r = await readPdf(pdfPath);
if (!r || !r.ok) {
  console.log('★ 提取失败: ' + (r && r.error));
  process.exit(1);
}
const chars = String(r.text).replace(/\s/g, '').length;
console.log('提取成功: ' + String(r.text).length + ' 字符（去空白 ' + chars + '）');
console.log('前 50 字: ' + JSON.stringify(String(r.text).slice(0, 50)));

// 检查关键资源是否进了包
for (const p of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs',
                 'node_modules/pdfjs-dist/cmaps',
                 'node_modules/pdfjs-dist/standard_fonts',
                 'node_modules/@napi-rs']) {
  console.log((existsSync(join(tmp, p)) ? '  有  ' : '  无  ') + p);
}

console.log('');
console.log(chars > 500000 ? '=== 通过：打包产物里 PDF 提取正常 ===' : '=== ★ 提取字符数异常 ===');
