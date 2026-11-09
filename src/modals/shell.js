// ---------------------------------------------------------------------------
// 通用弹窗容器：所有弹窗共用一套打开/关闭行为
// ---------------------------------------------------------------------------

/**
 * 打开一个弹窗。
 * @param html 弹窗内容（含 .modal 结构）
 * @returns { backdrop, close }
 */
export function openModal(html) {
  const root = document.querySelector('#modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = html;
  root.appendChild(backdrop);

  const close = () => backdrop.remove();

  // 关闭：点遮罩空白处或带 data-close 的按钮
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });

  return { backdrop, close };
}

/** 转义成 HTML 文本，避免用户内容破坏结构 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 输入框弹窗，用来替代 window.prompt。
 *
 * 为什么不能用 prompt：
 *   Electron 的渲染进程**不支持 window.prompt**，调用它会直接抛
 *   `Error: prompt() is and will not be supported.`。
 *   这个错误发生在 try/catch 之外时，表现就是「点了按钮完全没反应」——
 *   控制台有红字，界面上什么都没发生。角色卡编辑器的「AI 生成」按钮
 *   正是踩了这个坑（v0.2.0 及以前，这个按钮在打包版里从来没工作过）。
 *
 * 语义与 prompt 对齐：
 *   - 点「确定」返回输入框里的字符串（可以是空串）
 *   - 点「取消」/ 点遮罩 / 按 Esc 返回 null
 *
 * @param {object} opts
 * @param {string} [opts.title] 标题
 * @param {string} [opts.message] 说明文字（支持换行）
 * @param {string} [opts.placeholder] 输入框占位符
 * @param {string} [opts.value] 输入框初始值
 * @param {string} [opts.okText] 确定按钮文字
 * @param {string} [opts.cancelText] 取消按钮文字
 * @param {boolean} [opts.multiline] 用 textarea 而不是 input
 * @returns {Promise<string|null>}
 */
export function openPrompt(opts = {}) {
  const {
    title = '请输入',
    message = '',
    placeholder = '',
    value = '',
    okText = '确定',
    cancelText = '取消',
    multiline = false
  } = opts;

  return new Promise((resolve) => {
    // 说明文字里的换行要保留，所以按行拆成 <div>
    const msgHtml = message
      ? `<div class="prompt-msg">${String(message).split('\n').map((l) => esc(l)).join('<br>')}</div>`
      : '';

    const field = multiline
      ? `<textarea id="promptInput" class="prompt-input" rows="3" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input id="promptInput" class="prompt-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}">`;

    const { backdrop, close } = openModal(`
      <div class="modal narrow prompt-modal">
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          <button class="icon-btn" data-close>×</button>
        </div>
        <div class="modal-body">
          ${msgHtml}
          ${field}
        </div>
        <div class="modal-foot">
          <button class="btn ghost" id="promptCancel" data-cancel>${esc(cancelText)}</button>
          <button class="btn" id="promptOk" data-ok>${esc(okText)}</button>
        </div>
      </div>
    `);

    const input = backdrop.querySelector('#promptInput');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      close();
      resolve(result);
    };

    // 点遮罩 / 点 × 都算取消
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    backdrop.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => finish(null);
    });

    backdrop.querySelector('#promptCancel').onclick = () => finish(null);
    backdrop.querySelector('#promptOk').onclick = () => finish(input ? input.value : '');

    if (input) {
      // 单行输入按回车直接确定；多行用 Ctrl+Enter 确定
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      };
      input.focus?.();
      input.select?.();
    }
  });
}
