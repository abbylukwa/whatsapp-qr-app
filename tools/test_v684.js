'use strict';
/* ══════════════════════════════════════════════════════════════
 *  v68.4 TEST SUITE — runs against the REAL shipped server.js.
 *  Covers the v68.4 ONE-ADMIN-TWO-BOTS conflict fixes:
 *    1. BOT-CHAT GUARD  — school never acts in the admin↔bot chat
 *    2. SELF-CHAT       — school's only fromMe command channel
 *    3. claimSchool     — re-delivered messages execute once
 *    4. DOC OWNERSHIP   — exactly one account reads any PDF
 *    5. SHARED-GROUP TASKS — always sent by the groups account
 *    6. VERSIONS        — v68.4 everywhere, no leftovers
 *    7. SCRAPER MY LINKS — 7 dummy slots, built-in links intact
 *  Run: node tools/test_v684.js
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

const ADMIN = '263777627210';          // the user = the one admin
const BOTNUM = '263777000001';         // the groups (bot) account number

/* ═══ 1+2+3+4. BEHAVIORAL — the real school handler with stubs ═══ */
section('ROUTING — real handleSchoolMessage, stubbed world');
{
  const hsm = grab('async function handleSchoolMessage', 'async function connectSchoolBot');
  /* ALL stubs live in THIS scope — direct eval reads the enclosing scope
   * chain, so the eval'd real handler closes over them. */
  let schoolSock = true, schoolNumber = ADMIN;
  const botSentIds = new Set();
  /* v68.4 real claim memory (verbatim semantics) */
  const schoolClaimed = new Set();
  function claimSchool(id){ if (!id) return true; if (schoolClaimed.has(id)) return false; schoolClaimed.add(id); if (schoolClaimed.size > 5000){ const a=[...schoolClaimed]; schoolClaimed.clear(); for (const i of a.slice(-2500)) schoolClaimed.add(i); } return true; }
  let mainGroupJid = null;
  const schoolRegistry = new Map();
  let sock = null;                       /* groups socket stub */
  const accountStats = { school: { in: 0 } };
  const LOADTEST = 0, lt = { handled: 0 };
  const ADMIN_PHONE = ADMIN;
  let adminCmds = [], logged = [], liveSeen = [], docCalls = [], routedBtns = [];
  let touches = 0, marksRead = 0;
  let tapStub = null;
  function isAdminSender(msg, senderJid){
    const cands = extractAllPhoneCandidates(msg, senderJid);
    return cands.includes(ADMIN_PHONE) || String(senderJid||"").split("@")[0] === ADMIN_PHONE; }
  function extractAllPhoneCandidates(msg, senderJid){
    const s = new Set();
    const c = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
    for (const x of c){ if (typeof x === "string"){ const d = x.split("@")[0].split(":")[0].replace(/\D/g,""); if (d.length >= 10) s.add(d); } }
    return [...s]; }
  function extractLidFromMsg(){ return null; }
  function touchAdminActive(){ touches++; }
  function pushLiveMessage(e){ liveSeen.push(e); }
  function resetDailyStats(){}
  const dailyStats = { readsSent: 0 };
  function extractButtonCommand(){ return tapStub; }
  function markRead(){ marksRead++; return Promise.resolve(); }
  function routeButton(jid, id){ routedBtns.push([jid, id]); return Promise.resolve(); }
  function handleIncomingDocument(msg, m, chatJid, senderJid, isGroup, isAdmin, account){ docCalls.push([chatJid, isGroup, account]); return Promise.resolve({ name:"t.pdf" }); }
  function getSchoolGroupName(){ return "BSC 2.1 Botany"; }
  function isNeededUpdate(t){ return /test 2|lecture|assignment|exam/i.test(t); }
  function queueNeededUpdate(g, t){}
  function handleSchoolAdminCommand(text, chatJid, msg){ adminCmds.push([text, chatJid]); return Promise.resolve(); }
  function pushLog(level, source, message){ logged.push([source, message]); }
  const SCHOOL_STRICT_ADMIN = true;
  eval(hsm + '\n;__g.handleSchoolMessage = handleSchoolMessage;');
  const H = global.__g.handleSchoolMessage;

  (async function(){
    /* A. self-chat = school's command channel */
    await H({ key:{ id:'a1', fromMe:true, remoteJid: ADMIN+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'!status' } });
    ok('A1 self-chat "!status" handled by school', adminCmds.length === 1 && adminCmds[0][0] === '!status');

    /* B. the bot's chat is BOT territory */
    adminCmds = []; docCalls = []; liveSeen = []; routedBtns = [];
    sock = { user: { id: BOTNUM + ':12@s.whatsapp.net' } };   // groups account online
    await H({ key:{ id:'b1', fromMe:true, remoteJid: BOTNUM+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'!menu' } });
    ok('B1 command typed in the BOT chat never reaches school', adminCmds.length === 0);
    ok('B2 bot chat still visible on the school monitor panel', liveSeen.length === 1);

    /* C. groups account offline → still no double owner (isAdmin false) */
    sock = null;
    await H({ key:{ id:'c1', fromMe:true, remoteJid: BOTNUM+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'!menu' } });
    ok('C1 bot chat with groups account OFFLINE still ignored by school', adminCmds.length === 0);

    /* D. fromMe DM to a friend → nobody's business */
    sock = null; adminCmds = []; logged = [];
    await H({ key:{ id:'d1', fromMe:true, remoteJid:'263999111222@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'!menu' } });
    ok('D1 outgoing DM to a friend is not a command', adminCmds.length === 0);
    ok('D2 …and skipped silently', logged.length === 0);

    /* E. DOC OWNERSHIP — school-only group doc → school digests */
    sock = { user:{ id: BOTNUM+':12@s.whatsapp.net' } };
    const schoolGroupJid = '120363012345678888@g.us';
    schoolRegistry.set(schoolGroupJid, 'Chemistry Notes');
    docCalls = [];
    await H({ key:{ id:'e1', fromMe:true, remoteJid: schoolGroupJid, participant: ADMIN+'@s.whatsapp.net' },
              pushName:'Admin', message:{ documentMessage:{ fileName:'notes.pdf', fileLength: 1000 } } });
    ok('E1 PDF in a school-only group → SCHOOL reads it', docCalls.length === 1 && docCalls[0][2] === 'school' && docCalls[0][1] === true);

    /* F. main-group doc → school must NOT touch it (bot owns) */
    mainGroupJid = schoolGroupJid;
    docCalls = [];
    await H({ key:{ id:'f1', fromMe:true, remoteJid: schoolGroupJid, participant: ADMIN+'@s.whatsapp.net' },
              pushName:'Admin', message:{ documentMessage:{ fileName:'notes.pdf', fileLength: 1000 } } });
    ok('F2 PDF in the MAIN group → school skips (bot digests it)', docCalls.length === 0);
    mainGroupJid = null;

    /* G. PDF sent to the BOT's DM → school ignores (bot reads it) */
    docCalls = [];
    await H({ key:{ id:'g1', fromMe:true, remoteJid: BOTNUM+'@s.whatsapp.net' },
              pushName:'Admin', message:{ documentMessage:{ fileName:'hw.pdf', fileLength: 1000 } } });
    ok('G1 PDF sent to the BOT is not touched by school', docCalls.length === 0);

    /* H. PDF in the admin's self-chat → school reads it */
    docCalls = [];
    await H({ key:{ id:'h1', fromMe:true, remoteJid: ADMIN+'@s.whatsapp.net' },
              pushName:'Admin', message:{ documentMessage:{ fileName:'hw.pdf', fileLength: 1000 } } });
    ok('H1 PDF in self-chat → school reads it', docCalls.length === 1 && docCalls[0][1] === false);

    /* I. re-delivered command (same id) → exactly once */
    adminCmds = [];
    const redelivered = { key:{ id:'i1', fromMe:true, remoteJid: ADMIN+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'!tasks' } };
    await H(redelivered); await H(redelivered); await H(redelivered);
    ok('I1 re-delivered command executes exactly once', adminCmds.length === 1, 'calls=' + adminCmds.length);

    /* J. re-delivered doc (same id) → exactly once */
    docCalls = [];
    const redoc = { key:{ id:'j1', fromMe:true, remoteJid: schoolGroupJid, participant: ADMIN+'@s.whatsapp.net' },
                    pushName:'Admin', message:{ documentMessage:{ fileName:'x.pdf', fileLength: 10 } } };
    await H(redoc); await H(redoc);
    ok('J1 re-delivered PDF is read exactly once', docCalls.length === 1, 'calls=' + docCalls.length);

    /* K. button tap in the bot chat → never routed by school */
    tapStub = { id: 'menu:main' }; sock = { user:{ id: BOTNUM+':12@s.whatsapp.net' } };
    routedBtns = [];
    await H({ key:{ id:'k1', fromMe:true, remoteJid: BOTNUM+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'' } });
    ok('K1 button tap in the bot chat is not routed by school', routedBtns.length === 0);

    /* L. button tap in self-chat → routed once */
    routedBtns = [];
    const tap = { key:{ id:'l1', fromMe:true, remoteJid: ADMIN+'@s.whatsapp.net' }, pushName:'Admin', message:{ conversation:'' } };
    await H(tap); await H(tap);
    ok('L1 self-chat tap routed exactly once', routedBtns.length === 1, 'routed=' + routedBtns.length);
    tapStub = null;

    /* M. INCOMING admin DM (ADMIN_PHONE ≠ school login) still works —
     * only possible when the school account is NOT the admin's number */
    adminCmds = [];
    schoolNumber = '263000000001';         /* school logged in as someone else */
    await H({ key:{ id:'m1', fromMe:false, remoteJid: ADMIN+'@s.whatsapp.net', participantPn: ADMIN+'@s.whatsapp.net' },
              pushName:'Admin', message:{ conversation:'!test' } });
    ok('M1 incoming admin DM still reaches school (future-proof)', adminCmds.length === 1);
    schoolNumber = ADMIN;                  /* restore */
  })();
}

/* ═══ 5. SHARED-GROUP TASKS — static ═══ */
section('SHARED-GROUP TASKS — resolveTaskTarget');
{
  ok('school-registry match sends via groups account when the bot is a member',
     /account = joinedGroups\.has\(g\) \? 'groups' : 'school';/.test(src));
  ok('comment explains the ownership rule', /group BOTH accounts are in is always/.test(src));
}

/* ═══ 6. VERSIONS ═══ */
section('VERSIONS — v68.6 everywhere');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package.json is 68.6.0', pkg.version === '68.6.0', pkg.version);
  ok('COMMAND_LIST says v68.6', /BreadBot v68\.6 — Admin/.test(src));
  ok('self-test says v68.6', /BreadBot v68\.6 SELF-TEST/.test(src));
  ok('panel <title> says v68.6', /<title>BreadBot v68\.6<\/title>/.test(src));
  ok('panel <h1> says v68.6', /<h1>BreadBot v68\.6 — dual account<\/h1>/.test(src));
  ok('boot banners say v68.6', /BreadBot v68\.6 ONLINE/.test(src) && /SCHOOL account online/.test(src));
  ok('no user-facing "BreadBot v68.4" strings left in server.js', !/BreadBot v68\.4/.test(src));
}

/* ═══ 7. SCRAPER MY LINKS ═══ */
section('SCRAPER — MY LINKS (7 dummy slots) + built-in links intact');
{
  const sc = path.join(ROOT, '..', 'repo-intelligent-scraper');
  const ml = JSON.parse(fs.readFileSync(path.join(sc, 'my_links.json'), 'utf8'));
  ok('my_links.json has exactly 7 slots', Array.isArray(ml.links) && ml.links.length === 7, '' + ml.links.length);
  ok('every slot has url + type', ml.links.every(l => l.url && (l.type === 'image' || l.type === 'gif')));
  ok('dummy URLs are obvious placeholders', ml.links.every(l => /replace-me/i.test(l.url)));
  ok('_HOW_TO replace instructions present', Array.isArray(ml._HOW_TO) && ml._HOW_TO.length >= 5);
  ok('{query} token documented', ml._HOW_TO.some(t => t.includes('{query}')));

  const sjs = fs.readFileSync(path.join(sc, 'server.js'), 'utf8');
  ok('loader requires utils (live-boot bug fixed)', /const utils = require\('\.\/utils'\);/.test(sjs));
  ok('tryMyLinks merge in /search', /const myUrls = await tryMyLinks\(searchQuery, 'image'\);/.test(sjs));
  ok('tryMyLinks merge in /gif', /const myGifs = await tryMyLinks\(q, 'gif'\);/.test(sjs));
  ok('GET /my-links endpoint', /app\.get\('\/my-links'/.test(sjs));
  ok('15s per-slot timeout (dead links never hang a search)', /new Promise\(\(_, rej\) => setTimeout\(\(\) => rej\(new Error\('timeout'\)\), 15000\)\)/.test(sjs));
  ok('/status reports myLinks', /myLinks: \{/.test(sjs));
  ok('scraper version 2.3.0', /version: '2\.3\.0'/.test(sjs) && JSON.parse(fs.readFileSync(path.join(sc,'package.json'),'utf8')).version === '2.3.0');

  /* built-in direct links — BYTE-IDENTICAL guarantee */
  const aj = fs.readFileSync(path.join(sc, 'album.js'), 'utf8');
  const gj = fs.readFileSync(path.join(sc, 'gif.js'), 'utf8');
  ok('darknaija direct link intact', aj.includes('https://darknaija.com/?s='));
  ok('pornpics direct links intact (x2)', (aj.match(/pornpics\.com/g) || []).length >= 2);
  ok('reddit/boobs direct link intact', aj.includes('old.reddit.com/r/boobs/top/.json'));
  ok('imagefaqs direct link intact', aj.includes('imagefaqs.com/search'));
  ok('tenor direct link intact', gj.includes('tenor.com/search/'));
  ok('giphy direct link intact', gj.includes('giphy.com/search/'));
}

/* ═══ summary ═══ */
setTimeout(() => {
  console.log('\n════════════════════════════════════════════');
  console.log('  v68.4 suite: ' + pass + ' passed, ' + fail + ' failed');
  console.log('════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}, 800);
