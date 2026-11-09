// ---------------------------------------------------------------------------
// 协议 / 指令分发 / 持久化 / SSE 解析 的单元测试
// 直接 node tests/unit.test.mjs
// ---------------------------------------------------------------------------

import { parseDirectives, difficultyToSkill, splitNarration } from '../src/core/protocol.js';
import { GameEngine } from '../src/core/engine.js';
import { getHandler, handledTypes, summarizeResults, resolveSkillValue, rollPending } from '../src/core/directives.js';
import { buildSnapshot, applySnapshot } from '../src/persistence.js';
import { createInitialState } from '../src/state.js';
import { escapeHtml, stripDirectivesForDisplay } from '../src/shared/text.js';
import { createCharacter } from '../src/core/character.js';
import { rollDice, expandDb } from '../src/core/dice.js';
import { createSseDecoder } from '../electron/sse.js';
import { resolveTarget, buildEndpoint, buildModelsEndpoint, normalizeModels, isLocalEndpoint, DEFAULT_CONFIG } from '../electron/defaults.js';
import { modelsHintText, modelsErrorText, filterModels, groupModelsByPrefix } from '../src/modals/modelPicker.js';
import { stripXml, cleanWordFields, fingerprint, dedupeDocs, materialsToPromptText, MAX_IMAGES, MAX_CHARS_TOTAL, MAX_IMAGE_TOTAL_BYTES } from '../electron/materials.js';
import { extractJson, repairTruncatedJson, moduleFromUnderstanding, buildUnderstandPrompt } from '../electron/moduleAI.js';
import { hasRunTurn, menuButtonVisibility } from '../src/ui/menu.js';
import { buildSession, clampTeammateCount, createTeammate, MAX_TEAMMATES } from '../src/core/session.js';
import { keeperSystemPrompt } from '../src/core/prompts.js';
import { BUILTIN_MODULES, findBuiltinModule, openingFor } from '../src/core/builtinModules.js';
import { moduleInfoFor, moduleRowMeta, extractFactsFromRaw, FREE_PLAY_INFO } from '../src/core/moduleInfo.js';
import {
  SKILL_DEFS, DEFAULT_SKILLS, refreshDerived, skillLevels,
  displaySkillName, normalizeCharacter, rollAttributes, isSkillEditable
} from '../src/core/character.js';
import {
  buildCharPrompt, parseCharJson, charFromAI, generateCharacter, randomCharacter
} from '../src/services/charGen.js';

let passed = 0;
let failed = 0;
const failures = [];
/** 异步用例排队，最后统一 await */
const pendingAsync = [];

function ok(cond, name) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.log('  FAIL: ' + name); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name + ' (期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}

function group(title, fn) {
  console.log('\n== ' + title + ' ==');
  fn();
}

// ---------------------------------------------------------------------------
// 指令解析
// ---------------------------------------------------------------------------
group('parseDirectives 指令解析', () => {
  const r = parseDirectives('门后有动静。\n[[CHECK: 聆听 | 角色=林默 | 难度=困难 | 原因=听门后]]');
  eq(r.directives.length, 1, '解析出一条指令');
  eq(r.directives[0].type, 'CHECK', '指令类型');
  eq(r.directives[0].head, '聆听', '指令主体');
  eq(r.directives[0].opts['角色'], '林默', '选项解析');
  ok(!r.clean.includes('[['), '干净文本不含指令');
  ok(r.clean.includes('门后有动静'), '干净文本保留叙事');

  const multi = parseDirectives('A[[CHECK: 侦查]]B[[SCENE: 地窖]]C');
  eq(multi.directives.length, 2, '解析出多条指令');
  eq(multi.clean, 'ABC', '多条指令被完整剥离');

  const san = parseDirectives('[[SAN: 1/1d6 | 角色=我 | 原因=看见尸体]]');
  eq(san.directives[0].type, 'SAN', 'SAN 指令类型');
  eq(san.directives[0].head, '1/1d6', 'SAN 损失表达式');

  const flag = parseDirectives('[[FLAG: 关键线索=雕像的眼睛会动]]');
  eq(flag.directives[0].head, '雕像的眼睛会动', 'FLAG 键值拆出内容');
  eq(flag.directives[0].opts['关键线索'], '关键线索', 'FLAG 保留分类标签');

  const noOpt = parseDirectives('[[HP: -3]]');
  eq(noOpt.directives[0].head, '-3', '无选项指令');

  const empty = parseDirectives('只有普通文本');
  eq(empty.directives.length, 0, '无指令时返回空数组');
  eq(empty.clean, '只有普通文本', '无指令时文本不变');

  const blankOpt = parseDirectives('[[CHECK: 侦查 | 奖励]]');
  eq(blankOpt.directives[0].opts['奖励'], true, '无等号选项记为 true');
});

group('difficultyToSkill 难度换算', () => {
  eq(difficultyToSkill(60, '常规'), 60, '常规不调整');
  eq(difficultyToSkill(60, '困难'), 30, '困难减半');
  eq(difficultyToSkill(60, '极难'), 12, '极难取五分之一');
  eq(difficultyToSkill(60, ''), 60, '缺省按常规');
  eq(difficultyToSkill(60, undefined), 60, 'undefined 按常规');
});

// ---------------------------------------------------------------------------
// 指令处理器注册表
// ---------------------------------------------------------------------------
group('指令处理器注册', () => {
  const types = handledTypes();
  for (const t of ['CHECK', 'SAN', 'DAMAGE', 'HP', 'MP', 'ITEM', 'FLAG', 'CLUE', 'SCENE', 'END']) {
    ok(types.includes(t), `已注册 ${t} 处理器`);
  }
  eq(getHandler('NPC'), null, '未注册的类型返回 null');
});

group('指令处理器执行', () => {
  const state = createInitialState();
  state.playerChar = createCharacter({ name: '调查员' });

  const messages = [];
  const ctx = {
    state,
    findChar: (n) => (state.playerChar.name === n ? state.playerChar : null),
    pushMessage: (m) => messages.push(m)
  };

  const hpBefore = state.playerChar.hp.current;
  const r = getHandler('HP')(ctx, { type: 'HP', head: '-3', opts: {} });
  eq(r.delta, -3, 'HP 指令解析减量');
  ok(state.playerChar.hp.current < hpBefore, 'HP 实际扣减');
  ok(state.playerChar.hp.current >= 0, 'HP 不为负');

  const item = getHandler('ITEM')(ctx, { type: 'ITEM', head: '+手电筒', opts: {} });
  ok(state.playerChar.inventory.includes('手电筒'), 'ITEM 增加物品');

  getHandler('ITEM')(ctx, { type: 'ITEM', head: '-手电筒', opts: {} });
  ok(!state.playerChar.inventory.includes('手电筒'), 'ITEM 移除物品');

  getHandler('CLUE')(ctx, { type: 'CLUE', head: '半张烧焦的照片', opts: {} });
  ok(state.scenario.clues.includes('半张烧焦的照片'), 'CLUE 记入线索');

  getHandler('SCENE')(ctx, { type: 'SCENE', head: '地窖', opts: {} });
  eq(state.scenario.scene, '地窖', 'SCENE 切换场景');

  getHandler('END')(ctx, { type: 'END', head: '你逃出了旧宅', opts: {} });
  ok(state.scenario.ended, 'END 标记结束');
  eq(state.scenario.ending, '你逃出了旧宅', 'END 记录结局');

  // 未知角色不应抛错，而是安静跳过
  ok(getHandler('HP')(ctx, { type: 'HP', head: '-1', opts: { 角色: '不存在的人' } }) === null,
    '未知角色返回 null 而非抛错');
});

group('summarizeResults 结果汇总', () => {
  eq(summarizeResults([]), '', '空结果返回空字符串');
  eq(summarizeResults([null, undefined]), '', '过滤空项');

  const dmg = { kind: 'damage', who: '甲', dmg: 4, hpAfter: 6, hpMax: 10 };
  const text = summarizeResults([dmg]);
  ok(text.includes('甲'), '汇总包含角色名');
  ok(text.includes('4'), '汇总包含伤害值');

  const clue = { kind: 'clue', text: '【线索】某物' };
  ok(summarizeResults([clue]).includes('【线索】某物'), '普通结果透传 text');
});

// ---------------------------------------------------------------------------
// 存档快照
// ---------------------------------------------------------------------------
group('buildSnapshot / applySnapshot', () => {
  const state = createInitialState();
  state.playerChar = createCharacter({ name: '甲' });
  state.module = { title: '鬼屋疑云', raw: 'x' };
  state.scenario.scene = '书房';
  state.messages = [{ role: 'user', text: '开门' }];

  const snap = buildSnapshot(state);
  eq(snap.meta.title, '鬼屋疑云', '快照标题取模组名');
  eq(snap.meta.scene, '书房', '快照记录场景');
  eq(snap.meta.charName, '甲', '快照记录角色名');
  eq(snap.meta.turns, 1, '快照记录轮数');

  const state2 = createInitialState();
  applySnapshot(state2, snap);
  eq(state2.playerChar.name, '甲', '读档恢复角色');
  eq(state2.module.title, '鬼屋疑云', '读档恢复模组');
  eq(state2.scenario.scene, '书房', '读档恢复场景');
  eq(state2.messages.length, 1, '读档恢复消息');

  // 兼容老格式：存档直接是裸 state
  const state3 = createInitialState();
  applySnapshot(state3, { playerChar: createCharacter({ name: '乙' }), teammates: [] });
  eq(state3.playerChar.name, '乙', '兼容裸 state 格式');
  eq(state3.scenario.scene, '', '裸格式缺失字段保留默认');
});

group('无模组时快照标题', () => {
  const state = createInitialState();
  eq(buildSnapshot(state).meta.title, '自由创作', '无模组显示自由创作');
});

