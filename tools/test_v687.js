#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
 *  BreadBot v68.7 TEST SUITE — MESSAGE DELIVERY + SCRAPER TEST
 *  Verifies every v68.7 guarantee at source level:
 *   1. Admin plain-text DMs → adminDmChat (instant AI, 24/7)
 *   2. Bot-offline warning (self-chat, rate-limited, bot-territory only)
 *   3. !st / !scrapertest — search → download → deliver
 *   4. Boot-time AI backend detection
 *   5. Panel QR hints + alert rewrite
 *   6. Version strings (v68.7 everywhere) + package.json 68.7.0
 * ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PKG  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t){ console.log('\n── ' + t + ' ──'); }

/* ─── 1. ADMIN INSTANT DM CHAT ─────────────────────────────── */
section('1. Admin plain-text DM → instant AI (no more read-and-ignore)');
ok('adminDmChat() function exists',
   /async function adminDmChat\(chatJid, text\)\{/.test(SRC));
ok('handleMessage routes admin text DMs to adminDmChat',
   /if \(!isGroup && isAdmin && text && mediaType === 'text' && !text\.startsWith\('!'\)\s*\n\s*&& !botPaused && Date\.now\(\) >= botOfflineUntil\)\{\s*\n\s*await adminDmChat\(chatJid, text\);/.test(SRC));
ok('adminDmChat applies greeting restart',
   /adminDmChat[\s\S]*?isGreetingRestart\(text\)\) resetConversation\(chatJid, 'admin greeting restart'\)/.test(SRC));
ok('adminDmChat keeps 5-message memory',
   /adminDmChat[\s\S]*?hist\.slice\(-USER_HISTORY_SIZE \* 2\)/.test(SRC));
ok('adminDmChat persists history',
   /adminDmChat[\s\S]*?persistDmHistories\(\);/.test(SRC));
ok('AI-down fallback still acknowledges the admin',
   /AI is down right now — but I got your message/.test(SRC));
ok('admin reply uses fast lane priority 0',
   /adminDmChat[\s\S]*?sendBuffer\(chatJid, \{ text: informalize\(aiReply\) \}, 0, 'fast', 'admin'/.test(SRC));

/* ─── 2. BOT-OFFLINE WARNING ───────────────────────────────── */
section('2. Bot-offline warning (self-chat, rate-limited)');
ok('groupsNumberBase() helper (works while bot socket is down)',
   /function groupsNumberBase\(\)\{/.test(SRC));
ok('falls back to last known botNumber',
   /groupsNumberBase[\s\S]*?botNumber && botNumber !== 'unknown'/.test(SRC));
ok('school guard uses the helper',
   /const groupsBase = groupsNumberBase\(\);/.test(SRC));
ok('warns in the SELF-CHAT (ADMIN_JID), never into the bot chat',
   /schoolReply\(ADMIN_JID, '⚠️ GROUPS BOT IS OFFLINE/.test(SRC));
ok('warning is rate-limited (5 min)',
   /BOT_OFFLINE_WARN_MS = 5 \* 60 \* 1000/.test(SRC) && /botOfflineWarnAllowed\(\)/.test(SRC));
ok('warning only when bot is actually offline (typeof-safe)',
   /typeof connectionStatus !== 'undefined' && connectionStatus !== 'connected'\s*\n\s*&& tHere && isAdmin && typeof botOfflineWarnAllowed === 'function' && botOfflineWarnAllowed\(\)/.test(SRC));
ok('warning names the quote of the lost message',
   /Your message to it was NOT received/.test(SRC));
ok('warning does NOT loop (long text cannot match parseCasualAdmin)',
   (function(){
     const m = SRC.match(/function parseCasualAdmin\(text\)\{[\s\S]*?\n\}/);
     return !!m && /t\.length > 120 \|\| t\.includes\('\\n'\)/.test(m[0]);
   })());

/* ─── 3. SCRAPER DOWNLOAD TEST (!st) ───────────────────────── */
section('3. !st <name> — search → download → deliver');
ok("!st and !scrapertest cases exist",
   /case 'st': case 'scrapertest': \{/.test(SRC));
ok('3-step flow: search / download / send reported',
   /1\/3 Searching\.\.\./.test(SRC) && /2\/3 Downloading first result\.\.\./.test(SRC) && /3\/3 Sending it here\.\.\./.test(SRC));
ok('search failure surfaces the error + cold-start hint',
   /Scraper may be asleep \(free Render cold start\)/.test(SRC));
ok('delivery goes through sendMediaUrl with account passthrough',
   /sendMediaUrl\(chatJid, d\.mediaUrl, \{[\s\S]*?account:opts\.account/.test(SRC));
ok('final verdict reports all 3 steps',
   /ALL 3 STEPS PASSED — search ✓ download ✓ deliver ✓/.test(SRC));
ok('offline hint points at the school self-chat',
   /groups bot offline — run !st from the school self-chat/.test(SRC));
ok('school account may run !st (SCHOOL_COMMANDS)',
   /'whoami','summary','jobs','flow','registry','logs','errors','st','scrapertest'\]/.test(SRC));
ok('COMMAND_LIST documents !st',
   /!st <name> — FULL scraper test/.test(SRC));
ok('!test mentions the full download test',
   /Full download test: !st <name>/.test(SRC));

/* ─── 3b. SCRAPER TEST ON THE PANEL UI ─────────────────────── */
section('3b. Scraper test on the INTERFACE (panel card + endpoint)');
ok('/admin/scraper-test POST endpoint exists',
   /app\.post\('\/admin\/scraper-test', async function\(req,res\)\{/.test(SRC));
ok('endpoint rejects empty queries',
   /Empty query — type a name first\./.test(SRC));
ok('endpoint runs the same search→download flow',
   /scraperSearch\(query, false\)[\s\S]*?scraperDownloadMedia\(s\.images\[0\], 'image'\)/.test(SRC));
ok('endpoint never sends into WhatsApp (JSON verdict only)',
   /Deliberately does NOT send anything into WhatsApp/.test(SRC));
ok('success verdict carries mediaUrl + timings',
   /mediaUrl:d\.mediaUrl[\s\S]*?totalMs: Date\.now\(\)-t0/.test(SRC));
ok('search-failure verdict carries cold-start hint',
   /hint:'Scraper may be asleep[\s\S]*?wait 60s and try again\.'/.test(SRC));
ok('panel card 🧪 Scraper Test with query input',
   /<h2>🧪 Scraper Test<\/h2>[\s\S]*?id="scQuery"[\s\S]*?id="scBtn"/.test(SRC));
ok('panel runScraperTest() calls the endpoint',
   /async function runScraperTest\(\)[\s\S]*?api\('scraper-test','POST',\{query:q\}\)/.test(SRC));
ok('panel shows 2-step live progress + final verdict',
   /1\/2 Searching[\s\S]*?🏆 Scraper works/.test(SRC));
ok('panel result has open-media link',
   /open media ↗/.test(SRC));
ok('panel JS syntax guard exists (check_panel_js.js)',
   fs.existsSync(path.join(__dirname, 'check_panel_js.js')));

/* ─── 4. BOOT AI DETECTION ─────────────────────────────────── */
section('4. AI backend detected at boot (AI: NONE fix)');
ok('detectAIBackend() runs at boot, independent of bot connect',
   /v68\.7: detect the AI backend at BOOT[\s\S]*?detectAIBackend\(\)\.catch\(function\(\)\{\}\);/.test(SRC));
ok('still refreshed on bot connect too',
   /detectAIBackend\(\)\.catch\(e => pushLog\('error','ai','detect: '/.test(SRC));

/* ─── 5. PANEL ─────────────────────────────────────────────── */
section('5. Panel QR labels + honest main-group alert');
ok('QR 1 card says it is the BOT\'s own number',
   /QR 1 = the <b>BOT's own number<\/b> \(groups\)/.test(SRC));
ok('QR 1 card says your phone cannot activate it',
   /it cannot activate this QR/.test(SRC));
ok('QR 2 card says it is YOUR phone',
   /QR 2 = <b>YOUR phone<\/b> \(admin \/ read-only monitor\)/.test(SRC));
ok('noMain alert now tells the truth (auto-set after QR 1)',
   /auto-sets it from ADMIN_GROUP_LINK once QR 1 is scanned/.test(SRC));

/* ─── 6. VERSIONS ──────────────────────────────────────────── */
section('6. Versions');
ok('package.json 68.7.0', PKG.version === '68.7.0', PKG.version);
for (const [name, re] of [
  ['COMMAND_LIST header', /const COMMAND_LIST = `BreadBot v68\.7 — Admin/],
  ['!test banner',        /BreadBot v68\.7 SELF-TEST/],
  ['bot ONLINE message',  /BreadBot v68\.7 ONLINE/],
  ['school ONLINE msg',   /BreadBot v68\.7 SCHOOL account online/],
  ['panel <title>',       /<title>BreadBot v68\.7<\/title>/],
  ['panel <h1>',          /<h1>BreadBot v68\.7 — dual account<\/h1>/],
]) ok(name, re.test(SRC));
ok('no stale v68.6 banner strings left',
   !/BreadBot v68\.6/.test(SRC));

/* ─── 7. NO REGRESSIONS ────────────────────────────────────── */
section('7. Prior guarantees untouched');
ok('AI stays DM-only (v68.5)', /AI conversation is DM-ONLY/.test(SRC));
ok('human-mode reads intact (v68.6)', /scheduleHumanRead/.test(SRC) && /READ_DELAY_MIN_MS/.test(SRC));
ok('school still read-only in groups', /strictly read-only in groups/.test(SRC));
ok('bot-territory guard still returns (no double answers)',
   /the bot's chat is bot territory[\s\S]*?return;\s*\n    \}/.test(SRC));
ok('main-group auto-retry loop intact (v68.3)',
   /Main group still NOT SET — auto-set retry\.\.\./.test(SRC));
ok('auto-join from invite links intact',
   /AUTO-JOIN — extract invite codes from ANY message/.test(SRC));

console.log('\n════════════════════════════════════════════════');
console.log('  v68.7 TEST: ' + pass + ' passed, ' + fail + ' failed');
console.log('════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
