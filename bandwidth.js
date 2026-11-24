/* ══════════════════════════════════════════════════════════════
 *  BANDWIDTH METER (v92.9.15) — Render Hobby plan: 5 GB/month TOTAL
 *  bandwidth; at 70% the platform starts warning and soon after it
 *  CUTS THE SERVICE OFF. Media downloads + WhatsApp uploads are the
 *  only big consumers (AI texts are kilobytes), so the bot now meters
 *  its own media bytes and stops heavy media on a DAILY BUDGET before
 *  the month runs dry. Texts, commands and AI keep working — the bot
 *  just stops hauling megabytes until tomorrow.
 *
 *  Records:
 *    · DOWN — every media download (downloadAndCheck / video / music)
 *    · UP   — every media UPLOAD (buffer payloads handed to Baileys)
 *  URL-delivered sends (Baileys fetches them itself) are not directly
 *  measurable — their DOWN was already counted by downloadAndCheck or
 *  the scraper proxy, so the meter is a FLOOR, never an over-count.
 *
 *  BUDGET: BANDWIDTH_DAILY_BUDGET_MB (env, default 120 MB/day ≈ 3.6
 *  GB/month of media headroom, leaving room for deploys + pings).
 *  At ≥80% the admin gets ONE warning; over 100% media is refused
 *  (polite note to the asker) until the next day. ═══════════════ */
const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'bandwidth.json');
const BUDGET_MB  = Math.max(1, parseInt(process.env.BANDWIDTH_DAILY_BUDGET_MB || '120', 10));

let state = { day: '', downBytes: 0, upBytes: 0, warned80: false, warned100: false };
try {
  const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (j && typeof j.downBytes === 'number') state = Object.assign(state, j);
} catch (e) { /* fresh start */ }

function today(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
let saveTimer = null;
function save(){
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
  }, 3000);
  if (saveTimer.unref) saveTimer.unref();
}
function rollDay(){
  const t = today();
  if (state.day !== t){
    state = { day: t, downBytes: 0, upBytes: 0, warned80: false, warned100: false };
    save();
    return true;      /* a new day started */
  }
  return false;
}
function recordDown(n){
  if (!n || n <= 0) return;
  rollDay();
  state.downBytes += n;
  save();
}
function recordUp(n){
  if (!n || n <= 0) return;
  rollDay();
  state.upBytes += n;
  save();
}
function totalBytes(){ rollDay(); return (state.downBytes || 0) + (state.upBytes || 0); }
function budgetBytes(){ return BUDGET_MB * 1024 * 1024; }
function pctUsed(){ return Math.round((totalBytes() / budgetBytes()) * 100); }
/* 0 = fine · 1 = ≥80% (warn admin once) · 2 = over (media refused) */
function overBudget(){ const p = pctUsed(); return p >= 100 ? 2 : (p >= 80 ? 1 : 0); }
function shouldWarn(){
  const lvl = overBudget();
  if (lvl === 2 && !state.warned100){ state.warned100 = true; save(); return { level: 2, pct: pctUsed() }; }
  if (lvl === 1 && !state.warned80){ state.warned80 = true; save(); return { level: 1, pct: pctUsed() }; }
  return null;
}
function mediaAllowed(){ rollDay(); return overBudget() < 2; }
/* runtime budget change (!bw N mb) — rebinds the budget reader */
let budgetOverride = 0;
function setBudgetMB(n){
  budgetOverride = Math.max(1, parseInt(n, 10) || 0);
  budgetBytes = function(){ return budgetOverride * 1024 * 1024; };
  return budgetOverride;
}
function summary(){
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  return '📊 Bandwidth today: ' + mb(totalBytes()) + ' / ' + BUDGET_MB + ' MB (' + pctUsed() + '%)' +
    ' · down ' + mb(state.downBytes || 0) + ' MB · up ' + mb(state.upBytes || 0) + ' MB';
}
/* test hook */
function _setState(s){ state = Object.assign(state, s); }

module.exports = { recordDown, recordUp, totalBytes, budgetBytes, pctUsed, overBudget, shouldWarn, mediaAllowed, summary, setBudgetMB, _setState };
