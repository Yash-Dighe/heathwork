'use strict';
/* Fork brand + service URLs, generated into shared/brand.json by scripts/rebrand.mjs.
   An empty URL means "this deployment has no such service": the matching feature stays off. */
let raw = {};
try { raw = require('../shared/brand.json'); } catch (_) { /* unbranded checkout: everything off */ }
const urls = Object.assign({ website: '', releasesPage: '', updaterEndpoint: '', pricing: '', privacy: '',
  cloud: '', remoteRelay: '', skillCatalog: '' }, raw.urls || {});
module.exports = Object.freeze({ name: raw.name || 'Hearthwork', nameUpper: raw.nameUpper || 'HEARTHWORK',
  identifier: raw.identifier || '', urls: Object.freeze(urls) });
