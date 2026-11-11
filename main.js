'use strict';

// ---------------------------------------------------------------------------
// 主进程入口：只负责装配各模块，不放具体业务逻辑
// ---------------------------------------------------------------------------
const { app } = require('electron');
const crashlog = require('./electron/crashlog');

crashlog.install();
crashlog.log('================ BOOT ================');
crashlog.log('execPath=' + process.execPath);
crashlog.log('argv=' + JSON.stringify(process.argv));
crashlog.log('versions=' + JSON.stringify(process.versions));

// 关闭硬件加速：本程序是纯 DOM 界面，无 3D 需求，关掉能避免部分显卡驱动下的黑屏/崩溃
try {
  app.disableHardwareAcceleration();
  crashlog.log('disableHardwareAcceleration ok');
} catch (e) {
  crashlog.log('disableHardwareAcceleration failed: ' + e.message);
}

// Windows 上显式声明 AppUserModelId，让任务栏图标、窗口与进程归属一致。
// 不设的话，部分环境下窗口会被系统当成「来源不明的窗口」而降低前台激活优先级。
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('coc.keeper.ai');
    crashlog.log('setAppUserModelId ok');
  } catch (e) {
    crashlog.log('setAppUserModelId failed: ' + e.message);
  }
}

// 单实例锁：重复双击时不再开第二个窗口，而是把已有窗口叫回前台。
// 这同时解决「第二次启动只多一个进程、窗口仍停在任务栏」的情况。
//
// 踩过的坑：原来这里是
//     if (!gotSingleInstanceLock) { app.quit(); }
//     ...（后面照常注册 IPC 和窗口生命周期）
// 看起来没问题，实际 app.quit() 只是「请求退出」，是异步的：
// app.whenReady() 照样会 resolve，createWindow() 照样执行，
// 于是第二个进程还是会建出 splash 窗口，等 quit 生效再把它销毁。
// 实测 splash 在 +164ms 创建、+218ms 关闭，只活 54ms——
// 用户看到的就是「双击后有个窗口闪了一下」，而主窗口永远不会出现。
//
// 正确做法：锁失败就彻底不往下走，任何窗口、任何 IPC 都不注册。
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  crashlog.log('another instance is running, quitting this one');
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  const {
    registerWindowLifecycle, getWindow, openRuleBookWindow, focusExistingWindow
  } = require('./electron/window');
  const { registerConfigIpc } = require('./electron/config');
  const { registerLlmIpc } = require('./electron/llm');
  const {
    registerSaveIpc, registerModuleIpc, registerStoreIpc, registerCharIpc,
    registerRuleBookIpc, registerRuleBookWindowIpc, registerFileIpc
  } = require('./electron/ipc-files');

  // 已有实例时再次双击：把它的窗口叫回前台，而不是开新的
  app.on('second-instance', () => {
    crashlog.log('second-instance detected, focusing existing window');
    focusExistingWindow();
  });

  registerConfigIpc();
  registerLlmIpc(getWindow);
  registerSaveIpc();
  registerModuleIpc(getWindow);
  registerStoreIpc();
  registerCharIpc();
  registerRuleBookIpc();
  registerRuleBookWindowIpc(openRuleBookWindow);
  registerFileIpc(getWindow);

  crashlog.log('ipc handlers registered');

  registerWindowLifecycle();
}
