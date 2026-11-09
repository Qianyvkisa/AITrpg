// ---------------------------------------------------------------------------
// v0.2.1 端到端验证：真的点一次「AI 生成」按钮
//
// 上一个脚本（verify-prompt.cjs）验证了 openPrompt 本身能用；
// 这个脚本走完整链路：打开角色卡编辑器 → 点 #btnAIGen → 弹出输入框
// → 填内容点确定 → 确认真的发出了 AI 请求（用桩 chat 函数拦截）。
//
// 用法：.dev-electron\electron.exe tools\ui\verify-aigen.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

app.whenReady().then(async () => {
  // 最小 IPC 桩，让页面能正常启动
  const stubs = {
    'config:get': () => ({}),
    'chars:list': () => [],
    'modules:list': () => [],
    'save:read': () => null,
    'save:write': () => ({ ok: true })
  };
  for (const [ch, fn] of Object.entries(stubs)) {
    try { ipcMain.handle(ch, fn); } catch { /* 已注册过就跳过 */ }
  }

  const win = new BrowserWindow({
    width: 1400, height: 950, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });

  win.webContents.on('console-message', (_e, _lvl, message) => {
    note(`[renderer] ${message}`);
  });

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const out = { steps: [] };
      const push = (name, ok, detail) => out.steps.push({ name, ok, detail: detail || '' });

      const { openCharEditor } = await import('./modals/charEditor.js');
      const { createCharacter } = await import('./core/character.js');

      const ch = createCharacter({ name: '待生成', isPlayer: true });
      ch.occupation = '记者';

      // 记录 AI 是否真的被调用
      let chatCalled = false;
      let chatPurpose = '';
      const fakeApi = {
        chat: async (cfg) => {
          chatCalled = true;
          chatPurpose = cfg.purpose || '';
          return {
            ok: true,
            text: JSON.stringify({
              name: '林晚', occupation: '记者', age: 29, gender: '女', era: '1920s',
              attrs: { STR: 45, CON: 50, SIZ: 55, DEX: 60, APP: 65, INT: 75, POW: 60, EDU: 80 },
              skills: { '侦查': 55, '聆听': 45 },
              backstory: '端到端测试'
            })
          };
        }
      };

      const state = {
        apiConfig: { baseUrl: 'http://stub', apiKey: 'k', model: 'm' },
        tone: '经典恐怖',
        teammates: []
      };

      openCharEditor(ch, { title: 'E2E', state, api: fakeApi });

      const btn = document.querySelector('#btnAIGen');
      push('AI 生成按钮存在', !!btn);
      if (!btn) return out;

      // 点按钮（不 await，它内部在等 openPrompt）
      btn.click();

      // 等输入框出现
      await new Promise((r) => setTimeout(r, 120));
      const input = document.querySelector('#promptInput');
      push('点击后弹出创作方向输入框', !!input);

      if (!input) {
        push('按钮没有静默失败', false, '没弹窗说明点击链路断了');
        return out;
      }

      // 填内容并确定
      input.value = '1920s 的华裔女记者';
      document.querySelector('#promptOk').click();

      // 等 AI 调用完成 + 角色卡写回
      for (let i = 0; i < 60 && !chatCalled; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      push('AI 请求真的发出了', chatCalled, chatPurpose);

      // 等生成结果写回编辑器。
      // 注意：编辑器操作的是副本（work），点保存才写回原卡——
      // 所以这里验证的是「姓名输入框里显示的名字变了」，而不是 ch.name。
      await new Promise((r) => setTimeout(r, 400));
      const nameInput = document.querySelector('#fName');
      push('编辑器表单已显示 AI 生成的名字',
        !!nameInput && nameInput.value === '林晚',
        '表单姓名=' + (nameInput ? nameInput.value : 'null'));

      // 再点保存，确认能写回原卡
      const saveBtn = document.querySelector('#btnSaveChar');
      push('保存按钮存在', !!saveBtn);
      if (saveBtn) {
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 120));
        push('保存后写回原卡', ch.name === '林晚', '当前姓名=' + ch.name);
      }

      return out;
    })()
  `);

  let failed = 0;
  for (const s of result.steps) {
    note(`${s.ok ? '  OK  ' : '  FAIL'} ${s.name}${s.detail ? '  (' + s.detail + ')' : ''}`);
    if (!s.ok) failed++;
  }
  note(`\n通过 ${result.steps.length - failed} 项，失败 ${failed} 项`);

  fs.writeFileSync(path.join(ROOT, 'tools', 'ui', 'verify-aigen.log'), log.join('\n'), 'utf8');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('验证脚本出错：', e);
  app.exit(2);
});
