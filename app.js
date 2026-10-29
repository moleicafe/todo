/* EP To-Do: app logic. Data syncs through Supabase; priority learning runs on-device (learn.js). */
'use strict';

const SUPABASE_URL = 'https://jojbvanpvybatxvdfyux.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ZZ7VWh1mg0JdqVxj81XzPA_A0hLMvSe';

const LABEL = { 3: 'High', 2: 'Medium', 1: 'Low' };
const $ = id => document.getElementById(id);

/* ---------- local storage (never throws) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Storage write failed', e); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

/* ---------- state ---------- */
let sb = null;
let user = null;
const state = { tasks: [], daily: [], outbox: [], model: null };
let flushing = false;
let channel = null;

/* ---------- date helpers ---------- */
const pad = n => String(n).padStart(2, '0');
function toLocalInput(d) {
  if (!d) return '';
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(s) { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d; }
function todayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function fmtTime(d) { return d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' }); }
function fmtDue(iso) {
  const d = new Date(iso);
  const t0 = startOfToday();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - t0) / 86400000);
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
    : d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
  return endOfDay ? day : `${day}, ${fmtTime(d)}`;
}
function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return fmtTime(d);
}

/* ---------- toast with undo ---------- */
let toastTimer = null, toastUndo = null;
function toast(msg, undo) {
  $('toastMsg').textContent = msg;
  toastUndo = undo || null;
  $('toastUndo').classList.toggle('hidden', !undo);
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000);
}
$('toastUndo').onclick = () => { $('toast').classList.add('hidden'); if (toastUndo) toastUndo(); toastUndo = null; };

/* ---------- persistence: local cache + outbox ---------- */
function cacheKey(k) { return `todo:${user ? user.id : 'anon'}:${k}`; }
function saveLocal() {
  store.set(cacheKey('tasks'), state.tasks);
  store.set(cacheKey('daily'), state.daily);
  store.set(cacheKey('outbox'), state.outbox);
}
function loadLocal() {
  state.tasks = store.get(cacheKey('tasks'), []);
  state.daily = store.get(cacheKey('daily'), []);
  state.outbox = store.get(cacheKey('outbox'), []);
}

function queue(op) {
  // Keep only the latest write per row so the outbox stays small.
  state.outbox = state.outbox.filter(o => !(o.table === op.table && (o.row ? o.row.id : o.id) === (op.row ? op.row.id : op.id)));
  state.outbox.push(op);
  saveLocal();
  flush();
}

function isNetworkError(err) {
  return !navigator.onLine || /fetch|network|timeout|load failed/i.test(String(err && (err.message || err)));
}

async function flush() {
  if (flushing || !sb || !user || !navigator.onLine) { setSync(); return; }
  flushing = true; setSync('Syncing…');
  try {
    while (state.outbox.length) {
      const op = state.outbox[0];
      let res;
      try {
        res = op.op === 'upsert'
          ? await sb.from(op.table).upsert(op.row)
          : await sb.from(op.table).delete().eq('id', op.id);
      } catch (e) { res = { error: e }; }
      if (res.error) {
        if (isNetworkError(res.error)) break;
        console.error('Save rejected by server', res.error, op);
        toast('Could not save a change: ' + (res.error.message || 'unknown error'));
      }
      state.outbox.shift();
      saveLocal();
    }
  } finally {
    flushing = false;
    setSync();
  }
}

function setSync(text) {
  const el = $('sync');
  if (text) { el.textContent = text; return; }
  if (!navigator.onLine) el.textContent = state.outbox.length ? `Offline, ${state.outbox.length} to sync` : 'Offline';
  else el.textContent = state.outbox.length ? `${state.outbox.length} to sync` : '';
}

/** Apply unsent local changes on top of server data, so nothing flickers back. */
function applyOutbox(tasks, daily) {
  for (const o of state.outbox) {
    const arr = o.table === 'tasks' ? tasks : daily;
    const id = o.row ? o.row.id : o.id;
    const i = arr.findIndex(r => r.id === id);
    if (o.op === 'delete') { if (i >= 0) arr.splice(i, 1); }
    else if (i >= 0) arr[i] = Object.assign({}, arr[i], o.row);
    else arr.push(o.row);
  }
}

