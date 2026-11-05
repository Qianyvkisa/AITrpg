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
  setStore: (key, value) => ipcRenderer.invoke('store:set', { key, value })
});
