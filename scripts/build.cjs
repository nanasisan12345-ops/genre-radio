const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const files = ['index.html', 'style.css', 'renderer.js', 'core.js', 'api.js', 'settings.js', 'public-config.js', 'genres.json', 'README.md', '.nojekyll'];
const output = path.join(root, 'releases', `pages-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(output, file));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${output}\n`);
console.log(output);
