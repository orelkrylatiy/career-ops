#!/usr/bin/env node
import http from 'node:http';

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Autopilot Browser Smoke</title></head>
<body>
  <main>
    <h1>Test application</h1>
    <form id="application-form">
      <label>Name <input name="name" required></label>
      <button type="submit">Submit application</button>
    </form>
  </main>
  <script>
    document.getElementById('application-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = document.querySelector('input[name="name"]').value;
      const response = await fetch('/api/application', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ application: { name, resume: 'prepared.pdf' } }),
      });
      if (!response.ok) {
        document.body.insertAdjacentHTML('beforeend', '<div role="alert">Application failed</div>');
        return;
      }
      history.pushState({}, '', '/thank-you');
      document.body.innerHTML = '<main><h1>Thank you for applying</h1><p>Application received.</p></main>';
    });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/application') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (!parsed?.application?.name) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'name required' }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, applicationId: 'smoke-1' }));
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/job' || req.url === '/thank-you')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`PORT=${address.port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
