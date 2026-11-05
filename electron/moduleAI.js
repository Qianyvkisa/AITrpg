'use strict';

// ---------------------------------------------------------------------------
// 用 AI 理解模组素材：把零散的文件/图片整理成一份可用的模组
//
// 走视觉模型时把图片一起发过去；模型不支持视觉则退化为只发文字。
// ---------------------------------------------------------------------------
const { resolveTarget, buildEndpoint, isLocalEndpoint } = require('./defaults');

/**
 * 理解素材时给模型的最大输出 token。
 * 真实模组（如 30 页的长篇）整理出来的 JSON 很容易超过 4096，
 * 之前用 4096 会被硬截断成半截 JSON，表现为「返回的不是合法 JSON」。
 */
const UNDERSTAND_MAX_TOKENS = 8192;

/** 单次理解请求的超时（毫秒）。长模组输出 8000 token 可能要跑一两分钟 */
const UNDERSTAND_TIMEOUT_MS = 300000;

/** 组装给 AI 的理解指令 */
function buildUnderstandPrompt({ folderName, materialsText, imageCount }) {
  const sys = `你是《克苏鲁的呼唤》第 7 版的资深守密人（KP），擅长把零散的素材整理成可直接开团的模组。

你会收到一个模组文件夹里的全部材料：Word/PDF 正文、txt 笔记、以及随附的图片（地图、手绘、NPC 立绘、线索道具照片等）。
你的任务是通读并理解它们，整理成一份结构化的模组底稿。

要求：
1. 忠于原材料。不要凭空编造与原素材冲突的剧情、NPC 或真相；素材没写的地方可以合理补全，但要自然衔接。
2. 图片要看懂：地图上的房间布局、手绘标注、照片里的物件与文字，都要纳入模组（例如地图要转写成文字版场景布局）。
3. 如果多份材料互相矛盾，以正文主线为准，并在"备注"里说明矛盾点。
4. 输出必须是严格的 JSON，不要有任何多余文字、不要包在代码块里。
5. "summary" 是给**玩家**看的公开简介，用于开团前车卡。绝不能剧透：不许出现神话真相、真凶、怪物本体、结局、NPC 的真实秘密、以及"其实是……"这类揭示。可以写时代、地点、委托缘由、氛围基调、篇幅长短、玩法侧重（调查/潜行/正面冲突的比例）、可能的风险感。写成 100~180 字的一段连贯中文，不要分点、不要用 markdown。
6. "suggestions" 是 3~6 条车卡建议，每条写「职业：能派上用场的理由」，同样不能剧透（不要写"需要能抵抗精神污染"之类暗示真相的话）。

JSON 结构：
{
  "title": "模组名",
  "era": "时代背景",
  "location": "主要地点",
  "summary": "给玩家看的公开简介，绝不剧透",
  "suggestions": ["职业：理由"],
  "hook": "开场钩子，一句话",
  "truth": "神话真相，两到三句",
  "npcs": [{"name":"名字","role":"身份","secret":"秘密"}],
  "clues": ["可发现的线索"],
  "scenes": ["场景1","场景2"],
  "threat": "主要威胁或怪物",
  "opening": "开场白，150~250字，直接进入具体场景，不要问玩家想玩什么",
  "notes": "整理说明：素材矛盾点、图片解读、缺失信息"
}`;

  const imageLine = imageCount
    ? `共 ${imageCount} 张图片随附（请结合图像理解：地图布局、手绘标注、照片里的物件与文字都要纳入）`
    : '（本文件夹没有图片素材，只根据文字材料整理）';

  const user = `模组文件夹：${folderName}
${imageLine}

以下是材料正文：

${materialsText}`;

  return { sys, user };
}

/**
 * 调 AI 理解素材。
 * @param {{baseUrl, apiKey, model, temperature}} cfg
 * @param {{folderName, materialsText, images}} payload
 * @returns {ok, module?, raw?, error?, visionUsed?}
 */
