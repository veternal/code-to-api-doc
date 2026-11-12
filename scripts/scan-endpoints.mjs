#!/usr/bin/env node
/**
 * scan-endpoints.mjs — 从代码地址扫描接口候选与前端页面
 *
 * 用法:
 *   node scan-endpoints.mjs <codeRoot> [--out <dir>] [--max-files N] [--quiet]
 *
 * 产出:
 *   <out>/endpoints.json   机读清单（含文件与行号）
 *   <out>/endpoints.md     人读摘要
 *
 * 说明:
 *   本脚本只产出"候选"。路径前缀拼接、网关改写、废弃标记必须回代码确认。
 *   不联网、无第三方依赖、只读代码目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.cache', '.idea', '.vscode', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.mvn', '.gradle', 'tmp', 'temp',
  'logs', 'log', 'static', 'public', 'assets'
]);

const CODE_EXT = new Set([
  '.java', '.kt', '.scala', '.groovy',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.php', '.cs', '.rb', '.rs'
]);

const API_SPEC_EXT = new Set(['.yaml', '.yml', '.json']);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 14;

function parseArgs(argv) {
  const args = { codeRoot: null, out: null, maxFiles: 20000, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--max-files') args.maxFiles = parseInt(argv[++i], 10) || 20000;
    else if (a === '--quiet') args.quiet = true;
    else rest.push(a);
  }
  args.codeRoot = rest[0] || null;
  return args;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function gitInfo(root) {
  const run = (cmdArgs) => {
    try {
      return execFileSync('git', cmdArgs, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000
      }).trim();
    } catch { return null; }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = run(['rev-parse', 'HEAD']);
  return { branch, commit, available: Boolean(commit) };
}

function walk(root, maxFiles) {
  const files = [];
  let skipped = 0;
  let overLimit = false;

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name.toLowerCase())) { skipped++; continue; }
        if (ent.name.startsWith('.') && ent.name !== '.') { skipped++; continue; }
        if (depth + 1 > MAX_DEPTH) { skipped++; continue; }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;

      const ext = path.extname(ent.name).toLowerCase();
      if (!CODE_EXT.has(ext) && !API_SPEC_EXT.has(ext)) continue;

      // 只看可能承载接口定义的规格文件，避免扫全量 json 配置
      if (API_SPEC_EXT.has(ext)) {
        const lower = ent.name.toLowerCase();
        const looksSpec = /openapi|swagger|api[-_.]?spec|apis\./.test(lower);
        if (!looksSpec) continue;
      }

      if (files.length >= maxFiles) { overLimit = true; break; }
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
        files.push(full);
      } catch { /* ignore */ }
    }
    if (overLimit) break;
  }
  return { files, skipped, overLimit };
}

