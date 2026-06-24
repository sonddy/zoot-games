/**
 * Persistence layer for bet & refund state.
 *
 * Uses Firestore when FIREBASE_SERVICE_ACCOUNT is set; otherwise no-ops so
 * the server still runs locally without Firebase. Every function is safe
 * to call regardless of whether the backing store is configured.
 *
 * Collections:
 *   - match_queue       : open PvP bet entries waiting for an opponent
 *   - sports_bets       : sports/esports bets (open + matched)
 *   - active_rooms      : games currently being played (so we can refund on restart)
 *   - pending_refunds   : refund attempts that have failed and need retrying
 */

const HAS_FIREBASE = !!process.env.FIREBASE_SERVICE_ACCOUNT;
let db = null;
let enabled = false;

try {
  if (HAS_FIREBASE) {
    const fb = require('./firebase');
    db = fb.db;
    enabled = true;
  }
} catch (e) {
  console.warn('Persistence: Firebase init failed, falling back to in-memory only:', e.message);
}

function isEnabled() { return enabled; }

function colRef(name) { return db.collection(name); }

// Firestore quota errors (RESOURCE_EXHAUSTED, gRPC code 8) can fire on every
// single call once the daily free-tier cap is hit. Without throttling they bury
// the logs (hundreds of identical lines). Collapse them to one line per window.
const QUOTA_LOG_WINDOW_MS = 5 * 60 * 1000;
let _lastQuotaLogAt = 0;
let _quotaSuppressed = 0;

function _isQuotaError(e) {
  return !!e && (e.code === 8 || /RESOURCE_EXHAUSTED|quota exceeded/i.test(e.message || ''));
}

function logPersistenceError(label, e) {
  if (_isQuotaError(e)) {
    _quotaSuppressed++;
    const now = Date.now();
    if (now - _lastQuotaLogAt < QUOTA_LOG_WINDOW_MS) return;
    const extra = _quotaSuppressed > 1 ? ' (+' + (_quotaSuppressed - 1) + ' similar suppressed in last 5m)' : '';
    console.error('Persistence: Firestore quota exceeded — operations failing until quota resets. Last at ' + label + extra);
    _lastQuotaLogAt = now;
    _quotaSuppressed = 0;
    return;
  }
  console.error('Persistence ' + label + ':', e.message);
}

async function safe(promise, label) {
  try { return await promise; }
  catch (e) { logPersistenceError(label, e); return null; }
}

// ── match_queue ────────────────────────────────────────────────────────────
async function saveQueueEntry(id, entry) {
  if (!enabled) return;
  await safe(colRef('match_queue').doc(id).set({ ...entry, _updated: Date.now() }), 'saveQueueEntry');
}
async function removeQueueEntry(id) {
  if (!enabled) return;
  await safe(colRef('match_queue').doc(id).delete(), 'removeQueueEntry');
}
async function loadQueue() {
  if (!enabled) return [];
  const snap = await safe(colRef('match_queue').get(), 'loadQueue');
  if (!snap) return [];
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ── sports_bets ────────────────────────────────────────────────────────────
async function saveSportsBet(id, bet) {
  if (!enabled) return;
  await safe(colRef('sports_bets').doc(id).set({ ...bet, _updated: Date.now() }), 'saveSportsBet');
}
async function removeSportsBet(id) {
  if (!enabled) return;
  await safe(colRef('sports_bets').doc(id).delete(), 'removeSportsBet');
}
async function loadSportsBets() {
  if (!enabled) return [];
  const snap = await safe(colRef('sports_bets').get(), 'loadSportsBets');
  if (!snap) return [];
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ── active_rooms ──────────────────────────────────────────────────────────
async function saveActiveRoom(id, room) {
  if (!enabled) return;
  await safe(colRef('active_rooms').doc(id).set({ ...room, _updated: Date.now() }), 'saveActiveRoom');
}
async function removeActiveRoom(id) {
  if (!enabled) return;
  await safe(colRef('active_rooms').doc(id).delete(), 'removeActiveRoom');
}
async function loadActiveRooms() {
  if (!enabled) return [];
  const snap = await safe(colRef('active_rooms').get(), 'loadActiveRooms');
  if (!snap) return [];
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ── pending_refunds ───────────────────────────────────────────────────────
async function addPendingRefund(refund) {
  if (!enabled) return null;
  const doc = await safe(colRef('pending_refunds').add({
    ...refund,
    retries: refund.retries || 0,
    createdAt: refund.createdAt || Date.now(),
    _updated: Date.now(),
  }), 'addPendingRefund');
  return doc ? doc.id : null;
}
async function listPendingRefunds(limit) {
  if (!enabled) return [];
  const snap = await safe(colRef('pending_refunds').orderBy('createdAt').limit(limit || 25).get(), 'listPendingRefunds');
  if (!snap) return [];
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}
async function removePendingRefund(id) {
  if (!enabled) return;
  await safe(colRef('pending_refunds').doc(id).delete(), 'removePendingRefund');
}
async function incrementRefundRetry(id, lastError) {
  if (!enabled) return;
  const docRef = colRef('pending_refunds').doc(id);
  await safe(db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return;
    const data = snap.data();
    tx.update(docRef, {
      retries: (data.retries || 0) + 1,
      lastError: lastError || null,
      _updated: Date.now(),
    });
  }), 'incrementRefundRetry');
}

// ── used_signatures (replay protection that survives restarts) ──────────────
// Atomically claim a deposit signature. Returns:
//   true  → newly claimed (caller may proceed)
//   false → already claimed (replay — caller must reject)
//   null  → store unavailable / unknown error (caller falls back to in-memory)
async function tryConsumeSignature(signature) {
  if (!enabled) return null;
  try {
    // .create() fails if the doc already exists → gives us an atomic claim.
    await colRef('used_signatures').doc(signature).create({ usedAt: Date.now() });
    return true;
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
    logPersistenceError('tryConsumeSignature', e);
    return null;
  }
}

module.exports = {
  isEnabled,
  saveQueueEntry, removeQueueEntry, loadQueue,
  saveSportsBet, removeSportsBet, loadSportsBets,
  saveActiveRoom, removeActiveRoom, loadActiveRooms,
  addPendingRefund, listPendingRefunds, removePendingRefund, incrementRefundRetry,
  tryConsumeSignature,
};
