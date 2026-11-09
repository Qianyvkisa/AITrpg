// ---------------------------------------------------------------------------
// v0.2.1 端到端验证：AI 生成按钮 + openPrompt 弹窗
//
// 为什么要在真 Electron 里验：
//   这个 bug 的本质是「Electron 不支持 window.prompt」，
//   任何 Node 里的 DOM 桩都复现不出来——桩里 prompt 被我们自己的测试代码
//   替换成了 () => null，所以测试永远绿、线上永远坏。
//   只有在真 Chromium 渲染进程里跑，才能确认修复真的生效。
//
// 用法：.dev-electron\electron.exe tools\ui\verify-prompt.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

app.whenReady().then(async () => {
  // 注册主进程 IPC，否则页面启动时会因为 config:get 没有 handler 而报错
  try {
    const files = require(path.join(ROOT, 'electron', 'ipc-files.js'));
    if (files.registerRuleBookIpc) files.registerRuleBookIpc();
    const { ipcMain } = require('electron');
    // 页面启动需要的几个 handler 给个最小实现
    ipcMain.handle('config:get', () => ({}));
    ipcMain.handle('chars:list', () => []);
    ipcMain.handle('modules:list', () => []);
  } catch (e) {
    note('注册 IPC 时出错（可忽略）：' + e.message);
  }

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    note(`[renderer] ${message}`);
  });

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const out = { steps: [] };
      const push = (name, ok, detail) => out.steps.push({ name, ok, detail: detail || '' });

      // 1) 确认 window.prompt 在 Electron 里真的不可用
      try {
        window.prompt('x');
        push('window.prompt 可用性', false, '居然没抛错（预期应该抛）');
      } catch (e) {
        push('window.prompt 确实不可用', true, e.message.slice(0, 60));
      }

      // 2) 加载 shell.js 的 openPrompt，验证它能在真 DOM 里弹出并返回
      //    注意用相对页面路径，不能写 '/src/...'（file:// 下会解析到盘根）
      const shell = await import('./modals/shell.js');
      push('shell.js 导出 openPrompt', typeof shell.openPrompt === 'function');

      const p = shell.openPrompt({
        title: '端到端验证',
        message: '第一行\\n第二行',
        placeholder: '输入点什么',
        value: '初始值'
      });

      const input = document.querySelector('#promptInput');
      push('输入框已渲染到真实 DOM', !!input);

      const msg = document.querySelector('.prompt-msg');
      push('说明文字已渲染', !!msg, msg ? msg.textContent.replace(/\\n/g, '|').slice(0, 30) : '');

      const okBtn = document.querySelector('#promptOk');
      const cancelBtn = document.querySelector('#promptCancel');
      push('确定/取消按钮已渲染', !!okBtn && !!cancelBtn);

      if (input) {
        input.value = '1920s 的华裔记者';
        okBtn.click();
        const v = await p;
        push('点确定返回输入内容', v === '1920s 的华裔记者', JSON.stringify(v));
      }

      // 3) 取消语义
      const p2 = shell.openPrompt({ title: '取消验证' });
      const c2 = document.querySelector('#promptCancel');
      if (c2) { c2.click(); }
      const v2 = await p2;
      push('点取消返回 null', v2 === null, JSON.stringify(v2));

      // 4) 弹窗关闭后 DOM 干净
      push('弹窗已移除', !document.querySelector('#promptInput'));

      return out;
    })()
  `);

  let failed = 0;
  for (const s of result.steps) {
    note(`${s.ok ? '  OK  ' : '  FAIL'} ${s.name}${s.detail ? '  (' + s.detail + ')' : ''}`);
    if (!s.ok) failed++;
  }
  note(`\\n通过 ${result.steps.length - failed} 项，失败 ${failed} 项`);

  fs.writeFileSync(
    path.join(ROOT, 'tools', 'ui', 'verify-prompt.log'),
    log.join('\\n'),
    'utf8'
  );

  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('验证脚本出错：', e);
  app.exit(2);
});
