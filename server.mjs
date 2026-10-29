// Small, dependency-free signaling server. Video packets do not pass through it.
import http from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const clients = new Map();
const host = process.env.LISTEN_HOST || '127.0.0.1';
const outputDirectory = process.env.OUTPUT_DIR;
const latestSamples = { sender: null, receiver: null };
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['web/app.js', 'text/javascript']],
  ['/congestion-graph.js', ['web/congestion-graph.js', 'text/javascript']],
  ['/style.css', ['web/style.css', 'text/css']],
]);

function connectEvents(response, role) {
  if (clients.has(role)) {
    response.writeHead(409).end('That browser role is already connected');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  response.write(': connected\n\n');
  clients.set(role, response);
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
  response.on('close', () => {
    clearInterval(heartbeat);
    if (clients.get(role) === response) clients.delete(role);
  });
}

async function readMessage(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100000) {
      throw new Error('Message too large');
    }
  }
  return JSON.parse(body);
}

async function relaySignal(request, response) {
  let message;
  try {
    message = await readMessage(request);
  } catch {
    response.writeHead(400).end('Invalid JSON');
    return;
  }
  const peer = clients.get(message?.to);
  if (!peer) {
    response.writeHead(409).end('Other browser is not ready');
    return;
  }
  peer.write(`data: ${JSON.stringify(message)}\n\n`);
  response.writeHead(204).end();
}

async function recordTelemetry(request, response) {
  let sample;
  try {
    sample = await readMessage(request);
    if (!['sender', 'receiver'].includes(sample.role)) throw new Error('Invalid role');
  } catch {
    response.writeHead(400).end('Invalid telemetry');
    return;
  }
  if (!outputDirectory) {
    response.writeHead(503).end('No runtime log directory configured');
    return;
  }
  const entry = { ...sample, serverTimeMs: Date.now() };
  await appendFile(path.join(outputDirectory, `${sample.role}.jsonl`), `${JSON.stringify(entry)}\n`);
  latestSamples[sample.role] = entry;
  response.writeHead(204).end();
}

async function serveNetworkStats(response) {
  let content = JSON.stringify({ available: false });
  if (process.env.NETWORK_STATS_FILE) {
    try {
      content = await readFile(process.env.NETWORK_STATS_FILE, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  response.writeHead(200, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  }).end(JSON.stringify({ mahimahi: JSON.parse(content), ...latestSamples }));
}

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const role = url.searchParams.get('role');
  if (url.pathname === '/events' && ['sender', 'receiver'].includes(role)) {
    connectEvents(response, role);
  } else if (url.pathname === '/signal' && request.method === 'POST') {
    await relaySignal(request, response);
  } else if (url.pathname === '/telemetry' && request.method === 'POST') {
    await recordTelemetry(request, response);
  } else if (url.pathname === '/stats') {
    await serveNetworkStats(response);
  } else if (assets.has(url.pathname)) {
    const [filename, contentType] = assets.get(url.pathname);
    const content = await readFile(new URL(filename, import.meta.url));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    }).end(content);
  } else {
    response.writeHead(404).end('Not found');
  }
}

http.createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}).listen(8765, host, () => console.log(`WebRTC test: http://${host}:8765`));
