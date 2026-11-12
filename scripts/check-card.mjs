#!/usr/bin/env node
/**
 * check-card.mjs — 接口速览卡结构机检
 *
 * 用法:
 *   node check-card.mjs <卡片.md> [--json]
 *
 * 检查依据: references/survey-card-standard.md（接口速览卡 V2）
 * 只做结构、字数、禁词、字段上限等可机械判定的项；内容对错、证据真伪无法机检。
 * 退出码: 0 = 无 FAIL；1 = 存在 FAIL；2 = 用法/读取错误
 */

import fs from 'node:fs';
import path from 'node:path';

const BANNED_ZH = ['接口', '字段', '参数', '实体', '枚举', '生产调度'];
const BANNED_EN = ['JWT', 'OpenAPI', 'HTTP', 'MQ', 'ID'];
const BANNED_ALL = [...BANNED_ZH, ...BANNED_EN, '幂等', '事务'];

const results = [];
function ok(id, msg) { results.push({ id, level: 'PASS', msg }); }
function warn(id, msg) { results.push({ id, level: 'WARN', msg }); }
function fail(id, msg) { results.push({ id, level: 'FAIL', msg }); }

function charLen(s) {
  return [...s].length;
}

function stripMd(s) {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let cur = 'HEAD';
  sections.HEAD = [];
  for (const line of lines) {
    const m = line.match(/^##\s*(\d)\s*[\.、．]\s*(.*)$/);
    if (m) {
      cur = m[1];
      sections[cur] = [line];
    } else {
      if (!sections[cur]) sections[cur] = [];
      sections[cur].push(line);
    }
  }
  return sections;
}

function tableRows(lines) {
  // 返回第一张表的行（不含表头与分隔行）
  const idx = lines.findIndex(l => /^\s*\|/.test(l));
  if (idx === -1) return { header: null, rows: [] };
  const header = lines[idx];
  const rows = [];
  for (let i = idx + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) break;
    rows.push(lines[i]);
  }
  return { header, rows };
}

function countTableCols(line) {
  return line.split('|').length - 2;
}

