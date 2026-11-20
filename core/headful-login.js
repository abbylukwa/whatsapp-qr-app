'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  v84.5.3 — POP-OUT (HEADFUL) LOGIN ENGINE
 *
 *  THE CAPTCHA KILLER: opens a REAL visible Chrome window. The OWNER
 *  logs in by hand (types the password, solves the CAPTCHA / 2FA /
 *  checkpoint — human challenges are easy for a human). The engine
 *  polls the window every 3s; the moment a proof session cookie
 *  appears, ALL of that window's cookies are saved to
 *    data/<platform>/cookies.json
 *  — the exact file every platform bot auto-loads at init. After
 *  that the bot is logged in on every boot: no password typing, no
 *  CAPTCHA, ever again.
 *
 *  Used by TWO entry points:
 *    • login-window.js            (standalone, on the owner's PC)
 *    • POST /admin/platform-headful-login (panel "🔓 pop-out" button,
 *      only on hosts with a screen — cloud hosts honestly decline)
 * ═══════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs   = require('fs');
const { launchStealthBrowser } = require('./anti-detection');

const HEADFUL_FLOWS = {
  twitter: {
    label: 'Twitter / X',
    url: 'https://x.com/i/flow/login',
    proofCookies: ['auth_token', 'twid'],
    hint: 'Type the username/password and solve anything X throws up (CAPTCHA / 2FA). In = home feed shows.'
  },
  youtube: {
    label: 'YouTube',
    url: 'https://www.youtube.com/',
    proofCookies: ['SID', 'SSID', 'SAPISID'],
    hint: 'Click "Sign in" (top-right) and log into the Google account. In = your avatar shows.'
  },
  facebook: {
    label: 'Facebook',
    url: 'https://www.facebook.com/login',
    proofCookies: ['c_user', 'xs'],
    hint: 'Log in — solve the checkpoint if one shows. In = the home feed shows.'
  },
  tiktok: {
    label: 'TikTok',
    url: 'https://www.tiktok.com/login/phone-or-email',
    proofCookies: ['sessionid', 'sessionid_ss', 'sid_guard'],
    hint: 'Log in by phone/email or QR. In = the For-You feed shows.'
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Open a headful Chrome window and wait for the human to log in.
 * @param {string} name   twitter | youtube | facebook | tiktok
 * @param {object} opts   { timeoutMs (default 8 min), log (fn), proxyOverride }
 * @returns {ok:boolean, saved?:number, file?:string, error?:string, timedOut?:boolean}
 */
async function headfulLogin(name, opts = {}) {
  const cfg = HEADFUL_FLOWS[name];
  if (!cfg) return { ok: false, error: 'unknown platform: ' + name + ' — use one of: ' + Object.keys(HEADFUL_FLOWS).join(', ') };

  const timeoutMs = opts.timeoutMs || (8 * 60 * 1000);
  const log = opts.log || function(){};
  const proxy = opts.proxyOverride || process.env[name.toUpperCase() + '_PROXY'] || process.env.PROXY_URL || null;

  log('info', 'headful', cfg.label + ': opening a REAL Chrome window — ' + cfg.hint);

  let browser = null;
  try {
    const launched = await launchStealthBrowser({
      headless: false,                                  // ← THE pop-out window
      proxy
    });
    browser = launched.browser;
    const page = await browser.newPage();
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
      log('warn', 'headful', cfg.label + ': page still loading (' + e.message.split('\n')[0] + ') — window is open, continue');
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        if (page.isClosed()) {
          return { ok: false, error: cfg.label + ': window was closed before the login completed — nothing saved' };
        }
        const cookies = await page.cookies();
        const proof = cookies.find(c => cfg.proofCookies.includes(c.name));
        if (proof) {
          const dir = path.join(process.cwd(), 'data', name);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'cookies.json');
          fs.writeFileSync(file + '.tmp', JSON.stringify(cookies));
          fs.renameSync(file + '.tmp', file);
          log('info', 'headful', cfg.label + ': LOGGED IN — ' + cookies.length + ' cookies saved (proof: ' + proof.name + ') → data/' + name + '/cookies.json');
          return { ok: true, saved: cookies.length, file: 'data/' + name + '/cookies.json', proof: proof.name };
        }
      } catch (e) { /* page mid-navigation — keep polling */ }
    }
    log('warn', 'headful', cfg.label + ': no session cookie within ' + Math.round(timeoutMs / 60000) + ' min — nothing saved, nothing broken');
    return { ok: false, timedOut: true, error: cfg.label + ': no session cookie appeared within ' + Math.round(timeoutMs / 60000) + ' min — login not completed in the window (nothing saved, nothing broken — just try again)' };
  } catch (e) {
    const msg = e.message || String(e);
    if (/Missing X server|cannot open display|No usable sandbox/i.test(msg)) {
      return { ok: false, noDisplay: true, error: 'this machine has NO screen — a pop-out window is impossible here. Run this on YOUR OWN PC (node login-window.js ' + name + ') and the window will pop out there.' };
    }
    log('error', 'headful', cfg.label + ': pop-out failed: ' + msg);
    return { ok: false, error: cfg.label + ' pop-out login failed: ' + msg };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

module.exports = { headfulLogin, HEADFUL_FLOWS };
