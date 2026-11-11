// ---------------------------------------------------------------------------
// 上下文压缩 + replay 导出 + token 估算 的单元测试
// ---------------------------------------------------------------------------

import {
  compactHistory,
  estimateTokens,
  estimateMessagesTokens,
  DEFAULT_HISTORY_BUDGET
} from '../src/core/contextBudget.js';
import { buildReplay, replayFileName } from '../src/core/replay.js';

let passed = 0, failed = 0;
const failures = [];
function ok(c, n) { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } }
function eq(a, b, n) { ok(a === b, `${n}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

/** 造一条历史消息（OpenAI 格式 + _src） */
function msg(role, content, src = {}) {
  return { role, content, _src: { role, text: content, ...src } };
}

// ---------------------------------------------------------------------------
console.log('\n== token 估算 ==');

{
  eq(estimateTokens(''), 0, '空串是 0');
  eq(estimateTokens(null), 0, 'null 是 0');

  // 中文：1 字 ≈ 1 token
  const cn = '这是一个测试';
  eq(estimateTokens(cn), 6, '6 个汉字 ≈ 6 token');

  // 英文：4 字符 ≈ 1 token
  const en = 'abcdefgh';
  eq(estimateTokens(en), 2, '8 个英文字符 ≈ 2 token');

  ok(estimateTokens('中文中文') > estimateTokens('abcdefgh'), '中文比同长度英文贵');
}

{
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' }
  ];
  const t = estimateMessagesTokens(msgs);
  // 每条 +4 的结构开销
  ok(t >= 2 + 3 + 8, `消息总估算含结构开销（实际 ${t}）`);
  eq(estimateMessagesTokens([]), 0, '空数组是 0');
}

// ---------------------------------------------------------------------------
console.log('\n== 压缩：预算内不动 ==');

{
  const msgs = [msg('user', '短消息'), msg('assistant', '短回复')];
  const r = compactHistory(msgs, { budget: 10000 });

  eq(r.stats.compacted, false, '远低于预算时不压缩');
  eq(r.messages.length, 2, '条数不变');
  eq(r.stats.beforeTokens, r.stats.afterTokens, 'token 不变');
}

// ---------------------------------------------------------------------------
console.log('\n== 压缩：滤掉噪音 ==');

{
  const msgs = [
    msg('assistant', ''),                                   // 空占位（失败的 KP 回复）
    msg('user', '【自动推进已暂停】有检定等你掷骰'),
    msg('user', '【连接不稳定】模型服务暂时没响应'),
    msg('assistant', '真正的剧情内容')
  ];
  const r = compactHistory(msgs, { budget: 10000 });

  eq(r.messages.length, 1, '噪音全被滤掉，只剩 1 条');
  eq(r.messages[0].content, '真正的剧情内容', '保留的是正文');
  eq(r.stats.dropped, 3, '统计记录了丢弃 3 条');
}

// ---------------------------------------------------------------------------
console.log('\n== 压缩：超预算时折叠成前情提要 ==');

{
  // 造 30 条长消息，必定超预算
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push(msg(i % 2 ? 'assistant' : 'user', `第${i}段剧情：` + '他们继续往前走，四周一片漆黑。'.repeat(8)));
  }
  const r = compactHistory(msgs, { budget: 400 });

  eq(r.stats.compacted, true, '超预算触发压缩');
  ok(r.stats.afterTokens <= 400, `压缩后落在预算内（${r.stats.afterTokens} <= 400）`);
  ok(r.stats.afterTokens < r.stats.beforeTokens, '确实变小了');
  ok(r.stats.summarized > 0, '有消息被折叠成摘要');

  // 第一条应是「前情提要」
  ok(/前情提要/.test(r.messages[0].content), '开头是前情提要');
  ok(/细节已省略/.test(r.messages[0].content), '说明细节被省略');
}

{
  // 近处历史必须原样保留（连贯性靠它）
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(msg('assistant', 'X'.repeat(200) + `#${i}`));
  }
  const r = compactHistory(msgs, { budget: 300 });

  const last = r.messages[r.messages.length - 1];
  ok(/#19/.test(last.content), '最后一条（最新的）原样保留');
  ok(!/前情提要/.test(last.content), '最后一条不是摘要');
}

// ---------------------------------------------------------------------------
console.log('\n== 压缩：检定信息进摘要时保留因果 ==');

{
  const msgs = [
    {
      role: 'user',
      content: '检定结果',
      _src: {
        role: 'roll',
        text: '【检定结果】何九 · 侦查\n目标值 85，掷骰 95 → 失败',
        data: { kind: 'check', who: '何九', skill: '侦查', level: { level: 'failure', label: '失败' } }
      }
    },
    ...Array.from({ length: 30 }, (_, i) => msg('assistant', 'Z'.repeat(200) + `#${i}`))
  ];
  const r = compactHistory(msgs, { budget: 300 });
  const summary = r.messages[0].content;

  ok(/何九/.test(summary), '摘要里保留了谁掷的');
  ok(/侦查/.test(summary), '摘要里保留了什么技能');
  ok(/失败/.test(summary), '摘要里保留了结果');
}

// ---------------------------------------------------------------------------
console.log('\n== 压缩：极端预算不崩 ==');

{
  const msgs = [msg('assistant', 'A'.repeat(5000))];
  const r = compactHistory(msgs, { budget: 10 });
  ok(Array.isArray(r.messages), '预算极小时不抛异常');
  ok(r.stats.compacted, '标记为已压缩');

  eq(compactHistory(null, {}).messages.length, 0, 'null 输入返回空数组');
  eq(compactHistory(undefined, {}).messages.length, 0, 'undefined 输入返回空数组');
  eq(compactHistory([], {}).messages.length, 0, '空数组返回空数组');
}

{
  // 默认预算是个合理正数
  ok(DEFAULT_HISTORY_BUDGET > 1000 && DEFAULT_HISTORY_BUDGET < 100000, '默认预算在合理区间');
}

// ---------------------------------------------------------------------------
console.log('\n== replay 导出：说话人与动作要分清 ==');

{
  const state = {
    module: { title: '测试模组' },
    mode: 'spectator',
    turns: 3,
    messages: [
      { role: 'keeper', text: '雨夜，你们围坐在桌前。', clean: '雨夜，你们围坐在桌前。', ts: 1700000000000 },
      { role: 'user', text: '我检查桌上的东西', ts: 1700000060000 },
      { role: 'teammate', name: '何九', text: '别碰那个。', ts: 1700000120000 },
      { role: 'teammate-action', name: '何九', text: '他走到门边蹲下。', ts: 1700000180000 },
      {
        role: 'roll',
        text: '【检定结果】何九 · 侦查\n目标值 85，掷骰 95 → 失败',
        ts: 1700000240000,
        data: {
          kind: 'check', who: '何九', skill: '侦查', difficulty: '常规',
          baseSkill: 85, adjusted: 85,
          roll: { value: 95 },
          level: { level: 'failure', label: '失败' }
        }
      },
      { role: 'clue', text: '【线索】墙上有血迹', ts: 1700000300000 },
      { role: 'scene', text: '【场景】客厅', ts: 1700000360000 }
    ],
    scenario: { clues: ['墙上有血迹'], scene: '客厅' }
  };

  const txt = buildReplay(state);

  ok(/测试模组/.test(txt), '包含模组名');
  ok(/▶ 玩家：我检查桌上的东西/.test(txt), '玩家行动标出说话人');
  ok(/💬 何九：别碰那个。/.test(txt), '队友台词标出是谁说的');
  ok(/🎬 何九（行动）：/.test(txt), '队友动作与台词区分开');

  // 投点：谁、什么技能、目标值、掷出、结果 都要有
  ok(/🎲 何九 掷 侦查/.test(txt), '投点标出谁掷什么');
  ok(/目标 85/.test(txt), '投点包含目标值');
  ok(/掷出 95/.test(txt), '投点包含掷骰结果');
  ok(/→ 失败/.test(txt), '投点包含成败');
  ok(!/→ failure/.test(txt), '不把英文枚举漏进文本');

  ok(/🔍 线索：墙上有血迹/.test(txt), '线索单独标记');
  ok(/📍 场景：客厅/.test(txt), '场景单独标记');

  // 结尾状态
  ok(/已发现的线索/.test(txt), '结尾附线索清单');
}

{
  // 默认推进语不该被当成玩家原话
  const state = {
    messages: [{ role: 'user', text: '（继续推进剧情，让调查员们继续行动）' }]
  };
  const txt = buildReplay(state);
  ok(/（继续推进）/.test(txt), '默认推进语被简化标注');
  ok(!/让调查员们继续行动/.test(txt), '不把系统默认语当玩家原话');
}

{
  // 空消息 / 噪音不污染导出
  const state = {
    messages: [
      { role: 'keeper', text: '', clean: '' },
      { role: 'system', text: '【连接不稳定】正在自动重试' },
      { role: 'keeper', text: '真实内容', clean: '真实内容' }
    ]
  };
  const txt = buildReplay(state);
  ok(/真实内容/.test(txt), '保留真实内容');
  ok(!/正在自动重试/.test(txt), '网络噪音被跳过');
}

{
  // 大成功要标星
  const state = {
    messages: [{
      role: 'roll', text: '', ts: 1700000000000,
      data: {
        kind: 'check', who: '甲', skill: '聆听', adjusted: 50,
        roll: { value: 1 }, level: { level: 'critical', label: '大成功' }
      }
    }]
  };
  const txt = buildReplay(state);
  ok(/★/.test(txt), '大成功带星标');
}

// ---------------------------------------------------------------------------
console.log('\n== replay 文件名 ==');

{
  const name = replayFileName({ module: { title: '海面之梦' } }, new Date(2026, 10, 11, 15, 30));
  ok(/^跑团记录-海面之梦-20261111-1530\.txt$/.test(name), `文件名格式正确（实际 ${name}）`);

  // 非法字符要被替换，否则 Windows 存不了
  const bad = replayFileName({ module: { title: 'a/b:c*d?e"f<g>h|i' } });
  ok(!/[\\/:*?"<>|]/.test(bad), '非法字符已替换');

  const noMod = replayFileName({});
  ok(/自由创作/.test(noMod), '没有模组时用默认名');
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(42));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('全部通过');
}
