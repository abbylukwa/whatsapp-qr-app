/* ═══════════════════════════════════════════════════════════════════════
 *  v90 MEDIA QUEUE — the boss: "many members can request at the same time
 *  or they can be having a conversation … the bot must read all that."
 *
 *  · GLOBAL CONCURRENCY CAP — max 2 media fetches at once (downloads are
 *    network-bound; 10 parallel scrapers = timeouts + Render cold death)
 *  · COALESCING — two members asking the SAME thing at once share ONE
 *    fetch; the second gets "already fetching" instead of a double send
 *  · PER-CHAT FIFO + round-robin across chats — one spammy group can't
 *    starve DMs, and conversation continues while the queue drains
 *
 *  v92.9.9g FLOODPROOF — the 12-commands-per-second contract:
 *  the old queue grew WITHOUT LIMIT. 12 media cmds/s = 720/min against a
 *  service rate of ~1.5/min (2 active × ~80s hunts) — 1000 queued jobs =
 *  10-hour backlog and a 512MB OOM long before that. Now the queue is a
 *  BOUNDED waiting room, not an infinite parking lot:
 *    · MAX_PENDING     — total queued jobs (default 10). Full → the new
 *                        request is refused INSTANTLY (run() synthesizes
 *                        {ok:false, error:'queue full …'} so every caller's
 *                        existing failure branch replies "busy" — no job
 *                        object, no memory held, no silent pile-up).
 *    · MAX_PER_CHAT    — one chat can hold 2 slots; a spammy chat can't
 *                        fill the whole room for everyone else.
 *    · JOB_TTL         — a job waiting >240s is rejected at pump time
 *                        ("moved on, resend") — nobody wants a song they
 *                        asked for 5 minutes ago, and stale jobs kept the
 *                        room full for FRESH requests.
 *  Memory per queued job is a tiny closure — the BOUND is what protects
 *  the 512MB box, not the closure size.
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const MAX_ACTIVE = parseInt(process.env.MEDIA_QUEUE_CONCURRENCY || '2', 10);
const COALESCE_MS = 90 * 1000;         /* same request window */
const MAX_PENDING = Math.max(2, parseInt(process.env.MEDIA_QUEUE_MAX_PENDING || '10', 10));
const MAX_PER_CHAT = Math.max(1, parseInt(process.env.MEDIA_QUEUE_MAX_PER_CHAT || '2', 10));
const JOB_TTL_MS = Math.max(30, parseInt(process.env.MEDIA_QUEUE_JOB_TTL || '240', 10)) * 1000;
const queues = new Map();              /* chatJid -> [{key, fn, resolve, reject, enqAt}] */
const inflight = new Map();            /* key -> { at, promise } */
let active = 0;
let refusedCount = 0, ttlExpiredCount = 0;
let log = function(){};

function normKey(chatJid, kind, query){
  return chatJid + '|' + kind + '|' + String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}
function queueLen(chatJid){ return (queues.get(chatJid) || []).length; }
function pending(){ let n = 0; for (const q of queues.values()) n += q.length; return n + active; }

function pump(){
  /* v92.9.9g: first — evict stale waiters so the room never fills with
   * jobs nobody is still waiting for */
  const now = Date.now();
  for (const [chatJid, q] of queues){
    for (let i = q.length - 1; i >= 0; i--){
      if (now - q[i].enqAt > JOB_TTL_MS){
        const stale = q.splice(i, 1)[0];
        ttlExpiredCount++;
        log('warn', 'queue', 'job TTL ' + Math.round(JOB_TTL_MS / 1000) + 's exceeded — refusing stale request (' + stale.key + ')');
        try { stale.resolve({ __refused: 'stale', error: 'The queue moved on (waited too long) — please resend your request.' }); } catch (e) {}
      }
    }
    if (!q.length) queues.delete(chatJid);
  }
  while (active < MAX_ACTIVE){
    /* round-robin: pick the chat whose head waited longest */
    let pick = null, pickChat = null;
    for (const [chatJid, q] of queues){
      if (q.length && (!pick || q[0].enqAt < pick.enqAt)){ pick = q[0]; pickChat = chatJid; }
    }
    if (!pick) return;
    const q = queues.get(pickChat);
    q.shift();
    if (!q.length) queues.delete(pickChat);
    active++;
    /* coalesced shared job resolves everyone with the same result */
    const shared = inflight.get(pick.key);
    const p = shared && (Date.now() - shared.at) < COALESCE_MS
      ? shared.promise
      : Promise.resolve().then(pick.fn);
    if (!shared || (Date.now() - shared.at) >= COALESCE_MS){
      inflight.set(pick.key, { at: Date.now(), promise: p });
    }
    p.then(v => pick.resolve(v))
     .catch(e => pick.reject(e))
     .finally(() => {
       active--;
       if (inflight.get(pick.key) && inflight.get(pick.key).promise === p) inflight.delete(pick.key);
       pump();
     });
  }
}