function countPitItems(lines) {
  // 只统计“三个坑”标签后的第一组顶层编号项；示例代码、子步骤和后续 Q&A 不计入。
  let fence = null;
  const prose = lines.map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  });
  const label = line => line.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').replace(/\*\*|__/g, '').trim();
  const start = prose.findIndex(line => /^(?:三个坑|3\s*个坑)\s*[:：]?$/.test(label(line)));
  if (start === -1) return null;

  let count = 0;
  let listIndent = null;
  for (const line of prose.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    const item = line.match(/^([ \t]*)\d+[.)]\s+\S/);
    if (item) {
      if (listIndent === null) {
        if (indent > 3) continue; // 缩进代码块不作为顶层条目。
        listIndent = indent;
      }
      if (indent < listIndent) break;
      if (indent === listIndent) count++;
      continue;
    }
    if (listIndent !== null && indent > listIndent) continue;
    if (/^\s*#{1,6}\s+/.test(line) || /^\s*(?:\*\*.+\*\*|__.+__)\s*$/.test(line)
      || /^(?:常问\s*)?Q&A|^卡尾/.test(label(line)) || count > 0) break;
  }
  return count;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const file = args.find(a => !a.startsWith('--'));

  if (!file) {
    console.error('用法: node check-card.mjs <卡片.md> [--json]');
    process.exit(2);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error('ERROR: 文件不存在 -> ' + abs);
    process.exit(2);
  }

  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    console.error('ERROR: 无法读取卡片 -> ' + abs + ' (' + error.code + ')');
    process.exit(2);
  }
  const S = splitSections(text);

  /* 1. 八个区块 */
  const missing = [];
  for (let i = 1; i <= 8; i++) if (!S[String(i)]) missing.push(i);
  if (missing.length) fail('S1', `缺少区块: ${missing.join(', ')}（必须固定 8 个区块）`);
  else ok('S1', '8 个区块齐全');

  /* 2. 卡头 */
  const head = (S.HEAD || []).join('\n');
  const headChecks = [
    ['接口标识', /接口[:：]\s*\S/],
    ['核对日期', /核对日期[:：]\s*\S/],
    ['维护人', /维护人[:：]/],
    ['数据负责人', /数据负责人[:：]/],
    ['规则负责人', /规则负责人[:：]/],
    ['风险', /风险[:：]/]
  ];
  const headMissing = headChecks.filter(([, re]) => !re.test(head)).map(([n]) => n);
  if (headMissing.length) warn('S2', `卡头缺少项: ${headMissing.join(', ')}（缺失时须写"待指定/未提供"，不能省略）`);
  else ok('S2', '卡头七项齐全');

  /* 3. 三态标注 */
  const tri = ['【事实', '【假设', '【待确认'].filter(t => text.includes(t));
  if (tri.length === 0) warn('S3', '全文未见【事实】/【假设】/【待确认】标注，关键结论缺证据边界');
  else ok('S3', `三态标注已使用: ${tri.join(' / ')}`);

  /* 4. 第 1 块：三行且每行 ≤30 字 */
  const b1 = (S['1'] || []).join('\n');
  const b1Lines = b1.split(/\r?\n/).filter(l => /^\s*[-*+]\s+/.test(l));
  const items = {
    what: b1Lines.find(l => /干什么/.test(l)),
    who: b1Lines.find(l => /谁在用/.test(l)),
    risk: b1Lines.find(l => /什么时候会出问题|什么时候出问题/.test(l))
  };
  const missB1 = Object.entries(items).filter(([, v]) => !v).map(([k]) => k);
  if (missB1.length) fail('B1-1', `第 1 块缺少行: ${missB1.join(', ')}（固定三行：干什么/谁在用/什么时候会出问题）`);
  else {
    const bad = [];
    for (const [k, line] of Object.entries(items)) {
      const content = stripMd(line.replace(/^[-*+]\s+/, '')).replace(/^[^:：]*[:：]\s*/, '');
      const n = charLen(content);
      if (n > 30) bad.push(`${k}=${n}字`);
    }
    if (bad.length) fail('B1-2', `第 1 块超 30 字: ${bad.join(', ')}`);
    else ok('B1-2', '第 1 块三行均 ≤30 字');
  }

  /* 5. 第 2 块：禁词 */
  const b2 = (S['2'] || []).slice(1).join('\n');
  const b2Plain = b2.replace(/`/g, '');
  const hits = [];
  for (const w of BANNED_ALL) {
    if (/^[A-Za-z]+$/.test(w)) {
      const re = new RegExp(`\\b${w}\\b`, 'i');
      if (re.test(b2Plain)) hits.push(w);
    } else if (b2Plain.includes(w)) hits.push(w);
  }
  if (hits.length) fail('B2-1', `第 2 块出现封闭禁词: ${hits.join(', ')}（改用业务表达）`);
  else ok('B2-1', '第 2 块避开封闭禁词表');

  const b2Sent = b2.split(/[。！？\n]/).filter(x => x.trim()).length;
  if (b2Sent < 2) warn('B2-2', `第 2 块仅 ${b2Sent} 句，要求 2–4 句业务解释 + 一句"用户动作 → 系统结果"`);
  else if (!/→|->/.test(b2)) warn('B2-3', '第 2 块未见"用户动作 → 系统结果"动作链');
  else ok('B2-3', '第 2 块含动作链');

  /* 6. 第 3 块：四项 */
  const b3 = (S['3'] || []).join('\n');
  const need3 = ['适用场景', '前置条件', '不适用场景', '误用风险'];
  const miss3 = need3.filter(k => !b3.includes(k));
  if (miss3.length) fail('B3-1', `第 3 块缺少: ${miss3.join(', ')}（四项固定）`);
  else ok('B3-1', '第 3 块四项齐全');

  const preCond = b3.split(/\r?\n/).find(l => l.includes('前置条件')) || '';
  const permKeys = ['身份', '权限', '租户', '数据', '状态'];
  const permHit = permKeys.filter(k => preCond.includes(k));
  if (permHit.length < 3) warn('B3-2', `前置条件仅覆盖 ${permHit.join('/') || '无'}，需同时覆盖身份、功能权限、租户或资源权限、数据状态`);
  else ok('B3-2', '前置条件覆盖身份/权限/数据状态');

  /* 7. 第 4 块：依赖表超时列不留空 */
  const b4Lines = (S['4'] || []);
  const b4 = b4Lines.join('\n');
  if (!/超时|投递时限/.test(b4)) fail('B4-1', '第 4 块未见超时或投递时限列');
  else ok('B4-1', '第 4 块含超时/投递时限');

  const t4 = tableRows(b4Lines);
  if (!t4.rows.length) warn('B4-2', '第 4 块未发现依赖表');
  else {
    const cols = countTableCols(t4.header);
    const bad = [];
    t4.rows.forEach((row, i) => {
      const cells = row.split('|').slice(1, -1).map(c => c.trim());
      cells.forEach((c, j) => {
        if (c === '' || c === '—' || c === '-' || c === '待填' || c === 'N/A') {
          bad.push(`行${i + 1}列${j + 1}`);
        }
      });
    });
    if (cols < 5) warn('B4-3', `依赖表仅 ${cols} 列，要求 5 列：依赖｜同步异步与等待关系｜超时或投递时限｜依赖强度及口径｜失败影响`);
    if (bad.length) fail('B4-4', `依赖表存在空值或占位: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` 等 ${bad.length} 处` : ''}`);
    else ok('B4-4', '依赖表无空值');
  }

  if (!/预算/.test(b4)) warn('B4-5', '第 4 块未见耗时预算（客户端/网关/服务/下游），要求同时交代三层预算');

  /* 8. 第 5 块：同步返回点唯一 */
  const b5 = (S['5'] || []).join('\n');
  const syncCount = (b5.match(/同步返回点/g) || []).length;
  if (syncCount === 0) fail('B5-1', '第 5 块未标"同步返回点"（正常主路径必须有且仅有一个）');
  else if (syncCount > 1) fail('B5-1', `第 5 块出现 ${syncCount} 次"同步返回点"，主路径只允许一个`);
  else ok('B5-1', '同步返回点唯一');

  if (/异步/.test(b5) && !/异步分叉点/.test(b5)) warn('B5-2', '第 5 块提到异步但未标"异步分叉点"位置');
  if (!/回滚|未执行|未知|重试/.test(b5)) warn('B5-3', '第 5 块未见超时未知态或恢复方式说明');

  /* 9. 第 6 块：字段 ≤8 */
  const t6 = tableRows(S['6'] || []);
  if (!t6.rows.length) fail('B6-1', '第 6 块未发现字段表');
  else if (t6.rows.length > 8) fail('B6-1', `第 6 块有 ${t6.rows.length} 个字段，上限为 8（不设下限）`);
  else ok('B6-1', `第 6 块字段数 ${t6.rows.length} ≤ 8`);

  if (!/完整契约/.test((S['6'] || []).join('\n'))) warn('B6-2', '第 6 块未见"完整契约入口"');

  /* 10. 第 7 块 */
  const b7 = (S['7'] || []).join('\n');
  if (!/推动者|触发条件/.test(b7)) warn('B7-1', '第 7 块状态边未见触发条件/推动者');
  else ok('B7-1', '第 7 块含触发条件/推动者');
  if (!/只读|无业务状态变更|写入/.test(b7)) warn('B7-2', '第 7 块未说明写入范围或"无状态变更"');
  else ok('B7-2', '第 7 块含写入范围说明');

  /* 11. 第 8 块：失败地图 + 3 坑 + 3–5 问答 */
  const b8Lines = S['8'] || [];
  const b8 = b8Lines.join('\n');
  const t8 = tableRows(b8Lines);
  if (!t8.rows.length) fail('B8-1', '第 8 块未发现失败地图表');
  else if (t8.rows.length < 3) warn('B8-1', `失败地图仅 ${t8.rows.length} 行，需覆盖鉴权/冲突/输入/结果未知/部分成功/下游延迟`);
  else ok('B8-1', `失败地图 ${t8.rows.length} 行`);

  const pitCount = countPitItems(b8Lines);
  if (pitCount === null) fail('B8-2', '第 8 块缺少独立的“三个坑”或“3 个坑”标签及编号列表');
  else if (pitCount !== 3) fail('B8-2', `"三个坑"有 ${pitCount} 条，要求固定 3 条`);
  else ok('B8-2', `三个坑 ${pitCount} 条`);

  const qaCount = (b8.match(/\*\*\s*Q\s*[:：]/g) || []).length;
  if (qaCount < 3) warn('B8-3', `Q&A 约 ${qaCount} 个，要求 3–5 个`);
  else if (qaCount > 5) warn('B8-3', `Q&A 约 ${qaCount} 个，超过 3–5 个的约束`);
  else ok('B8-3', `Q&A ${qaCount} 个`);

  if (!/卡尾/.test(text)) warn('B8-4', '未见卡尾（契约入口/监控/测试与回滚/待确认）');
  else ok('B8-4', '卡尾存在');

  /* 输出 */
  const fails = results.filter(r => r.level === 'FAIL');
  if (asJson) {
    console.log(JSON.stringify({
      file: abs,
      pass: fails.length === 0,
      summary: {
        pass: results.filter(r => r.level === 'PASS').length,
        warn: results.filter(r => r.level === 'WARN').length,
        fail: fails.length
      },
      results
    }, null, 2));
  } else {
    for (const r of results) {
      const tag = r.level === 'PASS' ? 'PASS' : r.level === 'WARN' ? 'WARN' : 'FAIL';
      console.log(`[${tag}] ${r.id}  ${r.msg}`);
    }
    console.log('');
    console.log(`SUMMARY PASS=${results.filter(r => r.level === 'PASS').length} WARN=${results.filter(r => r.level === 'WARN').length} FAIL=${fails.length}`);
    console.log(fails.length === 0
      ? '结构机检通过。注意：机检不证明内容正确、证据真实或接口可用。'
      : '存在 FAIL，需修正后重跑。不要绕过。');
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

main();
