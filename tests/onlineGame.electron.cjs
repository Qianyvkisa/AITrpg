'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const prefix = path.join(tmpdir(), 'coc-online-ui-');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const runtime = process.env.COC_TEST_ELECTRON || require('electron');
  const dataRoot = mkdtempSync(prefix);
  const env = { ...process.env, COC_TEST_DATA_ROOT: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(runtime, [__filename], { stdio: 'inherit', windowsHide: true, timeout: 60000, env });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    if (dataRoot.startsWith(prefix)) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 4 });
  }
  return;
}

const { app, BrowserWindow, ipcMain } = require('electron');
const { registerNetIpc } = require('../electron/net-ipc');
const { registerConfigIpc } = require('../electron/config');
const { registerSaveIpc } = require('../electron/ipc-files');
const { writeJSON } = require('../electron/storage');
const { Client } = require('../electron/net/client');
const { Host } = require('../electron/net/host');

const dataRoot = process.env.COC_TEST_DATA_ROOT;
app.setPath('userData', dataRoot);
app.disableHardwareAcceleration();

async function until(description, getValue) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const value = await getValue();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`超时：${description}`);
}

app.whenReady().then(async () => {
  let win;
  let guest;
  let remote;
  try {
    const { createInitialState } = await import('../src/state.js');
    const { createCharacter } = await import('../src/core/character.js');
    const { buildSnapshot } = await import('../src/persistence.js');
    const { publicRoomState } = await import('../src/core/onlineSession.js');
    const state = createInitialState();
    state.playerChar = createCharacter({ name: '房主调查员', isPlayer: true });
    const character = createCharacter({ name: '客席调查员' });
    state.teammates = [character];
    state.scenario.scene = '旧宅';
    state.turns = 1;
    state.messages.push({ id: 'opening-action', role: 'user', text: '我来到旧宅门前。' });
    writeJSON('save-auto.json', buildSnapshot(state));

    registerConfigIpc();
    registerSaveIpc();
    registerNetIpc(() => win);
    const replies = ['你听见响动。[[SAN:2/2]]', '响动平息了。'];
    ipcMain.handle('llm:chat', (_event, request) => {
      assert.equal(request.purpose, 'keeper');
      assert.ok(replies.length, '模型调用不应多于两次');
      if (replies.length === 1) assert.match(request.messages.at(-1).content, /损失 2 点 SAN/);
      return { ok: true, text: replies.shift() };
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false }
    });
    win.webContents.on('preload-error', (_event, _preload, error) => console.error(error));
    const run = (code) => win.webContents.executeJavaScript(code);
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
    await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
    await run('window.alert = (message) => console.error(message); true');
    await until('继续按钮', () => run('!document.querySelector("#menuContinue").hidden'));
    await click('#menuContinue');
    await until('跑团界面', () => run('!document.querySelector("#app").hidden'));
    await click('#btnOnline');
    await until('开房按钮', () => run('!!document.querySelector("#btnHostStart")'));
    await click('#btnHostStart');
    const port = await until('房主开房', () => run('window.api.net.hostPlayers().then((r) => r.port)'));
    guest = new Client({ host: '127.0.0.1', port, name: '客人' });
    const received = [];
    guest.on('message', (message) => received.push(message));
    guest.on('error', (error) => console.error(error));
    const { playerId } = await guest.connect();
    guest.ready();
    await until('客人收到公开快照', () => received.find((message) => message.reset && message.state.ready));
    guest.claim(character.id);
    await until('房主确认认领', () => received.find((message) => message.players?.some((player) => player.charId === character.id)));
    await until('认领后房主空闲', () => received.findLast((message) => message.state)?.state.busy === false);
    guest.action('走进旧宅。');
    const roll = await until('客人收到待掷骰', () => received.flatMap((message) => message.messages || [])
      .find((message) => message.data?.status === 'pending'));
    assert.equal(roll.data.ownerId, playerId);
    assert.equal(roll.data.charId, character.id);
    await until('房主等待客人掷骰', () => run('document.querySelector(".roll-btn")?.disabled'));
    await until('房主结算前空闲', () => received.findLast((message) => message.state)?.state.busy === false);
    guest.roll(roll.data.id);
    await until('客人收到房主续写', () => received.flatMap((message) => message.messages || [])
      .some((message) => message.text === '响动平息了。'));
    await until('房主与客人的 SAN 同步', () => received.some((message) => message.state?.teammates[0]?.san.current === character.san.current - 2));
    assert.equal(await run('document.querySelector("#messages").textContent.includes("响动平息了。")'), true);
    assert.equal(replies.length, 0);
    guest.close('left room');
    guest = null;
    await until('解散房间按钮', () => run('!!document.querySelector("#btnHostStop")'));
    await click('#btnHostStop');
    await until('联机面板恢复入口', () => run('!!document.querySelector("#btnJoinManual")?.onclick'));

    // 换成本机窗口作为客人，验证真实的认领和行动按钮会通过 IPC 发给房主。
    remote = new Host();
    const info = await remote.start();
    const room = publicRoomState(state, { ready: true, busy: false });
    let actionText;
    let rollId;
    remote.on('ready', ({ player }) => remote.sendTo(player.id, 'patch', { reset: true, state: room, messages: [] }));
    remote.on('claim', ({ player, charId }) => remote.setPlayerChar(player.id, charId));
    remote.on('action', ({ player, text }) => {
      actionText = text;
      remote.sendTo(player.id, 'patch', { messages: [{
        id: 'remote-roll', role: 'roll', text: '等待掷骰',
        data: { id: 'pending-1', status: 'pending', ownerId: player.id, who: character.name }
      }] });
    });
    remote.on('roll', ({ player, pendingId }) => {
      rollId = pendingId;
      remote.sendTo(player.id, 'patch', {
        messages: [{ id: 'remote-roll', role: 'roll', text: '房主结算完成', data: { status: 'rolled' } }]
      });
    });
    await run(`document.querySelector('#joinHost').value = '127.0.0.1'; document.querySelector('#joinPort').value = '${info.port}'; true`);
    await click('#btnJoinManual');
    await until('客人窗口显示认领按钮', () => run('!!document.querySelector("[data-claim]")'));
    await click('[data-claim]');
    await until('客人认领后允许输入', () => run('!document.querySelector("#btnSend").disabled'));
    await click('.online-modal [data-close]');
    await run('document.querySelector("#input").value = "在门口聆听。"; true');
    await click('#btnSend');
    await until('远端收到客人行动', () => actionText === '在门口聆听。');
    await until('客人窗口可掷自己的骰', () => run('document.querySelector(".roll-btn")?.disabled === false'));
    await click('.roll-btn');
    await until('客人收到结算并移除待掷骰按钮', () => run('!document.querySelector(".roll-btn") && document.querySelector("#messages").textContent.includes("房主结算完成")'));
    assert.equal(rollId, 'pending-1');

    console.log('Electron 联机通过：房主推进、客人认领与掷骰、双端公开状态同步。');
  } finally {
    guest?.close();
    if (remote) await remote.close();
    win?.destroy();
  }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
