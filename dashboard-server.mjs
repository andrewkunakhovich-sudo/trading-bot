import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';

const PORT = 3000;
const types = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

createServer((req, res) => {
  let file = req.url === '/' ? 'dashboard.html' : req.url.slice(1);
  file = file.split('?')[0]; // strip query string
  if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end(readFileSync(file));
}).listen(PORT, () => {
  console.log(`\n📊 Dashboard running at http://localhost:${PORT}`);
  console.log('   Open this in your browser to see live trades.\n');
});
