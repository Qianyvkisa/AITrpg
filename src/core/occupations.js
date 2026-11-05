// ---------------------------------------------------------------------------
// 职业规则与技能点 —— 数据来源：COC7空白卡23（粉）-坪改.xlsx
//
// 从「职业列表」和「本职技能」两页提取，共 225 个可用职业。每个职业带：
//   credit  信用评级范围            （职业列表!D 列）
//   pts     职业技能点公式          （职业列表!F 列，如 EDU*4 / EDU*2+MAX(STR*2,DEX*2)）
//   fixed   固定必选的本职技能      （本职技能!★）
//   social  需自行挑选的社交技能数  （本职技能!☯ 行的数字，从取悦/话术/恐吓/说服里选）
//   star    ☆ 组里选几个           （本职技能!☆ 行）
//   circle  ⊙ 组里选几个           （本职技能!⊙ 行）
//   cross   ※ 组里选几个           （本职技能!※ 行）
//   free    任意特长可选几个        （本职技能!任意特长 行）
//
// 点数规则（对应原表 人物卡!J50 的校验公式）：
//   剩余职业点 = 职业点公式结果 − 已分配到本职技能上的点
//   剩余兴趣点 = 智力×2          − 已分配到非本职技能上的点
//
// 只把「超过初始值」的部分算作分配过的点，这与原表 J/N/P 三列的分工一致：
// J 列是技能初始成功率，N/P 列才是玩家实际加的点。
// ---------------------------------------------------------------------------

/** 属性缩写 → 角色字段，公式里的 EDU / APP 据此取值 */
const ATTR_KEYS = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'LUCK'];

/** 社交技能候选：本职技能表里 ☯ 行的四个格子就是这四个 */
export const SOCIAL_SKILLS = ['取悦', '话术', '恐吓', '说服'];

