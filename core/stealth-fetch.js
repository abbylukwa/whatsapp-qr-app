/* ═══════════════════════════════════════════════════════════════════
 *  v92.9 STEALTH FETCH — JS-challenge bypass for protected sites
 *
 *  The boss: "most sites are regarding a as 404 … yona-yethuu /video/
 *  /album/ look into that." yona-yethuu.co.za sits behind an obfuscated
 *  browser-fingerprint challenge ("One moment, please…" — navigator/
 *  webdriver checks + a computed form). Plain axios/curl can NEVER pass
 *  it; the bot already ships a stealth Chrome stack for Render
 *  (core/anti-detection.js), so render the page in that and hand back
 *  the HTML the same way a phone would see it.
 *
 *  · ONE shared browser, lazily launched, reused across fetches
 *  · challenge detection → wait for the auto-reload (5s timer) → verify
 *  · hard timeout + one retry; every failure falls back to callers
 * ═══════════════════════════════════════════════════════════════════ */
'use strict';

const ant = require('./anti-detection');

let _browser = null;
let _launching = null;
let _lastUse = 0;
const BROWSER_IDLE_MS = 5 * 60 * 1000;      /* close after 5 idle minutes */

async function getBrowser(){
  if (_browser){
    try { if (_browser.connected !== false && _browser.process && !_browser.process.killed) { _lastUse = Date.now(); return _browser; } }
    catch (e) { /* fall through to relaunch */ }
    try { await _browser.close(); } catch (e) {}
    _browser = null;
  }
  if (_launching) return _launching;
  _launching = (async () => {
    /* v92.9: launchStealthBrowser returns { browser, agent } */
    const launched = await ant.launchStealthBrowser({ headless: true });
    const b = launched && launched.browser ? launched.browser : launched;
    _browser = b;
    _lastUse = Date.now();
    /* idle closer — never hold Render memory for nothing */
    const t = setInterval(() => {
      if (!b.connected || Date.now() - _lastUse > BROWSER_IDLE_MS){
        clearInterval(t);
        b.close().catch(() => {});
        if (_browser === b) _browser = null;
      }
    }, 60 * 1000);
    if (t.unref) t.unref();
    return b;
  })();
  try { return await _launching; } finally { _launching = null; }
}

function looksChallenged(html){
  return !!html && /One moment, please|window\.location\.reload\(\)|challenge-platform|cf-browser-verification/i.test(html.slice(0, 20000));
}

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
/* challenge pages reload themselves mid-read — frames detach, reads throw.
 * retry the read instead of dying (v92.9). */
async function safeContent(page){
  let lastErr;
  for (let i = 0; i < 5; i++){
    try { return await page.content(); } catch (e) { lastErr = e; await sleepMs(900); }
  }
  throw (lastErr || new Error('page unreadable'));
}

/* v92.9.3: INTERACTIVE TURNSTILE — playmogo (yona-yethuu's stream host)
 * serves the click-me checkbox class, not the auto-reload class. Real
 * Chrome passes these when something clicks the checkbox inside the
 * challenges.cloudflare.com iframe. Best-effort: hover, wait, click
 * center of the widget; failures are silently ignored (the reload
 * loop keeps trying). */
async function tryClickTurnstile(page){
  try {
    const frames = page.frames();
    for (const f of frames){
      if (!/challenges\.cloudflare\.com/i.test(f.url() || '')) continue;
      const target = await f.$('input[type="checkbox"], label.ctp-checkbox-label, .ctp-checkbox-label, #challenge-stage');
      if (!target) continue;
      const box = await target.boundingBox();
      if (!box || !box.width) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await sleepMs(400 + Math.random() * 500);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
    /* no dedicated frame — sometimes the widget lives in the page itself */
    const inline = await page.$('input[type="checkbox"][name="cf-turnstile-response"], .cf-turnstile');
    if (inline){
      const box = await inline.boundingBox();
      if (box && box.width){
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    }
  } catch (e) { /* challenge frames detach mid-click — the loop retries */ }
  return false;
}

/* Render a URL in the stealth browser, solving "wait-and-reload" JS
 * challenges on the way. Returns final HTML (throws on hard failure). */
async function stealthFetchHtml(url, opts = {}){
  const timeoutMs = opts.timeoutMs || 60000;
  const b = await getBrowser();
  _lastUse = Date.now();
  const page = await b.newPage();
  try {
    if (opts.blockHeavy !== false){
      /* media bytes are wasted weight when we only want HTML */
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = (req.resourceType() || '').toLowerCase();
        if (t === 'media' || t === 'font') req.abort().catch(() => {});
        else req.continue().catch(() => {});
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    /* The challenge reloads itself after ~5s (frame detaches mid-read —
     * reading is unreliable). Re-NAVIGATE instead: the browser now holds
     * the challenge cookie from round 1, so a fresh goto passes it.
     * Interactive Turnstile pages don't reload on their own — click the
     * checkbox before re-navigating (v92.9.3). */
    let html = '';
    for (let round = 0; round < 5; round++){
      try { html = await page.content(); } catch (e) { html = ''; }
      if (html && !looksChallenged(html)) return html;
      await tryClickTurnstile(page);
      await sleepMs(7000);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
      catch (e) { /* navigation raced the challenge reload — keep looping */ }
    }
    if (html && !looksChallenged(html)) return html;
    throw new Error('challenge not solved');
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

function shutdownBrowser(){
  if (_browser){ const b = _browser; _browser = null; b.close().catch(() => {}); }
}

module.exports = { stealthFetchHtml, getBrowser, shutdownBrowser, looksChallenged };
