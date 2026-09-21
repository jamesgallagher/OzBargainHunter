/**
 * A loopback ntfy-shaped HTTP sink for integration tests. It records the real
 * POST path, headers and body while never permitting delivery off-host.
 */

import { createServer } from 'node:http';

/** Start a loopback alert sink. */
export async function startAlertSink() {
  const messages = [];
  const sockets = new Set();
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const topic = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\//, ''));
    messages.push({
      topic,
      title: String(req.headers['x-title'] ?? ''),
      priority: String(req.headers['x-priority'] ?? ''),
      body,
      receivedAt: new Date().toISOString(),
    });
    sequence += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `test-${sequence}` }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    messages,
    reset() {
      messages.length = 0;
    },
    async close() {
      if (!server.listening) return;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
