'use strict';

// ---------------------------------------------------------------------------
// 配置：API Key 只存在主进程，不进入渲染层的持久化状态
// ---------------------------------------------------------------------------
// 默认值来自 defaults.js（唯一来源），渲染层通过 config:get 拿到合并后的完整配置。
const { ipcMain } = require('electron');
const { readJSON, writeJSON } = require('./storage');
const { DEFAULT_CONFIG } = require('./defaults');

/** 读取磁盘配置并与默认值合并 */
function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJSON('config.json', {}) };
}

/** 保存配置（同样与默认值合并，避免缺字段） */
function saveConfig(patch) {
  const merged = { ...DEFAULT_CONFIG, ...(patch || {}) };
  writeJSON('config.json', merged);
  return merged;
}

function registerConfigIpc() {
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', (_e, cfg) => saveConfig(cfg));
}

module.exports = { loadConfig, saveConfig, registerConfigIpc };
