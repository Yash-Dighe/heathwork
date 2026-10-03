/* HEARTHWORK — windows/workshop.js : THE WORKSHOP window — your business ventures as the village's game.
   Reads /api/ventures (sidecar/ventures/*), which recomputes every number from the pipeline's files and the
   KDP reports you imported. This window owns no score: level, XP, coins, milestones and quests are rendered
   exactly as the sidecar derived them. The only thing kept in the browser is which milestones you have already
   SEEN celebrated (localStorage), so a new one gets its fanfare once. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const esc = StationUI.h.esc;
  const STAGES = [['planned', 'PLANNED'], ['drawing', 'DRAWING'], ['review', 'REVIEW'], ['approved', 'APPROVED'],
    ['print-ready', 'PRINT-READY'], ['listed', 'LISTED'], ['live', 'LIVE']];
  const money = n => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const SEEN_KEY = 'hearthwork.workshop.seen.v1';
  const seenStore = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (_) { return {}; } };
  const saveSeen = s => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (_) {} };
  const artUrls = new Map();   // "venture/book" -> object URL (art needs the token header, so it is fetched, not linked)

  async function api(method, url, body, headers) {
    const init = { method, headers: Object.assign({}, headers || {}) };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(url, init);
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  function celebrate(v, root) {
    const seen = seenStore();
    const mine = seen[v.id] || { milestones: [], level: 1, primed: false };
    const earned = v.game.milestones.filter(m => m.earned).map(m => m.id);
    const fresh = mine.primed ? earned.filter(id => !mine.milestones.includes(id)) : [];
    const levelUp = mine.primed && v.game.level > (mine.level || 1);
    seen[v.id] = { milestones: earned, level: v.game.level, primed: true };   // first open just learns the past
    saveSeen(seen);
    if (!fresh.length && !levelUp) return;
    const lines = fresh.map(id => v.game.milestones.find(m => m.id === id)).map(m => '✦ ' + m.label + ' <b>+' + m.xp + ' XP</b>');
    if (levelUp) lines.unshift('LEVEL UP! You are now <b>Lv ' + v.game.level + ' · ' + esc(v.game.title) + '</b>');
    const el = document.createElement('div');
    el.className = 'ws-fanfare';
    el.innerHTML = '<div class="ws-fanfare-in">' + lines.join('<br>') + '</div>';
    root.prepend(el);
    try { if (typeof SFX !== 'undefined') (SFX.milestone || SFX.level || SFX.chime || (() => {})).call(SFX); } catch (_) {}
    try { if (StationUI.notify) StationUI.notify(fresh.length ? 'Milestone: ' + v.game.milestones.find(m => m.id === fresh[0]).label : 'Level up!', 'ok'); } catch (_) {}
    setTimeout(() => el.classList.add('done'), 6000);
  }

  function stageTrack(stage) {
    const i = STAGES.findIndex(s => s[0] === stage);
    return '<div class="ws-track" title="' + esc((STAGES[i] || ['', stage])[1]) + '">'
      + STAGES.map((s, k) => '<span class="ws-pip' + (k < i ? ' done' : k === i ? ' now' : '') + '"></span>').join('')
      + '<span class="ws-stage">' + esc((STAGES[i] || ['', stage])[1]) + '</span></div>';
  }

  function monthsChart(months) {
    if (!months.length) return '';
    const last = months.slice(-12), max = Math.max(1, ...last.map(m => m.usd));
    const W = 300, H = 70, bw = Math.floor(W / last.length) - 4;
    const bars = last.map((m, i) => {
      const h = Math.max(2, Math.round((m.usd / max) * (H - 16)));
      return '<rect x="' + (i * (bw + 4) + 2) + '" y="' + (H - 12 - h) + '" width="' + bw + '" height="' + h + '" rx="2"><title>'
        + esc(m.month) + ': ' + money(m.usd) + '</title></rect>'
        + '<text x="' + (i * (bw + 4) + 2 + bw / 2) + '" y="' + (H - 1) + '" text-anchor="middle">' + esc(m.month.slice(5)) + '</text>';
    }).join('');
    return '<div class="ws-sec"><span class="ws-h">ROYALTIES BY MONTH</span></div><svg class="ws-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="royalties by month">' + bars + '</svg>';
  }

  function bookCard(v, b) {
    const canLive = b.stage === 'listed' || b.stage === 'print-ready';
    return '<div class="ws-book" data-book="' + esc(b.slug) + '">'
      + '<div class="ws-cover" data-art="' + esc(v.id + '/' + b.slug) + '"><span>' + esc(b.title.slice(0, 1)) + '</span></div>'
      + '<div class="ws-book-main">'
      + '<div class="ws-book-title">' + esc(b.title) + '</div>'
      + stageTrack(b.stage)
      + '<div class="ws-book-stats">'
      + '<span>' + b.pagesApproved + '/' + b.pagesTotal + ' pages</span>'
      + (b.pagesAwaiting ? '<span class="ws-warn">' + b.pagesAwaiting + ' to review</span>' : '')
      + (b.stage === 'live' ? '<span>' + (b.unitsSold || 0) + ' sold</span><span>' + money(b.royaltyUSD) + '</span>' : '')
      + (b.published && b.published.asin ? '<span class="dim">' + esc(b.published.asin) + '</span>' : '')
      + '</div>'
      + (b.pagesGenerated ? '<button class="bb sm ws-review-btn">REVIEW PAGES' + (b.pagesAwaiting ? ' (' + b.pagesAwaiting + ')' : '') + '</button>' : '')
      + (canLive ? '<form class="ws-live-form" hidden><input name="asin" placeholder="ASIN (from KDP)" maxlength="20"><input name="price" placeholder="price" value="' + esc(b.price || '9.99') + '" size="5"><button class="bb sm" type="submit">CONFIRM LIVE</button></form>'
        + '<button class="bb sm ws-live-btn">MARK LIVE</button>' : '')
      + '</div></div>';
  }

  function render(body, v) {
    const g = v.game, m = v.metrics;
    const span = Math.max(1, g.nextLevelXp - g.levelFloorXp), into = g.xp - g.levelFloorXp;
    const other = Object.entries(g.coins.other || {}).map(([c, n]) => n.toFixed(2) + ' ' + esc(c)).join(' · ');
    const tiles = [
      ['BOOKS LIVE', m.booksLive], ['COPIES SOLD', m.unitsSold], ['PAGES APPROVED', m.pagesApproved], ['BEST MONTH', money(m.bestMonthUSD)],
    ].map(([k, n]) => '<div class="ws-tile"><b>' + esc(String(n)) + '</b><small>' + k + '</small></div>').join('');
    const quests = g.quests.slice(0, 5).map(q => '<li><span class="ws-q">⚑</span><span>' + esc(q.text) + '<small>' + esc(q.how || '') + '</small></span></li>').join('');
    const ms = g.milestones.map(x => '<div class="ws-badge' + (x.earned ? ' on' : '') + '" title="' + esc(x.label) + '">'
      + '<span class="ws-badge-ico">' + (x.earned ? '★' : '☆') + '</span><span class="ws-badge-l">' + esc(x.label) + '</span>'
      + '<small>' + (x.earned ? '+' + x.xp + ' XP' : esc(String(Math.min(x.value, x.goal))) + ' / ' + esc(String(x.goal))) + '</small></div>').join('');
    const books = m.books.length
      ? m.books.slice().sort((a, b) => b.stageIndex - a.stageIndex || a.title.localeCompare(b.title)).map(b => bookCard(v, b)).join('')
      : '<p class="dim ws-empty-shelf">The shelf is empty. Ask an agent at the press to research a niche and plan your first book, or run <code>colorbook plan</code> in the folder below.</p>';

    body.innerHTML = '<div class="ws">'
      + '<div class="ws-head">'
      + '<div class="ws-level"><span class="ws-lv">Lv ' + g.level + '</span><span class="ws-title">' + esc(g.title) + '</span></div>'
      + '<div class="ws-name">' + esc(v.name) + '<small>' + esc(v.building) + '</small></div>'
      + '<div class="ws-coins" title="royalties reported by KDP">🪙 ' + money(g.coins.usd) + (other ? '<small>' + other + '</small>' : '') + '</div>'
      + '</div>'
      + '<div class="ws-xp" title="' + g.xp + ' XP"><div class="ws-xp-fill" style="width:' + Math.min(100, Math.round(into / span * 100)) + '%"></div>'
      + '<span>' + into + ' / ' + span + ' XP to Lv ' + (g.level + 1) + '</span></div>'
      + '<div class="ws-tiles">' + tiles + '</div>'
      + '<div class="ws-cols"><div class="ws-col">'
      + '<div class="ws-sec"><span class="ws-h">NEXT UP</span></div><ul class="ws-quests">' + quests + '</ul>'
      + '<div class="ws-sec"><span class="ws-h">BOOKSHELF</span><span class="ws-tag">' + m.books.length + '</span></div><div class="ws-shelf">' + books + '</div>'
      + '</div><div class="ws-col">'
      + (g.nextMilestone ? '<div class="ws-next">Next milestone: <b>' + esc(g.nextMilestone.label) + '</b> · ' + Math.min(g.nextMilestone.value, g.nextMilestone.goal) + ' / ' + g.nextMilestone.goal + ' <span class="ws-tag">+' + g.nextMilestone.xp + ' XP</span></div>' : '')
      + '<div class="ws-sec"><span class="ws-h">MILESTONES</span><span class="ws-tag">' + g.milestones.filter(x => x.earned).length + ' / ' + g.milestones.length + '</span></div>'
      + '<div class="ws-badges">' + ms + '</div>'
      + monthsChart(m.months)
      + '<div class="ws-sec"><span class="ws-h">SALES</span></div>'
      + '<label class="ws-drop"><input type="file" accept=".xlsx,.csv,.tsv" hidden><b>Drop your KDP royalty report here</b>'
      + '<small>KDP → Reports → download (.xlsx or .csv). Re-importing the same report never double-counts.</small></label>'
      + '<div class="ws-import-msg dim">' + (m.imports ? m.imports + ' report' + (m.imports === 1 ? '' : 's') + ' imported' + (m.unmatchedSales ? ' · ' + m.unmatchedSales + ' sale rows for books not in this venture' : '') : 'no reports imported yet') + '</div>'
      + '<div class="ws-dir dim" title="the pipeline\'s working folder">folder: <code>' + esc(v.dir) + '</code></div>'
      + '</div></div></div>';

    celebrate(v, body.querySelector('.ws'));
    wire(body, v);
    loadArt(body);
  }

  function loadArt(body) {
    body.querySelectorAll('[data-art]').forEach(async el => {
      const key = el.getAttribute('data-art');
      let url = artUrls.get(key);
      if (!url) {
        const [id, book] = key.split('/');
        try {
          const r = await fetch('/api/ventures/art?id=' + encodeURIComponent(id) + '&book=' + encodeURIComponent(book));
          if (!r.ok) return;
          url = URL.createObjectURL(await r.blob());
          artUrls.set(key, url);
        } catch (_) { return; }
      }
      el.style.backgroundImage = 'url("' + url + '")';
      el.classList.add('has-art');
    });
  }

  function wire(body, v) {
    const msg = body.querySelector('.ws-import-msg');
    const drop = body.querySelector('.ws-drop'), input = drop.querySelector('input');
    async function upload(file) {
      msg.textContent = 'reading ' + file.name + '…';
      try {
        const j = await api('POST', '/api/ventures/sales?id=' + encodeURIComponent(v.id), await file.arrayBuffer(), { 'Content-Type': 'application/octet-stream', 'x-filename': file.name });
        render(body, j.venture);
        body.querySelector('.ws-import-msg').textContent = file.name + ': ' + j.import.added + ' new sale rows' + (j.import.duplicates ? ', ' + j.import.duplicates + ' already counted' : '');
      } catch (e) { msg.textContent = 'could not import ' + file.name + ' — ' + e.message; msg.classList.add('ws-warn'); }
    }
    input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) upload(f); });

    body.querySelectorAll('.ws-review-btn').forEach(btn => btn.addEventListener('click', () =>
      openReview(body, v, btn.closest('.ws-book').getAttribute('data-book'))));
    body.querySelectorAll('.ws-book').forEach(card => {
      const btn = card.querySelector('.ws-live-btn'), form = card.querySelector('.ws-live-form');
      if (!btn || !form) return;
      btn.addEventListener('click', () => { form.hidden = false; btn.hidden = true; form.querySelector('input').focus(); });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          const j = await api('POST', '/api/ventures/publish', { id: v.id, book: card.getAttribute('data-book'), asin: fd.get('asin'), price: Number(fd.get('price')), date: new Date().toISOString().slice(0, 10) });
          render(body, j.venture);
        } catch (err) { if (StationUI.notify) StationUI.notify('Could not mark it live: ' + err.message, 'warn'); }
      });
    });
  }

  /* ---------- PAGE REVIEW: the Commander's approval step ---------- */
  const imgUrls = new Map();
  async function pageImg(el, vid, book, file) {
    const key = vid + '/' + book + '/' + file;
    let url = imgUrls.get(key);
    if (!url) {
      try {
        const r = await fetch('/api/ventures/img?id=' + encodeURIComponent(vid) + '&book=' + encodeURIComponent(book) + '&file=' + encodeURIComponent(file));
        if (!r.ok) return;
        url = URL.createObjectURL(await r.blob()); imgUrls.set(key, url);
      } catch (_) { return; }
    }
    el.style.backgroundImage = 'url("' + url + '")';
  }

  async function openReview(body, v, book) {
    body.innerHTML = '<div class="ws"><p class="dim">loading pages…</p></div>';
    let data;
    try { data = await api('GET', '/api/ventures/pages?id=' + encodeURIComponent(v.id) + '&book=' + encodeURIComponent(book)); }
    catch (e) { body.innerHTML = '<div class="ws"><p class="ws-warn">' + esc(e.message) + '</p></div>'; return; }
    renderReview(body, v, data);
  }

  function renderReview(body, v, data) {
    const pages = data.pages;
    const counts = { approved: 0, generated: 0, rejected: 0, pending: 0 };
    pages.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    const clean = pages.filter(p => p.status === 'generated' && p.chosen && !((p.variants.find(x => x.file === p.chosen) || {}).flags || []).length);
    const card = p => {
      const ch = p.variants.find(x => x.file === p.chosen) || null;
      const flags = ch ? ch.flags.filter(f => f !== 'rejected in review') : [];
      return '<div class="wr-page st-' + esc(p.status) + '" data-n="' + p.n + '">'
        + '<div class="wr-img" data-file="' + esc(p.chosen || '') + '">' + (p.chosen ? '' : '<span>' + (p.status === 'rejected' ? 'sent back — redraw next run' : 'not drawn yet') + '</span>') + '</div>'
        + '<div class="wr-meta"><b>' + p.n + '. ' + esc(p.title) + '</b><span class="wr-st">' + esc(p.status.toUpperCase()) + '</span></div>'
        + (p.variants.length > 1 ? '<div class="wr-vars">' + p.variants.map((x, i) => '<button class="wr-var' + (x.file === p.chosen ? ' on' : '') + '" data-file="' + esc(x.file) + '" title="' + esc((x.flags || []).join(', ') || 'no flags') + '">v' + (i + 1) + (x.score != null ? ' · ' + x.score : '') + '</button>').join('') + '</div>' : '')
        + (flags.length ? '<div class="wr-flags">⚠ ' + flags.map(esc).join(' · ') + '</div>' : (ch ? '<div class="wr-ok">QC clean' + (ch.score != null ? ' · ' + ch.score : '') + '</div>' : ''))
        + (p.notes.length ? '<div class="wr-note dim">note: ' + esc(p.notes[p.notes.length - 1]) + '</div>' : '')
        + (p.status !== 'approved' && p.chosen ? '<div class="wr-acts"><button class="bb sm wr-approve">✓ APPROVE</button><button class="bb sm wr-redo">↻ REDO</button></div>'
          + '<form class="wr-redo-form" hidden><input name="note" maxlength="300" placeholder="what to fix (goes into the next drawing)"><button class="bb sm" type="submit">SEND BACK</button></form>' : '')
        + (p.status === 'approved' ? '<div class="wr-acts"><button class="bb sm wr-redo">↻ REDO</button></div><form class="wr-redo-form" hidden><input name="note" maxlength="300" placeholder="what to fix"><button class="bb sm" type="submit">SEND BACK</button></form>' : '')
        + '</div>';
    };
    body.innerHTML = '<div class="ws wr">'
      + '<div class="wr-head"><button class="bb sm wr-back">◂ WORKSHOP</button><div class="ws-name">' + esc(data.book.title) + '<small>page review</small></div>'
      + '<div class="wr-counts"><span class="ok">' + counts.approved + ' approved</span> · ' + (counts.generated || 0) + ' waiting · ' + (counts.rejected || 0) + ' sent back · ' + (counts.pending || 0) + ' not drawn</div>'
      + (clean.length ? '<button class="bb wr-approve-clean">✓ APPROVE ' + clean.length + ' QC-CLEAN PAGE' + (clean.length === 1 ? '' : 'S') + '</button>' : '') + '</div>'
      + '<p class="dim wr-help">You are the art director: approve pages that are ready to print, pick another variant, or send a page back with a note. Approved pages are the only ones that go in the book.</p>'
      + '<div class="wr-grid">' + pages.map(card).join('') + '</div></div>';

    const submit = async ops => {
      try { const j = await api('POST', '/api/ventures/review', Object.assign({ id: v.id, book: data.book.slug }, ops)); renderReview(body, j.venture, j); }
      catch (e) { if (StationUI.notify) StationUI.notify('Review failed: ' + e.message, 'warn'); }
    };
    body.querySelector('.wr-back').addEventListener('click', () => build(body));
    const ac = body.querySelector('.wr-approve-clean');
    if (ac) ac.addEventListener('click', () => submit({ approve: clean.map(p => p.n) }));
    body.querySelectorAll('.wr-page').forEach(el => {
      const n = Number(el.getAttribute('data-n'));
      const im = el.querySelector('.wr-img'); const f = im.getAttribute('data-file');
      if (f) pageImg(im, v.id, data.book.slug, f);
      el.querySelectorAll('.wr-var').forEach(b => b.addEventListener('click', () => submit({ choose: [{ n, file: b.getAttribute('data-file') }] })));
      const ap = el.querySelector('.wr-approve'); if (ap) ap.addEventListener('click', () => submit({ approve: [n] }));
      const rd = el.querySelector('.wr-redo'), form = el.querySelector('.wr-redo-form');
      if (rd && form) {
        rd.addEventListener('click', () => { form.hidden = false; form.querySelector('input').focus(); });
        form.addEventListener('submit', e => { e.preventDefault(); submit({ reject: [{ n, note: new FormData(form).get('note') }] }); });
      }
    });
  }

  async function build(body) {
    body.innerHTML = '<div class="ws"><p class="dim">opening the workshop…</p></div>';
    let j;
    try { j = await api('GET', '/api/ventures'); }
    catch (e) { body.innerHTML = '<div class="ws"><p class="ws-warn">The workshop ledger could not be read: ' + esc(e.message) + '</p></div>'; return; }
    const v = j.ventures[0];
    if (!v) {
      body.innerHTML = '<div class="ws ws-start">'
        + '<div class="ws-start-art">📚</div>'
        + '<h3>Open your first business</h3>'
        + '<p>Start a <b>Coloring Book Press</b>: your agents research niches, plan books and draw pages; you approve every page and publish on Amazon KDP. '
        + 'Everything you ship and sell levels up your workshop. No points are ever invented: the numbers come from your books and your KDP reports.</p>'
        + '<button class="bb ws-start-btn">OPEN THE COLORING BOOK PRESS</button></div>';
      body.querySelector('.ws-start-btn').addEventListener('click', async () => {
        try { const c = await api('POST', '/api/ventures', { kind: 'coloring-books', name: 'Coloring Books' }); render(body, c.venture); }
        catch (e) { if (StationUI.notify) StationUI.notify('Could not open the press: ' + e.message, 'warn'); }
      });
      return;
    }
    render(body, v);
  }

  StationUI.registerWindow('ventures', 'WORKSHOP', body => { build(body); }, {});
})();
