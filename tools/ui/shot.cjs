// ---------------------------------------------------------------------------
// UI 截图工具（开发用，不随程序分发）
//
// 用途：把真实界面渲染出来并截图，用于核对样式改动后的实际效果。
//
// 为什么不用浏览器 headless：
//   本程序的界面依赖 Electron 的 preload（window.api），纯浏览器里
//   window.api 不存在，很多初始化会直接抛错，截出来的画面是残缺的。
//
// 用法：
//   node_modules\electron\dist\electron.exe tools\ui\shot.cjs
//
// 可用环境变量：
//   SHOT_OUT    输出目录（默认 tools\ui\shots）
//   SHOT_W/H    窗口宽高（默认 1440 x 900）
//   SHOT_TAB    截完后切到哪个页签（可选：settings / modules / saves）
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(ROOT, process.env.SHOT_OUT || 'tools/ui/shots');
const W = Number(process.env.SHOT_W || 1440);
const H = Number(process.env.SHOT_H || 900);
const TAB = process.env.SHOT_TAB || '';

// 打包外的源码直接加载；界面资源在 src 下
const INDEX = path.join(ROOT, 'src', 'index.html');

// 让截图不依赖真实的 Electron userData，避免污染用户存档
app.setPath('userData', path.join(ROOT, '.udata-shot'));
app.disableHardwareAcceleration();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: W,
    height: H,
    show: true,                 // 必须真实显示：隐藏窗口会被节流，动画/布局算不准
    backgroundColor: '#0a0b0f',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const LOG = path.join(ROOT, '_shot_result.txt');
const errors = [];
function out(m){ try{ fs.appendFileSync(LOG, m + '\n'); }catch(_){} }
fs.writeFileSync(LOG, '');
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  try {
    await win.loadFile(INDEX);
    // 等首屏脚本跑完（startScreen 渲染 + 字体就绪）
    await sleep(1200);

    // 可选：切到指定页签再截
    if (TAB) {
      await win.webContents.executeJavaScript(`
        (() => {
          const btn = document.querySelector('[data-tab="${TAB}"], #menu-${TAB}, .tab-${TAB}');
          if (btn) { btn.click(); return 'clicked'; }
          return 'not-found';
        })()
      `).catch(() => {});
      await sleep(600);
    }

    const img = await win.webContents.capturePage();
    const base = TAB ? `shot-${TAB}-${W}` : `shot-${W}`;
    const file = path.join(OUT, `${base}.png`);
    fs.writeFileSync(file, img.toPNG());

    const size = img.getSize();
    out(`[截图] ${file}`);
    out(`[尺寸] ${size.width} x ${size.height}`);
    if (errors.length) {
      out(`[控制台错误 ${errors.length} 条]`);
      errors.slice(0, 5).forEach((e) => out('  ' + String(e).slice(0, 120)));
    } else {
      out('[控制台] 无错误');
    }
  } catch (e) {
    out('[截图失败] ' + (e && e.message ? e.message : String(e)));
  } finally {
    win.destroy();
    app.quit();
  }
}

app.whenReady().then(main);
