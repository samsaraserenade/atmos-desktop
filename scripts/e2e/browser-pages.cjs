// Web pages for the Atmos Browser end-to-end check (browser.cjs): one plain
// HTTP server and one HTTPS server with the test certificate
// (scripts/test-tls.cjs), which the browser doesn't trust. Hosts under
// .test are mapped to 127.0.0.1 by the check (--host-resolver-rules).
const http = require('http');
const https = require('https');
const { cert, key } = require('../test-tls.cjs');

const esc = value => String(value).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
const doc = (title, body, head = '', icon = '/favicon.png') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
  + `<link rel="icon" href="${icon}">${head}</head><body>${body}</body></html>`;

// A 16×16 red square with a white one inside.
const FAVICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGO8o6b2n4ECwESJ5sFhAAu6gPLNm3g13FVXp64LRg0YDAYwjuYFBgD2wQdvyxzZ/QAAAABJRU5ErkJggg==', 'base64');

// Records every request, so the check can see which cookies reached the server.
function handler(requests, info) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = String(req.headers.host || '').split(':')[0];
    requests.push({ host, path: url.pathname, query: url.search, cookie: req.headers.cookie || '', agent: req.headers['user-agent'] || '', secure: info.secure });
    res.setHeader('Cache-Control', 'no-store');
    const html = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (url.pathname) {
      case '/favicon.png':
      case '/favicon.ico':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(FAVICON);
        return;
      case '/bad-icon.png':
        // Not an image at all, whatever it says: the icon decoder fails on it.
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.concat([FAVICON.subarray(0, 24), Buffer.alloc(4096, 0xa5)]));
        return;
      case '/':
      case '/solid': {
        const color = /^[0-9a-f]{6}$/i.test(url.searchParams.get('color') || '') ? url.searchParams.get('color') : '1d4ed8';
        const title = url.searchParams.get('title') || 'Solid';
        html(doc(title, `<input id="field" style="position:absolute;left:20px;top:20px;width:300px;height:28px;font-size:16px">
          <a id="link" href="/solid?color=059669&title=Linked" style="position:absolute;left:20px;top:70px;color:#fff;font:16px sans-serif">a link</a>
          <div id="keys" style="position:absolute;left:20px;top:110px;color:#fff;font:14px monospace"></div>
          <p style="position:absolute;left:20px;top:150px;color:#fff;font:14px sans-serif">findme one, findme two, findme three</p>
          <script>window.__keys=[];window.__clicks=0;addEventListener('pointerdown',()=>{__clicks++});
          addEventListener('keydown',e=>{__keys.push(e.key);document.getElementById('keys').textContent=__keys.join(' ')});</script>`,
        `<style>html,body{margin:0;height:100%;background:#${color}}</style>`));
        return;
      }
      case '/title-later':
        html(doc('First title', '<p>The title changes.</p><script>setTimeout(()=>{document.title="Second title"},300)</script>'));
        return;
      case '/links':
        html(doc('Links', `<style>body{font:15px sans-serif;background:#f5f5f4;padding:20px}a,button{display:block;margin:8px 0}</style>
          <a id="blank" href="/solid?title=Blank%20target&color=7c3aed" target="_blank">target=_blank</a>
          <button id="open-plain" onclick="window.open('/solid?title=Opened&color=0891b2')">window.open, no features</button>
          <button id="signin" onclick="window.__popup=window.open('/oauth/authorize?state=xyz','signin','width=480,height=560')">Sign in (a pop-up)</button>
          <a id="mailto" href="mailto:someone@example.com?subject=Hi">mailto:</a>
          <a id="magnet" href="magnet:?xt=urn:btih:0123456789abcdef">magnet:</a>
          <a id="calc" href="ms-calculator:">ms-calculator:</a>
          <a id="file" href="file:///etc/passwd">file:</a>
          <a id="app" href="atmos-app://local/index.html">atmos-app:</a>
          <a id="download" href="/download">a download</a>
          <a id="program" href="/download-program">a program</a>
          <img id="image" src="/favicon.png" width="64" height="64" alt="">
          <script>window.__messages=[];addEventListener('message',e=>{if(e.origin===location.origin)__messages.push(e.data)})</script>`));
        return;
      case '/oauth/authorize':
        html(doc('Sign in to Example', `<style>body{font:15px sans-serif;background:#fff;padding:20px}</style>
          <h1>Sign in</h1><p id="opener"></p>
          <script>document.getElementById('opener').textContent='opener: '+(window.opener?'yes':'no');
          const chromeMembers = Object.keys(window.chrome || {}).join(',');
          setTimeout(()=>{ if (window.opener) window.opener.postMessage({ token: 'secret-token', state: new URL(location.href).searchParams.get('state'), chrome: chromeMembers }, location.origin); window.close(); }, 600);</script>`));
        return;
      case '/download':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report ../../etc/passwd.txt"' });
        res.end('The quarterly report.\n'.repeat(2000));
        return;
      case '/download-program':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="setup.exe"' });
        res.end(Buffer.alloc(4096, 0x4d));
        return;
      case '/permissions':
        html(doc('Permissions', `<style>body{font:15px sans-serif;background:#fff;padding:20px}</style>
          <p>Asks for things.</p>
          <script>window.__results={};
          window.askLocation=()=>new Promise(r=>navigator.geolocation.getCurrentPosition(()=>r(__results.location='granted'),e=>r(__results.location='denied:'+e.code),{timeout:60000}));
          window.askCamera=()=>navigator.mediaDevices.getUserMedia({video:true}).then(()=>__results.camera='granted',e=>__results.camera='denied:'+e.name);
          window.askNotifications=()=>Notification.requestPermission().then(v=>__results.notifications=v);
          window.readClipboard=()=>navigator.clipboard.readText().then(()=>__results.clipboard='granted',e=>__results.clipboard='denied:'+e.name);
          window.state=async name=>(await navigator.permissions.query({name})).state;</script>`));
        return;
      case '/fullscreen':
        html(doc('Fullscreen', `<style>html,body{margin:0;height:100%;background:#16a34a}#box{width:100%;height:100%;background:#ea580c}</style>
          <div id="box"></div>`));
        return;
      case '/cookie/set': {
        const value = String(url.searchParams.get('v') || 'x').replace(/[^a-z0-9-]/gi, '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `probe=${value}; Path=/; SameSite=Lax; Max-Age=3600` });
        res.end(doc(`Cookie ${value}`, `<p id="c"></p><script>localStorage.setItem('probe','${value}');document.getElementById('c').textContent=document.cookie</script>`));
        return;
      }
      case '/cookie/read':
        html(doc('Cookie read', '<p id="c"></p><script>window.__cookie=document.cookie;window.__stored=localStorage.getItem("probe");document.getElementById("c").textContent=document.cookie</script>'));
        return;
      case '/ua':
        html(doc('User agent', `<p id="ua">${esc(req.headers['user-agent'] || '')}</p>`));
        return;
      case '/identity': {
        // What the page is told about the browser: the client hints its
        // navigation carried, and (before any other script) window.chrome,
        // FedCM and navigator.userAgentData.
        const hints = Object.fromEntries(Object.entries(req.headers).filter(([name]) => /^sec-ch-ua/.test(name)));
        html(doc('Identity', `<p id="hints">${esc(JSON.stringify(hints))}</p>
          <script>window.__identity = { chrome: Object.keys(window.chrome || {}), app: typeof (window.chrome && window.chrome.app),
            fedcm: typeof IdentityCredential, brands: navigator.userAgentData ? navigator.userAgentData.brands : null };</script>`));
        return;
      }
      case '/mixed':
        html(doc('Mixed', `<p>An https page loading script over http.</p>
          <script src="http://${host}:${info.httpPort()}/script.js"></script>
          <script>setTimeout(()=>{window.__mixedDone=true},800)</script>`));
        return;
      case '/script.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.__mixedRan = true;');
        return;
      case '/hostile':
        html(doc('Hostile', `<style>body{font:13px monospace;background:#111;color:#eee;padding:16px}</style>
          <pre id="out"></pre>
          <iframe id="frame-app" src="atmos-app://local/index.html" style="width:10px;height:10px"></iframe>
          <iframe id="frame-ext" src="atmos-ext://first-party-plugin-browser/__atmos/frame.html?ext=plugin%3Abrowser&surface=panel" style="width:10px;height:10px"></iframe>
          <iframe id="frame-file" src="file:///etc/passwd" style="width:10px;height:10px"></iframe>
          <script>
          window.__hostile = {};
          const note = (name, value) => { __hostile[name] = value; document.getElementById('out').textContent = JSON.stringify(__hostile, null, 1); };
          const attempt = (name, url) => fetch(url).then(r => r.text().then(t => note(name, 'read ' + t.length + ' bytes')), e => note(name, 'blocked: ' + e.name));
          attempt('fetchApp', 'atmos-app://local/index.html');
          attempt('fetchExt', 'atmos-ext://first-party-plugin-browser/boot.js');
          attempt('fetchResource', 'atmos-resource://audio-player-media/x');
          attempt('fetchFile', 'file:///etc/passwd');
          const xhr = new XMLHttpRequest();
          try { xhr.open('GET', 'file:///etc/passwd'); xhr.onload = () => note('xhrFile', 'read'); xhr.onerror = () => note('xhrFile', 'blocked'); xhr.send(); } catch (e) { note('xhrFile', 'blocked: ' + e.name); }
          note('globals', ['atmos', 'atmosCore', 'require', 'process', 'module', 'electron', 'ipcRenderer'].filter(name => typeof window[name] !== 'undefined'));
          note('storageBefore', localStorage.length);
          setTimeout(() => {
            for (const id of ['frame-app', 'frame-ext', 'frame-file']) {
              let readable = 'not readable';
              try { readable = 'readable: ' + document.getElementById(id).contentDocument?.URL; } catch { readable = 'not readable'; }
              note(id, readable);
            }
            note('done', true);
          }, 1500);
          </script>`));
        return;
      case '/broken-icon':
        html(doc('Broken icon', '<p>This page\'s icon isn\'t an image.</p>', '', '/bad-icon.png'));
        return;
      // The ad blocker's page (browser.cjs writes the test lists): an ad
      // server's script, a tracker's, a pixel, ad slots the lists hide by
      // class, id and site, one added later, and content that stays.
      case '/ads': {
        const at = name => `http://${name}:${info.httpPort()}`;
        html(doc('Ads', `<style>div{height:20px}</style>
          <script>window.__adblockTestAtStart = typeof window.adblockTest === 'undefined' ? 'unset' : String(window.adblockTest);</script>
          <script>(() => {
            // What the scriptlets left, seen through a frame's own (untouched) toString.
            const frame = document.createElement('iframe');
            document.body.append(frame);
            const nativeToString = frame.contentWindow.Function.prototype.toString;
            window.__scriptletTraces = {
              globals: ['scriptletGlobals', 'safeSelf', 'proxyApplyFn', 'preventXhrFn', 'setConstantFn'].filter(name => name in window),
              toString: nativeToString.call(Function.prototype.toString),
              open: nativeToString.call(XMLHttpRequest.prototype.open),
            };
            frame.remove();
          })();</script>
          <div class="ad-slot" id="slot">an ad slot</div>
          <div class="sponsored" id="sponsored">sponsored</div>
          <div id="banner-ad">a banner</div>
          <div class="content" id="content">the article</div>
          <script src="${at('ads.test')}/ad.js"></script>
          <script src="${at('tracker.test')}/tracker.js"></script>
          <img id="pixel" src="${at('pixel.test')}/p.gif" alt="">
          <script src="/first-party.js"></script>
          <script>setTimeout(() => { const late = document.createElement('div'); late.id = 'late'; late.className = 'ad-slot'; late.textContent = 'a late ad'; document.body.append(late); }, 250);</script>`));
        return;
      }
      // A page that fights blockers in its own world, as YouTube does: it
      // enforces Trusted Types (YouTube's header) and, in its first script,
      // makes every textContent rewrite do nothing. uBlock Origin's
      // scriptlets that rewrite an inline script (browser.cjs lists one for
      // it) run in a world of their own, out of its reach.
      case '/tt':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "require-trusted-types-for 'script'" });
        res.end(doc('Trusted Types', `<p>Trusted Types.</p>
          <script>(() => {
            // (With Trusted Types, a script element has a textContent of its own.)
            for (const proto of [Node.prototype, HTMLScriptElement.prototype]) {
              const own = Object.getOwnPropertyDescriptor(proto, 'textContent');
              if (own) Object.defineProperty(proto, 'textContent', { configurable: true, enumerable: own.enumerable, get() { return own.get.call(this); }, set() {} });
            }
          })();</script>
          <script>window.__rewritten = 'no'; window.__tt = { rewritten: window.__rewritten, pct: window.__pct ?? null };</script>`));
        return;
      case '/ad.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.__adLoaded = true;');
        return;
      case '/tracker.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.__trackerLoaded = true;');
        return;
      case '/first-party.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('window.__firstPartyLoaded = true;');
        return;
      case '/p.gif':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(FAVICON);
        return;
      default:
        html(doc('Not found', '<p>Not found</p>'), 404);
    }
  };
}

async function startPages() {
  const requests = [];
  let httpPort = 0;
  const plain = http.createServer(handler(requests, { secure: false, httpPort: () => httpPort }));
  const secure = https.createServer({ cert, key }, handler(requests, { secure: true, httpPort: () => httpPort }));
  await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
  httpPort = plain.address().port;
  return {
    requests,
    http: host => `http://${host}:${httpPort}`,
    https: host => `https://${host}:${secure.address().port}`,
    close() { plain.close(); secure.close(); },
  };
}

module.exports = { startPages };
