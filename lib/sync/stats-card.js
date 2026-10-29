/**
 * Dedicated Typst card for `/stats`: rounded metric cards plus a token table,
 * matching the `/usage` visual language instead of plain Markdown text.
 */

const PALETTES = {
  light: {
    text: '#1c1d21',
    muted: '#667085',
    accent: '#2f6feb',
    card: '#f4f7fd',
    border: '#e6eaf2',
    barBg: '#e8edf6',
    rowAlt: '#fafbfe',
  },
  dark: {
    text: '#e8eaed',
    muted: '#a0a6b2',
    accent: '#79a6ff',
    card: '#1c222b',
    border: '#2c313a',
    barBg: '#2b323d',
    rowAlt: '#181d25',
  },
};

function typstEscape(value) {
  return String(value ?? '').replace(/[\\)#$[\]*_`<>@~]/g, (char) => `\\${char}`);
}

export function formatStatsDuration(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '0s';
  const sec = Math.floor(value / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  if (hour > 0) return `${hour}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatStatsTokens(num) {
  const value = Number(num) || 0;
  if (value <= 0) return '0';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Derive the display metrics from the session stats payload.
 * @param {{stats?:Object, tokenUsage?:Object, modelSelection?:Object, title?:string}} data
 * @returns {Object}
 */
export function deriveStatsMetrics(data = {}) {
  const stats = data.stats || {};
  const totals = data.tokenUsage?.totals || {};
  const cacheRead = Number(totals.cacheReadTokens) || 0;
  const uncached = Number(totals.uncachedInputTokens) || 0;
  const output = Number(totals.outputTokens) || Number(stats.decodeTokens) || 0;
  const cacheWrite = Number(totals.cacheWriteTokens) || 0;
  const totalInput = cacheRead + uncached;
  const cacheRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0;
  const ttftAvg = Number(stats.ttftSteps) > 0 ? Number(stats.ttftMs) / Number(stats.ttftSteps) / 1000 : 0;
  const decodeSpeed = Number(stats.decodeMs) > 0 ? Number(stats.decodeTokens) / (Number(stats.decodeMs) / 1000) : 0;

  return {
    title: data.title || '',
    model: data.modelSelection?.model || '',
    provider: data.modelSelection?.provider || '',
    turns: Number(stats.turns) || 0,
    steps: Number(stats.steps) || 0,
    llmMs: Number(stats.llmMs) || 0,
    toolMs: Number(stats.toolMs) || 0,
    ttftAvg,
    decodeSpeed,
    cacheRead,
    uncached,
    cacheWrite,
    output,
    totalInput,
    cacheRate,
  };
}

/**
 * Markdown fallback (also used when Typst is unavailable).
 * @param {Object} data
 * @returns {string}
 */
export function buildStatsMarkdown(data = {}) {
  const m = deriveStatsMetrics(data);
  return [
    '## 📊 会话统计',
    `> **会话** ${typstEscape(m.title || '-')}`,
    m.model ? `> **模型** \`${m.model}\`${m.provider ? ` (${m.provider})` : ''}` : '',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 交互轮次 | ${m.turns} 轮 |`,
    `| 执行步骤 | ${m.steps} 步 |`,
    `| LLM 耗时 | ${formatStatsDuration(m.llmMs)} |`,
    `| 工具耗时 | ${formatStatsDuration(m.toolMs)} |`,
    `| 首字延迟 | ${m.ttftAvg.toFixed(2)}s |`,
    `| 生成速度 | ${m.decodeSpeed.toFixed(1)} t/s |`,
    `| 缓存命中率 | ${m.cacheRate.toFixed(1)}% |`,
    '',
    '| Token | 数量 |',
    '| --- | --- |',
    `| 总输入 | ${formatStatsTokens(m.totalInput)} |`,
    `| 缓存读取 | ${formatStatsTokens(m.cacheRead)} |`,
    `| 未缓存输入 | ${formatStatsTokens(m.uncached)} |`,
    `| 总输出 | ${formatStatsTokens(m.output)} |`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Build the dedicated Typst body for `/stats`.
 * @param {Object} data
 * @param {{theme?:'light'|'dark'}} [options]
 * @returns {string}
 */
export function buildStatsTypst(data = {}, { theme = 'light' } = {}) {
  const c = PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const m = deriveStatsMetrics(data);

  const card = (title, value, sub) =>
    `block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 11pt, y: 10pt))[
  #text(size: 9pt, fill: rgb("${c.muted}"))[${title}]
  #v(3pt)
  #text(size: 18pt, weight: "bold", fill: rgb("${c.text}"))[${value}]
  #v(2pt)
  #text(size: 8pt, fill: rgb("${c.muted}"))[${sub}]
]`;

  const row1 = [
    card('交互轮次', `${m.turns}`, '轮对话'),
    card('执行步骤', `${m.steps}`, '步工具/模型调用'),
    card('LLM 耗时', formatStatsDuration(m.llmMs), '模型推理累计'),
    card('工具耗时', formatStatsDuration(m.toolMs), '工具执行累计'),
  ].join(',\n  ');
  const row2 = [
    card('首字延迟 TTFT', `${m.ttftAvg.toFixed(2)}s`, '平均每步'),
    card('生成速度', `${m.decodeSpeed.toFixed(1)}`, 'tokens / 秒'),
    card('缓存命中率', `${m.cacheRate.toFixed(1)}%`, `${formatStatsTokens(m.cacheRead)} 命中`),
    card('Token 总量', formatStatsTokens(m.totalInput + m.output), `${formatStatsTokens(m.totalInput)} 输入`),
  ].join(',\n  ');

  const pct = Math.max(0, Math.min(100, m.cacheRate));
  const tokenTable = `#table(
  columns: (1.2fr, 0.9fr, 1.9fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, right, left),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header([*Token 项*], [*数量*], [*说明*]),
  [总输入], [${formatStatsTokens(m.totalInput)}], [缓存读取 + 未缓存],
  [缓存读取], [${formatStatsTokens(m.cacheRead)}], [#box(width: 60pt, height: 5pt, radius: 2.5pt, fill: rgb("${c.barBg}"), clip: true)[#rect(width: ${pct}%, height: 5pt, fill: rgb("${c.accent}"))] 命中 ${pct.toFixed(1)}%],
  [未缓存输入], [${formatStatsTokens(m.uncached)}], [新提示词],
  [缓存写入], [${formatStatsTokens(m.cacheWrite)}], [写入缓存],
  [总输出], [${formatStatsTokens(m.output)}], [模型生成]
)`;

  const modelLine = m.model
    ? `#block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 12pt, y: 9pt))[
  #text(size: 9pt, fill: rgb("${c.muted}"))[当前模型]
  #v(2pt)
  #text(size: 11pt, weight: "bold", fill: rgb("${c.text}"))[${typstEscape(m.model)}${m.provider ? ` · ${typstEscape(m.provider)}` : ''}]
]`
    : '';

  return `#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${row1}
)
#v(9pt)
#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${row2}
)
#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[会话概览]]
#text(size: 9pt, fill: rgb("${c.muted}"))[${typstEscape(m.title || '-')}]
#v(8pt)
${modelLine}
#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[Token 用量]]
${tokenTable}`;
}
