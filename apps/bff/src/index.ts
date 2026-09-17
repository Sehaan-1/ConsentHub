import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface HelloResponse {
  readonly message: string;
  readonly service: string;
}

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const backendOrigin = process.env.BACKEND_URL ?? 'http://backend:8080';

function sendJson<T>(response: ServerResponse, statusCode: number, body: T): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function proxyHello(response: ServerResponse): Promise<void> {
  try {
    const upstream = await fetch(new URL('/api/hello', backendOrigin));
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(body);
  } catch {
    sendJson(response, 502, {
      message: 'The backend service could not be reached.',
      service: 'bff'
    } satisfies HelloResponse);
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://bff.internal');

  if (request.method === 'GET' && requestUrl.pathname === '/api/hello') {
    await proxyHello(response);
    return;
  }

  sendJson(response, 404, { message: 'Not found' });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) {
      sendJson(response, 500, { message: 'Internal server error' });
    } else {
      response.destroy();
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ConsentHub BFF listening on port ${port}`);
});
