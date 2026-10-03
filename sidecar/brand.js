'use strict';
/* Fork brand + service URLs, generated into shared/brand.json by scripts/rebrand.mjs.
   An empty URL means "this deployment has no such service": the matching feature stays off. */
const fs = require('node:fs');
const path = require('node:path');
const { note: failNote } = require('./failopen.js');

const FILE = path.join(__dirname, '..', 'shared', 'brand.json');
let raw = {};
if (fs.existsSync(FILE)) {
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { failNote('brand.read', e); }   // a broken brand.json leaves every service off, loudly
}
const urls = Object.assign({ website: '', releasesPage: '', updaterEndpoint: '', pricing: '', privacy: '',
  cloud: '', remoteRelay: '', skillCatalog: '' }, raw.urls || {});
module.exports = Object.freeze({ name: raw.name || 'Hearthwork', nameUpper: raw.nameUpper || 'HEARTHWORK',
  identifier: raw.identifier || '', urls: Object.freeze(urls) });