export const OCCUPATIONS = [
  { name: "会计师", credit: "30-70", pts: "EDU*4", fixed: ["会计", "侦查", "图书馆使用", "法律", "聆听", "说服"], free: 2 },
  { name: "杂技演员", credit: "9-20", pts: "EDU*2+DEX*2", fixed: ["侦查", "投掷", "攀爬", "游泳", "跳跃", "闪避"], free: 2 },
  { name: "演员-戏剧演员", credit: "9-40", pts: "EDU*2+APP*2", fixed: ["乔装", "历史", "心理学", "格斗①", "格斗②", "格斗③"], social: 2, free: 1 },
  { name: "演员-电影演员", credit: "20-90", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "汽车驾驶"], social: 2, free: 2 },
  { name: "精神病医生（古典）", credit: "10-60", pts: "EDU*4", fixed: ["医学", "外语①", "外语②", "外语③", "心理学", "法律", "精神分析", "聆听"] },
  { name: "动物训练师", credit: "10-40", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["动物驯养", "博物学", "心理学", "潜行", "聆听", "跳跃", "追踪"], free: 1 },
  { name: "文物学家（原作向）", credit: "30-70", pts: "EDU*4", fixed: ["估价", "侦查", "历史", "图书馆使用", "外语①", "外语②", "外语③", "技艺①"], social: 1, free: 1 },
  { name: "古董商", credit: "30-50", pts: "EDU*4", fixed: ["会计", "估价", "历史", "图书馆使用", "导航", "汽车驾驶"], social: 2 },
  { name: "考古学家（原作向）", credit: "10-40", pts: "EDU*4", fixed: ["估价", "侦查", "历史", "图书馆使用", "外语①", "外语②", "外语③", "机械维修", "考古学"], star: ["导航", "科学①"] },
  { name: "建筑师", credit: "30-70", pts: "EDU*4", fixed: ["会计", "心理学", "母语", "法律", "说服"], star: ["图书馆使用", "计算机使用"] },
  { name: "艺术家", credit: "10-40", pts: "EDU*2+MAX(DEX*2,POW*2)", fixed: ["侦查", "外语①", "外语②", "外语③", "心理学", "技艺①"], social: 1, star: ["博物学", "历史"], free: 2 },
  { name: "精神病院看护", credit: "8-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["心理学", "急救", "潜行", "聆听", "闪避"], social: 2 },
  { name: "运动员", credit: "9-70", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["投掷", "攀爬", "游泳", "跳跃", "骑术"], social: 1, free: 1 },
  { name: "作家（原作向）", credit: "9-30", pts: "EDU*4", fixed: ["历史", "图书馆使用", "外语①", "外语②", "外语③", "心理学", "母语"], star: ["博物学", "神秘学"], free: 1 },
  { name: "酒保", credit: "8-25", pts: "EDU*2+APP*2", fixed: ["会计", "侦查", "心理学", "聆听"], social: 2, free: 1 },
  { name: "猎人", credit: "20-50", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["博物学", "导航", "射击①", "射击②", "射击③", "潜行", "追踪"], star: ["侦查", "聆听"], circle: ["外语①", "外语②", "外语③", "生存①"] },
  { name: "书商", credit: "20-40", pts: "EDU*4", fixed: ["会计", "估价", "历史", "图书馆使用", "外语①", "外语②", "外语③", "母语", "汽车驾驶"], social: 1 },
  { name: "赏金猎人", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["心理学", "汽车驾驶", "法律", "潜行", "追踪"], social: 1, star: ["电子学", "电气维修"], circle: ["射击①", "射击②", "射击③", "射击：手枪", "格斗①", "格斗②", "格斗③", "格斗：斗殴"] },
  { name: "拳击手、摔跤手", credit: "9-60", pts: "EDU*2+STR*2", fixed: ["侦查", "心理学", "恐吓", "跳跃", "闪避"], free: 2 },
  { name: "管家、男仆、女仆", credit: "9-40", pts: "EDU*4", fixed: ["侦查", "外语①", "外语②", "外语③", "心理学", "急救", "技艺①", "聆听"], star: ["会计", "估价"], free: 1 },
  { name: "神职人员", credit: "9-60", pts: "EDU*4", fixed: ["会计", "历史", "图书馆使用", "外语①", "外语②", "外语③", "心理学", "聆听"], social: 1, free: 1 },
  { name: "程序员、电子工程师（现代）", credit: "10-70", pts: "EDU*4", fixed: ["侦查", "图书馆使用", "电子学", "电气维修", "计算机使用"], free: 2 },
  { name: "黑客/骇客（现代）", credit: "10-70", pts: "EDU*4", fixed: ["侦查", "图书馆使用", "电子学", "电气维修", "计算机使用"], social: 1, free: 2 },
  { name: "牛仔", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["投掷", "生存①", "跳跃", "追踪", "闪避", "骑术"], star: ["博物学", "急救"], circle: ["射击①", "射击②", "射击③", "射击：手枪", "格斗①", "格斗②", "格斗③", "格斗：斗殴"] },
  { name: "工匠", credit: "9-35", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["会计", "侦查", "博物学", "技艺①", "技艺②", "机械维修"], free: 2 },
  { name: "罪犯-刺客", credit: "30-60", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["乔装", "射击①", "射击②", "射击③", "心理学", "机械维修", "格斗①", "格斗②", "格斗③", "潜行", "电气维修", "锁匠"] },
  { name: "罪犯-银行劫匪", credit: "5-75", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "恐吓", "操作重型机械", "格斗①", "格斗②", "格斗③", "汽车驾驶", "锁匠"], star: ["机械维修", "电气维修"], free: 1 },
  { name: "罪犯-打手、暴徒", credit: "5-30", pts: "EDU*2+STR*2", fixed: ["侦查", "射击①", "射击②", "射击③", "心理学", "格斗①", "格斗②", "格斗③", "汽车驾驶", "潜行"], social: 2 },
  { name: "罪犯-窃贼", credit: "5-40", pts: "EDU*2+DEX*2", fixed: ["估价", "侦查", "妙手", "攀爬", "潜行", "聆听", "锁匠"], star: ["机械维修", "电气维修"] },
  { name: "罪犯-欺诈师", credit: "10-65", pts: "EDU*2+APP*2", fixed: ["估价", "妙手", "心理学", "聆听"], social: 2, star: ["外语①", "外语②", "外语③", "法律"] },
  { name: "罪犯-独行罪犯", credit: "5-65", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["估价", "侦查", "心理学", "潜行"], social: 1, star: ["乔装"], circle: ["射击①", "射击②", "射击③", "射击：手枪", "格斗①", "格斗②", "格斗③", "格斗：斗殴"], cross: ["机械维修", "锁匠"] },
  { name: "罪犯-女飞贼（古典）", credit: "10-80", pts: "EDU*2+APP*2", fixed: ["技艺①", "汽车驾驶", "潜行", "聆听"], social: 2, star: ["射击：手枪", "格斗：斗殴"], free: 1 },
  { name: "罪犯-赃物贩子", credit: "20-40", pts: "EDU*2+APP*2", fixed: ["会计", "估价", "侦查", "历史", "图书馆使用"], social: 1, free: 1 },
  { name: "罪犯-赝造者", credit: "20-60", pts: "EDU*4", fixed: ["会计", "估价", "侦查", "历史", "图书馆使用", "妙手"], free: 1 },
  { name: "罪犯-走私者", credit: "20-60", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["侦查", "妙手", "导航", "射击①", "射击②", "射击③", "心理学", "聆听"], social: 1, star: ["汽车驾驶", "驾驶①"] },
  { name: "罪犯-混混", credit: "3-10", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["妙手", "射击①", "射击②", "射击③", "投掷", "攀爬", "格斗①", "格斗②", "格斗③", "潜行", "跳跃"], social: 1 },
  { name: "教团首领", credit: "30-60", pts: "EDU*4", fixed: ["会计", "侦查", "心理学", "神秘学"], social: 2, free: 2 },
  { name: "除魅师（现代）", credit: "20-50", pts: "EDU*4", fixed: ["催眠", "历史", "心理学", "汽车驾驶", "潜行", "神秘学"], social: 2, star: ["射击①", "射击②", "射击③", "射击：手枪", "格斗：斗殴"] },
  { name: "设计师", credit: "20-60", pts: "EDU*4", fixed: ["会计", "侦查", "心理学", "技艺②", "机械维修"], star: ["图书馆使用", "计算机使用"], free: 1 },
  { name: "业余艺术爱好者（原作向）", credit: "50-99", pts: "EDU*2+APP*2", fixed: ["外语①", "外语②", "外语③", "射击①", "射击②", "射击③", "技艺①", "骑术"], social: 2, free: 3 },
  { name: "潜水员", credit: "9-30", pts: "EDU*2+DEX*2", fixed: ["侦查", "急救", "机械维修", "游泳", "潜水"], free: 1 },
  { name: "医生（原作向）", credit: "30-80", pts: "EDU*4", fixed: ["医学", "心理学", "急救"], free: 2 },
  { name: "流浪者", credit: "0-5", pts: "EDU*2+MAX(DEX*2,APP*2,STR*2)", fixed: ["导航", "攀爬", "潜行", "聆听", "跳跃"], social: 1, free: 2 },
  { name: "司机-私人司机", credit: "10-40", pts: "EDU*2+DEX*2", fixed: ["侦查", "导航", "机械维修", "汽车驾驶", "聆听"], social: 2, free: 1 },
  { name: "司机-司机", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["会计", "导航", "心理学", "机械维修", "汽车驾驶", "聆听"], social: 1, free: 1 },
  { name: "司机-出租车司机", credit: "9-30", pts: "EDU*2+DEX*2", fixed: ["会计", "侦查", "导航", "机械维修", "汽车驾驶", "电气维修", "话术"], free: 1 },
  { name: "编辑", credit: "10-30", pts: "EDU*4", fixed: ["会计", "侦查", "历史", "心理学", "母语"], social: 2, free: 1 },
  { name: "政府官员", credit: "50-90", pts: "EDU*2+APP*2", fixed: ["历史", "取悦", "心理学", "恐吓", "母语", "聆听", "话术", "说服"] },
  { name: "工程师", credit: "30-60", pts: "EDU*4", fixed: ["图书馆使用", "操作重型机械", "机械维修", "电气维修"], free: 1 },
  { name: "艺人", credit: "10-40", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["乔装", "心理学", "聆听"], social: 2, free: 2 },
  { name: "探险家（古典）", credit: "55-80", pts: "EDU*2+MAX(DEX*2,APP*2,STR*2)", fixed: ["博物学", "历史", "外语①", "外语②", "外语③", "导航", "射击①", "射击②", "射击③", "生存①", "跳跃"], star: ["攀爬", "游泳"] },
  { name: "农民", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["博物学", "操作重型机械", "机械维修", "汽车驾驶", "追踪"], social: 1, free: 1 },
  { name: "联邦探员", credit: "20-40", pts: "EDU*4", fixed: ["侦查", "射击①", "射击②", "射击③", "汽车驾驶", "法律", "潜行", "说服"], free: 1 },
  { name: "消防员", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["急救", "投掷", "操作重型机械", "攀爬", "机械维修", "汽车驾驶", "跳跃", "闪避"] },
  { name: "驻外记者", credit: "10-40", pts: "EDU*4", fixed: ["历史", "外语①", "外语②", "外语③", "心理学", "母语", "聆听"], social: 2, free: 1 },
  { name: "法医", credit: "40-60", pts: "EDU*4", fixed: ["侦查", "医学", "图书馆使用", "说服"] },
  { name: "赌徒", credit: "8-50", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "侦查", "妙手", "心理学", "聆听"], social: 2 },
  { name: "黑帮-黑帮老大", credit: "60-95", pts: "EDU*2+APP*2", fixed: ["侦查", "射击①", "射击②", "射击③", "心理学", "格斗①", "格斗②", "格斗③", "法律", "聆听"], social: 2 },
  { name: "黑帮-马仔", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "心理学", "格斗①", "格斗②", "格斗③", "汽车驾驶"], social: 2, free: 2 },
  { name: "绅士、淑女", credit: "40-90", pts: "EDU*2+APP*2", fixed: ["历史", "外语①", "导航", "技艺①", "骑术"], social: 2 },
  { name: "游民", credit: "0-5", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["导航", "技艺①", "攀爬", "潜行", "聆听", "跳跃"], star: ["妙手", "锁匠"], free: 1 },
  { name: "勤杂护工", credit: "6-15", pts: "EDU*2+STR*2", fixed: ["心理学", "急救", "机械维修", "潜行", "电气维修", "聆听"], social: 1 },
  { name: "记者(原作向)-调查记者", credit: "9-30", pts: "EDU*4", fixed: ["历史", "图书馆使用", "心理学", "母语"], social: 1, free: 2 },
  { name: "记者(原作向)-通讯记者", credit: "9-30", pts: "EDU*4", fixed: ["侦查", "历史", "心理学", "潜行", "聆听"], social: 1 },
  { name: "法官", credit: "50-80", pts: "EDU*4", fixed: ["历史", "图书馆使用", "心理学", "恐吓", "母语", "法律", "聆听", "说服"] },
  { name: "实验室助理", credit: "10-30", pts: "EDU*4", fixed: ["侦查", "外语①", "电气维修", "科学②", "科学③"], star: ["图书馆使用", "计算机使用"], free: 1 },
  { name: "工人-伐木工", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["急救", "投掷", "攀爬", "机械维修", "跳跃", "闪避"], star: ["博物学"] },
  { name: "工人-矿工", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "操作重型机械", "攀爬", "机械维修", "潜行", "跳跃"], free: 1 },
  { name: "律师", credit: "20-80", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "法律"], social: 2, free: 2 },
  { name: "图书馆管理员（原作向）", credit: "9-35", pts: "EDU*4", fixed: ["会计", "图书馆使用", "外语①", "外语②", "外语③", "母语"], free: 4 },
  { name: "技师", credit: "9-40", pts: "EDU*4", fixed: ["技艺①", "技艺②", "技艺③", "操作重型机械", "攀爬", "机械维修", "汽车驾驶", "电气维修"], free: 2 },
  { name: "军官", credit: "20-70", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["会计", "导航", "射击①", "射击②", "射击③", "心理学", "急救"], social: 2, free: 1 },
  { name: "传教士", credit: "0-30", pts: "EDU*2+APP*2", fixed: ["医学", "博物学", "急救", "技艺①", "机械维修"], social: 1, free: 2 },
  { name: "登山家", credit: "30-60", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["外语①", "外语②", "外语③", "导航", "急救", "攀爬", "聆听", "跳跃", "追踪"] },
  { name: "博物馆管理员", credit: "10-30", pts: "EDU*4", fixed: ["会计", "估价", "侦查", "历史", "图书馆使用", "外语①", "外语②", "外语③", "神秘学", "考古学"] },
  { name: "音乐家", credit: "9-30", pts: "EDU*2+MAX(POW*2,DEX*2)", fixed: ["心理学", "聆听"], social: 1, free: 4 },
  { name: "护士", credit: "9-30", pts: "EDU*4", fixed: ["侦查", "医学", "心理学", "急救", "聆听"], social: 1 },
  { name: "神秘学家", credit: "9-65", pts: "EDU*4", fixed: ["人类学", "历史", "图书馆使用", "外语①", "外语②", "外语③", "神秘学"], social: 1, free: 1 },
  { name: "旅行家", credit: "5-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "博物学", "导航", "射击①", "射击②", "射击③", "急救", "生存①", "聆听", "追踪"] },
  { name: "超心理学家", credit: "9-30", pts: "EDU*4", fixed: ["人类学", "历史", "图书馆使用", "外语①", "外语②", "外语③", "心理学", "神秘学"], free: 1 },
  { name: "药剂师", credit: "35-75", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "急救"], social: 1 },
  { name: "摄影师-摄影师", credit: "9-30", pts: "EDU*4", fixed: ["侦查", "心理学", "潜行"], social: 1, free: 2 },
  { name: "摄影师-摄影记者", credit: "10-30", pts: "EDU*4", fixed: ["外语①", "外语②", "外语③", "心理学", "攀爬"], social: 1, free: 2 },
  { name: "飞行员-飞行员", credit: "20-70", pts: "EDU*2+DEX*2", fixed: ["导航", "操作重型机械", "机械维修", "电气维修"], free: 2 },
  { name: "飞行员-特技飞行员（古典）", credit: "30-60", pts: "EDU*4", fixed: ["会计", "侦查", "导航", "机械维修", "电气维修", "聆听"], free: 1 },
  { name: "警方(原作向)-警探", credit: "20-50", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "射击①", "射击②", "射击③", "心理学", "法律", "聆听"], social: 1, star: ["乔装"], free: 1 },
  { name: "警方(原作向)-巡警", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "射击①", "射击②", "射击③", "心理学", "急救", "法律"], star: ["汽车驾驶", "骑术"] },
  { name: "私家侦探", credit: "9-40", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["乔装", "侦查", "图书馆使用", "心理学", "法律"], social: 1, free: 1 },
  { name: "教授（原作向）", credit: "20-70", pts: "EDU*4", fixed: ["图书馆使用", "外语①", "外语②", "外语③", "心理学", "母语"], free: 4 },
  { name: "淘金客", credit: "0-10", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "历史", "导航", "急救", "攀爬", "机械维修"], free: 1 },
  { name: "性工作者", credit: "5-50", pts: "EDU*2+APP*2", fixed: ["妙手", "心理学", "技艺①", "潜行", "闪避"], social: 2, free: 1 },
  { name: "精神病学家", credit: "30-80", pts: "EDU*4", fixed: ["医学", "外语①", "外语②", "外语③", "心理学", "精神分析", "聆听", "说服"] },
  { name: "心理学家、精神分析学家", credit: "10-40", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "精神分析", "聆听", "说服"], free: 2 },
  { name: "研究员", credit: "9-30", pts: "EDU*4", fixed: ["侦查", "历史", "图书馆使用", "外语①", "外语②", "外语③"], social: 1, free: 3 },
  { name: "海员-军舰海员", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["导航", "射击①", "射击②", "射击③", "急救", "格斗①", "格斗②", "格斗③", "游泳"], star: ["机械维修", "电气维修"] },
  { name: "海员-民船海员", credit: "20-40", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "博物学", "导航", "急救", "机械维修", "游泳"], social: 1 },
  { name: "推销员", credit: "9-40", pts: "EDU*2+APP*2", fixed: ["会计", "心理学", "汽车驾驶", "聆听"], social: 2, star: ["妙手", "潜行"], free: 1 },
  { name: "科学家", credit: "10-60", pts: "EDU*4", fixed: ["侦查", "外语①", "外语②", "外语③", "母语", "科学①", "科学②", "科学③"], social: 1, star: ["图书馆使用", "计算机使用"] },
  { name: "秘书", credit: "9-30", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "心理学", "母语"], social: 2, circle: ["图书馆使用", "计算机使用"], free: 1 },
  { name: "店老板", credit: "20-40", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "侦查", "心理学", "机械维修", "电气维修", "聆听"], social: 2 },
  { name: "士兵、海军陆战队士兵", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "格斗①", "格斗②", "格斗③", "潜行", "生存①", "闪避"], star: ["攀爬", "游泳"], cross: ["外语①", "急救", "机械维修"] },
  { name: "间谍", credit: "20-60", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["外语①", "外语②", "外语③", "妙手", "射击①", "射击②", "射击③", "心理学", "潜行", "聆听"], social: 1, star: ["乔装"] },
  { name: "学生、实习生", credit: "5-10", pts: "EDU*4", fixed: ["图书馆使用", "聆听"], star: ["外语①", "外语②", "外语③", "母语"], free: 5 },
  { name: "替身演员", credit: "10-50", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["急救", "攀爬", "格斗①", "格斗②", "格斗③", "游泳", "跳跃", "闪避"], star: ["机械维修", "电气维修"], cross: ["汽车驾驶", "潜水", "驾驶①", "骑术"] },
  { name: "部落成员", credit: "0-15", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "博物学", "攀爬", "游泳", "生存①", "神秘学", "聆听"], star: ["投掷", "格斗①", "格斗②", "格斗③", "格斗：斗殴"] },
  { name: "殡葬师", credit: "20-40", pts: "EDU*4", fixed: ["会计", "历史", "心理学", "汽车驾驶", "神秘学"], social: 1 },
  { name: "工会活动家", credit: "5-50", pts: "EDU*4", fixed: ["会计", "心理学", "操作重型机械", "法律", "聆听"], social: 2 },
  { name: "服务生", credit: "9-20", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "心理学", "技艺①", "聆听", "闪避"], social: 2, free: 1 },
  { name: "白领工人-职员、主管", credit: "9-20", pts: "EDU*4", fixed: ["会计", "外语①", "外语②", "外语③", "母语", "法律", "聆听"], social: 1, star: ["图书馆使用", "计算机使用"], free: 2 },
  { name: "白领工人-中高层管理人员", credit: "20-80", pts: "EDU*4", fixed: ["会计", "外语①", "外语②", "外语③", "心理学", "法律"], social: 2, free: 2 },
  { name: "狂热者", credit: "0-30", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["历史", "心理学", "潜行"], social: 2, free: 3 },
  { name: "饲养员", credit: "9-40", pts: "EDU*4", fixed: ["会计", "动物驯养", "医学", "博物学", "急救", "闪避"] },
  { name: "大使", credit: "50-90", pts: "EDU*2+APP*2", fixed: ["历史", "取悦", "心理学", "恐吓", "母语", "聆听", "话术", "说服"] },
  { name: "运动员（游泳/潜水）", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["外语①", "投掷", "攀爬", "游泳", "跳跃"], social: 1, free: 1 },
  { name: "运动员（高尔夫）", credit: "50-70", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["投掷", "攀爬", "游泳", "跳跃", "骑术"], social: 1, free: 1 },
  { name: "运动员（网球）", credit: "30-70", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "心理学", "投掷", "跳跃", "闪避"], social: 1, free: 1 },
  { name: "运动员（田径）", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["外语①", "投掷", "攀爬", "跳跃", "闪避"], social: 1, free: 1 },
  { name: "发言人", credit: "50-80", pts: "EDU*4", fixed: ["乔装", "外语①", "外语②", "外语③", "心理学", "闪避"], social: 3, free: 1 },
  { name: "保释担保人", credit: "50-80", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "法律"], social: 2, free: 2 },
  { name: "神职人员(天主教牧师)", credit: "20-70", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "母语", "神秘学"], social: 1, free: 1 },
  { name: "神职人员(新教牧师)", credit: "9-60", pts: "EDU*4", fixed: ["会计", "历史", "图书馆使用", "心理学", "聆听"], social: 1, free: 1 },
  { name: "神职人员(犹太教拉比)", credit: "9-60", pts: "EDU*4", fixed: ["历史", "图书馆使用", "心理学", "母语", "神秘学"], social: 1, free: 1 },
  { name: "专栏作家", credit: "30-70", pts: "EDU*4", fixed: ["乔装", "历史", "图书馆使用", "外语①", "外语②", "外语③", "心理学", "母语", "潜行"], social: 1 },
  { name: "社会主义者/激进主义者", credit: "0-30", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["外语①", "外语②", "外语③", "心理学"], social: 2, free: 2 },
  { name: "撰稿人", credit: "20-60", pts: "EDU*4", fixed: ["历史", "图书馆使用", "心理学", "母语", "聆听"], social: 2 },
  { name: "罪犯（赌博庄家）", credit: "50-80", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "侦查", "妙手", "心理学"], social: 2, free: 1 },
  { name: "罪犯（放高利贷者）", credit: "50-80", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "估价", "侦查", "心理学"], social: 2, free: 2 },
  { name: "罪犯（扒手）", credit: "9-30", pts: "EDU*2+DEX*2", fixed: ["乔装", "侦查", "妙手", "心理学", "潜行", "聆听"], social: 1, free: 1 },
  { name: "罪犯（地下钱庄）", credit: "30-70", pts: "EDU*4", fixed: ["会计", "侦查", "图书馆使用", "法律", "聆听", "说服"], free: 2 },
  { name: "罪犯（黑律师）", credit: "30-80", pts: "EDU*4", fixed: ["会计", "图书馆使用", "心理学", "法律"], social: 2, free: 2 },
  { name: "牙医", credit: "30-70", pts: "EDU*4", fixed: ["医学", "心理学", "急救"], free: 2 },
  { name: "外科医生/内科医生", credit: "50-80", pts: "EDU*4", fixed: ["医学", "心理学", "急救"], free: 2 },
  { name: "整形医生", credit: "30-80", pts: "EDU*4", fixed: ["医学", "心理学", "急救"], free: 2 },
  { name: "司机-公交司机", credit: "30-50", pts: "EDU*2+DEX*2", fixed: ["会计", "导航", "心理学", "机械维修", "汽车驾驶", "电气维修"], social: 1, free: 1 },
  { name: "实地调研员", credit: "9-30", pts: "EDU*4", fixed: ["会计", "图书馆使用", "外语①", "外语②", "外语③", "急救"], social: 1, star: ["攀爬", "跳跃"], free: 2 },
  { name: "电影摄制人员", credit: "9-30", pts: "EDU*2+MAX(DEX*2,POW*2)", fixed: ["技艺①", "攀爬", "机械维修", "汽车驾驶", "电气维修"], social: 1, free: 2 },
  { name: "运动经理", credit: "20-70", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["会计", "心理学", "急救", "闪避"], social: 2, free: 1 },
  { name: "商船队船员", credit: "20-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["人类学", "外语①", "外语②", "外语③", "操作重型机械", "攀爬", "跳跃"], star: ["机械维修", "电气维修"], free: 1 },
  { name: "古典音乐家", credit: "9-30", pts: "EDU*2+MAX(POW*2,DEX*2)", fixed: ["会计", "心理学", "聆听"], social: 1, free: 3 },
  { name: "电台播音员", credit: "50-80", pts: "EDU*4", fixed: ["取悦", "心理学", "母语", "话术", "说服"], free: 2 },
  { name: "推销员（圣经推销员）", credit: "9-40", pts: "EDU*2+APP*2", fixed: ["会计", "心理学", "汽车驾驶", "聆听"], social: 2, star: ["妙手", "潜行"], free: 1 },
  { name: "推销员（旅行推销员）", credit: "9-30", pts: "EDU*2+APP*2", fixed: ["会计", "导航", "心理学", "汽车驾驶", "聆听"], social: 2, free: 1 },
  { name: "小企业家", credit: "50-70", pts: "EDU*4", fixed: ["会计", "心理学"], social: 2, free: 4 },
  { name: "舞台工作人员", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["乔装", "心理学", "技艺①", "母语"], social: 2, free: 2 },
  { name: "证券经纪人", credit: "60-90", pts: "EDU*4", fixed: ["会计", "估价", "心理学", "母语"], social: 2, free: 2 },
  { name: "勘测员", credit: "20-60", pts: "EDU*4", fixed: ["会计", "侦查", "博物学", "图书馆使用", "导航", "生存①"], free: 1 },
  { name: "电话接线员", credit: "20-50", pts: "EDU*4", fixed: ["外语①", "外语②", "外语③", "心理学", "母语", "聆听"], social: 2, free: 2 },
  { name: "星探", credit: "9-30", pts: "EDU*4", fixed: ["会计", "侦查", "心理学", "法律"], social: 2, free: 2 },
  { name: "医疗技术员", credit: "30-60", pts: "EDU*4", fixed: ["医学", "图书馆使用", "机械维修", "电气维修"] },
  { name: "队医", credit: "9-30", pts: "EDU*4", fixed: ["侦查", "医学", "心理学", "急救"], social: 2, free: 1 },
  { name: "寻宝猎人", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["估价", "侦查", "历史", "攀爬", "汽车驾驶", "跳跃", "驾驶①"], social: 1, star: ["机械维修", "电气维修"] },
  { name: "西部治安官", credit: "20-50", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "汽车驾驶", "法律", "追踪", "骑术"], star: ["心理学", "说服"] },
  { name: "暴走族", credit: "5-10", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["恐吓", "机械维修", "汽车驾驶", "话术"], free: 3 },
  { name: "神职人员(和尚,尼姑)", credit: "5-60", pts: "EDU*4", fixed: ["学识①", "心理学", "聆听"], social: 1, star: ["历史", "图书馆使用"], free: 1 },
  { name: "神职人员(神官,巫女)", credit: "20-60", pts: "EDU*4", fixed: ["图书馆使用", "学识①", "心理学", "技艺②", "神秘学"], social: 1, free: 1 },
  { name: "风水师", credit: "20-50", pts: "EDU*4", fixed: ["图书馆使用", "学识①", "技艺①", "神秘学"], social: 1, free: 1 },
  { name: "家传降妖人", credit: "9-20", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["博物学", "学识①", "心理学", "潜行", "神秘学"], free: 2 },
  { name: "高中生(教育60以下)", credit: "5-10", pts: "EDU*4", fixed: ["图书馆使用", "外语①", "攀爬", "母语", "潜行", "跳跃"], star: ["历史", "科学①"] },
  { name: "市子（盲人）", credit: "5-30", pts: "EDU*4", fixed: ["历史", "学识①", "心理学", "神秘学", "聆听"], star: ["话术", "说服"], free: 1 },
  { name: "言灵师/阴阳师", credit: "9-20", pts: "EDU*4", fixed: ["学识①", "技艺②", "神秘学"], star: ["历史", "图书馆使用"], free: 1 },
  { name: "炼丹师", credit: "30-50", pts: "EDU*4", fixed: ["医学", "博物学", "图书馆使用", "学识①", "神秘学"], star: ["急救", "精神分析"] },
  { name: "外语教师", credit: "30-60", pts: "EDU*4", fixed: ["历史", "心理学", "母语", "聆听"], social: 2, free: 2 },
  { name: "非法移民", credit: "0-5", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["乔装", "侦查", "妙手", "心理学", "潜行", "聆听", "话术"], free: 1 },
  { name: "相扑力士(SIZ>80,STR>70)", credit: "9-60", pts: "EDU*2+STR*2", fixed: ["侦查", "心理学", "恐吓", "跳跃", "闪避"], free: 2 },
  { name: "渔民", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "博物学", "导航", "操作重型机械", "机械维修", "游泳"] },
  { name: "心理治疗师", credit: "30-50", pts: "EDU*4", fixed: ["外语①", "外语②", "外语③", "心理学", "技艺①", "法律", "精神分析"], social: 2, free: 1 },
  { name: "女学生", credit: "5-10", pts: "EDU*4", fixed: ["图书馆使用", "外语①", "外语②", "外语③", "急救", "技艺①", "聆听", "骑术"], social: 1 },
  { name: "寄居学生", credit: "5-10", pts: "EDU*4", fixed: ["会计", "图书馆使用", "外语①", "急救", "说服"], free: 2 },
  { name: "动物辅助治疗师", credit: "30-50", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["博物学", "心理学", "精神分析", "聆听", "跳跃", "追踪"], free: 1 },
  { name: "急诊医生/救援队员", credit: "10-50", pts: "EDU*4", fixed: ["医学", "急救", "攀爬", "机械维修", "电气维修", "跳跃", "锁匠"] },
  { name: "密医", credit: "10-70", pts: "EDU*4", fixed: ["会计", "医学", "外语①", "外语②", "外语③", "急救", "法律"], social: 1, free: 1 },
  { name: "科学搜查研究员", credit: "30-50", pts: "EDU*4", fixed: ["侦查", "医学", "法律"], free: 1 },
  { name: "山岳救援队员", credit: "10-50", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["外语①", "外语②", "外语③", "导航", "急救", "攀爬", "聆听", "跳跃", "追踪"] },
  { name: "舞者", credit: "9-70", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "聆听"], social: 2, free: 2 },
  { name: "服装设计师", credit: "20-60", pts: "EDU*4", fixed: ["乔装", "会计", "侦查", "心理学", "技艺②"], star: ["图书馆使用", "计算机使用"], free: 1 },
  { name: "海上自卫队员", credit: "9-30", pts: "EDU*4", fixed: ["导航", "射击①", "射击②", "射击③", "急救", "机械维修", "格斗①", "格斗②", "格斗③", "游泳", "电气维修"] },
  { name: "海警", credit: "20-40", pts: "EDU*4", fixed: ["侦查", "博物学", "导航", "急救", "机械维修", "游泳"], social: 1 },
  { name: "陆上自卫队员", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "格斗①", "格斗②", "格斗③", "潜行", "生存①", "闪避"], star: ["攀爬", "游泳"], cross: ["外语①", "急救", "机械维修"] },
  { name: "私人军事公司成员", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "格斗①", "格斗②", "格斗③", "潜行", "生存①", "闪避"], star: ["攀爬", "游泳"], cross: ["外语①", "急救", "机械维修"] },
  { name: "冒险家教授", credit: "55-80", pts: "EDU*2+MAX(DEX*2,APP*2,STR*2)", fixed: ["博物学", "历史", "外语①", "外语②", "外语③", "导航", "射击①", "射击②", "射击③", "生存①", "跳跃"], star: ["攀爬", "游泳"] },
  { name: "评论家", credit: "30-70", pts: "EDU*4", fixed: ["乔装", "外语①", "外语②", "外语③", "心理学", "母语", "潜行"], social: 1, star: ["历史", "图书馆使用"] },
  { name: "偶像", credit: "9-70", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "聆听"], social: 2, free: 2 },
  { name: "歌手", credit: "9-70", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "聆听"], social: 2, free: 2 },
  { name: "搞笑艺人", credit: "9-70", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "聆听"], social: 2, free: 2 },
  { name: "运动员艺人", credit: "9-20", pts: "EDU*2+DEX*2", fixed: ["侦查", "投掷", "攀爬", "游泳", "跳跃", "闪避"], free: 2 },
  { name: "播音员", credit: "50-80", pts: "EDU*4", fixed: ["取悦", "心理学", "母语", "话术", "说服"], free: 2 },
  { name: "主持人", credit: "50-80", pts: "EDU*4", fixed: ["取悦", "心理学", "母语", "话术", "说服"], free: 2 },
  { name: "电视解说员", credit: "50-80", pts: "EDU*4", fixed: ["取悦", "心理学", "母语", "话术", "说服"], free: 2 },
  { name: "网络明星", credit: "9-70", pts: "EDU*2+APP*2", fixed: ["乔装", "心理学", "电气维修", "聆听", "计算机使用"], social: 2 },
  { name: "经纪人", credit: "30-70", pts: "EDU*4", fixed: ["汽车驾驶", "法律", "潜行", "聆听"], social: 2, free: 2 },
  { name: "捉鬼人", credit: "9-30", pts: "EDU*2+DEX*2", fixed: ["机械维修", "电气维修", "神秘学"], social: 1 },
  { name: "占卜师、灵媒师", credit: "9-30", pts: "EDU*2+MAX(EDU*2,APP*2)", fixed: ["历史", "图书馆使用", "心理学", "神秘学"], social: 2, free: 1 },
  { name: "机械师", credit: "9-40", pts: "EDU*4", fixed: ["操作重型机械", "攀爬", "机械维修", "汽车驾驶", "电气维修"], free: 2 },
  { name: "厨师", credit: "9-30", pts: "EDU*2+DEX*2", fixed: ["侦查", "博物学", "外语①", "外语②", "外语③"], free: 1 },
  { name: "网络犯罪者", credit: "10-70", pts: "EDU*4", fixed: ["侦查", "图书馆使用", "电子学", "电气维修", "计算机使用"], social: 1, free: 2 },
  { name: "佣兵", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["射击①", "射击②", "射击③", "格斗①", "格斗②", "格斗③", "潜行", "生存①", "闪避"], star: ["攀爬", "游泳"], cross: ["外语①", "急救", "机械维修"] },
  { name: "自宅警备员", credit: "1-10", pts: "EDU*4", fixed: ["图书馆使用", "母语", "潜行", "聆听", "计算机使用"], free: 3 },
  { name: "壮汉保镖", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "射击①", "射击②", "射击③", "心理学", "急救", "法律"], social: 1, star: ["汽车驾驶", "骑术"] },
  { name: "游戏测试员", credit: "9-20", pts: "EDU*4", fixed: ["电子学", "电气维修", "聆听", "计算机使用"], social: 1, free: 2 },
  { name: "交际花", credit: "9-30", pts: "EDU*2+APP*2", fixed: ["估价", "外语①", "心理学", "急救", "技艺①", "潜行", "骑术"], social: 1, star: ["乔装", "锁匠"], free: 1 },
  { name: "考古学家", credit: "30-60", pts: "EDU*4", fixed: ["会计", "估价", "侦查", "历史", "图书馆使用", "心理学", "技艺①"], social: 1, free: 2 },
  { name: "贵族", credit: "70-99", pts: "EDU*2+MAX(EDU*2,APP*2)", fixed: ["法律", "骑术"], free: 3 },
  { name: "艺术家", credit: "10-40", pts: "EDU*2+MAX(DEX*2,POW*2)", fixed: ["估价", "侦查", "历史", "图书馆使用", "技艺①"], free: 2 },
  { name: "作家", credit: "10-40", pts: "EDU*4", fixed: ["历史", "图书馆使用", "心理学", "母语"], social: 1, free: 2 },
  { name: "马车夫", credit: "3-10", pts: "EDU*2+DEX*2", fixed: ["博物学", "导航", "心理学", "机械维修", "汽车驾驶", "聆听", "跳跃", "闪避"], social: 1, free: 1 },
  { name: "牧师", credit: "20-65", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["历史", "图书馆使用", "心理学"], social: 1, free: 2 },
  { name: "咨询侦探", credit: "10-60", pts: "EDU*4", fixed: ["人类学", "估价", "侦查", "历史", "图书馆使用", "外语①", "心理学", "急救", "法律", "聆听", "追踪"], free: 2 },
  { name: "工匠", credit: "9-35", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["会计", "估价", "侦查", "技艺①", "机械维修"], social: 1, free: 1 },
  { name: "罪犯", credit: "9-30", pts: "EDU*2+MAX(DEX*2,APP*2,STR*2)", fixed: ["乔装", "估价", "格斗①", "格斗②", "格斗③", "潜行", "锁匠"], social: 1, free: 1 },
  { name: "业余艺术爱好者", credit: "10-70", pts: "EDU*2+APP*2", fixed: [], free: 6 },
  { name: "艺人", credit: "10-40", pts: "EDU*2+MAX(APP*2,POW*2)", fixed: ["乔装", "心理学", "技艺①", "母语", "聆听", "闪避"], social: 2, free: 3 },
  { name: "退役军官", credit: "40-75", pts: "EDU*4", fixed: ["侦查", "外语①", "导航", "心理学", "急救", "潜行", "骑术"], social: 1, star: ["攀爬", "游泳"] },
  { name: "探险家", credit: "45-70", pts: "EDU*2+MAX(DEX*2,APP*2,STR*2)", fixed: ["人类学", "估价", "侦查", "博物学", "外语①", "导航", "急救", "攀爬", "游泳", "潜行", "考古学", "追踪", "骑术"] },
  { name: "私家侦探", credit: "9-40", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["会计", "侦查", "图书馆使用", "法律", "聆听", "锁匠"], social: 2, free: 1 },
  { name: "记者", credit: "9-30", pts: "EDU*2+MAX(DEX*2,APP*2)", fixed: ["估价", "侦查", "图书馆使用", "心理学", "母语", "聆听", "闪避"], social: 2 },
  { name: "劳工", credit: "0-10", pts: "EDU*2+STR*2", fixed: ["估价", "急救", "操作重型机械", "机械维修", "闪避"], cross: ["技艺①", "攀爬", "格斗：斗殴", "汽车驾驶", "驾驶①"], free: 1 },
  { name: "律师", credit: "20-80", pts: "EDU*4", fixed: ["会计", "估价", "历史", "图书馆使用", "心理学", "法律", "聆听"], social: 2, free: 2 },
  { name: "医生", credit: "30-70", pts: "EDU*4", fixed: ["医学", "图书馆使用", "心理学", "急救"], free: 2 },
  { name: "警察", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "心理学", "急救", "法律", "潜行", "聆听", "闪避"], social: 1 },
  { name: "教授/学者", credit: "20-50", pts: "EDU*4", fixed: ["图书馆使用", "心理学"], social: 1, free: 6 },
  { name: "科学家", credit: "10-60", pts: "EDU*4", fixed: ["侦查", "历史", "图书馆使用", "技艺①", "机械维修"], social: 1, free: 6 },
  { name: "佣人", credit: "0-10", pts: "EDU*2+MAX(APP*2,DEX*2)", fixed: ["技艺①", "潜行", "聆听", "闪避"], cross: ["会计", "估价", "外语①", "急救", "汽车驾驶", "说服"], free: 1 },
  { name: "店主", credit: "9-30", pts: "EDU*2+MAX(APP*2,DEX*2)", fixed: ["会计", "估价", "侦查", "心理学", "技艺①", "聆听"], social: 1, free: 1 },
  { name: "士兵", credit: "9-30", pts: "EDU*2+MAX(STR*2,DEX*2)", fixed: ["侦查", "急救", "机械维修", "潜行", "聆听", "闪避"], free: 2 },
  { name: "密探", credit: "30-70", pts: "EDU*2+MAX(APP*2,DEX*2)", fixed: ["乔装", "侦查", "历史", "图书馆使用", "导航", "心理学", "潜行", "聆听", "锁匠"], social: 1 },
];

