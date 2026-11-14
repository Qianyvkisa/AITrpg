// ---------------------------------------------------------------------------
// 联机面板：开房 / 加入
//
// 交互设计上刻意做成「两步」：
//   房主点「开房」→ 直接把房间码和 IP 亮出来，能一键复制
//   朋友点「加入」→ 优先列出局域网里扫到的房间，点一下就连；扫不到再手填
//
// 抄 IP 是这个流程里最容易出错的一步，所以能自动发现就一定不让人手输。
// ---------------------------------------------------------------------------

import { openModal } from './shell.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * 打开联机面板。
 *
 * @param {object} opts
 * @param {object} opts.state 全局状态，用来判断当前是单人还是已在联机
 * @param {(info: object) => void} [opts.onHosted] 开房成功回调
 * @param {(info: object) => void} [opts.onJoined] 加入成功回调
 * @param {() => void} [opts.onLeft] 离开房间回调
 */
export function openOnline({ state, onHosted, onJoined, onLeft } = {}) {
  const net = window.api?.net;
  if (!net) {
    alert('联机功能不可用（预加载脚本没有暴露 net）');
    return;
  }

  const { backdrop, close } = openModal(`
    <div class="modal online-modal">
      <div class="modal-head">
        <h2>联机</h2>
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="modal-body" id="onlineBody">
        <div class="online-loading">正在检查局域网…</div>
      </div>
    </div>
  `);

  const body = backdrop.querySelector('#onlineBody');
  let unsubscribeRooms = null;
  let unsubscribers = [];

  /** 面板关闭时一定要解绑，否则监听器会在每次开面板时累积 */
  const cleanup = () => {
    if (unsubscribeRooms) { unsubscribeRooms(); unsubscribeRooms = null; }
    for (const off of unsubscribers) {
      try { off(); } catch (e) { /* 已经解绑 */ }
    }
    unsubscribers = [];
    net.scanStop();
  };

  /**
   * 注册一次性的玩家变动监听。
   * 关键点：回调里只重画，不重新注册——否则每次重画都会多一套监听器，
   * 十几次进出之后一次事件会触发十几次重画。
   */
  const watchPlayers = () => {
    if (unsubscribers.length) return;
    const repaint = () => { render(); };
    unsubscribers.push(
      net.onPlayerJoined(repaint),
      net.onPlayerOffline(repaint),
      net.onPlayerReconnected(repaint)
    );
  };

  // 点遮罩或 × 关闭时也要清理
  const origClose = close;
  const closeAndCleanup = () => { cleanup(); origClose(); };
  backdrop.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = closeAndCleanup;
  });

  // -------------------------------------------------------------------------
  // 主视图
  // -------------------------------------------------------------------------
  async function render() {
    const [hostRes, clientRes] = await Promise.all([
      net.hostPlayers().catch(() => ({ ok: false })),
      net.clientStatus().catch(() => ({ ok: false }))
    ]);

    if (hostRes.ok) return renderHosting(hostRes);
    if (clientRes.ok) return renderJoined(clientRes);
    return renderChooser();
  }

  // -------------------------------------------------------------------------
  // 未联机：选择开房还是加入
  // -------------------------------------------------------------------------
  async function renderChooser() {
    body.innerHTML = `
      <div class="online-split">
        <div class="online-card">
          <h3>开房（我做房主）</h3>
          <p class="online-hint">
            你这一局由你的机器跑 AI。朋友连上来只需要发文字，
            不用配 API Key、不用装模型。
          </p>
          <label class="online-field">
            <span>我的名字</span>
            <input id="hostName" type="text" maxlength="24" placeholder="守秘人" value="${esc(state?.netName || '守秘人')}">
          </label>
          <label class="online-field">
            <span>最多几人</span>
            <select id="hostMax">
              <option value="2">2 人</option>
              <option value="3" selected>3 人</option>
              <option value="4">4 人</option>
            </select>
          </label>
          <button class="btn" id="btnHostStart">开房</button>
        </div>

        <div class="online-card">
          <h3>加入（我是玩家）</h3>
          <p class="online-hint">
            同一个 WiFi 下会自动列出房间，点一下就连。
            不在同一个网络时需要房主做端口转发。
          </p>
          <label class="online-field">
            <span>我的名字</span>
            <input id="joinName" type="text" maxlength="24" placeholder="调查员" value="${esc(state?.netName || '调查员')}">
          </label>
          <div class="online-rooms" id="roomList">
            <div class="online-loading">正在搜索局域网里的房间…</div>
          </div>
          <details class="online-manual">
            <summary>手动输入地址</summary>
            <div class="online-manual-fields">
              <label class="online-field">
                <span>房主 IP</span>
                <input id="joinHost" type="text" placeholder="192.168.1.10">
              </label>
              <label class="online-field">
                <span>端口</span>
                <input id="joinPort" type="text" placeholder="8787" value="8787">
              </label>
              <button class="btn ghost" id="btnJoinManual">连接</button>
            </div>
          </details>
        </div>
      </div>
    `;

    // 开房
    body.querySelector('#btnHostStart').onclick = async () => {
      const name = body.querySelector('#hostName').value.trim() || '守秘人';
      const maxPlayers = Number(body.querySelector('#hostMax').value) || 3;
      const btn = body.querySelector('#btnHostStart');
      btn.disabled = true;
      btn.textContent = '正在开房…';

      const res = await net.hostStart({ hostName: name, maxPlayers });
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = '开房';
        alert('开房失败：' + res.error);
        return;
      }
      if (state) state.netName = name;
      onHosted?.(res);
      render();
    };

    // 局域网房间列表
    const roomList = body.querySelector('#roomList');
    const paintRooms = (rooms) => {
      if (!rooms || rooms.length === 0) {
        roomList.innerHTML = '<div class="online-loading">没搜到房间。让房主先开房，或者手动填 IP。</div>';
        return;
      }
      roomList.innerHTML = rooms.map((r) => `
        <button class="online-room" data-room="${esc(r.roomCode)}" data-host="${esc(r.host)}" data-port="${esc(r.port)}">
          <span class="online-room-code">${esc(r.roomCode)}</span>
          <span class="online-room-meta">${esc(r.hostName || '未命名')} · ${esc(r.host)}:${esc(r.port)}</span>
        </button>
      `).join('');
      roomList.querySelectorAll('.online-room').forEach((el) => {
        el.onclick = () => doJoin(el.dataset.host, Number(el.dataset.port));
      });
    };

    unsubscribeRooms = net.onRooms(paintRooms);
    const scan = await net.scanStart();
    paintRooms(scan.rooms || []);

    // 手动加入
    body.querySelector('#btnJoinManual').onclick = () => {
      const h = body.querySelector('#joinHost').value.trim();
      const p = Number(body.querySelector('#joinPort').value.trim()) || 8787;
      if (!h) { alert('请填写房主 IP'); return; }
      doJoin(h, p);
    };

    async function doJoin(host, port) {
      const name = body.querySelector('#joinName').value.trim() || '调查员';
      const res = await net.join({ host, port, name });
      if (!res.ok) {
        alert('加入失败：' + res.error);
        return;
      }
      if (state) state.netName = name;
      cleanup();
      onJoined?.(res);
      render();
    }
  }

  // -------------------------------------------------------------------------
  // 已开房
  // -------------------------------------------------------------------------
  function renderHosting(info) {
    const rooms = info.players || [];
    body.innerHTML = `
      <div class="online-status">
        <div class="online-code-block">
          <div class="online-code-label">房间码</div>
          <div class="online-code">${esc(info.roomCode || '')}</div>
        </div>
        <div class="online-addr-block">
          <div class="online-code-label">让朋友连这个地址</div>
          <div class="online-addr" id="hostAddr">${esc(info.address || '—')}:${esc(info.port || '')}</div>
        </div>
      </div>

      <div class="online-players">
        <div class="online-players-head">
          <span>房间里的人（${rooms.filter(p => p.online).length}/${rooms.length}）</span>
        </div>
        ${rooms.length === 0
          ? '<div class="online-loading">还没有人进来。同一个 WiFi 下朋友点「加入」就能看到这个房间。</div>'
          : rooms.map((p) => `
            <div class="online-player">
              <span class="online-dot ${p.online ? 'on' : 'off'}"></span>
              <span class="online-player-name">${esc(p.name)}</span>
              <span class="online-player-char">${p.charId ? '已选角色' : '未选角色'}</span>
            </div>
          `).join('')}
      </div>

      <div class="online-actions">
        <button class="btn ghost" id="btnCopyCode">复制房间码</button>
        <button class="btn danger" id="btnHostStop">解散房间</button>
      </div>
      <p class="online-hint">
        朋友不用配 API Key——AI 和骰子都跑在你这台机器上。
      </p>
    `;

    body.querySelector('#btnCopyCode').onclick = async () => {
      const text = `${info.roomCode}  ${info.address || ''}:${info.port || ''}`.trim();
      try {
        await navigator.clipboard.writeText(text);
        const b = body.querySelector('#btnCopyCode');
        b.textContent = '已复制';
        setTimeout(() => { b.textContent = '复制房间码'; }, 1500);
      } catch (e) {
        // 剪贴板权限被拒时退化成选中文本，玩家可以自己 Ctrl+C
        const el = body.querySelector('#hostAddr');
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    };

    body.querySelector('#btnHostStop').onclick = async () => {
      await net.hostStop();
      onLeft?.();
      render();
    };

    // 有人进出就重画（监听器只注册一次，见 watchPlayers）
    watchPlayers();
  }

  // -------------------------------------------------------------------------
  // 已加入
  // -------------------------------------------------------------------------
  function renderJoined(info) {
    body.innerHTML = `
      <div class="online-status">
        <div class="online-code-block">
          <div class="online-code-label">已加入房间</div>
          <div class="online-code">${esc(info.roomCode || '—')}</div>
        </div>
        <div class="online-addr-block">
          <div class="online-code-label">房主</div>
          <div class="online-addr">${esc(info.host)}:${esc(info.port)}</div>
        </div>
      </div>
      <p class="online-hint">
        ${info.connected ? '连接正常。' : '正在重连…'}
        游戏由房主推进，你在这里只负责自己那位调查员。
      </p>
      <div class="online-actions">
        <button class="btn danger" id="btnLeave">离开房间</button>
      </div>
    `;

    body.querySelector('#btnLeave').onclick = async () => {
      await net.leave();
      onLeft?.();
      render();
    };
  }

  render();

  return {
    close: closeAndCleanup,
    refresh: render
  };
}
