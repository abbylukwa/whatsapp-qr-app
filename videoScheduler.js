'use strict';
/* ════════════════════════════════════════════════════════════════
 *  videoScheduler.js — BreadBot v72 MAIN-GROUP VIDEO SCHEDULER
 * ════════════════════════════════════════════════════════════════
 *  WHAT IT DOES
 *  - Posts NSFW videos to ONE main group on a fixed timetable:
 *      6 runs/day (Harare time = UTC+2, follows the bot's TZ_OFFSET_HOURS)
 *      15 videos per run (env SCHED_PER_RUN)
 *  - HUMAN PACING: every send waits a random 25–55s ("download time
 *    delay") so the group never sees a machine-gun burst.
 *  - DIFFERENT QUERY → DIFFERENT VIDEO: every video in a run comes
 *    from a DIFFERENT query, picked round-robin from a 20-query
 *    variety pool; already-sent titles are passed to the scraper as
 *    an exclude list, and the scraper keeps its own recent-clip list.
 *  - SURVIVES RESTARTS: state (group, on/off, last hour, history)
 *    persists in data/video-scheduler.json.
 *  - FULLY INJECTABLE for tests: initVideoScheduler(deps) takes
 *    sendVideo / fetchVideo / log — no WhatsApp needed to test.
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

/* ── Config (env-overridable) ── */
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);   /* 2 = Harare (CAT) */
const SCHED_HOURS     = (process.env.SCHED_HOURS || '0,4,8,12,16,20')       /* 6 runs/day, Harare local */
    .split(',').map(h => parseInt(h, 10)).filter(h => h >= 0 && h <= 23);
const PER_RUN         = Math.max(1, parseInt(process.env.SCHED_PER_RUN || '15', 10));
const DELAY_MIN_MS    = Math.max(1000, parseInt(process.env.SCHED_DELAY_MIN_MS || '25000', 10));
const DELAY_MAX_MS    = Math.max(DELAY_MIN_MS, parseInt(process.env.SCHED_DELAY_MAX_MS || '55000', 10));

/* ── Variety pool — every scheduled video uses a DIFFERENT query ── */
const DEFAULT_QUERIES = [
    'ebony twerk', 'latina booty', 'african porn', 'big booty twerking',
    'ebony dance', 'nigerian twerk', 'south african porn', 'ghana porn',
    'booty shake', 'ebony threesome', 'latina porn', 'ebony bbw',
    'african booty', 'sexy dance', 'twerking compilation', 'ebony lesbian',
    'kenyan porn', 'ebony milf', 'booty clapping', 'african ebony'
];
let QUERIES = (process.env.SCHED_QUERIES || '').split(',').map(s => s.trim()).filter(Boolean);
if (QUERIES.length < 5) QUERIES = DEFAULT_QUERIES;

/* ── State ── */
const STATE_FILE = path.join(__dirname, 'data', 'video-scheduler.json');
const state = {
    groupJid: process.env.SCHED_GROUP_JID || '',
    enabled:  process.env.SCHED_ENABLED === '1',
    lastHourKey: '',            /* 'YYYY-MM-DDTHH' guard — one run per scheduled hour */
    queryCursor: 0,             /* round-robin position in QUERIES */
    sentCount: 0,
    runCount: 0,
    lastRun: null,              /* { at, sent, failed, queries:[...] } */
    history: []                 /* [{ q, title, source, ts }] — feeds the exclude list */
};
let deps = null;                /* { sendVideo, fetchVideo, log, now } */
let timer = null;
let running = false;

/* ── Persistence ── */
function loadState(){
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const saved = JSON.parse(raw);
        Object.assign(state, saved, {});
        if (!Array.isArray(state.history)) state.history = [];
    } catch (e) { /* first boot — defaults */ }
}
function saveState(){
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    } catch (e) { if (deps && deps.log) deps.log('warn', 'sched', 'save: ' + e.message); }
}

