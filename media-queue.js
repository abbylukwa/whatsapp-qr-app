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
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const MAX_ACTIVE = parseInt(process.env.MEDIA_QUEUE_CONCURRENCY || '2', 10);
const COALESCE_MS = 90 * 1000;         /* same request window */
const queues = new Map();              /* chatJid -> [{key, fn, resolve, reject, enqAt}] */
const inflight = new Map();            /* key -> { at, promise } */
let active = 0;
let log = function(){};

function normKey(chatJid, kind, query){
  return chatJid + '|' + kind + '|' + String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}
function queueLen(chatJid){ return (queues.get(chatJid) || []).length; }
function pending(){ let n = 0; for (const q of queues.values()) n += q.length; return n + active; }

function pump(){
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

/* enqueue(chatJid, kind, query, fn) → Promise<{shared, position, result}> */
function enqueue(chatJid, kind, query, fn){
  const key = normKey(chatJid, kind, query);
  /* same request already running → share its result */
  const shared = inflight.get(key);
  if (shared && (Date.now() - shared.at) < COALESCE_MS){
    log('info', 'queue', 'coalesced duplicate request ' + key);
    return shared.promise.then(result => ({ shared: true, position: 0, result }));
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
 * what to do with { shared, result } */
function run(chatJid, kind, query, fn){
  return enqueue(chatJid, kind, query, fn);
}

function init(logFn){ log = logFn || function(){}; return { maxActive: MAX_ACTIVE, coalesceMs: COALESCE_MS }; }

module.exports = { init, run, enqueue, pending, queueLen, MAX_ACTIVE };
