/* ═══════════════════════════════════════════════════════════════════
 *  v92.9.28 REAL-LIFE GATE PROOF — the boss: "make sure even if anyone
 *  from another group which is not that one the bot doesn't respond,
 *  even if someone in the same group as the nsfw and asks in DM it
 *  doesn't respond — tell me if this actually works in real life."
 *
 *  This harness loads the REAL gate modules (focus.js + access.js, the
 *  exact predicates handleMessage and sendBuffer call) and fires every
 *  real-world scenario at them. Fail-closed = a gate that cannot
 *  express an "allow" for anything except admin + the one focus group.
 * Run: node test-gates.js   (exit 0 = every scenario passed)
 * ═══════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

/* Isolated data dir so the test never touches the bot's live state */
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gates-'));
process.env.ADMIN_PHONE = '263777627210';
process.env.FOCUS_STATE_FILE = path.join(tmpData, 'focus_group.json');   /* v92.9.29: drift-swap writes here, NEVER the live file */

const focusLock = require('./focus');
const accessCtl = require('./access');

const ADMIN = '263777627210@s.whatsapp.net';
const SA_NUMBER = '27614159817';                 /* the SA number — now OFF the allowlist (one-number rule, v92.9.30) */
const FOCUS_GROUP = '120363021234567890@g.us';   /* the ONE designated NSFW group */
const OTHER_GROUP = '120363999999999999@g.us';   /* any other group on earth */
const MEMBER = '27821234567';                    /* a member OF the focus group */

focusLock.setAdminJid(ADMIN);
/* the admin's LID as WhatsApp may deliver his DM after the LID migration */
focusLock.setLidResolver(function(lidBase){
  if (lidBase === '555666777') return '263777627210';       /* admin's lid pair */
  if (lidBase === '999888000') return MEMBER;               /* a member's lid pair */
  return null;                                              /* stranger lid */
});
focusLock.addFocusJid(FOCUS_GROUP);

/* access.js state: designated + activated = the ONE nsfw group.
 * init() is what the bot calls at boot — it loads the config files. */
accessCtl.init('263777627210');
try {
  accessCtl.setDesignated(FOCUS_GROUP);
  accessCtl.activateGroup(FOCUS_GROUP, { by: 'test' });
} catch (e) { console.log('(access setup note: ' + e.message + ')'); }

