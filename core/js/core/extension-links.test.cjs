'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { externalLink, linkDecision, describeLink, CLICK_MS } = require('./extension-links.cjs');

test('only http(s) and mailto addresses are links Atmos opens', () => {
  assert.equal(externalLink('https://example.com/a?b#c'), 'https://example.com/a?b#c');
  assert.equal(externalLink('HTTP://Example.com'), 'http://example.com/');
  assert.equal(externalLink('mailto:me@example.com'), 'mailto:me@example.com');
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'atmos-ext://plugin-x/', 'data:text/html,x', 'about:blank', 'not a url', '', null, 42, `https://e.com/${'a'.repeat(9000)}`, 'https:']) {
    assert.equal(externalLink(bad), null, String(bad).slice(0, 30));
  }
});

test('official links open; a community one opens after a click in its frame, and asks otherwise', () => {
  const now = 100_000;
  assert.equal(linkDecision({ tier: 'first-party', now }), 'open');
  assert.equal(linkDecision({ tier: 'system', now }), 'open');
  assert.equal(linkDecision({ tier: 'third-party', focused: true, actedAt: now - 300, now }), 'open', 'clicked just now in its frame');
  assert.equal(linkDecision({ tier: 'third-party', focused: false, actedAt: now - 300, now }), 'ask', 'a click elsewhere in Atmos');
  assert.equal(linkDecision({ tier: 'third-party', focused: true, actedAt: now - CLICK_MS, now }), 'ask', 'not just now');
  assert.equal(linkDecision({ tier: 'third-party', focused: true, actedAt: 0, now }), 'ask', 'a tap, or a timer');
  assert.equal(linkDecision({ tier: 'third-party', now, asking: true }), 'refuse', 'one question at a time');
  assert.equal(linkDecision({ tier: 'third-party', focused: true, actedAt: now - 300, now, blocked: true }), 'refuse', 'blocked until a restart');
  assert.equal(linkDecision({ tier: 'third-party', focused: 'yes', actedAt: now - 300, now }), 'ask', 'only a real true counts');
});

test('the question names where a link goes', () => {
  assert.equal(describeLink('https://login.example.com/x'), 'login.example.com');
  assert.equal(describeLink('mailto:me@example.com'), 'an email to me@example.com');
});
