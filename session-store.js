/* ═══════════════════════════════════════════════════════════════════════
 *  v92.3 SESSION STORE — the WhatsApp session survives EVERY redeploy,
 *  automatically. No blob-copying, no QR re-scans after deploys.
 *
 *  THE PROBLEM (boss: "use the authentic session the ones which are
 *  already there on re deploy"): Render wipes the disk on every deploy,
 *  so auth_info/creds.json dies with the old container. The v70 fix
 *  needed the boss to copy a blob into Render env by hand. This module
 *  makes it AUTOMATIC:
 *
 *    1. When the bot is connected, the CURRENT authentic session is
 *       encrypted (AES-256-GCM) and pushed to ONE secret GitHub gist.
 *    2. On every boot with no local session, the bot pulls that gist,
 *       decrypts it, and restores — NO QR scan, the exact session that
 *       was already there comes back.
 *
 *  WHY A GIST (not a repo commit): every update would be a commit —
 *  hundreds of junk commits. A secret gist is unlisted (nobody finds it
 *  without the URL), versioned internally, and edits cost zero commits.
 *  The blob is ENCRYPTED on top, so even the gist content is useless
 *  without the key.
 *
 *  ENV (add once in Render):
 *    GITHUB_TOKEN    — a GitHub PAT (gist scope is enough). WITHOUT IT
 *                      the automatic backup cannot run (the bot will
 *                      log one clear hint).
 *    SESSION_SECRET  — recommended. Any long passphrase. Without it the
 *                      key is derived from ADMIN_PHONE (works, but the
 *                      phone is semi-known — set a real secret).
 *
 *  Dependency-free on purpose (crypto + global fetch, Node 18+).
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIST_FILE = 'breadbot-session-groups.enc.json';
const GIST_DESC = 'BreadBot WhatsApp session backup (AES-256-GCM encrypted, automatic)';

/* ── state surfaced on the panel via /admin/session-backup ──────────── */
const state = {
  pushedAt: 0,          /* last successful push (ms) */
  gistId: null,
  gistUrl: null,
  cloudTs: 0,           /* ts stored INSIDE the cloud blob */
  cloudSeenAt: 0,       /* when we last looked at the cloud */
  lastError: null,
  pushes: 0,
  restores: 0
};
function status(){
  return {
    configured: !!envToken(),
    secret: envSecret() ? 'SESSION_SECRET' : 'derived-from-admin-phone',
    secretStrong: !!envSecret(),
    pushedAt: state.pushedAt, pushes: state.pushes, restores: state.restores,
    gistId: state.gistId, gistUrl: state.gistUrl,
    cloudTs: state.cloudTs, cloudSeenAt: state.cloudSeenAt,
    lastError: state.lastError,
    gistFile: GIST_FILE
  };
}

/* ── config helpers ─────────────────────────────────────────────────── */
function envToken(){ return process.env.GITHUB_SESSION_TOKEN || process.env.GITHUB_TOKEN || ''; }
function envSecret(){ return process.env.SESSION_SECRET || ''; }
function adminPhone(){ return String(process.env.ADMIN_PHONE || '263777627210').replace(/\D/g, ''); }
function sessionSlot(){ return process.env.SESSION_SLOT || 'groups'; }

