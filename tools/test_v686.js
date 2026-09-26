'use strict';
/* ══════════════════════════════════════════════════════════════
 *  v68.6 HUMAN MODE TEST SUITE — runs against the REAL server.js.
 *  Kills the four bot tells:
 *    1. HUMAN READS    — 5-90s random delay, admin 2-8s, night hold
 *    2. QUIET HOURS    — AI holds DM replies 23:00-06:00 local
 *    3. OLDEST-FIRST   — wait-weighted DM picking (not a lottery)
 *    4. CYCLE JITTER   — DM cycle 75s ±35%, no fixed tick
 *    5. VERSIONS       — v68.6 everywhere, zero v68.5 leftovers
 *  Run: node tools/test_v686.js
 * ══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t){ console.log('\n━━ ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }
function grab(startMarker, endMarker){
  const s = src.indexOf(startMarker);
  const e = endMarker ? src.indexOf(endMarker, s) : -1;
  if (s < 0 || (endMarker && e < 0)) throw new Error('grab failed: ' + startMarker);
  return endMarker ? src.slice(s, e) : src.slice(s);
}

/* ═══ 1. HUMAN READS — code guarantees ═══ */
section('HUMAN READS — no instant blue ticks');
{
  ok('scheduleHumanRead exists', /function scheduleHumanRead\(msg, opts\)/.test(src));
  ok('handleMessage uses scheduleHumanRead with admin flag', /scheduleHumanRead\(msg, \{ admin: isAdmin \}\)/.test(src));
  ok('admin button taps read fast (2-8s path)', /scheduleHumanRead\(msg, \{ admin: true \}\)/.test(src));
  ok('flood valve falls back to instant read at cap', /pendingHumanReads\.size >= READ_PENDING_CAP\)\{ markRead\(msg\)/.test(src));
  ok('night hold: 70% of 23:00-07:00 msgs wait for morning',
     /isReadNightHour\(localHour\(\)\) && Math\.random\(\) < READ_NIGHT_HOLD_PCT/.test(src));
  ok('normal reads wait 5-90s random', /READ_DELAY_MIN_MS \+ Math\.random\(\) \* \(READ_DELAY_MAX_MS - READ_DELAY_MIN_MS\)/.test(src));
  ok('admin reads wait 2-8s random', /ADMIN_READ_DELAY_MIN_MS \+ Math\.random\(\) \* \(ADMIN_READ_DELAY_MAX_MS - ADMIN_READ_DELAY_MIN_MS\)/.test(src));
  ok('direct markRead call sites: definition + valve + timer + school admin tap',
     (src.match(/markRead\(msg\)/g) || []).length === 4,
     (src.match(/markRead\(msg\)/g) || []).length + ' refs');
}

/* ═══ 1b. HUMAN READS — behavioral (real fns, stubbed world) ═══ */
section('HUMAN READS — behavioral (real scheduleHumanRead)');
{
  const consts = grab('const HUMAN_READ              =', '\n\n/* ══════════════════════════════════════════════════════════════\n *  CONFIG');
  const readFn = grab('const pendingHumanReads = new Map();', '/* ══════════════════════════════════════════════════════════════\n *  INVITE RESOLUTION');
  const delays = [], reads = [];
  (function(){
    const __g = { delays, reads, hour: 12 };
    const ENABLE_READ_RECEIPTS = true;
    const sock = {};
    async function markRead(msg){ __g.reads.push(msg); }
    function localHour(){ return __g.hour; }
    const TZ_OFFSET_HOURS = 2;
    function setTimeout(fn, ms){ __g.delays.push(ms); return { unref(){} }; }
    eval(consts + '\n' + readFn + `;
      __g.api = {
        schedule: (m, o) => scheduleHumanRead(m, o),
        msMorning: () => msUntilMorning(),
        map: pendingHumanReads
      };`);
    const H = __g.api;

    let bad = null;
    for (let i=0;i<50 && !bad;i++){ __g.delays.length = 0; H.schedule({ key:{id:'a'+i} }, { admin:true });
      const d = __g.delays[0]; if (!(d >= 2000 && d <= 8000)) bad = d; }
    ok('admin read delay 2-8s (50 runs)', bad === null, bad === null ? 'all in range' : bad + 'ms out of range');

    bad = null;
    for (let i=0;i<50 && !bad;i++){ __g.delays.length = 0; __g.hour = 12; H.schedule({ key:{id:'n'+i} }, {});
      const d = __g.delays[0]; if (!(d >= 5000 && d <= 90000)) bad = d; }
    ok('day read delay 5-90s (50 runs)', bad === null, bad === null ? 'all in range' : bad + 'ms out of range');

    let held = 0, quick = 0;
    for (let i=0;i<300;i++){ __g.delays.length = 0; __g.hour = 2; H.schedule({ key:{id:'h'+i} }, {});
      if (__g.delays[0] > 2*3600*1000) held++; else quick++; }
    ok('night hold actually happens (some reads wait for morning)', held > 50, held + '/300 held');
    ok('night non-held reads still human-delayed', quick > 50, quick + '/300 quick');

    /* msUntilMorning sanity: returns 0 < ms < 33h */
    __g.hour = 2;
    const msM = H.msMorning();
    ok('msUntilMorning lands before tomorrow noon', msM > 0 && msM < 33*3600*1000, Math.round(msM/3600000) + 'h');

    ok('no read is ever faster than 1s', !__g.delays.some(d => d < 1000));

    /* flood valve */
    __g.delays.length = 0; __g.reads.length = 0;
    for (let i=0;i<1500;i++) H.map.set(i, null);
    H.schedule({ key:{id:'flood'} }, {});
    ok('flood valve: at 1500 pending, reads happen instantly',
       __g.reads.length === 1 && __g.delays.length === 0,
       'reads=' + __g.reads.length + ' timers=' + __g.delays.length);
    H.map.clear();
  })();
}

