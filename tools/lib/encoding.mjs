import fs from 'node:fs';

export const UTF8 = 'utf8';

export function readTextFile(file) {
  return fs.readFileSync(file, UTF8);
}

export function writeTextFile(file, text) {
  fs.writeFileSync(file, String(text), UTF8);
}

export function readJsonFile(file) {
  return JSON.parse(readTextFile(file));
}

export function writeJsonFile(file, value) {
  writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`);
}