/* enqueue(chatJid, kind, query, fn) → Promise<{shared, position, result}>
 * v92.9.9g: a FULL room refuses instantly — the caller gets
 * { __refused:'full'|'perchat', error } instead of a queued promise, so
 * the user hears "busy, N ahead" right away instead of waiting forever. */
function enqueue(chatJid, kind, query, fn){
  const key = normKey(chatJid, kind, query);
  /* same request already running → share its result */
  const shared = inflight.get(key);
  if (shared && (Date.now() - shared.at) < COALESCE_MS){
    log('info', 'queue', 'coalesced duplicate request ' + key);
    return shared.promise.then(result => ({ shared: true, position: 0, result }));
  }
  /* bounded waiting room — refuse BEFORE allocating anything */
  const q0 = queues.get(chatJid) || [];
  if (pending() >= MAX_PENDING + MAX_ACTIVE){
    refusedCount++;
    log('warn', 'queue', 'queue FULL (' + pending() + '/' + (MAX_PENDING + MAX_ACTIVE) + ') — refusing "' + key + '" instantly (no memory held)');
    return Promise.resolve({ shared: false, refused: 'full', position: 0,
      result: { ok: false, error: 'Busy — ' + pending() + ' media jobs ahead (serves ~1-2/min on the free tier). Resend in a few minutes.' } });
  }
  if (q0.length >= MAX_PER_CHAT){
    refusedCount++;
    log('warn', 'queue', 'per-chat cap (' + q0.length + '/' + MAX_PER_CHAT + ') — refusing "' + key + '" (chat already has jobs waiting)');
    return Promise.resolve({ shared: false, refused: 'perchat', position: 0,
      result: { ok: false, error: 'You already have ' + q0.length + ' request(s) waiting — let them finish first.' } });
  }
  return new Promise((resolve, reject) => {
    let q = queues.get(chatJid);
    if (!q){ q = []; queues.set(chatJid, q); }
    const position = q.length + active + 1;
    q.push({ key, fn, resolve, reject, enqAt: Date.now() });
    pump();
    resolve.__position = position;   /* informational only */
  }).then(r => ({ shared: false, position: 0, result: r }))
    .catch(e => { throw e; });
}

/* convenience: run a media job through the queue, with the caller deciding
 * what to do with { shared, result }.
 * v92.9.9g: refusals come back as result.ok=false — every existing caller
 * checks .ok, so ALL call sites get honest "busy" replies for free. */
function run(chatJid, kind, query, fn){
  return enqueue(chatJid, kind, query, fn);
}

function init(logFn){ log = logFn || function(){}; return { maxActive: MAX_ACTIVE, coalesceMs: COALESCE_MS, maxPending: MAX_PENDING, maxPerChat: MAX_PER_CHAT, jobTtlMs: JOB_TTL_MS }; }

function stats(){
  return { pending: pending(), active: active, maxActive: MAX_ACTIVE, maxPending: MAX_PENDING + MAX_ACTIVE,
           perChat: MAX_PER_CHAT, ttlSec: Math.round(JOB_TTL_MS / 1000), chats: queues.size,
           refused: refusedCount, ttlExpired: ttlExpiredCount };
}

module.exports = { init, run, enqueue, pending, queueLen, stats, MAX_ACTIVE };
