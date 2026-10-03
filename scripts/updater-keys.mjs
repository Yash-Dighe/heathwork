#!/usr/bin/env node
/* updater-keys.mjs — create YOUR auto-update signing key. Run this on your own machine.

     node scripts/updater-keys.mjs            # prompts for a password
     node scripts/updater-keys.mjs --force    # replace an existing key (old installs stop trusting updates!)

   - The PRIVATE key is written to ~/.hearthwork/updater.key — outside the repo. Never commit it.
     Put it (and its password) in your GitHub repo's Actions secrets:
       TAURI_SIGNING_PRIVATE_KEY           = contents of ~/.hearthwork/updater.key
       TAURI_SIGNING_PRIVATE_KEY_PASSWORD  = the password you chose
   - The PUBLIC key goes into brand.json "updaterPubkey", and rebrand.mjs bakes it into
     src-tauri/tauri.conf.json, so every installed copy only accepts updates you signed.
   Lose the private key and existing installs can no longer be auto-updated: back it up. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(os.homedir(), '.hearthwork');
const keyPath = path.join(dir, 'updater.key');
const force = process.argv.includes('--force');

if (fs.existsSync(keyPath) && !force) {
  console.log(`A key already exists at ${keyPath}. Re-using its public key (pass --force to replace it).`);
} else {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
  const args = ['signer', 'generate', '-w', keyPath].concat(force ? ['-f'] : []);
  const r = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('tauri signer failed — run `npm ci` first.'); process.exit(r.status || 1); }
}
const pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
const brandPath = path.join(ROOT, 'brand.json');
const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
brand.updaterPubkey = pub;
fs.writeFileSync(brandPath, JSON.stringify(brand, null, 2) + '\n');
console.log('\nbrand.json updaterPubkey set. Applying with rebrand…');
spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'rebrand.mjs')], { stdio: 'inherit' });
console.log(`\nNext: add GitHub Actions secrets TAURI_SIGNING_PRIVATE_KEY (file ${keyPath}) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.`);
