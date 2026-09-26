'use strict';
/* ══════════════════════════════════════════════════════════════
 *  v68.5 TEST SUITE — runs against the REAL shipped server.js.
 *  Covers "AI only replies DMs on the groups account":
 *    1. DM-ONLY (code)   — group conversational AI removed, no toggle
 *    2. SCHOOL SILENCE   — the school handler never AI-chats
 *    3. GREETING RESTART — hey/hi/mhoro = fresh conversation (real fn)
 *    4. 5-MESSAGE MEMORY — AI recalls the last 5 exchanges, capped
 *    5. BEHAVIORAL       — the REAL processDM with stubbed world
 *    6. VERSIONS         — v68.5 everywhere
 *  Run: node tools/test_v685.js
 * ══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
global.__g = {};
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

/* ═══ 1. DM-ONLY — group conversational AI is gone ═══ */
section('AI DM-ONLY — groups never answered, no toggle');
{
  const groupBlock = grab('/* ═══ GROUP MESSAGES — MAIN ONLY ═══ */',
                          '*  CONNECT BOT');
  ok('group block has ZERO askAI calls', !/askAI\(/.test(groupBlock));
  ok('group block has ZERO conversational sends (no informalize)', !/informalize\(/.test(groupBlock));
  ok('group block carries the DMs-ONLY marker', /DMs ONLY/.test(groupBlock));
  ok('group block still serves explicit media requests', /scraperSearch\(|scraperGif\(|scraperMusic\(/.test(groupBlock));
  ok('group block still runs antilink', /handleAntiLink\(/.test(groupBlock));

  ok('groupRepliesEnabled flag deleted everywhere', !/groupRepliesEnabled/.test(src));
  ok('REPLY_IN_GROUPS retired to false', /const REPLY_IN_GROUPS\s+= false;/.test(src));
  ok('!groupchat still answers (permanent-off stub)', /case 'groupchat': \{[\s\S]*?permanently off/.test(src));
  ok('menu says AI is DMs on the groups account ONLY', /DMs on the groups account ONLY/.test(src));
  ok('!mode line reports the DM-only AI surface', /AI surface: DMs only \(groups account\)/.test(src));
  ok('status export flags aiDmOnly: true', /aiDmOnly: true/.test(src));
  ok('confusion guard retired (noteEngagement keeps stats only)',
     /engagement is still recorded for stats[\s\S]*?function noteEngagement/.test(src) &&
     !/Group replies AUTO-DISABLED/.test(src));
}

/* ═══ 2. SCHOOL SILENCE ═══ */
section('SCHOOL ACCOUNT — never AI-chats');
{
  const hsm = grab('async function handleSchoolMessage', 'async function connectSchoolBot');
  ok('school handler has ZERO askAI calls', !/askAI\(/.test(hsm));
  ok('school handler has ZERO conversational sends', !/informalize\(/.test(hsm));
  ok('school handler has no DM AI pool access', !/dmPool\.set/.test(hsm));
  ok('school-DM comment documents no-reply policy', /never auto-replies|no reply|no-reply/i.test(hsm));
}

/* ═══ 3+5. REAL processDM + real greeting helpers, stubbed world ═══ */
section('BEHAVIORAL — the real processDM (stubs for the world)');
let G = {};
{
  const helpers = grab('/* ═══ v68.5: GREETING DETECTION + CONVERSATION RESTART ═══',
                       'function dmIsInteractive');
  const pd = grab('async function processDM', 'function createPendingRequest');

  /* ─── stub world (eval closes over THIS scope) ─── */
  const USER_HISTORY_SIZE = 5;
  const ADMIN_GROUP_LINK = 'https://chat.whatsapp.com/stub';
  const userHistories = new Map();
  const LANG_NAMES = { en: 'English' };
  const dailyStats = { dmsReplied: 0, picsSent: 0, videosSent: 0 };
  let persistWrites = 0;
  const aiCalls = [], sends = [], mediaCalls = [], logs = [], pendings = [];
  function persistDmHistories(){ persistWrites++; }
  function containsForbidden(){ return false; }
  function detectMediaIntent(){ return intentOverride; }
  let intentOverride = null;
  function detectNsfw(){ return false; }
  function detectGroupLinkRequest(){ return false; }
  function isVague(){ return false; }   /* intents always reach the scraper */
  function detectLanguage(){ return 'en'; }
  function isAdminSender(){ return false; }
  function isNsfwWindow(){ return false; }
  function nsfwRoleplayEnabled(){ return false; }        // not referenced directly
  function scraperMusic(){ mediaCalls.push('music'); return { ok:false }; }
  function scraperGif(){ mediaCalls.push('gif'); return { ok:false, gifs:[] }; }
  function scraperSearch(){ mediaCalls.push('search'); return { ok:false, images:[] }; }
  function sendGifSafe(){ mediaCalls.push('sendGif'); return Promise.resolve(); }
  function sendImageSafe(){ mediaCalls.push('sendImg'); return Promise.resolve(); }
  function sendMediaUrl(){ mediaCalls.push('sendMedia'); return Promise.resolve(); }
  function createPendingRequest(jid, name){ pendings.push([jid, name]); }
  function pickFresh(arr){ return arr && arr[0]; }
  function informalize(t){ return t; }
  function resetDailyStats(){}
  function pushLog(level, source, message){ logs.push([source, message]); }
  function sendBuffer(jid, content, priority, lane, taskType, typing){
    sends.push({ jid, text: content && content.text, lane, taskType });
    return Promise.resolve();
  }
  function askAI(prompt, sys){
    aiCalls.push({ prompt, sys });
    return Promise.resolve('fresh reply ' + (aiCalls.length));
  }
  function isAdminActive(){ return false; }

  eval(helpers + '\n' + pd +
       '\n;__g.processDM = processDM; __g.isGreetingRestart = isGreetingRestart;' +
       '__g.world = { userHistories, aiCalls, sends, mediaCalls, logs, pendings, persistWrites: () => persistWrites };');
  G = global.__g;
  const W = G.world;
  const DM = '263700111111';
  const mk = (text, seedHist) => ({
    msg: { key: { id: 'STUB' + Math.random().toString(36).slice(2), remoteJid: DM + '@s.whatsapp.net' } },
    text, chatJid: DM + '@s.whatsapp.net', senderJid: DM + '@s.whatsapp.net',
    pushName: 'Tino', phone: DM, messages: [{ text }], lang: 'en',
  });
  const seed = (pairs) => userHistories.set(DM + '@s.whatsapp.net',
    pairs.map(([u, b]) => ([{ role:'user', text:u, ts:Date.now() }, { role:'bot', text:b, ts:Date.now() }])).flat());

  /* returns a promise — awaited by main() before the summary prints */
  G.behavioral = (async () => {
    /* 5a — greeting RESTARTS a conversation that had history */
    seed([['we were doing the maths assignment', 'yes I said I will help with the maths assignment']]);
    await G.processDM(mk('hey'));
    ok('greeting triggers exactly ONE AI call', W.aiCalls.length === 1, W.aiCalls.length + ' calls');
    ok('greeting reply is sent on the bot DM lane', W.sends.length === 1 && W.sends[0].taskType === 'dmreply');
    ok('greeting WIPES old topic from the prompt', !/maths assignment/.test(W.aiCalls[0].prompt));
    ok('sys prompt carries the LAST-5-MESSAGES rule', /LAST 5 MESSAGES/.test(W.aiCalls[0].sys));
    ok('sys prompt says a greeting is a NEW conversation', /greeting.*NEW conversation|NEW conversation/.test(W.aiCalls[0].sys));
    ok('reset logged for the contact', W.logs.some(l => /Conversation reset.*greeting/.test(l[1])));
    ok('history re-seeded fresh (1 user + 1 bot entry)',
       W.userHistories.get(DM + '@s.whatsapp.net').length === 2);
    ok('persist ran after the reset', W.persistWrites() >= 1);

    /* 5b — NON-greeting keeps the memory (re-seeded: 5a's greeting wiped it) */
    W.aiCalls.length = 0;
    seed([['we were doing the maths assignment', 'yes I said I will help with the maths assignment']]);
    await G.processDM(mk('so about the maths assignment, when are we starting?'));
    ok('non-greeting prompt KEEPS the conversation history', /maths assignment/.test(W.aiCalls[0].prompt));

    /* 5c — memory is capped at the LAST 5 exchanges */
    W.aiCalls.length = 0;
    seed(Array.from({length: 8}, (_, i) => [['msg ' + (i+1), 'reply ' + (i+1)]]).flat());
    await G.processDM(mk('msg 9 question'));
    const p = W.aiCalls[0].prompt;
    ok('prompt includes the latest exchange (msg 8)', /Them: msg 8/.test(p));
    ok('prompt DROPPED the oldest (msg 1 forgotten)', !/msg 1/.test(p));
    ok('prompt includes the new pooled message (msg 9)', /msg 9/.test(p));
    ok('history stays capped at 5 exchanges (10 entries)',
       W.userHistories.get(DM + '@s.whatsapp.net').length === 10,
       W.userHistories.get(DM + '@s.whatsapp.net').length + ' entries');

    /* 5d — brand-new contact greets: fresh start, no crash */
    W.aiCalls.length = 0; W.sends.length = 0;
    const OTHER = '263700222222';
    await G.processDM({ msg:{ key:{ id:'S2', remoteJid: OTHER + '@s.whatsapp.net' } },
      text:'hello', chatJid: OTHER + '@s.whatsapp.net', senderJid: OTHER + '@s.whatsapp.net',
      pushName:'Rue', phone: OTHER, messages:[{ text:'hello' }], lang:'en' });
    ok('new contact greeting → AI called once, fresh (no transcript)',
       W.aiCalls.length === 1 && !/Recent conversation/.test(W.aiCalls[0].prompt));
    ok('new contact greeting → one DM reply, no media fan-out',
       W.sends.length === 1 && W.mediaCalls.length === 0);

    /* 5e — pooled messages feed the memory too */
    W.aiCalls.length = 0;
    await G.processDM({ msg:{ key:{ id:'S3', remoteJid: DM + '@s.whatsapp.net' } },
      text:'and my exam is on Friday', chatJid: DM + '@s.whatsapp.net', senderJid: DM + '@s.whatsapp.net',
      pushName:'Tino', phone: DM, messages:[{ text:'hi again' },{ text:'and my exam is on Friday' }], lang:'en' });
    ok('multi-text DM: pooled messages appear in the prompt', /hi again/.test(W.aiCalls[0].prompt));

    /* 5f — media-intent texts go to the MEDIA path, never the AI chat
     * (processDM reads intent from the item — the batcher's detectMediaIntent) */
    W.aiCalls.length = 0; W.mediaCalls.length = 0;
    const mi = mk('hey send me pics of cars'); mi.intent = { type:'image', query:'cars' };
    await G.processDM(mi);
    ok('greeting + media request goes to the MEDIA path, not chat',
       W.aiCalls.length === 0 && W.mediaCalls.length > 0, 'media=' + W.mediaCalls.join(','));
  })();

  /* 3 — the REAL greeting detector, unit level (sync, runs inside main) */
  section('GREETING DETECTOR — real isGreetingRestart()');
  const yes = ['hey','HEY!!','hie','hello','Hello!','yo','yoooo','eo','mhoro','mhoroi',
               'mangwanani','masikati','madekwana','howfar','how far','wassup','wasup',
               "what's up",'whats up','whats good','sup','good morning','Good Evening',
               'greetings','hey chomi'];
  const no  = ['','   ', null, undefined, 'whoa hey', 'I was like hey to him',
               "hey, so I wanted to ask about tomorrow's assignment and the whole plan",
               'history', 'supper', 'you there', 'send me pics of cars', 'hey3'];
  ok('all ' + yes.length + ' greeting forms detected', yes.every(t => G.isGreetingRestart(t) === true),
     yes.filter(t => !G.isGreetingRestart(t)).join(', ') || 'all matched');
  ok('all ' + no.length + ' non-greetings rejected', no.every(t => G.isGreetingRestart(t) === false),
     no.filter(t => G.isGreetingRestart(t)).join(', ') || 'all rejected');
  ok('greeting restart capped at 40 chars', G.isGreetingRestart('hey'.padEnd(39, ' z')) === true &&
     G.isGreetingRestart('hey'.padEnd(41, ' z')) === false);
}

/* ═══ 4. 5-MESSAGE MEMORY (code level) ═══ */
function memorySection(){
section('5-MESSAGE MEMORY — code wiring');
{
  ok('USER_HISTORY_SIZE is 5', /const USER_HISTORY_SIZE\s+= 5;/.test(src));
  ok('reset runs BEFORE history is read (greeting wipes then rebuilds)',
     src.indexOf('greeting restart') < src.indexOf('const hist = userHistories.get(senderJid)'));
  ok('transcript slice = last 5 exchanges (USER_HISTORY_SIZE * 2)',
     /hist\.slice\(-USER_HISTORY_SIZE \* 2\)/.test(src));
  ok('history hard-capped at USER_HISTORY_SIZE * 2 on every reply',
     /while \(hist\.length > USER_HISTORY_SIZE \* 2\) hist\.shift\(\);/.test(src));
  ok('histories persist to disk (survive restarts)', /function persistDmHistories/.test(src) &&
     /function loadDmHistories/.test(src) && /loadDmHistories\(\);/.test(src));
}
}

/* ═══ 6. VERSIONS ═══ */
function versionsSection(){
section('VERSIONS — v68.5 core banners');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package.json is 69.0.0', pkg.version === '69.0.0', pkg.version);
  ok('menu/self-test/boot/panel all say v68.7',
     /BreadBot v69 — Admin/.test(src) && /BreadBot v69 SELF-TEST/.test(src) &&
     /BreadBot v69 ONLINE/.test(src) && /<title>BreadBot v69<\/title>/.test(src));
}
}

function summary(){
console.log('\n══════════════════════════════════════════');
console.log('  v68.5 suite: ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════');
process.exit(fail ? 1 : 0);
}

/* sections 1+2 + detector run sync; the behavioral promises must land
 * before the summary prints. */
memorySection();
versionsSection();
Promise.resolve(G.behavioral).catch(function(e){
  ok('processDM behavioral block crashed: ' + e.message, false);
}).then(summary);