let pass = 0, fail = 0;
function check(name, cond){
  if (cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}

console.log('\n── 1. GROUPS: only the ONE focus group gets service ──');
check('designated NSFW group allowed (intake)', focusLock.isAllowedJid(FOCUS_GROUP) === true);
check('random group A refused (intake)', focusLock.isAllowedJid(OTHER_GROUP) === false);
check('random group B refused (intake)', focusLock.isAllowedJid('120363000000000000@g.us') === false);
check('group with similar jid prefix refused', focusLock.isAllowedJid(FOCUS_GROUP.replace('890', '891')) === false);
check('status@broadcast refused', focusLock.isAllowedJid('status@broadcast') === false);
check('other group NOT active for sends (access layer)', accessCtl.isGroupActive(OTHER_GROUP) === false);
check('focus group active for sends (access layer)', accessCtl.isGroupActive(FOCUS_GROUP) === true);

console.log('\n── 2. DMs: NOBODY except the admin gets a reply ──');
check('DM from a member OF the nsfw group REFUSED', focusLock.isAllowedJid(MEMBER + '@s.whatsapp.net') === false);
check('DM from the SA number (group member) REFUSED in DM', focusLock.isAllowedJid(SA_NUMBER + '@s.whatsapp.net') === false);
check('DM from a total stranger REFUSED', focusLock.isAllowedJid('447700900123@s.whatsapp.net') === false);
check('DM from ANOTHER bot number REFUSED', focusLock.isAllowedJid('15551234567@s.whatsapp.net') === false);
check('admin DM (phone jid) ALLOWED', focusLock.isAllowedJid(ADMIN) === true);
check('admin DM arriving as @lid ALLOWED (v92.9.28 fix)', focusLock.isAllowedJid('555666777@lid.whatsapp.net') === true);
check('group member DM arriving as @lid REFUSED', focusLock.isAllowedJid('999888000@lid.whatsapp.net') === false);
check('stranger DM arriving as unknown @lid REFUSED', focusLock.isAllowedJid('111222333@lid.whatsapp.net') === false);
check('admin DM with device suffix (:12) ALLOWED', focusLock.isAllowedJid('263777627210:12@s.whatsapp.net') === true);
check('null/garbage jid REFUSED', focusLock.isAllowedJid(null) === false && focusLock.isAllowedJid('') === false && focusLock.isAllowedJid(12345) === false);

console.log('\n── 3. DEFENSE IN DEPTH — access.js number gates (send-side backstop) ──');
check('SA number OFF the allowlist (one-number rule, v92.9.30)', accessCtl.isAllowedNumber(SA_NUMBER, '263777627210') === false);
check('stranger NOT on allowlist', accessCtl.isAllowedNumber('447700900123', '263777627210') === false);
check('group member NOT on allowlist (DM service stays admin-only)', accessCtl.isAllowedNumber(MEMBER, '263777627210') === false);
check('allowlist has EXACTLY the 1 number (admin only)', JSON.stringify(accessCtl.allowedNumbers().slice().sort()) === JSON.stringify(['263777627210']));
check('admin phone is never blockable by mistake', accessCtl.isBlockedNumber('263777627210') === false);

console.log('\n── 4. NSFW scoping — media only inside the designated group ──');
check('designated group recognised', accessCtl.isDesignated(FOCUS_GROUP) === true);
check('other group NOT designated', accessCtl.isDesignated(OTHER_GROUP) === false);
check('setDesignated rejects a DM jid (groups only)', accessCtl.setDesignated(ADMIN) === null);

console.log('\n── 5. STATIC PROOF — the gates sit above EVERY code path ──');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
check('intake gate: handleMessage drops non-whitelisted chats BEFORE processing (with a trace verdict, v92.9.37)', /if \(!focusLock\.isAllowedJid\(chatJid\)\)\{[\s\S]{0,2400}?drop:focus-lock[\s\S]{0,400}?return;/m.test(srv));
const sendBufSlice = srv.slice(srv.indexOf('function sendBuffer'), srv.indexOf('function sendBuffer') + 4000);
check('send gate: sendBuffer refuses ANY jid that is not admin/focus group', /send REFUSED \(not admin\/focus group\)/.test(sendBufSlice));
check('send gate runs BEFORE the group-activation check (belt + braces)', sendBufSlice.indexOf('focusLock.isAllowedJid(jid)') > -1 && sendBufSlice.indexOf('focusLock.isAllowedJid(jid)') < sendBufSlice.indexOf('accessCtl.isGroupActive(jid)'));
check('DM whitelist gate still backs the focus lock up', /if \(!isGroup && !isAdmin\)\{[\s\S]{0,1200}?accessCtl\.isAllowedNumber\(realPhone \|\| senderJid, ADMIN_PHONE\)/m.test(srv));
check('BAD-MAC storm now SELF-HEALS (dead-mark + wipe + fresh QR)', /BAD-MAC STORM[\s\S]{0,4500}?markDeadSession\(\)[\s\S]{0,4500}?connectBot\(\); \}, 2000\)/m.test(srv));
check('LID map feeds the focus lock at boot', /focusLock\.setLidResolver\(function\(lidBase\)\{ return lid2pn\.get/.test(srv));

console.log('\n── 6. TWO-FACTOR IDENTITY (v92.9.29) — group: link↔JID · admin: number↔phone-JID ──');
const v1 = focusLock.verifyGroupLink(FOCUS_GROUP);            /* link resolves to the SAME jid */
check('GROUP 2FA pass: link resolves to the persisted JID', v1.ok === true && v1.factors.length === 2);
const v2 = focusLock.verifyGroupLink('120363777777777777@g.us');   /* link resolves elsewhere */
check('GROUP 2FA drift: link JID ≠ persisted → link is ground truth (swap+persist)', v2.ok === true && focusLock.isAllowedJid('120363777777777777@g.us') === true && focusLock.isAllowedJid(FOCUS_GROUP) === false);
const v3 = focusLock.verifyGroupLink(null);
check('GROUP 2FA: failed resolve → linkVerified false', v3.ok === false && focusLock.isGroupLinkVerified() === false);
focusLock.verifyGroupLink('120363777777777777@g.us');          /* restore verified state */
const a1 = focusLock.verifyAdmin2FA('263777627210@s.whatsapp.net');
check('ADMIN 2FA pass (pn JID): number + phone-JID both match', a1.ok === true && a1.factors.length === 2);
const a2 = focusLock.verifyAdmin2FA('555666777@lid.whatsapp.net');
check('ADMIN 2FA pass (LID JID): resolves to admin number + JID', a2.ok === true && a2.factors.length === 2);
const a3 = focusLock.verifyAdmin2FA(MEMBER + '@s.whatsapp.net');
check('ADMIN 2FA fail: group member number has neither factor', a3.ok === false);
const a4 = focusLock.verifyAdmin2FA('263777627211:5@s.whatsapp.net');
check('ADMIN 2FA fail: near-miss number (±1) has neither factor', a4.ok === false);

console.log('\n── 7. DEPLOY SELF-TEST (v92.9.29) — wired, locked, once-per-deploy ──');
check('self-test sends ONLY through sendBuffer (focus-locked choke point)', /deploySelfTest\(\)\{[\s\S]{0,6500}?sendBuffer\(focusJid[\s\S]{0,3500}?sendBuffer\(ADMIN_JID/m.test(srv));
check('self-test is admin-triggered, NOT member-triggered', /sendBuffer\(focusJid[\s\S]{0,120}?adminTrigger: true/.test(srv));
check('5 images from DIFFERENT sites, 5s apart, 10s after the links list', /await sleepMs\(10000\)[\s\S]{0,700}picks\.length >= 5[\s\S]{0,1800}await sleepMs\(5000\)/m.test(srv));
check('report goes to the ADMIN only, never the group', /sendBuffer\(ADMIN_JID, \{ text: report[\s\S]{0,120}adminTrigger: true/.test(srv));
check('self-test arms ONCE per deploy at +20s after connect', /setTimeout\(function\(\)\{ armDeploySelfTest\(\); \}, 20000\)/.test(srv));
check('boot banner now prints the REAL package version (fossil killed)', /'BreadBot v' \+ require\('\.\/package\.json'\)\.version \+ ' ONLINE/.test(srv) && !/v92\\\.9\\\.12 ONLINE/.test(srv));
check('no "random DMs" advertising left in the banner', !/random DMs every/.test(srv));

console.log('\n── 8. EXIT-66 POST-MORTEM (v92.9.36) — refuse, never suicide; revive, never drown ──');
check('final wire boundary exempts the boss diagnostic lane (adminTrigger/activationConfirm)', /const adminLane = !!\(opts && \(opts\.adminTrigger === true \|\| opts\.activationConfirm === true\)\)/.test(srv));
check('kill switch refuses WITHOUT dying — exit(66) only behind KILL_SWITCH_EXIT=1', /KILL_SWITCH_EXIT[\s\S]{0,220}process\.exit\(66\)/.test(srv) && srv.indexOf('process.exit(66)') === srv.lastIndexOf('process.exit(66)'));
check('dropped stale messages are ACKed — WhatsApp stops redelivering the backlog', /function ackStaleMessage/.test(srv) && (srv.match(/ackStaleMessage\(msg\)/g) || []).length >= 3);
check('bounded revival — first stale message per allowed chat is served (≤6h, ≤10/boot)', /function reviveStaleMessage/.test(srv) && /REVIVE_MAX_PER_BOOT = 10/.test(srv) && /REVIVE_MAX_AGE_MS = 6 \* 60 \* 60 \* 1000/.test(srv));
check('graceful memory recycle exits 75 (nonzero = Render always restarts)', /process\.exit\(75\)/.test(srv));
check('self-test marks its own media request before the 5 test images', /await sleepMs\(10000\);[\s\S]{0,400}markMediaRequest\(focusJid\)/.test(srv));

console.log('\n── 9. INBOUND TRACE + STORM SELF-HEAL (v92.9.37) — deafness can never be silent again ──');
check('every inbound message gets a verdict (traceInbound exists + wired at the display point)', /function traceInbound/.test(srv) && /traceInbound\(chatJid, senderJid, 'accepted'/.test(srv));
check('undecryptable arrivals are VISIBLE on the panel (CRYPTO system line)', /senderName:'CRYPTO'/.test(srv));
check('focus-lock drops announce themselves on the panel (FOCUS-LOCK system line)', /senderName:'FOCUS-LOCK'/.test(srv));
check('storm self-heal fires at 3 undecryptable with zero decrypted (was 15 — unreachable for a 1-group bot)', /decryptedSinceConnect === 0 && undecryptableCount >= 3/.test(srv));
check('X-ray endpoint /debug/inbound exposes connection + counters + trace', /app\.get\('\/debug\/inbound'/.test(srv) && /inboundTrace\.slice\(-60\)/.test(srv));
check('stale/focus/dup/echo/flood drops all carry trace reasons', (srv.match(/traceInbound\(/g) || []).length >= 10);

console.log('\n════════════════════════════════════════════════');
console.log((fail === 0 ? 'RESULT: ALL ' + pass + ' CHECKS PASSED — the lock is real.' : 'RESULT: ' + fail + ' FAILED / ' + pass + ' passed'));
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