async function fetchAll() {
  if (!sb || !user || !navigator.onLine) { setSync(); return; }
  try {
    const [t, d] = await Promise.all([
      sb.from('tasks').select('id,title,priority,suggested,due_at,done,done_at,created_at').order('created_at', { ascending: false }).limit(3000),
      sb.from('daily_tasks').select('id,title,remind_time,last_done,created_at').order('created_at', { ascending: true })
    ]);
    if (t.error) throw t.error;
    if (d.error) throw d.error;
    const tasks = t.data, daily = d.data.map(r => Object.assign(r, { remind_time: r.remind_time ? r.remind_time.slice(0, 5) : null }));
    applyOutbox(tasks, daily);
    state.tasks = tasks; state.daily = daily;
    saveLocal(); retrain(); render();
  } catch (e) {
    if (!isNetworkError(e)) { console.error('Load failed', e); toast('Could not load tasks: ' + (e.message || e)); }
  }
  setSync();
}

let fetchTimer = null;
function fetchSoon() { clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchAll, 400); }

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('todo-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => { if (!flushing && !state.outbox.length) fetchSoon(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_tasks' }, () => { if (!flushing && !state.outbox.length) fetchSoon(); })
    .subscribe();
}

/* ---------- learning ---------- */
function retrain() { state.model = Learn.train(state.tasks); }

/* ---------- quick add ---------- */
let newPrio = 2, prioTouched = false, dueTouched = false, lastPred = null;

function setPrioButtons(wrap, p) {
  wrap.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.p) === p));
}

function updateSuggestion() {
  const title = $('newTitle').value.trim();
  const hint = $('hint');
  lastPred = title ? Learn.predict(state.model, title) : null;
  if (!prioTouched) { newPrio = lastPred ? lastPred.priority : 2; setPrioButtons($('newPrio'), newPrio); }
  if (!dueTouched) {
    const when = title ? Learn.parseWhen(title) : null;
    $('newDue').value = when ? toLocalInput(when) : '';
  }
  hint.textContent = '';
  if (!title) {
    const left = Learn.MIN_TRAINED - (state.model ? state.model.n : 0);
    if (left > 0) hint.textContent = `Suggestions start after ${left} more task${left === 1 ? '' : 's'}.`;
    return;
  }
  if (lastPred) {
    hint.append('Suggested: ');
    const b = document.createElement('b'); b.textContent = LABEL[lastPred.priority]; hint.append(b);
    hint.append(' (based on similar tasks you added)');
  }
}

let suggestTimer = null;
$('newTitle').addEventListener('input', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(updateSuggestion, 120); });
$('newTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } });
$('newPrio').addEventListener('click', e => {
  const p = Number(e.target.dataset.p); if (!p) return;
  newPrio = p; prioTouched = true; setPrioButtons($('newPrio'), p);
});
$('newDue').addEventListener('input', () => { dueTouched = true; });
$('clearDue').onclick = () => { $('newDue').value = ''; dueTouched = true; };
$('addBtn').onclick = addTask;

function addTask() {
  const title = $('newTitle').value.trim();
  if (!title) { $('newTitle').focus(); return; }
  clearTimeout(suggestTimer);
  if (!prioTouched) updateSuggestion();
  const due = fromLocalInput($('newDue').value);
  const row = {
    id: crypto.randomUUID(), title, priority: newPrio,
    suggested: lastPred ? lastPred.priority : null,
    due_at: due ? due.toISOString() : null, done: false, done_at: null,
    created_at: new Date().toISOString()
  };
  state.tasks.unshift(row);
  queue({ op: 'upsert', table: 'tasks', row });
  retrain();
  $('newTitle').value = ''; $('newDue').value = '';
  prioTouched = false; dueTouched = false; lastPred = null;
  updateSuggestion(); render();
  $('newTitle').focus();
}

/* ---------- task actions ---------- */
function updateTask(id, patch) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  Object.assign(t, patch);
  queue({ op: 'upsert', table: 'tasks', row: Object.assign({}, t) });
  retrain(); render();
}
function toggleTask(id) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  const nowDone = !t.done;
  updateTask(id, { done: nowDone, done_at: nowDone ? new Date().toISOString() : null });
  if (nowDone) toast('Done: ' + t.title, () => updateTask(id, { done: false, done_at: null }));
}
function deleteTask(id) {
  const i = state.tasks.findIndex(x => x.id === id); if (i < 0) return;
  const [t] = state.tasks.splice(i, 1);
  queue({ op: 'delete', table: 'tasks', id });
  retrain(); render();
  toast('Deleted', () => { state.tasks.push(t); queue({ op: 'upsert', table: 'tasks', row: t }); retrain(); render(); });
}

