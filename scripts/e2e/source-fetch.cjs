// Downloads from sources (core/js/core/source-fetch.cjs) in a real Electron,
// against local servers: an https file and one redirected over https; a
// redirect to http, to file: and too many of them refused; Atmos's own
// schemes never reached (bypassCustomProtocolHandlers); a declared or real
// size past the limit refused; a 2 MB download written with progress; a
// stalled one stopped; an abort.
//
// Not through Atmos: Electron runs this file as its main process.
// Usage: xvfb-run -a node_modules/.bin/electron scripts/e2e/source-fetch.cjs --no-sandbox
const { app, net, protocol, session } = require('electron');
const crypto = require('crypto'), fs = require('fs'), http = require('http'), https = require('https'), os = require('os'), path = require('path');
const { cert, key } = require('../test-tls.cjs');
const { createSourceFetch } = require('../../core/js/core/source-fetch.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'atmos-test', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const checks = [];
const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === null ? '' : `: ${JSON.stringify(detail)}`}`); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const outcome = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));

app.whenReady().then(async () => {
  // The test certificate is self-signed: trusted here, for these servers only.
  session.defaultSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'localhost' ? 0 : -3));
  protocol.handle('atmos-test', () => new Response('from Atmos\'s own scheme'));

  const big = crypto.randomBytes(2 * 1024 * 1024);
  let httpsPort = 0;
  let httpPort = 0;
  const plain = http.createServer((_req, res) => res.end('plain http'));
  const secure = https.createServer({ cert, key }, (req, res) => {
    const to = location => { res.writeHead(302, { location }); res.end(); };
    switch (req.url) {
      case '/index.json': return res.end('{"signed":true}');
      case '/hop': return to(`https://localhost:${httpsPort}/index.json`);
      case '/to-http': return to(`http://localhost:${httpPort}/index.json`);
      case '/to-file': return to('file:///etc/hostname');
      case '/to-scheme': return to('atmos-test://local/index.json');
      case '/loop': return to(`https://localhost:${httpsPort}/loop`);
      case '/declared': res.writeHead(200, { 'content-length': '5000' }); return res.end('x'.repeat(5000));
      case '/setup.exe': res.writeHead(200, { 'content-length': String(big.length) }); return res.end(big);
      case '/stall': res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('a little'); return; // and nothing more
      case '/no-answer': res.writeHead(200); res.write('a little'); return; // held back by Chromium's sniffing: no answer at all
      default: res.writeHead(404); return res.end();
    }
  });
  httpPort = await listen(plain);
  httpsPort = await listen(secure);
  const base = `https://localhost:${httpsPort}`;
  const sources = createSourceFetch({ net, stallMs: 1500 });

  let r = await outcome(sources.fetchBuffer(`${base}/index.json`, 1000));
  check('an https file', r.ok && r.value.toString() === '{"signed":true}', r);
  r = await outcome(sources.fetchBuffer(`${base}/hop`, 1000));
  check('a redirect that stays https is followed', r.ok && r.value.toString() === '{"signed":true}', r);
  r = await outcome(sources.fetchBuffer(`${base}/to-http`, 1000));
  check('a redirect to http is refused', !r.ok && /redirected away from https/.test(r.error), r);
  r = await outcome(sources.fetchBuffer(`${base}/to-file`, 1000));
  check('a redirect to file: is refused', !r.ok, r);
  r = await outcome(sources.fetchBuffer(`${base}/to-scheme`, 1000));
  check('a redirect to a custom scheme is refused', !r.ok, r);
  r = await outcome(sources.fetchBuffer('atmos-test://local/index.json', 1000));
  check('Atmos\'s own schemes are never reached', !r.ok, r);
  const control = await outcome(net.fetch('atmos-test://local/index.json').then(response => response.text()));
  check('…(which a plain net.fetch would reach: the check means something)', control.ok && /own scheme/.test(control.value), control);
  r = await outcome(sources.fetchBuffer(`${base}/loop`, 1000));
  check('endless redirects are refused', !r.ok && /too many redirects/.test(r.error), r);
  r = await outcome(sources.fetchBuffer(`${base}/declared`, 1000));
  check('a declared length past the limit is refused', !r.ok && /larger than expected/.test(r.error), r);
  r = await outcome(sources.fetchBuffer(`${base}/index.json`, 5));
  check('a body past the limit is refused', !r.ok && /larger than expected/.test(r.error), r);
  r = await outcome(sources.fetchBuffer(`${base}/missing`, 1000));
  check('an error status is refused', !r.ok && /HTTP 404/.test(r.error), r);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
  const seen = [];
  r = await outcome(sources.downloadToFile(`${base}/setup.exe`, path.join(dir, 'setup.exe'), { maxBytes: big.length, onProgress: size => seen.push(size) }));
  check('a 2 MB download is written whole', r.ok && fs.readFileSync(path.join(dir, 'setup.exe')).equals(big), r);
  check('…with progress up to its size', seen.length > 0 && seen[seen.length - 1] === big.length, seen.slice(-3));
  r = await outcome(sources.downloadToFile(`${base}/setup.exe`, path.join(dir, 'small.exe'), { maxBytes: big.length - 1 }));
  check('a download past its signed size is refused', !r.ok && /larger than expected/.test(r.error), r);
  r = await outcome(sources.downloadToFile(`${base}/stall`, path.join(dir, 'stall.exe'), { maxBytes: 1000 }));
  check('a download that stops sending is stopped', !r.ok && /stalled/.test(r.error), r);
  r = await outcome(sources.downloadToFile(`${base}/no-answer`, path.join(dir, 'none.exe'), { maxBytes: 1000 }));
  check('a server that doesn\'t answer is given up on', !r.ok && /didn't answer/.test(r.error), r);
  const controller = new AbortController();
  const pending = outcome(sources.downloadToFile(`${base}/stall`, path.join(dir, 'abort.exe'), { maxBytes: 1000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 300);
  r = await pending;
  check('an abort stops a download', !r.ok && /Cancelled/.test(r.error), r);
  r = await outcome(sources.downloadToFile(`${base}/setup.exe`, path.join(dir, 'missing', 'setup.exe'), { maxBytes: big.length }));
  check('a file that can\'t be written ends it with that error', !r.ok && /ENOENT/.test(r.error), r);

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = checks.filter(item => !item.ok);
  console.log(JSON.stringify({ electron: process.versions.electron, passed: checks.length - failed.length, failed: failed.map(item => item.name) }, null, 2));
  app.exit(failed.length ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