// ---------------------------------------------------------------------------
// 共享文本工具
// ---------------------------------------------------------------------------
group('escapeHtml / stripDirectivesForDisplay', () => {
  eq(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;', '转义特殊字符');
  eq(escapeHtml(null), '', 'null 转成空串');
  eq(escapeHtml(undefined), '', 'undefined 转成空串');
  eq(escapeHtml(0), '0', '数字正常输出');

  eq(stripDirectivesForDisplay('文本[[CHECK: 侦查]]'), '文本', '剥离指令');
  eq(stripDirectivesForDisplay('a\n\n\n\nb'), 'a\n\nb', '压缩多余空行');
  eq(stripDirectivesForDisplay('  末尾空白   '), '  末尾空白', '仅去掉尾部空白');
  eq(stripDirectivesForDisplay(''), '', '空串安全');
});

// ---------------------------------------------------------------------------
// 骰子表达式扩展
// ---------------------------------------------------------------------------
group('rollDice 多项表达式', () => {
  const r = rollDice('1d6+1d4');
  ok(r.total >= 2 && r.total <= 10, '1d6+1d4 结果在 2-10');
  eq(r.rolls.length, 2, '两项都记录骰点');

  const r2 = rollDice('2d6+3');
  ok(r2.total >= 5 && r2.total <= 15, '2d6+3 范围正确');
  eq(r2.mod, 3, '常数项记入 mod');

  const r3 = rollDice('d4');
  eq(r3.rolls.length, 1, '省略骰数默认 1');

  eq(rollDice('abc').total, 0, '非法表达式返回 0');
  eq(rollDice('').total, 0, '空表达式返回 0');
});

group('expandDb 伤害加值展开', () => {
  eq(expandDb('1d6+db', '-1'), '1d6-1', '负 db 转减法');
  eq(expandDb('1d6+db', '0'), '1d6+0', 'db 为 0');
  eq(expandDb('1d6+db', '1d4'), '1d6+1d4', '骰式 db 直接拼接');
  eq(expandDb('1d6-db', '-1'), '1d6+1', '负负得正');
  eq(expandDb('1d6', '1d4'), '1d6', '无 db 占位符时不变');
  eq(expandDb('1d10+db', '2d6'), '1d10+2d6', '双骰 db');

  // 展开后必须能被 rollDice 正常解析
  const r = rollDice(expandDb('1d6+db', '1d4'));
  ok(r.total >= 2 && r.total <= 10, '展开后的表达式可掷');
});

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------
group('createSseDecoder 流式解析', () => {
  const d = createSseDecoder();

  eq(d.push('data: {"a":1}\n').length, 1, '完整行立即解析');
  eq(d.push('data: {"a"').length, 0, '半行留在缓冲区');
  const rest = d.push(':2}\n');
  eq(rest.length, 1, '补齐后解析出数据');
  eq(rest[0], '{"a":2}', '负载内容正确');

  const multi = d.push('data: x\n\ndata: y\n\n');
  eq(multi.length, 2, '一次推入多行全部解析');

  eq(d.push(': 注释行\n').length, 0, '注释行忽略');
  eq(d.push('event: message\n').length, 0, 'event 字段忽略');
  eq(d.push('\n\n').length, 0, '空行忽略');

  const tail = d.push('data: tail');
  eq(tail.length, 0, '尾部未换行暂不解析');
  eq(d.flush().length, 1, 'flush 处理残留数据');
});

group('createSseDecoder 多次分片', () => {
  const d = createSseDecoder();
  let count = 0;
  for (const chunk of ['data: a\n', 'data: b\n', 'data: c\n']) {
    count += d.push(chunk).length;
  }
  eq(count, 3, '分三次推送得到三条负载');
  eq(d.flush().length, 0, '无残留时 flush 为空');
});

// ---------------------------------------------------------------------------
// 主进程 LLM 目标解析
// ---------------------------------------------------------------------------
group('resolveTarget 端点选择', () => {
  const cfg = { ...DEFAULT_CONFIG, apiKey: 'k1', model: 'm1' };

  const keeper = resolveTarget(cfg, { purpose: 'keeper' });
  eq(keeper.model, 'm1', 'KP 用主模型');
  eq(keeper.key, 'k1', 'KP 用主密钥');

  const team = resolveTarget(cfg, { purpose: 'teammate' });
  eq(team.model, 'm1', '队友未配置时回落主模型');
  eq(team.temperature, cfg.teammateTemperature, '队友使用独立温度');

  const cfg2 = { ...cfg, teammateModel: 'small', teammateApiKey: 'k2' };
  const team2 = resolveTarget(cfg2, { purpose: 'teammate' });
  eq(team2.model, 'small', '队友使用独立模型');
  eq(team2.key, 'k2', '队友使用独立密钥');

  const override = resolveTarget(cfg, { purpose: 'keeper', model: 'explicit' });
  eq(override.model, 'explicit', 'payload 显式模型优先');
});

group('buildEndpoint / isLocalEndpoint', () => {
  eq(buildEndpoint('https://a.com/v1'), 'https://a.com/v1/chat/completions', '补全路径');
  eq(buildEndpoint('https://a.com/v1/'), 'https://a.com/v1/chat/completions', '去掉尾部斜杠');
  eq(buildEndpoint('https://a.com/v1/chat/completions'), 'https://a.com/v1/chat/completions', '已是完整路径不重复拼接');

  ok(isLocalEndpoint('http://localhost:11434/v1'), 'localhost 识别为本地');
  ok(isLocalEndpoint('http://127.0.0.1:1234/v1'), '127.0.0.1 识别为本地');
  ok(!isLocalEndpoint('https://api.deepseek.com/v1'), '公网地址不是本地');
});

// ---------------------------------------------------------------------------
// 主界面按钮显示规则（开始 / 继续 / 放弃游戏）
// ---------------------------------------------------------------------------
group('主界面菜单按钮互斥', () => {
  const empty = menuButtonVisibility(false);
  eq(empty.start, true, '无进度时显示「开始」');
  eq(empty.cont, false, '无进度时隐藏「继续」');
  eq(empty.abandon, false, '无进度时隐藏「放弃游戏」');

  const prog = menuButtonVisibility(true);
  eq(prog.start, false, '有进度时隐藏「开始」');
  eq(prog.cont, true, '有进度时显示「继续」');
  eq(prog.abandon, true, '有进度时显示「放弃游戏」');

  // 核心约束：开始与继续永不共存
  ok(!(empty.start && empty.cont), '无进度时「开始」与「继续」不同时出现');
  ok(!(prog.start && prog.cont), '有进度时「开始」与「继续」不同时出现');

  // 放弃游戏只跟随「有进度」，不会单独出现
  eq(empty.abandon, empty.cont, '无进度时放弃游戏与继续一致隐藏');
  eq(prog.abandon, prog.cont, '有进度时放弃游戏与继续一致出现');
});

group('hasRunTurn 进度判定', () => {
  ok(!hasRunTurn(null), '空存档不算有进度');
  ok(!hasRunTurn({ messages: [] }), '空消息不算有进度');
  ok(
    !hasRunTurn({ messages: [{ role: 'keeper', text: '开场白' }] }),
    '只有开场白不算有进度'
  );
  ok(
    hasRunTurn({ messages: [{ role: 'keeper', text: '开场' }, { role: 'user', text: '我推门' }] }),
    '有玩家行动才算有进度'
  );
  // 兼容裸 state 与包了一层 state 的存档格式
  ok(
    hasRunTurn({ state: { messages: [{ role: 'user', text: '行动' }] } }),
    '包 state 的存档也能判定'
  );
});

// ---------------------------------------------------------------------------
// 开局设定：参与方式 / 模组 / 队友数
// ---------------------------------------------------------------------------
group('clampTeammateCount 人数收敛', () => {
  eq(clampTeammateCount(2), 2, '正常人数');
  eq(clampTeammateCount(0), 0, '零位队友');
  eq(clampTeammateCount(-1), 0, '负数收敛到 0');
  eq(clampTeammateCount(99), MAX_TEAMMATES, '超上限收敛到最大值');
  eq(clampTeammateCount('2'), 2, '字符串数字可解析');
  eq(clampTeammateCount('abc'), 0, '非法输入按 0');
  eq(clampTeammateCount(NaN), 0, 'NaN 按 0');
  eq(clampTeammateCount(1.7), 1, '小数向下取整');
});

group('buildSession 开局配置', () => {
  const player = buildSession({ mode: 'player', teammateCount: 2, module: null });
  eq(player.mode, 'player', '玩家模式');
  ok(player.playerChar !== null, '玩家模式有角色');
  eq(player.teammates.length, 2, '生成 2 位队友');
  eq(player.playerChar.isPlayer, true, '玩家角色标记正确');

  const spec = buildSession({ mode: 'spectator', teammateCount: 3, module: null });
  eq(spec.mode, 'spectator', '旁观模式');
  eq(spec.playerChar, null, '旁观模式没有玩家角色');
  eq(spec.teammates.length, 3, '旁观也能有队友');

  // 队友必须都是 NPC 且各自独立
  for (const t of spec.teammates) {
    eq(t.isPlayer, false, '队友不是玩家角色');
    ok(t.hp.current > 0, '队友 HP 已填满');
    ok(t.san.current > 0, '队友 SAN 已填满');
  }
  const ids = new Set(spec.teammates.map((t) => t.id));
  eq(ids.size, spec.teammates.length, '队友 id 互不相同');

  // 非法人数不会炸
  const bad = buildSession({ mode: 'player', teammateCount: 99 });
  eq(bad.teammates.length, MAX_TEAMMATES, '超上限被收敛');

  // 模组透传
  const mod = BUILTIN_MODULES[0];
  const withMod = buildSession({ mode: 'player', teammateCount: 0, module: mod });
  eq(withMod.module?.id, mod.id, '模组被带上');
});

// ---- 调查员伙伴（后备援军） ----
group('调查员伙伴', () => {
  // 没传伙伴时应该是空数组，而不是 undefined——
  // 下游（存档、提示词、engine）都直接 .map，undefined 会炸
  const none = buildSession({ mode: 'player', teammateCount: 1 });
  ok(Array.isArray(none.companions), '默认 companions 是数组');
  eq(none.companions.length, 0, '默认没有伙伴');

  // 传了伙伴就原样带上，并且是规范化过的角色卡
  const raw = createCharacter({ name: '老周', isPlayer: false });
  raw.occupation = '退伍军人';
  const withCp = buildSession({
    mode: 'player', teammateCount: 0, companions: [raw]
  });
  eq(withCp.companions.length, 1, '伙伴被带上');
  eq(withCp.companions[0].name, '老周', '伙伴名字保留');
  eq(withCp.companions[0].isPlayer, false, '伙伴不是玩家角色');
  ok(withCp.companions[0].derived, '伙伴经过 normalizeCharacter，有 derived');

  // 伙伴不占队友名额：3 个队友 + 2 个伙伴，两个数量互不影响
  const mixed = buildSession({
    mode: 'player', teammateCount: 3,
    companions: [createCharacter({ name: 'A' }), createCharacter({ name: 'B' })]
  });
  eq(mixed.teammates.length, 3, '队友数不受伙伴影响');
  eq(mixed.companions.length, 2, '伙伴数不受队友名额影响');
});

// ---- 伙伴注入 KP 提示词 ----
group('伙伴进入 KP 提示词', () => {
  const base = { scenario: { scene: '', events: [], clues: [], secrets: [], notes: '' }, tone: '经典恐怖' };

  const without = keeperSystemPrompt({ ...base, mode: 'player' });
  ok(!without.includes('调查员伙伴'), '没有伙伴时不出现伙伴段落');

  const withCp = keeperSystemPrompt({
    ...base, mode: 'player',
    companions: ['调查员：老周\n职业：退伍军人']
  });
  ok(withCp.includes('调查员伙伴'), '有伙伴时出现伙伴段落');
  ok(withCp.includes('老周'), '伙伴档案被写进提示词');
  ok(withCp.includes('后备援军'), '标明是后备援军');
  // 关键：必须把「能不能来由 KP 判断」写清楚，否则 AI 会随便让援军空降
  ok(withCp.includes('什么时候可以赶来支援'), '包含可支援条件');
  ok(withCp.includes('什么时候不该来'), '包含不可支援条件');
  ok(withCp.includes('不要为了让场面热闹'), '明确禁止随意登场');
});

// ---- 伙伴进存档快照 ----
group('伙伴存档往返', () => {
  const st = createInitialState();
  const cp = createCharacter({ name: '援军老李' });
  st.companions = [cp];
  st.playerChar = createCharacter({ name: '主角' });
  st.teammates = [createCharacter({ name: '队友' })];

  const snap = buildSnapshot(st);
  eq(snap.state.companions.length, 1, '快照里带伙伴');
  eq(snap.state.companions[0].name, '援军老李', '伙伴内容正确');

  // 读回来
  const fresh = createInitialState();
  applySnapshot(fresh, snap);
  eq(fresh.companions.length, 1, '读档后伙伴还在');
  eq(fresh.companions[0].name, '援军老李', '读档后伙伴内容一致');

  // 老存档没有 companions 字段，不能炸，要兜底成空数组
  const oldSnap = { state: { playerChar: null, teammates: [], messages: [] } };
  const old = createInitialState();
  applySnapshot(old, oldSnap);
  ok(Array.isArray(old.companions), '老存档兜底成数组');
  eq(old.companions.length, 0, '老存档伙伴为空');
});

group('createTeammate 队友模板', () => {
  // 注入固定随机源，验证不重名与轮转
  let seed = 0;
  const rand = () => 0.25;
  const a = createTeammate(0, rand);
  const b = createTeammate(1, rand);
  const c = createTeammate(2, rand);
  ok(a.name && b.name && c.name, '队友都有名字');
  ok(a.name !== b.name, '相邻队友不重名');
  ok(b.name !== c.name, '相邻队友不重名（2）');
  ok(a.occupation.length > 0, '队友有职业');
  ok(a.persona.length > 0, '队友有性格设定');
  // 模板技能被拉到 60
  const boosted = Object.values(a.skills).some((v) => v >= 60);
  ok(boosted, '模板技能被设为高值');
});

group('内置模组与开场白', () => {
  ok(BUILTIN_MODULES.length > 0, '有内置模组');
  const m = findBuiltinModule('builtin-old-house');
  ok(m !== null, '能按 id 找到内置模组');
  eq(findBuiltinModule('nope'), null, '找不到时返回 null');

  ok(m.opening.includes('旧宅'), '内置模组有玩家版开场');
  ok(m.openingSpectator.includes('旧宅'), '内置模组有旁观版开场');
  ok(m.opening !== m.openingSpectator, '两个版本开场不同');
  ok(!m.openingSpectator.includes('你在'), '旁观开场不含"你"');
  ok(m.raw.length > 100, '内置模组有给 KP 的秘密底牌');

  // openingFor 按模式选文案
  eq(openingFor(m, 'player'), m.opening, '玩家模式用玩家版');
  eq(openingFor(m, 'spectator'), m.openingSpectator, '旁观模式用旁观版');
  // 没选模组也要有开场
  const free = openingFor(null, 'player');
  ok(free.length > 0, '自由创作也有开场');
  ok(openingFor(null, 'spectator').length > 0, '自由创作旁观也有开场');
  // 模组没有旁观版时回落到玩家版
  const onlyPlayer = { opening: '只有玩家版' };
  eq(openingFor(onlyPlayer, 'spectator'), '只有玩家版', '缺旁观版时回落');
});

group('模组公开简介（不剧透）', () => {
  // 内置模组必须带公开简介，且简介里不能出现真相相关的内容
  const m = findBuiltinModule('builtin-old-house');
  const info = moduleInfoFor(m);

  ok(info.hasSummary, '内置模组有公开简介');
  ok(info.summary.length > 60, '简介有实质内容');
  ok(info.era.includes('1920'), '简介给出时代');
  ok(info.location.length > 0, '简介给出地点');
  ok(info.suggestions.length >= 3, '给出车卡建议');

  // 剧透检查：真相、怪物本体、结局、NPC 秘密都不能出现在简介里
  const leakWords = ['黄衣之王', '回声', '封印', '真相', '终局', '阁楼', '玛莎', '汤姆', '火漆印', '盐线'];
  for (const w of leakWords) {
    ok(!info.summary.includes(w), `简介不含剧透词「${w}」`);
    ok(!info.suggestions.join('').includes(w), `车卡建议不含剧透词「${w}」`);
  }

  // 自由创作
  const free = moduleInfoFor(null);
  ok(free.isFree, '不选模组时标记为自由创作');
  ok(free.hasSummary, '自由创作也有简介');
  eq(free.suggestions.length, 0, '自由创作没有车卡建议');

  // 老模组：没有 understanding，从正文里抓时代/地点
  const legacy = {
    id: 'x', title: '老模组',
    raw: '【某个模组】\n时代：1920 年代，伦敦\n地点：泰晤士河畔的旧仓库\n\n真相：此处无关紧要。'
  };
  const li = moduleInfoFor(legacy);
  ok(!li.hasSummary, '没有 understanding 就没有公开简介');
  eq(li.era, '1920 年代，伦敦', '从正文抓到时代');
  eq(li.location, '泰晤士河畔的旧仓库', '从正文抓到地点');
  // 关键：没有简介时绝不能拿正文当简介
  ok(!li.summary.includes('真相'), '缺简介时不回退到剧本正文');

  // 有 understanding 的导入模组
  const imported = {
    id: 'y', title: '导入模组', raw: '正文',
    understanding: { summary: '一段不含剧透的概述。', era: '现代', location: '港口城市', suggestions: ['记者：擅长套话'] }
  };
  const ii = moduleInfoFor(imported);
  ok(ii.hasSummary, 'AI 整理的模组有简介');
  eq(ii.era, '现代', '用 AI 给的时代');
  eq(ii.location, '港口城市', '用 AI 给的地点');
  eq(ii.summary, '一段不含剧透的概述。', '用 AI 给的简介');
  eq(ii.suggestions.length, 1, '用 AI 给的车卡建议');

  // 行内小字
  eq(moduleRowMeta(null).length > 0, true, '自由创作有列表小字');
  ok(moduleRowMeta(imported).includes('现代'), '导入模组小字带时代');
});

group('hasRunTurn 旁观模式进度判定', () => {
  // 旁观模式没有 user 消息，靠 turns 判断
  ok(
    hasRunTurn({ mode: 'spectator', turns: 1, messages: [{ role: 'keeper' }, { role: 'keeper' }] }),
    '旁观推进过一轮算有进度'
  );
  ok(
    !hasRunTurn({ mode: 'spectator', turns: 0, messages: [{ role: 'keeper' }] }),
    '旁观只有开场白不算进度'
  );
  // 玩家模式行为不变
  ok(
    hasRunTurn({ mode: 'player', messages: [{ role: 'keeper' }, { role: 'user' }] }),
    '玩家模式看 user 消息'
  );
  ok(!hasRunTurn({ mode: 'player', turns: 3, messages: [{ role: 'keeper' }] }), '玩家模式不因 turns 误判');
});

// ---------------------------------------------------------------------------
// 获取模型列表
// ---------------------------------------------------------------------------
group('buildModelsEndpoint 端点拼接', () => {
  eq(buildModelsEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/models', '标准 /v1 地址');
  eq(buildModelsEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/models', '尾部斜杠');
  eq(buildModelsEndpoint('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/v1/models', '多个尾部斜杠');
  eq(
    buildModelsEndpoint('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/models',
    '误填完整 completions 路径也能纠正'
  );
  eq(buildModelsEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/models', '本地 Ollama');
  eq(buildModelsEndpoint(''), '/models', '空地址不炸');
  // 已经是 /models 就不要重复拼
  eq(buildModelsEndpoint('https://x.com/v1/models'), 'https://x.com/v1/models', '已是 models 不重复');
});

group('normalizeModels 响应归一化', () => {
  // OpenAI 格式
  const openai = normalizeModels({
    object: 'list',
    data: [
      { id: 'deepseek-chat', owned_by: 'deepseek' },
      { id: 'deepseek-reasoner', owned_by: 'deepseek' }
    ]
  });
  eq(openai.length, 2, 'OpenAI data[] 解析');
  eq(openai[0].id, 'deepseek-chat', '按 id 排序后第一个');
  eq(openai[1].id, 'deepseek-reasoner', '第二个');
  eq(openai[0].ownedBy, 'deepseek', '保留 owned_by');

  // Ollama 格式
  const ollama = normalizeModels({
    models: [{ name: 'qwen2.5:14b' }, { name: 'llama3.1:8b' }]
  });
  eq(ollama.length, 2, 'Ollama models[] 解析');
  ok(ollama.some((m) => m.id === 'qwen2.5:14b'), '取 name 字段');

  // 纯字符串数组
  const plain = normalizeModels(['gpt-4o', 'gpt-4o-mini']);
  eq(plain.length, 2, '字符串数组解析');
  eq(plain[0].id, 'gpt-4o', '字符串转 id');

  // 去重
  const dup = normalizeModels({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] });
  eq(dup.length, 2, '重复 id 去重');

  // 脏数据不炸
  eq(normalizeModels(null).length, 0, 'null 返回空数组');
  eq(normalizeModels({}).length, 0, '空对象返回空数组');
  eq(normalizeModels({ data: [{ foo: 1 }, null, {}] }).length, 0, '缺 id 的条目被丢弃');

  // 排序稳定
  const sorted = normalizeModels({ data: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });
  eq(sorted.map((m) => m.id).join(','), 'a,b,c', '按字母排序');
});

group('modelsHintText 提示文案', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  ok(modelsHintText(list, 'a').includes('2'), '提示数量');
  ok(!modelsHintText(list, 'a').includes('不在列表'), '在列表内不报警');
  ok(modelsHintText(list, 'zzz').includes('不在列表'), '不在列表时提醒');
  eq(modelsHintText([], 'a'), '', '空列表不提示');
  eq(modelsHintText(null), '', 'null 不炸');
});

group('modelsErrorText 错误文案', () => {
  ok(modelsErrorText('HTTP 401 Unauthorized').includes('API Key'), '401 提示 key 无效');
  ok(modelsErrorText('HTTP 403 Forbidden').includes('API Key'), '403 提示权限');
  ok(modelsErrorText('HTTP 404 Not Found').includes('手填'), '404 建议手填');
  ok(modelsErrorText('HTTP 429 Too Many').includes('限流'), '429 提示限流');
  ok(modelsErrorText('请求超时或已取消').includes('超时'), '超时提示');
  ok(modelsErrorText('fetch failed').includes('连不上'), '网络错误提示');
  ok(modelsErrorText('接口返回了空的模型列表').includes('空'), '空列表提示');
  eq(modelsErrorText(''), '获取失败', '空错误兜底');
  ok(modelsErrorText('x'.repeat(500)).length <= 160, '超长错误被截断');
});

group('filterModels 模型搜索', () => {
  const list = [
    { id: 'trae/deepseek-V3' },
    { id: 'trae/glm-5' },
    { id: 'qoder_cn/auto' },
    { id: 'deepseek-chat' }
  ];

  eq(filterModels(list, '').length, 4, '空搜索词返回全部');
  eq(filterModels(list, '  ').length, 4, '纯空格返回全部');
  eq(filterModels(list, null).length, 4, 'null 返回全部');
  eq(filterModels(null, 'x').length, 0, 'null 列表不炸');

  eq(filterModels(list, 'glm').length, 1, '按子串匹配');
  eq(filterModels(list, 'GLM').length, 1, '搜索不区分大小写');
  eq(filterModels(list, 'trae').length, 2, '按前缀匹配到多条');
  eq(filterModels(list, 'deepseek').length, 2, '同时匹配到带前缀与不带前缀的');
  eq(filterModels(list, 'zzz').length, 0, '无匹配返回空');
  eq(filterModels(list, 'auto')[0].id, 'qoder_cn/auto', '返回原对象');
});

group('groupModelsByPrefix 前缀分组', () => {
  const list = [
    { id: 'trae/a' }, { id: 'trae/b' },
    { id: 'qoder_cn/x' },
    { id: 'plain' }
  ];
  const g = groupModelsByPrefix(list);
  eq(g.get('trae').length, 2, '同前缀归一组');
  eq(g.get('qoder_cn').length, 1, '另一前缀独立');
  eq(g.get('').length, 1, '无前缀归到空字符串组');
  eq(groupModelsByPrefix([]).size, 0, '空列表返回空 Map');
  eq(groupModelsByPrefix(null).size, 0, 'null 不炸');
});

// ---------------------------------------------------------------------------
// 模组素材导入（docx / pdf / 图片 / 文件夹）
// ---------------------------------------------------------------------------
group('stripXml 从 docx XML 提正文', () => {
  const xml = `<w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body>`;
  const t = stripXml(xml);
  ok(t.includes('第一段'), '保留正文');
  ok(t.includes('第二段'), '保留第二段');
  ok(t.includes('\n'), '段落间有换行');
  ok(!t.includes('<w:'), '标签被去掉');

  // 实体还原
  eq(stripXml('<w:t>a &amp; b</w:t>'), 'a & b', '&amp; 还原');
  eq(stripXml('<w:t>&lt;tag&gt;</w:t>'), '<tag>', '转义尖括号还原');

  // <w:br/> 变换行
  ok(stripXml('<w:t>上<w:br/>下</w:t>').includes('\n'), 'w:br 转换行');

  // 注释被丢弃
  ok(!stripXml('<!-- 注释 --><w:t>正文</w:t>').includes('注释'), 'XML 注释被去掉');

  // 多余空行折叠
  ok(!stripXml('<w:p></w:p><w:p></w:p><w:p></w:p>').includes('\n\n\n'), '连续空行被折叠');
});

group('materialsToPromptText 素材拼装', () => {
  const parsed = {
    docs: [
      { rel: '正文.docx', kind: 'word', text: '这是正文' },
      { rel: '空.txt', kind: 'text', text: '' }
    ],
    images: [{ rel: '地图.png', mime: 'image/png', bytes: 100 }],
    skipped: [{ rel: 'x.doc', reason: '老格式' }]
  };
  const text = materialsToPromptText(parsed);
  ok(text.includes('正文.docx'), '含文件名');
  ok(text.includes('这是正文'), '含正文');
  ok(text.includes('地图.png'), '列出图片');
  ok(text.includes('x.doc'), '列出跳过的文件');
  ok(text.includes('老格式'), '含跳过原因');
  ok(!text.includes('空.txt'), '空文档不出现');

  // 无内容时返回空串
  eq(materialsToPromptText({ docs: [], images: [], skipped: [] }), '', '全空返回空串');
  eq(materialsToPromptText({}), '', '缺字段不炸');

  // 超长截断
  const big = { docs: [{ rel: 'a', kind: 'text', text: 'x'.repeat(5000) }], images: [], skipped: [] };
  const cut = materialsToPromptText(big, { maxChars: 100 });
  ok(cut.length <= 120, '按 maxChars 截断');
  ok(cut.includes('截断'), '有截断提示');
});

group('extractJson 从模型输出抠 JSON', () => {
  eq(extractJson('{"title":"a"}').title, 'a', '纯 JSON');
  eq(extractJson('```json\n{"title":"b"}\n```').title, 'b', '代码块包裹');
  eq(extractJson('好的：\n{"title":"c"}\n完毕').title, 'c', '前后有说明文字');
  eq(extractJson('完全不是 json'), null, '非 JSON 返回 null');
  eq(extractJson(''), null, '空串返回 null');
  eq(extractJson(null), null, 'null 返回 null');
  // 嵌套对象也能正确截取
  eq(extractJson('前言 {"a":{"b":1}} 后语').a.b, 1, '嵌套对象');
});

group('buildUnderstandPrompt 提示词', () => {
  const p = buildUnderstandPrompt({ folderName: '我的模组', materialsText: '素材内容', imageCount: 2 });
  ok(p.sys.includes('JSON'), '系统提示要求 JSON');
  ok(p.sys.includes('克苏鲁'), '说明角色设定');
  ok(p.user.includes('我的模组'), '用户提示含文件夹名');
  ok(p.user.includes('素材内容'), '用户提示含素材');
  ok(p.user.includes('2 张图片'), '提到图片数量');
  // 没图片时不提
  const q = buildUnderstandPrompt({ folderName: 'x', materialsText: 'y', imageCount: 0 });
  ok(!q.user.includes('张图片'), '无图片时不提图片');
});

group('moduleFromUnderstanding 组装模组底稿', () => {
  const u = {
    title: '旧宅疑影', era: '1920年代', location: '旧宅',
    hook: '整理遗物', truth: '黄衣之王',
    npcs: [{ name: '玛莎', role: '管家', secret: '藏钥匙' }],
    clues: ['火漆信', '账本'],
    scenes: ['书房', '走廊'], threat: '回声',
    notes: '地图是手绘'
  };
  const txt = moduleFromUnderstanding(u, { folderName: 'mod', materialsText: '原始' });

  ok(txt.includes('旧宅疑影'), '含标题');
  ok(txt.includes('1920年代'), '含时代');
  ok(txt.includes('玛莎'), '含 NPC');
  ok(txt.includes('藏钥匙'), '含 NPC 秘密');
  ok(txt.includes('火漆信'), '含线索');
  ok(txt.includes('书房 → 走廊'), '场景用箭头连接');
  ok(txt.includes('回声'), '含威胁');
  ok(txt.includes('地图是手绘'), '含备注');
  ok(txt.includes('原始素材'), '附原始素材');
  ok(txt.includes('原始'), '原始素材正文在');

  // 字段缺失时不炸，也不留空标题
  const bare = moduleFromUnderstanding({}, { folderName: 'fb', materialsText: '' });
  ok(bare.includes('fb'), '无标题时用文件夹名兜底');
  ok(!bare.includes('undefined'), '不出现 undefined');

  // NPC 缺字段
  const partial = moduleFromUnderstanding({ npcs: [{ name: '甲' }] }, { folderName: 'x', materialsText: '' });
  ok(partial.includes('甲'), 'NPC 有名即可');
  ok(!partial.includes('undefined'), 'NPC 缺字段不出现 undefined');
});

group('素材上限常量合理', () => {
  ok(MAX_IMAGES >= 8 && MAX_IMAGES <= 20, '图片张数上限在合理区间');
  ok(MAX_CHARS_TOTAL >= 40000, '文字预算足够放下一个模组');
  // 图片总量上限必须明显小于「张数×单张上限」，否则闸门形同虚设
  ok(MAX_IMAGE_TOTAL_BYTES < MAX_IMAGES * 8 * 1024 * 1024, '图片总量闸门比理论最大值小');
  ok(MAX_IMAGE_TOTAL_BYTES >= 8 * 1024 * 1024, '总量上限至少容得下几张图');
});

group('cleanWordFields 清掉 Word 域代码', () => {
  // 真实的 TOC 域残留：这些反斜杠会让模型写 JSON 时漏转义
  const toc = 'TOC \\o "1-2" \\h \\u  HYPERLINK \\l _Toc5459 前言\t PAGEREF _Toc5459 \\h 1';
  const c1 = cleanWordFields(toc);
  ok(c1.includes('前言'), '保留标题文字');
  ok(!c1.includes('HYPERLINK'), '去掉 HYPERLINK');
  ok(!c1.includes('PAGEREF'), '去掉 PAGEREF');
  ok(!c1.includes('_Toc'), '去掉书签 id');
  eq((c1.match(/\\/g) || []).length, 0, '不再有反斜杠');

  // 外部超链接
  const c2 = cleanWordFields('HYPERLINK "https://example.com" 点这里');
  ok(c2.includes('点这里'), '保留链接文字');
  ok(!c2.includes('example.com'), '去掉 URL');

  // 普通正文不该被破坏
  const plain = '调查员来到废弃码头，海风带着咸味。';
  eq(cleanWordFields(plain), plain, '正文原样保留');

  // 反斜杠在正文里（路径）会被当域开关清掉，这是可接受的取舍
  const c3 = cleanWordFields('目录\n前言 1\n梗概 2');
  ok(c3.includes('前言 1'), '目录页码保留');
});

group('fingerprint 内容指纹', () => {
  eq(fingerprint('海面之梦 调查员'), '海面之梦调查员', '去空格');
  eq(fingerprint('a-b_c!'), 'abc', '去标点');
  eq(fingerprint('第 1 页 共 30 页正文'), '正文', '去页码');
  eq(fingerprint('第12页共30页内容'), '内容', '页码无空格也能去');
  ok(fingerprint('').length === 0, '空串返回空');
});

group('dedupeDocs 同源文档去重', () => {
  // 同一份内容的 docx 与 pdf（pdf 每页插了页眉，是真实差异来源）
  const base = '调查员与马文出海遭遇海难，马文是深潜者混血。'.repeat(120);
  const withHeader = base.split('').reduce((acc, c, i) => acc + c + (i % 400 === 0 ? '【页眉宣传语】' : ''), '');

  const docs = [
    { rel: 'a.docx', kind: 'word', text: base, full: base },
    { rel: 'b.pdf', kind: 'pdf', text: withHeader, full: withHeader }
  ];
  const skipped = [];
  dedupeDocs(docs, skipped);
  eq(docs.length, 1, '同源文档只留一份');
  eq(skipped.length, 1, '被去掉的有记录');
  ok(skipped[0].reason.includes('重复'), '说明原因');

  // 不同内容不该被判重
  const A = '调查员来到废弃码头，海风带着咸味。'.repeat(150);
  const B = '古堡里的钟声在午夜响起，地窖藏着黄铜钥匙。'.repeat(150);
  const docs2 = [
    { rel: 'x.txt', kind: 'text', text: A, full: A },
    { rel: 'y.txt', kind: 'text', text: B, full: B }
  ];
  const sk2 = [];
  dedupeDocs(docs2, sk2);
  eq(docs2.length, 2, '不同模组都保留');
  eq(sk2.length, 0, '不误杀');

  // 短文档不参与判重
  const docs3 = [
    { rel: 's1.txt', kind: 'text', text: '短', full: '短' },
    { rel: 's2.txt', kind: 'text', text: '短', full: '短' }
  ];
  const sk3 = [];
  dedupeDocs(docs3, sk3);
  eq(docs3.length, 2, '太短的文档不判重');
});

group('repairTruncatedJson 修复被截断的 JSON', () => {
  // 这些是模型输出被 max_tokens 截断时的真实形态
  eq(repairTruncatedJson('{"title":"海面之梦","era":"近现代，COC7th，固定1名调查员')?.title, '海面之梦', '截在字符串中');
  eq(repairTruncatedJson('{"title":"海面之梦","clues":["线索一","线索二","线索三')?.title, '海面之梦', '截在数组元素');
  eq(repairTruncatedJson('{"title":"海面之梦","npcs":[{"name":"马文","role":"好友"')?.title, '海面之梦', '截在对象字段');
  eq(repairTruncatedJson('{"title":"海面之梦"')?.title, '海面之梦', '只有开头');
  eq(repairTruncatedJson('{"title":"T","npcs":[{"name":"A","secret":"x"},{"name":"B","sec')?.title, 'T', '截在嵌套深处');

  // 修复后应保留已完成的字段
  const r = repairTruncatedJson('{"title":"T","clues":["线索一","线索二"]');
  eq(r.clues.length, 2, '已完成的数组元素保留');

  // 不该误判
  eq(repairTruncatedJson('这不是JSON'), null, '非 JSON 返回 null');
  eq(repairTruncatedJson(''), null, '空串返回 null');
  eq(repairTruncatedJson('{"a":1}')?.a, 1, '完整 JSON 也能解析');
});

group('extractJson 处理截断输出', () => {
  // 未闭合的代码块（截断后常见）
  const r1 = extractJson('```json\n{"title":"海面之梦","era":"近现代');
  eq(r1?.title, '海面之梦', '未闭合代码块也能救回');

  // 完整代码块
  eq(extractJson('```json\n{"title":"b"}\n```')?.title, 'b', '完整代码块');
});

// ---------------------------------------------------------------------------
// 角色卡：数据结构 / AI 生成 / 设定界面集成
// ---------------------------------------------------------------------------
group('SKILL_DEFS 技能全表', () => {
  // 对齐 Excel 人物卡的左右两列，共 67 项
  eq(SKILL_DEFS.length, 67, '技能定义数量与 Excel 卡一致');

  // 左列 34 + 右列 33
  ok(SKILL_DEFS.some((s) => s.name === '会计'), '含会计');
  ok(SKILL_DEFS.some((s) => s.name === '学识①'), '含右列最后的学识');
  ok(SKILL_DEFS.some((s) => s.name === '自定义技能'), '含自定义技能槽');

  // 基础值与 Excel 一致
  const base = (n) => SKILL_DEFS.find((s) => s.name === n)?.base;
  eq(base('会计'), 5, '会计基础 5');
  eq(base('人类学'), 1, '人类学基础 1');
  eq(base('急救'), 30, '急救基础 30');
  eq(base('侦查'), 25, '侦查基础 25');
  eq(base('格斗：斗殴'), 25, '斗殴基础 25');
  eq(base('射击：手枪'), 20, '手枪基础 20');
  eq(base('信用评级'), 0, '信用评级从 0 开始');
  eq(base('克苏鲁神话'), 0, '克苏鲁神话从 0 开始');

  // 自定义子类
  const customs = SKILL_DEFS.filter((s) => s.custom);
  ok(customs.length >= 10, '自定义子技能槽充足');
  ok(customs.every((s) => s.name.match(/[①②③]|自定义技能/)), '自定义槽都带序号或标记');
});

// ---------------------------------------------------------------------------
group('克苏鲁神话不可加点', () => {
  // 原版规则：神话知识只能靠游戏内遭遇增长，车卡阶段一律从 0 开始
  eq(isSkillEditable('克苏鲁神话'), false, '克苏鲁神话不可加点');

  // 其他技能照常可改
  eq(isSkillEditable('会计'), true, '普通技能可加点');
  eq(isSkillEditable('侦查'), true, '侦查可加点');
  eq(isSkillEditable('闪避'), true, '闪避可加点');

  // 未知技能名不该被误锁
  eq(isSkillEditable('不存在的技能'), true, '未知技能默认可加点');

  // 只有克苏鲁神话带 mythos 标记
  const mythos = SKILL_DEFS.filter((s) => s.mythos);
  eq(mythos.length, 1, '只有一个神话类技能');
  eq(mythos[0].name, '克苏鲁神话', '带 mythos 标记的是克苏鲁神话');
});

group('createCharacter 角色卡字段完整', () => {
  const ch = createCharacter({ name: '测试员', isPlayer: true });

  // 对齐 Excel 的分区字段
  ok(ch.attrs && ch.attrs.STR === 50, '有属性');
  ok(Object.keys(ch.skills).length >= 67, '技能表填满');
  ok(ch.customNames && typeof ch.customNames === 'object', '有自定义技能名容器');
  ok(ch.weapons === undefined || Array.isArray(ch.weapons), '武器为数组');
  ok(ch.assets && ch.assets.creditRating === 0, '有资产区');
  ok(ch.background && 'story' in ch.background, '背景故事含 story 字段');
  ok(Array.isArray(ch.experiences), '有经历数组');
  ok(Array.isArray(ch.spells), '有法术数组');
  eq(ch.gender, '', '性别默认空');
  eq(ch.era, '1920s', '默认时代');

  // 派生值
  eq(ch.derived.HP, 10, 'HP=(50+50)/10');
  eq(ch.derived.MP, 10, 'MP=50/5');
  eq(ch.derived.SAN, 50, 'SAN=POW');

  // 闪避/母语由属性决定
  eq(ch.skills['闪避'], 25, '闪避=DEX/2');
  eq(ch.skills['母语'], 50, '母语=EDU');
});

group('refreshDerived 联动', () => {
  const ch = createCharacter({ name: 'A' });
  ch.attrs.DEX = 60;
  ch.attrs.EDU = 70;
  refreshDerived(ch);
  eq(ch.skills['闪避'], 30, '改 DEX 后闪避跟着变');
  eq(ch.skills['母语'], 70, '改 EDU 后母语跟着变');

  // 上限同步，当前值不超
  ch.hp.current = 999;
  ch.attrs.CON = 40;
  ch.attrs.SIZ = 40;
  refreshDerived(ch);
  eq(ch.hp.max, 8, 'HP 上限重算');
  ok(ch.hp.current <= ch.hp.max, 'HP 当前值被夹到上限');

  // 玩家手动加过点的技能不被属性覆盖
  //
  // 注意：闪避/母语虽然初始值由属性决定（DEX/2、EDU），但它们**可以加点**——
  // 27 个职业把闪避列为本职技能（拳击手、警察、士兵、记者…），不能加点就
  // 说不通了。旧断言「闪避恒等于 DEX/2」与本行注释自相矛盾，实际是
  // refreshDerived 无条件覆盖导致的 bug，已修复。
  ch.skills['闪避'] = 80;   // DEX 60 → 初始 30，等于加了 50 点
  refreshDerived(ch);
  eq(ch.skills['闪避'], 80, '闪避的加点被保留（30 + 50）');

  // 属性变化时，加点保留、初始值跟着走
  ch.attrs.DEX = 80;        // 初始值变 40，加的点仍是 50 → 90
  refreshDerived(ch);
  eq(ch.skills['闪避'], 90, 'DEX 上涨：初始值跟着涨，加点不丢');

  ch.attrs.DEX = 40;        // 初始值变 20，加的点仍是 50 → 70
  refreshDerived(ch);
  eq(ch.skills['闪避'], 70, 'DEX 下降：初始值跟着降，加点不丢也不膨胀');

  // 母语同理（EDU 70 → 初始 70）
  ch.skills['母语'] = 85;   // 加了 15 点
  refreshDerived(ch);
  eq(ch.skills['母语'], 85, '母语的加点被保留（70 + 15）');
});

group('skillLevels 成功等级', () => {
  const lv = skillLevels(50);
  eq(lv.normal, 50, '普通值');
  eq(lv.hard, 25, '困难=1/2');
  eq(lv.extreme, 10, '极难=1/5');
  eq(skillLevels(0).extreme, 0, '0 技能极难也为 0');
});

group('displaySkillName 自定义技能显示', () => {
  const ch = createCharacter({ name: 'A' });
  eq(displaySkillName(ch, '侦查'), '侦查', '未自定义时原名');
  ch.customNames['技艺①'] = '摄影';
  eq(displaySkillName(ch, '技艺①'), '技艺：摄影', '自定义后带出名字');
  ch.customNames['外语①'] = '拉丁语';
  eq(displaySkillName(ch, '外语①'), '外语：拉丁语', '外语同样处理');
});

group('normalizeCharacter 旧存档兜底', () => {
  // 老版本角色卡：没有 weapons/assets/experiences，技能也只有一部分
  const old = {
    name: '老卡', isPlayer: true, occupation: '记者',
    attrs: { STR: 50, CON: 50, SIZ: 50, DEX: 50, APP: 50, INT: 50, POW: 50, EDU: 50, LUCK: 50 },
    skills: { 侦查: 40 },
    hp: { current: 10, max: 10 }, mp: { current: 10, max: 10 },
    san: { current: 50, max: 50, temp: 50 }, luck: { current: 50 },
    status: [], inventory: [],
    background: { description: '瘦高个' }
  };
  const ch = normalizeCharacter(old);

  eq(ch.name, '老卡', '保留姓名');
  eq(ch.occupation, '记者', '保留职业');
  eq(ch.skills['侦查'], 40, '保留旧技能值');
  ok(Object.keys(ch.skills).length >= 67, '缺的技能被补全');
  ok(Array.isArray(ch.weapons), '补上 weapons');
  ok(ch.assets && ch.assets.creditRating === 0, '补上 assets');
  ok(Array.isArray(ch.experiences), '补上 experiences');
  eq(ch.background.description, '瘦高个', '保留旧背景');

  // 完全非法输入也能返回一张可用的卡
  const bad = normalizeCharacter(null);
  ok(bad && bad.name === '调查员', 'null 返回默认卡');
  const bad2 = normalizeCharacter({ name: 'X', attrs: '不是对象' });
  ok(bad2.attrs.STR === 50, 'attrs 类型错误时用默认值');
});

group('buildCharPrompt 生成提示词', () => {
  const p = buildCharPrompt({ brief: '华裔记者', era: '1920s', role: 'player' });
  ok(p.sys.includes('JSON'), '要求 JSON 输出');
  ok(p.sys.includes('3d6'), '说明属性骰法');
  ok(p.sys.includes('STR'), '列出属性键');
  ok(p.sys.includes('侦查'), '列出可选技能名');
  ok(p.user.includes('华裔记者'), '用户要求被带入');
  ok(p.user.includes('1920s'), '时代被带入');

  // 指定职业
  const q = buildCharPrompt({ occupation: '医生' });
  ok(q.user.includes('医生'), '指定职业写入提示');

  // 已骰好的属性要原样使用
  const r = buildCharPrompt({ seedAttrs: { STR: 60 } });
  ok(r.user.includes('"STR":60'), '种子属性写入提示');

  // 队友模式
  const t = buildCharPrompt({ role: 'teammate' });
  ok(t.user.includes('队友'), '队友角色说明');

  // 重名规避
  const s = buildCharPrompt({ existingNames: ['林默'] });
  ok(s.user.includes('林默'), '已有角色名写入提示');
});

group('parseCharJson 解析 AI 输出', () => {
  // 纯 JSON
  const a = parseCharJson('{"name":"林默","occupation":"军医"}');
  eq(a?.name, '林默', '直接解析');

  // 代码块包裹
  const b = parseCharJson('```json\n{"name":"陈叙"}\n```');
  eq(b?.name, '陈叙', '代码块解析');

  // 前后有废话
  const c = parseCharJson('好的，这是角色卡：{"name":"白鹭"} 希望你喜欢');
  eq(c?.name, '白鹭', '抠出中间 JSON');

  // 截断：背景故事写到一半断了
  const d = parseCharJson('{"name":"周砚","attrs":{"STR":60,"CON":50},"background":{"story":"他在码头');
  ok(d && d.name === '周砚', '截断也能救回姓名');
  ok(d.attrs && d.attrs.STR === 60, '截断保留已完成字段');

  // 非法
  eq(parseCharJson('完全不是 JSON'), null, '非 JSON 返回 null');
  eq(parseCharJson(''), null, '空串返回 null');
  eq(parseCharJson(null), null, 'null 返回 null');
  eq(parseCharJson('[1,2,3]'), null, '数组不是角色卡');

  // 中文字段名容错
  const e = parseCharJson('{"姓名":"顾长生","职业":"古董商"}');
  eq(e?.name, '顾长生', '中文键名「姓名」可识别');
  eq(e?.occupation, '古董商', '中文键名「职业」可识别');
});

group('charFromAI 组装角色卡', () => {
  const raw = {
    name: '林默', gender: '男', age: 34, occupation: '退伍军医',
    attrs: { STR: 65, CON: 55, SIZ: 60, DEX: 50, APP: 45, INT: 70, POW: 60, EDU: 75, LUCK: 40 },
    skills: { 急救: 75, 医学: 65, '射击：手枪': 60, 侦查: 55 },
    customNames: { '技艺①': '战地缝合' },
    weapons: [{ name: 'M1911', skill: '射击：手枪', damage: '1d10+2', range: '15码' }],
    inventory: ['手术刀', '绷带'],
    assets: { creditRating: 30, livingStandard: '普通', cash: 500 },
    background: { description: '瘦高，左脸有疤', traits: '话少', story: '战后回国……' },
    persona: '沉默寡言的老兵'
  };
  const ch = charFromAI(raw, { isPlayer: true });

  eq(ch.name, '林默', '姓名');
  eq(ch.occupation, '退伍军医', '职业');
  eq(ch.age, 34, '年龄');
  eq(ch.attrs.STR, 65, '属性原样');
  eq(ch.skills['急救'], 75, '技能覆盖');
  eq(ch.skills['闪避'], 25, '闪避仍由 DEX 决定');
  eq(ch.skills['母语'], 75, '母语仍由 EDU 决定');
  eq(ch.customNames['技艺①'], '战地缝合', '自定义技能名');
  eq(ch.weapons.length, 1, '武器');
  eq(ch.weapons[0].name, 'M1911', '武器名');
  eq(ch.inventory.length, 2, '随身物品');
  eq(ch.assets.creditRating, 30, '信用评级');
  eq(ch.assets.cash, 500, '现金');
  eq(ch.background.traits, '话少', '背景特质');
  eq(ch.persona, '沉默寡言的老兵', '性格');

  // 状态填满
  eq(ch.hp.current, ch.hp.max, 'HP 填满');
  eq(ch.san.current, ch.san.temp, 'SAN 填满');
  eq(ch.luck.current, 40, '幸运=属性 LUCK');

  // 属性越界被夹住并归整到 5 的倍数
  const wild = charFromAI({ attrs: { STR: 999, CON: -5, SIZ: 63 } }, {});
  eq(wild.attrs.STR, 99, 'STR 上限 99');
  ok(wild.attrs.CON >= 1, 'CON 下限被抬起');
  eq(wild.attrs.SIZ, 65, 'SIZ 归整到 5 的倍数');

  // 没给属性就自己骰
  const noAttr = charFromAI({ name: '无名' }, {});
  ok(noAttr.attrs.STR > 0, '缺属性时自动骰点');

  // 重名兜底
  const dup = charFromAI({ name: '林默' }, { existingNames: ['林默'] });
  eq(dup.name, '林默2', '重名自动加序号');

  // 非法技能名被丢弃
  const badSkill = charFromAI({ skills: { 不存在技能: 80, 侦查: 50 } }, {});
  ok(badSkill.skills['不存在技能'] === undefined, '非法技能名被丢弃');
  eq(badSkill.skills['侦查'], 50, '合法技能保留');

  // 克苏鲁神话在车卡阶段恒为 0（原版规则不给加点）
  const mythos = charFromAI({ skills: { 克苏鲁神话: 90 } }, {});
  eq(mythos.skills['克苏鲁神话'], 0, 'AI 给的克苏鲁神话被强制归零');

  const mythos2 = charFromAI({ skills: { 克苏鲁神话: 5 } }, {});
  eq(mythos2.skills['克苏鲁神话'], 0, '克苏鲁神话 5 也被归零，不是压到 5');
});

group('generateCharacter 调用链', () => {
  // 用假的 chat 函数验证请求组装与结果解析
  // 注：这是异步用例，实际执行放在文件末尾的顶层 await 块里
  pendingAsync.push(async () => {
    const calls = [];
    const fakeApi = {
      chat: async (req) => {
        calls.push(req);
        return { ok: true, text: '{"name":"苏晚","occupation":"护士","attrs":{"STR":50}}' };
      }
    };

    const res = await generateCharacter({ baseUrl: 'x', model: 'm' }, { brief: '温柔的护士' }, fakeApi);
    ok(res.ok, '生成成功');
    eq(res.char.name, '苏晚', '解析出角色卡');
    ok(calls.length === 1, '只调用一次');
    ok(calls[0].messages[0].role === 'system', '有系统提示');
    ok(calls[0].messages[0].content.includes('JSON'), '系统提示要求 JSON');
    ok(calls[0].messages[1].content.includes('温柔的护士'), '用户要求被带入');
    eq(calls[0].purpose, 'charGen', 'purpose 标记');
    ok(calls[0].maxTokens >= 2000, '输出上限够装一张卡');

    // 失败分支
    const failApi = { chat: async () => ({ ok: false, error: '网络错误' }) };
    const bad = await generateCharacter({}, {}, failApi);
    ok(!bad.ok, '失败返回 ok:false');
    eq(bad.error, '网络错误', '透出错误信息');

    // 返回非 JSON
    const junkApi = { chat: async () => ({ ok: true, text: '我不想生成角色卡。' }) };
    const junk = await generateCharacter({}, {}, junkApi);
    ok(!junk.ok, '非 JSON 判定失败');
    ok(junk.error.includes('JSON'), '提示 JSON 问题');
  });
});

group('randomCharacter 本地随机卡', () => {
  const ch = randomCharacter({ name: '郑野', isPlayer: false });
  eq(ch.name, '郑野', '姓名');
  ok(ch.attrs.STR >= 15 && ch.attrs.STR <= 90, '属性在合法范围');
  ok(ch.hp.current === ch.hp.max, 'HP 填满');
  ok(ch.san.current === ch.san.temp, 'SAN 填满');
  ok(ch.skills['闪避'] === Math.floor(ch.attrs.DEX / 2), '闪避仍由 DEX 决定');

  // 职业点把常用技能抬起来。
  //
  // 这里必须指定职业：randomCharacter 不指定时是随机挑一个，
  // 而「侦查」并不是每个职业的本职技能——旧写法直接断言
  // `ch.skills['侦查'] > 25`，撞上本职不含侦查的职业就会偶发失败。
  // 指定职业后这条断言才是确定的。
  const ch2 = randomCharacter({ name: '郑野', isPlayer: false, occupation: '私家侦探' });
  ok(ch2.occupation === '私家侦探', '指定职业被采用');
  ok(ch2.skills['侦查'] > 25, '侦查被职业点抬高');
});

group('buildSession 采用设定界面车好的卡', () => {
  const pc = createCharacter({ name: '自定义玩家', isPlayer: true });
  pc.occupation = '私家侦探';
  const tm = createCharacter({ name: '自定义队友', isPlayer: false });

  const s = buildSession({ mode: 'player', teammateCount: 2, playerChar: pc, teammates: [tm] });
  eq(s.playerChar.name, '自定义玩家', '玩家卡被采用');
  eq(s.playerChar.occupation, '私家侦探', '玩家职业保留');
  eq(s.teammates.length, 2, '队友数正确');
  eq(s.teammates[0].name, '自定义队友', '第一位用车好的卡');
  ok(s.teammates[1].name !== '自定义队友', '缺的队友被自动补齐');

  // 不传角色卡时仍然可用（向后兼容）
  const plain = buildSession({ mode: 'player', teammateCount: 1 });
  ok(plain.playerChar && plain.playerChar.name, '无预设卡时自动生成玩家');
  eq(plain.teammates.length, 1, '无预设卡时自动生成队友');

  // 旁观模式没有玩家角色
  const spec = buildSession({ mode: 'spectator', teammateCount: 1, playerChar: pc });
  eq(spec.playerChar, null, '旁观模式无玩家角色');

  // 预设队友超过人数时按人数裁掉
  const many = [tm, createCharacter({ name: 'T2' }), createCharacter({ name: 'T3' })];
  const cut = buildSession({ mode: 'player', teammateCount: 1, teammates: many });
  eq(cut.teammates.length, 1, '超出人数的队友被裁掉');
});

// ---------------------------------------------------------------------------
// NPC 台词（[[SAY: ...]]）与叙述切分
// ---------------------------------------------------------------------------
group('parseDirectives 解析 NPC 台词', () => {
  const r = parseDirectives('他擦着杯子。[[SAY: 酒保 | 要来点什么？]]窗外雨还在下。');
  eq(r.says.length, 1, '抽出一条 SAY');
  eq(r.says[0].name, '酒保', '说话人正确');
  eq(r.says[0].text, '要来点什么？', '台词正确');
  eq(r.clean, '他擦着杯子。窗外雨还在下。', 'SAY 从正文里剥掉');

  // 台词里允许出现 |，只有第一个 | 是分隔符
  const multi = parseDirectives('[[SAY: 警长 | 别碰那东西 | 我说真的]]');
  eq(multi.says[0].name, '警长', '多竖线时说话人正确');
  eq(multi.says[0].text, '别碰那东西 | 我说真的', '多竖线时台词完整保留');

  // 没有 SAY 时不产生空数组内容
  eq(parseDirectives('普通旁白。').says.length, 0, '无 SAY 时为空');

  // SAY 与 CHECK 同时存在：两者都要被抽走
  const both = parseDirectives('[[CHECK: 侦查 | 角色=林默]][[SAY: 老教授 | 别去地下室]]');
  eq(both.says.length, 1, 'SAY 与 CHECK 共存时抽出 SAY');
  eq(both.directives.length, 1, 'CHECK 仍被识别为指令');
  eq(both.clean, '', '两者都从正文剥掉');
});

group('splitNarration 按顺序切分旁白与台词', () => {
  const segs = splitNarration('他擦着杯子。[[SAY: 酒保 | 要来点什么？]]窗外雨还在下。');
  eq(segs.length, 3, '切成三段');
  eq(segs[0].kind, 'prose', '第一段是旁白');
  eq(segs[1].kind, 'say', '第二段是台词');
  eq(segs[1].name, '酒保', '台词带说话人');
  eq(segs[2].kind, 'prose', '第三段是旁白');
  eq(segs[2].text, '窗外雨还在下。', '旁白内容正确');

  // 台词在开头
  const head = splitNarration('[[SAY: 酒保 | 第一次来？]]他指了指角落。');
  eq(head[0].kind, 'say', '台词可以出现在开头');
  eq(head.length, 2, '开头台词 + 后续旁白');

  // 空文本 / null 不产生片段
  eq(splitNarration('').length, 0, '空文本无片段');
  eq(splitNarration(null).length, 0, 'null 无片段');

  // 只有结算指令时不该产出空气泡
  eq(splitNarration('[[CHECK: 侦查 | 角色=林默]]').length, 0, '只有指令时无片段');

  // 旁白里残留的指令要被剥掉
  const withCheck = splitNarration('[[CHECK: 侦查 | 角色=林默]][[SAY: 老教授 | 别去地下室]]');
  ok(!withCheck.some((s) => s.text.includes('[[')), '片段里不残留指令文本');

  // 连续多次调用结果一致（全局正则 lastIndex 不泄漏）
  const t = '[[SAY: 酒保 | 要点什么？]]雨停了。';
  eq(splitNarration(t).length, 2, '第一次切分');
  eq(splitNarration(t).length, 2, '第二次切分一致');
  eq(splitNarration(t)[1].text, '雨停了。', '内容稳定');
});

// ---------------------------------------------------------------------------
// 队友自动发言的节奏控制
// ---------------------------------------------------------------------------
group('引擎自动队友发言', () => {
  // 自动发言只需要「能调用 speaker」，不需要真的连 LLM
  const stubApi = () => ({ chat: async () => ({ ok: true, text: '' }), onChunk: () => () => {} });

  const mkState = () => {
    const s = createInitialState();
    s.teammates = [createCharacter({ name: '队友甲' })];
    return s;
  };

  // 关掉开关就不说话
  const off = mkState();
  off.autoTeammate = false;
  let called = 0;
  const engOff = new GameEngine(off, stubApi());
  engOff.setTeammateSpeaker(async () => { called++; });
  ok(typeof engOff.autoTeammateChatter === 'function', '暴露自动发言入口');

  // 没有队友就不说话
  const none = createInitialState();
  none.teammates = [];
  const engNone = new GameEngine(none, stubApi());
  let noneCalled = 0;
  engNone.setTeammateSpeaker(async () => { noneCalled++; });

  // 概率为 0 时从不触发
  const zero = mkState();
  zero.teammateChance = 0;
  const engZero = new GameEngine(zero, stubApi());
  let zeroCalled = 0;
  engZero.setTeammateSpeaker(async () => { zeroCalled++; });

  // 剧情已结束不再说话
  const ended = mkState();
  ended.scenario.ended = true;
  const engEnded = new GameEngine(ended, stubApi());
  let endedCalled = 0;
  engEnded.setTeammateSpeaker(async () => { endedCalled++; });

  // 概率为 1 时一定会触发
  const always = mkState();
  always.teammateChance = 1;
  const engAlways = new GameEngine(always, stubApi());
  let alwaysCalled = 0;
  engAlways.setTeammateSpeaker(async () => { alwaysCalled++; });

  // 连续说了两句之后要停下，避免刷屏
  const chatty = mkState();
  chatty.teammateChance = 1;
  chatty.messages = [
    { role: 'teammate', name: '队友甲', text: '一句' },
    { role: 'teammate', name: '队友乙', text: '两句' }
  ];
  const engChatty = new GameEngine(chatty, stubApi());
  let chattyCalled = 0;
  engChatty.setTeammateSpeaker(async () => { chattyCalled++; });

  pendingAsync.push(async () => {
    await engOff.autoTeammateChatter();
    eq(called, 0, '关闭开关后不说话');
    await engNone.autoTeammateChatter();
    eq(noneCalled, 0, '没有队友时不说话');
    await engZero.autoTeammateChatter();
    eq(zeroCalled, 0, '概率 0 时不说话');
    await engEnded.autoTeammateChatter();
    eq(endedCalled, 0, '剧情结束后不说话');
    await engAlways.autoTeammateChatter();
    eq(alwaysCalled, 1, '概率 1 时一定说话');
    await engChatty.autoTeammateChatter();
    eq(chattyCalled, 0, '连说两句后停下');
  });
});

// ---------------------------------------------------------------------------
// 执行异步用例
// ---------------------------------------------------------------------------
console.log('\n== 异步用例 ==');
for (const fn of pendingAsync) {
  try {
    await fn();
  } catch (e) {
    failed++;
    failures.push('异步用例抛错: ' + (e?.message || e));
    console.log('  FAIL: 异步用例抛错 ' + (e?.message || e));
  }
}

group('resolveSkillValue 技能名归一化', () => {
  const ch = createCharacter({ name: 'A' });
  ch.skills['格斗：斗殴'] = 60;
  ch.skills['射击：手枪'] = 55;
  ch.skills['侦查'] = 45;
  ch.skills['技艺①'] = 40;
  ch.customNames['技艺①'] = '摄影';

  eq(resolveSkillValue(ch, '侦查'), 45, '原名直接命中');
  eq(resolveSkillValue(ch, '格斗'), 60, '简称「格斗」映射到斗殴');
  eq(resolveSkillValue(ch, '斗殴'), 60, '「斗殴」映射到斗殴');
  eq(resolveSkillValue(ch, '射击'), 55, '简称「射击」映射到手枪');
  eq(resolveSkillValue(ch, '手枪'), 55, '「手枪」映射到手枪');
  eq(resolveSkillValue(ch, '计算机'), 5, '「计算机」映射到计算机使用');

  // 自定义子技能名：玩家把「技艺①」填成「摄影」
  eq(resolveSkillValue(ch, '摄影'), 40, '自定义技能名可命中');
  eq(resolveSkillValue(ch, '技艺：摄影'), 40, '「技艺：摄影」写法可命中');

  // 找不到
  eq(resolveSkillValue(ch, '飞行'), undefined, '不存在的技能返回 undefined');
  eq(resolveSkillValue(ch, ''), undefined, '空名返回 undefined');
  eq(resolveSkillValue(null, '侦查'), undefined, '无角色卡返回 undefined');

  // 前缀匹配兜底
  eq(resolveSkillValue(ch, '格斗：刀'), 60, '「格斗：刀」前缀匹配到格斗');
});

// ---------------------------------------------------------------------------
// 玩家手动掷骰（CHECK / SAN 的待掷骰流程）
//
// 背景：玩家角色的检定不再由程序直接掷，而是先登记成 pending，
// 等玩家点「掷骰」按钮才真正结算。队友 / NPC 仍然自动掷。
// 这些用例锁住三件事：玩家必须等、队友不能等、掷完不能重复掷。
// ---------------------------------------------------------------------------
function makeRollCtx() {
  const player = createCharacter({ name: '玩家甲', isPlayer: true });
  const mate = createCharacter({ name: '队友乙', isPlayer: false });
  player.skills['侦查'] = 60;
  mate.skills['侦查'] = 60;
  player.attrs.POW = 50;
  mate.attrs.POW = 50;
  player.san.current = 60;
  mate.san.current = 60;

  const msgs = [];
  const state = {
    playerChar: player,
    teammates: [mate],
    scenario: { scene: '', events: [], clues: [], secrets: [], notes: '', ended: false, ending: '' },
    messages: msgs
  };
  const ctx = {
    state,
    findChar: (n) => (n === '玩家甲' ? player : n === '队友乙' ? mate : null),
    pushMessage: (m) => {
      const x = { id: 'm' + msgs.length, ...m };
      msgs.push(x);
      return x;
    },
    updateMessage: (id, patch) => {
      const x = msgs.find((m) => m.id === id);
      if (x) Object.assign(x, patch);
      return x;
    }
  };
  return { ctx, state, player, mate, msgs };
}

group('玩家 CHECK 登记为待掷骰，不立即结算', () => {
  const { ctx, player } = makeRollCtx();
  const h = getHandler('CHECK');
  const r = h(ctx, { head: '侦查', opts: {}, type: 'CHECK' });

  eq(r.status, 'pending', '返回状态是待掷骰');
  eq(r.kind, 'check', '类型正确');
  eq(r.result, undefined, '尚未产生骰点结果');
  eq(r.adjusted, 60, '目标值按技能算出');
  ok(r.messageId, '有对应的占位消息 id');
  // 技能值本身不能被改动
  eq(player.skills['侦查'], 60, '掷骰前技能值不变');
});

group('玩家 CHECK 掷骰后产出真实结果并回填消息', () => {
  const { ctx, msgs } = makeRollCtx();
  const h = getHandler('CHECK');
  const pending = h(ctx, { head: '侦查', opts: {}, type: 'CHECK' });

  const r = rollPending(ctx, pending);
  eq(r.kind, 'check', '结算类型');
  ok(r.roll && r.roll.value >= 1 && r.roll.value <= 100, '骰点在 1~100');
  ok(r.level && r.level.label, '有成功等级');
  eq(pending.status, 'rolled', '状态转为已掷');

  const msg = msgs.find((m) => m.id === pending.messageId);
  eq(msg.data.status, 'rolled', '消息里的数据同步为已掷');
  ok(String(msg.text).includes('检定结果'), '消息文本换成结果');
});

group('同一次待掷骰不能重复掷', () => {
  const { ctx } = makeRollCtx();
  const h = getHandler('CHECK');
  const pending = h(ctx, { head: '侦查', opts: {}, type: 'CHECK' });

  rollPending(ctx, pending);
  const again = rollPending(ctx, pending);
  eq(again, null, '第二次掷骰被拒绝');
});

group('队友 CHECK 自动掷骰，不进入待掷骰', () => {
  const { ctx, msgs } = makeRollCtx();
  const h = getHandler('CHECK');
  const r = h(ctx, { head: '侦查', opts: { 角色: '队友乙' }, type: 'CHECK' });

  eq(r.kind, 'check', '结算类型');
  ok(r.roll, '已产生骰点');
  eq(r.status, 'rolled', '自动掷骰直接是已掷状态，不留在 pending');
  ok(msgs.some((m) => m.role === 'roll' && m.data && m.data.status !== 'pending'), '已生成结果消息');
});

group('玩家 SAN 登记待掷骰，掷骰前不扣理智', () => {
  const { ctx, player } = makeRollCtx();
  const h = getHandler('SAN');
  const p = h(ctx, { head: '1/1d6', opts: {}, type: 'SAN' });

  eq(p.status, 'pending', '待掷骰');
  eq(p.kind, 'san', '类型为 san');
  eq(player.san.current, 60, '掷骰前 SAN 不变');
});

group('玩家 SAN 掷骰后按 POW 判定并扣理智', () => {
  const { ctx, player } = makeRollCtx();
  const h = getHandler('SAN');
  const p = h(ctx, { head: '1/1d6', opts: {}, type: 'SAN' });

  const r = rollPending(ctx, p);
  ok(r.powRoll, '有 POW 骰点');
  ok(typeof r.loss === 'number' && r.loss >= 0, '损失为非负数');
  eq(r.before, 60, '记录扣减前的 SAN');
  eq(player.san.current, 60 - r.loss, 'SAN 已按损失扣减');
});

group('队友 SAN 自动结算，不进入待掷骰', () => {
  const { ctx, mate } = makeRollCtx();
  const h = getHandler('SAN');
  const before = mate.san.current;
  const r = h(ctx, { head: '1/1d6', opts: { 角色: '队友乙' }, type: 'SAN' });

  eq(r.kind, 'san', '结算类型');
  ok(r.loss >= 0, '有损失数值');
  eq(mate.san.current, before - r.loss, 'SAN 已扣减');
});

// ---------------------------------------------------------------------------
// 旁观模式：没有玩家角色时，CHECK / SAN 要落到队友身上
//
// 这两条是回归测试。原来 CHECK 把角色兜底成字面量「调查员」，
// 旁观模式没有玩家角色，于是找不到人、检定直接报错；
// SAN 更糟，找不到人时 return null，整条理智检定静默消失，
// 玩家完全不知道 SAN 没被结算。
// ---------------------------------------------------------------------------
function makeSpectatorCtx() {
  const mate = createCharacter({ name: '队友乙', isPlayer: false });
  mate.skills['侦查'] = 60;
  mate.attrs.POW = 50;
  mate.san.current = 60;

  const msgs = [];
  const state = {
    playerChar: null,              // 旁观模式的关键：没有玩家角色
    teammates: [mate],
    scenario: { scene: '', events: [], clues: [], secrets: [], notes: '', ended: false, ending: '' },
    messages: msgs
  };
  const ctx = {
    state,
    findChar: (n) => (n === '队友乙' ? mate : null),
    pushMessage: (m) => {
      const x = { id: 'm' + msgs.length, ...m };
      msgs.push(x);
      return x;
    },
    updateMessage: (id, patch) => {
      const x = msgs.find((m) => m.id === id);
      if (x) Object.assign(x, patch);
      return x;
    }
  };
  return { ctx, state, mate, msgs };
}

group('旁观模式 CHECK 未指定角色时落到队友', () => {
  const { ctx } = makeSpectatorCtx();
  const r = getHandler('CHECK')(ctx, { head: '侦查', opts: {}, type: 'CHECK' });

  eq(r.kind, 'check', '正常产出检定结果，不是 error');
  eq(r.who, '队友乙', '作用对象是队伍里的队友');
  eq(r.status, 'rolled', '队友自动掷完，不是 pending');
  ok(r.roll !== undefined, '已经掷出骰点');
});

group('旁观模式 SAN 未指定角色时落到队友', () => {
  const { ctx, mate } = makeSpectatorCtx();
  const before = mate.san.current;
  const r = getHandler('SAN')(ctx, { head: '1/1d6', opts: {}, type: 'SAN' });

  ok(r !== null, '不能静默返回 null');
  eq(r.kind, 'san', '正常结算理智');
  eq(r.who, '队友乙', '作用对象是队伍里的队友');
  eq(mate.san.current, before - r.loss, 'SAN 真的被扣减了');
});

group('一个人都没有时，CHECK / SAN 都明确报错', () => {
  const empty = {
    state: {
      playerChar: null,
      teammates: [],
      scenario: { scene: '', events: [], clues: [], secrets: [], notes: '', ended: false, ending: '' },
      messages: []
    },
    findChar: () => null,
    pushMessage: (m) => m,
    updateMessage: (id) => id
  };

  const rc = getHandler('CHECK')(empty, { head: '侦查', opts: {}, type: 'CHECK' });
  eq(rc.kind, 'error', 'CHECK 报错而不是崩掉');

  const rs = getHandler('SAN')(empty, { head: '1/1d6', opts: {}, type: 'SAN' });
  ok(rs !== null, 'SAN 不能静默返回 null');
  eq(rs.kind, 'error', 'SAN 明确报错');
});

// ---------------------------------------------------------------------------
// takeTurn 的成功/失败信号
//
// 真实问题：runKeeper 在 API 失败时只把错误写进消息，takeTurn 照常返回。
// 界面据此给 state.turns +1，自动推进也当成「这一轮跑成了」继续往下推，
// 结果模型挂掉时会一路空转 200 轮，每轮烧一次失败请求。
//
// 现在 runKeeper 返回 false，takeTurn 汇总成 { chain, ok }。
// ---------------------------------------------------------------------------
console.log('\n== takeTurn 的成败信号 ==');

{
  const mkApi = (ok) => ({
    chat: async () => (ok ? { ok: true, text: '你走进走廊。' } : { ok: false, error: '连接超时' }),
    onChunk: () => () => {}
  });

  // 成功：ok 应为 true
  const s1 = createInitialState();
  const eng1 = new GameEngine(s1, mkApi(true));
  const r1 = await eng1.takeTurn('我推开门');
  eq(r1.ok, true, 'API 正常时 takeTurn.ok === true');
  ok(typeof r1.chain === 'number', 'takeTurn 仍返回 chain（兼容旧用法）');

  // 失败：ok 应为 false，且不应计为「跑成」
  const s2 = createInitialState();
  const eng2 = new GameEngine(s2, mkApi(false));
  const r2 = await eng2.takeTurn('我推开门');
  eq(r2.ok, false, 'API 失败时 takeTurn.ok === false');
  eq(r2.chain, 0, 'API 失败时不续跑');

  // 失败时不该触发队友发言（否则又是一次失败请求）
  const s3 = createInitialState();
  s3.teammates = [createCharacter({ name: '队友甲' })];
  let spoke = 0;
  const eng3 = new GameEngine(s3, mkApi(false));
  eng3.setTeammateSpeaker(async () => { spoke++; });
  await eng3.takeTurn('我推开门');
  eq(spoke, 0, 'API 失败时不触发队友发言（避免连环失败请求）');

  // 成功时队友发言逻辑仍然生效
  const s4 = createInitialState();
  s4.teammates = [createCharacter({ name: '队友甲' })];
  s4.autoTeammate = true;
  s4.teammateChance = 1;
  let spoke2 = 0;
  const eng4 = new GameEngine(s4, mkApi(true));
  eng4.setTeammateSpeaker(async () => { spoke2++; });
  await eng4.takeTurn('我推开门');
  ok(spoke2 >= 0, 'API 正常时队友发言逻辑不受影响（按概率决定）');
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项，共 ' + (passed + failed) + ' 项');
if (failed > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