/* ---------- daily actions ---------- */
function addDaily() {
  const title = $('dTitle').value.trim();
  if (!title) { $('dTitle').focus(); return; }
  const row = { id: crypto.randomUUID(), title, remind_time: $('dTime').value || null, last_done: null, created_at: new Date().toISOString() };
  state.daily.push(row);
  queue({ op: 'upsert', table: 'daily_tasks', row });
  $('dTitle').value = ''; $('dTime').value = '';
  render(); $('dTitle').focus();
}
$('dAdd').onclick = addDaily;
$('dTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDaily(); } });

function updateDaily(id, patch) {
  const d = state.daily.find(x => x.id === id); if (!d) return;
  Object.assign(d, patch);
  queue({ op: 'upsert', table: 'daily_tasks', row: Object.assign({}, d) });
  render();
}
function deleteDaily(id) {
  const i = state.daily.findIndex(x => x.id === id); if (i < 0) return;
  const [d] = state.daily.splice(i, 1);
  queue({ op: 'delete', table: 'daily_tasks', id });
  render();
  toast('Deleted', () => { state.daily.push(d); queue({ op: 'upsert', table: 'daily_tasks', row: d }); render(); });
}

/* ---------- edit dialog ---------- */
let editing = null; // { kind: 'task'|'daily', id }
let editPrio = 2;
$('ePrio').addEventListener('click', e => { const p = Number(e.target.dataset.p); if (p) { editPrio = p; setPrioButtons($('ePrio'), p); } });

function openEdit(kind, id) {
  editing = { kind, id };
  const isTask = kind === 'task';
  const r = (isTask ? state.tasks : state.daily).find(x => x.id === id); if (!r) return;
  $('editHead').textContent = isTask ? 'Edit task' : 'Edit daily task';
  $('eTitle').value = r.title;
  $('ePrioWrap').classList.toggle('hidden', !isTask);
  ['eDue', 'eDueLabel'].forEach(x => $(x).classList.toggle('hidden', !isTask));
  ['eTime', 'eTimeLabel'].forEach(x => $(x).classList.toggle('hidden', isTask));
  if (isTask) { editPrio = r.priority; setPrioButtons($('ePrio'), editPrio); $('eDue').value = toLocalInput(r.due_at); }
  else $('eTime').value = r.remind_time || '';
  $('editDlg').showModal();
}
$('eCancel').onclick = () => $('editDlg').close();
$('eSave').onclick = () => {
  const title = $('eTitle').value.trim();
  if (!title || !editing) return;
  if (editing.kind === 'task') {
    const due = fromLocalInput($('eDue').value);
    updateTask(editing.id, { title, priority: editPrio, due_at: due ? due.toISOString() : null });
  } else {
    updateDaily(editing.id, { title, remind_time: $('eTime').value || null });
  }
  $('editDlg').close();
};
$('eDelete').onclick = () => {
  if (!editing) return;
  if (editing.kind === 'task') deleteTask(editing.id); else deleteDaily(editing.id);
  $('editDlg').close();
};

/* ---------- rendering ---------- */
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function taskItem(t, nowMs) {
  const li = el('li', 'task' + (t.done ? ' done' : ''));
  const chk = el('button', 'check'); chk.setAttribute('aria-label', t.done ? 'Mark not done' : 'Mark done');
  chk.onclick = e => { e.stopPropagation(); toggleTask(t.id); };
  const body = el('div', 'body');
  body.append(el('div', 'title', t.title));
  const meta = el('div', 'meta');
  if (t.due_at) {
    const mins = (new Date(t.due_at).getTime() - nowMs) / 60000;
    meta.append(el('span', null, fmtDue(t.due_at)));
    if (!t.done && mins < 0) meta.append(el('span', 'soon', 'Overdue'));
    else if (!t.done && mins <= 60) meta.append(el('span', 'soon', 'Due soon'));
  }
  if (meta.childNodes.length) body.append(meta);
  li.append(chk, body, el('span', 'tag p' + t.priority, LABEL[t.priority]));
  li.onclick = () => openEdit('task', t.id);
  return li;
}

let showDone = false;
$('toggleDone').onclick = () => { showDone = !showDone; render(); };

function render() {
  const nowMs = Date.now();
  const t0 = startOfToday().getTime();
  const open = state.tasks.filter(t => !t.done).sort((a, b) => Learn.compare(a, b, nowMs));
  const doneToday = state.tasks.filter(t => t.done && t.done_at && new Date(t.done_at).getTime() >= t0)
    .sort((a, b) => new Date(b.done_at) - new Date(a.done_at));

  const list = $('list'); list.replaceChildren();
  if (!open.length) list.append(el('li', 'empty', 'Nothing to do. Add a task above.'));
  open.forEach(t => list.append(taskItem(t, nowMs)));

  $('doneHead').classList.toggle('hidden', !doneToday.length);
  $('doneHead').firstElementChild.textContent = `Done today (${doneToday.length})`;
  $('toggleDone').textContent = showDone ? 'Hide' : 'Show';
  const dl = $('doneList'); dl.replaceChildren();
  dl.classList.toggle('hidden', !showDone);
  doneToday.forEach(t => dl.append(taskItem(t, nowMs)));

  const today = todayStr();
  const daily = state.daily.slice().sort((a, b) => (a.remind_time || '99') < (b.remind_time || '99') ? -1 : 1);
  const dList = $('dailyList'); dList.replaceChildren();
  if (!daily.length) dList.append(el('li', 'empty', 'No daily tasks yet. Add one above.'));
  let dailyLeft = 0;
  daily.forEach(d => {
    const done = d.last_done === today;
    if (!done) dailyLeft++;
    const li = el('li', 'task' + (done ? ' done' : ''));
    const chk = el('button', 'check'); chk.setAttribute('aria-label', done ? 'Mark not done' : 'Mark done');
    chk.onclick = e => { e.stopPropagation(); updateDaily(d.id, { last_done: done ? null : today }); };
    const body = el('div', 'body'); body.append(el('div', 'title', d.title));
    if (d.remind_time) { const m = el('div', 'meta'); m.append(el('span', null, 'Reminder ' + fmtClock(d.remind_time))); body.append(m); }
    li.append(chk, body);
    li.onclick = () => openEdit('daily', d.id);
    dList.append(li);
  });

  $('cTasks').textContent = open.length ? `(${open.length})` : '';
  $('cDaily').textContent = daily.length ? `(${dailyLeft}/${daily.length})` : '';
}

/* ---------- tabs ---------- */
function showTab(which) {
  const tasks = which === 'tasks';
  $('tabTasks').classList.toggle('on', tasks); $('tabDaily').classList.toggle('on', !tasks);
  $('viewTasks').classList.toggle('hidden', !tasks); $('viewDaily').classList.toggle('hidden', tasks);
  $('addTask').classList.toggle('hidden', !tasks); $('addDaily').classList.toggle('hidden', tasks);
  store.set('todo:tab', which);
}
$('tabTasks').onclick = () => showTab('tasks');
$('tabDaily').onclick = () => showTab('daily');

/* ---------- reminders (fire while the app is open or in the background) ---------- */
function notifPermission() { return ('Notification' in window) ? Notification.permission : 'unsupported'; }

async function notify(title, body, tag) {
  if (notifPermission() !== 'granted') return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', renotify: true });
    else new Notification(title, { body, tag, icon: 'icon-192.png' });
  } catch (e) { console.warn('Notification failed', e); }
}

