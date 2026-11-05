// ---------------------------------------------------------------------------
// 通用工具：HTML 转义、消息指令剥离
// 渲染层与弹窗层共用一份，避免两个文件各写一遍
// ---------------------------------------------------------------------------

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** 展示用：把 [[...]] 指令藏起来，只留叙事文本 */
export function stripDirectivesForDisplay(text) {
  return String(text ?? '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
