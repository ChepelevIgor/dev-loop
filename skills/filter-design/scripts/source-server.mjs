// Untrusted designer files have their own read-only origin and capability, never the decision API's token.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

export async function serveSources(src) {
  const root = fs.realpathSync(src);
  const token = crypto.randomBytes(24).toString('hex');
  const prefix = `/src/${token}/`;
  let host;
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, {
        'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox allow-scripts allow-same-origin',
      });
      res.end(body);
    };
    if (req.headers.host !== host) return send(403, 'text/plain', 'host');
    if (req.method !== 'GET') return send(405, 'text/plain', 'read only');
    let relative;
    try {
      const u = new URL(req.url, `http://${host}`);
      if (!u.pathname.startsWith(prefix)) return send(403, 'text/plain', 'source link required');
      relative = decodeURIComponent(u.pathname.slice(prefix.length));
      if (relative.includes('\0')) return send(400, 'text/plain', 'invalid path');
    } catch {
      return send(400, 'text/plain', 'invalid path');
    }
    try {
      const candidate = path.resolve(root, relative);
      if (!candidate.startsWith(root + path.sep)) return send(404, 'text/plain', 'not found');
      // Resolve both file and directory symlinks before checking the boundary and reading the file.
      const file = fs.realpathSync(candidate);
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return send(404, 'text/plain', 'not found');
      const body = fs.readFileSync(file);
      const type = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return send(200, type, body);
    } catch {
      // A removed file, broken link or unreadable resource must not terminate the decision session.
      return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  host = `127.0.0.1:${server.address().port}`;
  return { server, baseUrl: `http://${host}${prefix}` };
}