function ghHeaders(){
  const t = envToken();
  if (!t) {
    const e = new Error('GITHUB_TOKEN missing — add it in Render env once and the session backs itself up automatically');
    e.code = 'NO_TOKEN';
    throw e;
  }
  return {
    'Authorization': 'Bearer ' + t,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'breadbot-session-store',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/* ── encryption — AES-256-GCM, key = scrypt(SESSION_SECRET) ─────────── */
function encKey(){
  const material = envSecret() || (adminPhone() + ':breadbot-session-v1');
  return crypto.scryptSync(material, 'breadbot-session-salt-v1', 32);
}
function encryptEnvelope(filesPayload){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(filesPayload), cipher.final()]);
  return JSON.stringify({
    v: 1, slot: sessionSlot(), ts: Date.now(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  });
}
function decryptEnvelope(raw){
  try {
    const env = JSON.parse(raw);
    if (!env || !env.iv || !env.tag || !env.data) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
    const files = JSON.parse(out.toString('utf8'));
    /* v92.9.24: dead-marked blobs carry no creds.json — pass them
     * through so restoreLatest refuses them with the honest reason */
    if (files && files.dead === true) return { ts: env.ts || 0, files };
    if (!files || !files.files || !files.files['creds.json']) return null;
    return { ts: env.ts || 0, files };
  } catch (e) { return null; }
}

/* ── capture the auth folder (same shape as the panel's 💾 blob) ────── */
function captureFolder(folder){
  try {
    const p = path.join(folder, 'creds.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const creds = JSON.parse(raw);
    if (!creds || !creds.noiseKey) return null;
    /* v92.9.10: Baileys 7 can leave `registered` false while `me.id` IS set
     * (pairing complete, device registered) — the old gate silently kept
     * pushes at 0 through a whole WORKING session, so a 401 logout left
     * nothing to restore. me.id is proof of a finished pairing. */
    if (creds.registered === false && !(creds.me && creds.me.id)) return null;   /* QR shown but not scanned yet — nothing to back up */
    return JSON.stringify({ v: 1, files: { 'creds.json': raw } });
  } catch (e) { return null; }
}

/* ── GitHub gists (list once per process, then reuse the id) ────────── */
let gistCache = null;                                /* { id, updatedAt } */
async function findGist(H){
  if (gistCache) return gistCache;
  const r = await fetch('https://api.github.com/gists?per_page=100', { headers: H });
  if (!r.ok) throw new Error('gist list failed: HTTP ' + r.status);
  const list = await r.json();
  if (!Array.isArray(list)) throw new Error('gist list unexpected response');
  let best = null;
  for (const g of list){
    if (g && g.files && g.files[GIST_FILE]){
      if (!best || new Date(g.updated_at) > new Date(best.updated_at)) best = g;
    }
  }
  if (best){
    gistCache = { id: best.id, updatedAt: best.updated_at };
    state.gistId = best.id;
    state.gistUrl = best.html_url || ('https://gist.github.com/' + best.id);
  }
  return gistCache;
}

async function pushSessionBlob(folder){
  const payload = captureFolder(folder);
  if (!payload) return { ok: false, error: 'no registered creds.json on disk yet' };
  const content = encryptEnvelope(payload);
  const H = ghHeaders();                            /* throws NO_TOKEN when unset */
  try {
    const existing = await findGist(H);
    if (existing){
      const r = await fetch('https://api.github.com/gists/' + existing.id, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ files: { [GIST_FILE]: { content } } })
      });
      if (!r.ok) throw new Error('gist update failed: HTTP ' + r.status);
      state.pushedAt = Date.now(); state.pushes++;
      return { ok: true, action: 'updated', gistId: existing.id };
    }
    const r = await fetch('https://api.github.com/gists', {
      method: 'POST', headers: H,
      body: JSON.stringify({ description: GIST_DESC, public: false, files: { [GIST_FILE]: { content } } })
    });
    if (!r.ok) throw new Error('gist create failed: HTTP ' + r.status);
    const g = await r.json();
    gistCache = { id: g.id, updatedAt: g.updated_at };
    state.gistId = g.id;
    state.gistUrl = g.html_url || ('https://gist.github.com/' + g.id);
    state.pushedAt = Date.now(); state.pushes++;
    return { ok: true, action: 'created', gistId: g.id };
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message, noToken: e.code === 'NO_TOKEN' };
  }
}

async function fetchSessionBlob(){
  const H = ghHeaders();
  const existing = await findGist(H);
  if (!existing) return { ok: false, reason: 'no backup gist yet' };
  const r = await fetch('https://api.github.com/gists/' + existing.id, { headers: H });
  if (!r.ok) throw new Error('gist fetch failed: HTTP ' + r.status);
  const g = await r.json();
  const f = g.files && g.files[GIST_FILE];
  if (!f || !f.content) return { ok: false, reason: 'gist has no session file' };
  const dec = decryptEnvelope(f.truncated ? '' : f.content);
  if (!dec) return { ok: false, reason: 'decrypt failed — different SESSION_SECRET or corrupted blob' };
  state.cloudTs = dec.ts; state.cloudSeenAt = Date.now();
  return { ok: true, ts: dec.ts, files: dec.files };
}

