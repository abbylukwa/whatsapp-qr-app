'use strict';
/* ════════════════════════════════════════════════════════════════
 *  videoScheduler.js — BreadBot v73 MAIN-GROUP VIDEO SCHEDULER
 * ════════════════════════════════════════════════════════════════
 *  WHAT IT DOES
 *  - Posts NSFW videos to ONE main group on a fixed timetable:
 *      6 runs/day (Harare time = UTC+2)
 *      15 videos per run (env SCHED_PER_RUN)
 *  - HUMAN PACING: every send waits a random 25–55s
 *  - DIFFERENT QUERY → DIFFERENT VIDEO: every video uses a unique
 *    query from the QueryEngine (time-aware, varied, never repeated)
 *  - DEDUP: Media hashes prevent sending the same video twice
 *  - CROSS-POST HOOK: every video sent triggers onVideoSent() for
 *    Twitter NSFW cross-posting
 *  - SURVIVES RESTARTS: state persists in data/video-scheduler.json
 *
 *  ADMIN COMMANDS (wired in server.js):
 *      !sched                 status
 *      !sched here            set THIS group as the main group
 *      !sched on | off        enable / disable posting
 *      !sched test            send ONE video to the main group now
 *      !sched run             trigger a full 15-video run now
 *      !sched queries         show the variety pool
 * ════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── Config (env-overridable) ── */
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);
const SCHED_HOURS     = (process.env.SCHED_HOURS || '0,4,8,12,16,20')
    .split(',').map(h => parseInt(h, 10)).filter(h => h >= 0 && h <= 23);
const PER_RUN         = Math.max(1, parseInt(process.env.SCHED_PER_RUN || '15', 10));
const DELAY_MIN_MS    = Math.max(1000, parseInt(process.env.SCHED_DELAY_MIN_MS || '25000', 10));
const DELAY_MAX_MS    = Math.max(DELAY_MIN_MS, parseInt(process.env.SCHED_DELAY_MAX_MS || '55000', 10));

/* ── State ── */
const STATE_FILE = path.join(__dirname, 'data', 'video-scheduler.json');
const state = {
    groupJid: process.env.SCHED_GROUP_JID || '',
    enabled:  process.env.SCHED_ENABLED === '1',  // DEFAULT OFF — admin must !sched on
    lastHourKey: '',
    queryCursor: 0,
    sentCount: 0,
    runCount: 0,
    lastRun: null,
    history: [],             /* [{ q, title, source, hash, ts }] */
    sentMediaHashes: []      /* MD5 hashes of all sent media for dedup */
};
let deps = null;
let timer = null;
let running = false;

/* ── QueryEngine (lazy-loaded to avoid circular deps) ── */
let QueryEngine = null;
let queryEngine = null;
function getQueryEngine() {
    if (!queryEngine) {
        try {
            QueryEngine = require('./core/content/query-engine');
            queryEngine = new QueryEngine({ log: deps ? deps.log : console.log });
            // Load persisted query state
            if (state.queryEngineState) {
                queryEngine.loadState(state.queryEngineState);
            }
        } catch (e) {
            // Fallback to default queries if query engine not available
        }
    }
    return queryEngine;
}

/* ── Default queries (fallback) ── */
const DEFAULT_QUERIES = [
    'ebony twerk', 'latina booty', 'african porn', 'big booty twerking',
    'ebony dance', 'nigerian twerk', 'south african porn', 'ghana porn',
    'booty shake', 'ebony threesome', 'latina porn', 'ebony bbw',
    'african booty', 'sexy dance', 'twerking compilation', 'ebony lesbian',
    'kenyan porn', 'ebony milf', 'booty clapping', 'african ebony',
    'zimbabwean twerk', 'mapouka dance', 'ebony homemade', 'african amateur',
    'thick ebony solo', 'ghanaian booty', 'naija dance', 'ebony oil',
    'african lap dance', 'ebony bbw twerk', 'latina milf', 'african couples',
    'ebony shower', 'mzansi booty', 'kenyan twerk', 'ebony strip'
];
let QUERIES = (process.env.SCHED_QUERIES || '').split(',').map(s => s.trim()).filter(Boolean);
if (QUERIES.length < 5) QUERIES = DEFAULT_QUERIES;

