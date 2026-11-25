/* ══════════════════════════════════════════════════════════════
 *  MONITOR (v92.9.18) — the boss: "queries downloads monitored thru
 *  storages and sending and queries." Every member query, every media
 *  download and every send lands in an append-only audit trail at
 *  data/monitor.jsonl (one JSON per line), rotated at 2 MB. The admin
 *  reads it with !monitor — totals, per-user breakdown, moderation
 *  events. Disk cost is trivial (a few KB/day) and it shares the
 *  bandwidth meter's philosophy: measure, then act. ═══════════════ */
const fs   = require('fs');
const path = require('path');

const DIR  = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'monitor.jsonl');
const ROTATE_BYTES = 2 * 1024 * 1024;

function _line(obj){
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > ROTATE_BYTES){
      fs.renameSync(FILE, path.join(DIR, 'monitor-' + new Date().toISOString().slice(0, 10) + '.jsonl'));
    }
    fs.appendFileSync(FILE, JSON.stringify(Object.assign({ t: Date.now() }, obj)) + '\n');
  } catch (e) { /* monitoring must never break the bot */ }
}

const today = () => new Date().toISOString().slice(0, 10);
function recordQuery(chat, user, query, kind, results){
  _line({ ev: 'query', chat, user, q: String(query || '').slice(0, 80), kind, n: results || 0 });
}
function recordDownload(kind, bytes, host, ok){
  _line({ ev: 'download', kind, bytes: bytes || 0, host: String(host || '').slice(0, 60), ok: ok !== false });
}
function recordSend(chat, kind, bytes){
  _line({ ev: 'send', chat, kind, bytes: bytes || 0 });
}
function recordMod(chat, user, action, reason, delayMs){
  _line({ ev: 'mod', chat, user, action, reason, delay: delayMs || 0 });
}
function recordAdmin(user, cmd){
  _line({ ev: 'admin', user, cmd: String(cmd || '').slice(0, 40) });
}

/* !monitor — today's rollup from the audit trail */
function summary(){
  let rows = [];
  try { rows = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  const t = rows.filter(r => new Date(r.t).toISOString().slice(0, 10) === today());
  const byUser = {};
  let q = 0, dl = 0, dlBytes = 0, sends = 0, sendBytes = 0, mods = 0;
  for (const r of t){
    if (r.ev === 'query'){ q++; const u = byUser[r.user] = byUser[r.user] || { q: 0, bytes: 0 }; u.q++; }
    else if (r.ev === 'download'){ dl++; dlBytes += r.bytes || 0; }
    else if (r.ev === 'send'){ sends++; sendBytes += r.bytes || 0; if (byUser[r.chat]) byUser[r.chat].bytes += r.bytes || 0; }
    else if (r.ev === 'mod') mods++;
  }
  const mb = (n) => ((n || 0) / (1024 * 1024)).toFixed(1);
  const top = Object.entries(byUser).sort((a, b) => b[1].q - a[1].q).slice(0, 5)
    .map(([u, s]) => '  ' + String(u).split('@')[0].slice(0, 14) + ' — ' + s.q + ' queries');
  return '📡 Monitor today — queries ' + q + ' · downloads ' + dl + ' (' + mb(dlBytes) + ' MB) · sends ' + sends +
    ' (' + mb(sendBytes) + ' MB) · moderation ' + mods +
    (top.length ? '\nTop members:\n' + top.join('\n') : '') +
    (t.length === 0 ? '\n(quiet today)' : '');
}

module.exports = { recordQuery, recordDownload, recordSend, recordMod, recordAdmin, summary };
