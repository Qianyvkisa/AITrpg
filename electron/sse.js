'use strict';

// ---------------------------------------------------------------------------
// SSE 增量解析：把流式响应的字节片段切成一条条 data 负载
// 与网络、Electron 无关，可以单独测试
// ---------------------------------------------------------------------------

/**
 * 创建一个增量解析器。
 * push(text) 返回本次可以处理的 data 负载数组；
 * 未完成的行会留在内部缓冲区，等下一片数据补齐。
 */
function createSseDecoder() {
  let buffer = '';

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split('\n');
      // 最后一段可能是半行，留在缓冲区里
      buffer = lines.pop() ?? '';

      const payloads = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;   // 空行 / 注释行
        if (!line.startsWith('data:')) continue;       // event:/id:/retry: 等字段忽略
        payloads.push(line.slice(5).trim());
      }
      return payloads;
    },

    /** 流结束时残留的半行也尝试解析一次 */
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (!rest || !rest.startsWith('data:')) return [];
      return [rest.slice(5).trim()];
    }
  };
}

module.exports = { createSseDecoder };
