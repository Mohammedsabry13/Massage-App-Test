/* app.js — UI, audio, storage. */
(function () {
  'use strict';
  var MP = window.MP, I18N = window.I18N;

  /* ---------- helpers ---------- */
  var $app = document.getElementById('app'), $nav = document.getElementById('nav'), $toast = document.getElementById('toast');
  var $file = document.getElementById('file');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + pad2(sec % 60); }
  function fmtH(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ---------- state ---------- */
  var DEFAULT_EXTRAS = ['abdomen', 'chest', 'face'];
  var PALETTE = ['#e4cf9e', '#b9d9a8', '#8ecae6', '#f4a7b9', '#f6b26b', '#c3a6ff', '#ee9c8c', '#7fd6c2'];
  var MIN_DUR = 5, MAX_DUR = 600;   // session length limits, in minutes

  var S = {
    view: 'home', plan: null, prep: null, session: null, meta: null, recordId: null, pending: null,
    lastTick: Date.now(), soundNames: { 1: null, 2: null, 3: null, 4: null }, pickSlot: 1, lastSnap: 0,
    editing: null, lockTotal: true, planPrep: true, openRec: null, recEdit: false, imgTarget: null
  };
  function defaultExtraList(flags) {
    return DEFAULT_EXTRAS.map(function (k) { return { id: k, name: '', on: !!(flags && flags[k]) }; });
  }
  S.settings = Object.assign({ lang: 'ar', alert: 'both', volume: 0.8, retention: 24, tz: 'cairo', voice: false }, LS.get('mp.settings', {}));
  S.setup = Object.assign({ duration: 60, area: 'full', direction: 'both', skipMode: 'drop' }, LS.get('mp.setup', {}));
  if (S.setup.skipMode !== 'share') S.setup.skipMode = 'drop';
  if (!Array.isArray(S.setup.extraList)) S.setup.extraList = defaultExtraList(S.setup.extras);   // migrate the old fixed toggles
  delete S.setup.extras;
  S.setup.duration = Math.min(MAX_DUR, Math.max(0, Math.round(Number(S.setup.duration)) || 60));
  var records = LS.get('mp.records', []);

  function t(key) { var d = I18N[S.settings.lang]; return (d && d[key] != null) ? d[key] : (I18N.en[key] != null ? I18N.en[key] : key); }
  function saveSettings() { LS.set('mp.settings', S.settings); }
  function saveSetup() { LS.set('mp.setup', S.setup); }
  function saveRecords() { LS.set('mp.records', records); }
  function toast(msg) { $toast.textContent = msg; $toast.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { $toast.classList.remove('show'); }, 2400); }
  function findRec(id) { return records.filter(function (x) { return x.id === id; })[0]; }

  function purge() {
    var h = Number(S.settings.retention);
    if (!h) return;
    var cutoff = Date.now() - h * 3600 * 1000, n = records.length;
    records = records.filter(function (r) { return r.ts >= cutoff; });
    if (records.length !== n) saveRecords();
  }

  /* ---------- time (Alexandria / Cairo by default) ---------- */
  function tzName() { return S.settings.tz === 'device' ? undefined : 'Africa/Cairo'; }
  function locale() { return S.settings.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB'; }
  function safeFmt(ms, opts) {
    var o = Object.assign({}, opts), tz = tzName();
    if (tz) o.timeZone = tz;
    try { return new Date(ms).toLocaleString(locale(), o); }
    catch (e) {
      delete o.timeZone;
      try { return new Date(ms).toLocaleString(locale(), o); } catch (e2) { return new Date(ms).toLocaleString(); }
    }
  }
  function clockStr(ms, withSec) {
    var o = { hour: 'numeric', minute: '2-digit', hour12: true };
    if (withSec) o.second = '2-digit';
    return safeFmt(ms, o);
  }
  function fmtDate(ts) { return safeFmt(ts, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(ts) { return safeFmt(ts, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  // Wall-clock parts of a moment in the chosen time zone, and the way back.
  function tzParts(ms) {
    var o = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }, tz = tzName();
    if (tz) o.timeZone = tz;
    try {
      var f;
      try { f = new Intl.DateTimeFormat('en-US', o); } catch (e) { delete o.timeZone; f = new Intl.DateTimeFormat('en-US', o); }
      var p = {};
      f.formatToParts(new Date(ms)).forEach(function (x) { if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10); });
      if (p.hour === 24) p.hour = 0;
      return p;
    } catch (e2) {
      var d = new Date(ms);
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
    }
  }
  function tzOffset(ms) { var p = tzParts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000; }
  function fromParts(y, mo, d, h, mi) {
    var guess = Date.UTC(y, mo - 1, d, h, mi), ms = guess - tzOffset(guess);
    return guess - tzOffset(ms);
  }
  function cityLabel() { return S.settings.tz === 'device' ? t('city_device') : t('city_cairo'); }

  /* ---------- IndexedDB (custom sounds + images) ---------- */
  var DB = {
    open: function () {
      return new Promise(function (res, rej) {
        var r = indexedDB.open('mp', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('sounds'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    },
    tx: function (mode, fn) {
      return DB.open().then(function (db) {
        return new Promise(function (res, rej) {
          var tx = db.transaction('sounds', mode), st = tx.objectStore('sounds'), req = fn(st);
          tx.oncomplete = function () { res(req && req.result); };
          tx.onerror = function () { rej(tx.error); };
        });
      });
    },
    get: function (k) { return DB.tx('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return DB.tx('readwrite', function (s) { return s.put(v, k); }); },
    del: function (k) { return DB.tx('readwrite', function (s) { return s.delete(k); }); }
  };

  /* ---------- images for cards and movements ---------- */
  var IMG = {}, IMG_REQ = {};
  function loadImg(id) {
    if (!id || IMG[id] || IMG_REQ[id]) return;
    IMG_REQ[id] = 1;
    DB.get('img:' + id).then(function (v) {
      if (v) { IMG[id] = v; if (S.view === 'plan' || S.view === 'session') render(); }
    }).catch(function () {});
  }
  function imgTag(id, cls, extra) {
    if (!id) return '';
    if (!IMG[id]) { loadImg(id); return ''; }
    return '<img class="' + cls + '" src="' + IMG[id] + '" alt=""' + (extra || '') + '>';
  }
  function dropImg(id) { if (!id) return; delete IMG[id]; DB.del('img:' + id).catch(function () {}); }
  function processImage(file, cb) {
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function () {
      try {
        var sc = Math.min(1, 640 / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.width * sc)); c.height = Math.max(1, Math.round(im.height * sc));
        var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(im, 0, 0, c.width, c.height);
        var data = c.toDataURL('image/jpeg', 0.82);
        URL.revokeObjectURL(url); cb(data);
      } catch (e) { URL.revokeObjectURL(url); cb(null); }
    };
    im.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    im.src = url;
  }
  var $img = document.createElement('input');
  $img.type = 'file'; $img.accept = 'image/*'; $img.hidden = true; document.body.appendChild($img);

  /* ---------- audio + vibration ---------- */
  var A = { ctx: null, gain: null, buffers: {} };
  function ensureAudio() {
    try {
      if (!A.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        A.ctx = new AC(); A.gain = A.ctx.createGain(); A.gain.connect(A.ctx.destination);
      }
      if (A.ctx.state === 'suspended') A.ctx.resume();
      return true;
    } catch (e) { return false; }
  }
  function bell(freq, t0, dur, vol) {
    var c = A.ctx, o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), g2 = c.createGain();
    o.type = 'sine'; o.frequency.value = freq; o2.type = 'sine'; o2.frequency.value = freq * 2.01; g2.gain.value = 0.22;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(A.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0); o2.start(t0); o.stop(t0 + dur + 0.05); o2.stop(t0 + dur + 0.05);
  }
  function synth(n) {
    var t0 = A.ctx.currentTime + 0.02;
    if (n === 1) { bell(660, t0, 0.9, 0.7); }
    else if (n === 2) { bell(523.25, t0, 0.8, 0.65); bell(783.99, t0 + 0.3, 1.1, 0.65); }
    else if (n === 4) { bell(880, t0, 0.6, 0.6); bell(698.46, t0 + 0.28, 0.6, 0.6); bell(880, t0 + 0.56, 1.4, 0.65); }
    else { bell(523.25, t0, 1.4, 0.6); bell(659.25, t0 + 0.45, 1.4, 0.6); bell(783.99, t0 + 0.9, 2.2, 0.65); }
  }
  var VIBE = { 1: [220], 2: [200, 120, 200], 3: [600, 150, 600, 150, 600], 4: [150, 80, 150, 80, 400] };
  function play(n) {
    var mode = S.settings.alert;
    if (mode !== 'vibrate' && ensureAudio()) {
      A.gain.gain.value = Number(S.settings.volume);
      var buf = A.buffers[n];
      if (buf) {
        var src = A.ctx.createBufferSource(); src.buffer = buf; src.connect(A.gain);
        var t0 = A.ctx.currentTime; src.start(t0); src.stop(t0 + Math.min(buf.duration, 6));
      } else synth(n);
    }
    if (mode !== 'sound' && navigator.vibrate) { try { navigator.vibrate(VIBE[n]); } catch (e) {} }
  }
  function decode(ab) {
    return new Promise(function (res, rej) {
      var p = A.ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }
  function loadSounds() {
    if (!ensureAudio()) return;
    [1, 2, 3, 4].forEach(function (n) {
      DB.get('s' + n).then(function (rec) {
        if (!rec) return;
        S.soundNames[n] = rec.name;
        return decode(rec.data.slice(0)).then(function (b) { A.buffers[n] = b; if (S.view === 'settings') render(); });
      }).catch(function () {});
    });
  }

  /* ---------- voice announcements (text to speech) ---------- */
  var TTS = { ok: false, voices: [] };
  try { TTS.ok = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; } catch (e) {}
  function refreshVoices() { try { TTS.voices = window.speechSynthesis.getVoices() || []; } catch (e) {} }
  if (TTS.ok) {
    refreshVoices();
    try { window.speechSynthesis.addEventListener('voiceschanged', function () { refreshVoices(); if (S.view === 'settings') render(); }); }
    catch (e) { try { window.speechSynthesis.onvoiceschanged = function () { refreshVoices(); }; } catch (e2) {} }
  }
  function pickVoice() {
    var l = S.settings.lang === 'ar' ? 'ar' : 'en', vs = TTS.voices.filter(function (v) { return (v.lang || '').toLowerCase().indexOf(l) === 0; });
    return vs[0];
  }
  function speak(text, delay, force) {
    if (!TTS.ok || !text || (!force && !S.settings.voice)) return;
    var go = function () {
      try {
        var ss = window.speechSynthesis; ss.cancel();
        var u = new window.SpeechSynthesisUtterance(text), v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = S.settings.lang === 'ar' ? 'ar-SA' : 'en-GB';
        u.volume = Number(S.settings.volume); u.rate = 0.95;
        ss.speak(u);
      } catch (e) {}
    };
    if (delay) setTimeout(go, delay); else go();
  }
  function stopSpeech() { if (TTS.ok) { try { window.speechSynthesis.cancel(); } catch (e) {} } }
  // Speak the movement that just started (and its card name when the card/position changed).
  function speakStep(st, withPart, delay) {
    var s = st.steps[st.idx], txt = stepMove(s);
    if (withPart && s.kind !== 'turn' && stepPart(s) !== txt) txt = stepPart(s) + '. ' + txt;
    speak(txt, delay);
  }
  function speakDelay() { return S.settings.alert === 'vibrate' ? 0 : 700; }   // let the bell finish first

  /* ---------- wake lock ---------- */
  var wake = null;
  function lockScreen() {
    try {
      if ('wakeLock' in navigator && !wake) {
        navigator.wakeLock.request('screen').then(function (l) { wake = l; l.addEventListener('release', function () { wake = null; }); }).catch(function () {});
      }
    } catch (e) {}
  }
  function unlockScreen() { try { if (wake) { wake.release(); wake = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && (S.view === 'prep' || S.view === 'session')) lockScreen();
  });

  /* ---------- labels ---------- */
  function areaLabel(a) { return t('area_' + a); }
  function dirLabel(d) { return t('dir_' + d); }
  function extraLabel(x) { return x.name || t('ex_' + x.id); }
  function gLabel(g) { return g.title || (g.part === 'custom' ? t('new_card') : t('p_' + g.part)); }
  function mLabel(m) { return m.name || (m.key ? t(m.key) : t('new_move')); }
  function stepPart(s) { return s.gtitle || (s.gkey && s.gkey !== 'custom' ? t('p_' + s.gkey) : t('new_card')); }
  function stepMove(s) { return s.mname || (s.mkey ? t(s.mkey) : t('new_move')); }
  function durText(min) {
    var s = min + ' ' + t('min');
    if (min >= 60) s += ' (' + Math.floor(min / 60) + ' ' + t('hr_short') + (min % 60 ? ' ' + (min % 60) + ' ' + t('min_short') : '') + ')';
    return s;
  }
  function planSummary(steps) {
    var out = [], last = null;
    steps.forEach(function (s) {
      if (!last || last.pid !== s.part) { last = { pid: s.part, g: stepPart(s), m: [] }; out.push(last); }
      last.m.push([stepMove(s), Math.round(s.dur)]);
    });
    return out.map(function (x) { return { g: x.g, m: x.m }; });
  }

  /* ---------- flow ---------- */
  function newPrep() { return { rem: 120, ready: false, running: true, name: '', notes: '', checks: [false, false, false, false, false, false] }; }
  function planOk() { return S.plan && MP.flatten(S.plan).length > 0; }
  function startSession() {
    if (!planOk()) { toast(t('no_moves')); return; }
    S.session = MP.createState(MP.flatten(S.plan));
    S.session.skipMode = S.setup.skipMode;
    var mins = Math.round(S.session.total / 60);
    S.meta = { duration: mins, area: S.setup.area, direction: S.setup.direction };
    var id = String(Date.now()), now = Date.now();
    S.recordId = id;
    records.unshift({
      id: id, ts: now, start: now, end: null, edited: false,
      name: S.prep ? S.prep.name.trim() : '', notes: S.prep ? S.prep.notes.trim() : '',
      duration: mins, area: S.setup.area, direction: S.setup.direction, done: false, plan: planSummary(S.session.steps)
    });
    saveRecords();
    S.lastTick = Date.now();
    S.view = 'session'; lockScreen(); ensureAudio(); render();
    speakStep(S.session, true, 0);
  }
  function finishSession(completed) {
    var r = findRec(S.recordId);
    if (r) {
      r.done = !!completed; r.end = Date.now();
      if (S.session) r.plan = planSummary(S.session.steps);
      saveRecords();
    }
    LS.del('mp.session');
    stopSpeech();
    if (completed) play(3);
    S.session = null; unlockScreen();
    S.view = 'done'; render();
  }
  function snapshot(force) {
    var now = Date.now();
    if (!S.session || (!force && now - S.lastSnap < 2000)) return;
    S.lastSnap = now;
    LS.set('mp.session', { v: 2, state: S.session, meta: S.meta, recordId: S.recordId, plan: S.plan, savedAt: now });
  }
  function loadPending() {
    var snap = LS.get('mp.session', null);
    if (snap && snap.v === 2 && snap.state && !snap.state.done && Date.now() - snap.savedAt < 3 * 3600 * 1000) S.pending = snap;
    else if (snap) LS.del('mp.session');
  }
  function restoreSession() {
    var snap = S.pending; S.pending = null;
    if (!snap) return;
    S.session = snap.state; S.meta = snap.meta; S.recordId = snap.recordId; S.plan = snap.plan || S.plan;
    var ev = MP.tick(S.session, Date.now() - snap.savedAt);
    S.lastTick = Date.now(); ensureAudio();
    if (S.session.done || ev.indexOf('end') >= 0) { finishSession(true); return; }
    S.view = 'session'; lockScreen(); render();
  }

  /* ---------- rendering: home ---------- */
  var CIRC = 2 * Math.PI * 96;
  function chips(key, values, labelFn) {
    return '<div class="chips" role="group">' + values.map(function (v) {
      return '<button class="chip" data-action="set" data-k="' + key + '" data-v="' + v + '" aria-pressed="' + (String(S.setup[key]) === String(v)) + '">' + labelFn(v) + '</button>';
    }).join('') + '</div>';
  }
  function summaryText() {
    var extras = S.setup.extraList.filter(function (x) { return x.on; }).map(extraLabel);
    var parts = [durText(S.setup.duration), areaLabel(S.setup.area), dirLabel(S.setup.direction)].concat(extras);
    return t('summary_prefix') + ' <b>' + esc(parts.join(S.settings.lang === 'ar' ? '، ' : ', ')) + '</b>';
  }

  function viewHome() {
    var dur = S.setup.duration;
    var ex = S.setup.extraList.map(function (x) {
      return '<div class="xrow"><button class="tog" data-action="toggle-extra" data-id="' + esc(x.id) + '" aria-pressed="' + !!x.on + '"><span>' + esc(extraLabel(x)) + '</span><i></i></button>' +
        '<button class="xdel" data-action="del-extra" data-id="' + esc(x.id) + '" aria-label="' + t('extras_del') + '">×</button></div>';
    }).join('');
    var pend = S.pending ? '<div class="card"><p>' + t('restore_text') + '</p><div class="acts"><button class="btn small primary" data-action="restore">' + t('restore') + '</button><button class="btn small ghost" data-action="discard">' + t('discard') + '</button></div></div>' : '';
    return pend + '<h1>' + t('app_title') + '</h1>' +
      '<h3>' + t('duration') + '</h3>' +
      '<div class="durbox"><label class="dfield"><input type="number" id="dur-h" inputmode="numeric" min="0" max="10" value="' + Math.floor(dur / 60) + '"><span>' + t('dur_h') + '</span></label>' +
      '<label class="dfield"><input type="number" id="dur-m" inputmode="numeric" min="0" max="59" value="' + (dur % 60) + '"><span>' + t('dur_m') + '</span></label></div>' +
      '<p class="durtotal" id="dur-total">' + esc(durText(dur)) + '</p><p class="muted small">' + t('dur_hint') + '</p>' +
      '<h3>' + t('area') + '</h3>' + chips('area', ['upper', 'lower', 'full'], areaLabel) +
      '<h3>' + t('direction') + '</h3>' + chips('direction', ['front', 'back', 'both'], dirLabel) +
      '<h3>' + t('extras') + '</h3><p class="muted small">' + t('extras_hint') + '</p><div class="toggles">' + ex + '</div>' +
      '<div class="addrow"><input type="text" id="ex-new" autocomplete="off" placeholder="' + esc(t('extras_add_ph')) + '"><button class="btn small" data-action="add-extra">' + t('extras_add') + '</button></div>' +
      '<button class="linkbtn muted" data-action="reset-extras">' + t('extras_reset') + '</button>' +
      '<div class="summary" id="sum">' + summaryText() + '</div>' +
      '<button class="btn primary" data-action="to-plan">' + t('review_plan') + '</button>';
  }

  /* ---------- rendering: plan editor ---------- */
  function planBase() { return Date.now() + (S.planPrep ? 120000 : 0); }

  function colorRow(id, cur) {
    return '<div class="swatches" role="group">' +
      '<button class="sw none' + (!cur ? ' on' : '') + '" data-action="set-color" data-id="' + id + '" data-c="" aria-label="' + t('color_none') + '">×</button>' +
      PALETTE.map(function (c) {
        return '<button class="sw' + (cur === c ? ' on' : '') + '" style="background:' + c + '" data-action="set-color" data-id="' + id + '" data-c="' + c + '" aria-label="' + c + '"></button>';
      }).join('') + '</div>';
  }
  function imageRow(id, imgId) {
    return '<div class="imgrow">' + imgTag(imgId, 'ed-thumb') +
      '<button class="btn small" data-action="pick-img" data-id="' + id + '">' + t(imgId ? 'ed_change_img' : 'ed_pick_img') + '</button>' +
      (imgId ? '<button class="btn small ghost" data-action="rm-img" data-id="' + id + '">' + t('ed_remove_img') + '</button>' : '') + '</div>';
  }
  function groupEditor(g) {
    return '<div class="editor">' +
      '<label class="field"><span>' + t('ed_card_name') + '</span><input type="text" data-edit="g-title" data-id="' + g.id + '" autocomplete="off" value="' + esc(g.title) + '" placeholder="' + esc(g.part === 'custom' ? t('new_card') : t('p_' + g.part)) + '"></label>' +
      '<span class="lab">' + t('ed_color') + '</span>' + colorRow(g.id, g.color) +
      '<span class="lab">' + t('ed_image') + '</span>' + imageRow(g.id, g.img) +
      '<div class="acts"><button class="btn small" data-action="g-up" data-id="' + g.id + '">' + t('ed_up') + '</button><button class="btn small" data-action="g-down" data-id="' + g.id + '">' + t('ed_down') + '</button>' +
      '<button class="btn small" data-action="add-move" data-id="' + g.id + '">' + t('add_move') + '</button></div>' +
      '<div class="acts"><button class="btn small danger" data-action="del-group" data-id="' + g.id + '">' + t('ed_delete_card') + '</button><button class="btn small primary" data-action="edit-close">' + t('ed_done') + '</button></div></div>';
  }
  function moveEditor(m, g) {
    var opts = S.plan.map(function (x) { return '<option value="' + x.id + '"' + (x.id === g.id ? ' selected' : '') + '>' + esc(gLabel(x)) + '</option>'; }).join('');
    return '<div class="editor">' +
      '<label class="field"><span>' + t('ed_name') + '</span><input type="text" data-edit="m-name" data-id="' + m.id + '" autocomplete="off" value="' + esc(m.name) + '" placeholder="' + esc(m.key ? t(m.key) : t('new_move')) + '"></label>' +
      '<span class="lab">' + t('ed_time') + '</span>' +
      '<div class="durfields"><label class="dfield"><input type="number" inputmode="numeric" min="0" id="md-m" value="' + Math.floor(m.dur / 60) + '"><span>' + t('dur_m') + '</span></label>' +
      '<label class="dfield"><input type="number" inputmode="numeric" min="0" id="md-s" value="' + (Math.round(m.dur) % 60) + '"><span>' + t('sec_lbl') + '</span></label></div>' +
      '<span class="lab">' + t('ed_color') + '</span>' + colorRow(m.id, m.color) +
      '<span class="lab">' + t('ed_image') + '</span>' + imageRow(m.id, m.img) +
      '<label class="field"><span>' + t('ed_move_to') + '</span><select data-edit="m-to">' + opts + '</select></label>' +
      '<div class="acts"><button class="btn small" data-action="m-up" data-id="' + m.id + '">' + t('ed_up') + '</button><button class="btn small" data-action="m-down" data-id="' + m.id + '">' + t('ed_down') + '</button></div>' +
      '<div class="acts"><button class="btn small danger" data-action="del-move" data-id="' + m.id + '">' + t('ed_delete_move') + '</button><button class="btn small primary" data-action="edit-close">' + t('ed_done') + '</button></div></div>';
  }

  function viewPlan() {
    var groups = S.plan, total = MP.sumDur(groups), base = planBase(), off = 0, html = '', gi, mi;
    html += '<h1>' + t('plan_title') + '</h1><p class="muted">' + t('plan_hint') + '</p>';
    html += '<div class="total-card"><div class="row"><span class="lbl">' + t('plan_total') + '</span><b class="num" id="plan-total">' + fmtH(total) + '</b></div>' +
      '<button class="tog mini" data-action="toggle-lock" aria-pressed="' + S.lockTotal + '"><span>' + t('lock_total') + '</span><i></i></button></div>';
    html += '<div class="summary">' + summaryText() + '</div>';
    if (MP.shortest(groups) < 40) html += '<div class="warn">' + t('warn_short') + '</div>';
    html += '<div class="clock-card"><div class="clock-row"><span>' + t('clock_now') + ' <small>(' + esc(cityLabel()) + ')</small></span><b id="plan-clock">' + esc(clockStr(Date.now(), true)) + '</b></div>' +
      '<button class="tog mini" data-action="toggle-planprep" aria-pressed="' + S.planPrep + '"><span>' + t('clock_after_prep') + '</span><i></i></button></div>';

    html += '<div class="clock-card skip-card"><div class="skip-h">' + t('skip_title') + '</div><div class="chips" role="group">' +
      '<button class="chip" data-action="skipmode" data-v="drop" aria-pressed="' + (S.setup.skipMode === 'drop') + '">' + t('skip_drop') + '</button>' +
      '<button class="chip" data-action="skipmode" data-v="share" aria-pressed="' + (S.setup.skipMode === 'share') + '">' + t('skip_share') + '</button></div></div>';

    for (gi = 0; gi < groups.length; gi++) {
      var g = groups[gi], gs = MP.groupSum(g), gOpen = S.editing === g.id, gStart = off;
      html += '<div class="pgroup' + (g.kind === 'turn' ? ' turn' : '') + '" data-gid="' + g.id + '"' + (g.color ? ' style="--gc:' + g.color + '"' : '') + '>' +
        '<div class="pg-h"><button class="grip" data-drag="g:' + g.id + '" aria-label="' + t('drag') + '">⠿</button>' +
        '<button class="pg-title" data-action="edit" data-id="' + g.id + '" aria-expanded="' + gOpen + '">' + imgTag(g.img, 'thumb') +
        '<span class="ttw"><span class="tt" data-tt="' + g.id + '">' + esc(gLabel(g)) + '</span>' +
        '<small class="rng"><bdi data-clk="' + gStart + '">' + esc(clockStr(base + gStart * 1000)) + '</bdi> – <bdi data-clk="' + (gStart + gs) + '">' + esc(clockStr(base + (gStart + gs) * 1000)) + '</bdi></small></span></button>' +
        '<span class="pg-dur">' + fmt(gs) + '</span></div>';
      if (gOpen) html += groupEditor(g);
      for (mi = 0; mi < g.moves.length; mi++) {
        var m = g.moves[mi], mOpen = S.editing === m.id;
        off += m.dur;
        html += '<div class="mrow" data-mid="' + m.id + '"' + (m.color ? ' style="--mc:' + m.color + '"' : '') + '>' +
          '<button class="grip" data-drag="m:' + m.id + '" aria-label="' + t('drag') + '">⠿</button>' +
          '<button class="mv" data-action="edit" data-id="' + m.id + '" aria-expanded="' + mOpen + '">' + (m.color ? '<i class="dot"></i>' : '') + imgTag(m.img, 'thumb') +
          '<span class="mvt"><span data-tt="' + m.id + '">' + esc(mLabel(m)) + '</span><small><bdi data-clk="' + off + '">' + esc(clockStr(base + off * 1000)) + '</bdi></small></span></button>' +
          '<button class="step-btn" data-action="plan-adj" data-id="' + m.id + '" data-d="-30" aria-label="' + t('secs30m') + '">−</button>' +
          '<span class="tm">' + fmt(m.dur) + '</span>' +
          '<button class="step-btn" data-action="plan-adj" data-id="' + m.id + '" data-d="30" aria-label="' + t('secs30p') + '">+</button></div>';
        if (mOpen) html += moveEditor(m, g);
      }
      html += '<div class="pg-f"><button class="btn small ghost" data-action="add-move" data-id="' + g.id + '">' + t('add_move') + '</button></div></div>';
    }
    html += '<button class="btn ghost dashed mt" data-action="add-group">' + t('add_card') + '</button>' +
      '<button class="btn primary mt2" data-action="to-prep">' + t('start_prep') + '</button>' +
      '<button class="btn ghost mt" data-action="skip-prep">' + t('skip_prep') + '</button>' +
      '<button class="btn red mt" data-action="to-home">' + t('back') + '</button>';
    return html;
  }

  /* ---------- rendering: prep, session, done ---------- */
  function viewPrep() {
    var p = S.prep, qs = '';
    for (var i = 1; i <= 6; i++) {
      qs += '<label class="check"><input type="checkbox" data-check="' + (i - 1) + '"' + (p.checks[i - 1] ? ' checked' : '') + '><span>' + t('q' + i) + '</span></label>';
    }
    return '<h1>' + t('prep_title') + '</h1>' +
      '<div class="timer-card' + (p.ready ? ' ready' : '') + '"><div class="big-time" id="prep-time">' + fmt(p.rem) + '</div>' +
      '<p class="muted" style="margin:8px 0 0">' + (p.ready ? t('prep_ready') : t('prep_hint')) + '</p></div>' +
      '<div class="row3" style="grid-template-columns:1fr 1fr;margin-top:12px">' +
      '<button class="btn small" data-action="prep-toggle">' + (p.running ? t('pause') : t('resume')) + '</button>' +
      '<button class="btn small" data-action="prep-add">' + t('add_30') + '</button></div>' +
      '<h3>' + t('questions') + '</h3>' + qs +
      '<div class="note">' + t('safety') + '</div>' +
      '<label class="field"><span>' + t('client_name') + '</span><input type="text" id="c-name" autocomplete="off" value="' + esc(p.name) + '"></label>' +
      '<label class="field"><span>' + t('notes') + '</span><textarea id="c-notes">' + esc(p.notes) + '</textarea></label>' +
      '<button class="btn primary mt2" data-action="start-session">' + t('start_session') + '</button>' +
      '<button class="btn ghost mt" data-action="cancel-prep">' + t('back') + '</button>';
  }

  function viewSession() {
    var st = S.session, cur = st.steps[st.idx], nxt = st.steps[st.idx + 1];
    // segmented progress by card
    var segs = '', acc = 0, j = 0;
    while (j < st.steps.length) {
      var pid = st.steps[j].part, kind = st.steps[j].kind, col = st.steps[j].gcolor, sum = 0;
      while (j < st.steps.length && st.steps[j].part === pid) { sum += st.steps[j].dur; j++; }
      segs += '<div class="seg' + (kind === 'turn' ? ' turn' : '') + '" style="flex:' + sum.toFixed(1) + '" data-s="' + acc.toFixed(1) + '" data-e="' + (acc + sum).toFixed(1) + '"><i' + (col ? ' style="background:' + col + '"' : '') + '></i></div>';
      acc += sum;
    }
    var accent = cur.mcolor || cur.gcolor;
    var nextHtml = nxt
      ? '<span><span class="nx">' + t('next') + ':</span> ' + esc(stepMove(nxt)) + '</span>' + (nxt.part !== cur.part ? '<span class="tag">' + t('part_change') + '</span>' : '')
      : '<span>' + t('last_move') + '</span>';
    return '<section class="session' + (st.running ? '' : ' paused') + '"' + (accent ? ' style="--acc:' + accent + '"' : '') + '>' +
      '<div class="topline"><span>' + t('remaining') + ' <b id="tot-rem">' + fmtH(Math.ceil(MP.totalRemaining(st))) + '</b></span><span>' + t('move_of').replace('{a}', st.idx + 1).replace('{b}', st.steps.length) + '</span></div>' +
      '<div class="segs" aria-hidden="true">' + segs + '</div>' +
      '<p class="part">' + esc(stepPart(cur)) + '</p>' +
      '<h2 class="move">' + esc(stepMove(cur)) + '</h2>' +
      imgTag(cur.mimg || cur.gimg, 'move-img', ' data-action="zoom"') +
      '<div class="ring-wrap"><svg viewBox="0 0 220 220" aria-hidden="true"><circle class="ring-bg" cx="110" cy="110" r="96"/>' +
      '<circle class="ring-fg" id="ring" cx="110" cy="110" r="96" stroke-dasharray="' + CIRC.toFixed(1) + '" stroke-dashoffset="0"/></svg>' +
      '<div class="ring-num"><div class="big-time" id="cur-time">' + fmt(Math.ceil(st.rem)) + '</div>' + (st.running ? '' : '<small>' + t('paused') + '</small>') + '</div></div>' +
      '<div class="next">' + nextHtml + '</div>' +
      '<div class="ctrl"><button class="btn primary" data-action="toggle-run">' + (st.running ? t('pause') : t('resume')) + '</button>' +
      '<div class="row3"><button class="btn" data-action="adj" data-d="-30">' + t('secs30m') + '</button><button class="btn" data-action="skip">' + t('skip') + '</button><button class="btn" data-action="adj" data-d="30">' + t('secs30p') + '</button></div>' +
      '<button class="linkbtn" data-action="end">' + t('end') + '</button></div></section>';
  }

  function viewDone() {
    return '<h1>' + t('done_title') + '</h1><p class="muted">' + t('done_text') + '</p>' +
      '<button class="btn primary mt" data-action="to-records">' + t('go_records') + '</button>' +
      '<button class="btn ghost mt" data-action="to-home">' + t('new_session') + '</button>';
  }

  /* ---------- rendering: records ---------- */
  function recordMeta(r) { return [r.duration + ' ' + t('min'), areaLabel(r.area), dirLabel(r.direction), r.done ? t('status_done') : t('status_partial')].join(S.settings.lang === 'ar' ? '، ' : ', '); }

  function recDetails(r) {
    var st = r.start || r.ts;
    var kv = [
      ['hl', t('rec_start'), clockStr(st)], ['hl', t('rec_end'), r.end ? clockStr(r.end) : '—'],
      ['', t('rec_duration'), r.duration + ' ' + t('min')], ['', t('rec_status'), r.done ? t('status_done') : t('status_partial')],
      ['', t('area'), areaLabel(r.area)], ['', t('direction'), dirLabel(r.direction)]
    ].map(function (x) { return '<div class="' + x[0] + '"><dt>' + esc(x[1]) + '</dt><dd>' + esc(x[2]) + '</dd></div>'; }).join('');
    var moves = '';
    if (r.plan && r.plan.length) {
      moves = '<h3>' + t('rec_moves') + '</h3>' + r.plan.map(function (g) {
        var sum = 0; g.m.forEach(function (x) { sum += x[1]; });
        return '<div class="rp"><div class="rph"><span>' + esc(g.g) + '</span><span>' + fmt(sum) + '</span></div><ul>' +
          g.m.map(function (x) { return '<li><span>' + esc(x[0]) + '</span><span>' + fmt(x[1]) + '</span></li>'; }).join('') + '</ul></div>';
      }).join('');
    }
    return '<div class="rec-body"><div class="meta">' + esc(fmtDay(st)) + '</div><dl class="kv">' + kv + '</dl>' +
      (r.notes ? '<h3>' + t('notes') + '</h3><div class="notes">' + esc(r.notes) + '</div>' : '') + moves +
      '<div class="acts"><button class="btn small" data-action="edit-rec" data-id="' + r.id + '">' + t('rec_edit') + '</button>' +
      '<button class="btn small" data-action="copy-rec" data-id="' + r.id + '">' + t('copy') + '</button>' +
      '<button class="btn small danger" data-action="del-rec" data-id="' + r.id + '">' + t('delete') + '</button></div></div>';
  }

  function recForm(r) {
    var st = r.start || r.ts, p = tzParts(st), pe = r.end ? tzParts(r.end) : null;
    function opt(v, label, cur) { return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + label + '</option>'; }
    return '<div class="rec-body form">' +
      '<label class="field"><span>' + t('client_name') + '</span><input type="text" id="r-name" autocomplete="off" value="' + esc(r.name) + '"></label>' +
      '<div class="two"><label class="field"><span>' + t('rec_date') + '</span><input type="date" id="r-date" value="' + p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + '"></label>' +
      '<label class="field"><span>' + t('rec_dur_min') + '</span><input type="number" inputmode="numeric" min="1" id="r-dur" value="' + r.duration + '"></label></div>' +
      '<div class="two"><label class="field"><span>' + t('rec_start') + '</span><input type="time" id="r-start" value="' + pad2(p.hour) + ':' + pad2(p.minute) + '"></label>' +
      '<label class="field"><span>' + t('rec_end') + '</span><input type="time" id="r-end" value="' + (pe ? pad2(pe.hour) + ':' + pad2(pe.minute) : '') + '"></label></div>' +
      '<div class="two"><label class="field"><span>' + t('area') + '</span><select id="r-area">' + ['upper', 'lower', 'full'].map(function (a) { return opt(a, areaLabel(a), r.area); }).join('') + '</select></label>' +
      '<label class="field"><span>' + t('direction') + '</span><select id="r-dir">' + ['front', 'back', 'both'].map(function (a) { return opt(a, dirLabel(a), r.direction); }).join('') + '</select></label></div>' +
      '<label class="field"><span>' + t('rec_status') + '</span><select id="r-status">' + opt('1', t('status_done'), r.done ? '1' : '0') + opt('0', t('status_partial'), r.done ? '1' : '0') + '</select></label>' +
      '<label class="field"><span>' + t('notes') + '</span><textarea id="r-notes">' + esc(r.notes) + '</textarea></label>' +
      '<div class="acts"><button class="btn small primary" data-action="save-rec" data-id="' + r.id + '">' + t('save') + '</button><button class="btn small ghost" data-action="cancel-rec">' + t('cancel') + '</button></div></div>';
  }

  function recCard(r) {
    var open = S.openRec === r.id;
    var tag = '<span class="edtag' + (r.edited ? ' on' : '') + '">' + t(r.edited ? 'rec_edited' : 'rec_not_edited') + '</span>';
    var head = '<div class="rec-head" role="button" tabindex="0" aria-expanded="' + open + '" data-action="toggle-rec" data-id="' + r.id + '"><h4>' + esc(r.name || '—') + '</h4>' +
      '<div class="meta">' + esc(fmtDate(r.start || r.ts)) + '<br>' + esc(recordMeta(r)) + '</div><span class="chev" aria-hidden="true">▾</span></div>';
    return '<div class="card rec' + (open ? ' open' : '') + '" data-rid="' + r.id + '">' + tag + head + (open ? (S.recEdit ? recForm(r) : recDetails(r)) : '') + '</div>';
  }

  function viewRecords() {
    purge();
    var body = records.length
      ? '<p class="muted">' + t('rec_tap_hint') + '</p>' + records.map(recCard).join('') + '<button class="btn danger mt" data-action="del-all">' + t('delete_all') + '</button>'
      : '<p class="muted">' + t('records_empty') + '</p>';
    return '<h1>' + t('records_title') + '</h1>' + body;
  }

  function saveRec() {
    var r = findRec(S.openRec);
    if (!r) return;
    function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
    var dur = Math.round(Number(v('r-dur')));
    if (!(dur >= 1)) { toast(t('bad_time')); return; }
    var oldStart = r.start || r.ts, base = tzParts(oldStart);
    var dp = v('r-date').split('-').map(Number), y = base.year, mo = base.month, d = base.day;
    if (dp.length === 3 && dp[0] && dp[1] && dp[2]) { y = dp[0]; mo = dp[1]; d = dp[2]; }
    var start = oldStart, end = null, sv = v('r-start'), ev = v('r-end'), a;
    if (sv) { a = sv.split(':').map(Number); start = fromParts(y, mo, d, a[0], a[1]); }
    if (ev) { a = ev.split(':').map(Number); end = fromParts(y, mo, d, a[0], a[1]); if (end <= start) end += 86400000; }
    if (isNaN(start) || (end !== null && isNaN(end))) { toast(t('bad_time')); return; }
    var n = { name: v('r-name').trim(), notes: v('r-notes').trim(), area: v('r-area'), direction: v('r-dir'), done: v('r-status') === '1', duration: dur, start: start, end: end };
    var changed = false;
    Object.keys(n).forEach(function (k) {
      var old = k === 'start' ? oldStart : r[k];
      if (n[k] !== old && !(n[k] === null && (old == null))) changed = true;
    });
    Object.keys(n).forEach(function (k) { r[k] = n[k]; });
    if (changed) r.edited = true;
    saveRecords(); S.recEdit = false; toast(t('saved')); render();
  }

  /* ---------- rendering: settings, nav ---------- */
  function viewSettings() {
    var lang = S.settings.lang, alertOpts = ['sound', 'vibrate', 'both'];
    var alertLabel = { sound: t('alert_sound'), vibrate: t('alert_vibe'), both: t('alert_both') };
    var rows = [1, 2, 3, 4].map(function (n) {
      return '<div class="srow"><div class="lbl">' + t('s' + n) + '</div><div class="src">' + (S.soundNames[n] ? esc(S.soundNames[n]) : t('src_default')) + '</div>' +
        '<div class="acts"><button class="btn small" data-action="test" data-n="' + n + '">' + t('test') + '</button>' +
        '<button class="btn small" data-action="pick" data-n="' + n + '">' + t('choose') + '</button>' +
        (S.soundNames[n] ? '<button class="btn small ghost" data-action="reset-sound" data-n="' + n + '">' + t('reset') + '</button>' : '') + '</div></div>';
    }).join('');
    var ret = [24, 48, 168, 0].map(function (h) { return '<option value="' + h + '"' + (Number(S.settings.retention) === h ? ' selected' : '') + '>' + t('ret_' + h) + '</option>'; }).join('');
    var guide = '<ol>' + t('guide').map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ol>';
    var dev = S.settings.tz === 'device';
    var voiceHtml = '<h3>' + t('voice_title') + '</h3>' + (TTS.ok
      ? '<button class="tog" data-action="toggle-voice" aria-pressed="' + !!S.settings.voice + '"><span>' + t('voice_toggle') + '</span><i></i></button>' +
        '<p class="muted small mt">' + t('voice_hint') + '</p><div class="acts"><button class="btn small" data-action="test-voice">' + t('voice_test') + '</button></div>' +
        (TTS.voices.length && !pickVoice() ? '<p class="note">' + t('voice_no_voice') + '</p>' : '')
      : '<p class="note">' + t('voice_unsupported') + '</p>');
    return '<h1>' + t('settings_title') + '</h1>' +
      '<h3>' + t('language') + '</h3><div class="chips"><button class="chip" data-action="lang" data-v="ar" aria-pressed="' + (lang === 'ar') + '">العربية</button><button class="chip" data-action="lang" data-v="en" aria-pressed="' + (lang === 'en') + '">English</button></div>' +
      '<h3>' + t('tz_title') + '</h3><div class="chips"><button class="chip" data-action="tz" data-v="cairo" aria-pressed="' + !dev + '">' + t('tz_cairo') + '</button><button class="chip" data-action="tz" data-v="device" aria-pressed="' + dev + '">' + t('tz_device') + '</button></div>' +
      '<p class="muted small mt">' + t('tz_note') + ' <b>' + esc(clockStr(Date.now())) + '</b></p>' +
      '<h3>' + t('alerts') + '</h3><div class="chips">' + alertOpts.map(function (o) { return '<button class="chip" data-action="alert" data-v="' + o + '" aria-pressed="' + (S.settings.alert === o) + '">' + alertLabel[o] + '</button>'; }).join('') + '</div>' +
      (navigator.vibrate ? '' : '<p class="note">' + t('vibe_unsupported') + '</p>') +
      voiceHtml +
      '<h3>' + t('volume') + '</h3><input type="range" id="vol" min="0.1" max="1" step="0.05" value="' + S.settings.volume + '">' +
      '<h3>' + t('sounds') + '</h3>' + rows +
      '<h3>' + t('retention') + '</h3><select id="ret">' + ret + '</select>' +
      '<div class="mt2"></div><details><summary>' + t('guide_title') + '</summary>' + guide + '</details>' +
      '<p class="muted mt2">' + t('privacy') + '</p>';
  }

  function renderNav() {
    var show = ['home', 'plan', 'records', 'settings'].indexOf(S.view) >= 0;
    if (!show) { $nav.innerHTML = ''; return; }
    var cur = S.view === 'plan' ? 'home' : S.view;
    $nav.innerHTML = [['home', 'tab_new'], ['records', 'tab_records'], ['settings', 'tab_settings']].map(function (x) {
      return '<button data-action="tab" data-v="' + x[0] + '"' + (cur === x[0] ? ' aria-current="page"' : '') + '>' + t(x[1]) + '</button>';
    }).join('');
  }

  function render() {
    var lang = S.settings.lang;
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('app_title');
    var v = S.view, html = '';
    if (v === 'home') html = viewHome();
    else if (v === 'plan') html = viewPlan();
    else if (v === 'prep') html = viewPrep();
    else if (v === 'session') html = viewSession();
    else if (v === 'done') html = viewDone();
    else if (v === 'records') html = viewRecords();
    else if (v === 'settings') html = viewSettings();
    $app.className = ['prep', 'session', 'done'].indexOf(v) >= 0 ? 'no-nav' : '';
    $app.innerHTML = html;
    renderNav();
    updateLive();
    if (v === 'prep' || v === 'session') { if (!('wakeLock' in navigator) && !render._warned) { render._warned = true; toast(t('wake_missing')); } }
  }
  function keepScroll() { var y = window.scrollY; render(); window.scrollTo(0, y); }
  function reveal(sel) { var e = document.querySelector(sel); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'center' }); }

  function setText(id, s) { var e = document.getElementById(id); if (e && e.textContent !== s) e.textContent = s; }
  function refreshClocks() {
    var base = planBase(), els = document.querySelectorAll('[data-clk]');
    for (var i = 0; i < els.length; i++) {
      var s = clockStr(base + Number(els[i].getAttribute('data-clk')) * 1000);
      if (els[i].textContent !== s) els[i].textContent = s;
    }
  }
  function updateLive() {
    if (S.view === 'prep' && S.prep) setText('prep-time', fmt(S.prep.rem));
    if (S.view === 'plan' && S.plan) {
      var now = Date.now();
      setText('plan-clock', clockStr(now, true));
      var minute = Math.floor(now / 60000);
      if (updateLive._min !== minute) { updateLive._min = minute; refreshClocks(); }
    }
    if (S.view === 'session' && S.session) {
      var st = S.session, cur = st.steps[st.idx];
      setText('cur-time', fmt(Math.ceil(st.rem)));
      var ring = document.getElementById('ring');
      if (ring) { var f = cur.dur > 0 ? Math.max(0, Math.min(1, st.rem / cur.dur)) : 0; ring.style.strokeDashoffset = (CIRC * (1 - f)).toFixed(1); }
      var tr = MP.totalRemaining(st); setText('tot-rem', fmtH(Math.ceil(tr)));
      var elapsed = st.total - tr, segs = document.querySelectorAll('.seg');
      for (var i = 0; i < segs.length; i++) {
        var s = parseFloat(segs[i].getAttribute('data-s')), e = parseFloat(segs[i].getAttribute('data-e'));
        var p = e > s ? Math.max(0, Math.min(1, (elapsed - s) / (e - s))) : 1;
        segs[i].firstChild.style.width = (p * 100).toFixed(1) + '%';
      }
    }
  }

  /* ---------- timer loop ---------- */
  setInterval(function () {
    var now = Date.now(), dt = now - S.lastTick; S.lastTick = now;
    if (S.view === 'prep' && S.prep && S.prep.running && !S.prep.ready) {
      S.prep.rem -= dt / 1000;
      if (S.prep.rem <= 0) { S.prep.rem = 0; S.prep.ready = true; play(4); render(); return; }
    }
    if (S.view === 'session' && S.session) {
      var evs = MP.tick(S.session, dt);
      if (evs.length) {
        if (evs.indexOf('end') >= 0) { finishSession(true); return; }
        play(evs.indexOf('part') >= 0 ? 2 : 1);
        speakStep(S.session, evs.indexOf('part') >= 0, speakDelay());
        render(); snapshot(true); return;
      }
      snapshot(false);
    }
    updateLive();
  }, 250);

  /* ---------- extras ---------- */
  function addExtra() {
    var el = document.getElementById('ex-new'), v = el ? el.value.trim() : '';
    if (!v) return;
    S.setup.extraList.push({ id: MP.uid(), name: v, on: true });
    saveSetup(); render();
  }

  /* ---------- drag & drop (cards and movements) ---------- */
  var drag = null;
  function clearMark() { if (drag && drag.marked) { drag.marked.classList.remove('drop-before', 'drop-after', 'drop-in'); drag.marked = null; } }
  function dragHit(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return null;
    var pg = el.closest('.pgroup');
    if (!pg) return null;
    var gid = pg.getAttribute('data-gid'), r, after;
    if (drag.kind === 'g') {
      if (gid === drag.id) return null;
      r = pg.getBoundingClientRect(); after = y > r.top + r.height / 2;
      return { el: pg, cls: after ? 'drop-after' : 'drop-before', gid: gid, after: after };
    }
    var row = el.closest('.mrow');
    if (row) {
      var mid = row.getAttribute('data-mid');
      if (mid === drag.id) return null;
      r = row.getBoundingClientRect(); after = y > r.top + r.height / 2;
      return { el: row, cls: after ? 'drop-after' : 'drop-before', gid: gid, mid: mid, after: after };
    }
    if (el.closest('.pg-h')) return { el: el.closest('.pg-h'), cls: 'drop-after', gid: gid, start: true };
    return { el: pg, cls: 'drop-in', gid: gid };
  }
  function endDrag(apply) {
    if (!drag) return;
    clearInterval(drag.timer); clearMark();
    if (drag.el) drag.el.classList.remove('dragging');
    var d = drag, h = drag.hit; drag = null;
    if (!apply || !h || !S.plan) return;
    var i, ok = false, loc;
    if (d.kind === 'g') {
      var before = h.gid;
      if (h.after) { for (i = 0; i < S.plan.length; i++) if (S.plan[i].id === h.gid) before = S.plan[i + 1] ? S.plan[i + 1].id : null; }
      ok = MP.relocateGroup(S.plan, d.id, before);
    } else {
      loc = MP.locate(S.plan, h.gid);
      if (!loc) return;
      var bm = null, ms = loc.g.moves;
      if (h.mid) {
        bm = h.mid;
        if (h.after) { for (i = 0; i < ms.length; i++) if (ms[i].id === h.mid) bm = ms[i + 1] ? ms[i + 1].id : null; }
      } else if (h.start) bm = ms.length ? ms[0].id : null;
      ok = MP.relocateMove(S.plan, d.id, h.gid, bm);
    }
    if (ok) { render(); reveal(d.kind === 'g' ? '[data-gid="' + d.id + '"]' : '[data-mid="' + d.id + '"]'); }
  }
  document.addEventListener('pointerdown', function (ev) {
    var grip = ev.target.closest && ev.target.closest('[data-drag]');
    if (!grip || S.view !== 'plan' || drag) return;
    ev.preventDefault();
    var spec = grip.getAttribute('data-drag').split(':');
    var el = document.querySelector(spec[0] === 'g' ? '.pgroup[data-gid="' + spec[1] + '"]' : '.mrow[data-mid="' + spec[1] + '"]');
    drag = { kind: spec[0], id: spec[1], pid: ev.pointerId, x: ev.clientX, y: ev.clientY, el: el, hit: null, marked: null };
    if (el) el.classList.add('dragging');
    try { grip.setPointerCapture(ev.pointerId); } catch (e) {}
    drag.timer = setInterval(function () {
      if (!drag) return;
      if (drag.y < 90) window.scrollBy(0, -14); else if (drag.y > window.innerHeight - 90) window.scrollBy(0, 14);
    }, 30);
  });
  document.addEventListener('pointermove', function (ev) {
    if (!drag || ev.pointerId !== drag.pid) return;
    ev.preventDefault();
    drag.x = ev.clientX; drag.y = ev.clientY;
    var h = dragHit(drag.x, drag.y);
    clearMark();
    drag.hit = h;
    if (h) { h.el.classList.add(h.cls); drag.marked = h.el; }
  });
  document.addEventListener('pointerup', function (ev) { if (drag && ev.pointerId === drag.pid) endDrag(true); });
  document.addEventListener('pointercancel', function (ev) { if (drag && ev.pointerId === drag.pid) endDrag(false); });

  /* ---------- events ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); res(); } catch (e) { rej(e); } document.body.removeChild(ta);
    });
  }
  function recordText(r) {
    var st = r.start || r.ts, lines = [t('client_name') + ': ' + (r.name || '—'), fmtDay(st),
      t('rec_start') + ': ' + clockStr(st) + '   ' + t('rec_end') + ': ' + (r.end ? clockStr(r.end) : '—'), recordMeta(r)];
    if (r.notes) lines.push(t('notes') + ': ' + r.notes);
    if (r.plan && r.plan.length) {
      lines.push('');
      r.plan.forEach(function (g) { lines.push(g.g); g.m.forEach(function (x) { lines.push('  - ' + x[0] + ' ' + fmt(x[1])); }); });
    }
    return lines.join('\n');
  }
  function targetOf(id) { var it = S.plan && MP.locate(S.plan, id); return it ? (it.m || it.g) : null; }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    ensureAudio();
    var a = el.getAttribute('data-action'), d = el.dataset, x, r, it;
    switch (a) {
      case 'tab': S.view = d.v; S.editing = null; if (d.v === 'home') S.plan = null; render(); break;
      case 'set': S.setup[d.k] = d.v; saveSetup(); render(); break;
      case 'toggle-extra':
        x = S.setup.extraList.filter(function (e) { return e.id === d.id; })[0];
        if (x) { x.on = !x.on; saveSetup(); render(); } break;
      case 'del-extra': S.setup.extraList = S.setup.extraList.filter(function (e) { return e.id !== d.id; }); saveSetup(); render(); break;
      case 'add-extra': addExtra(); break;
      case 'reset-extras':
        DEFAULT_EXTRAS.slice().reverse().forEach(function (k) {
          if (!S.setup.extraList.some(function (e) { return e.id === k; })) S.setup.extraList.unshift({ id: k, name: '', on: false });
        });
        saveSetup(); render(); break;
      case 'to-home': S.view = 'home'; render(); break;
      case 'to-plan':
        if (S.setup.duration < MIN_DUR) { toast(t('err_duration')); break; }
        var flags = {}, customs = [];
        S.setup.extraList.forEach(function (e) {
          if (!e.on) return;
          if (DEFAULT_EXTRAS.indexOf(e.id) >= 0) flags[e.id] = true; else customs.push(e.name);
        });
        S.plan = MP.buildPlan({ duration: S.setup.duration, area: S.setup.area, direction: S.setup.direction, extras: flags, customExtras: customs });
        S.editing = null; S.view = 'plan'; window.scrollTo(0, 0); render();
        if (MP.sumDur(S.plan) > S.setup.duration * 60) toast(t('too_short_plan').replace('{n}', Math.ceil(MP.sumDur(S.plan) / 60)));
        break;

      /* plan editing */
      case 'edit': S.editing = S.editing === d.id ? null : d.id; keepScroll(); break;
      case 'edit-close': S.editing = null; keepScroll(); break;
      case 'plan-adj':
        if (!MP.adjustPlanStep(S.plan, d.id, Number(d.d), S.lockTotal)) toast(t('cant_adjust'));
        keepScroll(); break;
      case 'add-move':
        x = MP.addMove(S.plan, d.id, 60, S.lockTotal);
        if (x) { S.editing = x.id; render(); reveal('[data-mid="' + x.id + '"]'); } break;
      case 'add-group':
        x = MP.addGroup(S.plan, 120, S.lockTotal);
        S.editing = x.id; render(); reveal('[data-gid="' + x.id + '"]'); break;
      case 'del-group':
        if (window.confirm(t('confirm_del_card'))) { MP.removeGroup(S.plan, d.id, S.lockTotal); S.editing = null; keepScroll(); } break;
      case 'del-move': MP.removeMove(S.plan, d.id, S.lockTotal); S.editing = null; keepScroll(); break;
      case 'g-up': case 'g-down':
        if (MP.moveGroupBy(S.plan, d.id, a === 'g-up' ? -1 : 1)) { render(); reveal('[data-gid="' + d.id + '"]'); } break;
      case 'm-up': case 'm-down':
        if (MP.moveMoveBy(S.plan, d.id, a === 'm-up' ? -1 : 1)) { render(); reveal('[data-mid="' + d.id + '"]'); } break;
      case 'set-color': x = targetOf(d.id); if (x) { x.color = d.c; keepScroll(); } break;
      case 'pick-img': S.imgTarget = d.id; $img.value = ''; $img.click(); break;
      case 'rm-img': x = targetOf(d.id); if (x) { dropImg(x.img); x.img = ''; keepScroll(); } break;
      case 'toggle-lock': S.lockTotal = !S.lockTotal; keepScroll(); break;
      case 'skipmode': S.setup.skipMode = d.v === 'share' ? 'share' : 'drop'; saveSetup(); keepScroll(); break;
      case 'toggle-planprep': S.planPrep = !S.planPrep; keepScroll(); break;
      case 'zoom': el.classList.toggle('zoom'); break;

      case 'to-prep':
        if (!planOk()) { toast(t('no_moves')); break; }
        S.prep = newPrep(); S.lastTick = Date.now(); S.view = 'prep'; lockScreen(); window.scrollTo(0, 0); render(); break;
      case 'skip-prep': S.prep = newPrep(); startSession(); break;
      case 'cancel-prep': S.prep = null; unlockScreen(); S.view = 'plan'; render(); break;
      case 'prep-toggle': S.prep.running = !S.prep.running; render(); break;
      case 'prep-add': S.prep.rem += 30; S.prep.ready = false; render(); break;
      case 'start-session': startSession(); break;
      case 'toggle-run': S.session.running = !S.session.running; S.lastTick = Date.now(); snapshot(true); render(); break;
      case 'adj':
        if (!MP.adjustCurrent(S.session, Number(d.d))) toast(t('cant_adjust')); else snapshot(true);
        render(); break;
      case 'skip':
        var e2 = MP.skipCurrent(S.session);
        if (e2 === 'end') { finishSession(true); break; }
        play(e2 === 'part' ? 2 : 1); speakStep(S.session, e2 === 'part', speakDelay()); snapshot(true); render(); break;
      case 'end': if (window.confirm(t('confirm_end'))) finishSession(false); break;
      case 'restore': restoreSession(); break;
      case 'discard': S.pending = null; LS.del('mp.session'); render(); break;

      /* records */
      case 'to-records': S.view = 'records'; S.openRec = null; S.recEdit = false; render(); break;
      case 'toggle-rec':
        S.openRec = S.openRec === d.id ? null : d.id; S.recEdit = false; render();
        if (S.openRec) reveal('[data-rid="' + d.id + '"]'); break;
      case 'edit-rec': S.recEdit = true; render(); break;
      case 'cancel-rec': S.recEdit = false; render(); break;
      case 'save-rec': saveRec(); break;
      case 'copy-rec':
        r = findRec(d.id);
        if (r) copyText(recordText(r)).then(function () { toast(t('copied')); }, function () {}); break;
      case 'del-rec': records = records.filter(function (q) { return q.id !== d.id; }); if (S.openRec === d.id) { S.openRec = null; S.recEdit = false; } saveRecords(); render(); break;
      case 'del-all': if (window.confirm(t('confirm_delete_all'))) { records = []; S.openRec = null; saveRecords(); render(); } break;

      /* settings */
      case 'lang': S.settings.lang = d.v; saveSettings(); render(); break;
      case 'tz': S.settings.tz = d.v; saveSettings(); render(); break;
      case 'toggle-voice':
        S.settings.voice = !S.settings.voice; saveSettings(); render();
        if (S.settings.voice) speak(t('voice_sample'), 0, true); break;
      case 'test-voice': speak(t('voice_sample'), 0, true); break;
      case 'alert': S.settings.alert = d.v; saveSettings(); render(); break;
      case 'test': play(Number(d.n)); break;
      case 'pick': S.pickSlot = Number(d.n); $file.value = ''; $file.click(); break;
      case 'reset-sound':
        var n = Number(d.n); DB.del('s' + n).catch(function () {}); delete A.buffers[n]; S.soundNames[n] = null; render(); break;
    }
  });

  function readDur() {
    var h = parseInt(document.getElementById('dur-h').value, 10) || 0, m = parseInt(document.getElementById('dur-m').value, 10) || 0;
    S.setup.duration = Math.min(MAX_DUR, Math.max(0, h * 60 + m)); saveSetup();
    setText('dur-total', durText(S.setup.duration));
    var sm = document.getElementById('sum'); if (sm) sm.innerHTML = summaryText();
  }

  document.addEventListener('input', function (ev) {
    var el = ev.target, id = el.id;
    if (el.hasAttribute && el.hasAttribute('data-edit') && S.plan) {
      var kind = el.getAttribute('data-edit'), eid = el.getAttribute('data-id'), it = eid && MP.locate(S.plan, eid);
      if (!it) return;
      if (kind === 'g-title') it.g.title = el.value;
      else if (kind === 'm-name' && it.m) it.m.name = el.value;
      else return;
      var lab = document.querySelector('[data-tt="' + eid + '"]');
      if (lab) lab.textContent = it.m ? mLabel(it.m) : gLabel(it.g);
      return;
    }
    if (id === 'c-name' && S.prep) S.prep.name = el.value;
    else if (id === 'c-notes' && S.prep) S.prep.notes = el.value;
    else if (id === 'vol') { S.settings.volume = Number(el.value); saveSettings(); }
    else if ((id === 'dur-h' || id === 'dur-m') && S.view === 'home') readDur();
    else if (el.hasAttribute && el.hasAttribute('data-check') && S.prep) S.prep.checks[Number(el.getAttribute('data-check'))] = el.checked;
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target, id = el.id;
    if (id === 'ret') { S.settings.retention = Number(el.value); saveSettings(); purge(); }
    else if ((id === 'dur-h' || id === 'dur-m') && S.view === 'home') {
      readDur();
      document.getElementById('dur-h').value = Math.floor(S.setup.duration / 60);
      document.getElementById('dur-m').value = S.setup.duration % 60;
    } else if ((id === 'md-m' || id === 'md-s') && S.plan) {
      var it = MP.locate(S.plan, S.editing);
      if (!it || !it.m) return;
      var mm = Math.max(0, parseInt(document.getElementById('md-m').value, 10) || 0), ss = Math.max(0, parseInt(document.getElementById('md-s').value, 10) || 0);
      var nd = mm * 60 + ss;
      if (nd < MP.MIN_STEP) toast(t('cant_adjust'));
      else if (nd !== Math.round(it.m.dur) && !MP.adjustPlanStep(S.plan, it.m.id, nd - Math.round(it.m.dur), S.lockTotal)) toast(t('cant_adjust'));
      keepScroll();
    } else if (el.getAttribute && el.getAttribute('data-edit') === 'm-to' && S.plan) {
      if (MP.relocateMove(S.plan, S.editing, el.value, null)) { render(); reveal('[data-mid="' + S.editing + '"]'); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'ex-new') { ev.preventDefault(); addExtra(); }
    else if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.classList && ev.target.classList.contains('rec-head')) { ev.preventDefault(); ev.target.click(); }
  });
  document.addEventListener('pointerup', function (ev) { if (ev.target && ev.target.id === 'vol') play(1); });

  $file.addEventListener('change', function () {
    var f = $file.files && $file.files[0], n = S.pickSlot;
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast(t('too_big')); return; }
    ensureAudio();
    var reader = new FileReader();
    reader.onload = function () {
      var ab = reader.result;
      decode(ab.slice(0)).then(function (buf) {
        A.buffers[n] = buf; S.soundNames[n] = f.name;
        DB.set('s' + n, { name: f.name, data: ab }).catch(function () {});
        render(); play(n);
      }).catch(function () { toast(t('bad_audio')); });
    };
    reader.readAsArrayBuffer(f);
  });

  $img.addEventListener('change', function () {
    var f = $img.files && $img.files[0], id = S.imgTarget;
    if (!f || !id || !S.plan) return;
    if (f.size > 15 * 1024 * 1024) { toast(t('too_big_img')); return; }
    processImage(f, function (data) {
      if (!data) { toast(t('bad_img')); return; }
      var tgt = targetOf(id);
      if (!tgt) return;
      var nid = MP.uid();
      if (tgt.img) dropImg(tgt.img);
      IMG[nid] = data; tgt.img = nid;
      DB.set('img:' + nid, data).catch(function () {});
      keepScroll();
    });
  });

  /* ---------- start ---------- */
  purge();
  setInterval(purge, 60000);
  loadPending();
  render();
  loadSounds();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