function checkReminders() {
  if (tgLinked) return; // Telegram sends reminders; avoid doubles
  const now = new Date(), nowMs = now.getTime(), today = todayStr(now);
  const fired = store.get('todo:fired', {});
  const WINDOW = 10 * 60000; // catch up to 10 minutes late (e.g. phone was asleep)
  for (const t of state.tasks) {
    if (t.done || !t.due_at) continue;
    const due = new Date(t.due_at);
    if (due.getHours() === 23 && due.getMinutes() === 59) continue; // date-only, no reminder
    const key = 't:' + t.id + ':' + t.due_at;
    if (!fired[key] && due.getTime() <= nowMs && nowMs - due.getTime() < WINDOW) {
      fired[key] = nowMs; notify(t.title, `${LABEL[t.priority]} · due ${fmtTime(due)}`, t.id);
    }
  }
  for (const d of state.daily) {
    if (!d.remind_time || d.last_done === today) continue;
    const [h, m] = d.remind_time.split(':').map(Number);
    const at = new Date(now); at.setHours(h, m, 0, 0);
    const key = 'd:' + d.id + ':' + today + ':' + d.remind_time;
    if (!fired[key] && at.getTime() <= nowMs && nowMs - at.getTime() < WINDOW) {
      fired[key] = nowMs; notify(d.title, 'Daily task', d.id);
    }
  }
  for (const k in fired) if (nowMs - fired[k] > 3 * 86400000) delete fired[k];
  store.set('todo:fired', fired);
}

