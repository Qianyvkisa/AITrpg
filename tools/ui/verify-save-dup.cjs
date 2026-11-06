// ---------------------------------------------------------------------------
// 端到端验证：开始界面「存库」连点不会存出多份
//
// 前面 charStore.test.mjs 验的是主进程 IPC 层。这个脚本走真实 UI：
// 打开设定界面 → 找到「存库」按钮 → 连点 3 次 → 检查角色卡库里只有 1 份。
//
// 为什么要单独做 UI 层验证：
//   bug 的根因横跨两层——前端不传 id、后端"不传 id 就新建"。
//   只测 IPC 层会漏掉前端是否真的把带 id 的角色卡传了下去。
//
// 用法：electron.exe tools\ui\verify-save-dup.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

// 用独立 userData，绝不碰用户真实的角色卡库
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-uidup-'));
app.setPath('userData', TMP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // 注册真实的 IPC 处理器——不注册的话设定界面一打开就会报
  // "No handler registered for 'module:list'"，测不到真实路径
  const ipc = require(path.join(ROOT, 'electron', 'ipc-files.js'));
  const win = new BrowserWindow({
    width: 1440, height: 920, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  ipc.registerSaveIpc();
  ipc.registerModuleIpc(() => win);
  ipc.registerCharIpc();
  ipc.registerStoreIpc();

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(1500);

  // 打开设定界面（和用户点「开始」后看到的是同一个）
  const opened = await win.webContents.executeJavaScript(`
    (async () => {
      const mod = await import('./modals/gameSetup.js');
      window.__setup = mod.openGameSetup({
        onStart: () => {},
        state: window.state || null,
        api: window.api || null
      });
      await window.__setup;
      return true;
    })()
  `).catch((e) => ({ error: String(e) }));

  if (opened && opened.error) {
    console.log('★ 无法打开设定界面:', opened.error);
    app.exit(1);
    return;
  }

  await sleep(1200);

  // 找到玩家角色卡的「存库」按钮并连点 3 次
  const clicked = await win.webContents.executeJavaScript(`
    (async () => {
      // 第一行就是玩家角色卡（label「你扮演」）
      const rows = [...document.querySelectorAll('.char-row')];
      // 第 0 行是玩家卡，第 1 行是队友 1
      const out = {};
      for (const [idx, kind, label] of [[0,'player','玩家卡'],[1,'ai','队友卡']]) {
        const btn = rows[idx]?.querySelector('[data-act="save"]');
        if (!btn) { out[kind] = { error: '没找到第 ' + idx + ' 行的存库按钮' }; continue; }
        for (let i = 0; i < 3; i++) {
          btn.click();
          await new Promise(r => setTimeout(r, 350));
        }
        const list = await window.api.listChars(kind);
        out[kind] = {
          label,
          count: list.length,
          names: list.map(e => e.name),
          charIds: list.map(e => e.char && e.char.id),
          entryIds: list.map(e => e.id)
        };
      }
      out.flash = (document.querySelector('#companionFlash') || {}).textContent || '';
      return out;
    })()
  `);

  console.log('=== 连点「存库」3 次后的结果 ===');
  console.log(JSON.stringify(clicked, null, 2));

  let code = 0;
  for (const kind of ['player', 'ai']) {
    const r = clicked[kind] || {};
    if (r.error) {
      console.log(`★ ${kind}: ${r.error}`);
      code = 1;
    } else if (r.count === 1) {
      console.log(`✓ ${r.label}：库里只有 1 份`);
    } else {
      console.log(`★ ${r.label}：库里有 ${r.count} 份（期望 1 份）`);
      code = 1;
    }
  }

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(code);
});
