'use strict';
/* ══════════════════════════════════════════════════════════════
 *  v68.3 TEST SUITE — runs against the REAL shipped server.js.
 *  Covers the v68.3 fixes:
 *    1. ADMIN RECOGNITION — school account (admin's own number):
 *       fromMe messages are PROCESSED, not dropped
 *    2. !test diagnostic command (both accounts)
 *    3. RECONNECT HARDENING — backoff, QR cap, storm detector,
 *       401 hard stop, last-resort wipe
 *    4. MAIN GROUP auto-retry (was set-once, failed once = never)
 *    5. PANEL SPLIT — separate Groups/School streams
 *    6. SCRAPER — every direct site link (incl. NSFW) intact
 *  Run: node tools/test_v683.js
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

/* ═══ 1. ADMIN RECOGNITION — the fromMe fix ═══ */
section('1. ADMIN RECOGNITION — school account processes fromMe');
{
  ok('blanket `if (msg.key?.fromMe) return;` is GONE from handleSchoolMessage',
     !/if \(msg\.key\?\.fromMe\) return;/.test(grab('async function handleSchoolMessage', 'async function connectSchoolBot')) &&
     !/if \(msg\.key\.fromMe\) return;/.test(grab('async function handleSchoolMessage', 'async function connectSchoolBot')));
  ok('bot-sent echo guard (botSentIds) added at the top of the school handler',
     /if \(msg\.key\?\.id && botSentIds\.has\(msg\.key\.id\)\) return;/.test(grab('async function handleSchoolMessage', 'async function connectSchoolBot')));
  ok('self-echo drop is guarded by !fromMe (admin IS the account)',
     /if \(!fromMe && selfBase && cand\.includes\(selfBase\)\) return;/.test(src));

  /* BEHAVIORAL: run the real handler with stubs */
  const hsm = grab('async function handleSchoolMessage', 'async function connectSchoolBot');
  eval(
    /* handler dependencies — stubbed to observe behavior */
    'let schoolSock = true, schoolNumber = "263777627210";\n' +
    'const botSentIds = new Set();\n' +
    'const accountStats = { school: { in: 0 } };\n' +
    'const LOADTEST = 0, lt = { handled: 0 };\n' +
    'const ADMIN_PHONE = "263777627210";\n' +
    'let adminCmds = [];\n' +
    'let logged = [];\n' +
    'let liveSeen = [];\n' +
    'let touches = 0, reads = 0, queuedUpdates = [], marksRead = 0, routedBtns = [];\n' +
    'function isAdminSender(msg, senderJid){' +
    '  const cands = extractAllPhoneCandidates(msg, senderJid);' +
    '  return cands.includes(ADMIN_PHONE) || String(senderJid||"").split("@")[0] === ADMIN_PHONE; }\n' +
    'function extractAllPhoneCandidates(msg, senderJid){\n' +
    '  const s = new Set();\n' +
    '  const c = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);\n' +
    '  for (const x of c){ if (typeof x === "string"){ const d = x.split("@")[0].split(":")[0].replace(/\\D/g,""); if (d.length >= 10) s.add(d); } }\n' +
    '  return [...s]; }\n' +
    'function extractLidFromMsg(){ return null; }\n' +
    'function touchAdminActive(){ touches++; }\n' +
    'function pushLiveMessage(e){ liveSeen.push(e); }\n' +
    'function resetDailyStats(){}\n' +
    'const dailyStats = { readsSent: 0 };\n' +
    'function extractButtonCommand(){ return null; }\n' +
    'function markRead(){ marksRead++; return Promise.resolve(); }\n' +
    'function routeButton(jid, id){ routedBtns.push(id); return Promise.resolve(); }\n' +
    'function handleIncomingDocument(){ return Promise.resolve(); }\n' +
    'function getSchoolGroupName(){ return "BSC 2.1 Botany"; }\n' +
    'function isNeededUpdate(t){ return /test 2|lecture|assignment|exam/i.test(t); }\n' +
    'function queueNeededUpdate(g, t){ queuedUpdates.push([g, t]); }\n' +
    'function handleSchoolAdminCommand(text, chatJid, msg){ adminCmds.push([text, chatJid]); return Promise.resolve(); }\n' +
    'function pushLog(level, source, message){ logged.push([source, message]); }\n' +
    'const SCHOOL_STRICT_ADMIN = true;\n' +
    hsm + '\n;__g.handleSchoolMessage = handleSchoolMessage;'
  );
  const H = global.__g.handleSchoolMessage;

  (async function(){
    /* case A: the admin types "menu" in their own chat (self-chat,
     * remoteJid = own number) — arrives with fromMe=true */
    let called = 0;
    adminCmds = [];
    await H({ key: { id: 'A1', fromMe: true, remoteJid: '263777627210@s.whatsapp.net' },
              pushName: 'Admin',
              message: { conversation: 'menu' } });
    ok('fromMe self-chat "menu" reaches the school admin command handler',
       adminCmds.length === 1 && adminCmds[0][0] === 'menu', JSON.stringify(adminCmds));

    /* case B: the admin's own texts are NOT counted as reads */
    ok('fromMe texts are not counted as readsSent', dailyStats.readsSent === 0);

    /* case C: fromMe DM to a FRIEND (remoteJid = friend) — must NOT be
     * treated as a command (would reply into the friend's chat) */
    adminCmds = [];
    logged = [];
    await H({ key: { id: 'A2', fromMe: true, remoteJid: '263999111222@s.whatsapp.net' },
              pushName: 'Admin',
              message: { conversation: 'menu' } });
    ok('fromMe DM to a friend is NOT treated as an admin command', adminCmds.length === 0);
    ok('fromMe DM to a friend is skipped silently (no log spam)', logged.length === 0);

    /* case D: inbound self-echo (NOT fromMe but sender = self) dropped */
    adminCmds = [];
    liveSeen = [];
    await H({ key: { id: 'A3', fromMe: false, remoteJid: '263777627210@s.whatsapp.net' },
              message: { conversation: 'echo' } });
    ok('non-fromMe self-echo is still dropped', liveSeen.length === 0 && adminCmds.length === 0);

    /* case E: the bot's own send (id in botSentIds) is never reprocessed */
    botSentIds.add('BOT1');
    liveSeen = [];
    await H({ key: { id: 'BOT1', fromMe: true, remoteJid: '263777627210@s.whatsapp.net' },
              message: { conversation: 'hello from the bot itself' } });
    ok('botSentIds messages are dropped (no loops)', liveSeen.length === 0);

    /* case F: the admin posts in a SCHOOL group from their phone
     * (fromMe=true, group) — monitored, update queued, never replied */
    queuedUpdates = [];
    await H({ key: { id: 'A4', fromMe: true, remoteJid: '120363@g.us', participant: '263777627210:1@s.whatsapp.net' },
              message: { conversation: 'Test 2 moved to monday' } });
    ok('fromMe group message is monitored for needed updates', queuedUpdates.length === 1, JSON.stringify(queuedUpdates[0] || []));

    /* case G: inbound DM from a stranger — strict gate still logs */
    logged = [];
    await H({ key: { id: 'A5', fromMe: false, remoteJid: '263555000111@s.whatsapp.net' },
              pushName: 'Stranger',
              message: { conversation: 'hi' } });
    ok('non-admin DM still ignored with the quiet log line',
       logged.length === 1 && /Non-admin DM ignored/.test(logged[0][1]), JSON.stringify(logged[0] || []));

    /* case H: button tap arriving fromMe (self-chat) routes through */
    /* (extractButtonCommand stubbed null above; structural check instead) */
    ok('button tap path untouched (SCHOOL_STRICT_ADMIN gate intact)',
       /if \(SCHOOL_STRICT_ADMIN && \(!\(!isGroup && isAdmin\)\)\) return;/.test(hsm));
  })();
}

