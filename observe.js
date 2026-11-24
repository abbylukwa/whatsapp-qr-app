/* ══════════════════════════════════════════════════════════════
 *  OBSERVE MODE (v92.9.20) — the boss: "my bot to just listen send
 *  nothing ... not sending anything for 3 hours, let the chats get
 *  used to the environment", then look at the logs and decide
 *  refinements vs activation.
 *
 *  WHAT IT DOES:
 *   · every whitelisted GROUP message is captured to
 *     data/chatlog.jsonl (user, text, hour) — the raw material for
 *     the refinement decision
 *   · ZERO outbound activity to groups: no replies, no AI, no media,
 *     no moderation kicks/warns, no probes, no broadcasts. Admin DMs
 *     keep working (private — the group never sees them).
 *   · auto-expires after the set hours (default 3); the expiry is
 *     persisted, so even a crash/reboot/reconnect never wakes it up
 *     early and never keeps it silent for longer than ordered.
 *
 *  CONTROLS (admin DM only): !observe on [hours] · !observe off ·
 *  !observe status · !observe report — the report is the decision
 *  data: who talks, what they ask for, links/scams seen, languages. ═ */
const fs   = require('fs');
const path = require('path');

const DIR      = path.join(__dirname, 'data');
const STATE    = path.join(DIR, 'observe.json');
const CHATLOG  = path.join(DIR, 'chatlog.jsonl');
const ROTATE   = 5 * 1024 * 1024;

let st = { on: false, until: 0, startedAt: 0, hours: 0 };
try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (j && typeof j.until === 'number') st = j; } catch (e) {}

function persist(){ try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st)); } catch (e) {} }
function active(){ return st.on && Date.now() < st.until; }
function remainingMs(){ return active() ? st.until - Date.now() : 0; }
function setMode(on, hours){
  st = on ? { on: true, until: Date.now() + (hours || 3) * 3600 * 1000, startedAt: Date.now(), hours: hours || 3 }
          : { on: false, until: 0, startedAt: 0, hours: 0 };
  persist();
  return st;
}
function status(){
  if (active()){
    const h = Math.floor(remainingMs() / 3600000), m = Math.round((remainingMs() % 3600000) / 60000);
    return '👂 OBSERVE MODE — silent for ' + h + 'h ' + m + 'm more (listening, capturing, sending nothing to the group).';
  }
  return st.on ? '👂 observe window ended — bot is back to normal.' : '👂 observe OFF — bot is live.';
}

/* capture every group message while observing (rotating file) */
function capture(chat, user, text){
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(CHATLOG) && fs.statSync(CHATLOG).size > ROTATE){
      fs.renameSync(CHATLOG, path.join(DIR, 'chatlog-' + new Date().toISOString().slice(0, 10) + '.jsonl'));
    }
    fs.appendFileSync(CHATLOG, JSON.stringify({ t: Date.now(), chat: chat.slice(0, 30), user: String(user || '').slice(0, 40), text: String(text || '').slice(0, 300) }) + '\n');
  } catch (e) { /* never break the bot for a log */ }
}

/* !observe report — the refinement-decision data */
function report(){
  let rows = [];
  try { rows = fs.readFileSync(CHATLOG, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  if (!rows.length) return '📭 No chat captured yet — the observe window has not seen messages.';
  const byUser = {}, byHour = {};
  let asks = 0, links = 0, scamish = 0, greetings = 0;
  const ASK = /(send|give|show|need|want|looking for|please).{0,30}(pic|pics|photo|video|vid|gif|movie|film|song|music|clip)/i;
  const LINK = /https?:\/\/|chat\.whatsapp\.com|t\.me\//i;
  const SCAMISH = /(double|investment|forex|fixed match|free data|giveaway|earn)/i;
  const GREET = /^(hi|hello|hey|hie|morning|evening|mhoroi|mhoro|salut|hola|سلام)/i;
  for (const r of rows){
    const u = byUser[r.user] = byUser[r.user] || { n: 0, asks: 0 };
    u.n++;
    const d = new Date(r.t); byHour[d.getHours()] = (byHour[d.getHours()] || 0) + 1;
    if (ASK.test(r.text)){ asks++; u.asks++; }
    if (LINK.test(r.text)) links++;
    if (SCAMISH.test(r.text)) scamish++;
    if (GREET.test(r.text)) greetings++;
  }
  const top = Object.entries(byUser).sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([u, s]) => '  ' + String(u).split('@')[0].slice(0, 14) + ' — ' + s.n + ' msgs' + (s.asks ? ' (' + s.asks + ' media asks)' : ''));
  const hours = Object.entries(byHour).sort((a, b) => a[0] - b[0]).map(([h, n]) => h + ':00×' + n).join(' ');
  return '📊 OBSERVE REPORT — ' + rows.length + ' messages captured, ' + Object.keys(byUser).length + ' speakers\n' +
    'Media asks: ' + asks + ' · links: ' + links + ' · scam-ish: ' + scamish + ' · greetings: ' + greetings + '\n' +
    'Activity by hour: ' + hours + '\nTop speakers:\n' + top.join('\n') +
    '\n(decide: refinements vs activation — the trail is in data/chatlog.jsonl)';
}

module.exports = { active, setMode, status, remainingMs, capture, report, _state: () => st };
