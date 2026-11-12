import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const scanner = process.env.SCAN_SCRIPT || path.join(here, 'scan-endpoints.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code-to-api-doc-scan-test-'));
after(() => {
  const target = path.resolve(work);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('code-to-api-doc-scan-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});

function scan(name, extra = []) {
  const source = path.join(work, name, 'source');
  const out = path.join(work, name, 'output');
  fs.cpSync(path.join(here, 'fixtures', name), source, { recursive: true });
  const run = spawnSync(process.execPath, [scanner, source, '--out', out, ...extra], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(out, 'endpoints.json'), 'utf8'));
  const md = fs.readFileSync(path.join(out, 'endpoints.md'), 'utf8');
  return { result, run, md };
}

function facts(result) {
  return result.endpoints.map(e => [e.method, e.path, e.handler, e.line]);
}

test('Spring: multiline class/method mappings preserve exact annotation source lines', () => {
  const { result } = scan('spring');
  assert.deepEqual(facts(result), [
    ['GET', '/api/v1/orders/{id}', 'get', 6],
    ['POST', '/api/v1/orders', 'create', 11],
    ['HEAD', '/api/v1/health', 'health', 14]
  ]);
});

test('NestJS: TS controllers, empty routes, multiline decorators, separate class prefixes', () => {
  const { result } = scan('nest');
  assert.deepEqual(facts(result), [
    ['GET', '/cats/:id', 'findOne', 3],
    ['POST', '/cats', 'create', 6],
    ['GET', '/dogs/:id', 'findDog', 12],
    ['GET', '/', 'health', 20]
  ]);
  assert.ok(result.endpoints.every(e => e.framework === 'nestjs'));
});

test('Express: handlers stay inside each call, including middleware and multiple calls on a line', () => {
  const { result } = scan('express');
  assert.deepEqual(facts(result), [
    ['GET', '/users/:id', 'getUser', 1],
    ['POST', '/login', '', 2],
    ['GET', '/members', 'controllers.list', 3],
    ['POST', '/multiline', 'saveUser', 4],
    ['GET', '/named', 'namedHandler', 9],
    ['GET', '/anonymous', '', 10],
    ['GET', '/wrapped', '', 11],
    ['GET', '/left', 'left', 12],
    ['GET', '/right', 'right', 12],
    ['GET', '/no-handler', '', 14],
    ['GET', '/next', '', 15],
    ['GET', '/with-regex', '', 19]
  ]);
});

test('FastAPI/Flask: method arrays and handler source lines retain existing behavior', () => {
  const { result } = scan('python');
  assert.deepEqual(facts(result), [
    ['GET', '/items/{id}', 'get_item', 1],
    ['POST', '/submit', 'submit', 5],
    ['PUT', '/submit', 'submit', 5]
  ]);
});

test('Go: existing direct registration patterns retain candidates', () => {
  assert.deepEqual(facts(scan('go').result), [
    ['GET', '/go/items', '', 2], ['ANY', '/go/health', '', 3]
  ]);
});

test('OpenAPI: existing YAML paths retain methods and source lines', () => {
  assert.deepEqual(facts(scan('spec').result), [
    ['GET', '/spec/items', '', 4], ['POST', '/spec/items', '', 6]
  ]);
});

test('CLI: non-Git sources generate both artifacts with honest baseline', () => {
  const { result, run, md } = scan('nest', ['--quiet']);
  assert.equal(run.stdout, '');
  assert.deepEqual(result.git, { branch: null, commit: null, available: false });
  assert.match(md, /未获取（非 Git 目录或 git 不可用）/);
  assert.match(md, /候选清单/);
  assert.match(md, /\/cats\/:id/);
});

test('CLI: nonexistent sources return usage/read failure without generating output', () => {
  const out = path.join(work, 'missing-output');
  const run = spawnSync(process.execPath, [scanner, path.join(work, 'missing'), '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(fs.existsSync(out), false);
});

test('Decorators: named paths reject expressions and ignore property-like text inside literals', () => {
  const { result } = scan('named-paths');
  const observed = result.endpoints.map(e => [e.framework, e.path, e.handler]).sort();
  assert.deepEqual(observed, [
    ['nestjs', "/notes/path: '/fake'", 'literalText'],
    ['nestjs', '/static', 'staticPath'],
    ['spring', "/api/notes/path = '/fake'", 'literalText'],
    ['spring', '/api/static', 'staticPath']
  ].sort());
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.every(w => w.includes('路径不是可识别的单一字符串')));
});