/* ═══ 2. !test DIAGNOSTIC ═══ */
section('2. !test — self-diagnostic command');
{
  const sw = grab('async function handleAdminCommand', 'function checkFlood');
  ok('case \'test\' exists in the admin command switch', /case 'test': \{/.test(sw));
  ok('!test reports accounts (Groups/School status)',
     /Groups : ' \+ connectionStatus/.test(sw) && /School : ' \+ schoolStatus/.test(sw));
  ok('!test pings the scraper /health', /axios\.get\(SCRAPER_URL \+ '\/health'/.test(sw));
  ok('!test reports AI provider states', /providerReport\[p\.name\]/.test(sw));
  ok('!test reports the scheduler', /scheduledTasks\.values\(\)\]\.filter\(t => t\.status === 'active'\)/.test(sw));
  ok('!test reports the main group state', /NOT SET ✗ — auto-retrying/.test(sw));
  ok('!test is NOT in the school-blocked list',
     !(grab("const SCHOOL_BLOCKED = ", ";").includes("'test'")));
  ok("'test' added to SCHOOL_COMMANDS (works from the school line)",
     /const SCHOOL_COMMANDS = \[[^\]]*'test'[^\]]*\]/.test(src));
  ok('COMMAND_LIST documents !test', /!test \/ !testall \/ !aitest/.test(src));
}

