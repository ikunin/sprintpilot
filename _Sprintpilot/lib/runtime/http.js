const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

// Bound response bodies so a malicious / misconfigured server cannot OOM the
// process with an unbounded chunked response. 5 MB is generous for any PR
// API response we'd expect.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function postJson(urlStr, body, { headers = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }

    // Single resolve/reject guard — both `req.on('error')` and `res.on('error')`
    // can fire on the size-cap abort path (we call req.destroy(err)). Without
    // this, the observed error message becomes non-deterministic.
    let settled = false;
    const done = (fn, val) => {
      if (!settled) {
        settled = true;
        fn(val);
      }
    };
    const ok = (val) => done(resolve, val);
    const fail = (err) => done(reject, err);

    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    // Pick the transport based on URL scheme so http:// can be used by local
    // integration tests without standing up a TLS cert. Production callers
    // always use https://.
    const transport = url.protocol === 'http:' ? http : https;
    const defaultPort = url.protocol === 'http:' ? 80 : 443;
    const req = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || defaultPort,
        path: `${url.pathname}${url.search || ''}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'sprintpilot',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        // We do NOT follow redirects: the caller's Authorization header
        // could leak to an unintended host, and upstream PR APIs don't
        // return 3xx for normal success paths. Surface redirects explicitly
        // so the caller can fix the base URL.
        if (res.statusCode >= 300 && res.statusCode < 400) {
          const location = res.headers.location || '<no Location header>';
          res.resume(); // drain
          return ok({
            statusCode: res.statusCode,
            body: `redirect not supported; Location: ${location}`,
            json: null,
          });
        }

        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on('data', (c) => {
          if (aborted) return;
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            aborted = true;
            req.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return; // error path handles it
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-json */
          }
          ok({ statusCode: res.statusCode, body: text, json });
        });
        res.on('error', fail);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    });
    req.on('error', fail);
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson, MAX_RESPONSE_BYTES };
