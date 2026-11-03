import http from 'node:http';
import net from 'node:net';

function target(db, userId, pathname) {
  const match = /^\/desktop\/([a-f0-9-]+)\//.exec(pathname);
  if (!match) return null;
  const row = db.prepare(`SELECT computers.id, computer_provisioning.container_name, computer_provisioning.status
    FROM computers JOIN computer_provisioning ON computer_provisioning.computer_id=computers.id
    WHERE computers.id=? AND computers.user_id=?`).get(match[1], userId);
  return row?.status === 'running' && row.container_name ? row.container_name : null;
}

export function proxyDesktop(db, userId, req, res) {
  const host = target(db, userId, new URL(req.url, 'http://local').pathname);
  if (!host) { res.writeHead(404); res.end('Desktop unavailable'); return; }
  const headers = { ...req.headers, host: `${host}:3000` };
  delete headers.cookie;
  delete headers.authorization;
  const upstream = http.request({ host, port: 3000, method: req.method, path: req.url, headers }, response => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders['set-cookie'];
    res.writeHead(response.statusCode, responseHeaders);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Desktop unavailable'); });
  req.pipe(upstream);
}

export function proxyDesktopUpgrade(db, userId, req, socket, head) {
  const host = target(db, userId, new URL(req.url, 'http://local').pathname);
  if (!host) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  const upstream = net.connect(3000, host);
  upstream.once('connect', () => {
    const allowed = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'origin', 'user-agent'];
    const headers = allowed.filter(key => req.headers[key]).map(key => `${key}: ${req.headers[key]}`).join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nhost: ${host}:3000\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}
