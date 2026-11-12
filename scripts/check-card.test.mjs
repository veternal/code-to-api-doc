import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const checker = path.join(skillRoot, 'scripts', 'check-card.mjs');
const template = fs.readFileSync(path.join(skillRoot, 'assets', 'card-template.md'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'code-to-api-card-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

function runText(text, asJson = true) {
  const file = path.join(scratch, `card-${sequence++}.md`);
  fs.writeFileSync(file, text);
  const result = spawnSync(process.execPath, [checker, file, ...(asJson ? ['--json'] : [])], { encoding: 'utf8' });
  assert.ifError(result.error);
  return { ...result, report: asJson ? JSON.parse(result.stdout) : null };
}

function checkResult(report, id, level) {
  const matches = report.results.filter(result => result.id === id);
  assert.equal(matches.length, 1, `${id} must appear exactly once`);
  assert.equal(matches[0].level, level, matches[0].msg);
}

function replaceB7(body) {
  return template.replace(/## 7\.[\s\S]*?(?=## 8\.)/, `## 7. 状态与数据变化\n\n${body}\n\n`);
}

function replacePits(body) {
  return template.replace(/\*\*三个坑\*\*[\s\S]*?(?=\*\*常问 Q&A\*\*)/, body + '\n\n');
}

test('template passes structural checks while retaining content warnings', () => {
  const result = runText(template);
  assert.equal(result.status, 0);
  assert.equal(result.report.pass, true);
  assert.equal(result.report.summary.fail, 0);
  assert.ok(result.report.summary.warn > 0);
  checkResult(result.report, 'B7-1', 'PASS');
  checkResult(result.report, 'B7-2', 'PASS');
  checkResult(result.report, 'B8-2', 'PASS');
});

for (const trigger of [false, true]) {
  for (const write of [false, true]) {
    test(`B7 independently reports trigger=${trigger}, write=${write}`, () => {
      const body = [trigger ? '触发条件：审核通过。' : '状态关系尚未说明。', write ? '本服务写入：订单表。' : '副作用尚未说明。'].join('\n');
      const { status, report } = runText(replaceB7(body));
      assert.equal(status, 0, 'missing B7 metadata remains a warning');
      checkResult(report, 'B7-1', trigger ? 'PASS' : 'WARN');
      checkResult(report, 'B7-2', write ? 'PASS' : 'WARN');
    });
  }
}

for (const count of [0, 1, 2, 3, 4, 5]) {
  test(`pit count ${count} is accepted only when exactly three`, () => {
    const text = replacePits('**三个坑**\n\n' + Array.from({ length: count }, (_, i) => `${i + 1}. 业务误区 ${i + 1}`).join('\n'));
    const { status, report } = runText(text);
    assert.equal(status, count === 3 ? 0 : 1);
    checkResult(report, 'B8-2', count === 3 ? 'PASS' : 'FAIL');
  });
}

for (const heading of ['### 三个坑', '### 3 个坑', '**三个坑：**', '三个坑：']) {
  test(`pit heading ${heading} supports a normal ordered list`, () => {
    const { status, report } = runText(replacePits(`${heading}\n\n1. 误区甲\n2. 误区乙\n3. 误区丙`));
    assert.equal(status, 0);
    checkResult(report, 'B8-2', 'PASS');
  });
}

test('only the pit list counts, excluding failure procedures, Q&A and card-tail numbering', () => {
  let text = template.replace('**三个坑**', '1. 失败排查步骤甲\n2. 失败排查步骤乙\n\n**三个坑**');
  text = text.replace('**常问 Q&A**', '**常问 Q&A**\n\n1. 查询步骤甲\n2. 查询步骤乙');
  text += '\n1. 卡尾操作甲\n2. 卡尾操作乙\n';
  const { status, report } = runText(text);
  assert.equal(status, 0);
  checkResult(report, 'B8-2', 'PASS');
});

test('nested numbered examples and fenced examples do not add pits', () => {
  const pits = '**三个坑**\n\n1. 误区甲\n   1. 子步骤甲\n   2. 子步骤乙\n\n   ```text\n   1. 示例甲\n   2. 示例乙\n   ```\n2. 误区乙\n3. 误区丙';
  const { status, report } = runText(replacePits(pits));
  assert.equal(status, 0);
  checkResult(report, 'B8-2', 'PASS');
});

test('a heading and list entirely inside a fenced example do not count', () => {
  const text = replacePits('```markdown\n**三个坑**\n1. 示例甲\n2. 示例乙\n3. 示例丙\n```');
  const { status, report } = runText(text);
  assert.equal(status, 1);
  checkResult(report, 'B8-2', 'FAIL');
});

test('missing pit label cannot borrow numbering from another list', () => {
  const { status, report } = runText(replacePits('**排查步骤**\n\n1. 甲\n2. 乙\n3. 丙'));
  assert.equal(status, 1);
  checkResult(report, 'B8-2', 'FAIL');
});

test('a following section with a numbered list does not complete two pits', () => {
  const { status, report } = runText(replacePits('### 三个坑\n\n1. 甲\n2. 乙\n\n### 排查步骤\n\n1. 丙'));
  assert.equal(status, 1);
  checkResult(report, 'B8-2', 'FAIL');
});

test('existing structural failure still exits 1 in JSON and text modes', () => {
  const text = template.replace('**← 同步返回点**', '**返回时点**');
  const json = runText(text);
  assert.equal(json.status, 1);
  assert.equal(json.report.pass, false);
  checkResult(json.report, 'B5-1', 'FAIL');
  const plain = runText(text, false);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /\[FAIL\] B5-1/);
});

test('usage and unreadable inputs exit 2 without a stack trace', () => {
  for (const args of [[], ['--json'], [path.join(scratch, 'missing.md')], [scratch, '--json']]) {
    const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /用法|ERROR/);
    assert.doesNotMatch(result.stderr, /at (?:Object\.|main\s*\()/);
  }
});
