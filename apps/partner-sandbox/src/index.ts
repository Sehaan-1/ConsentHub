import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3010', 10);

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://partner-sandbox.internal');

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'ok', service: 'partner-sandbox' }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ message: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ConsentHub partner sandbox listening on port ${port}`);
});
