'use strict';
/**
 * Loading the package signing key: an Ed25519 private key in an encrypted
 * PEM file kept outside the repo (see scripts/extension-keys.cjs).
 *
 * The passphrase comes from ATMOS_SIGNING_PASSPHRASE when set (for
 * scripted use), otherwise it is asked for without echoing it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const repo = path.resolve(__dirname, '..');

function isInsideRepo(file) {
  const rel = path.relative(repo, path.resolve(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Ask for a passphrase on the terminal without showing it. */
function askHidden(question) {
  if (process.env.ATMOS_SIGNING_PASSPHRASE) return Promise.resolve(process.env.ATMOS_SIGNING_PASSPHRASE);
  if (!process.stdin.isTTY) return Promise.reject(new Error('No terminal to ask for the passphrase; set ATMOS_SIGNING_PASSPHRASE'));
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = text => { if (!muted) rl.output.write(text); };
    rl.question(question, answer => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function loadSigningKey(file) {
  if (!file) throw new Error('No signing key: pass --key <file> or set ATMOS_SIGNING_KEY');
  if (isInsideRepo(file)) throw new Error(`The signing key must be kept outside the repo, not at ${file}`);
  const pem = fs.readFileSync(file, 'utf8');
  const passphrase = await askHidden(`Passphrase for ${path.basename(file)}: `);
  let key;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem', passphrase });
  } catch {
    throw new Error('Could not open the signing key (wrong passphrase?)');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not an Ed25519 key');
  return key;
}

module.exports = { loadSigningKey, askHidden, isInsideRepo, repo };