/* ── Time helpers (Harare) ── */
function harareHour(now){
    const d = now instanceof Date ? now : (deps && deps.now ? deps.now() : new Date());
    return (d.getUTCHours() + TZ_OFFSET_HOURS) % 24;
}
function hourKey(now){
    const d = now instanceof Date ? now : (deps && deps.now ? deps.now() : new Date());
    /* shift by TZ offset so the key rolls over at Harare midnight */
    const shifted = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
    return shifted.toISOString().slice(0, 13);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = () => DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

/* ── Query rotation: every video gets a DIFFERENT query ── */
function nextQuery(){
    const q = QUERIES[state.queryCursor % QUERIES.length];
    state.queryCursor = (state.queryCursor + 1) % QUERIES.length;
    return q;
}

/* ── The actual run: n videos, different query each, human delays ── */
async function runOnce(n = PER_RUN, quiet = false){
    if (!deps) throw new Error('scheduler not initialised');
    if (!state.groupJid) { if (!quiet) deps.log('warn', 'sched', 'no main group set — use !sched here'); return { ok: false, error: 'no main group set (use !sched here)' }; }
    if (running) return { ok: false, error: 'a run is already in progress' };
    running = true;
    const summary = { at: new Date().toISOString(), sent: 0, failed: 0, queries: [], delays: [] };
    try {
        if (!quiet) await deps.sendText(state.groupJid, '🎬 Video drop starting — ' + Math.min(n, QUERIES.length) + ' videos, one every ' + Math.round(DELAY_MIN_MS / 1000) + '-' + Math.round(DELAY_MAX_MS / 1000) + 's. Sit back.');
        for (let i = 0; i < n; i++) {
            const query = nextQuery();
            summary.queries.push(query);
            /* v72.1: exclude is computed PER VIDEO from the live history —
             * video #2 must not repeat video #1, etc. */
            const exclude = state.history.slice(-10).map(h => h.title).filter(Boolean);
            let vid = null;
            try {
                vid = await deps.fetchVideo(query, exclude);
            } catch (e) { deps.log('warn', 'sched', 'fetch "' + query + '": ' + e.message); }
            if (vid && vid.ok) {
                try {
                    await deps.sendVideo(state.groupJid, vid, '🎬 ' + (vid.title || query).slice(0, 90));
                    summary.sent++;
                    state.sentCount++;
                    state.history.push({ q: query, title: vid.title || '', source: vid.source || '', ts: Date.now() });
                    if (state.history.length > 60) state.history = state.history.slice(-40);
                    deps.log('success', 'sched', `run ${summary.sent}/${n}: "${query}" → ${(vid.title || '').slice(0, 50)}`);
                } catch (e) {
                    summary.failed++;
                    deps.log('error', 'sched', 'send "' + query + '": ' + e.message);
                }
            } else {
                summary.failed++;
                deps.log('warn', 'sched', 'no video for "' + query + '"' + (vid && vid.error ? ' (' + vid.error.slice(0, 60) + ')' : ''));
            }
            /* human-like pause between sends — NOT after the last one */
            if (i < n - 1) {
                const d = humanDelay();
                summary.delays.push(Math.round(d / 100) / 10);   /* seconds, 1 decimal */
                await sleep(d);
            }
        }
        state.runCount++;
        state.lastRun = summary;
        saveState();
        if (!quiet) await deps.sendText(state.groupJid, '✅ Drop done — ' + summary.sent + ' sent' + (summary.failed ? ', ' + summary.failed + ' skipped' : '') + '.');
        deps.log('info', 'sched', `run complete: ${summary.sent}/${n} sent`);
        return { ok: true, ...summary };
    } finally {
        running = false;
    }
}

/* ── Minute tick: fires a run when the Harare hour matches a slot ── */
async function tick(){
    if (!state.enabled || running) return;
    const hk = hourKey();
    if (state.lastHourKey === hk) return;            /* already ran this hour */
    if (!SCHED_HOURS.includes(harareHour())) return;
    state.lastHourKey = hk;
    saveState();
    deps.log('info', 'sched', `scheduled run starting (${hk} Harare ${String(harareHour()).padStart(2, '0')}:00)`);
    try { await runOnce(PER_RUN); } catch (e) { deps.log('error', 'sched', 'run: ' + e.message); }
}

/* ── Member "video <query>" requests — rate limited per user ── */
const userRequests = new Map();      /* userId -> [ts] */
const USER_LIMIT = 3;                /* per hour */
const USER_WINDOW_MS = 3600 * 1000;
function canRequest(userId){
    const now = Date.now();
    const arr = (userRequests.get(userId) || []).filter(ts => now - ts < USER_WINDOW_MS);
    userRequests.set(userId, arr);
    return arr.length < USER_LIMIT;
}
function recordRequest(userId){ userRequests.get(userId).push(Date.now()); }

/* ── Init ── */
function initVideoScheduler(d){
    deps = d;
    loadState();
    if (state.groupJid) deps.log('info', 'sched', `state loaded — group ${state.groupJid}, ${state.enabled ? 'ON' : 'off'}, ${state.runCount} runs / ${state.sentCount} videos sent`);
    timer = setInterval(() => { tick().catch(e => deps.log('error', 'sched', 'tick: ' + e.message)); }, 60 * 1000);
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
            lastRun: state.lastRun,
            recent: state.history.slice(-5).map(h => h.title || h.q),
            running
        };
    },
    runOnce,
    canRequest,
    recordRequest,
    /* test hook — overrides timers/behaviour without touching state */
    _state: state,
    _stop(){ if (timer) clearInterval(timer); timer = null; },
    _queries: () => QUERIES.slice(),
};

module.exports = { initVideoScheduler, PER_RUN, SCHED_HOURS, DEFAULT_QUERIES };
