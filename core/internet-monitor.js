'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/internet-monitor.js — Internet Access & Update Monitor
 *  Ensures the app has internet access and monitors for:
 *    - Internet connectivity (periodic checks)
 *    - Remote updates (git check for newer versions)
 *    - Platform availability (YouTube, FB, Twitter, TikTok)
 *    - DNS resolution
 *    - Proxy health
 *    - Self-update capability
 * ══════════════════════════════════════════════════════════════ */

const https = require('https');
const http = require('http');
const dns = require('dns').promises;

class InternetMonitor {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.checkInterval = options.checkInterval || 300000; // 5 min
    this.platforms = {
      youtube: 'https://www.youtube.com',
      facebook: 'https://www.facebook.com',
      twitter: 'https://x.com',
      tiktok: 'https://www.tiktok.com',
      github: 'https://github.com'
    };
    this.status = {
      internet: false,
      dns: false,
      lastCheck: 0,
      platformStatus: {},
      checkHistory: [],
      updateAvailable: false
    };
    this.timer = null;
    this.updateChecker = options.updateChecker || null; // SelfUpdate instance
  }

  /* ── Start monitoring ─────────────────────────────────────── */
  start() {
    this.timer = setInterval(() => this.check(), this.checkInterval);
    this.check(); // immediate first check
    this.log('info', 'internet', `Monitoring started (every ${this.checkInterval / 1000}s)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ── Run full connectivity check ──────────────────────────── */
  async check() {
    const result = {
      timestamp: Date.now(),
      internet: false,
      dns: false,
      platforms: {}
    };

    // 1. Check internet connectivity
    result.internet = await this._checkInternet();

    // 2. Check DNS resolution
    result.dns = await this._checkDNS();

    // 3. Check each platform
    for (const [name, url] of Object.entries(this.platforms)) {
      result.platforms[name] = await this._checkUrl(url);
    }

    // 4. Check for updates
    if (this.updateChecker) {
      try {
        const updateCheck = await this.updateChecker.checkForUpdate();
        this.status.updateAvailable = updateCheck.hasUpdate;
        result.updateAvailable = updateCheck.hasUpdate;
      } catch (e) {}
    }

    // Update status
    this.status.internet = result.internet;
    this.status.dns = result.dns;
    this.status.lastCheck = result.timestamp;
    this.status.platformStatus = result.platforms;

    // Keep history (last 100)
    this.status.checkHistory.push(result);
    if (this.status.checkHistory.length > 100) {
      this.status.checkHistory = this.status.checkHistory.slice(-100);
    }

    return result;
  }

  /* ── Check basic internet ─────────────────────────────────── */
  _checkInternet() {
    return new Promise((resolve) => {
      const req = https.request('https://www.google.com', { method: 'HEAD', timeout: 5000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  /* ── Check DNS ────────────────────────────────────────────── */
  async _checkDNS() {
    try {
      await dns.resolve('google.com');
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── Check URL availability ───────────────────────────────── */
  _checkUrl(url) {
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
        resolve({
          accessible: res.statusCode >= 200 && res.statusCode < 500,
          statusCode: res.statusCode,
          responseTime: Date.now()
        });
      });
      req.on('error', () => resolve({ accessible: false, statusCode: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ accessible: false, statusCode: 0 }); });
      req.end();
    });
  }

  /* ── Get current status ───────────────────────────────────── */
  getStatus() {
    return { ...this.status, monitoring: !!this.timer };
  }
}

module.exports = InternetMonitor;
