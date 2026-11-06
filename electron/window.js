'use strict';

// ---------------------------------------------------------------------------
// 窗口创建与生命周期
// ---------------------------------------------------------------------------
const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

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

function createWindow() {
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
  const showOnce = () => {
    if (frontShown || !win || win.isDestroyed()) return;
    frontShown = true;
    bringToFront();
  };

  win.once('ready-to-show', showOnce);
  win.webContents.once('did-finish-load', showOnce);
  // 页面加载异常时 ready-to-show 不会触发，不能因此让窗口永远不出现
  setTimeout(showOnce, 1200);

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
