import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const captured = [];
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type,x-write-key');
  response.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.url === '/v1/events' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const batch = JSON.parse(body);
      if (request.headers['x-write-key'] !== 'ua_example' || !Array.isArray(batch.events)) throw new Error('Invalid example request');
      captured.push(...batch.events);
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: batch.events.length }));
    } catch { response.writeHead(400).end(); }
    return;
  }
  if (request.url === '/captured') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(captured, null, 2)); return; }
  if (request.url === '/snippet.global.js') { response.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(join(root, '../dist/snippet.global.js'))); return; }
  if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(root, 'index.html'))); return; }
  response.writeHead(404).end();
});
server.listen(4317, () => console.log('SDK example: http://localhost:4317'));
