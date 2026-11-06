// ---------------------------------------------------------------------------
// 规则书阅读器逻辑
//
// 渲染方式：用 pdfjs 自己画到 canvas，不再用 iframe 套 Chromium 内置阅读器。
//
// 为什么换掉内置阅读器：
//   内置阅读器（PDFium）只认 URL 上的 #page=N 锚点，而改 iframe 的 src 是
//   "重新导航"，PDF 已加载过时 Chromium 不会真的跳到新页——表现就是点了目录
//   右侧纹丝不动。它内部状态我们拿不到，也改不了。
//   pdfjs 是自己算页面、自己画，跳到第几页完全由我们决定，还能精确知道
//   "这一页画完了没有"，可以给出真实的载入反馈。
//
// 中文 PDF 的两个必要条件（少一个就会画出空白或方块）：
//   1) cMapUrl    —— 预定义编码表，中文 CID 字体靠它把字符映射到字形
//   2) standardFontDataUrl —— 14 种标准字体的替代数据
//   两者都在 src/vendor/ 下随应用一起打包。
// ---------------------------------------------------------------------------
import { RULE_BOOK_PAGES, RULE_BOOK_TOTAL } from './core/ruleBookIndex.js';

const $ = (id) => document.getElementById(id);

const tree = $('rbTree');
const search = $('rbSearch');
const searchClear = $('rbSearchClear');
const viewer = $('rbViewer');
const status = $('rbStatus');
const pageInput = $('rbPageInput');
const crumb = $('rbCrumb');
const count = $('rbCount');
const prevBtn = $('rbPrev');
const nextBtn = $('rbNext');
const externalBtn = $('rbExternal');

let pdfDoc = null;        // pdfjs 文档对象
let current = 1;          // 当前页（1 起）
let rendering = false;    // 正在渲染，避免连续点击造成并发绘制
let pending = null;       // 渲染期间又有新的跳页请求，记下来等这次画完再执行
let zoom = 1;             // 缩放倍数
let baseViewport = null;  // 当前页 scale=1 时的尺寸

// 渲染队列：pdfjs 不允许同一 canvas 同时渲染两次，这里串行化
let chain = Promise.resolve();

// ---------------------------------------------------------------------------
// 章节树
// ---------------------------------------------------------------------------

/** 按关键词过滤（不区分大小写，匹配标题即可） */
function filterPages(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return RULE_BOOK_PAGES;
  return RULE_BOOK_PAGES.filter(([title]) => title.toLowerCase().includes(q));
}

/** 转义 HTML，避免章节标题里的尖括号被当成标签 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 把命中的关键词包成 <mark> */
function highlight(title, query) {
  const safe = esc(title);
  const q = (query || '').trim();
  if (!q) return safe;
  const safeQ = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(safeQ, 'gi'), (m) => `<mark>${m}</mark>`);
  } catch {
    return safe;
  }
}

function renderTree(query = '') {
  const items = filterPages(query);
  count.textContent = query
    ? `${items.length} / ${RULE_BOOK_PAGES.length} 条`
    : `${RULE_BOOK_PAGES.length} 条`;

  if (!items.length) {
    tree.innerHTML = `<div class="rb-empty">没有匹配「${esc(query)}」的章节</div>`;
    return;
  }

  tree.innerHTML = items
    .map(([title, page, depth]) => `
      <button class="rb-item d${depth}" data-page="${page}" data-title="${esc(title)}"
              title="${esc(title)} · 第 ${page} 页">
        <span class="rb-item-title">${highlight(title, query)}</span>
        <span class="rb-item-page">${page}</span>
      </button>`)
    .join('');

  tree.querySelectorAll('.rb-item').forEach((btn) => {
    btn.onclick = () => goToPage(Number(btn.dataset.page), btn.dataset.title, btn);
  });
  markActive();
}

/** 标出当前页对应的章节条目 */
function markActive() {
  const items = tree.querySelectorAll('.rb-item');
  let best = null;
  for (const btn of items) {
    const p = Number(btn.dataset.page);
    btn.classList.toggle('active', p === current);
    if (p <= current) best = btn;
  }
  const active = tree.querySelector('.rb-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
  return best;
}

/** 找到覆盖某页的最近一级章节标题，用于面包屑 */
function titleForPage(page) {
  let t = '';
  for (const [title, p, depth] of RULE_BOOK_PAGES) {
    if (depth === 0 && p <= page) t = title;
  }
  return t;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 更新工具栏上的页码/按钮状态 */
function syncToolbar(target, title, fromBtn) {
  pageInput.value = String(target);
  prevBtn.disabled = target <= 1;
  nextBtn.disabled = target >= RULE_BOOK_TOTAL;
  crumb.textContent = title || titleForPage(target);

  if (fromBtn) {
    tree.querySelectorAll('.rb-item').forEach((b) => b.classList.remove('active'));
    fromBtn.classList.add('active');
  } else {
    markActive();
  }
}

/** 让画布尺寸跟随容器宽度，保证页面铺满又不溢出 */
function fitZoom() {
  if (!baseViewport) return 1;
  const pad = 24;
  const avail = viewer.clientWidth - pad;
  const availH = viewer.clientHeight - pad;
  if (avail <= 0 || availH <= 0) return zoom;
  // 同时考虑宽高，取较小的缩放，避免页面被裁掉
  const z = Math.min(avail / baseViewport.width, availH / baseViewport.height);
  return Math.max(0.4, Math.min(z, 3));
}

/** 真正把某一页画到 canvas 上 */
async function drawPage(target) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(target);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // 以容器尺寸计算缩放，并叠加设备像素比，保证高分屏下文字清晰
  const vp1 = page.getViewport({ scale: 1 });
  baseViewport = { width: vp1.width, height: vp1.height };

  const cssZoom = fitZoom() * zoom;
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: cssZoom * dpr });

  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  // CSS 尺寸与逻辑尺寸一致，画布内部分辨率才是 dpr 倍
  canvas.style.width = Math.floor(vp.width / dpr) + 'px';
  canvas.style.height = Math.floor(vp.height / dpr) + 'px';

  // 先铺白底：PDF 页面本身是透明的，不铺白底会看到黑背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  // 换页时整块替换，避免旧页面残留
  viewer.innerHTML = '';
  viewer.appendChild(canvas);
  viewer.scrollTop = 0;

  page.cleanup();

  // 对外暴露"这一页确实画完了"的信号。
  // 界面本身不读它，但自动化验证要靠它判断渲染是否结束——
  // 只看画布存在不够（画布在渲染前就建好了）。
  window.__rbRendered = { page: target, done: true, at: Date.now() };
}

