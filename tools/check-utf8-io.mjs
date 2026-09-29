#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const INCLUDE_DIRS = ['tools', 'scripts'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.cmd', '.yml', '.yaml']);
const violations = [];

for (const dir of INCLUDE_DIRS) {
  walk(path.join(ROOT, dir));
}
for (const file of ['AGENTS.md', 'package.json', '.editorconfig']) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) checkFile(full);
}

if (violations.length) {
  for (const item of violations) {
    console.error(`${item.file}:${item.line}: ${item.reason}`);
  }
  process.exit(1);
}
console.log('UTF-8 file I/O check passed.');

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.o11y' || entry.name.startsWith('.chrome-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (TEXT_EXT.has(path.extname(entry.name))) checkFile(full);
  }
}

function checkFile(file) {
  if (path.basename(file) === 'check-utf8-io.mjs') return;
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);
  const calls = collectFsCalls(lines);
  for (const call of calls) {
    if (call.kind === 'read' && !/['"]utf8['"]|\bUTF8\b/.test(call.text) && !isBinaryRead(call.text)) {
      violations.push({ file: rel, line: call.line, reason: 'fs.readFileSync for text must pass utf8/UTF8 explicitly' });
    }
    if (call.kind === 'write' && !/['"]utf8['"]|\bUTF8\b/.test(call.text) && !isBinaryWrite(call.text)) {
      violations.push({ file: rel, line: call.line, reason: 'fs.writeFileSync for text must pass utf8/UTF8 explicitly' });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\b(?:Set-Content|Add-Content|Out-File)\b/i.test(line) && !/-Encoding\s+utf8/i.test(line)) {
      violations.push({ file: rel, line: i + 1, reason: 'PowerShell text output must use -Encoding utf8' });
    }
    if (/\bExport-Csv\b/i.test(line) && !/-Encoding\s+utf8/i.test(line)) {
      violations.push({ file: rel, line: i + 1, reason: 'Export-Csv must use -Encoding utf8' });
    }
    if (/\[System\.IO\.File\]::WriteAllText/i.test(line) && !/UTF8Encoding|Encoding\]::UTF8/i.test(line)) {
      violations.push({ file: rel, line: i + 1, reason: 'WriteAllText must pass UTF-8 encoding explicitly' });
    }
  }
}

function collectFsCalls(lines) {
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    const readIndex = lines[i].indexOf('fs.readFileSync(');
    const writeIndex = lines[i].indexOf('fs.writeFileSync(');
    const index = readIndex >= 0 ? readIndex : writeIndex;
    if (index < 0) continue;
    const kind = readIndex >= 0 ? 'read' : 'write';
    let text = lines[i].slice(index);
    let depth = parenDelta(text);
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j += 1;
      text += `\n${lines[j]}`;
      depth += parenDelta(lines[j]);
      if (/\);\s*$/.test(lines[j]) && depth <= 0) break;
    }
    calls.push({ kind, line: i + 1, text });
  }
  return calls;
}

function parenDelta(text) {
  let delta = 0;
  let quote = '';
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') delta += 1;
    else if (ch === ')') delta -= 1;
  }
  return delta;
}

function isBinaryRead(text) {
  return /fs\.readFileSync\([\s\S]*(?:\.pdf|fullName|screenshot|Buffer)/i.test(text);
}

function isBinaryWrite(text) {
  return /Buffer\.from\(|,\s*buffer\s*\)|screenshotPath|\.pdf/i.test(text);
}