function firstQuoted(s) {
  const m = s.match(/["'`]([^"'`]*)["'`]/);
  return m ? m[1] : '';
}

function allQuoted(s) {
  const out = [];
  const re = /["'`]([^"'`]*)["'`]/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

const endpoints = [];
const frontendRoutes = [];
const frontendPages = [];
const frontendCalls = [];
const warnings = [];

function pushEndpoint(o) {
  if (!o.path) return;
  const key = o.method + ' ' + o.path + ' ' + o.file + ':' + o.line;
  if (endpoints.some(e => e.key === key)) return;
  o.key = key;
  endpoints.push(o);
}

/* ---------------- 逐文件解析 ---------------- */

// 小型词法辅助器：保留字符偏移与换行，不求值代码，不解析完整语言语法。
function quotedEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i + 1;
  }
  return text.length;
}

function maskSource(text, strings = false) {
  let result = '';
  for (let i = 0; i < text.length;) {
    let end = i;
    if ('\'"`'.includes(text[i])) {
      end = quotedEnd(text, i);
      result += strings ? text.slice(i, end).replace(/[^\n]/g, ' ') : text.slice(i, end);
    } else if (text.slice(i, i + 2) === '//') {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      result += ' '.repeat(end - i);
    } else if (text.slice(i, i + 2) === '/*') {
      end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
      result += text.slice(i, end).replace(/[^\n]/g, ' ');
    } else { result += text[i++]; continue; }
    i = end;
  }
  return result;
}

function readCall(text, open) {
  const stack = [')'];
  const args = [];
  let start = open + 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ('\'"`'.includes(c)) { i = quotedEnd(text, i) - 1; continue; }
    if ('([{'.includes(c)) stack.push({ '(': ')', '[': ']', '{': '}' }[c]);
    else if (')]}'.includes(c)) {
      if (stack.pop() !== c) return null;
      if (!stack.length) {
        if (text.slice(start, i).trim()) args.push(text.slice(start, i).trim());
        return { args, end: i + 1, inner: text.slice(open + 1, i) };
      }
    } else if (c === ',' && stack.length === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

function literalPath(value) {
  const s = value.trim();
  if (!/^['"`]/.test(s) || quotedEnd(s, 0) !== s.length || s.at(-1) !== s[0]) return null;
  // 动态模板与转义串需要语言级求值，宁可不报候选也不把表达式写成事实。
  if (s.includes('\\') || (s[0] === '`' && s.includes('${'))) return null;
  return s.slice(1, -1);
}

function decoratorPath(args, framework) {
  if (!args.trim()) return '';
  const fields = readCall('(' + args + ')', 0)?.args;
  if (!fields?.length) return null;
  const first = fields[0];
  if (/^['"`]/.test(first)) return literalPath(first);
  if (framework === 'spring') {
    const paths = fields.map(field => field.match(/^(?:path|value)\s*=\s*([\s\S]*)$/)).filter(Boolean);
    // 只读取完整属性值；字符串拼接、数组、常量以及相互冲突的别名都须人工确认。
    if (paths.length) return paths.length === 1 ? literalPath(paths[0][1]) : null;
    // method/produces/consumes 等命名属性不等于路径。
    return fields.every(field => /^\w+\s*=/.test(field)) ? '' : null;
  }
  if (fields.length === 1 && first.startsWith('{') && first.endsWith('}')) {
    const properties = readCall('(' + first.slice(1, -1) + ')', 0)?.args;
    if (!properties || properties.some(property => /^\.\.\./.test(property))) return null;
    const paths = properties.map(property => property.match(/^(?:path|"path"|'path')\s*:\s*([\s\S]*)$/)).filter(Boolean);
    return paths.length === 1 ? literalPath(paths[0][1]) : null;
  }
  return null;
}

function parseDecorated(lines, rel, framework) {
  const source = maskSource(lines.join('\n'));
  const cleanLines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of cleanLines) { offsets.push(offset); offset += line.length + 1; }
  let classPrefix = '';
  let isController = framework === 'spring';
  let pending = [];

  for (let i = 0; i < cleanLines.length; i++) {
    let cursor = offsets[i];
    let remainder = cleanLines[i];
    let annotation;
    while ((annotation = remainder.match(/^\s*@([\w.]+)\s*/))) {
      const name = annotation[1];
      const annotationLine = i + 1;
      cursor += annotation[0].length;
      let args = '';
      if (source[cursor] === '(') {
        const call = readCall(source, cursor);
        if (!call) { pending = []; break; }
        args = call.inner;
        cursor = call.end;
        while (i + 1 < offsets.length && offsets[i + 1] <= cursor) i++;
      }
      pending.push({ name, args, line: annotationLine });
      remainder = source.slice(cursor, offsets[i] + cleanLines[i].length);
    }
    if (/\b(?:class|interface)\s+\w+/.test(remainder)) {
      const controller = pending.find(p => p.name === (framework === 'spring' ? 'RequestMapping' : 'Controller'));
      classPrefix = controller ? decoratorPath(controller.args, framework) : '';
      isController = framework === 'spring' || Boolean(controller);
      pending = [];
      continue;
    }
    if (!pending.length || !remainder.trim()) continue;
    const decl = framework === 'nestjs'
      ? remainder.match(/^\s*(?:(?:public|private|protected|static|async|override)\s+)*([\w$]+)\s*(?:<[^>]*>)?\s*\(/)
      : remainder.match(/^\s*(?:[\w<>\[\],.?]+\s+)+([\w$]+)\s*\(/);
    if (!decl) continue;
    for (const p of pending) {
      const verb = p.name.match(framework === 'spring'
        ? /^(Get|Post|Put|Delete|Patch)Mapping$/ : /^(Get|Post|Put|Delete|Patch|Options|Head|All)$/);
      if (!isController || (!verb && !(framework === 'spring' && p.name === 'RequestMapping'))) continue;
      const route = decoratorPath(p.args, framework);
      if (route === null || classPrefix === null) {
        warnings.push(`${rel}:${p.line} 路径不是可识别的单一字符串，需人工确认`);
        continue;
      }
      const methods = verb ? [verb[1].toUpperCase()] : [...p.args.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b/g)].map(m => m[1]);
      for (const method of methods.length ? methods : ['ANY']) pushEndpoint({
        method: method === 'ALL' ? 'ANY' : method,
        path: joinPath(classPrefix, route), framework,
        file: rel, line: p.line, handler: decl[1], classPrefix,
        raw: lines[p.line - 1].trim().slice(0, 160)
      });
    }
    pending = [];
  }
}

function joinPath(prefix, sub) {
  const p = (prefix || '').trim().replace(/^\/+|\/+$/g, '');
  const s = (sub || '').trim().replace(/^\/+/, '');
  return '/' + [p, s].filter(Boolean).join('/');
}

function parseJsLike(lines, rel) {
  parseDecorated(lines, rel, 'nestjs');
  const source = maskSource(lines.join('\n'));
  const codeOnly = maskSource(source, true);
  const registration = /\b(app|router|server|routes?|api|fastify)\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(/gi;
  let match;
  let lineNumber = 1;
  let lastOffset = 0;
  while ((match = registration.exec(codeOnly))) {
    lineNumber += source.slice(lastOffset, match.index).split('\n').length - 1;
    lastOffset = match.index;
    const open = match.index + match[0].lastIndexOf('(');
    const call = readCall(source, open);
    // 函数体里的正则等复杂语法可能超出轻量括号解析能力；保留可确认的路径，handler 留空。
    const tail = source.slice(open + 1).trimStart();
    const firstEnd = /^['"`]/.test(tail) ? quotedEnd(tail, 0) : 0;
    const first = firstEnd && /^\s*[,)]/.test(tail.slice(firstEnd)) ? tail.slice(0, firstEnd) : '';
    const route = literalPath(call?.args[0] || first);
    if (route === null) continue;
    const ln = lineNumber;
    pushEndpoint({
      method: match[2].toUpperCase(), path: route,
      framework: match[1].toLowerCase() === 'fastify' ? 'fastify/hono' : 'express/koa',
      file: rel, line: ln, handler: call ? extractHandler(call.args) : '', classPrefix: '',
      raw: lines[ln - 1].trim().slice(0, 160)
    });
    if (call) registration.lastIndex = call.end;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    // 前端路由
    const route = line.match(/\bpath\s*:\s*["'`]([^"'`]+)["'`]/);
    if (route && /router|routes|index\.(js|ts)/i.test(rel)) {
      frontendRoutes.push({ path: route[1], file: rel, line: ln });
    }
    const routeCall = line.match(/\b(?:routes?|router)\s*\.\s*(?:push|addRoute)\s*\(\s*\{[^}]*path\s*:\s*["'`]([^"'`]+)["'`]/);
    if (routeCall) frontendRoutes.push({ path: routeCall[1], file: rel, line: ln });

    // 前端调用（用于和后端接口对账）
    const call = line.match(/\b(?:axios|http|request|api|service|fetch)\s*(?:\.\s*(get|post|put|delete|patch)|\(\s*\{[^}]*url)\s*[:(]?\s*["'`]([^"'`]+)["'`]/i);
    if (call) {
      frontendCalls.push({
        method: (call[1] || 'GET').toUpperCase(), path: call[2], file: rel, line: ln
      });
    }
    const fetchCall = line.match(/\bfetch\s*\(\s*[`"']([^`"']+)[`"']/);
    if (fetchCall) frontendCalls.push({ method: 'GET', path: fetchCall[1], file: rel, line: ln });
  }
}

function extractHandler(args) {
  if (args.length < 2) return '';
  const last = args.at(-1).trim();
  const named = last.match(/^(?:async\s+)?function\s+([\w$]+)\s*\(/);
  if (named) return named[1];
  if (/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(last)
      && !/^(async|function|undefined|null|true|false)$/.test(last)) return last.replace(/\s/g, '');
  // 内联函数、数组与工厂调用的真实处理函数不可由名称安全推断。
  return '';
}

function parsePython(lines, rel) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const deco = line.match(/@\s*(?:app|router|bp|blueprint|api)\s*\.\s*(get|post|put|delete|patch|route|api_route)\s*\(([^)]*)\)/i);
    if (!deco) continue;
    const routes = allQuoted(deco[2]);
    const routePath = routes[0];
    let methods = [];
    const kind = deco[1].toLowerCase();
    if (kind === 'route' || kind === 'api_route') {
      const m = deco[2].match(/methods\s*=\s*\[([^\]]*)\]/i);
      methods = m ? allQuoted(m[1]).map(s => s.toUpperCase()) : ['GET'];
    } else {
      methods = [kind.toUpperCase()];
    }
    const handlerLine = lines.slice(i + 1, Math.min(i + 4, lines.length)).join(' ');
    const hm = handlerLine.match(/(?:async\s+)?def\s+(\w+)/);
    for (const mth of methods) {
      pushEndpoint({
        method: mth, path: routePath, framework: 'fastapi/flask',
        file: rel, line: ln, handler: hm ? hm[1] : '', classPrefix: '',
        raw: line.trim().slice(0, 160)
      });
    }
  }
}

function parseGo(lines, rel) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const g = line.match(/\b(?:r|router|g|e|app|mux|api|group)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|Handle|HandleFunc)\s*\(\s*"([^"]+)"/);
    if (!g) continue;
    const method = g[1].toUpperCase();
    pushEndpoint({
      method: method.startsWith('HANDLE') ? 'ANY' : method,
      path: g[2], framework: 'go',
      file: rel, line: ln, handler: '', classPrefix: '', raw: line.trim().slice(0, 160)
    });
  }
}

function parseSpec(lines, rel) {
  const head = lines.slice(0, 30).join('\n');
  if (!/openapi\s*:|swagger\s*:|"openapi"\s*:|"swagger"\s*:/.test(head)) return;
  let inPaths = false;
  let currentPath = null;
  let pathIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (/^\s*paths\s*:\s*$/.test(line) || /"paths"\s*:/.test(line)) { inPaths = true; continue; }
    if (!inPaths) continue;
    if (/^\S/.test(line) && !/^\s*$/.test(line) && !/^paths/.test(line) && pathIndent >= 0) break;

    const p = line.match(/^(\s*)["']?(\/[^"':\s]*)["']?\s*:\s*$/);
    if (p) {
      currentPath = p[2];
      pathIndent = p[1].length;
      continue;
    }
    const m = line.match(/^(\s*)(get|post|put|delete|patch|head|options)\s*:\s*$/i);
    if (m && currentPath && m[1].length > pathIndent) {
      pushEndpoint({
        method: m[2].toUpperCase(), path: currentPath, framework: 'openapi',
        file: rel, line: ln, handler: '', classPrefix: '', raw: line.trim()
      });
    }
  }
}

/* ---------------- 主流程 ---------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const codeRoot = args.codeRoot ? path.resolve(args.codeRoot) : process.cwd();

  if (!fs.existsSync(codeRoot)) {
    console.error('ERROR: 代码地址不存在 -> ' + codeRoot);
    process.exit(2);
  }
  const st = fs.statSync(codeRoot);
  if (!st.isDirectory()) {
    console.error('ERROR: 代码地址不是目录 -> ' + codeRoot);
    process.exit(2);
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(process.cwd(), 'api-doc-work');
  fs.mkdirSync(outDir, { recursive: true });

  const { files, skipped, overLimit } = walk(codeRoot, args.maxFiles);
  if (overLimit) warnings.push(`文件数超过 --max-files=${args.maxFiles}，扫描已截断，需按子目录重扫`);

  for (const full of files) {
    const rel = toPosix(path.relative(codeRoot, full));
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (text.indexOf('\u0000') !== -1) continue;
    const lines = text.split(/\r?\n/);
    const ext = path.extname(full).toLowerCase();

    if (ext === '.java' || ext === '.kt' || ext === '.scala' || ext === '.groovy') parseDecorated(lines, rel, 'spring');
    else if (ext === '.py') parsePython(lines, rel);
    else if (ext === '.go') parseGo(lines, rel);
    else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      parseJsLike(lines, rel);
      if (/\.vue$/.test(rel)) { /* noop */ }
    } else if (ext === '.vue' || ext === '.svelte') {
      parseJsLike(lines, rel);
    } else if (API_SPEC_EXT.has(ext)) {
      parseSpec(lines, rel);
    }

    if (/\.(vue|svelte)$/.test(ext) || /(?:^|\/)views?\/.+\.(tsx|jsx)$/.test(rel) || /(?:^|\/)pages?\/.+\.(tsx|jsx|vue)$/.test(rel)) {
      frontendPages.push({ file: rel });
    }
  }

  // 去重
  const uniqRoutes = dedupe(frontendRoutes, r => r.path + '@' + r.file + ':' + r.line);
  const uniqPages = dedupe(frontendPages, p => p.file);
  const uniqCalls = dedupe(frontendCalls, c => c.method + ' ' + c.path + '@' + c.file + ':' + c.line);

  const git = gitInfo(codeRoot);

  const result = {
    codeRoot: toPosix(codeRoot),
    scannedAt: new Date().toISOString(),
    git,
    stats: {
      filesConsidered: files.length,
      dirsSkipped: skipped,
      endpoints: endpoints.length,
      frontendRoutes: uniqRoutes.length,
      frontendPages: uniqPages.length,
      frontendCalls: uniqCalls.length,
      truncated: overLimit
    },
    warnings,
    endpoints: endpoints.map(({ key, ...rest }) => rest),
    frontendRoutes: uniqRoutes,
    frontendPages: uniqPages,
    frontendCalls: uniqCalls
  };

  const jsonPath = path.join(outDir, 'endpoints.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');

  const mdPath = path.join(outDir, 'endpoints.md');
  fs.writeFileSync(mdPath, renderMd(result), 'utf8');

  if (!args.quiet) {
    console.log('SCAN_OK');
    console.log('CODE_ROOT=' + result.codeRoot);
    console.log('GIT=' + (git.available ? `${git.branch}@${String(git.commit).slice(0, 12)}` : '未获取'));
    console.log('ENDPOINTS=' + endpoints.length);
    console.log('FRONTEND_ROUTES=' + uniqRoutes.length);
    console.log('FRONTEND_PAGES=' + uniqPages.length);
    console.log('FRONTEND_CALLS=' + uniqCalls.length);
    console.log('JSON=' + toPosix(jsonPath));
    console.log('MD=' + toPosix(mdPath));
    if (warnings.length) console.log('WARN=' + warnings.join(' | '));
  }
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function renderMd(r) {
  const L = [];
  L.push('# 接口与页面扫描结果（候选清单）');
  L.push('');
  L.push(`> 代码地址：\`${r.codeRoot}\``);
  L.push(`> 扫描时间：${r.scannedAt}`);
  L.push(`> Git 基线：${r.git.available ? `${r.git.branch} @ ${r.git.commit}` : '未获取（非 Git 目录或 git 不可用）'}`);
  L.push('> 本清单为脚本候选结果，路径前缀、网关改写、废弃标记必须回代码确认后才能写入文档。');
  L.push('');
  L.push(`- 参与扫描文件：${r.stats.filesConsidered}`);
  L.push(`- 接口候选：${r.stats.endpoints}`);
  L.push(`- 前端路由：${r.stats.frontendRoutes}｜前端页面文件：${r.stats.frontendPages}｜前端调用点：${r.stats.frontendCalls}`);
  if (r.warnings.length) {
    L.push('');
    L.push('**扫描告警**');
    for (const w of r.warnings) L.push('- ' + w);
  }
  L.push('');

  const byFw = new Map();
  for (const e of r.endpoints) {
    if (!byFw.has(e.framework)) byFw.set(e.framework, []);
    byFw.get(e.framework).push(e);
  }

  L.push('## 一、接口候选');
  L.push('');
  if (!r.endpoints.length) {
    L.push('未发现接口候选。可能是框架不在支持范围内，或接口定义在未扫描目录；需人工按目录结构定位路由文件，并在文档登记"扫描未覆盖"。');
    L.push('');
  }
  for (const [fw, list] of byFw) {
    L.push(`### ${fw}（${list.length}）`);
    L.push('');
    L.push('| # | 方法 | 路径 | 处理函数 | 文件:行 |');
    L.push('| --- | --- | --- | --- | --- |');
    list.forEach((e, i) => {
      L.push(`| ${i + 1} | ${e.method} | \`${e.path}\` | ${e.handler || '—'} | ${e.file}:${e.line} |`);
    });
    L.push('');
  }

  L.push('## 二、前端路由');
  L.push('');
  if (!r.frontendRoutes.length) L.push('未发现路由定义（可能不在 router 目录或使用约定式路由）。');
  else {
    L.push('| # | 路由 | 文件:行 |');
    L.push('| --- | --- | --- |');
    r.frontendRoutes.forEach((x, i) => L.push(`| ${i + 1} | \`${x.path}\` | ${x.file}:${x.line} |`));
  }
  L.push('');

  L.push('## 三、前端页面文件');
  L.push('');
  if (!r.frontendPages.length) L.push('未发现页面文件。');
  else r.frontendPages.forEach(p => L.push('- ' + p.file));
  L.push('');

  L.push('## 四、前端调用点（用于与后端接口对账）');
  L.push('');
  if (!r.frontendCalls.length) L.push('未发现调用点。');
  else {
    L.push('| # | 方法 | 路径 | 文件:行 | 后端是否有对应候选 |');
    L.push('| --- | --- | --- | --- | --- |');
    r.frontendCalls.forEach((c, i) => {
      const hit = r.endpoints.some(e => e.path.endsWith(c.path) || c.path.endsWith(e.path) || e.path.includes(c.path));
      L.push(`| ${i + 1} | ${c.method} | \`${c.path}\` | ${c.file}:${c.line} | ${hit ? '是' : '未匹配'} |`);
    });
  }
  L.push('');
  L.push('## 五、下一步');
  L.push('');
  L.push('1. 对每条候选回代码确认完整路径（类级前缀 + 方法级路径 + 网关前缀）。');
  L.push('2. 读 handler、DTO/VO、异常映射、配置类，补齐入参出参、错误码、超时、幂等、事务边界。');
  L.push('3. 按优先级出速览卡：写操作/状态流转 > 跨系统依赖 > 高频调用 > 只读。');
  L.push('4. 前端调用点"未匹配"的行需要核查是网关前缀差异，还是前端调用的接口未在本目录实现。');
  L.push('');
  return L.join('\n');
}

main();
