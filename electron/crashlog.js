'use strict';

// ---------------------------------------------------------------------------
// 崩溃日志：写到系统临时目录，双击启动时也能留痕
// ---------------------------------------------------------------------------
// 依次尝试多个位置，取第一个能写的（受限环境下 %TEMP% / LOCALAPPDATA 可能不可写）
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_CANDIDATES = [
  path.join(__dirname, 'coc-keeper-crash.log'),
  path.join(process.env.LOCALAPPDATA || '', 'coc-keeper-crash.log'),
  path.join(os.tmpdir(), 'coc-keeper-crash.log')
].filter((p) => p && p.length > 20);

let logPath = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;

  if (logPath) {
    try { fs.appendFileSync(logPath, line, 'utf8'); return; } catch (_) { logPath = null; }
  }
  for (const p of LOG_CANDIDATES) {
    try { fs.appendFileSync(p, line, 'utf8'); logPath = p; return; } catch (_) { /* 换下一个 */ }
  }
  try { process.stderr.write(line); } catch (_) { /* 实在没地方写 */ }
}

/** 挂上全局异常钩子，未捕获的错误也进日志 */
function install() {
  process.on('uncaughtException', (e) => {
    log('UNCAUGHT: ' + (e && e.stack ? e.stack : String(e)));
  });
  process.on('unhandledRejection', (e) => {
    log('UNHANDLED: ' + (e && e.stack ? e.stack : String(e)));
  });
}

module.exports = { log, install };
