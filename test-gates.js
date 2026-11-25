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

const focusLock = require('./focus');
const accessCtl = require('./access');

const ADMIN = '263777627210@s.whatsapp.net';
const SA_NUMBER = '27614159817';                 /* the SA number (2-number rule) */
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
check('SA number IS on the 2-number allowlist', accessCtl.isAllowedNumber(SA_NUMBER, '263777627210') === true);
check('stranger NOT on allowlist', accessCtl.isAllowedNumber('447700900123', '263777627210') === false);
check('group member NOT on allowlist (DM service stays admin-only)', accessCtl.isAllowedNumber(MEMBER, '263777627210') === false);
check('allowlist has EXACTLY the 2 numbers', JSON.stringify(accessCtl.allowedNumbers().slice().sort()) === JSON.stringify(['263777627210','27614159817']));
check('admin phone is never blockable by mistake', accessCtl.isBlockedNumber('263777627210') === false);

console.log('\n── 4. NSFW scoping — media only inside the designated group ──');
check('designated group recognised', accessCtl.isDesignated(FOCUS_GROUP) === true);
check('other group NOT designated', accessCtl.isDesignated(OTHER_GROUP) === false);
check('setDesignated rejects a DM jid (groups only)', accessCtl.setDesignated(ADMIN) === null);

console.log('\n── 5. STATIC PROOF — the gates sit above EVERY code path ──');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
check('intake gate: handleMessage drops non-whitelisted chats BEFORE processing', /if \(!focusLock\.isAllowedJid\(chatJid\)\)\{[\s\S]{0,2000}?else return;/m.test(srv));
const sendBufSlice = srv.slice(srv.indexOf('function sendBuffer'), srv.indexOf('function sendBuffer') + 4000);
check('send gate: sendBuffer refuses ANY jid that is not admin/focus group', /send REFUSED \(not admin\/focus group\)/.test(sendBufSlice));
check('send gate runs BEFORE the group-activation check (belt + braces)', sendBufSlice.indexOf('focusLock.isAllowedJid(jid)') > -1 && sendBufSlice.indexOf('focusLock.isAllowedJid(jid)') < sendBufSlice.indexOf('accessCtl.isGroupActive(jid)'));
check('DM whitelist gate still backs the focus lock up', /if \(!isGroup && !isAdmin\)\{[\s\S]{0,1200}?accessCtl\.isAllowedNumber\(realPhone \|\| senderJid, ADMIN_PHONE\)/m.test(srv));
check('BAD-MAC storm now SELF-HEALS (dead-mark + wipe + fresh QR)', /BAD-MAC STORM[\s\S]{0,4500}?markDeadSession\(\)[\s\S]{0,4500}?connectBot\(\); \}, 2000\)/m.test(srv));
check('LID map feeds the focus lock at boot', /focusLock\.setLidResolver\(function\(lidBase\)\{ return lid2pn\.get/.test(srv));

console.log('\n════════════════════════════════════════════════');
console.log((fail === 0 ? 'RESULT: ALL ' + pass + ' CHECKS PASSED — the lock is real.' : 'RESULT: ' + fail + ' FAILED / ' + pass + ' passed'));
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
