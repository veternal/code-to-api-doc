import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-version.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-to-api-doc-version-test-'));
after(() => {
  const target = path.resolve(temp);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('code-to-api-doc-version-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});
let counter = 0;
function fixture({ front = '1.3.0', body = '1.3.0', release = '1.3.0', date = '2026-11-11', skill, changelog } = {}) {
  const root = path.join(temp, `fixture-${counter++}`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'SKILL.md'), skill ?? `---\nname: sample\nversion: ${front}\n---\n# Sample\n\n## 版本\n\n- 当前版本：${body}\n- 配套标准：V2、V2.3+\n\n## 用途\n历史版本 0.9.0 不应被解析。\n`);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog ?? `# 更新日志\n\n## ${release} — ${date}（MINOR）\n\n新增：规则。\n\n## 1.2.0 — 2026-11-10（MINOR）\n历史条目。\n`);
  return root;
}
function run(root, { executable = script, args = [root], cwd = temp } = {}) {
  return spawnSync(process.execPath, [executable, ...args], { cwd, encoding: 'utf8' });
}
function expectFail(options, label, value) {
  const result = run(fixture(options));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /SUMMARY=FAIL/);
  assert.ok(result.stdout.includes(label), result.stdout);
  if (value !== undefined) assert.ok(result.stdout.includes(value), result.stdout);
}

test('matching versions print all actual values and the validated date', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const label of ['SKILL.frontmatter.version', 'SKILL.body.version', 'CHANGELOG.version']) assert.ok(result.stdout.includes(`[PASS] ${label} = 1.3.0`));
  assert.match(result.stdout, /\[PASS\] CHANGELOG.date = 2026-11-11/);
  assert.match(result.stdout, /SUMMARY=PASS/);
});
test('default root is relative to the script even when cwd contains conflicting files', () => {
  const root = fixture();
  const elsewhere = fixture({ front: '9.9.9' });
  fs.mkdirSync(path.join(root, 'scripts'));
  const copy = path.join(root, 'scripts', 'check-version.mjs');
  fs.copyFileSync(script, copy);
  const result = run(root, { executable: copy, args: [], cwd: elsewhere });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`ROOT=${root}`));
});
test('frontmatter mismatch is reported without hiding the actual values', () => expectFail({ front: '1.2.0' }, 'VERSIONS_EQUAL', '1.2.0 / 1.3.0 / 1.3.0'));
test('body mismatch is reported separately', () => expectFail({ body: '1.4.0' }, 'VERSIONS_EQUAL', '1.3.0 / 1.4.0 / 1.3.0'));
test('CHANGELOG mismatch is reported separately', () => expectFail({ release: '1.2.1' }, 'VERSIONS_EQUAL', '1.3.0 / 1.3.0 / 1.2.1'));
for (const invalid of ['1.3', '1.3.0-beta', '1.3.0.1', 'v1.3.0', '01.3.0', '1.3.0junk']) {
  test(`reject malformed or partial SemVer ${invalid} even when three sources agree`, () => expectFail({ front: invalid, body: invalid, release: invalid }, 'SKILL.frontmatter.version', invalid));
}
for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-11-00', '2026-1-01', '0000-01-01', '2026-11-11suffix']) {
  test(`reject invalid release date ${invalid}`, () => expectFail({ date: invalid }, 'CHANGELOG.date', invalid));
}
test('accept real leap day and reject century non-leap day', () => {
  assert.equal(run(fixture({ date: '2000-02-29' })).status, 0);
  expectFail({ date: '1900-02-29' }, 'CHANGELOG.date', '1900-02-29');
});
test('accept quoted YAML and inline Markdown formatting without confusing standard versions', () => {
  const result = run(fixture({ front: '"1.3.0" # current', body: '**`1.3.0`**' }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('first malformed release is not replaced by a later valid historical entry', () => expectFail({
  changelog: '# 更新日志\n## 1.3.0-beta — 2026-11-11\n## 1.3.0 — 2026-11-10\n'
}, 'CHANGELOG.version', '1.3.0-beta'));
test('first heading with missing version is not skipped', () => expectFail({
  changelog: '# 更新日志\n## — 2026-11-11\n## 1.3.0 — 2026-11-10\n'
}, 'CHANGELOG.first-heading'));
test('blank CHANGELOG fails instead of falling back to SKILL version', () => expectFail({ changelog: '' }, 'CHANGELOG.version', '（缺失）'));
test('missing frontmatter version fails', () => expectFail({ skill: '---\nname: sample\n---\n## 版本\n当前版本：1.3.0\n' }, 'SKILL.frontmatter.version', '（缺失）'));
test('blank version values fail', () => expectFail({ front: '', body: '', release: '' }, 'SKILL.frontmatter.version', '必须是完整数字 SemVer'));
test('missing current-version field is not replaced by another number', () => expectFail({
  skill: '---\nversion: 1.3.0\n---\n## 版本\n配套标准：V2.3\n## 用途\n当前版本：1.3.0\n'
}, 'SKILL.body.version', '（缺失）'));
test('duplicate version fields and duplicate version sections fail as ambiguous', () => {
  expectFail({ skill: '---\nversion: 1.3.0\nversion: 1.3.0\n---\n## 版本\n当前版本：1.3.0\n' }, 'SKILL.frontmatter.version', '实际 2 处');
  expectFail({ skill: '---\nversion: 1.3.0\n---\n## 版本\n当前版本：1.3.0\n## 版本\n当前版本：1.3.0\n' }, 'SKILL.body.version', '实际 2 处');
});
test('fenced examples do not override actual version sections or the first release', () => {
  const result = run(fixture({
    skill: '---\nversion: 1.3.0\n---\n```md\n## 版本\n当前版本：9.9.9\n```\n## 版本\n- **当前版本：** `1.3.0`\n',
    changelog: '# 更新日志\n```md\n## 9.9.9 — 2099-01-01\n```\n## 1.3.0 — 2026-11-11\n'
  }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const name of ['SKILL.md', 'CHANGELOG.md']) {
  test(`missing ${name} returns readable failure`, () => {
    const root = fixture();
    fs.unlinkSync(path.join(root, name));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`[FAIL] ${name}`));
    assert.match(result.stdout, /ENOENT/);
  });
}
test('help succeeds, invalid arguments fail with documented exit semantics', () => {
  const help = run(temp, { args: ['--help'] });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /退出码：0/);
  for (const args of [['--unknown'], [temp, 'extra'], ['']]) {
    const result = run(temp, { args });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /用法错误/);
  }
});
