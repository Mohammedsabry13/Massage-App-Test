/* plan.js — pure scheduling logic (no DOM). Works in the browser (window.MP) and in Node (module.exports).
 *
 * The plan is a list of GROUPS (cards). Each group holds MOVES:
 *   group = { id, part, kind: 'part'|'turn'|'custom', title, color, img, moves: [] }
 *   move  = { id, key, name, dur, color, img }
 * `key` / `part` point to the built-in translated names; `name` / `title` override them with the user's own text.
 * For the live session the groups are flattened into steps (see flatten()).
 */
(function (root) {
  'use strict';

  var TURN_SECONDS = 60;   // time to ask the client to turn over (counted inside the session)
  var MIN_STEP = 10;       // no movement is ever shrunk below this many seconds
  var ROUND_TO = 5;        // generated durations are rounded to 5 s
  var CUSTOM_WEIGHT = 4;   // share of a custom extra (same as the abdomen)

  // weight = share of the whole session; moves = [nameKey, relativeWeight]
  var PARTS = {
    legBackL:   { weight: 8.5, moves: [['m_leg_warm', 1], ['m_hamstrings', 2.5], ['m_calf', 2.5], ['m_heel', 1]] },
    legBackR:   { weight: 8.5, moves: [['m_leg_warm', 1], ['m_hamstrings', 2.5], ['m_calf', 2.5], ['m_heel', 1]] },
    backL:      { weight: 14,  moves: [['m_back_warm', 1.5], ['m_lumbar', 2], ['m_erector', 2.5], ['m_scapula', 2], ['m_lats', 1.5]] },
    backR:      { weight: 14,  moves: [['m_back_warm', 1.5], ['m_lumbar', 2], ['m_erector', 2.5], ['m_scapula', 2], ['m_lats', 1.5]] },
    neckBack:   { weight: 5,   moves: [['m_shoulders', 2], ['m_neck_back', 2], ['m_suboccipital', 1]] },
    lowerBackL: { weight: 5,   moves: [['m_back_warm', 1], ['m_lumbar', 2.5], ['m_hip', 1.5]] },
    lowerBackR: { weight: 5,   moves: [['m_back_warm', 1], ['m_lumbar', 2.5], ['m_hip', 1.5]] },
    legFrontL:  { weight: 8.5, moves: [['m_leg_warm', 1], ['m_quads', 2.5], ['m_shin', 1.5], ['m_foot', 2]] },
    legFrontR:  { weight: 8.5, moves: [['m_leg_warm', 1], ['m_quads', 2.5], ['m_shin', 1.5], ['m_foot', 2]] },
    abdomen:    { weight: 4,   moves: [['m_abdomen', 1]] },
    armL:       { weight: 8.5, moves: [['m_arm_warm', 1], ['m_upper_arm', 2], ['m_forearm', 2], ['m_hand', 1.5]] },
    armR:       { weight: 8.5, moves: [['m_arm_warm', 1], ['m_upper_arm', 2], ['m_forearm', 2], ['m_hand', 1.5]] },
    neckHead:   { weight: 8,   moves: [['m_neck_front', 2], ['m_shoulders_front', 1.5], ['m_scalp', 2]] }
  };

  var _n = 0;
  function uid() {
    _n += 1;
    return 'i' + Date.now().toString(36) + _n.toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  // Order always goes LEFT first, then RIGHT.
  function sequences(area, extras) {
    extras = extras || {};
    var back, front;
    if (area === 'full') {
      back = ['legBackL', 'legBackR', 'backL', 'backR', 'neckBack'];
      front = ['legFrontL', 'legFrontR'];
      if (extras.abdomen) front.push('abdomen');
      front = front.concat(['armL', 'armR', 'neckHead']);
    } else if (area === 'upper') {
      back = ['backL', 'backR', 'neckBack'];
      front = ['armL', 'armR', 'neckHead'];
    } else { // lower
      back = ['legBackL', 'legBackR', 'lowerBackL', 'lowerBackR'];
      front = ['legFrontL', 'legFrontR'];
      if (extras.abdomen) front.push('abdomen');
    }
    return { back: back, front: front };
  }

  function movesFor(part, extras) {
    var moves = PARTS[part].moves.map(function (m) { return [m[0], m[1]]; });
    if (part === 'neckHead') {
      extras = extras || {};
      if (extras.chest) moves.splice(2, 0, ['m_chest', 1.5]);
      if (extras.face) moves.push(['m_face', 2]);
    }
    return moves;
  }

  function roundTo(x, n) { return Math.round(x / n) * n; }

  function makeMove(key, name, dur) { return { id: uid(), key: key || '', name: name || '', dur: dur, color: '', img: '' }; }
  function makeGroup(part, kind, title, moves) { return { id: uid(), part: part, kind: kind, title: title || '', color: '', img: '', moves: moves }; }

  function eachMove(groups, fn) {
    for (var i = 0; i < groups.length; i++) for (var j = 0; j < groups[i].moves.length; j++) fn(groups[i].moves[j], groups[i]);
  }
  function groupSum(g) { var s = 0; for (var i = 0; i < g.moves.length; i++) s += g.moves[i].dur; return s; }
  function sumDur(groups) { var s = 0; for (var i = 0; i < groups.length; i++) s += groupSum(groups[i]); return s; }
  function sumSteps(steps) { var s = 0; for (var i = 0; i < steps.length; i++) s += steps[i].dur; return s; }

  function locate(groups, id) {
    for (var gi = 0; gi < groups.length; gi++) {
      if (groups[gi].id === id) return { g: groups[gi], m: null, gi: gi, mi: -1 };
      for (var mi = 0; mi < groups[gi].moves.length; mi++) {
        if (groups[gi].moves[mi].id === id) return { g: groups[gi], m: groups[gi].moves[mi], gi: gi, mi: mi };
      }
    }
    return null;
  }

  // Make every duration a whole number of seconds and force the total to match exactly.
  // A surplus is taken from the longest movements first (never below MIN_STEP); a shortage goes to the longest one.
  function normalize(groups, total) {
    var sum = 0, movable = [];
    eachMove(groups, function (m, g) {
      m.dur = Math.max(MIN_STEP, Math.round(m.dur));
      sum += m.dur;
      if (g.kind !== 'turn') movable.push(m);
    });
    var diff = total - sum, i, best;
    if (!movable.length || diff === 0) return groups;
    if (diff > 0) {
      best = movable[0];
      for (i = 1; i < movable.length; i++) if (movable[i].dur > best.dur) best = movable[i];
      best.dur += diff;
      return groups;
    }
    var guard = 0;
    while (diff < 0 && guard++ < 10000) {
      best = null;
      for (i = 0; i < movable.length; i++) if (movable[i].dur > MIN_STEP && (!best || movable[i].dur > best.dur)) best = movable[i];
      if (!best) break;
      var take = Math.min(-diff, best.dur - MIN_STEP, Math.max(1, Math.ceil(-diff / 40)));
      best.dur -= take; diff += take;
    }
    return groups;
  }

  // Scale every flexible movement so the whole plan sums to `total`. Turn steps and `keepId` stay fixed.
  function fitTotal(groups, total, keepId) {
    var fixed = 0, flex = [], sum = 0;
    eachMove(groups, function (m, g) {
      if (g.kind === 'turn' || m.id === keepId) fixed += m.dur; else { flex.push(m); sum += m.dur; }
    });
    if (!flex.length || sum <= 0) return groups;
    var factor = Math.max(0.01, (total - fixed) / sum);
    for (var i = 0; i < flex.length; i++) flex[i].dur *= factor;
    return normalize(groups, total);
  }

  // opts: { duration (minutes), area, direction, extras: {abdomen, chest, face}, customExtras: [names] }
  function buildPlan(opts) {
    var total = Math.round(opts.duration * 60);
    var seq = sequences(opts.area, opts.extras);
    var order = [], i, j;
    if (opts.direction === 'back' || opts.direction === 'both') order = order.concat(seq.back);
    var hasTurn = opts.direction === 'both';
    if (opts.direction === 'front' || opts.direction === 'both') order = order.concat(seq.front);

    var items = order.map(function (p) { return { part: p, weight: PARTS[p].weight }; });
    (opts.customExtras || []).forEach(function (n) {
      n = String(n == null ? '' : n).trim();
      if (n) items.push({ part: 'custom', name: n, weight: CUSTOM_WEIGHT });
    });

    var avail = total - (hasTurn ? TURN_SECONDS : 0);
    var weightSum = 0;
    for (i = 0; i < items.length; i++) weightSum += items[i].weight;

    var groups = [];
    var firstFrontIndex = hasTurn ? seq.back.length : -1;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (i === firstFrontIndex) groups.push(makeGroup('turn', 'turn', '', [makeMove('m_turn', '', TURN_SECONDS)]));
      var partSec = avail * it.weight / weightSum;
      if (it.part === 'custom') {
        groups.push(makeGroup('custom', 'custom', it.name, [makeMove('', it.name, roundTo(partSec, ROUND_TO))]));
        continue;
      }
      var moves = movesFor(it.part, opts.extras), wSum = 0, list = [];
      for (j = 0; j < moves.length; j++) wSum += moves[j][1];
      for (j = 0; j < moves.length; j++) list.push(makeMove(moves[j][0], '', roundTo(partSec * moves[j][1] / wSum, ROUND_TO)));
      groups.push(makeGroup(it.part, 'part', '', list));
    }
    normalize(groups, total);
    return groups;
  }

  // Shortest hands-on movement, in seconds (turn steps excluded).
  function shortest(groups) {
    var m = Infinity;
    eachMove(groups, function (mv, g) { if (g.kind !== 'turn' && mv.dur < m) m = mv.dur; });
    return m;
  }

  // ---- Editing the plan BEFORE the session ----
  // Change one movement by `delta` seconds. lock=true: the others absorb the difference (total stays). lock=false: total changes.
  function adjustPlanStep(groups, moveId, delta, lock) {
    var target = null, others = [], sum = 0, minOther = Infinity, total = sumDur(groups);
    eachMove(groups, function (m, g) {
      if (m.id === moveId) { target = m; return; }
      if (g.kind !== 'turn') { others.push(m); sum += m.dur; if (m.dur < minOther) minOther = m.dur; }
    });
    if (!target) return false;
    delta = Math.round(delta);
    if (delta < 0) {
      delta = -Math.min(-delta, target.dur - MIN_STEP);
      if (delta > -1) return false;
    } else {
      if (delta < 1) return false;
      if (lock) {
        var maxTake = minOther > MIN_STEP ? sum * (1 - MIN_STEP / minOther) : 0;
        delta = Math.floor(Math.min(delta, maxTake));
        if (delta < 1) return false;
      }
    }
    if (!lock) { target.dur += delta; return true; }
    if (!others.length || sum <= 0) return false;
    var factor = (sum - delta) / sum;
    target.dur += delta;
    for (var i = 0; i < others.length; i++) others[i].dur *= factor;
    normalize(groups, total);
    return true;
  }

  function addMove(groups, gid, dur, lock) {
    var loc = locate(groups, gid);
    if (!loc || loc.m) return null;
    var total = sumDur(groups), m = makeMove('', '', dur);
    loc.g.moves.push(m);
    if (lock) fitTotal(groups, total, m.id);
    return m;
  }

  function addGroup(groups, dur, lock) {
    var total = sumDur(groups), m = makeMove('', '', dur), g = makeGroup('custom', 'custom', '', [m]);
    groups.push(g);
    if (lock) fitTotal(groups, total, m.id);
    return g;
  }

  function removeMove(groups, mid, lock) {
    var loc = locate(groups, mid);
    if (!loc || !loc.m) return false;
    var total = sumDur(groups);
    loc.g.moves.splice(loc.mi, 1);
    if (lock) fitTotal(groups, total, null);
    return true;
  }

  function removeGroup(groups, gid, lock) {
    var loc = locate(groups, gid);
    if (!loc || loc.m) return false;
    var total = sumDur(groups);
    groups.splice(loc.gi, 1);
    if (lock) fitTotal(groups, total, null);
    return true;
  }

  function moveGroupBy(groups, gid, dir) {
    var loc = locate(groups, gid);
    if (!loc || loc.m) return false;
    var j = loc.gi + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= groups.length) return false;
    var tmp = groups[j]; groups[j] = groups[loc.gi]; groups[loc.gi] = tmp;
    return true;
  }

  // Up/down inside a card; at the edge the movement jumps into the neighbouring card.
  function moveMoveBy(groups, mid, dir) {
    var loc = locate(groups, mid);
    if (!loc || !loc.m) return false;
    var ms = loc.g.moves, mv = loc.m, tmp;
    if (dir < 0) {
      if (loc.mi > 0) { tmp = ms[loc.mi - 1]; ms[loc.mi - 1] = mv; ms[loc.mi] = tmp; return true; }
      if (loc.gi > 0) { ms.splice(0, 1); groups[loc.gi - 1].moves.push(mv); return true; }
      return false;
    }
    if (loc.mi < ms.length - 1) { tmp = ms[loc.mi + 1]; ms[loc.mi + 1] = mv; ms[loc.mi] = tmp; return true; }
    if (loc.gi < groups.length - 1) { ms.splice(loc.mi, 1); groups[loc.gi + 1].moves.unshift(mv); return true; }
    return false;
  }

  // Put a card before another card (beforeGid null = at the end).
  function relocateGroup(groups, gid, beforeGid) {
    if (gid === beforeGid) return false;
    var loc = locate(groups, gid);
    if (!loc || loc.m) return false;
    var g = groups.splice(loc.gi, 1)[0], j = -1;
    if (beforeGid) for (var i = 0; i < groups.length; i++) if (groups[i].id === beforeGid) j = i;
    if (j < 0) groups.push(g); else groups.splice(j, 0, g);
    return true;
  }

  // Put a movement into card `toGid`, before movement `beforeMid` (null = at the end of that card).
  function relocateMove(groups, mid, toGid, beforeMid) {
    if (mid === beforeMid) return false;
    var loc = locate(groups, mid), dest = locate(groups, toGid);
    if (!loc || !loc.m || !dest || dest.m) return false;
    var mv = loc.g.moves.splice(loc.mi, 1)[0], j = -1;
    if (beforeMid) for (var i = 0; i < dest.g.moves.length; i++) if (dest.g.moves[i].id === beforeMid) j = i;
    if (j < 0) dest.g.moves.push(mv); else dest.g.moves.splice(j, 0, mv);
    return true;
  }

  // Groups -> flat list of steps used by the live timer. `part` = card id (a change of card triggers the "new area" alert).
  function flatten(groups) {
    var out = [];
    groups.forEach(function (g) {
      g.moves.forEach(function (m) {
        out.push({
          part: g.id, kind: g.kind, gkey: g.part, gtitle: g.title || '', gcolor: g.color || '', gimg: g.img || '',
          mkey: m.key || '', mname: m.name || '', mcolor: m.color || '', mimg: m.img || '', dur: m.dur
        });
      });
    });
    return out;
  }

  // ---- Live session state ----
  function createState(steps) {
    var copy = steps.map(function (s) { var c = {}, k; for (k in s) if (Object.prototype.hasOwnProperty.call(s, k)) c[k] = s[k]; return c; });
    return { steps: copy, idx: 0, rem: copy[0].dur, running: true, done: false, total: sumSteps(copy) };
  }

  function laterSum(st) { var s = 0; for (var i = st.idx + 1; i < st.steps.length; i++) s += st.steps[i].dur; return s; }

  function totalRemaining(st) { return st.done ? 0 : st.rem + laterSum(st); }

  function eventAfter(st) {
    var next = st.steps[st.idx + 1];
    if (!next) return 'end';
    return next.part !== st.steps[st.idx].part ? 'part' : 'move';
  }

  // Advance the clock by dtMs. Returns the list of events that happened: 'move' | 'part' | 'end'.
  function tick(st, dtMs) {
    var events = [];
    if (!st.running || st.done) return events;
    st.rem -= dtMs / 1000;
    while (st.rem <= 0 && !st.done) {
      var over = -st.rem;
      var ev = eventAfter(st);
      events.push(ev);
      if (ev === 'end') { st.done = true; st.rem = 0; st.running = false; }
      else { st.idx += 1; st.rem = st.steps[st.idx].dur - over; }
    }
    return events;
  }

  // Add/remove time on the current movement; later movements give or take proportionally.
  function adjustCurrent(st, delta) {
    var n = st.steps.length - st.idx - 1;
    if (n <= 0 || st.done) return false;
    var later = laterSum(st), minLater = Infinity, i;
    for (i = st.idx + 1; i < st.steps.length; i++) if (st.steps[i].dur < minLater) minLater = st.steps[i].dur;
    if (delta > 0) {
      var maxTake = minLater > MIN_STEP ? later * (1 - MIN_STEP / minLater) : 0;
      delta = Math.min(delta, maxTake);
      if (delta < 1) return false;
    } else {
      delta = -Math.min(-delta, st.rem - MIN_STEP);
      if (delta > -1) return false;
    }
    var factor = (later - delta) / later;
    st.rem += delta;
    st.steps[st.idx].dur += delta;
    for (i = st.idx + 1; i < st.steps.length; i++) st.steps[i].dur *= factor;
    return true;
  }

  // Skip to the next movement now.
  // st.skipMode === 'drop': the unused time is simply dropped (the session ends earlier).
  // otherwise ('share'): the unused time is shared among the remaining movements (total stays the same).
  function skipCurrent(st) {
    if (st.done) return null;
    var ev = eventAfter(st);
    if (ev === 'end') { st.done = true; st.rem = 0; st.running = false; return ev; }
    if (st.skipMode === 'drop') {
      st.steps[st.idx].dur -= st.rem;
      st.total -= st.rem;
    } else {
      var later = laterSum(st), factor = (later + st.rem) / later, i;
      for (i = st.idx + 1; i < st.steps.length; i++) st.steps[i].dur *= factor;
      st.steps[st.idx].dur -= st.rem;
    }
    st.idx += 1;
    st.rem = st.steps[st.idx].dur;
    return ev;
  }

  var api = {
    TURN_SECONDS: TURN_SECONDS, MIN_STEP: MIN_STEP, PARTS: PARTS, uid: uid,
    buildPlan: buildPlan, shortest: shortest, sumDur: sumDur, groupSum: groupSum, locate: locate,
    adjustPlanStep: adjustPlanStep, addMove: addMove, addGroup: addGroup, removeMove: removeMove, removeGroup: removeGroup,
    moveGroupBy: moveGroupBy, moveMoveBy: moveMoveBy, relocateGroup: relocateGroup, relocateMove: relocateMove,
    flatten: flatten, createState: createState, tick: tick, adjustCurrent: adjustCurrent, skipCurrent: skipCurrent,
    totalRemaining: totalRemaining
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MP = api;
})(typeof window !== 'undefined' ? window : this);
