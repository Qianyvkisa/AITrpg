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