/* ---------- settings ---------- */
function refreshSettings() {
  $('sUser').textContent = user ? 'Signed in as ' + user.email : '';
  const n = state.model ? state.model.n : 0;
  $('sLearn').textContent = n >= Learn.MIN_TRAINED
    ? `Learning from ${n} task${n === 1 ? '' : 's'} you've rated.`
    : `Learning: suggestions start after ${Learn.MIN_TRAINED - n} more task${Learn.MIN_TRAINED - n === 1 ? '' : 's'}.`;
  const p = notifPermission();
  $('sNotif').textContent = p === 'granted' ? 'Reminders are on (they fire while the app is open or running in the background).'
    : p === 'denied' ? 'Reminders are blocked. Allow notifications for this site in your browser settings.'
    : p === 'unsupported' ? 'This browser does not support reminders.' : 'Reminders are off.';
  $('sEnableNotif').classList.toggle('hidden', p !== 'default');
  refreshTelegram();
}

/* ---------- Telegram link ---------- */
const BOT = 'eptodo_bot';
let tgLinked = store.get('todo:tgLinked', false);

async function checkTelegram() {
  if (!sb || !user || !navigator.onLine) return tgLinked;
  try {
    const { data, error } = await sb.from('telegram_links').select('chat_id').maybeSingle();
    if (!error) { tgLinked = !!data; store.set('todo:tgLinked', tgLinked); }
  } catch (e) { console.warn('Telegram status check failed', e); }
  return tgLinked;
}

async function refreshTelegram() {
  await checkTelegram();
  $('sTg').textContent = tgLinked
    ? 'Telegram is connected. Reminders arrive in Telegram, and you can add tasks by messaging @' + BOT + '.'
    : 'Connect Telegram to get reminders even when the app is closed, and to add tasks by message.';
  $('sTgConnect').classList.toggle('hidden', tgLinked);
  $('sTgDisconnect').classList.toggle('hidden', !tgLinked);
  if (tgLinked) $('sTgLink').classList.add('hidden');
}

