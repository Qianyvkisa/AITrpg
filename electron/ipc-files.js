'use strict';

// ---------------------------------------------------------------------------
// 存档 / 模组 / 通用键值存储 的 IPC
// ---------------------------------------------------------------------------
const { ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const { readJSON, writeJSON, deleteFile, listFiles } = require('./storage');
const { readFolder, readSingleFile, materialsToPromptText } = require('./materials');
const { understandMaterials, moduleFromUnderstanding } = require('./moduleAI');
const { loadConfig } = require('./config');

const SAVE_PREFIX = 'save-';

function registerSaveIpc() {
  ipcMain.handle('save:list', () => {
    const files = listFiles((f) => f.startsWith(SAVE_PREFIX) && f.endsWith('.json'));
    return files
      .map(({ name, path: p, stat }) => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(p, 'utf8')).meta ?? {}; } catch (_) { /* 坏档跳过 meta */ }
        return { file: name, mtime: stat.mtimeMs, ...meta };
      })
      .sort((a, b) => b.mtime - a.mtime);
  });

  ipcMain.handle('save:write', (_e, { slot, state }) => {
    const name = `${SAVE_PREFIX}${slot}.json`;
    writeJSON(name, state);
    return { ok: true, file: name };
  });

  ipcMain.handle('save:read', (_e, slot) => readJSON(`${SAVE_PREFIX}${slot}.json`, null));

  ipcMain.handle('save:delete', (_e, slot) => {
    deleteFile(`${SAVE_PREFIX}${slot}.json`);
    return { ok: true };
  });
}

function newModuleId() {
  return 'mod-' + Date.now().toString(36);
}

function appendModule(mod) {
  const list = readJSON('modules.json', []);
  list.push(mod);
  writeJSON('modules.json', list);
  return mod;
}

function registerModuleIpc(getWindow) {
  /**
   * 导入单个文件（txt / md / json / docx / pdf / 图片）。
   * 不再局限于纯文本。
   */
  ipcMain.handle('module:import', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: '导入模组文件',
      filters: [
        { name: '模组文档', extensions: ['txt', 'md', 'markdown', 'json', 'docx', 'pdf', 'html', 'htm'] },
        { name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return null;

    const p = r.filePaths[0];
    const parsed = await readSingleFile(p);

    const text = materialsToPromptText(parsed);
    if (!text.trim()) {
      return {
        error: parsed.skipped.map((s) => `${s.rel}：${s.reason}`).join('；') || '文件里没有可读内容'
      };
    }

    return appendModule({
      id: newModuleId(),
      title: path.basename(p, path.extname(p)),
      source: p,
      importedAt: Date.now(),
      raw: text,
      materials: parsed.docs.map((d) => ({ rel: d.rel, kind: d.kind }))
    });
  });

  /**
   * 导入整个文件夹：递归读取 docx / pdf / 文本 / 图片。
   * understand=false 时只把素材拼成文本，不调用 AI。
   * understand=true  时交给 AI 整理成结构化模组。
   */
  ipcMain.handle('module:importFolder', async (_e, { folder, understand = true } = {}) => {
    const win = getWindow();

    let dir = folder;
    if (!dir) {
      const r = await dialog.showOpenDialog(win, {
        title: '选择模组文件夹',
        properties: ['openDirectory']
      });
      if (r.canceled || !r.filePaths.length) return null;
      dir = r.filePaths[0];
    }

    let parsed;
    try {
      parsed = await readFolder(dir, {
        onProgress: (rel) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('module:progress', { folder: dir, rel });
          }
        }
      });
    } catch (e) {
      return { error: `读取文件夹失败：${e.message}` };
    }

    const materialsText = materialsToPromptText(parsed);
    if (!materialsText.trim()) {
      return {
        error:
          '这个文件夹里没有可用的材料。支持 .docx / .pdf / .txt / .md / 图片，' +
          `已跳过：${parsed.skipped.map((s) => `${s.rel}（${s.reason}）`).join('；') || '无'}`
      };
    }

    const folderName = path.basename(dir);

    // 不用 AI：直接把素材当作模组原文
    if (!understand) {
      return appendModule({
        id: newModuleId(),
        title: folderName,
        source: dir,
        importedAt: Date.now(),
        raw: materialsText,
        materials: {
          docs: parsed.docs.map((d) => ({ rel: d.rel, kind: d.kind })),
          images: parsed.images.map((i) => ({ rel: i.rel, mime: i.mime, bytes: i.bytes })),
          skipped: parsed.skipped
        }
      });
    }

    // 用 AI 理解素材
    const cfg = loadConfig();
    const r = await understandMaterials(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      { folderName, materialsText, images: parsed.images }
    );

    if (!r.ok) {
      return {
        error: `AI 理解失败：${r.error}`,
        hint: '可以改用「不经过 AI，直接存为模组」，素材原文仍会保留。',
        materialsText
      };
    }

    const raw = moduleFromUnderstanding(r.module, { folderName, materialsText });

    return appendModule({
      id: newModuleId(),
      title: r.module.title || folderName,
      source: dir,
      importedAt: Date.now(),
      raw,
      understanding: r.module,
      materials: {
        docs: parsed.docs.map((d) => ({ rel: d.rel, kind: d.kind })),
        images: parsed.images.map((i) => ({ rel: i.rel, mime: i.mime, bytes: i.bytes })),
        skipped: parsed.skipped
      },
      visionUsed: !!r.visionUsed
    });
  });

  ipcMain.handle('module:list', () => readJSON('modules.json', []));

  ipcMain.handle('module:delete', (_e, id) => {
    writeJSON('modules.json', readJSON('modules.json', []).filter((m) => m.id !== id));
    return { ok: true };
  });

  // 直接从文本框粘贴模组
  ipcMain.handle('module:addText', (_e, { title, raw }) =>
    appendModule({
      id: newModuleId(),
      title: title || '未命名模组',
      source: '(手动粘贴)',
      importedAt: Date.now(),
      raw
    })
  );
}

