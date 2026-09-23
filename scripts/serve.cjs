const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(__dirname, '..'));
const port = Number(process.env.PORT || 4173);
const allowed = new Set(['index.html', 'style.css', 'renderer.js', 'core.js', 'playlists.js', 'api.js', 'settings.js', 'public-config.js', 'genres.json', 'README.md', '.nojekyll']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let filename;
  try { filename = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html'; }
  catch { res.writeHead(400).end(); return; }
  if (!allowed.has(filename)) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(root, filename), (error, content) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.end(content);
  });
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Close the previous server or set PORT.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Genre Radio: ${url}\nServing ${root}`);
  if (!process.argv.includes('--open')) return;
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .flatMap(base => [path.join(base, 'Microsoft/Edge/Application/msedge.exe'), path.join(base, 'Google/Chrome/Application/chrome.exe')]);
  const browser = candidates.find(file => fs.existsSync(file));
  if (!browser) { console.log('Edge or Chrome was not found in Program Files. Open the displayed URL manually.'); return; }
  const data = path.join(__dirname, '..', 'Data');
  fs.mkdirSync(data, { recursive: true });
  const child = require('node:child_process').spawn(browser, [`--app=${url}`, `--user-data-dir=${path.join(data, 'Browser')}`, `--disk-cache-dir=${path.join(data, 'Cache')}`, '--no-first-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => console.error(`Browser launch failed: ${error.message}`));
  child.unref();
});
