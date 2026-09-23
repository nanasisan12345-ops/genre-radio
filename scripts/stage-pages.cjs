const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const output = execFileSync(process.execPath, [path.join(__dirname, 'build.cjs')], { encoding: 'utf8' }).trim();
const docs = path.join(root, 'docs');
fs.mkdirSync(docs, { recursive: true });
for (const name of fs.readdirSync(output)) fs.copyFileSync(path.join(output, name), path.join(docs, name));
console.log(`Fresh release: ${output}\nPages source: ${docs}`);