/**
 * 跳到指定页。
 * 用 promise 链串行，保证同一时刻只有一个渲染在跑；
 * 若渲染期间用户又点了别的章节，只保留最后一次请求（跳过中间页）。
 */
function goToPage(page, title, fromBtn) {
  const target = Math.max(1, Math.min(Number(page) || 1, RULE_BOOK_TOTAL));
  current = target;
  syncToolbar(target, title, fromBtn);

  if (!pdfDoc) return;

  if (rendering) {
    // 正在画：记下最新目标，等这次结束后直接画它
    pending = target;
    return;
  }

  rendering = true;
  window.__rbRendered = null;
  chain = chain.then(async () => {
    try {
      status.hidden = false;
      status.textContent = `正在载入第 ${target} 页…`;
      await drawPage(target);
      status.hidden = true;
    } catch (e) {
      status.hidden = false;
      status.innerHTML = `<div class="rb-error"><p>第 ${target} 页渲染失败：${esc(e.message)}</p>
        <p class="rb-error-hint">可点右上角「系统打开」用默认阅读器查看。</p></div>`;
    } finally {
      rendering = false;
      // 渲染期间积压的请求：只执行最后一个
      if (pending !== null && pending !== target) {
        const next = pending;
        pending = null;
        goToPage(next);
      } else {
        pending = null;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  pageInput.max = String(RULE_BOOK_TOTAL);
  const totalEl = document.querySelector('.rb-total');
  if (totalEl) totalEl.textContent = `/ ${RULE_BOOK_TOTAL}`;

  renderTree('');

  search.oninput = () => {
    searchClear.hidden = !search.value;
    renderTree(search.value);
  };
  searchClear.onclick = () => {
    search.value = '';
    searchClear.hidden = true;
    renderTree('');
    search.focus();
  };
  searchClear.hidden = true;

  pageInput.onchange = () => goToPage(pageInput.value);
  prevBtn.onclick = () => goToPage(current - 1);
  nextBtn.onclick = () => goToPage(current + 1);

  // 键盘翻页（焦点在搜索框/页码框时不拦截，否则没法打字）
  document.addEventListener('keydown', (e) => {
    if (e.target === search || e.target === pageInput) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goToPage(current - 1); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goToPage(current + 1); }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(zoom + 0.15); }
    if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.15); }
  });

  externalBtn.onclick = async () => {
    if (!window.api || !window.api.openRuleBookExternal) return;
    const r = await window.api.openRuleBookExternal();
    if (!r || !r.ok) alert('打不开规则书：' + ((r && r.error) || '未知原因'));
  };

  // 窗口尺寸变化时重排当前页（防抖，避免拖动窗口时疯狂重绘）
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // 重绘当前页，保持所在位置
      rendering = false;
      pending = null;
      goToPage(current, crumb.textContent);
    }, 200);
  });

  try {
    if (!window.api || !window.api.getRuleBookBase64) {
      throw new Error('这个环境里没有 Electron 接口（预览页？）');
    }

    status.hidden = false;
    status.textContent = '正在载入规则书…';

    const b64 = await window.api.getRuleBookBase64();
    if (!b64 || !b64.ok) throw new Error((b64 && b64.error) || '无法读取规则书');

    // base64 → 字节流（pdfjs 要的是字节，不是字符串）
    const bin = atob(b64.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

    pdfDoc = await pdfjs.getDocument({
      data: bytes,
      // 中文 PDF 的关键两项，缺了会画成空白
      cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href
    }).promise;

    goToPage(1);
  } catch (e) {
    status.hidden = false;
    status.innerHTML = `<div class="rb-error">
      <p>规则书载入失败：${esc(e.message)}</p>
      <p class="rb-error-hint">文件应在 assets/coc-kp.pdf。若你拿到的是安装版，可能被安全软件拦截。</p>
    </div>`;
  }
}

/** 缩放：改倍数后重绘当前页 */
function setZoom(z) {
  const next = Math.max(0.5, Math.min(Number(z) || 1, 3));
  if (Math.abs(next - zoom) < 0.01) return;
  zoom = next;
  goToPage(current, crumb.textContent);
}

init();