/* ═══ 2. QUIET HOURS ═══ */
section('QUIET HOURS — AI sleeps 23:00-06:00, admin never waits');
{
  ok('quiet-hours gate inside runDmAiBatch', /async function runDmAiBatch\(\)\{[\s\S]{0,900}?AI_QUIET_HOURS\)\{[\s\S]{0,400}?if \(quietNow\) return;/.test(src));
  ok('quiet hours env-tunable', /process\.env\.AI_QUIET_START_HOUR\s*\|\| '23'/.test(src) && /process\.env\.AI_QUIET_END_HOUR\s*\|\| '6'/.test(src));
  ok('AI_QUIET_HOURS=0 kills the feature', /process\.env\.AI_QUIET_HOURS !== '0'/.test(src));

  const batch = grab('async function runDmAiBatch', 'async function processDM');
  const mk = (hour, quietOn, adminActive, pool) => {
    const picked = [];
    (function(){
      const sock = {}; const connectionStatus = 'connected';
      let botPaused = false, botOfflineUntil = 0;
      const focus = { busy:false, run: (jid, f) => { f(); } };
      function isAdminActive(){ return adminActive; }
      const AI_QUIET_HOURS = quietOn, AI_QUIET_START_HOUR = 23, AI_QUIET_END_HOUR = 6;
      function localHour(){ return hour; }
      const dmPool = pool;
      function dmIsInteractive(){ return true; }
      function pushLog(){}
      function shuffleArr(a){ return a.slice(); }
      const DM_BATCH_MIN = 1, DM_BATCH_MAX = 4;
      function sleepMs(){}
      function detectMediaIntent(){ return null; }
      function detectLanguage(){ return 'en'; }
      const dailyStats = { focusRuns:0 };
      function resetDailyStats(){}
      async function processDM(item){ picked.push(item.chatJid); }
      const __g = {};
      eval(batch + ';__g.runBatch = () => runDmAiBatch();');
      __g.runBatch();
    })();
    return picked;
  };
  const pool = () => new Map([
    ['263700000001@s.whatsapp.net', { text:'x', lastMsg:{}, ts:1, replied:false }],
    ['263700000002@s.whatsapp.net', { text:'y', lastMsg:{}, ts:2, replied:false }]
  ]);
  ok('02:00 → no DM replies (asleep)', mk(2, true, false, pool()).length === 0);
  ok('23:00 → no DM replies (asleep)', mk(23, true, false, pool()).length === 0);
  ok('06:00 → replies resume', mk(6, true, false, pool()).length > 0);
  ok('quiet OFF → replies at night too', mk(2, false, false, pool()).length > 0);
  ok('admin-active pauses the whole batch (v68.2 focus: boss comes first, admin never uses the AI pool)',
     mk(2, true, true, pool()).length === 0);
}

/* ═══ 3. OLDEST-FIRST PICKING ═══ */
section('OLDEST-FIRST — the longest-waiting DM is answered first');
{
  ok('picking sorts by ts', /byAge = candidates\.slice\(\)\.sort\(\(a, b\) => \(a\[1\]\.ts \|\| 0\) - \(b\[1\]\.ts \|\| 0\)\)/.test(src));
  ok('oldest window then shuffle (age-biased, order-varied)', /oldest = byAge\.slice\(0, Math\.min\(byAge\.length, Math\.max\(n \* 2, n\)\)\)/.test(src));
  ok('shuffle kept for batch order', /picked = shuffleArr\(oldest\)\.slice\(0, n\)/.test(src));

  const batch = grab('async function runDmAiBatch', 'async function processDM');
  /* 3 candidates: two ancient, one brand new. The oldest-2 window must
   * NEVER let the brand-new one beat the ancient ones (n ≤ 4 < window
   * logic guarantees it: slice(0, max(n*2,n)) with 3 candidates → 2). */
  const pool = new Map([
    ['old1@s.whatsapp.net', { text:'a', lastMsg:{}, ts:1000,  replied:false }],
    ['old2@s.whatsapp.net', { text:'b', lastMsg:{}, ts:2000,  replied:false }],
    ['new@s.whatsapp.net',  { text:'c', lastMsg:{}, ts:Date.now(), replied:false }]
  ]);
  const picked = [];
  (function(){
    const __g = {};
    const sock = {}; const connectionStatus = 'connected';
    let botPaused = false, botOfflineUntil = 0;
    const focus = { busy:false, run: (jid, f) => { f(); } };
    function isAdminActive(){ return false; }
    const AI_QUIET_HOURS = false;
    function localHour(){ return 12; }
    const dmPool = pool;
    function dmIsInteractive(){ return true; }
    function pushLog(){}
    function shuffleArr(a){ return a.slice(); }
    const DM_BATCH_MIN = 1, DM_BATCH_MAX = 4;
    function sleepMs(){}
    function detectMediaIntent(){ return null; }
    function detectLanguage(){ return 'en'; }
    const dailyStats = { focusRuns:0 };
    function resetDailyStats(){}
    async function processDM(item){ picked.push(item.chatJid); }
    eval(batch + ';__g.runBatch = () => runDmAiBatch();');
    __g.runBatch();
  })();
  ok('brand-new DM never beats the ancient ones', !picked.includes('new@s.whatsapp.net'), picked.join(',') || 'nobody picked');
  ok('ancient DMs do get answered', picked.filter(j => j.startsWith('old')).length > 0, picked.length + ' replies');
}

/* ═══ 4. CYCLE JITTER ═══ */
section('CYCLE JITTER — 75s ±35%, no metronome');
{
  ok('fixed interval gone', !/setInterval\(runDmAiBatch/.test(src));
  ok('self-rescheduling sweep exists', /function runDmCycleSweep\(\)/.test(src));
  ok('first sweep lands mid-window (37.5-75s)', /setTimeout\(runDmCycleSweep, DM_CYCLE_MS \* \(0\.5 \+ Math\.random\(\) \* 0\.5\)\)/.test(src));

  const cyc = grab('let dmCycleRunning = false;', '/* v68.2: INTERACTIVITY GATE');
  const armed = [];
  (function(){
    function pushLog(){}
    function pruneDmPool(){}
    const DM_CYCLE_MS = 75000, DM_CYCLE_JITTER_PCT = 0.35;
    const DM_BATCH_MIN = 1, DM_BATCH_MAX = 4;
    const AI_QUIET_HOURS = true, AI_QUIET_START_HOUR = 23, AI_QUIET_END_HOUR = 6;
    async function runDmAiBatch(){}
    function setInterval(fn, ms){ return { unref(){} }; }
    function setTimeout(fn, ms){ armed.push(ms); return { unref(){} }; }
    eval(cyc + '\n;startDmAiCycle(); for (let i=0;i<200;i++) runDmCycleSweep();');
  })();
  const sweeps = armed.slice(1); /* first arm = startDmAiCycle initial */
  ok('first arm is mid-window 37.5-75s', armed[0] >= 37500 && armed[0] <= 75000, Math.round(armed[0]/1000) + 's');
  ok('all 200 sweeps within 49-101s (75s ±35%)',
     sweeps.every(ms => ms >= 48750 - 1 && ms <= 101250 + 1),
     Math.round(Math.min(...sweeps)/1000) + '-' + Math.round(Math.max(...sweeps)/1000) + 's');
  ok('sweeps are NOT all identical (real jitter)', new Set(sweeps.map(ms => Math.round(ms))).size > 190,
     new Set(sweeps).size + ' unique values');
}

/* ═══ 5. !test REPORTS HUMAN MODE ═══ */
section('!test — human mode line');
{
  ok('self-test prints human mode', /Human mode: ' \+ \(HUMAN_READ \? 'reads '/.test(src));
  ok('self-test prints AI quiet hours', /AI quiet ' \+ \(AI_QUIET_HOURS \? AI_QUIET_START_HOUR/.test(src));
}

/* ═══ 6. VERSIONS ═══ */
section('VERSIONS — v68.6 everywhere');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package.json is 68.6.0', pkg.version === '68.6.0', pkg.version);
  ok('COMMAND_LIST says v68.6', /BreadBot v68\.6 — Admin/.test(src));
  ok('self-test says v68.6', /BreadBot v68\.6 SELF-TEST/.test(src));
  ok('boot banners say v68.6', /BreadBot v68\.6 ONLINE/.test(src) && /SCHOOL account online/.test(src));
  ok('panel says v68.6', /<title>BreadBot v68\.6<\/title>/.test(src) && /<h1>BreadBot v68\.6 — dual account<\/h1>/.test(src));
  ok('zero user-facing v68.5 strings left', !/BreadBot v68\.5/.test(src));
  ok('v68.6 markers present', /v68\.6 HUMAN MODE/.test(src));
}

console.log('\n══════════════════════════════════════════');
console.log('  v68.6 suite: ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════');
process.exit(fail ? 1 : 0);
