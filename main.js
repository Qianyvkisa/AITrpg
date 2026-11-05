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
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  crashlog.log('another instance is running, quitting this one');
  app.quit();
} else {
  const { focusExistingWindow } = require('./electron/window');
  app.on('second-instance', () => {
    crashlog.log('second-instance detected, focusing existing window');
    focusExistingWindow();
  });
}

const { registerWindowLifecycle, getWindow } = require('./electron/window');
const { registerConfigIpc } = require('./electron/config');
const { registerLlmIpc } = require('./electron/llm');
const { registerSaveIpc, registerModuleIpc, registerStoreIpc, registerCharIpc } = require('./electron/ipc-files');

registerConfigIpc();
registerLlmIpc(getWindow);
registerSaveIpc();
registerModuleIpc(getWindow);
registerStoreIpc();
registerCharIpc();

crashlog.log('ipc handlers registered');

registerWindowLifecycle();
