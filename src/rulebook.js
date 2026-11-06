// ---------------------------------------------------------------------------
// 规则书阅读器逻辑
//
// 页面本身交给 Chromium 内置的 PDF 阅读器（PDFium），我们只负责：
//   1) 左侧章节树（来自 PDF 书签，176 条，可搜索）
//   2) 点击章节 → 让右侧 PDF 跳到对应页（通过 #page=N 锚点）
//
// 为什么不用 pdfjs 自己画：
//   pdfjs 渲染中文 PDF 需要额外配置 cMap 与字体资源，链路长、失败点分散；
//   而 PDFium 是 Chromium 自带的，中文支持成熟，还自带缩放/搜索/打印。
//   代价是页码跳转只能靠 URL 锚点，够用。
// ---------------------------------------------------------------------------
import { RULE_BOOK_PAGES, RULE_BOOK_TOTAL } from './core/ruleBookIndex.js';

const $ = (id) => document.getElementById(id);

const tree = $('rbTree');
const search = $('rbSearch');
const searchClear = $('rbSearchClear');
const frame = $('rbFrame');
const status = $('rbStatus');
const pageInput = $('rbPageInput');
const crumb = $('rbCrumb');
const count = $('rbCount');
const prevBtn = $('rbPrev');
const nextBtn = $('rbNext');
const externalBtn = $('rbExternal');

let pdfUrl = null;      // PDF 的 file:// URL
let current = 1;

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
}

/** 标出当前页对应的章节（可能有多个条目同页，取最后一个一级章节） */
function markActive() {
  let best = null;
  for (const btn of tree.querySelectorAll('.rb-item')) {
    const p = Number(btn.dataset.page);
    btn.classList.toggle('active', p === current);
    if (p <= current) best = btn;
  }
  // 滚到可见区域，但不要抢走用户正在滚动的视图
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
// 翻页
// ---------------------------------------------------------------------------

/**
 * 让 PDF 跳到指定页。
 * Chromium 的 PDF 阅读器认 URL 里的 #page=N 锚点；改 hash 不会重新加载整个文档，
 * 但为了确保生效，这里用整段 src 重设（PDF 已在缓存里，不会重新下载）。
 */
function goToPage(page, title, fromBtn) {
  const target = Math.max(1, Math.min(Number(page) || 1, RULE_BOOK_TOTAL));
  current = target;
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

  if (pdfUrl) {
    // toolbar=0 让内置工具栏尽量不抢空间；navpanes=0 关掉它自己的侧栏
    frame.src = `${pdfUrl}#page=${target}&toolbar=0&navpanes=0`;
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  // 页数上限由索引常量决定，不写死在 HTML 里，避免两处数字对不上
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
  });

  externalBtn.onclick = async () => {
    if (!window.api || !window.api.openRuleBookExternal) return;
    const r = await window.api.openRuleBookExternal();
    if (!r || !r.ok) alert('打不开规则书：' + ((r && r.error) || '未知原因'));
  };

  // 向主进程要 PDF 的真实路径
  try {
    if (!window.api || !window.api.getRuleBookPath) {
      throw new Error('这个环境里没有 Electron 接口（预览页？）');
    }
    const res = await window.api.getRuleBookPath();
    if (!res || !res.ok) throw new Error((res && res.error) || '无法定位规则书');
    pdfUrl = res.url;
    frame.onload = () => { status.hidden = true; };
    frame.onerror = () => {
      status.hidden = false;
      status.textContent = '规则书载入失败。可点右上角「系统打开」用默认阅读器查看。';
    };
    goToPage(1);
    // 兜底：万一 onload 没触发，别让"正在载入"一直挂着
    setTimeout(() => { status.hidden = true; }, 6000);
  } catch (e) {
    status.hidden = false;
    status.innerHTML = `<div class="rb-error">
      <p>规则书载入失败：${esc(e.message)}</p>
      <p class="rb-error-hint">文件应在 assets/coc-kp.pdf。若你拿到的是安装版，可能被安全软件拦截。</p>
    </div>`;
  }
}

init();
