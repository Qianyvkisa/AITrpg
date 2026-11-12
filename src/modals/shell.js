// ---------------------------------------------------------------------------
// 通用弹窗容器：所有弹窗共用一套打开/关闭行为
// ---------------------------------------------------------------------------

/**
 * 点遮罩空白处关闭弹窗——但要排除「框选文字时拖出弹窗」这种情况。
 *
 * 为什么不能用 click + `e.target === backdrop` 判断（原来的写法）：
 *   click 的 target 是**按下与松开位置的最近共同祖先**。
 *   玩家在弹窗里按住鼠标拖选文字，手滑移出弹窗、在遮罩上松开，
 *   按下在弹窗内、松开在遮罩，共同祖先正好是 backdrop——
 *   于是被判定成「点了遮罩」，弹窗自己关掉了。设置界面里框选
 *   模型名、API 地址时经常触发，输入的内容也跟着丢了。
 *
 * 正确判据是「按下和松开**都**落在遮罩空白处」才算真的点了遮罩：
 *   - 弹窗内按下 → 遮罩上松开（框选拖出去）：不关
 *   - 遮罩按下   → 弹窗内松开（拖回来改主意）：不关
 *   - 遮罩按下   → 遮罩上松开（真的点空白）：关
 *
 * 用 mouseup 而不是 click，就是为了拿到松开那一刻真实的 target，
 * 而不是 click 那个「共同祖先」。
 *
 * @param {Element} backdrop 遮罩元素
 * @param {() => void} onClose 确认要关闭时调用
 */
function bindBackdropClose(backdrop, onClose) {
  // 记录按下时落在哪里；只在 mouseup 时读取一次就重置
  let downTarget = null;

  backdrop.addEventListener('mousedown', (e) => {
    downTarget = e.target;
  });

  backdrop.addEventListener('mouseup', (e) => {
    const bothOnBackdrop = downTarget === backdrop && e.target === backdrop;
    downTarget = null;
    if (bothOnBackdrop) onClose();
  });

  // 鼠标移出窗口再松开时收不到 mouseup，downTarget 会留着旧值。
  // 下次 mousedown 会重新赋值，所以不会误判；这里额外兜一层，
  // 避免「上次残留 + 这次在遮罩上松开」凑成一次假点击。
  backdrop.addEventListener('mouseleave', () => {
    downTarget = null;
  });
}

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

  // 关闭：点遮罩空白处（且不是框选拖出去）或带 data-close 的按钮
  bindBackdropClose(backdrop, close);
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

    // 点遮罩空白处算取消（同样排除框选拖出去的误触，见 bindBackdropClose）
    bindBackdropClose(backdrop, () => finish(null));
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
