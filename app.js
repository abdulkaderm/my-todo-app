/**
 * SmartTodo — app.js  (v2)
 *
 * 100% standalone vanilla JavaScript. No framework, no backend.
 * All data stored in browser LocalStorage.
 * Works by opening index.html directly, or on GitHub Pages.
 *
 * ─── FUTURE GOOGLE SHEETS / APPS SCRIPT SYNC ────────────────
 * Search for "SYNC:" comments to find all integration points.
 * Steps to activate:
 *   1. Deploy a Google Apps Script Web App (doGet / doPost).
 *   2. Paste its URL into GOOGLE_APPS_SCRIPT_URL below.
 *   3. Implement syncToCloud() and fetchFromCloud() with fetch().
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ============================================================
// SYNC: Set your Google Apps Script endpoint URL here.
// Leave empty to keep the app fully offline.
// ============================================================
const GOOGLE_APPS_SCRIPT_URL = '';

// ============================================================
// CONSTANTS
// ============================================================
const STORAGE_KEY   = 'smarttodo_tasks_v2';
const SETTINGS_KEY  = 'smarttodo_settings_v2';
const CATS_KEY      = 'smarttodo_categories_v2';
const DEFAULT_CATS  = ['Job', 'Personal', 'Life'];

// ============================================================
// STATE
// ============================================================
let tasks        = [];
let customCats   = [];     // user-defined categories
let editingId    = null;   // task ID being edited
let focusTaskId  = null;   // task ID in focus mode
let showNextRecs = false;  // recommendation "next 3" toggle

let filterState = {
  search: '', category: '', urgency: '', importance: '', time: '',
  showSnoozed: false,
};

let recState = { time: 15, energy: 'normal' };

// ============================================================
// PERSISTENCE
// ============================================================

function loadTasks() {
  try { tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch(e) { tasks = []; }
}

function saveTasks() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }
  catch(e) { showToast('Storage full — could not save!', 'warn'); }
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch(e) { return {}; }
}

function saveSettings(data) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...data })); }
  catch(e) {}
}

function loadCustomCats() {
  try { customCats = JSON.parse(localStorage.getItem(CATS_KEY) || '[]'); }
  catch(e) { customCats = []; }
}

function saveCustomCats() {
  try { localStorage.setItem(CATS_KEY, JSON.stringify(customCats)); }
  catch(e) {}
}

function allCategories() {
  return [...DEFAULT_CATS, ...customCats];
}

// ============================================================
// SYNC — Google Sheets via Google Apps Script
//
// Credentials are stored ONLY in LocalStorage (never hardcoded).
// The user sets them in Settings → Cloud Sync.
// ============================================================

/** Read syncUrl and syncToken from LocalStorage settings. */
function getSyncConfig() {
  const s = loadSettings();
  return { syncUrl: s.syncUrl || '', syncToken: s.syncToken || '' };
}

/** Save syncUrl and syncToken to LocalStorage. */
function saveSyncConfig() {
  const url   = document.getElementById('syncUrlInput')?.value.trim()  || '';
  const token = document.getElementById('syncTokenInput')?.value.trim() || '';
  saveSettings({ syncUrl: url, syncToken: token });
  showToast('Sync settings saved locally.', 'success');
}

/**
 * SYNC: Push all local tasks to Google Sheets via Apps Script.
 * Uses text/plain content-type to avoid CORS preflight issues with Apps Script.
 */