async function understandMaterials(cfg, payload) {
  const { folderName, materialsText, images = [] } = payload;

  if (!cfg?.model) return { ok: false, error: '未配置模型，无法用 AI 理解素材' };
  if (!cfg.apiKey && !isLocalEndpoint(cfg.baseUrl)) {
    return { ok: false, error: '未配置 API Key，无法用 AI 理解素材' };
  }

  const { sys, user } = buildUnderstandPrompt({
    folderName,
    materialsText,
    imageCount: images.length
  });

  // 有图片就按 OpenAI 视觉格式发；content 变成数组
  const userContent = images.length
    ? [
        { type: 'text', text: user },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.base64}` }
        }))
      ]
    : user;

  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userContent }
    ],
    temperature: 0.3,
    max_tokens: UNDERSTAND_MAX_TOKENS,
    stream: false
  });

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch (_) { /* ignore */ }
  }, UNDERSTAND_TIMEOUT_MS);

  try {
    const res = await fetch(buildEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 400); } catch (_) { /* ignore */ }
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}${detail ? '\n' + detail : ''}` };
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason;
    const completionTokens = data?.usage?.completion_tokens;

    if (!text.trim()) return { ok: false, error: 'AI 没有返回内容', truncated: finishReason === 'length' };

    const parsed = extractJson(text);
    if (!parsed) {
      // 区分「被截断」和「真的乱答」：前者是 token 预算问题，重试/换模型可解
      const truncated = finishReason === 'length';
      if (truncated) {
        return {
          ok: false,
          truncated: true,
          error:
            `AI 输出被截断（已达上限 ${UNDERSTAND_MAX_TOKENS} tokens，模型返回 finish_reason=length）。` +
            '素材太长，整理出的 JSON 没写完。可以改用「不经过 AI，直接存为模组」，或换一个输出上限更高的模型。',
          raw: text
        };
      }
      // 没被截断但解析失败：再试一次「修复截断的 JSON」
      const repaired = repairTruncatedJson(text);
      if (repaired) {
        return { ok: true, module: repaired, raw: text, visionUsed: images.length > 0, repaired: true };
      }
      return {
        ok: false,
        error: `AI 返回的不是合法 JSON（finish_reason=${finishReason || '未知'}${
          completionTokens ? `，用了 ${completionTokens} tokens` : ''
        }）`,
        raw: text
      };
    }

    return { ok: true, module: parsed, raw: text, visionUsed: images.length > 0 };
  } catch (e) {
    if (e?.name === 'AbortError') {
      return { ok: false, error: `AI 理解超时（${Math.round(UNDERSTAND_TIMEOUT_MS / 1000)} 秒）` };
    }
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型输出里抠出 JSON。
 * 模型常会包 ```json 代码块，或在前后加说明文字，这里尽量兜住。
 */
function extractJson(text) {
  const s = String(text || '').trim();

  // 1) 直接解析
  try { return JSON.parse(s); } catch (_) { /* 继续尝试 */ }

  // 2) 去掉 ```json ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* 继续 */ }
  }

  // 3) 截取第一个 { 到最后一个 }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* 继续 */ }
  }

  // 4) 代码块没闭合（被截断）时，取 ``` 之后的全部内容再修
  if (/```/.test(s)) {
    const after = s.slice(s.indexOf('```') + 3).replace(/^\s*json\s*/i, '');
    const repaired = repairTruncatedJson(after);
    if (repaired) return repaired;
  }

  // 5) 最后尝试修复半截 JSON
  return repairTruncatedJson(s);
}

/**
 * 尽力修复「被截断」的 JSON。
 *
 * 典型场景：模型输出到一半被 max_tokens 切断，结尾停在字符串中间或数组中间。
 *
 * 策略：先记下所有「逗号位置」作为候选断点（逗号前后一定是完整的值边界），
 * 从最靠后的断点往前试，逐个补全括号直到能解析成功。
 * 这样即使截在字符串中间，也能回退到上一个完整字段。
 *
 * @returns {object|null} 修复成功返回对象，否则 null
 */
function repairTruncatedJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;

  // 先扫一遍：找到所有「安全断点」= 逗号位置 + 最后一个闭合括号位置
  const stack = [];
  let inString = false;
  let escaped = false;
  const safeCuts = [];   // {pos, stackDepth} pos 指向逗号，切到这里时栈深度为 stackDepth

  for (let i = start; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) {
        // 完整闭合
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { /* 继续找断点 */ }
        return null;
      }
      continue;
    }
    // 逗号：此刻栈里是当前容器的开括号，可作为断点
    if (c === ',') safeCuts.push({ pos: i, stack: stack.slice() });
  }

  // 先试最优解：只去掉尾部悬空的逗号/冒号，然后补全括号。
  // 截断处刚好是完整值时这样能保住最多内容。
  {
    let head = s.slice(start).replace(/[,:\s]+$/, '');
    for (let j = stack.length - 1; j >= 0; j--) {
      head += stack[j] === '{' ? '}' : ']';
    }
    try {
      const obj = JSON.parse(head);
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* 继续 */ }
  }

  // 再试：尾部可能是半个键名（`"key":` 或 `"key"`），整段删掉后再补括号
  {
    let head = s.slice(start).replace(/[,:\s]+$/, '');
    head = head.replace(/,\s*"[^"]*"\s*:\s*$/, '');
    head = head.replace(/,\s*"[^"]*"\s*$/, '');
    head = head.replace(/"\s*:\s*$/, '');
    head = head.replace(/,\s*$/, '');
    for (let j = stack.length - 1; j >= 0; j--) {
      head += stack[j] === '{' ? '}' : ']';
    }
    try {
      const obj = JSON.parse(head);
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* 退化到逐级回退 */ }
  }

  // 再从最靠后的逗号断点往前试
  for (let k = safeCuts.length - 1; k >= 0; k--) {
    const cut = safeCuts[k];
    let head = s.slice(start, cut.pos);          // 不含这个逗号

    // 补全所有未闭合的括号
    for (let j = cut.stack.length - 1; j >= 0; j--) {
      head += cut.stack[j] === '{' ? '}' : ']';
    }

    try {
      const obj = JSON.parse(head);
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* 试更靠前的断点 */ }
  }

  // 没有任何逗号可退：尝试「只保留第一个完整键值」
  const m = s.slice(start).match(/^\{\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*("([^"\\]*(?:\\.[^"\\]*)*)"|[-0-9.]+|true|false|null)/);
  if (m) {
    try {
      const obj = JSON.parse(m[0] + '}');
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* 继续 */ }
  }

  // 最后一招：只有开头、截在字符串中间（如 `{"title":"海面之梦`）时，
  // 直接把尾部引号与括号补齐再试一次。
  const tail = s.slice(start);
  if (inString) {
    try {
      const obj = JSON.parse(tail + '"' + '}'.repeat(Math.max(1, stack.length)));
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* 放弃 */ }
  }

  return null;
}

/** 把 AI 整理结果转成写进模组的 raw 文本（KP 的剧本底稿） */
function moduleFromUnderstanding(u, { folderName, materialsText }) {
  const lines = [];
  lines.push(`【${u.title || folderName}】`);
  if (u.era) lines.push(`时代：${u.era}`);
  if (u.location) lines.push(`地点：${u.location}`);
  if (u.hook) lines.push(`\n开场钩子：${u.hook}`);
  if (u.truth) lines.push(`\n神话真相：\n${u.truth}`);

  if (Array.isArray(u.npcs) && u.npcs.length) {
    lines.push('\n关键 NPC：');
    for (const n of u.npcs) {
      lines.push(`- ${n.name || '无名'}（${n.role || '身份不明'}）：${n.secret || '无秘密记录'}`);
    }
  }

  if (Array.isArray(u.clues) && u.clues.length) {
    lines.push('\n可发现的线索：');
    u.clues.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }

  if (Array.isArray(u.scenes) && u.scenes.length) {
    lines.push(`\n场景流程：${u.scenes.join(' → ')}`);
  }

  if (u.threat) lines.push(`\n主要威胁：${u.threat}`);
  if (u.notes) lines.push(`\n整理备注：\n${u.notes}`);

  // 附上原始素材，方便 KP 追问细节
  if (materialsText) {
    lines.push('\n\n===== 以下为原始素材（供查阅）=====\n');
    lines.push(materialsText.slice(0, 40000));
  }

  return lines.join('\n');
}

module.exports = {
  understandMaterials,
  buildUnderstandPrompt,
  extractJson,
  repairTruncatedJson,
  moduleFromUnderstanding,
  UNDERSTAND_MAX_TOKENS,
  UNDERSTAND_TIMEOUT_MS
};