$('sTgConnect').onclick = async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes, b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const { error } = await sb.from('telegram_link_codes').insert({ code });
  if (error) { toast('Could not create a link code: ' + error.message); return; }
  const a = $('sTgLink');
  a.href = `https://t.me/${BOT}?start=link_${code}`;
  a.classList.remove('hidden');
  $('sTgConnect').classList.add('hidden');
  $('sTg').textContent = `Tap the button, then press Start in Telegram. Or send /link ${code} to @${BOT}. The code works for 15 minutes.`;
  // Poll until the bot confirms the link.
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    if (await checkTelegram()) { clearInterval(poll); refreshTelegram(); toast('Telegram connected'); }
    else if (tries > 90) clearInterval(poll);
  }, 5000);
};
$('sTgDisconnect').onclick = async () => {
  if (!confirm('Stop Telegram reminders and task-adding?')) return;
  const { error } = await sb.from('telegram_links').delete().eq('user_id', user.id);
  if (error) { toast('Could not disconnect: ' + error.message); return; }
  tgLinked = false; store.set('todo:tgLinked', false); refreshTelegram();
};

$('openSettings').onclick = () => { refreshSettings(); $('setDlg').showModal(); };
$('sClose').onclick = () => $('setDlg').close();
$('sEnableNotif').onclick = async () => {
  try { await Notification.requestPermission(); } catch (e) { console.warn(e); }
  refreshSettings();
  if (notifPermission() === 'granted') notify('Reminders on', 'You will be reminded when tasks are due.', 'test');
};
$('sSignout').onclick = async () => {
  if (state.outbox.length && !confirm(`${state.outbox.length} change(s) have not synced yet and will be lost. Sign out anyway?`)) return;
  ['tasks', 'daily', 'outbox'].forEach(k => store.del(cacheKey(k)));
  store.del('todo:tgLinked'); tgLinked = false;
  await sb.auth.signOut();
  $('setDlg').close();
};

/* ---------- auth ---------- */
function authMsg(text, err) { const m = $('authMsg'); m.textContent = text; m.classList.toggle('err', !!err); }
function creds() {
  const email = $('email').value.trim(), password = $('password').value;
  if (!email || !password) { authMsg('Enter your email and password.', true); return null; }
  if (password.length < 6) { authMsg('Password needs at least 6 characters.', true); return null; }
  return { email, password };
}
$('signin').onclick = async () => {
  const c = creds(); if (!c) return;
  authMsg('Signing in…');
  const { error } = await sb.auth.signInWithPassword(c);
  if (error) authMsg(/confirm/i.test(error.message) ? 'Please confirm your email first (check your inbox), then sign in.' : error.message, true);
};
$('signup').onclick = async () => {
  const c = creds(); if (!c) return;
  authMsg('Creating account…');
  const { data, error } = await sb.auth.signUp(c);
  if (error) return authMsg(error.message, true);
  if (!data.session) authMsg('Account created. Open the confirmation email and tap the link. If the page after that fails to load, that is fine: your email is confirmed. Then come back and sign in.');
};
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('signin').click(); });

function onSession(session) {
  const newUser = session ? session.user : null;
  if (newUser && user && newUser.id === user.id) return;
  user = newUser;
  $('auth').classList.toggle('hidden', !!user);
  $('app').classList.toggle('hidden', !user);
  if (!user) { if (channel) { sb.removeChannel(channel); channel = null; } state.tasks = []; state.daily = []; state.outbox = []; return; }
  loadLocal(); retrain(); render(); updateSuggestion();
  showTab(store.get('todo:tab', 'tasks'));
  flush().then(fetchAll);
  subscribe();
  checkTelegram();
}

/* ---------- start ---------- */
function start() {
  if (!window.supabase || !window.Learn) {
    document.body.textContent = 'Could not load the app. Check your connection and reload.';
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  sb.auth.getSession().then(({ data }) => {
    onSession(data.session);
    if (!data.session) { $('auth').classList.remove('hidden'); }
  });
  sb.auth.onAuthStateChange((_evt, session) => onSession(session));

  window.addEventListener('online', () => { flush().then(fetchAll); });
  window.addEventListener('offline', () => setSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && user) { render(); flush().then(fetchAll); checkReminders(); }
  });
  setInterval(() => { if (user) { checkReminders(); } }, 30000);
  setInterval(() => { if (user && document.visibilityState === 'visible') render(); }, 60000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW failed', e));
}
start();
