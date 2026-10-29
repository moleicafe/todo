/* Priority learning and time parsing for the To-Do app.
   Runs entirely on the device. No API calls.
   Priorities: 3 = High, 2 = Medium, 1 = Low. */
(function (root) {
  'use strict';

  const STOP = new Set(['a', 'an', 'the', 'for', 'to', 'of', 'on', 'at', 'in', 'and', 'with',
    'from', 'by', 'my', 'is', 'be', 'pls', 'please', 're', 'about', 'today', 'tomorrow', 'tmr', 'tmrw',
    'am', 'pm', 'mr', 'ms', 'mrs']);
  const PRI = [1, 2, 3];
  const MIN_TRAINED = 5;        // tasks needed before suggestions start
  const MIN_CONFIDENCE = 0.55;  // below this, no suggestion is shown
  const HALF_LIFE_DAYS = 90;    // older choices count less
  const ALPHA = 0.1;            // smoothing; small so rare words still count

  /** Words that describe the kind of task. Numbers, order IDs and times are dropped. */
  function tokens(title) {
    const t = String(title || '').toLowerCase()
      .replace(/\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ');
    return t.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w) && !/\d/.test(w));
  }

  /** Features: single words, word pairs, and the opening action words (weighted more). */
  function features(title) {
    const tk = tokens(title);
    const f = tk.map(w => 'w:' + w);
    for (let i = 0; i < tk.length - 1; i++) f.push('b:' + tk[i] + '_' + tk[i + 1]);
    if (tk.length) {
      f.push('l1:' + tk[0], 'l1:' + tk[0]);
      if (tk.length > 1) { const l2 = 'l2:' + tk[0] + '_' + tk[1]; f.push(l2, l2, l2); }
    }
    return f;
  }

  /** Train a weighted Naive Bayes model from past tasks (each needs title, priority, created_at). */
  function train(tasks, now) {
    now = now || Date.now();
    const m = { count: { 1: 0, 2: 0, 3: 0 }, feat: { 1: {}, 2: {}, 3: {} }, total: { 1: 0, 2: 0, 3: 0 }, vocab: new Set(), n: 0, l1: {}, l2: {} };
    for (const t of tasks || []) {
      const p = Number(t.priority);
      if (!t.title || !PRI.includes(p)) continue;
      const created = t.created_at ? new Date(t.created_at).getTime() : now;
      const ageDays = Math.max(0, (now - created) / 86400000);
      let w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      if (t.suggested && Number(t.suggested) !== p) w *= 1.5; // overrides teach faster
      m.count[p] += w;
      m.n++;
      const tk = tokens(t.title);
      if (tk.length) addLead(m.l1, tk[0], p, w);
      if (tk.length > 1) addLead(m.l2, tk[0] + '_' + tk[1], p, w);
      for (const f of features(t.title)) {
        m.feat[p][f] = (m.feat[p][f] || 0) + w;
        m.total[p] += w;
        m.vocab.add(f);
      }
    }
    return m;
  }

  function addLead(table, key, p, w) {
    const e = table[key] || (table[key] = { 1: 0, 2: 0, 3: 0, n: 0 });
    e[p] += w; e.n += 1;
  }

  /** Uses how you rated tasks that start with the same action words, if seen at least twice. */
  function fromLead(e) {
    if (!e || e.n < 2) return null;
    const z = e[1] + e[2] + e[3];
    let best = 2;
    for (const p of PRI) if (e[p] > e[best]) best = p;
    const conf = e[best] / z;
    if (conf < MIN_CONFIDENCE) return null;
    return { priority: best, confidence: conf, probs: { 1: e[1] / z, 2: e[2] / z, 3: e[3] / z } };
  }

  /** Returns { priority, confidence, probs } or null when there is not enough evidence. */
  function predict(m, title) {
    if (!m || m.n < MIN_TRAINED) return null;
    const tk = tokens(title);
    if (tk.length > 1) { const r = fromLead(m.l2[tk[0] + '_' + tk[1]]); if (r) return r; }
    if (tk.length) { const r = fromLead(m.l1[tk[0]]); if (r) return r; }
    const known = features(title).filter(f => m.vocab.has(f));
    if (!known.length) return null;
    const V = m.vocab.size;
    const sumC = m.count[1] + m.count[2] + m.count[3];
    const logs = {};
    for (const p of PRI) {
      let s = Math.log((m.count[p] + 1) / (sumC + 3));
      for (const f of known) s += Math.log(((m.feat[p][f] || 0) + ALPHA) / (m.total[p] + ALPHA * V));
      logs[p] = s;
    }
    const max = Math.max(logs[1], logs[2], logs[3]);
    const ex = {}; let z = 0;
    for (const p of PRI) { ex[p] = Math.exp(logs[p] - max); z += ex[p]; }
    const probs = {}; let best = 2;
    for (const p of PRI) { probs[p] = ex[p] / z; if (probs[p] > probs[best]) best = p; }
    if (probs[best] < MIN_CONFIDENCE) return null;
    return { priority: best, confidence: probs[best], probs };
  }

  /** Finds a due time in text like "at 3pm", "3.30pm", "by 15:30", "tomorrow 10am". */
  function parseWhen(title, nowDate) {
    const now = nowDate ? new Date(nowDate) : new Date();
    const s = String(title || '').toLowerCase();
    const tomorrow = /\b(tomorrow|tmr|tmrw)\b/.test(s);
    let h = null, min = 0;
    let m = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/);
    if (m) {
      h = Number(m[1]) % 12; min = m[2] ? Number(m[2]) : 0;
      if (m[3] === 'pm') h += 12;
    } else if ((m = s.match(/\b(?:at|by)\s+(\d{1,2})[:.](\d{2})\b/))) {
      h = Number(m[1]); min = Number(m[2]);
    }
    if (h !== null && (h > 23 || min > 59)) h = null;
    if (h === null && !tomorrow) return null;
    const d = new Date(now);
    d.setSeconds(0, 0);
    if (tomorrow) d.setDate(d.getDate() + 1);
    if (h === null) { d.setHours(23, 59, 0, 0); return d; }
    d.setHours(h, min, 0, 0);
    // A time already well past today most likely means tomorrow.
    if (!tomorrow && d.getTime() < now.getTime() - 30 * 60000) d.setDate(d.getDate() + 1);
    return d;
  }

  /** Effective priority for sorting: due within an hour or overdue moves up one level. */
  function effective(t, nowMs) {
    let p = Number(t.priority) || 2;
    if (t.due_at) {
      const mins = (new Date(t.due_at).getTime() - nowMs) / 60000;
      if (mins <= 60) p = Math.min(3, p + 1);
    }
    return p;
  }

  function compare(a, b, nowMs) {
    const ea = effective(a, nowMs), eb = effective(b, nowMs);
    if (ea !== eb) return eb - ea;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    if (da !== db) return da - db;
    return new Date(a.created_at) - new Date(b.created_at);
  }

  const api = { tokens, features, train, predict, parseWhen, effective, compare, MIN_TRAINED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Learn = api;
})(typeof self !== 'undefined' ? self : this);
