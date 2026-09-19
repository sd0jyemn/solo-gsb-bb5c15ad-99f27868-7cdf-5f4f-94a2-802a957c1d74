'use strict';

/**
 * 分析基线与对比
 *
 * 每条问题生成一个「稳定指纹」：只由 问题类型 + 场景/选项标识 + 关键目标 构成，
 * 不依赖问题在分析结果数组中的顺序，也不包含文案与路径，
 * 因此同一问题在剧情编辑（改文案、改路径、调整场景顺序）后仍能匹配上。
 *
 * 另为每条问题计算「详情哈希」（文案 + 路径 + 未满足条件解释树）：
 * 指纹相同但详情哈希不同 => 同一问题、详情变化（保留前后路径供对照）。
 *
 * 对比结果状态：
 *   new      新增：当前分析有、基线没有
 *   fixed    已修复：基线有、当前分析没有
 *   changed  详情变化：指纹相同，但文案 / 路径等细节不同
 *   ongoing  仍存在：指纹与详情都一致
 */

const crypto = require('crypto');

/** 递归生成键序稳定的串行化（对象键排序、跳过 undefined 与内部 ast 字段） */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined && k !== 'ast')
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return 'null';
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * 稳定指纹：问题类型 + 场景/选项标识 + 关键目标。
 *   unreachableScene                          => 场景 ID
 *   orphanOption / blockedEntry / neverTrueOption => 场景 ID + 选项序号 + 目标场景 ID
 *   error                                     => 错误码 + 结构化位置(where) + 相关变量名
 * 刻意不包含 message / path / unmet，保证文案或路径变化时身份不变。
 */
function fingerprintOf(issue) {
  if (!issue || typeof issue !== 'object') return '["unknown"]';
  if (issue.type === 'error') {
    return canonical(['error', issue.code || '', issue.where || '', issue.varName || '']);
  }
  return canonical([
    issue.type || 'unknown',
    issue.sceneId || '',
    issue.optionIndex === undefined || issue.optionIndex === null ? null : issue.optionIndex,
    issue.targetSceneId || '',
  ]);
}

/** 详情哈希：同一指纹下用于识别“详情变化”（文案 / 标题 / 路径 / 条件解释） */
function detailHashOf(issue) {
  return sha1(canonical({
    message: issue.message,
    title: issue.title,
    path: issue.path,
    unmet: issue.unmet,
  })).slice(0, 16);
}

/**
 * 为一次分析结果的全部问题生成指纹表。
 * 同一指纹出现多次（极端情况，如同一位置报告多个相同错误）时，
 * 按详情哈希排序后追加序号，保证多次运行结果确定。
 */
function fingerprintIssues(issues) {
  const entries = (issues || []).map((issue) => ({
    fingerprint: fingerprintOf(issue),
    detailHash: detailHashOf(issue),
    issue,
  }));
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.fingerprint);
    if (g) g.push(e);
    else groups.set(e.fingerprint, [e]);
  }
  const out = [];
  for (const [fp, group] of groups) {
    if (group.length === 1) { out.push(group[0]); continue; }
    group.sort((a, b) => (a.detailHash < b.detailHash ? -1 : a.detailHash > b.detailHash ? 1 : 0));
    group.forEach((e, i) => out.push({ ...e, fingerprint: `${fp}~${i}` }));
  }
  return out;
}

/** 由一次分析结果构造可持久化的基线对象（随剧情 JSON 存储） */
function buildBaseline(analysis, story) {
  const issues = fingerprintIssues((analysis && analysis.issues) || []);
  issues.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    storyTitle: (story && story.title) || '',
    counts: (analysis && analysis.counts) || {},
    issues,
  };
}

const STATUS_RANK = { new: 0, changed: 1, ongoing: 2, fixed: 3 };
const TYPE_RANK = { error: 0, unreachableScene: 1, blockedEntry: 2, orphanOption: 3, neverTrueOption: 4 };

/**
 * 对比基线与当前分析的问题列表，返回差异摘要与逐条对比结果。
 * 每条 entry 同时携带 baselineIssue / currentIssue（可能为 null），
 * “详情变化”时前端可据此展示前后路径。
 */
function diffAnalyses(baseline, currentIssues) {
  const baseEntries = baseline && Array.isArray(baseline.issues) ? baseline.issues : [];
  const curEntries = fingerprintIssues(currentIssues || []);

  const baseMap = new Map();
  for (const e of baseEntries) {
    if (e && typeof e.fingerprint === 'string' && !baseMap.has(e.fingerprint)) baseMap.set(e.fingerprint, e);
  }
  const curMap = new Map(curEntries.map((e) => [e.fingerprint, e]));

  const summary = {
    new: 0, fixed: 0, changed: 0, ongoing: 0,
    baselineTotal: baseMap.size, currentTotal: curMap.size,
  };
  const entries = [];

  const mkEntry = (status, base, cur) => {
    const show = (cur && cur.issue) || (base && base.issue) || {};
    return {
      status,
      fingerprint: (cur || base).fingerprint,
      type: show.type || 'error',
      severity: show.severity || 'error',
      sceneId: show.sceneId,
      optionIndex: show.optionIndex,
      targetSceneId: show.targetSceneId,
      message: show.message || '',
      baselineIssue: base ? base.issue || null : null,
      currentIssue: cur ? cur.issue || null : null,
    };
  };

  for (const [fp, cur] of curMap) {
    const base = baseMap.get(fp);
    if (!base) {
      summary.new++;
      entries.push(mkEntry('new', null, cur));
    } else if ((base.detailHash || '') !== cur.detailHash) {
      summary.changed++;
      entries.push(mkEntry('changed', base, cur));
    } else {
      summary.ongoing++;
      entries.push(mkEntry('ongoing', base, cur));
    }
  }
  for (const [fp, base] of baseMap) {
    if (!curMap.has(fp)) {
      summary.fixed++;
      entries.push(mkEntry('fixed', base, null));
    }
  }

  entries.sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    ((TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)) ||
    String(a.sceneId || '').localeCompare(String(b.sceneId || '')) ||
    ((a.optionIndex ?? -1) - (b.optionIndex ?? -1)) ||
    a.fingerprint.localeCompare(b.fingerprint));

  return { comparedAt: new Date().toISOString(), summary, entries };
}

/** 校验并规整化待持久化的基线对象；不合法时返回 undefined（调用方丢弃该字段） */
function sanitizeBaseline(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.issues)) return undefined;
  return {
    version: 1,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : new Date().toISOString(),
    storyTitle: typeof input.storyTitle === 'string' ? input.storyTitle : '',
    counts: input.counts && typeof input.counts === 'object' ? input.counts : {},
    issues: input.issues
      .filter((e) => e && typeof e.fingerprint === 'string')
      .map((e) => ({
        fingerprint: e.fingerprint,
        detailHash: typeof e.detailHash === 'string' ? e.detailHash : '',
        issue: e.issue && typeof e.issue === 'object' ? e.issue : {},
      })),
  };
}

module.exports = {
  canonical,
  fingerprintOf,
  detailHashOf,
  fingerprintIssues,
  buildBaseline,
  diffAnalyses,
  sanitizeBaseline,
};
