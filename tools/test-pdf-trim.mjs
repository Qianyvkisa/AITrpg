// ---------------------------------------------------------------------------
// 验证：裁剪 pdfjs-dist 的 web/types/image_decoders/.map 后，
// PDF 文字提取是否仍然完好
//
// 背景：pdfjs-dist 34.7MB 里有一大块是给浏览器端用的（web/）、类型声明（types/）、
// 图片解码器（image_decoders/）和 source map。我们只在主进程抽文字，用不到这些。
//
// 做法：临时移走这些目录，跑一次真实提取，比对字符数，再移回来。
//
// 用法：node tools/test-pdf-trim.mjs
// ---------------------------------------------------------------------------

import { readFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pdfDir = join(root, 'node_modules', 'pdfjs-dist');
const pdfPath = join(root, 'assets', 'coc-kp.pdf');
const req = createRequire(import.meta.url);

if (!existsSync(pdfPath)) {
  console.error('找不到 assets/coc-kp.pdf');
  process.exit(1);
}

async function extract(label) {
  // 清缓存，确保重新加载
  for (const k of Object.keys(req.cache)) delete req.cache[k];
  const { PDFParse } = req('pdf-parse');
  const parser = new PDFParse({ data: readFileSync(pdfPath) });
  try {
    const r = await parser.getText();
    const text = String(r?.text || '');
    const chars = text.replace(/\s/g, '').length;
    console.log(`  ${label}: ${text.length} 字符（去空白 ${chars}）`);
    return chars;
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

console.log('=== 1) 完整 pdfjs-dist ===');
const full = await extract('完整');

// 移走可裁剪目录
const targets = ['web', 'types', 'image_decoders'];
const moved = [];
for (const t of targets) {
  const p = join(pdfDir, t);
  if (existsSync(p)) {
    renameSync(p, p + '.trimmed');
    moved.push(p);
  }
}

console.log('\n=== 2) 移走 ' + moved.map((p) => p.split(/[\\/]/).pop()).join(', ') + ' 后 ===');
let trimmed = 0;
try {
  trimmed = await extract('裁剪后');
} catch (e) {
  console.log('  ★ 提取失败: ' + e.message);
} finally {
  for (const p of moved) renameSync(p + '.trimmed', p);
}

console.log('\n=== 结论 ===');
if (trimmed === full && trimmed > 0) {
  console.log(`可以安全裁剪：结果完全一致（${full} 字符）`);
} else if (trimmed > 0) {
  console.log(`仍可提取但结果不同（${full} vs ${trimmed}），需人工确认`);
} else {
  console.log('★ 不能裁剪：提取失败');
}