/**
 * 别名表：把口语化的职业名映射到职业表里的标准名。
 *
 * 队友模板和 AI 车出来的卡常写「退伍军医」「大学讲师」这种叫法，
 * 它们不在那 225 个标准名里。只做字符串匹配的话会查不到职业，
 * 职业点直接算成 0，技能页还会显示「还没填职业」。
 *
 * 这里保留角色卡上原本的名字（人设更有味道），只在查表时换成标准职业。
 */
export const OCCUPATION_ALIASES = {
  // 医疗
  '退伍军医': '队医',
  '军医': '队医',
  '随队医生': '队医',
  '护士长': '护士',
  '急救员': '急诊医生/救援队员',
  // 学术 / 教育
  '大学讲师': '教授/学者',
  '讲师': '教授/学者',
  '大学教授': '教授（原作向）',
  '教师': '外语教师',
  '老师': '外语教师',
  '图书馆员': '图书馆管理员（原作向）',
  '图书管理员': '图书馆管理员（原作向）',
  '博物馆员': '博物馆管理员',
  // 体力 / 劳工
  '码头工人': '劳工',
  '搬运工': '劳工',
  '装卸工': '劳工',
  '建筑工人': '工匠',
  '矿工': '工人-矿工',
  '伐木工': '工人-伐木工',
  '船员': '商船队船员',
  '水手': '海员-民船海员',
  // 治安 / 地下
  '侦探': '私家侦探',
  '刑警': '警方(原作向)-警探',
  '巡警': '警方(原作向)-巡警',
  '小混混': '罪犯-混混',
  '打手': '罪犯-打手、暴徒',
  '小偷': '罪犯-窃贼',
  '杀手': '罪犯-刺客',
  // 现代
  '黑客': '黑客/骇客（现代）',
  '程序员': '程序员、电子工程师（现代）'
};