/* ── restore at boot — call ONLY when no local creds exist ──────────── */
/* v92.9.24: PERSISTENT DEAD-MARK — Render's disk is ephemeral, so the
 * FRESH_REQUIRED file dies with every restart; the gist is the ONLY
 * store that survives. When the 401 self-heal marks the session dead,
 * the mark is pushed HERE — restoreLatest refuses it at every future
 * boot until a fresh pairing overwrites the gist with the live blob. */
async function markDeadSession(){
  try {
    /* v92.9.24: same encrypted push path as pushSessionBlob (findGist →
     * PATCH, or create when no gist exists yet) — upsert, never fork. */
    const content = encryptEnvelope(JSON.stringify({ v: 1, dead: true, deadAt: new Date().toISOString(), files: {} }));
    const H = ghHeaders();                            /* throws NO_TOKEN when unset */
    const existing = await findGist(H);
    if (existing){
      const r = await fetch('https://api.github.com/gists/' + existing.id, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ files: { [GIST_FILE]: { content } } })
      });
      if (!r.ok) throw new Error('gist update failed: HTTP ' + r.status);
    } else {
      const r = await fetch('https://api.github.com/gists', {
        method: 'POST', headers: H,
        body: JSON.stringify({ description: GIST_DESC + ' (DEAD-MARK)', public: false, files: { [GIST_FILE]: { content } } })
      });
      if (!r.ok) throw new Error('gist create failed: HTTP ' + r.status);
      const g = await r.json();
      gistCache = { id: g.id, updatedAt: g.updated_at };
    }
    state.deadMarks = (state.deadMarks || 0) + 1;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function restoreLatest(folder){
  const p = path.join(folder, 'creds.json');
  if (fs.existsSync(p)) return { ok: false, reason: 'local session already on disk' };
  const r = await fetchSessionBlob();
  if (!r.ok) return r;
  /* v92.9.24: the 401 self-heal marked this session dead — refuse it */
  if (r.files && r.files.dead === true){
    return { ok: false, reason: 'dead-mark: the gist session was logged out by WhatsApp — fresh QR required' };
  }
  const raw = r.files.files['creds.json'];
  const creds = JSON.parse(raw);
  if (!creds || !creds.noiseKey) return { ok: false, reason: 'cloud blob is not a valid session' };
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(p, raw);
  state.restores++;
  return { ok: true, ts: r.ts };
}

/* ── auto-push scheduling (debounced — creds.update fires often) ────── */
let pushTimer = null;
let lastPushedHash = null;
function credsHash(folder){
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'creds.json'))).digest('hex'); }
  catch (e) { return null; }
}
function schedulePush(folder, delayMs){
  if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    const h = credsHash(folder);
    if (!h || h === lastPushedHash) return;         /* nothing changed since last push */
    const r = await pushSessionBlob(folder);
    if (r.ok){ lastPushedHash = h; }
  }, delayMs || 90000);
  if (pushTimer.unref) pushTimer.unref();
}
/* hourly keep-alive: pushes only when creds.json actually changed */
function startAutoBackup(folder){
  setInterval(async () => {
    try {
      const h = credsHash(folder);
      if (!h || h === lastPushedHash) return;
      const r = await pushSessionBlob(folder);
      if (r.ok) lastPushedHash = h;
    } catch (e) { /* panel shows status() */ }
  }, 60 * 60 * 1000).unref();
}

module.exports = {
  GIST_FILE, status,
  captureFolder, encryptEnvelope, decryptEnvelope,
  pushSessionBlob, fetchSessionBlob, restoreLatest, markDeadSession,
  schedulePush, startAutoBackup
};