async function syncToCloud() {
  const { syncUrl, syncToken } = getSyncConfig();
  if (!syncUrl || !syncToken) {
    showToast('Set Cloud Sync URL and token first.', 'warn');
    return;
  }
  showToast('Syncing…');
  try {
    const res = await fetch(syncUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body:    JSON.stringify({ action: 'syncTasks', token: syncToken, tasks }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server returned failure');
    const serverTime = data.serverTime || new Date().toISOString();
    mergeLocalAndCloudData(data.tasks || [], serverTime);
    setLastSyncTime(serverTime);
    showToast('Synced successfully. ✓', 'success');
  } catch (err) {
    console.error('[SmartTodo] syncToCloud failed:', err);
    showToast('Sync failed. Local data is safe.', 'warn');
  }
}

/**
 * SYNC: Pull tasks from Google Sheets and merge with local data.
 */
async function fetchFromCloud() {
  const { syncUrl, syncToken } = getSyncConfig();
  if (!syncUrl || !syncToken) {
    showToast('Set Cloud Sync URL and token first.', 'warn');
    return;
  }
  showToast('Fetching from cloud…');
  try {
    const url = syncUrl + '?action=getTasks&token=' + encodeURIComponent(syncToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Server returned failure');
    const serverTime = data.serverTime || new Date().toISOString();
    mergeLocalAndCloudData(data.tasks || [], serverTime);
    setLastSyncTime(serverTime);
    showToast('Cloud data fetched successfully. ✓', 'success');
  } catch (err) {
    console.error('[SmartTodo] fetchFromCloud failed:', err);
    showToast('Cloud fetch failed. Local data is safe.', 'warn');
  }
}

/**
 * SYNC: Merge local and cloud task arrays safely.
 * Rules:
 *  - Local-only tasks → keep.
 *  - Cloud-only tasks → add.
 *  - Both exist → keep the one with the newer updatedAt.
 *  - If updatedAt is missing or invalid → treat as older.
 *  - If the winning version has status "deleted" → keep that deleted status.
 */
function mergeLocalAndCloudData(cloudTasks, serverTime) {
  const map = new Map();
  // Index all local tasks
  tasks.forEach(t => map.set(t.id, t));

  (cloudTasks || []).forEach(ct => {
    const local    = map.get(ct.id);
    const localTs  = local ? (new Date(local.updatedAt).getTime()  || 0) : 0;
    const cloudTs  = new Date(ct.updatedAt).getTime() || 0;
    if (!local || cloudTs > localTs) {
      map.set(ct.id, ct);
    }
  });

  // Mark all tasks as synced
  const syncedAt = serverTime || new Date().toISOString();
  tasks = Array.from(map.values()).map(t => ({
    ...t,
    syncStatus:   'synced',
    lastSyncedAt: syncedAt,
  }));

  saveTasks();
  renderAll();
  updateSyncStatusDisplay();
}

/** Update the pending-changes counter shown in Settings. */
function updateSyncStatusDisplay() {
  const pending = tasks.filter(t => t.syncStatus === 'pending' || !t.syncStatus).length;
  const el = document.getElementById('syncPendingInfo');
  if (el) el.textContent = pending > 0 ? `${pending} pending local change${pending > 1 ? 's' : ''}` : '';
}

/** SYNC: Read last sync timestamp */
function getLastSyncTime() { return loadSettings().lastSyncTime || null; }

/** SYNC: Write last sync timestamp and update displayed text. */
function setLastSyncTime(iso) {
  saveSettings({ lastSyncTime: iso });
  const el = document.getElementById('lastSyncInfo');
  if (el) el.textContent = 'Last sync: ' + new Date(iso).toLocaleString();
}

// ============================================================
// SCORING ALGORITHM
// ─────────────────────────────────────────────────────────────
// Final Score = Urgency + Importance + TimeEfficiency
//             + ManualWeight + AgeBonus + DueDateBonus + PinBonus
// ============================================================

function calcScore(task) {
  // 1. Urgency  (how pressing is it?)
  const urgencyScore = { 'Very Urgent': 60, 'Urgent': 40, 'Normal': 10 }[task.urgency] ?? 10;

  // 2. Importance  (how valuable is it?)
  const importanceScore = { 'High': 30, 'Medium': 15, 'Low': 5 }[task.importance] ?? 15;

  // 3. Time efficiency  (shorter tasks bubble up)
  const timeScore = { 15: 30, 30: 20, 60: 10, 999: 0 }[Number(task.estimatedTime)] ?? 10;

  // 4. Manual weight  (user override, 1–5 × 10)
  const weightScore = Math.max(1, Math.min(5, Number(task.manualWeight) || 3)) * 10;

  // 5. Age bonus  (+5 per day since creation, max 40)
  const ageDays = Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 86400000);
  const ageScore = Math.min(40, ageDays * 5);

  // 6. Due date bonus
  //    noDeadline = 0 bonus  |  overdue = 70  |  today = 50  |  tomorrow = 35  |  ≤7 days = 20
  let dueScore = 0;
  if (!task.noDeadline && task.dueDate) {
    const today  = new Date(); today.setHours(0,0,0,0);
    const dueDay = new Date(task.dueDate); dueDay.setHours(0,0,0,0);
    const diff   = Math.floor((dueDay - today) / 86400000);
    if      (diff < 0)  dueScore = 70;
    else if (diff === 0) dueScore = 50;
    else if (diff === 1) dueScore = 35;
    else if (diff <= 7)  dueScore = 20;
  }

  // 7. Pin bonus
  const pinBonus = task.pinned ? 100 : 0;

  return urgencyScore + importanceScore + timeScore + weightScore + ageScore + dueScore + pinBonus;
}

// ============================================================
// RECOMMENDATION
// ============================================================

function buildRecommendation() {
  const active = getActiveTasks(true); // all active, ignore filters
  if (!active.length) return [];

  const { time, energy } = recState;

  // Determine allowed estimated times
  let allowed;
  if (energy === 'low') {
    allowed = [15, 30];
  } else if (energy === 'high') {
    allowed = time >= 999 ? [15,30,60,999] : time >= 60 ? [15,30,60] : time >= 30 ? [15,30] : [15];
  } else {
    allowed = time >= 999 ? [15,30,60,999] : time >= 60 ? [15,30,60] : time >= 30 ? [15,30] : [15];
  }

  const sorted = [...active].sort((a,b) => b._score - a._score);
  const fits   = sorted.filter(t => allowed.includes(Number(t.estimatedTime)));

  // Results array: [{task, fallback, reason}]
  const results = [];

  function buildReason(t, fallback) {
    const parts = [];
    if (t.pinned)                parts.push('it is pinned');
    if (t.urgency === 'Very Urgent') parts.push('it is very urgent');
    else if (t.urgency === 'Urgent') parts.push('it is urgent');
    if (t.importance === 'High')     parts.push('it is high importance');
    if (!t.noDeadline && t.dueDate) {
      const today  = new Date(); today.setHours(0,0,0,0);
      const dueDay = new Date(t.dueDate); dueDay.setHours(0,0,0,0);
      const diff   = Math.floor((dueDay - today) / 86400000);
      if      (diff < 0)  parts.push('it is overdue');
      else if (diff === 0) parts.push('it is due today');
      else if (diff === 1) parts.push('it is due tomorrow');
    }
    if (energy === 'low' && Number(t.estimatedTime) <= 30) parts.push('it is a short task suitable for low energy');
    if (!parts.length) parts.push('it has the highest priority score');

    let reason = 'Recommended because ' + parts.slice(0,3).join(', ');
    if (!reason.endsWith('.')) reason += '.';
    if (fallback) reason += ' (No task fits your exact available time — this may need more time than you have.)';
    return reason;
  }

  if (fits.length) {
    // Top match + next 3
    const top = fits[0];
    results.push({ task: top, fallback: false, reason: buildReason(top, false) });
    fits.slice(1, 4).forEach(t => results.push({ task: t, fallback: false, reason: buildReason(t, false) }));
  } else if (sorted.length) {
    // Fallback to highest overall
    const top = sorted[0];
    results.push({ task: top, fallback: true, reason: buildReason(top, true) });
    sorted.slice(1, 4).forEach(t => results.push({ task: t, fallback: true, reason: buildReason(t, true) }));
  }

  return results;
}

// ============================================================
// TASK HELPERS
// ============================================================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isActivelySnoozed(task) {
  if (task.status !== 'snoozed' && !task.snoozedUntil) return false;
  if (!task.snoozedUntil) return false;
  return new Date(task.snoozedUntil) > new Date();
}

function restoreExpiredSnoozes() {
  let changed = false;
  tasks.forEach(t => {
    if (t.status === 'snoozed' && t.snoozedUntil && new Date(t.snoozedUntil) <= new Date()) {
      t.status = 'active';
      t.snoozedUntil = null;
      t.updatedAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) saveTasks();
}

/** Return scored+sorted active tasks; optionally ignore filters. */
function getActiveTasks(ignoreFilters = false) {
  restoreExpiredSnoozes();
  return tasks
    .filter(t => {
      if (t.status === 'completed' || t.status === 'deleted') return false;
      if (ignoreFilters) {
        return !isActivelySnoozed(t);
      }
      // Snoozed tasks hidden unless toggle on
      if (isActivelySnoozed(t) && !filterState.showSnoozed) return false;
      if (t.status === 'snoozed' && !filterState.showSnoozed) return false;
      // Apply text/filter state
      if (filterState.search) {
        const q = filterState.search.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !(t.description||'').toLowerCase().includes(q)) return false;
      }
      if (filterState.category) {
        const cat = t.category || 'Personal';
        if (cat !== filterState.category) return false;
      }
      if (filterState.urgency   && t.urgency   !== filterState.urgency)   return false;
      if (filterState.importance && t.importance !== filterState.importance) return false;
      if (filterState.time      && Number(t.estimatedTime) !== Number(filterState.time)) return false;
      return true;
    })
    .map(t => ({ ...t, _score: calcScore(t) }))
    .sort((a,b) => b._score !== a._score ? b._score - a._score : new Date(a.createdAt) - new Date(b.createdAt));
}

/** Today view: due today + overdue + pinned/very-urgent no-deadline tasks */
function getTodayTasks() {
  restoreExpiredSnoozes();
  const today  = new Date(); today.setHours(0,0,0,0);
  return tasks
    .filter(t => {
      if (t.status !== 'active') return false;
      if (isActivelySnoozed(t)) return false;
      // Overdue or due today
      if (!t.noDeadline && t.dueDate) {
        const d = new Date(t.dueDate); d.setHours(0,0,0,0);
        if (d <= today) return true;
      }
      // Pinned or very urgent with no deadline
      if (t.noDeadline || !t.dueDate) {
        if (t.pinned || t.urgency === 'Very Urgent') return true;
      }
      return false;
    })
    .map(t => ({ ...t, _score: calcScore(t) }))
    .sort((a,b) => b._score !== a._score ? b._score - a._score : new Date(a.createdAt) - new Date(b.createdAt));
}

function getCompletedTasks() {
  return tasks
    .filter(t => t.status === 'completed')
    .map(t => ({ ...t, _score: t.finalScoreAtCompletion || calcScore(t) }))
    .sort((a,b) => new Date(b.completedAt) - new Date(a.completedAt));
}

// ============================================================
// TASK CRUD
// ============================================================

function buildTaskObject(data, existing = null) {
  const now = new Date().toISOString();
  return {
    id:                   existing ? existing.id : generateId(),
    title:                (data.title || '').trim(),
    description:          (data.description || '').trim(),
    urgency:              data.urgency       || 'Normal',
    importance:           data.importance    || 'Medium',
    estimatedTime:        Number(data.estimatedTime) || 30,
    category:             data.category      || 'Job',
    manualWeight:         Math.max(1, Math.min(5, Number(data.manualWeight) || 3)),
    dueDate:              data.noDeadline ? null : (data.dueDate || null),
    noDeadline:           Boolean(data.noDeadline),
    pinned:               Boolean(data.pinned),
    notes:                (data.notes || '').trim(),
    status:               existing ? existing.status : 'active',
    snoozedUntil:         existing ? existing.snoozedUntil : null,
    createdAt:            existing ? existing.createdAt : now,
    updatedAt:            now,
    completedAt:          existing ? existing.completedAt : null,
    deletedAt:            existing ? existing.deletedAt : null,
    finalScoreAtCompletion: existing ? existing.finalScoreAtCompletion : null,
    // SYNC fields — populated when cloud sync is implemented
    syncStatus:           existing ? existing.syncStatus   : 'local',
    lastSyncedAt:         existing ? existing.lastSyncedAt : null,
  };
}

function createTask(data) {
  const task = buildTaskObject(data);
  tasks.push(task);
  saveTasks();
  return task;
}

function updateTask(id, data) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx < 0) return;
  tasks[idx] = buildTaskObject(data, tasks[idx]);
  saveTasks();
}

function completeTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const now = new Date().toISOString();
  t.status = 'completed';
  t.completedAt = now;
  t.updatedAt   = now;
  t.finalScoreAtCompletion = calcScore(t);
  saveTasks();
  showToast(`"${t.title}" completed! ✓`, 'success');
  renderAll();
}

/** Soft delete — sets status to "deleted" and records timestamp. */
function deleteTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Delete "${t.title}"? (It will be hidden but kept for sync purposes.)`)) return;
  const now = new Date().toISOString();
  t.status    = 'deleted';
  t.deletedAt = now;
  t.updatedAt = now;
  saveTasks();
  showToast('Task deleted.');
  renderAll();
}

function snoozeTask(id, untilIso) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.status      = 'snoozed';
  t.snoozedUntil = untilIso;
  t.updatedAt   = new Date().toISOString();
  saveTasks();
  showToast(`"${t.title}" snoozed until ${fmtDateTime(untilIso)}.`);
  renderAll();
}

function quickAddTask(title) {
  if (!title.trim()) return;
  createTask({
    title,
    description:   '',
    urgency:       'Normal',
    importance:    'Medium',
    estimatedTime: 30,
    category:      'Job',
    manualWeight:  3,
    dueDate:       todayISO(),
    noDeadline:    false,
    pinned:        false,
    notes:         '',
  });
  showToast(`"${title.trim()}" added! ✓`, 'success');
  renderAll();
}

// ============================================================
// CATEGORY MANAGEMENT
// ============================================================

function addCategory(name) {
  const n = name.trim();
  if (!n) { showToast('Category name cannot be empty.', 'warn'); return false; }
  if (allCategories().map(c => c.toLowerCase()).includes(n.toLowerCase())) {
    showToast('Category already exists.', 'warn'); return false;
  }
  customCats.push(n);
  saveCustomCats();
  showToast(`Category "${n}" added.`, 'success');
  return true;
}

function deleteCategory(name) {
  if (DEFAULT_CATS.includes(name)) { showToast('Default categories cannot be deleted.', 'warn'); return; }
  if (!confirm(`Delete category "${name}"? Tasks in this category will be moved to "Personal".`)) return;
  // Reassign tasks
  tasks.forEach(t => {
    if (t.category === name) { t.category = 'Personal'; t.updatedAt = new Date().toISOString(); }
  });
  saveTasks();
  customCats = customCats.filter(c => c !== name);
  saveCustomCats();
  showToast(`Category "${name}" removed — tasks moved to Personal.`);
  renderAll();
  renderCategoryList();
  populateCategoryDropdowns();
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function esc(str) {
  return String(str || '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const m = Math.floor((new Date(endIso) - new Date(startIso)) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m/60), r = m%60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function fmtTime(val) {
  return ({15:'15 min', 30:'30 min', 60:'1 hour', 999:'1 hour+'})[Number(val)] || val + ' min';
}

function dueBadge(task) {
  if (task.noDeadline || !task.dueDate) return null;
  const today  = new Date(); today.setHours(0,0,0,0);
  const dueDay = new Date(task.dueDate); dueDay.setHours(0,0,0,0);
  const diff   = Math.floor((dueDay - today) / 86400000);
  if      (diff < 0)  return { cls: 'badge-due-over',  txt: `Overdue (${fmtDate(task.dueDate)})` };
  else if (diff === 0) return { cls: 'badge-due-today', txt: 'Due today' };
  else if (diff === 1) return { cls: 'badge-due-soon',  txt: 'Due tomorrow' };
  else if (diff <= 7)  return { cls: 'badge-due-soon',  txt: `Due ${fmtDate(task.dueDate)}` };
  else                return { cls: 'badge-due-ok',    txt: `Due ${fmtDate(task.dueDate)}` };
}

function urgBadge(u)  { return ({
  'Very Urgent':'badge-urg-very','Urgent':'badge-urg-urgent','Normal':'badge-urg-normal'
})[u] || 'badge-muted'; }

function impBadge(i)  { return ({
  'High':'badge-imp-high','Medium':'badge-imp-medium','Low':'badge-imp-low'
})[i] || 'badge-muted'; }

// ============================================================
// RENDER: TASK CARD
// ============================================================

function buildTaskCard(task, showSnoozeIndicator = true) {
  const db = dueBadge(task);
  const snoozed = isActivelySnoozed(task) || task.status === 'snoozed';
  const el = document.createElement('article');
  el.className = 'task-card' + (task.pinned ? ' is-pinned' : '') + (snoozed ? ' is-snoozed' : '');
  el.dataset.id = task.id;

  el.innerHTML = `
    <div class="task-top">
      <div class="task-title-wrap">
        ${task.pinned ? `<span class="badge badge-pin">📌</span>` : ''}
        <span class="task-title">${esc(task.title)}</span>
        <span class="task-score-badge" title="Score is based on urgency, importance, time, age, due date, and pin status.">${task._score}</span>
        ${snoozed && showSnoozeIndicator ? `<span class="badge badge-snooze">💤 Snoozed${task.snoozedUntil ? ' until '+fmtDateTime(task.snoozedUntil) : ''}</span>` : ''}
      </div>
    </div>
    ${task.description ? `<p class="task-desc">${esc(task.description)}</p>` : ''}
    <div class="task-meta">
      <span class="badge ${urgBadge(task.urgency)}">${esc(task.urgency)}</span>
      <span class="badge ${impBadge(task.importance)}">${esc(task.importance)}</span>
      <span class="badge badge-time">⏱ ${fmtTime(task.estimatedTime)}</span>
      <span class="badge badge-cat">${esc(task.category || 'Job')}</span>
      ${db ? `<span class="badge ${db.cls}">${esc(db.txt)}</span>` : task.noDeadline ? `<span class="badge badge-muted">No deadline</span>` : ''}
      <span class="badge badge-muted" style="margin-left:auto">${fmtDate(task.createdAt)}</span>
    </div>
    <div class="task-actions">
      <button class="btn btn-glass-primary btn-sm t-complete" data-id="${task.id}">✓ Done</button>
      <button class="btn btn-glass btn-sm t-focus"    data-id="${task.id}">⊙ Focus</button>
      <button class="btn btn-glass btn-sm t-edit"     data-id="${task.id}">✏ Edit</button>
      <button class="btn btn-glass btn-sm t-snooze"   data-id="${task.id}">💤 Snooze</button>
      <button class="btn btn-ghost btn-sm t-delete"   data-id="${task.id}" style="opacity:.55">🗑</button>
    </div>
  `;
  return el;
}

// ============================================================
// RENDER: RECOMMENDATION
// ============================================================

function renderRecommendation() {
  const results  = buildRecommendation();
  const resultEl = document.getElementById('recommendationResult');
  const nextEl   = document.getElementById('nextRecommendations');
  const toggleBtn = document.getElementById('recToggleNext');

  if (!results.length) {
    resultEl.innerHTML = '<p class="empty-hint">Add tasks to get a smart recommendation.</p>';
    if (nextEl) nextEl.innerHTML = '';
    return;
  }

  const top = results[0];
  const db  = dueBadge(top.task);
  resultEl.innerHTML = `
    <div class="rec-card">
      <div class="rec-card-title">${esc(top.task.title)}</div>
      <p class="rec-reason">${esc(top.reason)}</p>
      <div class="rec-card-meta">
        <span class="badge ${urgBadge(top.task.urgency)}">${esc(top.task.urgency)}</span>
        <span class="badge ${impBadge(top.task.importance)}">${esc(top.task.importance)}</span>
        <span class="badge badge-time">⏱ ${fmtTime(top.task.estimatedTime)}</span>
        <span class="badge badge-cat">${esc(top.task.category || 'Job')}</span>
        ${db ? `<span class="badge ${db.cls}">${esc(db.txt)}</span>` : ''}
        <span class="badge badge-muted">Score: ${top.task._score}</span>
      </div>
      ${top.fallback ? `<p class="rec-fallback-note">⚠ No task fits your available time — this task may take longer.</p>` : ''}
    </div>
  `;

  // Next 3
  if (nextEl) {
    nextEl.hidden = !showNextRecs;
    if (showNextRecs && results.length > 1) {
      nextEl.innerHTML = results.slice(1).map((r, i) => `
        <div class="next-rec-item">
          <span class="next-rec-rank">#${i+2}</span>
          <span class="next-rec-title">${esc(r.task.title)}</span>
          <span class="next-rec-score">${r.task._score} pts</span>
        </div>
      `).join('');
    } else {
      nextEl.innerHTML = '';
    }
  }

  if (toggleBtn) {
    toggleBtn.textContent = showNextRecs ? 'Hide others' : 'Show next 3';
  }
}

// ============================================================
// RENDER: TODAY TAB
// ============================================================

function renderTodayList() {
  const container = document.getElementById('todayList');
  if (!container) return;
  const list = getTodayTasks();
  if (!list.length) {
    container.innerHTML = '<p class="empty-state">No tasks due today. Great work! 🎉</p>';
    return;
  }
  container.innerHTML = '';
  list.forEach(t => container.appendChild(buildTaskCard(t)));
}

// ============================================================
// RENDER: ALL TASKS TAB
// ============================================================

function renderAllTaskList() {
  const container = document.getElementById('allTaskList');
  if (!container) return;
  const list = getActiveTasks();
  if (!list.length) {
    const hasFilters = filterState.search || filterState.category || filterState.urgency || filterState.importance || filterState.time;
    container.innerHTML = `<p class="empty-state">${hasFilters
      ? 'No tasks match your filters. Try resetting them.'
      : 'No active tasks. Click <strong>+ New Task</strong> to get started! 🚀'
    }</p>`;
    return;
  }
  container.innerHTML = '';
  list.forEach(t => container.appendChild(buildTaskCard(t)));
}

// ============================================================
// RENDER: HISTORY
// ============================================================

function renderHistoryList() {
  const container = document.getElementById('historyList');
  if (!container) return;

  let list = getCompletedTasks();

  const q   = (document.getElementById('historySearch')?.value   || '').toLowerCase();
  const cat = document.getElementById('historyCategory')?.value  || '';
  const urg = document.getElementById('historyUrgency')?.value   || '';
  const imp = document.getElementById('historyImportance')?.value || '';

  list = list.filter(t => {
    if (q   && !t.title.toLowerCase().includes(q)) return false;
    if (cat && (t.category||'Job') !== cat) return false;
    if (urg && t.urgency   !== urg)  return false;
    if (imp && t.importance !== imp) return false;
    return true;
  });

  if (!list.length) {
    container.innerHTML = '<p class="empty-state">No completed tasks yet.</p>';
    return;
  }

  container.innerHTML = '';
  list.forEach(t => {
    const el = document.createElement('article');
    el.className = 'history-card';
    const db = dueBadge(t);
    el.innerHTML = `
      <div class="history-header">
        <span class="history-title">${esc(t.title)}</span>
        <span class="badge badge-muted">Score: ${t._score}</span>
      </div>
      <div class="history-meta">
        <span class="badge ${urgBadge(t.urgency)}">${esc(t.urgency)}</span>
        <span class="badge ${impBadge(t.importance)}">${esc(t.importance)}</span>
        <span class="badge badge-time">⏱ ${fmtTime(t.estimatedTime)}</span>
        <span class="badge badge-cat">${esc(t.category || 'Job')}</span>
        ${db ? `<span class="badge ${db.cls}">${esc(db.txt)}</span>` : ''}
      </div>
      <div class="history-times">
        <span>Created: ${fmtDateTime(t.createdAt)}</span>
        <span>Completed: ${fmtDateTime(t.completedAt)}</span>
        ${fmtDuration(t.createdAt, t.completedAt) ? `<span>Took: ${fmtDuration(t.createdAt, t.completedAt)}</span>` : ''}
      </div>
    `;
    container.appendChild(el);
  });
}

// ============================================================
// RENDER: SETTINGS
// ============================================================

function renderStats() {
  restoreExpiredSnoozes();
  const active    = tasks.filter(t => t.status === 'active').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const snoozed   = tasks.filter(t => isActivelySnoozed(t) || t.status === 'snoozed').length;
  const deleted   = tasks.filter(t => t.status === 'deleted').length;
  document.getElementById('statActive')?.setAttribute('textContent', active);
  document.getElementById('statActive').textContent    = active;
  document.getElementById('statCompleted').textContent = completed;
  document.getElementById('statSnoozed').textContent   = snoozed;
  document.getElementById('statDeleted').textContent   = deleted;
  document.getElementById('statCategories').textContent = allCategories().length;
}

function renderCategoryList() {
  const container = document.getElementById('categoryList');
  if (!container) return;
  container.innerHTML = '';
  allCategories().forEach(cat => {
    const isDefault = DEFAULT_CATS.includes(cat);
    const el = document.createElement('div');
    el.className = 'cat-item' + (isDefault ? ' is-default' : '');
    el.innerHTML = `
      <span>${esc(cat)}${isDefault ? ' <span class="badge badge-muted" style="font-size:.62rem">default</span>' : ''}</span>
      ${!isDefault ? `<button class="cat-del-btn" data-cat="${esc(cat)}" title="Delete category">✕</button>` : ''}
    `;
    container.appendChild(el);
  });
}

function populateCategoryDropdowns() {
  const cats = allCategories();
  const selects = ['taskCategory', 'filterCategory', 'historyCategory'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    // Keep first option (empty "All categories" for filters)
    const firstOpt = sel.options[0];
    sel.innerHTML = '';
    if (firstOpt && firstOpt.value === '') sel.appendChild(firstOpt);
    cats.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    if (prev && cats.includes(prev)) sel.value = prev;
  });
}

// ============================================================
// RENDER: ALL
// ============================================================

function renderAll() {
  renderTodayList();
  renderAllTaskList();
  renderRecommendation();
  renderHistoryList();
  renderStats();
  renderCategoryList();
}

// ============================================================
// MODAL: ADD / EDIT TASK
// ============================================================

function openAddModal() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Add Task';
  document.getElementById('taskForm').reset();
  document.getElementById('taskId').value = '';
  document.getElementById('titleError').textContent = '';
  document.getElementById('taskWeight').value = 3;
  document.getElementById('taskTime').value   = '30';
  document.getElementById('taskUrgency').value   = 'Normal';
  document.getElementById('taskImportance').value = 'Medium';
  // Default due date = today
  document.getElementById('taskDueDate').value = todayISO();
  document.getElementById('taskNoDeadline').checked = false;
  document.getElementById('taskDueDate').disabled    = false;
  populateCategoryDropdowns();
  document.getElementById('taskCategory').value = 'Job';
  showModal('taskModal');
  setTimeout(() => document.getElementById('taskTitle').focus(), 60);
}

function openEditModal(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Task';
  document.getElementById('taskId').value = id;
  document.getElementById('taskTitle').value       = t.title;
  document.getElementById('taskDesc').value         = t.description || '';
  document.getElementById('taskUrgency').value      = t.urgency;
  document.getElementById('taskImportance').value   = t.importance;
  document.getElementById('taskTime').value         = String(t.estimatedTime);
  document.getElementById('taskWeight').value       = t.manualWeight;
  populateCategoryDropdowns();
  document.getElementById('taskCategory').value    = t.category || 'Job';
  document.getElementById('taskDueDate').value     = t.noDeadline ? '' : (t.dueDate || '');
  document.getElementById('taskNoDeadline').checked = Boolean(t.noDeadline);
  document.getElementById('taskDueDate').disabled   = Boolean(t.noDeadline);
  document.getElementById('taskPinned').checked     = t.pinned;
  document.getElementById('taskNotes').value        = t.notes || '';
  document.getElementById('titleError').textContent = '';
  showModal('taskModal');
  setTimeout(() => document.getElementById('taskTitle').focus(), 60);
}

function closeTaskModal() { hideModal('taskModal'); editingId = null; }

function handleTaskSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) {
    document.getElementById('titleError').textContent = 'Title is required.';
    document.getElementById('taskTitle').focus();
    return;
  }
  const noDeadline = document.getElementById('taskNoDeadline').checked;
  const data = {
    title,
    description:   document.getElementById('taskDesc').value,
    urgency:       document.getElementById('taskUrgency').value,
    importance:    document.getElementById('taskImportance').value,
    estimatedTime: document.getElementById('taskTime').value,
    manualWeight:  document.getElementById('taskWeight').value,
    category:      document.getElementById('taskCategory').value,
    dueDate:       noDeadline ? null : (document.getElementById('taskDueDate').value || null),
    noDeadline,
    pinned:        document.getElementById('taskPinned').checked,
    notes:         document.getElementById('taskNotes').value,
  };
  if (editingId) { updateTask(editingId, data); showToast('Task updated!', 'success'); }
  else           { createTask(data);            showToast('Task added!',   'success'); }
  closeTaskModal();
  renderAll();
}

// ============================================================
// MODAL: SNOOZE
// ============================================================

function openSnoozeModal(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  document.getElementById('snoozeTaskId').value = id;
  document.getElementById('snoozeTaskName').textContent = `"${t.title}"`;
  document.getElementById('snoozeCustomDate').value = '';
  showModal('snoozeModal');
}

function closeSnoozeModal() { hideModal('snoozeModal'); }

function calcSnoozeDate(option) {
  const now = new Date();
  if (option === 'later-today') {
    now.setHours(now.getHours() + 4);
    return now.toISOString();
  }
  if (option === 'tomorrow') {
    now.setDate(now.getDate() + 1);
    now.setHours(9, 0, 0, 0);
    return now.toISOString();
  }
  if (option === 'next-monday') {
    const day = now.getDay();
    const daysUntil = ((1 - day) + 7) % 7 || 7;
    now.setDate(now.getDate() + daysUntil);
    now.setHours(9, 0, 0, 0);
    return now.toISOString();
  }
  return null;
}

// ============================================================
// MODAL: FOCUS MODE
// ============================================================

function openFocusMode(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  focusTaskId = id;
  document.getElementById('focusTitle').textContent = t.title;
  document.getElementById('focusDesc').textContent  = t.description || '';
  const db = dueBadge(t);
  document.getElementById('focusMeta').innerHTML = `
    <span class="badge badge-time">⏱ ${fmtTime(t.estimatedTime)}</span>
    <span class="badge ${urgBadge(t.urgency)}">${esc(t.urgency)}</span>
    ${db ? `<span class="badge ${db.cls}">${esc(db.txt)}</span>` : ''}
    ${t.noDeadline ? `<span class="badge badge-muted">No deadline</span>` : ''}
  `;
  showModal('focusModal');
}

function closeFocusModal() { hideModal('focusModal'); focusTaskId = null; }

// ============================================================
// MODAL HELPERS
// ============================================================

function showModal(id) {
  const el = document.getElementById(id);
  el.hidden = false;
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function hideModal(id) {
  const el = document.getElementById(id);
  el.hidden = true;
  el.style.display = '';
  document.body.style.overflow = '';
}

// ============================================================
// TOAST
// ============================================================

let toastTimer = null;

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast show' + (type ? ' toast-' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ============================================================
// EXPORT / IMPORT
// ============================================================

function exportData() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: 2, tasks }, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'smarttodo-' + todayISO() + '.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('Data exported! ⬇', 'success');
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data     = JSON.parse(e.target.result);
      const imported = Array.isArray(data) ? data : (data.tasks || []);
      if (!imported.length) { showToast('No tasks found in file.', 'warn'); return; }
      if (!confirm(`Import ${imported.length} task(s)? New tasks will be merged with existing.`)) return;
      const existing = new Set(tasks.map(t => t.id));
      const added    = imported.filter(t => !existing.has(t.id));
      tasks = [...tasks, ...added];
      saveTasks();
      showToast(`Imported ${added.length} task(s).`, 'success');
      renderAll();
    } catch(err) { showToast('Invalid JSON file.', 'warn'); }
    document.getElementById('importFile').value = '';
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('Delete ALL tasks, history, and categories? This cannot be undone.')) return;
  if (!confirm('Final confirmation — clear everything?')) return;
  tasks = []; saveTasks();
  customCats = []; saveCustomCats();
  showToast('All data cleared.', 'success');
  renderAll(); renderCategoryList(); populateCategoryDropdowns();
}

function purgeDeletedTasks() {
  const count = tasks.filter(t => t.status === 'deleted').length;
  if (!count) { showToast('No soft-deleted tasks to purge.'); return; }
  if (!confirm(`Permanently remove ${count} soft-deleted task(s)? This cannot be undone.`)) return;
  tasks = tasks.filter(t => t.status !== 'deleted');
  saveTasks();
  showToast(`${count} deleted task(s) permanently removed.`, 'success');
  renderStats();
}

// ============================================================
// TAB / NAVIGATION
// ============================================================

function switchTab(name) {
  // Desktop tabs
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  // Bottom nav
  document.querySelectorAll('.bnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  // Panes
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.hidden = p.id !== 'tab-' + name;
  });
  if (name === 'settings') { renderStats(); renderCategoryList(); }
}

// ============================================================
// DARK MODE
// ============================================================

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  const toggle = document.getElementById('darkToggle');
  if (toggle) toggle.textContent = dark ? '☀' : '🌙';
  const checkbox = document.getElementById('darkModeToggle');
  if (checkbox) checkbox.checked = dark;
  saveSettings({ darkMode: dark });
}

// ============================================================
// BIND ALL EVENTS
// ============================================================

function bindEvents() {
  // Desktop tab nav
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Bottom nav
  document.querySelectorAll('.bnav-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Dark mode
  document.getElementById('darkToggle')?.addEventListener('click', () => {
    applyTheme(!document.body.classList.contains('dark'));
  });
  document.getElementById('darkModeToggle')?.addEventListener('change', e => {
    applyTheme(e.target.checked);
  });

  // Add task buttons
  document.getElementById('addTaskBtnToday')?.addEventListener('click', openAddModal);
  document.getElementById('addTaskBtnAll')?.addEventListener('click', openAddModal);

  // Quick add (Today)
  const qaToday = document.getElementById('quickAddInput');
  const qaAllInput = document.getElementById('quickAddInputAll');
  const qaBtn   = document.getElementById('quickAddBtn');
  const qaBtnAll = document.getElementById('quickAddBtnAll');
  function doQuickAdd(inputEl) {
    if (!inputEl) return;
    quickAddTask(inputEl.value);
    inputEl.value = '';
  }
  qaToday?.addEventListener('keydown', e => { if (e.key === 'Enter') doQuickAdd(qaToday); });
  qaBtn?.addEventListener('click', () => doQuickAdd(qaToday));
  qaAllInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doQuickAdd(qaAllInput); });
  qaBtnAll?.addEventListener('click', () => doQuickAdd(qaAllInput));

  // Task form
  document.getElementById('taskForm')?.addEventListener('submit', handleTaskSubmit);
  document.getElementById('closeModal')?.addEventListener('click', closeTaskModal);
  document.getElementById('cancelModal')?.addEventListener('click', closeTaskModal);
  document.getElementById('taskModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeTaskModal(); });

  // No deadline toggle
  document.getElementById('taskNoDeadline')?.addEventListener('change', e => {
    document.getElementById('taskDueDate').disabled = e.target.checked;
    if (e.target.checked) document.getElementById('taskDueDate').value = '';
  });

  // Snooze modal
  document.getElementById('closeSnoozeModal')?.addEventListener('click', closeSnoozeModal);
  document.getElementById('snoozeModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeSnoozeModal(); });
  document.querySelectorAll('.snooze-option').forEach(btn =>
    btn.addEventListener('click', () => {
      const id = document.getElementById('snoozeTaskId').value;
      const until = calcSnoozeDate(btn.dataset.snooze);
      if (until) { snoozeTask(id, until); closeSnoozeModal(); }
    })
  );
  document.getElementById('snoozeCustomBtn')?.addEventListener('click', () => {
    const id  = document.getElementById('snoozeTaskId').value;
    const val = document.getElementById('snoozeCustomDate').value;
    if (!val) { showToast('Please select a date and time.', 'warn'); return; }
    const iso = new Date(val).toISOString();
    if (new Date(iso) <= new Date()) { showToast('Please pick a future date.', 'warn'); return; }
    snoozeTask(id, iso); closeSnoozeModal();
  });

  // Focus modal
  document.getElementById('closeFocusModal')?.addEventListener('click', closeFocusModal);
  document.getElementById('exitFocusBtn')?.addEventListener('click', closeFocusModal);
  document.getElementById('focusModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeFocusModal(); });
  document.getElementById('focusCompleteBtn')?.addEventListener('click', () => {
    if (focusTaskId) { completeTask(focusTaskId); closeFocusModal(); }
  });

  // ESC key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('taskModal').hidden)   closeTaskModal();
      if (!document.getElementById('snoozeModal').hidden) closeSnoozeModal();
      if (!document.getElementById('focusModal').hidden)  closeFocusModal();
    }
  });

  // Task list event delegation (Today + All Tasks)
  ['todayList', 'allTaskList'].forEach(listId => {
    document.getElementById(listId)?.addEventListener('click', e => {
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      const id = btn.dataset.id;
      if      (btn.classList.contains('t-complete')) completeTask(id);
      else if (btn.classList.contains('t-edit'))     openEditModal(id);
      else if (btn.classList.contains('t-snooze'))   openSnoozeModal(id);
      else if (btn.classList.contains('t-delete'))   deleteTask(id);
      else if (btn.classList.contains('t-focus'))    openFocusMode(id);
    });
  });

  // Recommendation toggles
  document.getElementById('timeSelector')?.addEventListener('click', e => {
    const btn = e.target.closest('.sel-btn');
    if (!btn) return;
    document.querySelectorAll('#timeSelector .sel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    recState.time = Number(btn.dataset.value);
    renderRecommendation();
  });
  document.getElementById('energySelector')?.addEventListener('click', e => {
    const btn = e.target.closest('.sel-btn');
    if (!btn) return;
    document.querySelectorAll('#energySelector .sel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    recState.energy = btn.dataset.value;
    renderRecommendation();
  });
  document.getElementById('recToggleNext')?.addEventListener('click', () => {
    showNextRecs = !showNextRecs;
    renderRecommendation();
  });

  // Filters (All Tasks)
  document.getElementById('searchInput')?.addEventListener('input', e => {
    filterState.search = e.target.value; renderAllTaskList();
  });
  document.getElementById('filterCategory')?.addEventListener('change', e => {
    filterState.category = e.target.value; renderAllTaskList();
  });
  document.getElementById('filterUrgency')?.addEventListener('change', e => {
    filterState.urgency = e.target.value; renderAllTaskList();
  });
  document.getElementById('filterImportance')?.addEventListener('change', e => {
    filterState.importance = e.target.value; renderAllTaskList();
  });
  document.getElementById('filterTime')?.addEventListener('change', e => {
    filterState.time = e.target.value; renderAllTaskList();
  });
  document.getElementById('showSnoozed')?.addEventListener('change', e => {
    filterState.showSnoozed = e.target.checked; renderAllTaskList();
  });
  document.getElementById('resetFilters')?.addEventListener('click', () => {
    filterState = { search:'', category:'', urgency:'', importance:'', time:'', showSnoozed: false };
    document.getElementById('searchInput').value = '';
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterUrgency').value = '';
    document.getElementById('filterImportance').value = '';
    document.getElementById('filterTime').value = '';
    document.getElementById('showSnoozed').checked = false;
    renderAllTaskList();
  });

  // History filters
  ['historySearch','historyCategory','historyUrgency','historyImportance'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener(id === 'historySearch' ? 'input' : 'change', renderHistoryList);
  });
  document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    const n = tasks.filter(t => t.status === 'completed').length;
    if (!n) { showToast('No history to clear.'); return; }
    if (!confirm(`Clear ${n} completed tasks from history?`)) return;
    tasks = tasks.filter(t => t.status !== 'completed');
    saveTasks(); showToast('History cleared.', 'success'); renderHistoryList(); renderStats();
  });

  // Settings actions
  document.getElementById('exportBtn')?.addEventListener('click', exportData);
  document.getElementById('importFile')?.addEventListener('change', e => importData(e.target.files[0]));
  document.getElementById('clearAllBtn')?.addEventListener('click', clearAllData);
  document.getElementById('clearDeletedBtn')?.addEventListener('click', purgeDeletedTasks);
  document.getElementById('saveSyncSettingsBtn')?.addEventListener('click', saveSyncConfig);
  document.getElementById('syncToCloudBtn')?.addEventListener('click', syncToCloud);
  document.getElementById('fetchFromCloudBtn')?.addEventListener('click', fetchFromCloud);

  // Category management
  document.getElementById('addCategoryBtn')?.addEventListener('click', () => {
    const input = document.getElementById('newCategoryInput');
    if (addCategory(input.value)) {
      input.value = '';
      renderCategoryList();
      populateCategoryDropdowns();
    }
  });
  document.getElementById('newCategoryInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = document.getElementById('newCategoryInput');
      if (addCategory(input.value)) { input.value = ''; renderCategoryList(); populateCategoryDropdowns(); }
    }
  });
  document.getElementById('categoryList')?.addEventListener('click', e => {
    const btn = e.target.closest('.cat-del-btn');
    if (btn) deleteCategory(btn.dataset.cat);
  });
}

// ============================================================
// INIT
// ============================================================

function init() {
  loadTasks();
  loadCustomCats();
  const settings = loadSettings();

  // Dark mode: default ON for new users
  const darkMode = settings.darkMode !== false; // default to true
  applyTheme(darkMode);

  bindEvents();
  populateCategoryDropdowns();
  renderAll();

  // Pre-fill sync config inputs from LocalStorage
  const { syncUrl, syncToken } = getSyncConfig();
  const urlInput   = document.getElementById('syncUrlInput');
  const tokenInput = document.getElementById('syncTokenInput');
  if (urlInput   && syncUrl)   urlInput.value   = syncUrl;
  if (tokenInput && syncToken) tokenInput.value = syncToken;

  // Update last sync display
  const t = getLastSyncTime();
  const el = document.getElementById('lastSyncInfo');
  if (el && t) el.textContent = 'Last sync: ' + new Date(t).toLocaleString();
  updateSyncStatusDisplay();

  // Periodically restore expired snoozes (every 60 seconds)
  setInterval(() => {
    restoreExpiredSnoozes();
    renderTodayList();
    renderAllTaskList();
    renderRecommendation();
  }, 60000);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