/** 按名字找职业；容忍「侦探」「演员」这类简称，以及上表的别名 */
export function findOccupation(name) {
  const n = String(name || '').trim();
  if (!n) return null;

  const exact = OCCUPATIONS.find((o) => o.name === n);
  if (exact) return exact;

  // 别名要排在模糊匹配之前，否则「退伍军医」可能被别的规则先吃掉
  const alias = OCCUPATION_ALIASES[n];
  if (alias) {
    const hit = OCCUPATIONS.find((o) => o.name === alias);
    if (hit) return hit;
  }

  const prefix = OCCUPATIONS.find((o) => o.name.startsWith(n));
  if (prefix) return prefix;

  return OCCUPATIONS.find((o) => o.name.includes(n)) || null;
}

/**
 * 为识别不了职业名给出候选，供界面提示用。
 *
 * 不伪造点数：规则不能凭空编，宁可明确告诉玩家「这个名字不在表里」，
 * 再给几个最接近的标准职业让他自己选。
 *
 * @param {string} name 玩家填的职业名
 * @param {number} limit 最多返回几个
 * @returns {string[]} 候选标准职业名
 */
export function suggestOccupations(name, limit = 5) {
  const n = String(name || '').trim();
  if (!n) return [];

  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };

  // 先按两字重合找相近的
  const target = grams(n);
  const scored = [];
  for (const o of OCCUPATIONS) {
    const og = grams(o.name);
    let score = 0;
    for (const g of target) if (og.has(g)) score++;
    if (score > 0) scored.push({ name: o.name, score });
  }

  if (scored.length) {
    return scored
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
      .slice(0, limit)
      .map((x) => x.name);
  }

  // 两字完全不沾边时退一步按单字重合，避免「赛博格」这种给不出任何候选
  const singles = new Set(n);
  const byChar = [];
  for (const o of OCCUPATIONS) {
    let score = 0;
    for (const c of singles) if (o.name.includes(c)) score++;
    if (score > 0) byChar.push({ name: o.name, score });
  }

  return byChar
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map((x) => x.name);
}

