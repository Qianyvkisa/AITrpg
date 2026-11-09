// ---------------------------------------------------------------------------
// v0.2.1 端到端验证：AI 生成的卡，技能点必须花完
//
// 走真实浏览器环境（真 DOM + 真模块），只把 chat 换成桩，
// 然后用编辑器里同一套 skillPointBudget 算账，确认「剩 0」。
//
// 用法：.dev-electron\electron.exe tools\ui\verify-points.cjs
// ---------------------------------------------------------------------------

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const log = [];
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

app.whenReady().then(async () => {
  const stubs = {
    'config:get': () => ({}), 'chars:list': () => [], 'modules:list': () => [],
    'save:read': () => null, 'save:write': () => ({ ok: true })
  };
  for (const [ch, fn] of Object.entries(stubs)) {
    try { ipcMain.handle(ch, fn); } catch { /* ignore */ }
  }

  const win = new BrowserWindow({
    width: 1400, height: 950, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (_e, _l, m) => note(`[renderer] ${m}`));

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const out = { steps: [] };
      const push = (name, ok, detail) => out.steps.push({ name, ok, detail: detail || '' });

      const { generateCharacter } = await import('./services/charGen.js');
      const { SKILL_DEFS, baseSkillValue } = await import('./core/character.js');
      const { skillPointBudget, isOccupationalSkill, OCCUPATIONS } = await import('./core/occupations.js');

      const budgetOf = (c) => {
        const baseOf = (n) => {
          const d = SKILL_DEFS.find((x) => x.name === n);
          return d ? baseSkillValue(d, c.attrs) : 0;
        };
        const isOcc = (n) => isOccupationalSkill(c, n, (c.customNames || {})[n] || '');
        return skillPointBudget(c, baseOf, isOcc);
      };

      // 模拟 AI 只给很少技能（最糟情况）
      const mkApi = (occ) => ({
        chat: async () => ({
          ok: true,
          text: JSON.stringify({
            name: '测试', occupation: occ, age: 30, gender: '男', era: '1920s',
            attrs: { STR: 50, CON: 55, SIZ: 60, DEX: 65, APP: 45, INT: 90, POW: 60, EDU: 90 },
            skills: { '侦查': 45 },
            backstory: 'x'
          })
        })
      });

      const cfg = { baseUrl: 'http://stub', apiKey: 'k', model: 'm' };

      // 1) 抽查几个典型职业
      for (const occ of ['记者', '法医', '医疗技术员', '科学搜查研究员', '医生', '士兵']) {
        const res = await generateCharacter(cfg, { role: 'player', occupation: occ }, mkApi(occ));
        if (!res.ok) { push(occ + ' 生成', false, res.error); continue; }
        const b = budgetOf(res.char);
        push(occ + ' 点数花完',
          b.occLeft === 0 && b.intLeft === 0,
          '职业剩' + b.occLeft + '/兴趣剩' + b.intLeft);
      }

      // 2) 全职业扫描（AI 一项技能都不给，EDU/INT 拉满）
      const bad = [];
      const mkApiEmpty = (occ) => ({
        chat: async () => ({
          ok: true,
          text: JSON.stringify({
            name: '测试', occupation: occ, age: 30, gender: '男', era: '1920s',
            attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 99, POW: 50, EDU: 99 },
            skills: {}, backstory: 'x'
          })
        })
      });
      for (const o of OCCUPATIONS) {
        const res = await generateCharacter(cfg, { role: 'player', occupation: o.name }, mkApiEmpty(o.name));
        if (!res.ok) continue;
        const b = budgetOf(res.char);
        if (b.occLeft > 0 || b.intLeft > 0) {
          bad.push(o.name + '(剩' + b.occLeft + '/' + b.intLeft + ')');
        }
      }
      push('全 ' + OCCUPATIONS.length + ' 职业在极端条件下都无剩余',
        bad.length === 0, bad.slice(0, 5).join('、'));

      return out;
    })()
  `);

  let failed = 0;
  for (const s of result.steps) {
    note(`${s.ok ? '  OK  ' : '  FAIL'} ${s.name}${s.detail ? '  (' + s.detail + ')' : ''}`);
    if (!s.ok) failed++;
  }
  note(`\n通过 ${result.steps.length - failed} 项，失败 ${failed} 项`);

  fs.writeFileSync(path.join(ROOT, 'tools', 'ui', 'verify-points.log'), log.join('\n'), 'utf8');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('验证脚本出错：', e); app.exit(2); });
