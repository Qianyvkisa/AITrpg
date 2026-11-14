'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),

  // LLM
  chat: (payload) => ipcRenderer.invoke('llm:chat', payload),
  cancel: (requestId) => ipcRenderer.invoke('llm:cancel', requestId),
  listModels: (payload) => ipcRenderer.invoke('llm:models', payload),
  onChunk: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  // 上游网关抖动（502/503/504 等）时主进程会自动重试，
  // 这里把「正在重试第 n 次」告诉界面，否则玩家只看到界面卡住。
  onRetry: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('llm:retry', handler);
    return () => ipcRenderer.removeListener('llm:retry', handler);
  },

  // 存档
  listSaves: () => ipcRenderer.invoke('save:list'),
  writeSave: (slot, state) => ipcRenderer.invoke('save:write', { slot, state }),
  readSave: (slot) => ipcRenderer.invoke('save:read', slot),
  deleteSave: (slot) => ipcRenderer.invoke('save:delete', slot),

  // 角色卡库（kind: 'player' | 'ai'，两边分开存）
  listChars: (kind) => ipcRenderer.invoke('char:list', kind),
  saveChar: (kind, char, opts = {}) =>
    ipcRenderer.invoke('char:save', { kind, char, id: opts.id ?? null, name: opts.name ?? null }),
  deleteChar: (kind, id) => ipcRenderer.invoke('char:delete', { kind, id }),
  renameChar: (kind, id, name) => ipcRenderer.invoke('char:rename', { kind, id, name }),

  // 模组
  importModule: () => ipcRenderer.invoke('module:import'),
  importModuleFolder: (payload) => ipcRenderer.invoke('module:importFolder', payload),
  listModules: () => ipcRenderer.invoke('module:list'),
  deleteModule: (id) => ipcRenderer.invoke('module:delete', id),
  addModuleText: (title, raw) => ipcRenderer.invoke('module:addText', { title, raw }),
  onModuleProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('module:progress', handler);
    return () => ipcRenderer.removeListener('module:progress', handler);
  },

  // 通用存储
  getStore: (key) => ipcRenderer.invoke('store:get', key),
  setStore: (key, value) => ipcRenderer.invoke('store:set', { key, value }),

  // 规则书
  openRuleBook: () => ipcRenderer.invoke('rulebook:open'),
  getRuleBookPath: () => ipcRenderer.invoke('rulebook:path'),
  getRuleBookBase64: () => ipcRenderer.invoke('rulebook:base64'),
  openRuleBookExternal: () => ipcRenderer.invoke('rulebook:openExternal'),

  // 导出文本（跑团记录等）：弹保存对话框让玩家自己选位置
  saveTextFile: (payload) => ipcRenderer.invoke('file:saveText', payload),

  // -------------------------------------------------------------------------
  // 联机
  // -------------------------------------------------------------------------
  net: {
    // 开房 / 关房
    hostStart: (opts) => ipcRenderer.invoke('net:hostStart', opts),
    hostStop: () => ipcRenderer.invoke('net:hostStop'),
    hostPlayers: () => ipcRenderer.invoke('net:hostPlayers'),
    hostBroadcast: (payload) => ipcRenderer.invoke('net:hostBroadcast', payload),
    hostSendTo: (payload) => ipcRenderer.invoke('net:hostSendTo', payload),
    hostSetChar: (payload) => ipcRenderer.invoke('net:hostSetChar', payload),
    hostFindByChar: (charId) => ipcRenderer.invoke('net:hostFindByChar', charId),

    // 加入 / 离开
    join: (opts) => ipcRenderer.invoke('net:join', opts),
    leave: () => ipcRenderer.invoke('net:leave'),
    send: (payload) => ipcRenderer.invoke('net:send', payload),
    clientStatus: () => ipcRenderer.invoke('net:clientStatus'),

    // 局域网发现
    scanStart: () => ipcRenderer.invoke('net:scanStart'),
    scanStop: () => ipcRenderer.invoke('net:scanStop'),
    rooms: () => ipcRenderer.invoke('net:rooms'),
    normalizeRoomCode: (input) => ipcRenderer.invoke('net:normalizeRoomCode', input),
    localAddresses: () => ipcRenderer.invoke('net:localAddresses'),

    shutdown: () => ipcRenderer.invoke('net:shutdown'),

    // 房主侧事件
    onPlayerJoined: sub('net:playerJoined'),
    onPlayerOffline: sub('net:playerOffline'),
    onPlayerReconnected: sub('net:playerReconnected'),
    onClaim: sub('net:claim'),
    onAction: sub('net:action'),
    onRoll: sub('net:roll'),
    onChat: sub('net:chat'),
    onReady: sub('net:ready'),

    // 客户端侧事件
    onWelcome: sub('net:welcome'),
    onMessage: sub('net:message'),
    onServerError: sub('net:serverError'),
    onClientError: sub('net:clientError'),
    onFatal: sub('net:fatal'),
    onHostGone: sub('net:hostGone'),
    onDisconnected: sub('net:disconnected'),
    onReconnecting: sub('net:reconnecting'),
    onRooms: sub('net:rooms')
  }
});

/**
 * 订阅一个主进程推送的通道，返回取消订阅函数。
 * 每个订阅都返回自己的解绑器，避免组件重渲染时监听器越堆越多。
 */
function sub(channel) {
  return (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}
