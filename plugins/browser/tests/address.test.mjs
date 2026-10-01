// The address bar: what typed text means (src/address.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, searchUrl, hostOf, originOf, siteName, displayUrl, isPageUrl, REFUSED } from '../src/address.js';

const searchTemplate = 'https://duckduckgo.com/?q=%s';
const go = text => interpret(text, { searchTemplate });
const url = text => { const result = go(text); assert.equal(result?.kind, 'url', `${text} → ${JSON.stringify(result)}`); return result.url; };
const searched = text => { const result = go(text); assert.equal(result?.kind, 'search', `${text} → ${JSON.stringify(result)}`); return result; };

test('addresses go there; a bare site name gets https, local ones http', () => {
  assert.equal(url('https://example.com/a?b#c'), 'https://example.com/a?b#c');
  assert.equal(url('http://example.com'), 'http://example.com/');
  assert.equal(url('HTTPS://Example.COM/Path'), 'https://example.com/Path');
  assert.equal(url('example.com'), 'https://example.com/');
  assert.equal(url('www.example.co.uk/news?x=1'), 'https://www.example.co.uk/news?x=1');
  assert.equal(url('  example.com  '), 'https://example.com/');
  assert.equal(url('localhost'), 'http://localhost/');
  assert.equal(url('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(url('192.168.1.10'), 'http://192.168.1.10/');
  assert.equal(url('192.168.1.10:8080'), 'http://192.168.1.10:8080/');
  assert.equal(url('[::1]:5173'), 'http://[::1]:5173/');
  assert.equal(url('example.com:8443'), 'http://example.com:8443/');
  assert.equal(url('example.com:443'), 'https://example.com/');
  assert.equal(url('xn--bcher-kva.example'), 'https://xn--bcher-kva.example/');
  assert.equal(url('bücher.de'), 'https://xn--bcher-kva.de/', 'a Unicode name reads as punycode');
  assert.equal(url('about:blank'), 'about:blank');
});

test('words search with the chosen engine', () => {
  assert.equal(searched('atmos browser').url, 'https://duckduckgo.com/?q=atmos%20browser');
  assert.equal(searched('news').query, 'news', 'one word without a dot is a search');
  assert.equal(searched('what is 2+2?').url, `https://duckduckgo.com/?q=${encodeURIComponent('what is 2+2?')}`);
  searched('1.5');
  searched('a.b');
  searched('someone@example.com');
  searched('example.com is down');
  assert.equal(searched('? example.com').query, 'example.com', '"?" first always searches');
  assert.equal(interpret('   ', { searchTemplate }), null);
  assert.equal(interpret('?', { searchTemplate }), null);
  assert.equal(interpret('x', { searchTemplate: 'https://www.google.com/search?q=%s' }).url, 'https://www.google.com/search?q=x');
  assert.equal(searchUrl('https://s.example/?q=', 'a&b'), 'https://s.example/?q=a%26b', 'a template without %s gets the words at the end');
});

test('script, files and drives typed in are refused before anything loads', () => {
  for (const text of ['javascript:alert(1)', 'JavaScript:alert(document.cookie)', ' javascript:void 0', 'vbscript:msgbox']) {
    assert.deepEqual(go(text), { kind: 'refused', reason: REFUSED.script }, text);
  }
  for (const text of ['file:///C:/Windows/win.ini', 'FILE:///etc/passwd', 'C:\\Windows\\System32\\calc.exe', 'c:/Users', 'D:', '\\\\server\\share']) {
    assert.deepEqual(go(text), { kind: 'refused', reason: REFUSED.file }, text);
  }
});

test('other schemes pass to Core, which asks or refuses', () => {
  assert.equal(url('mailto:someone@example.com'), 'mailto:someone@example.com');
  assert.equal(url('tel:12345'), 'tel:12345', 'a known scheme, not host:port');
  assert.equal(url('magnet:?xt=urn:btih:abc'), 'magnet:?xt=urn:btih:abc');
  assert.equal(url('steam://run/440'), 'steam://run/440');
  assert.equal(url('atmos-app://local/index.html'), 'atmos-app://local/index.html', 'Core refuses it (web-policy.cjs)');
  assert.equal(url('chrome://settings'), 'chrome://settings');
  assert.equal(url('data:text/html,hi'), 'data:text/html,hi');
});

test('how an address reads', () => {
  assert.equal(hostOf('https://www.example.com:8080/x'), 'www.example.com:8080');
  assert.equal(hostOf('mailto:a@b.c'), '');
  assert.equal(hostOf('nonsense'), '');
  assert.equal(originOf('https://example.com/a/b'), 'https://example.com');
  assert.equal(originOf('file:///x'), '');
  assert.equal(siteName('https://www.example.com/path'), 'example.com');
  assert.equal(siteName('https://xn--pypal-4ve.com/'), 'xn--pypal-4ve.com', 'look-alike names stay punycode');
  assert.equal(displayUrl('about:blank'), '');
  assert.equal(displayUrl('https://example.com/'), 'https://example.com/');
  // A user name or password before the site: not shown, so the name can't pass for the site.
  assert.equal(displayUrl('https://bank.example@evil.example/login'), 'https://evil.example/login');
  assert.equal(displayUrl('http://user:secret@site.example:8080/a?b#c'), 'http://site.example:8080/a?b#c');
  assert.equal(displayUrl('https://:pw@site.example/'), 'https://site.example/');
  assert.equal(displayUrl('mailto:a@b.c'), 'mailto:a@b.c', 'not a web address: as it is');
  assert.ok(isPageUrl('http://x.y/') && isPageUrl('https://x.y/'));
  assert.ok(!isPageUrl('about:blank') && !isPageUrl('') && !isPageUrl('mailto:x'));
});