// ---------------------------------------------------------------------------
// 角色卡库
//
// 玩家角色卡和 AI 队友角色卡分开存两个文件，因为它们的用途不同：
//   characters-player.json  —— 玩家自己的调查员，随时可以拿来开局
//   characters-ai.json      —— AI 队友，供开局时挑人、以及模组里当支援伙伴
//
// 每张卡是一个完整的角色卡对象，外面套一层 meta（id / 保存时间 / 来源）。
// ---------------------------------------------------------------------------
const CHAR_KINDS = {
  player: 'characters-player.json',
  ai: 'characters-ai.json'
};

function charFile(kind) {
  return CHAR_KINDS[kind] || CHAR_KINDS.player;
}

function listChars(kind) {
  const list = readJSON(charFile(kind), []);
  return Array.isArray(list) ? list : [];
}

function registerCharIpc() {
  /** 列出某个库里所有角色卡（按保存时间倒序） */
  ipcMain.handle('char:list', (_e, kind) => {
    return listChars(kind)
      .slice()
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  });

  /**
   * 存一张角色卡。
   * 传 id 表示覆盖已有卡，不传则新建。
   * @returns {{ok: true, id: string}}
   */
  ipcMain.handle('char:save', (_e, { kind, char, id = null, name = null }) => {
    if (!char || typeof char !== 'object') return { ok: false, error: '角色卡内容为空' };

    const file = charFile(kind);
    const list = listChars(kind);

    const entry = {
      id: id || 'char-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      savedAt: Date.now(),
      name: name || char.name || '未命名调查员',
      char
    };

    const idx = id ? list.findIndex((c) => c.id === id) : -1;
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);

    writeJSON(file, list);
    return { ok: true, id: entry.id };
  });

  ipcMain.handle('char:delete', (_e, { kind, id }) => {
    const file = charFile(kind);
    writeJSON(file, listChars(kind).filter((c) => c.id !== id));
    return { ok: true };
  });

  /** 改名：只动库里的显示名，不动角色卡本身 */
  ipcMain.handle('char:rename', (_e, { kind, id, name }) => {
    const list = listChars(kind);
    const hit = list.find((c) => c.id === id);
    if (hit) hit.name = String(name || '').trim() || hit.name;
    writeJSON(charFile(kind), list);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// 规则书 PDF
//
// 阅读器是 src/rulebook.html 这个独立窗口，PDF 交给 Chromium 内置的 PDF 阅读器
// 显示（PDFium 对中文支持成熟，自带缩放/搜索/打印）。
// 这里只负责：告诉渲染进程 PDF 在哪、以及在需要时用系统阅读器打开。
//
// 关键：PDF 必须放在真实磁盘上，不能在 asar 里。
// Chromium 的 PDF 插件走的是自己的加载路径，读不到 asar 虚拟文件系统，
// 表现就是 iframe 一片空白。所以 package.json 里用 asarUnpack 把 assets/ 解出来，
// 这里的路径也要指向 app.asar.unpacked。
// ---------------------------------------------------------------------------
function ruleBookPath() {
  const packed = path.join(__dirname, '..', 'assets', 'coc-kp.pdf');
  // 打包后 __dirname 形如 .../resources/app.asar/electron，
  // 同名文件在 app.asar.unpacked 下才是真实文件，优先用它
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== packed && fs.existsSync(unpacked)) return unpacked;
  return packed;
}

function registerRuleBookIpc() {
  /** 返回 PDF 的 file:// URL，供阅读器窗口的 iframe 直接指向 */
  ipcMain.handle('rulebook:path', () => {
    const p = ruleBookPath();
    if (!fs.existsSync(p)) {
      return { ok: false, error: `找不到规则书文件：${p}` };
    }
    // pathToFileURL 会正确处理盘符、空格与中文
    return { ok: true, url: pathToFileURL(p).href, path: p };
  });
  /** 用系统默认阅读器打开（应用内阅读器出问题时的退路） */
  ipcMain.handle('rulebook:openExternal', async () => {
    const p = ruleBookPath();
    if (!fs.existsSync(p)) return { ok: false, error: '找不到规则书文件' };
    try {
      const err = await shell.openPath(p);
      // openPath 不抛异常，失败时返回非空字符串
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// 通用键值存储（世界观笔记等）
function registerStoreIpc() {
  ipcMain.handle('store:get', (_e, key) => readJSON(`${key}.json`, null));
  ipcMain.handle('store:set', (_e, { key, value }) => writeJSON(`${key}.json`, value));
}

// ---------------------------------------------------------------------------
// 打开规则书窗口
//
// 窗口创建在 electron/window.js 里（那里管窗口生命周期），
// 这里只负责把「点按钮 → 开窗口」这条 IPC 接上。
// 传函数而不是直接 require，是为了避免 window.js 与 ipc-files.js 互相依赖。
// ---------------------------------------------------------------------------
function registerRuleBookWindowIpc(openWindow) {
  ipcMain.handle('rulebook:open', () => {
    try {
      openWindow();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  registerSaveIpc, registerModuleIpc, registerStoreIpc, registerCharIpc,
  registerRuleBookIpc, registerRuleBookWindowIpc
};
