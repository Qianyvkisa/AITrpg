import { parseDirectives, splitNarration } from './protocol.js';

const MODULE_BUDGET = 12000;
const MEMORY_BUDGET = 3600;

/** 记录经过结算的守密人回复，并把换场与新发现的线索关联到原场景。 */
export function rememberInvestigation(scenario, scene, message, clues, action) {
  const segments = (message.segments || [])
    .map((part) => part.kind === 'say' ? `${part.name}：${part.text}` : part.text);
  const text = (segments.join('\n') || message.clean || '').trim().slice(0, 900);
  const nextScene = scenario.scene !== scene ? scenario.scene : '';
  if (!text && !clues.length && !nextScene) return;
  scenario.investigation ??= [];
  scenario.investigation.push({ scene, nextScene, text, clues, action: String(action || '').slice(0, 220) });
}

/** 旧存档保留了原始叙事与指令，可从中补建调查记录。 */
export function restoreInvestigation(messages, initialScene) {
  const history = { scene: initialScene || '', investigation: [] };
  let action = '';
  for (const message of messages) {
    if (message.role === 'user' && !message.hidden) action = message.text;
    if (message.role !== 'keeper' || message.error || message.streaming) continue;

    const raw = message.text || message.clean || '';
    const directives = message.directives || parseDirectives(raw).directives;
    const previousScene = history.scene;
    const clues = [];
    for (const { type, head } of directives) {
      if (!head) continue;
      if (type === 'SCENE') history.scene = head;
      if (type === 'CLUE' || type === 'FLAG') clues.push(head);
    }
    const segments = message.segments || splitNarration(raw);
    rememberInvestigation(history, previousScene, { ...message, segments }, clues, action);
  }
  return history.investigation;
}

function keywords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z\d]{2,}|\p{Script=Han}{2,}/gu) || [];
  const terms = new Set();
  for (const word of words) {
    if (/^[a-z\d]/.test(word)) terms.add(word);
    else for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms];
}

function relevance(text, terms) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + Number(lower.includes(term)), 0);
}

function fitSections(sections, budget) {
  const selected = [];
  for (const section of sections) {
    if (section.text.length + 2 > budget) continue;
    selected.push(section);
    budget -= section.text.length + 2;
  }
  return selected.sort((a, b) => a.index - b.index).map((section) => section.text).join('\n\n');
}

export function selectInvestigation(scenario, focus) {
  const terms = keywords(focus);
  const entries = (scenario.investigation || []).map((entry, index) => {
    const clueText = (entry.clues || []).join('；');
    const location = [entry.scene, entry.nextScene].filter(Boolean).join(' → ');
    const text = [location ? `【${location}】` : '', clueText ? `线索：${clueText}` : '',
      entry.action ? `调查行动：${entry.action}` : '', entry.text]
      .filter(Boolean).join('\n');
    const score = relevance(text, terms) + relevance(clueText, terms) + Number(entry.scene === scenario.scene) * 2;
    return { index, text, score };
  });
  entries.sort((a, b) => b.score - a.score || b.index - a.index);
  return fitSections(entries, MEMORY_BUDGET);
}

/** 短模组照常整篇使用，长模组保留开头并按当前调查挑选全文中的相关段落。 */
export function selectModuleText(raw, focus) {
  if (!raw || raw.length <= MODULE_BUDGET) return raw || '';

  const paragraphs = raw.split(/\r?\n\s*\r?\n/).flatMap((paragraph) => {
    // 长段落切成相邻片段，并保留少量重叠，避免把跨边界的线索切丢。
    const chunks = [];
    for (let start = 0; start < paragraph.length; start += 850) {
      chunks.push(paragraph.slice(start, start + 1000).trim());
      if (start + 1000 >= paragraph.length) break;
    }
    return chunks;
  }).filter(Boolean);
  const terms = keywords(focus);
  const sections = paragraphs.map((text, index) => ({ index, text, score: relevance(text, terms) }));
  const opening = sections.slice(0, 2);
  const rest = sections.slice(2).sort((a, b) => b.score - a.score || a.index - b.index);
  return fitSections([...opening, ...rest], MODULE_BUDGET);
}

