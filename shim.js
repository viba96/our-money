/* Connects the app to your Google Sheet through the Apps Script web app (Code.gs).
   The app was built to call window.claude.use('db') and window.claude.use('downloads');
   this file answers those calls. It keeps a copy on the phone, queues changes while offline,
   and refreshes from the sheet every 30 seconds, when the app is reopened, and on demand. */
(function () {
  'use strict';
  var cfg = window.SHEETS_CONFIG || {};
  var K = { pass: 'om-pass', cache: 'om-cache', out: 'om-outbox', last: 'om-last' };
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var clone = function (x) { return x == null ? x : JSON.parse(JSON.stringify(x)); };
  var newId = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };

  var server = { tx: {}, goals: {}, cfg: {} };
  var loaded = false, outbox = [], listeners = [], syncing = false, fails = 0, lastErr = '';
  var last = +ls.get(K.last) || 0, pass = ls.get(K.pass) || '', lastJson = '', timer = null, started = false, ov = null;

  try {
    var cached = JSON.parse(ls.get(K.cache) || 'null');
    if (cached && typeof cached === 'object') {
      server = { tx: cached.tx || {}, goals: cached.goals || {}, cfg: cached.cfg || {} };
      loaded = true; lastJson = JSON.stringify(cached);
    }
  } catch (e) {}
  try { outbox = JSON.parse(ls.get(K.out) || '[]') || []; } catch (e) { outbox = []; }

  function emit() { try { window.dispatchEvent(new Event('om-status')); } catch (e) {} }

  /* ---- local view = last data from the sheet + changes not yet uploaded ---- */
  function applyOp(v, op) {
    var m = v[op.c]; if (!m) return;
    if (op.op === 'del') delete m[op.id]; else m[op.id] = clone(op.d);
  }
  function view() { var v = clone(server); outbox.forEach(function (op) { applyOp(v, op); }); return v; }
  function docSnap(v) {
    var d = v.cfg.main;
    return { id: 'main', exists: !!d, data: function () { return d ? clone(d) : undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function colSnap(v, name) {
    var m = v[name] || {}, docs = Object.keys(m).map(function (id) {
      return { id: id, exists: true, data: function () { return clone(m[id]); } };
    });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function deliver(l) {
    try { l.cb(l.type === 'doc' ? docSnap(view()) : colSnap(view(), l.name)); } catch (e) { console.error(e); }
  }
  function notify() { if (loaded) listeners.slice().forEach(deliver); }
  function listen(l) {
    listeners.push(l);
    if (loaded) setTimeout(function () { deliver(l); }, 0);
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }
  function write(c, id, op, d) {
    outbox.push({ c: c, op: op, id: id, d: op === 'set' ? clone(d) : undefined });
    ls.set(K.out, JSON.stringify(outbox));
    notify(); emit();
    clearTimeout(timer); timer = setTimeout(sync, 400);
    return Promise.resolve();
  }

  /* ---- talking to the sheet ---- */
  function sync() {
    if (syncing || !pass || !cfg.url) return Promise.resolve();
    syncing = true; emit();
    var sent = outbox.slice();
    return fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ pass: pass, ops: sent }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.error === 'auth') { pass = ''; ls.del(K.pass); lastErr = 'auth'; showPass('That passcode is not right.'); return; }
        if (!res || !res.ok || !res.data) { lastErr = 'server'; fails++; return; }
        fails = 0; lastErr = '';
        outbox = outbox.slice(sent.length); ls.set(K.out, JSON.stringify(outbox));
        var j = JSON.stringify(res.data), changed = j !== lastJson || !loaded;
        lastJson = j;
        server = { tx: res.data.tx || {}, goals: res.data.goals || {}, cfg: res.data.cfg || {} };
        loaded = true; last = Date.now();
        ls.set(K.cache, j); ls.set(K.last, String(last));
        if (changed || sent.length) notify();
      })
      .catch(function () { lastErr = 'net'; fails++; })
      .then(function () {
        syncing = false; emit();
        if (outbox.length && lastErr !== 'auth') { clearTimeout(timer); timer = setTimeout(sync, Math.min(30000, 1000 * Math.pow(2, fails))); }
      });
  }
  function start() {
    if (started) return; started = true;
    sync();
    setInterval(function () { if (!document.hidden) sync(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
    window.addEventListener('online', sync);
    window.addEventListener('focus', sync);
  }

  /* ---- passcode / setup screens ---- */
  function overlay() {
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'auth';
    ov.style.cssText = 'position:fixed;inset:0;z-index:60;background:var(--bg);color:var(--ink);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto';
    document.body.appendChild(ov);
    return ov;
  }
  function card(inner) {
    return '<form id="authForm" style="width:100%;max-width:380px;background:var(--cd);border:1px solid var(--ln);border-radius:22px;padding:22px;display:flex;flex-direction:column;gap:6px">' + inner + '</form>';
  }
  function showSetup() {
    overlay().hidden = false;
    ov.innerHTML = card('<h1>Almost there</h1><p class="sb">This copy is not connected to your Google Sheet yet. Open <b>sheets-config.js</b>, paste your web app address (guide, step 5) and upload the files again.</p>');
  }
  function showPass(msg, cb) {
    overlay().hidden = false;
    ov.innerHTML = card('<h1>Viba &amp; Yuvanthi</h1><p class="sb">Enter your shared passcode. This phone remembers it.</p>' +
      '<label class="f">Passcode<input id="ap" type="password" autocomplete="current-password" required></label>' +
      '<p id="aerr" class="er" role="alert"></p><button class="pri" type="submit">Unlock</button>');
    var err = document.getElementById('aerr'); if (err) err.textContent = msg || '';
    document.getElementById('authForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = document.getElementById('ap').value.trim(); if (!v) return;
      pass = v; ls.set(K.pass, v); lastErr = ''; ov.hidden = true;
      if (cb) cb(); else sync();
    });
  }

  /* ---- the object the app talks to ---- */
  var db = {
    doc: function (path) {
      if (path !== 'cfg/main') throw new TypeError('unsupported path');
      return {
        onSnapshot: function (cb) { return listen({ type: 'doc', cb: cb }); },
        set: function (d) { return write('cfg', 'main', 'set', d); }
      };
    },
    collection: function (name) {
      return {
        onSnapshot: function (cb) { return listen({ type: 'col', name: name, cb: cb }); },
        add: function (d) { var id = newId(); return write(name, id, 'set', d).then(function () { return { id: id }; }); },
        doc: function (id) {
          return {
            set: function (d) { return write(name, id, 'set', d); },
            update: function (d) {
              var cur = view()[name][id]; if (!cur) return Promise.resolve();
              return write(name, id, 'set', Object.assign({}, cur, d));
            },
            delete: function () { return write(name, id, 'del'); }
          };
        }
      };
    }
  };
  function getDb() {
    if (!cfg.url || /PASTE/i.test(cfg.url)) { showSetup(); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      function go() { resolve(db); start(); }
      if (pass) go(); else showPass('', go);
    });
  }
  var downloads = {
    save: function (o) {
      try {
        var blob = new Blob([o.data], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = o.filename || 'entries.csv';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        return Promise.resolve({ status: 'saved' });
      } catch (e) { return Promise.reject(e); }
    }
  };

  window.__om = {
    refresh: function () { if (!pass) { showPass(''); return Promise.resolve(); } clearTimeout(timer); return sync(); },
    lock: function () { ls.del(K.pass); ls.del(K.cache); ls.del(K.last); location.reload(); },
    info: function () { return { last: last, pending: outbox.length, busy: syncing, err: lastErr, loaded: loaded }; }
  };
  window.claude = {
    use: function (name) {
      if (name === 'db') return getDb();
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);
    }
  };
})();