/** 单个项求值，如 "EDU*4"、"STR*2" */
function termValue(term, get) {
  const m = String(term).match(/^([A-Z]{2,3})(?:\*(\d+))?$/i);
  if (!m) return 0;
  const key = m[1].toUpperCase();
  if (!ATTR_KEYS.includes(key)) return 0;
  const mult = m[2] ? parseInt(m[2], 10) : 1;
  return get(key) * mult;
}

/**
 * 求值职业点数公式。
 * 支持表里出现的两种形态：EDU*4 和 EDU*2+MAX(STR*2,DEX*2)。
 * 属性缺失按 0 处理，避免角色卡没填完时报错。
 */
export function evalOccupationFormula(formula, attrs) {
  const a = attrs || {};
  const get = (k) => {
    const v = Number(a[k]);
    return Number.isFinite(v) ? v : 0;
  };

  const src = String(formula || '').replace(/\s/g, '');
  if (!src) return 0;

  let total = 0;
  for (const term of src.split('+').filter(Boolean)) {
    const maxMatch = term.match(/^MAX\((.+)\)$/i);
    if (maxMatch) {
      const vals = maxMatch[1].split(',').map((p) => termValue(p, get));
      total += Math.max(...vals, 0);
    } else {
      total += termValue(term, get);
    }
  }
  return total;
}

