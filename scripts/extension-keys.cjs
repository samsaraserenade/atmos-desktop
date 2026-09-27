#!/usr/bin/env node
'use strict';
/**
 * The package signing key.
 *
 *   npm run keys:create -- <file>   make a new key, saved encrypted in <file>
 *                                   (outside the repo; a folder gets
 *                                   atmos-signing-key.pem), and add its public
 *                                   half to core/trusted-keys.json
 *   npm run keys:show -- <file>     print the key's id and whether Atmos trusts it
 *
 * Keep <file> somewhere separate from the repo, and keep a backup copy of
 * it and its passphrase: without them no further official package can be
 * signed until an Atmos update ships a new key.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSigningKey, askHidden, isInsideRepo, repo } = require('./signing-key.cjs');
const { trustedKeyEntry, keyIdFor, loadTrustedKeys } = require('../core/js/core/extension-signing.cjs');

const TRUSTED = path.join(repo, 'core', 'trusted-keys.json');
const fail = message => { console.error(`keys: ${message}`); process.exit(1); };

async function create(file) {
  if (!file) fail('usage: npm run keys:create -- <file outside the repo>');
  file = path.resolve(file);
  // A folder: put the key file in it.
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'atmos-signing-key.pem');
  if (isInsideRepo(file)) fail('keep the key outside the repo (it must never be committed)');
  if (fs.existsSync(file)) fail(`${file} already exists; not overwriting a key`);
  const passphrase = await askHidden('New passphrase (12+ characters): ');
  if (passphrase.length < 12) fail('the passphrase must be at least 12 characters');
  if (!process.env.ATMOS_SIGNING_PASSPHRASE && passphrase !== await askHidden('Same passphrase again: ')) fail('the passphrases differ');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });

  const list = JSON.parse(fs.readFileSync(TRUSTED, 'utf8'));
  const entry = trustedKeyEntry(publicKey, { publisher: 'atmos', official: true });
  list.keys.push(entry);
  fs.writeFileSync(TRUSTED, `${JSON.stringify(list, null, 1)}\n`);

  console.log(`Created signing key ${entry.id}`);
  console.log(`  private key (encrypted): ${file}`);
  console.log(`  public key added to:     ${path.relative(repo, TRUSTED)} (commit this)`);
  console.log('Back up the key file and its passphrase somewhere separate. Without them, no');
  console.log('further official package can be signed until an Atmos update ships a new key.');
}

async function show(file) {
  if (!file) fail('usage: npm run keys:show -- <file>');
  const key = await loadSigningKey(path.resolve(file));
  const id = keyIdFor(crypto.createPublicKey(key));
  const trusted = loadTrustedKeys([TRUSTED]).get(id);
  console.log(`key ${id}: ${trusted ? `trusted${trusted.official ? ' (official)' : ''}${trusted.revoked ? ', revoked' : ''}` : 'not in core/trusted-keys.json'}`);
}

const [command, file] = process.argv.slice(2);
const commands = { create, show };
if (!commands[command]) fail('usage: node scripts/extension-keys.cjs create|show <file>');
commands[command](file).catch(error => fail(error.message));