/* ═══ 3. RECONNECT HARDENING ═══ */
section('3. RECONNECT HARDENING — backoff, QR cap, storm, 401');
{
  ok('RC constants block exists', /const RC = \{[\s\S]*?QR_MAX: 5[\s\S]*?STORM_THRESHOLD: 8[\s\S]*?WIPE_ATTEMPTS: 5[\s\S]*?\};/.test(src));
  ok('backoffMs is exponential with jitter', /function backoffMs\(attempts\)\{[\s\S]*?Math\.pow\(2, [\s\S]*?\(0\.8 \+ Math\.random\(\) \* 0\.4\)/.test(src));

  /* behavioral: backoff growth + cap + jitter bounds */
  eval(grab('const RC = {', 'function noteClose') + '\n;__g.RC = RC; __g.backoffMs = backoffMs;');
  const B = global.__g.backoffMs, RCv = global.__g.RC;
  ok('backoff grows: attempt1 < attempt4 < attempt7',
     B(1) < B(4) && B(4) < B(7), `${B(1)} < ${B(4)} < ${B(7)}`);
  ok('backoff never exceeds RC.MAX_MS (10 min cap)',
     B(30) <= RCv.MAX_MS && B(1) >= RCv.BASE_MS * 0.8, 'B(30)=' + B(30));
  ok('jitter stays within ±20%', (function(){
    for (let i = 0; i < 200; i++){ const v = B(3);
      if (v < Math.floor(20000*0.8) || v > Math.ceil(20000*1.2)) return false; }
    return true; })());

  /* behavioral: storm detector window */
  eval(grab('const RC = {', 'function noteClose') + grab('function noteClose', '\nlet mainGroupJid') + '\n;__g.noteClose = noteClose;');
  const NC = global.__g.noteClose;
  const times = [];
  let storm = false;
  for (let i = 0; i < 7; i++) storm = NC(times);
  ok('7 drops in window: no storm yet', storm === false);
  storm = NC(times);
  ok('8th drop within 10 min = STORM', storm === true);
  const old = [];
  for (let i = 0; i < 10; i++) NC(old);
  await0(old);
  function await0(t){ t.forEach((x,i)=>t[i]=x-11*60000); }   /* age them out of the window */
  ok('drops older than 10 min fall out of the window', NC(old) === false);

  /* wiring — both accounts */
  const botClose = grab("    sock.ev.on('connection.update'", "sock.ev.on('creds.update'");
  const schoolClose = grab("schoolSock.ev.on('connection.update'", "schoolSock.ev.on('creds.update'");
  ok('BOT: 428/440 uses backoffMs (no more fixed 3s*n)', /code === 428 \|\| code === 440[\s\S]*?backoffMs\(reconnectAttempts\)/.test(botClose));
  ok('BOT: QR renewals capped (QR_MAX) with cooldown', /botQrCount\+\+;[\s\S]*?botQrCount > RC\.QR_MAX[\s\S]*?RC\.QR_COOLDOWN_MS/.test(botClose));
  ok('BOT: 401 → logged-out HARD STOP (no auto-retry)', /DisconnectReason\.loggedOut[\s\S]*?connectionStatus = 'logged-out'[\s\S]*?Refresh QR/.test(botClose));
  ok('BOT: auth wipe only after WIPE_ATTEMPTS (last resort)', /reconnectAttempts > RC\.WIPE_ATTEMPTS[\s\S]*?rmSync\(AUTH_FOLDER/.test(botClose));
  ok('BOT: storm detector wired (noteClose on close)', /noteClose\(botCloseTimes\)/.test(botClose));
  ok('BOT: QR cycle resets on successful open', /reconnectAttempts = 0; botStartTime = Date\.now\(\);\n\s*botQrCount = 0; botCloseTimes = \[\];/.test(botClose));
  ok('SCHOOL: QR cap + cooldown wired', /schoolQrCount > RC\.QR_MAX[\s\S]*?RC\.QR_COOLDOWN_MS/.test(schoolClose));
  ok('SCHOOL: 401 → logged-out HARD STOP with rescan instruction', /schoolStatus = 'logged-out'[\s\S]*?Refresh QR/.test(schoolClose));
  ok('SCHOOL: exponential backoff replaces fixed 3s*n', /backoffMs\(schoolReconnectAttempts\)/.test(schoolClose));
  ok('SCHOOL: storm detector wired', /noteClose\(schoolCloseTimes\)/.test(schoolClose));
  ok('SCHOOL: no more fast fixed retry (Math.min(3000 * schoolReconnectAttempts, 20000) gone)',
     !/Math\.min\(3000 \* schoolReconnectAttempts, 20000\)/.test(schoolClose));
  ok('manual Refresh QR resets the QR cycle (both accounts)',
     /botQrCount = 0; botCloseTimes = \[\];/.test(grab('function refreshQR(){', 'pushLog')) &&
     /schoolQrCount = 0; schoolCloseTimes = \[\];/.test(grab('function refreshSchoolQR(){', 'pushLog')));
}

/* ═══ 4. MAIN GROUP AUTO-RETRY ═══ */
section('4. MAIN GROUP — auto-set retries every 3 min (was once-ever)');
{
  ok('retry interval exists (3 * 60 * 1000)', /autoSetMainGroup\(\)\.catch\(function\(\)\{\}\);\n\}, 3 \* 60 \* 1000\)/.test(src));
  ok('retry only fires while NOT SET + connected', /if \(mainGroupJid \|\| !ADMIN_GROUP_LINK\) return;\n\s*if \(!sock \|\| connectionStatus !== 'connected'\) return;/.test(src));
  ok('boot log explains the retry to the admin', /NOT SET ✗ — auto-retrying from ADMIN_GROUP_LINK/.test(src));
}

/* ═══ 5. PANEL SPLIT ═══ */
section('5. PANEL — separate GROUPS / SCHOOL streams');
{
  const panel = grab('const PANEL_HTML', "app.get('/', function");
  ok('four streams: msgsG / msgsS / logsG / logsS', 
     /id="msgsG"/.test(panel) && /id="msgsS"/.test(panel) && /id="logsG"/.test(panel) && /id="logsS"/.test(panel));
  ok('old single #msgs / #logs ids are gone', !/id="msgs"/.test(panel) && !/id="logs"/.test(panel));
  ok('live messages route by account (school → msgsS)', /var b=\(m\.account==='school'\)\?\$\('msgsS'\):\$\('msgsG'\)/.test(panel));
  ok('logs route by source ([school] tag / school sources)',
     /function isSchoolLog\(en\)\{return en\.source==='school'\|\|en\.source==='school-handler'/.test(panel));
  ok('GROUPS badge for groups-account entries', /background:#1f6feb">GROUPS<\/span>/.test(panel));
  ok('titles say v68.7 (no more v67 header)', /<title>BreadBot v69<\/title>/.test(panel) && /BreadBot v69 — dual account/.test(panel));
  ok('logged-out dot style exists (blinking red)', /\.s-logged-out\{background:#f85149;animation:blink/.test(panel));
  ok('panel h2 headers label both accounts', /GROUPS ACCOUNT — Live Messages/.test(panel) && /SCHOOL ACCOUNT \(QR2\) — Live Messages/.test(panel));
}

/* ═══ 6. SCRAPER — DIRECT LINKS (incl. NSFW) UNTOUCHED ═══ */
section('6. SCRAPER — every direct site link intact');
{
  const sRoot = path.join(ROOT, '..', 'repo-intelligent-scraper');
  const album = fs.readFileSync(path.join(sRoot, 'album.js'), 'utf8');
  const media = fs.readFileSync(path.join(sRoot, 'media.js'), 'utf8');
  const gif   = fs.readFileSync(path.join(sRoot, 'gif.js'), 'utf8');
  ok('SFW direct: darknaija.com search', album.includes('https://darknaija.com/?s='));
  ok('NSFW direct: pornpics.com main search', album.includes('https://www.pornpics.com/search/?q='));
  ok('NSFW direct: pornpics.com alt (srch.php)', album.includes('https://www.pornpics.com/search/srch.php?q='));
  ok('NSFW direct: old.reddit.com/r/boobs JSON', album.includes('https://old.reddit.com/r/boobs/top/.json?limit=20'));
  ok('NSFW direct: imagefaqs.com search', album.includes('https://www.imagefaqs.com/search?q='));
  ok('GIF sources: tenor + giphy + reddit', gif.includes('https://tenor.com/search/') && gif.includes('https://giphy.com/search/') && gif.includes('https://old.reddit.com/search.json'));
  ok('media.js piped/invidious/cobalt pools intact',
     media.includes('pipedapi.kavin.rocks') && media.includes('inv.nadeko.net') && media.includes('cobalt-api.kwiatekmiki.com'));
  ok('media.js youtube endpoints intact',
     media.includes('https://www.youtube.com/results?search_query=') && media.includes('https://www.youtube.com/youtubei/v1/player'));
  ok('bot side: NSFW site routing unchanged (SCRAPER_NSFW_SITE → nsfw)',
     /const SCRAPER_NSFW_SITE = process\.env\.SCRAPER_NSFW_SITE \|\| 'nsfw';/.test(src));
  ok('bot side: nsfw search still passes nsfw flag', /const site = nsfw \? SCRAPER_NSFW_SITE : SCRAPER_SFW_SITE;/.test(src));
}

/* ═══ SUMMARY ═══ */
console.log('\n' + '═'.repeat(62));
console.log(`  v68.3 TEST: ${pass} passed, ${fail} failed  (${pass + fail} total)`);
console.log('═'.repeat(62));
process.exit(fail ? 1 : 0);