/** 职业点总额 */
export function occupationTotal(ch) {
  const occ = findOccupation(ch?.occupation);
  return occ ? evalOccupationFormula(occ.pts, ch.attrs) : 0;
}

/** 兴趣点总额 = 智力×2（原表 AA7+AA7） */
export function interestTotal(ch) {
  const int = Number(ch?.attrs?.INT);
  return Number.isFinite(int) ? int * 2 : 0;
}

/**
 * 判断某技能是否算这个职业的本职技能。
 *
 * 只看 fixed 是不够的：很多职业写着「一项社交技能」「任意特长」，
 * 玩家选了话术或自定义技能后，那些点也该记在职业点里。
 * 所以这里把 fixed、社交候选、☆⊙※ 候选，以及玩家自填的 customNames
 * 全部纳入本职范围。
 *
 * @param {object} ch   角色卡
 * @param {string} skillName 技能名（如 "话术"、"技艺①"）
 * @param {(name:string)=>string} displayOf 取自定义子技能名的函数
 */
export function isOccupationalSkill(ch, skillName, displayOf) {
  const occ = findOccupation(ch?.occupation);
  if (!occ) return false;

  if (occ.fixed?.includes(skillName)) return true;

  // 社交技能：职业要求「N 项社交技能」时，这四个都算本职候选
  if (occ.social > 0 && SOCIAL_SKILLS.includes(skillName)) return true;

  // ☆ ⊙ ※ 组里的候选
  for (const group of [occ.star, occ.circle, occ.cross]) {
    if (Array.isArray(group) && group.includes(skillName)) return true;
  }

  // 「任意特长」：玩家自填了具体名字的技能都算本职。
  // 比如技艺①填「摄影」、外语①填「拉丁语」，这类都归职业点。
  if (occ.free > 0 && typeof displayOf === 'function') {
    const custom = displayOf(skillName);
    if (custom && custom.trim()) return true;
  }

  return false;
}

/**
 * 汇总技能点账目。
 *
 * @param {object} ch 角色卡
 * @param {(skillName:string)=>number} baseOf 取技能初始值（会计 5、闪避 DEX/2…）
 * @param {(skillName:string)=>boolean} isOcc 判断是否本职技能
 * @returns {{occTotal,occUsed,occLeft,intTotal,intUsed,intLeft,occupation}}
 */
export function skillPointBudget(ch, baseOf, isOcc) {
  const occTotal = occupationTotal(ch);
  const intTotal = interestTotal(ch);

  let occUsed = 0;
  let intUsed = 0;

  for (const [name, val] of Object.entries(ch?.skills || {})) {
    const spent = Number(val) - baseOf(name);
    if (!Number.isFinite(spent) || spent <= 0) continue;

    if (isOcc(name)) occUsed += spent;
    else intUsed += spent;
  }

  return {
    occupation: findOccupation(ch?.occupation),
    occTotal,
    occUsed,
    occLeft: occTotal - occUsed,
    intTotal,
    intUsed,
    intLeft: intTotal - intUsed
  };
}
