import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * ConsentHub partner sandbox — mock counterparty endpoints (week 0 stand-in
 * for the real FIU/FIP services, see ADR-0002 §7):
 *
 *   POST /mock/fiu/consent-requests  mock FIU intake for consent requests
 *   GET  /mock/fiu/consent-requests  requests received so far
 *   POST /mock/fip/consent-artefacts mock FIP artefact store
 *   GET  /mock/fip/consent-artefacts artefacts stored so far
 *   POST /mock/notifications         notification receiver
 *   GET  /mock/notifications         notifications received so far
 *   GET  /health                     liveness for docker compose
 *
 * All state is in-memory and bounded; a container restart wipes it. This
 * week-0 mock has no authentication — signature-based authentication of
 * artefacts and notifications lands with the real partner flows (issues
 * #74–#76), not here.
 */

const port = Number.parseInt(process.env.PORT ?? '4100', 10);
const maxStoredEntries = 1000;
const maxBodyBytes = 64 * 1024;

interface StoredEntry {
  readonly id: string;
  readonly receivedAt: string;
  readonly body: unknown;
}

interface Acknowledgement {
  readonly id: string;
  readonly status: string;
  readonly receivedAt: string;
}

interface Collection {
  readonly count: number;
  readonly items: readonly StoredEntry[];
}

const fiuConsentRequests: StoredEntry[] = [];
const fipConsentArtefacts: StoredEntry[] = [];
const notifications: StoredEntry[] = [];

function store(list: StoredEntry[], body: unknown): StoredEntry {
  const entry: StoredEntry = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    body
  };
  list.push(entry);
  if (list.length > maxStoredEntries) {
    list.shift();
  }
  return entry;
}

function sendJson<T>(response: ServerResponse, statusCode: number, body: T): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('body-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    request.on('error', reject);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://partner-sandbox.internal');
  const path = requestUrl.pathname;

  if (request.method === 'GET' && path === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'partner-sandbox' });
    return;
  }

  if (request.method === 'POST' && path === '/mock/fiu/consent-requests') {
    const body = await readJsonBody(request);
    const entry = store(fiuConsentRequests, body);
    const ack: Acknowledgement = { id: entry.id, status: 'accepted', receivedAt: entry.receivedAt };
    sendJson(response, 202, ack);
    return;
  }

  if (request.method === 'GET' && path === '/mock/fiu/consent-requests') {
    const collection: Collection = { count: fiuConsentRequests.length, items: fiuConsentRequests };
    sendJson(response, 200, collection);
    return;
  }

  if (request.method === 'POST' && path === '/mock/fip/consent-artefacts') {
    const body = await readJsonBody(request);
    const entry = store(fipConsentArtefacts, body);
    const ack: Acknowledgement = { id: entry.id, status: 'stored', receivedAt: entry.receivedAt };
    sendJson(response, 202, ack);
    return;
  }

  if (request.method === 'GET' && path === '/mock/fip/consent-artefacts') {
    const collection: Collection = { count: fipConsentArtefacts.length, items: fipConsentArtefacts };
    sendJson(response, 200, collection);
    return;
  }

  if (request.method === 'POST' && path === '/mock/notifications') {
    const body = await readJsonBody(request);
    const entry = store(notifications, body);
    const ack: Acknowledgement = { id: entry.id, status: 'delivered', receivedAt: entry.receivedAt };
    sendJson(response, 202, ack);
    return;
  }

  if (request.method === 'GET' && path === '/mock/notifications') {
    const collection: Collection = { count: notifications.length, items: notifications };
    sendJson(response, 200, collection);
    return;
  }

  sendJson(response, 404, { message: 'Not found' });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof Error && error.message === 'invalid-json') {
      sendJson(response, 400, { message: 'Request body must be valid JSON.' });
      return;
    }
    if (error instanceof Error && error.message === 'body-too-large') {
      sendJson(response, 413, { message: 'Request body is too large.' });
      return;
    }
    sendJson(response, 500, { message: 'Internal server error' });
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ConsentHub partner sandbox listening on port ${port}`);
});
