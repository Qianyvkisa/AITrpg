'use strict';

// ---------------------------------------------------------------------------
// 窗口创建与生命周期
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell } = require('electron');

// ---------------------------------------------------------------------------
// 启动时序记录（仅在设置 COCO_STARTUP_LOG 时启用）
//
// 为什么要它：启动画面"看不见"这个问题，从外部几乎无法诊断——
// isVisible() 会骗人（返回 true 但窗口被盖住），Win32 窗口枚举在 PowerShell
// 里又不可靠。只有让进程自己记录"窗口何时真的上了屏幕"，才能拿到真话。
//
// 用法：设环境变量 COCO_STARTUP_LOG=<文件路径> 再启动，
// 结束后文件里就是完整时间线。正常使用不受任何影响。
// ---------------------------------------------------------------------------
const LOG_FILE = process.env.COCO_STARTUP_LOG || null;
const T0 = Date.now();

function slog(label) {
  if (!LOG_FILE) return;
  const line = `+${String(Date.now() - T0).padStart(5)}ms  ${label}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* 日志失败不能影响启动 */ }
  console.log('[startup] ' + line.trim());
}

slog('main.js 开始执行');

let win = null;

function getWindow() {
  return win;
}

// ---------------------------------------------------------------------------
// 把窗口真正送到用户眼前
//
// 背景：打包成 portable exe 后，用户双击的是「启动器进程」，它解压完再 spawn
// 真正的 Electron 进程。Windows 的前台激活权限（SetForegroundWindow）只给了
// 那个启动器，于是窗口进程调用 show() 会被系统静默降级成「只显示、不激活」，
// 表现就是：窗口已经开好、进程也在跑，但停在任务栏，必须手动点一下图标才出来。
//
// 对策：
//   1) 窗口先 show 出来（保证用户至少能看到它）
//   2) 短暂置顶，借置顶窗口显示时必定获得前台的机会，然后立刻取消置顶
//   3) 多次延迟重试：用户刚双击启动时前台锁定计时器还在跑，稍后再试更容易成功
// ---------------------------------------------------------------------------
function forceForeground() {
  if (!win || win.isDestroyed()) return false;
  if (win.isFocused()) return true;

  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();

    // macOS 上需要显式 steal 才能跨应用抢焦点；Windows 上该调用被忽略，加上无害
    app.focus({ steal: true });

    // 置顶窗口在显示时必定被允许成为前台，抢到后立刻取消置顶，避免真的压在别人上面
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
    win.focus();
  } catch (e) {
    return false;
  }
  return win.isFocused();
}

function bringToFront() {
  if (!win || win.isDestroyed()) return;

  forceForeground();

  // 逐级重试，越往后间隔越长；一旦抢到前台就停止，不做多余动作
  const RETRY_DELAYS = [200, 500, 1000, 2000];
  RETRY_DELAYS.forEach((delay) => {
    setTimeout(() => forceForeground(), delay);
  });
}

/**
 * 把已经存在的窗口叫回前台（重复启动时用）。
 * 若窗口已被关掉，则重新创建一个。
 */
function focusExistingWindow() {
  if (!win || win.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  bringToFront();
}

// ---------------------------------------------------------------------------
// 规则书窗口
//
// 独立窗口而不是主窗口里的弹窗：418 页的 PDF 放进弹窗会挤成一窄条，
// 独立窗口能记住自己的尺寸，也能和主窗口并排放，方便边看规则边开局。
// ---------------------------------------------------------------------------
let rbWin = null;

function openRuleBookWindow() {
  if (rbWin && !rbWin.isDestroyed()) {
    rbWin.focus();
    return rbWin;
  }

  rbWin = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0b0f',
    title: '规则书 · 克苏鲁的呼唤 第七版',
    autoHideMenuBar: true,
    parent: win && !win.isDestroyed() ? win : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium 自带的 PDF 阅读器需要 plugins 才能启用；
      // 少了这一项 iframe 指向 .pdf 会变成下载而不是显示
      plugins: true
    }
  });

  rbWin.loadFile(path.join(__dirname, '..', 'src', 'rulebook.html'));
  rbWin.on('closed', () => { rbWin = null; });

  // PDF 阅读器内部可能想开新窗口（如打印预览），交给系统浏览器处理
  rbWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return rbWin;
}

// ---------------------------------------------------------------------------
// 启动画面
//
// 背景：双击 exe 到看见界面之间有一段空窗期——portable 启动器要先解压，
// Electron 起来后还要加载 index.html、读存档、初始化渲染进程。
// 这段时间用户看到的是"什么都没发生"，容易以为没启动成功又去双击。
//
// 做法：先开一个极轻的无边框小窗（单文件、无脚本、无外部资源）立刻显示，
// 主窗口在后台加载，等它真正准备好再交接。
//
// 几个必须注意的点：
//   1) splash 不能抢焦点，否则主窗口交接时焦点会跳一下
//   2) 主窗口必须等 splash 退场后再显示，两个窗口不能重叠
//   3) 主窗口加载失败时也要关掉 splash，不能让它永远转下去
//
// 关于第 2 点（踩过的坑）：
//   最初的做法是"主窗口一准备好就 bringToFront，同时让 splash 至少留 700ms"。
//   结果 splash 在 217ms 出现、主窗口 320ms 就盖上来了——
//   splash 只有约 100ms 真正露在屏幕上，用户等于什么都没看见。
//   isVisible() 却一直是 true，所以自检完全查不出来。
//   根因是"最短显示时长"只管了什么时候关，没管什么时候被盖。
//   现在改成：主窗口准备好之后，先等到 splash 该退场，再关 splash、再显示主窗口，
//   两者在时间上完全错开。
// ---------------------------------------------------------------------------
const SPLASH_MIN_MS = 900;   // splash 至少露这么久（含创建与渲染时间）
const SPLASH_MAX_MS = 6000;  // 兜底：再慢也不能一直挂着

let splash = null;
let splashStartAt = 0;

function showSplash() {
  splashStartAt = Date.now();
  try {
    splash = new BrowserWindow({
      width: 380,
      height: 300,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      skipTaskbar: true,
      // 直接显示：先 show 出来再等页面画好，比"等 ready-to-show"可靠——
      // 透明无边框窗口的 ready-to-show 在某些机器上不触发，那样启动画面就永远不出现。
      show: true,
      // 不参与焦点竞争：它是装饰，不是可交互界面
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    splash.loadFile(path.join(__dirname, '..', 'src', 'splash.html'));
    slog('splash 窗口已创建并显示');
    splash.once('ready-to-show', () => slog('splash ready-to-show'));
    splash.webContents.once('did-finish-load', () => slog('splash 页面加载完成'));
    splash.on('closed', () => { slog('splash 已关闭'); splash = null; });
  } catch {
    // 启动画面只是锦上添花，失败不能影响主流程
    splash = null;
  }
}

/**
 * 关闭启动画面。
 * 返回一个 Promise，在 splash 真正关掉之后 resolve——
 * 调用方要等它，才能保证主窗口出现时 splash 已经不在屏幕上了。
 */
function closeSplash() {
  return new Promise((resolve) => {
    if (!splash || splash.isDestroyed()) {
      splash = null;
      resolve();
      return;
    }
    const s = splash;
    splash = null;
    // 'closed' 事件才是真正关掉的时刻；只调 close() 不能保证已经消失
    s.once('closed', () => { slog('closeSplash 完成'); resolve(); });
    slog('closeSplash 请求关闭');
    s.close();
    // 极端情况下 'closed' 可能不触发（窗口已被系统回收），加个超时兜底
    setTimeout(resolve, 300);
  });
}

function createWindow() {
  // 先把启动画面亮出来，再慢慢建主窗口
  showSplash();

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0d0f14',
    title: 'COC 跑团 · AI 守密人',
    autoHideMenuBar: true,
    // 先不显示，等页面渲染好再一次性送到前台，避免白屏窗口闪一下才激活
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 三种触发各自兜底，任何一个先到就执行；都到也只执行一次
  let frontShown = false;
  const showOnce = async () => {
    if (frontShown || !win || win.isDestroyed()) return;
    frontShown = true;
    slog('showOnce 触发（主窗口已准备好）');

    // 等 splash 把最短时长露满，再交接；两者不重叠
    const elapsed = Date.now() - splashStartAt;
    const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
    if (wait > 0) {
      slog(`等待 splash 补足最短时长 ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }

    await closeSplash();
    if (!win || win.isDestroyed()) return;
    slog('主窗口 bringToFront');
    bringToFront();
    slog('主窗口已显示，交接完毕');
  };

  win.once('ready-to-show', showOnce);
  win.webContents.once('did-finish-load', showOnce);
  // 页面加载异常时 ready-to-show 不会触发，不能因此让窗口永远不出现
  setTimeout(showOnce, 1200);
  // 启动画面兜底关闭：即使上面都没触发，也不能让它一直转
  setTimeout(async () => {
    if (!frontShown) {
      await closeSplash();
      if (win && !win.isDestroyed()) bringToFront();
    }
  }, SPLASH_MAX_MS);

  slog('开始加载 index.html');
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.on('closed', () => { win = null; });

  // 外部链接用系统浏览器打开，不在应用内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function registerWindowLifecycle() {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = {
  createWindow, getWindow, registerWindowLifecycle, focusExistingWindow, openRuleBookWindow
};
