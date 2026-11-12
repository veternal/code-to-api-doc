#!/usr/bin/env node
/**
 * 技能版本一致性检查（无第三方依赖）。
 * 用法：node check-version.mjs [skillRoot]
 * 默认读取本脚本上一级目录，与当前工作目录无关。
 * 退出码：0 = 通过或 --help；1 = 用法、读取、缺失、格式或一致性错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('用法：node check-version.mjs [skillRoot]\n默认目录：本脚本的上一级目录（不使用 cwd）。\n退出码：0 = 全部通过或显示帮助；1 = 用法/读取/缺失/格式/一致性错误。');
  process.exit(0);
}
if (args.length > 1 || (args[0] !== undefined && (!args[0].trim() || args[0].startsWith('-')))) {
  console.error('用法错误：node check-version.mjs [skillRoot]；查看帮助请用 --help。');
  process.exit(1);
}

const root = args.length ? path.resolve(args[0]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
function record(label, value, valid, reason = '') {
  checks.push({ label, value, valid, reason });
}
function read(name) {
  try { return fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) {
    record(name, path.join(root, name), false, `无法读取：${error.code || error.message}`);
    return '';
  }
}
function unquoteYaml(value) {
  const quoted = value.match(/^(['"])(.*?)\1[ \t]*(?:#.*)?$/);
  return quoted ? quoted[2] : value.replace(/[ \t]+#.*$/, '').trim();
}
function unwrap(value) {
  let result = value.trim();
  for (let i = 0; i < 3; i++) {
    const marker = ['**', '__', '`'].find(m => result.startsWith(m) && result.endsWith(m) && result.length >= 2 * m.length);
    if (!marker) break;
    result = result.slice(marker.length, -marker.length).trim();
  }
  return result;
}
function withoutFences(text) {
  let fence = null;
  return text.split(/\r?\n/).map(line => {
    const boundary = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (boundary && !fence) { fence = boundary[1]; return ''; }
    if (boundary && fence && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) { fence = null; return ''; }
    return fence ? '' : line;
  });
}
function versionCheck(label, values, error = '') {
  const value = values.length ? values.join(' | ') : '（缺失）';
  const valid = !error && values.length === 1 && VERSION.test(values[0]);
  record(label, value, valid, error || (values.length !== 1 ? `需要且只允许一处，实际 ${values.length} 处` : valid ? '' : '必须是完整数字 SemVer（无前导零、前缀或后缀）'));
  return valid ? values[0] : null;
}

const skill = read('SKILL.md');
const changelog = read('CHANGELOG.md');
const frontmatter = skill.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
const frontValues = frontmatter ? [...frontmatter[1].matchAll(/^version[ \t]*:[ \t]*(.*)$/gm)].map(m => unquoteYaml(m[1].replace(/\r$/, ''))) : [];
const frontVersion = versionCheck('SKILL.frontmatter.version', frontValues, frontmatter ? '' : '缺少文件开头的 YAML frontmatter');

const bodyLines = withoutFences(frontmatter ? skill.slice(frontmatter[0].length) : skill);
const sections = bodyLines.flatMap((line, index) => /^##[ \t]+版本(?:[ \t]+#+)?[ \t]*$/.test(line) ? [index] : []);
const bodyValues = [];
if (sections.length === 1) {
  for (let i = sections[0] + 1; i < bodyLines.length && !/^#{1,2}[ \t]+/.test(bodyLines[i]); i++) {
    const line = unwrap(bodyLines[i].replace(/^[ \t]*(?:[-*+][ \t]+)?/, ''))
      .replace(/^(?:\*\*|__)(当前版本[ \t]*[：:])(?:\*\*|__)/, '$1')
      .replace(/^(?:\*\*|__)当前版本(?:\*\*|__)[ \t]*([：:])/, '当前版本$1');
    const field = line.match(/^当前版本[ \t]*[：:][ \t]*(.*)$/);
    if (field) bodyValues.push(unwrap(field[1]));
  }
}
const bodyVersion = versionCheck('SKILL.body.version', bodyValues, sections.length === 1 ? '' : `“## 版本”小节需要且只允许一处，实际 ${sections.length} 处`);

// 首个二级标题即最新发布项。不能因其格式错误而跳过它、误用后面的历史版本。
const firstHeading = withoutFences(changelog).find(line => /^##(?:[ \t]+|$)/.test(line));
const heading = firstHeading?.replace(/^##[ \t]*/, '').trim() || '';
const release = heading.match(/^(\S+)[ \t]+—[ \t]+([^ \t（）()]+)(?:[ \t]*[（(][^（）()\r\n]*[）)])?[ \t]*$/);
record('CHANGELOG.first-heading', heading || '（缺失）', Boolean(release), release ? '' : '格式应为：## x.y.z — YYYY-MM-DD（可选发布类型）');
const headingVersion = release?.[1] || heading.match(/^(\S+)/)?.[1];
const changelogVersion = versionCheck('CHANGELOG.version', headingVersion ? [headingVersion] : [], release ? '' : '首个发布标题格式错误');
const date = release?.[2] || heading.split('—').slice(1).join('—').trim() || '';
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
record('CHANGELOG.date', date || '（缺失）', Boolean(release) && validDate(date), validDate(date) ? '' : '日期须为真实公历日期 YYYY-MM-DD');
const equal = frontVersion !== null && bodyVersion !== null && changelogVersion !== null && frontVersion === bodyVersion && bodyVersion === changelogVersion;
record('VERSIONS_EQUAL', [frontVersion, bodyVersion, changelogVersion].map(v => v ?? '无效').join(' / '), equal, equal ? '' : '三处有效版本必须完全相同');

console.log(`ROOT=${root}`);
for (const item of checks) console.log(`[${item.valid ? 'PASS' : 'FAIL'}] ${item.label} = ${item.value}${item.reason ? `；${item.reason}` : ''}`);
const pass = checks.every(item => item.valid);
console.log(`SUMMARY=${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
