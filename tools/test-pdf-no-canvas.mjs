// ---------------------------------------------------------------------------
// 验证：pdf-parse 在没有 @napi-rs/canvas 时能否正常提取文字
//
// 背景：@napi-rs/canvas 占 35MB（skia 图形库 + icudtl），被 pdf-parse 作为
// 依赖带进包里。但我们的用途只有「抽取 PDF 文字层」这一件事，不需要渲染。
// pdf-parse 内部用 try/catch 包住 canvas 加载，缺了只警告「渲染可能损坏」。
//
// 本脚本临时把 canvas 目录改名，跑一次真实 PDF 提取，再改回来。
// 这样能确定排除它是否安全，而不是靠猜。
//
// 用法：node tools/test-pdf-no-canvas.mjs
// ---------------------------------------------------------------------------

import { readFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canvasDir = join(root, 'node_modules', '@napi-rs');
const parked = join(root, 'node_modules', '@napi-rs.parked');
const pdfPath = join(root, 'assets', 'coc-kp.pdf');

if (!existsSync(pdfPath)) {
  console.error('找不到 assets/coc-kp.pdf，无法测试');
  process.exit(1);
}

async function tryExtract(label) {
  // 用 createRequire 走 CommonJS 解析，避免 ESM 的包名严格校验；
  // 每次清掉缓存，确保「移走 canvas 后」真的重新加载
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const entry = req.resolve('pdf-parse');
  delete req.cache[entry];
  const { PDFParse } = req('pdf-parse');
  const parser = new PDFParse({ data: readFileSync(pdfPath) });
  try {
    const r = await parser.getText();
    const text = String(r?.text || '');
    const chars = text.replace(/\s/g, '').length;
    console.log(`  ${label}: 提取 ${text.length} 字符（去空白 ${chars}），前 60 字：`);
    console.log(`    ${JSON.stringify(text.slice(0, 60))}`);
    return chars;
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

console.log('=== 1) 有 canvas（当前状态）===');
const withCanvas = await tryExtract('带 canvas');

// 临时移走 canvas
let moved = false;
if (existsSync(canvasDir)) {
  renameSync(canvasDir, parked);
  moved = true;
  console.log('\n=== 2) 无 canvas（临时移走 @napi-rs）===');
} else {
  console.log('\n=== 2) @napi-rs 本来就不存在 ===');
}

let withoutCanvas = 0;
try {
  withoutCanvas = await tryExtract('无 canvas');
} catch (e) {
  console.log('  ★ 提取失败: ' + e.message);
} finally {
  if (moved) renameSync(parked, canvasDir);
}

console.log('\n=== 结论 ===');
if (withoutCanvas > 0 && Math.abs(withoutCanvas - withCanvas) < 50) {
  console.log(`可以安全排除 @napi-rs/canvas：文字提取结果基本一致（${withCanvas} vs ${withoutCanvas}）`);
} else if (withoutCanvas > 0) {
  console.log(`文字仍能提取，但数量有差异（${withCanvas} vs ${withoutCanvas}），需要人工确认`);
} else {
  console.log('★ 不能排除：无 canvas 时提取失败');
}
