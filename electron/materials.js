'use strict';

// ---------------------------------------------------------------------------
// 模组素材解析：把「一个文件夹」变成可供 AI 理解的结构化材料
//
// 支持：
//   文本  .txt .md .markdown .json .html .csv
//   Word  .docx（含 .doc 的提示：老格式无法直接读）
//   PDF   .pdf（抽取文字层；扫描件无文字层时如实标注）
//   图片  .png .jpg .jpeg .webp .gif .bmp
//   其他  跳过并记录
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');

/** 各类扩展名归类 */
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
const HTML_EXT = new Set(['.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const PDF_EXT = new Set(['.pdf']);
const DOCX_EXT = new Set(['.docx']);

/** 单个文件最多抽多少字，避免超长模组撑爆上下文 */
const MAX_CHARS_PER_FILE = 20000;
/** 整个文件夹最多抽多少字 */
const MAX_CHARS_TOTAL = 60000;
/** 单个图片最大字节数（超出则不入包，仅记录） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 最多读取多少张图片 */
const MAX_IMAGES = 12;
/**
 * 所有图片加起来的原始字节上限。
 * 12 张 8MB 的图 base64 后接近 128MB，多数 API 会直接拒绝请求，
 * 所以再设一道总量闸门，超了就停止收图。
 */
const MAX_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;
/** 扫描时最多下钻多少层，防止误选整个磁盘（模组常见 素材/章节/子章节 多层嵌套） */
const MAX_DEPTH = 12;

function extOf(p) {
  return path.extname(p).toLowerCase();
}

/** 去掉 XML 里的标签，保留可读文字；<w:br/> 与段落结束转换行 */
function stripXml(xml) {
  let s = String(xml);
  s = s.replace(/<w:br\s*\/?>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<w:tab\s*\/?>/g, '\t');
  // 去注释与声明
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<[^>]+>/g, '');
  // 还原常用实体
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // 清掉 Word 域代码残留（目录、超链接、交叉引用）。
  // 这些是 <w:fldSimple>/<w:instrText> 里的指令，剥掉标签后会变成
  // `TOC \o "1-2" \h \u  HYPERLINK \l _Toc5459 前言  PAGEREF _Toc5459 \h 1`
  // 这类满屏反斜杠的噪音：既占字数，又会让模型写 JSON 时漏转义。
  s = cleanWordFields(s);
  // 折叠多余空行
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 清理 Word 域代码残留，保留人类可读的标题文字。
 *
 * 例：`HYPERLINK \l _Toc5459 前言	 PAGEREF _Toc5459 \h 1` → `前言`
 */
function cleanWordFields(text) {
  let s = String(text);

  // TOC 域开关本身（`TOC \o "1-2" \h \u`）整段丢弃
  s = s.replace(/TOC\s*\\o[\s\S]{0,40}?\\u/g, '');

  // HYPERLINK 指向书签：只保留后面的显示文字
  // `HYPERLINK \l _Toc1234 前言  PAGEREF _Toc1234 \h 1` → `前言 1`（页码有用，留着）
  s = s.replace(/HYPERLINK\s*\\l\s*_\w+\s*/g, '');
  s = s.replace(/PAGEREF\s*_\w+\s*\\h\s*/g, '');
  // 其他形式的 HYPERLINK（外部链接）
  s = s.replace(/HYPERLINK\s*"[^"]*"\s*/g, '');
  // 交叉引用 / 页码引用残留
  s = s.replace(/PAGEREF\s*_\w+\s*/g, '');
  // 书签定义
  s = s.replace(/_Toc\d+/g, '');
  // 兜底：剩下的裸域开关（\o \h \u \l \* 等）
  s = s.replace(/\s*\\[a-z*]\s*/gi, ' ');
  // 清掉指令残留后可能出现的孤立花括号域语法
  s = s.replace(/[{}]/g, '');

  // 收拾清理后的空白：多个空格合一，行首行尾去空
  s = s.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

/**
 * 解析 .docx：本质是 zip，正文在 word/document.xml。
 * 用 fflate 解压，不引入 mammoth 之类的大依赖。
 */
function readDocx(p) {
  const buf = fs.readFileSync(p);
  const files = unzipSync(new Uint8Array(buf));

  const docEntry = files['word/document.xml'];
  if (!docEntry) return { ok: false, error: '不是有效的 docx（缺少 word/document.xml）' };

  let text = stripXml(strFromU8(docEntry));

  // 有些文档正文在页眉页脚或脚注里，顺带拼上（有则加）
  const extras = ['word/footnotes.xml', 'word/endnotes.xml'];
  for (const name of extras) {
    if (files[name]) {
      const t = stripXml(strFromU8(files[name]));
      if (t) text += '\n\n' + t;
    }
  }

  return { ok: true, text };
}

/** 解析 PDF：抽取文字层 */
async function readPdf(p) {
  let PDFParse;
  try {
    ({ PDFParse } = require('pdf-parse'));
  } catch (e) {
    return { ok: false, error: '缺少 pdf 解析库' };
  }

  let parser;
  try {
    parser = new PDFParse({ data: fs.readFileSync(p) });
    const r = await parser.getText();
    let text = String(r?.text || '');
    // pdf-parse 会在每页后插入 "-- N of M --" 分隔，去掉更干净
    text = text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, '').trim();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await parser?.destroy(); } catch (_) { /* ignore */ }
  }
}

/** HTML 转纯文本（够用即可，不追求完美） */
function readHtml(p) {
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 判断图片类型（按文件头，不信扩展名） */
function sniffImage(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

/**
 * 递归扫描文件夹。
 * @param {string} root
 * @returns {Array<{abs, rel, ext, size}>}
 */
function scanFolder(root, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }

  for (const ent of entries) {
    // 跳过隐藏文件与常见垃圾目录
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__MACOSX') continue;

    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      scanFolder(abs, depth + 1, out);
      continue;
    }
    if (!ent.isFile()) continue;

    let size = 0;
    try { size = fs.statSync(abs).size; } catch (_) { continue; }
    out.push({ abs, rel: path.relative(root, abs), ext: extOf(abs), size });
  }

  return out;
}

/**
 * 读取整个文件夹，产出：
 *   docs  —— 可读的文字材料（含来源文件名）
 *   images —— 图片（base64，供视觉模型）
 *   skipped —— 跳过的文件与原因
 *
 * @param {string} folder
 * @param {{onProgress?: (msg:string)=>void}} opts
 */
async function readFolder(folder, opts = {}) {
  const files = scanFolder(folder);
  const docs = [];
  const images = [];
  const skipped = [];
  let totalChars = 0;
  let totalImageBytes = 0;

  // 先文字，后图片，让文字优先占满预算
  const order = [...files].sort((a, b) => {
    const rank = (f) => {
      if (DOCX_EXT.has(f.ext) || PDF_EXT.has(f.ext)) return 0;
      if (TEXT_EXT.has(f.ext) || HTML_EXT.has(f.ext)) return 1;
      if (IMAGE_EXT.has(f.ext)) return 2;
      return 3;
    };
    return rank(a) - rank(b);
  });

  for (const f of order) {
    opts.onProgress?.(f.rel);

    // 注意：这里先存全文（full），判重时要用完整内容比对；
    // 截断留到 dedupeDocs 之后统一做，否则两份同源文档会被截成不同长度，判重失效。
    // ---- Word ----
    if (DOCX_EXT.has(f.ext)) {
      const r = readDocx(f.abs);
      if (!r.ok) { skipped.push({ rel: f.rel, reason: r.error }); continue; }
      if (!r.text) { skipped.push({ rel: f.rel, reason: '文档没有文字内容' }); continue; }
      docs.push({ rel: f.rel, kind: 'word', text: r.text, full: r.text });
      continue;
    }

    // 老式 .doc：二进制格式，不引入重型依赖，如实告知
    if (f.ext === '.doc') {
      skipped.push({ rel: f.rel, reason: '老式 .doc 格式无法直接读取，请另存为 .docx' });
      continue;
    }

    // ---- PDF ----
    if (PDF_EXT.has(f.ext)) {
      const r = await readPdf(f.abs);
      if (!r.ok) { skipped.push({ rel: f.rel, reason: `PDF 解析失败：${r.error}` }); continue; }
      if (!r.text) {
        skipped.push({
          rel: f.rel,
          reason: 'PDF 没有可提取的文字（可能是扫描件/纯图片），建议截图后作为图片导入'
        });
        continue;
      }
      docs.push({ rel: f.rel, kind: 'pdf', text: r.text, full: r.text });
      continue;
    }

    // ---- 纯文本 ----
    if (TEXT_EXT.has(f.ext)) {
      let text = '';
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch (e) {
        skipped.push({ rel: f.rel, reason: `读取失败：${e.message}` });
        continue;
      }
      if (!text.trim()) { skipped.push({ rel: f.rel, reason: '空文件' }); continue; }
      docs.push({ rel: f.rel, kind: 'text', text, full: text });
      continue;
    }

    // ---- HTML ----
    if (HTML_EXT.has(f.ext)) {
      const text = readHtml(f.abs);
      if (!text) { skipped.push({ rel: f.rel, reason: '空文件' }); continue; }
      docs.push({ rel: f.rel, kind: 'html', text, full: text });
      continue;
    }

    // ---- 图片 ----
    if (IMAGE_EXT.has(f.ext)) {
      if (images.length >= MAX_IMAGES) {
        skipped.push({ rel: f.rel, reason: `图片数量超过上限（${MAX_IMAGES} 张）` });
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        skipped.push({ rel: f.rel, reason: `图片过大（${(f.size / 1024 / 1024).toFixed(1)} MB）` });
        continue;
      }
      if (totalImageBytes + f.size > MAX_IMAGE_TOTAL_BYTES) {
        skipped.push({ rel: f.rel, reason: `图片总量超过上限（${(MAX_IMAGE_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB）` });
        continue;
      }
      let buf;
      try { buf = fs.readFileSync(f.abs); } catch (e) {
        skipped.push({ rel: f.rel, reason: `读取失败：${e.message}` });
        continue;
      }
      const mime = sniffImage(buf);
      if (!mime) { skipped.push({ rel: f.rel, reason: '不是有效的图片文件' }); continue; }
      totalImageBytes += buf.length;
      images.push({
        rel: f.rel,
        mime: `image/${mime}`,
        bytes: buf.length,
        base64: buf.toString('base64')
      });
      continue;
    }

    skipped.push({ rel: f.rel, reason: '不支持的文件类型' });
  }

  // 去重：同一份模组常同时提供 docx 和 pdf（内容几乎一致），
  // 两份都塞给模型会白白吃掉一半预算，还可能把输出挤到截断。
  // 用全文（full）判重，避免截断造成的假差异。
  dedupeDocs(docs, skipped);

  // 单文件超长先各自截断
  for (const d of docs) {
    if (d.text.length > MAX_CHARS_PER_FILE) {
      d.text = d.text.slice(0, MAX_CHARS_PER_FILE) + '\n…（本文件过长已截断）';
    }
  }

  // 总字数超预算时按比例截断（保留靠前的文件，通常是主线文档）
  totalChars = docs.reduce((a, d) => a + d.text.length, 0);
  if (totalChars > MAX_CHARS_TOTAL) {
    let acc = 0;
    for (const d of docs) {
      if (acc >= MAX_CHARS_TOTAL) { d.text = ''; continue; }
      const room = MAX_CHARS_TOTAL - acc;
      if (d.text.length > room) d.text = d.text.slice(0, room) + '\n…（内容过长已截断）';
      acc += d.text.length;
    }
  }

  // 判重用的全文不再带出去，省内存
  for (const d of docs) delete d.full;

  return { folder, docs, images, skipped, files: files.length };
}

/**
 * 去掉内容重复的文档。
 *
 * 判重不靠文件名，也不靠「整段包含」——同一份模组的 docx 与 pdf 排版差异很大：
 * pdf 每页页眉都会重复插入标题/宣传语，还会带「第 N 页 共 M 页」，
 * 这些碎片会把连续文本打断，导致整段包含判断永远失败。
 *
 * 所以改成「分片重合率」：把正文切成若干小片，看短文档有多少比例的片段
 * 能在长文档里找到。同一份内容重合率会很高（通常 > 80%），
 * 不同模组则很低。
 *
 * 保留信息量更大（字数更多）的那一份；被去掉的记进 skipped 并说明原因。
 */
function dedupeDocs(docs, skipped) {
  const kept = [];

  for (const d of docs) {
    const source = d.full || d.text || '';
    if (!source.trim()) continue;

    const fp = fingerprint(source);
    if (fp.length < 200) { kept.push(d); continue; }   // 太短，谈不上重复

    let dupOf = null;
    for (const k of kept) {
      const kfp = fingerprint(k.full || k.text || '');
      if (kfp.length < 200) continue;
      if (overlapRatio(fp, kfp) >= 0.8) { dupOf = k; break; }
    }

    if (dupOf) {
      // 谁字多留谁
      const dupLen = fingerprint(dupOf.full || dupOf.text || '').length;
      if (fp.length > dupLen) {
        const idx = kept.indexOf(dupOf);
        kept[idx] = d;
        skipped.push({ rel: dupOf.rel, reason: `与 ${d.rel} 内容重复（保留字数更多的一份）` });
      } else {
        skipped.push({ rel: d.rel, reason: `与 ${dupOf.rel} 内容重复（已忽略）` });
      }
      continue;
    }

    kept.push(d);
  }

  docs.length = 0;
  docs.push(...kept);
}

/** 内容指纹：去掉标点、空白、页码与零宽字符，只留文字骨架 */
function fingerprint(text) {
  return String(text)
    .replace(/第\s*\d+\s*页\s*共\s*\d+\s*页/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 估算两份指纹的重合率：把较短那份切成等长小片，统计有多少片出现在较长那份里。
 * 分片比连续包含更能容忍排版差异（页眉重复、分页符、插入的宣传语）。
 *
 * @returns {number} 0~1
 */
function overlapRatio(a, b) {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  const PIECE = 60;                     // 每片字数
  const step = Math.max(PIECE, Math.floor(short.length / 60)); // 最多抽 60 片
  const pieces = [];
  for (let i = 0; i + PIECE <= short.length; i += step) {
    pieces.push(short.slice(i, i + PIECE));
  }
  if (!pieces.length) return 0;

  let hit = 0;
  for (const p of pieces) {
    if (long.includes(p)) hit++;
  }
  return hit / pieces.length;
}

/** 只导入单个文件（保持旧行为，但支持 docx/pdf） */
async function readSingleFile(p) {
  const ext = extOf(p);
  const rel = path.basename(p);

  if (DOCX_EXT.has(ext)) {
    const r = readDocx(p);
    return r.ok
      ? { docs: [{ rel, kind: 'word', text: r.text.slice(0, MAX_CHARS_PER_FILE) }], images: [], skipped: [] }
      : { docs: [], images: [], skipped: [{ rel, reason: r.error }] };
  }
  if (PDF_EXT.has(ext)) {
    const r = await readPdf(p);
    return r.ok
      ? { docs: [{ rel, kind: 'pdf', text: r.text.slice(0, MAX_CHARS_PER_FILE) }], images: [], skipped: [] }
      : { docs: [], images: [], skipped: [{ rel, reason: r.error }] };
  }
  if (TEXT_EXT.has(ext)) {
    const text = fs.readFileSync(p, 'utf8').slice(0, MAX_CHARS_PER_FILE);
    return { docs: [{ rel, kind: 'text', text }], images: [], skipped: [] };
  }
  if (HTML_EXT.has(ext)) {
    return { docs: [{ rel, kind: 'html', text: readHtml(p).slice(0, MAX_CHARS_PER_FILE) }], images: [], skipped: [] };
  }
  if (IMAGE_EXT.has(ext)) {
    const buf = fs.readFileSync(p);
    const mime = sniffImage(buf);
    return {
      docs: [],
      images: mime ? [{ rel, mime: `image/${mime}`, bytes: buf.length, base64: buf.toString('base64') }] : [],
      skipped: mime ? [] : [{ rel, reason: '不是有效的图片文件' }]
    };
  }
  return { docs: [], images: [], skipped: [{ rel, reason: '不支持的文件类型' }] };
}

/**
 * 把解析结果拼成给 AI 的素材文本（图片另行以视觉内容发送）。
 * @param {{docs, images, skipped}} parsed
 */
function materialsToPromptText(parsed, { maxChars = MAX_CHARS_TOTAL } = {}) {
  const parts = [];

  for (const d of parsed.docs || []) {
    if (!d.text) continue;
    parts.push(`### 文件：${d.rel}\n${d.text}`);
  }

  if ((parsed.images || []).length) {
    const list = parsed.images.map((i) => `- ${i.rel}（${i.mime}）`).join('\n');
    parts.push(`### 随附图片（共 ${parsed.images.length} 张，已作为图像一并提供，请结合画面理解）\n${list}`);
  }

  if ((parsed.skipped || []).length) {
    const list = parsed.skipped.map((s) => `- ${s.rel}：${s.reason}`).join('\n');
    parts.push(`### 未纳入的文件\n${list}`);
  }

  let text = parts.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（素材过长已截断）';
  return text;
}

module.exports = {
  readFolder,
  readSingleFile,
  readDocx,
  readPdf,
  readHtml,
  sniffImage,
  scanFolder,
  materialsToPromptText,
  stripXml,
  cleanWordFields,
  dedupeDocs,
  fingerprint,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_IMAGES,
  MAX_CHARS_TOTAL
};