/* ── Persistence ── */
function loadState(){
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const saved = JSON.parse(raw);
        Object.assign(state, saved);
        if (!Array.isArray(state.history)) state.history = [];
        if (!Array.isArray(state.sentMediaHashes)) state.sentMediaHashes = [];
    } catch (e) { /* first boot */ }
}
function saveState(){
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        // Persist query engine state too
        if (queryEngine) {
            state.queryEngineState = queryEngine.exportState();
        }
        // Cap sentMediaHashes at 5000 to avoid unbounded growth
        if (state.sentMediaHashes.length > 5000) {
            state.sentMediaHashes = state.sentMediaHashes.slice(-3000);
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    } catch (e) { if (deps && deps.log) deps.log('warn', 'sched', 'save: ' + e.message); }
}

/* ── Time helpers (Harare) ── */
function harareHour(now){
    const d = now instanceof Date ? now : new Date();
    return (d.getUTCHours() + TZ_OFFSET_HOURS) % 24;
}
function hourKey(now){
    const d = now instanceof Date ? now : new Date();
    const shifted = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
    return shifted.toISOString().slice(0, 13);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = () => DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

/* ── Query rotation ── */
function nextQuery(){
    // Use QueryEngine if available (time-aware, varied, deduped)
    const engine = getQueryEngine();
    if (engine) {
        return engine.generate({ hour: harareHour() });
    }
    // Fallback: round-robin from static pool
    const q = QUERIES[state.queryCursor % QUERIES.length];
    state.queryCursor = (state.queryCursor + 1) % QUERIES.length;
    return q;
}

/* ── Media hash for dedup ── */
function hashMedia(vid) {
    const key = (vid.mediaUrl || vid.url || '') + '|' + (vid.title || '') + '|' + (vid.source || '');
    return crypto.createHash('md5').update(key).digest('hex').substring(0, 16);
}

/* ── The actual run: n videos, different query each, human delays ── */
async function runOnce(n = PER_RUN, quiet = false){
    if (!deps) throw new Error('scheduler not initialised');
    if (!state.groupJid) { if (!quiet) deps.log('warn', 'sched', 'no main group set — use !sched here'); return { ok: false, error: 'no main group set' }; }
    if (running) return { ok: false, error: 'a run is already in progress' };
    running = true;
    const summary = { at: new Date().toISOString(), sent: 0, failed: 0, deduped: 0, queries: [] };
    try {
        if (!quiet) await deps.sendText(state.groupJid, '🎬 Video drop starting — ' + Math.min(n, QUERIES.length) + ' videos, one every ' + Math.round(DELAY_MIN_MS / 1000) + '-' + Math.round(DELAY_MAX_MS / 1000) + 's.');

        for (let i = 0; i < n; i++) {
            const query = nextQuery();
            summary.queries.push(query);

            // Exclude recent titles from history
            const exclude = state.history.slice(-15).map(h => h.title).filter(Boolean);

            let vid = null;
            try {
                vid = await deps.fetchVideo(query, exclude);
            } catch (e) { deps.log('warn', 'sched', 'fetch "' + query + '": ' + e.message); }

            if (vid && vid.ok) {
                // DEDUP CHECK: skip if we already sent this exact media
                const mediaHash = hashMedia(vid);
                if (state.sentMediaHashes.includes(mediaHash)) {
                    summary.deduped++;
                    deps.log('info', 'sched', 'dedup: skipping "' + (vid.title || '').slice(0, 40) + '" (already sent)');
                    continue; // Skip to next video, don't count as failed
                }

                try {
                    await deps.sendVideo(state.groupJid, vid, '🎬 ' + (vid.title || query).slice(0, 90));
                    summary.sent++;
                    state.sentCount++;

                    // Record in history with hash
                    state.history.push({ q: query, title: vid.title || '', source: vid.source || '', hash: mediaHash, ts: Date.now() });
                    if (state.history.length > 60) state.history = state.history.slice(-40);

                    // Add to dedup set
                    state.sentMediaHashes.push(mediaHash);

                    deps.log('success', 'sched', `run ${summary.sent}/${n}: "${query}" → ${(vid.title || '').slice(0, 50)}`);

                    // ═══ NO MORE CROSS-POST HOOK ════════════════════════════
                    // Twitter is now INDEPENDENT from WhatsApp.
                    // No onVideoSent() hook — Twitter posts on its own schedule.
                    // WhatsApp NSFW stays in WhatsApp only.
                } catch (e) {
                    summary.failed++;
                    deps.log('error', 'sched', 'send "' + query + '": ' + e.message);
                }
            } else {
                summary.failed++;
                deps.log('warn', 'sched', 'no video for "' + query + '"' + (vid && vid.error ? ' (' + vid.error.slice(0, 60) + ')' : ''));
            }

            /* human-like pause between sends */
            if (i < n - 1) {
                const d = humanDelay();
                await sleep(d);
            }
        }

        state.runCount++;
        state.lastRun = summary;
        saveState();
        if (!quiet) await deps.sendText(state.groupJid, '✅ Drop done — ' + summary.sent + ' sent' + (summary.failed ? ', ' + summary.failed + ' skipped' : '') + (summary.deduped ? ', ' + summary.deduped + ' deduped' : '') + '.');
        deps.log('info', 'sched', `run complete: ${summary.sent}/${n} sent, ${summary.deduped} deduped`);
        return { ok: true, ...summary };
    } finally {
        running = false;
    }
}

/* ── Minute tick: fires a run when the Harare hour matches a slot ── */
async function tick(){
    if (!state.enabled || running) return;
    const hk = hourKey();
    if (state.lastHourKey === hk) return;
    if (!SCHED_HOURS.includes(harareHour())) return;
    state.lastHourKey = hk;
    saveState();
    deps.log('info', 'sched', `scheduled run starting (Harare ${String(harareHour()).padStart(2, '0')}:00)`);
    try { await runOnce(PER_RUN); } catch (e) { deps.log('error', 'sched', 'run: ' + e.message); }
}

/* ── Member "video <query>" requests — rate limited per user ── */
const userRequests = new Map();
const USER_LIMIT = 3;
const USER_WINDOW_MS = 3600 * 1000;
function canRequest(userId){
    const now = Date.now();
    const arr = (userRequests.get(userId) || []).filter(ts => now - ts < USER_WINDOW_MS);
    userRequests.set(userId, arr);
    return arr.length < USER_LIMIT;
}
function recordRequest(userId){ (userRequests.get(userId) || []).push(Date.now()); }

/* ── Init ── */
function initVideoScheduler(d){
    deps = d;
    loadState();
    if (state.groupJid) deps.log('info', 'sched', `state loaded — group ${state.groupJid}, ${state.enabled ? 'ON' : 'off'}, ${state.runCount} runs / ${state.sentCount} videos sent / ${state.sentMediaHashes.length} unique`);
    timer = setInterval(() => { tick().catch(e => deps.log('error', 'sched', 'tick: ' + e.message)); }, 60 * 1000);
    Object.assign(module.exports, api);
    return api;
}

/* ── Public API ── */
const api = {
    setGroup(jid){ state.groupJid = String(jid || ''); saveState(); return state.groupJid; },
    enable(){ state.enabled = true; saveState(); },
    disable(){ state.enabled = false; saveState(); },
    isEnabled(){ return !!state.enabled; },
    getGroup(){ return state.groupJid; },
    isRunning(){ return running; },
    status(){
        return {
            enabled: state.enabled,
            groupJid: state.groupJid,
            hours: SCHED_HOURS,
            perRun: PER_RUN,
            delaySec: Math.round(DELAY_MIN_MS / 1000) + '-' + Math.round(DELAY_MAX_MS / 1000),
            queryCount: QUERIES.length,
            nextHourHarare: SCHED_HOURS.map(h => String(h).padStart(2, '0') + ':00').join(', '),
            harareHour: harareHour(),
            runs: state.runCount,
            sent: state.sentCount,
            uniqueMedia: state.sentMediaHashes.length,
            lastRun: state.lastRun,
            recent: state.history.slice(-5).map(h => h.title || h.q),
            running,
            queryEngineStats: getQueryEngine()?.getStats()
        };
    },
    runOnce,
    canRequest,
    recordRequest,
    _state: state,
    _stop(){ if (timer) clearInterval(timer); timer = null; },
    _queries: () => QUERIES.slice(),
};

module.exports = {
    ...api,
    initVideoScheduler,
    PER_RUN, SCHED_HOURS, DEFAULT_QUERIES
};
