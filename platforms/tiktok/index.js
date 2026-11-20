'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/tiktok/index.js — TikTok Automation
 *  TikTok is the hardest platform to automate. Most actions
 *  require browser automation with extreme caution:
 *    - Follow users (browser, risky)
 *    - Comment on videos (browser, risky)
 *    - Like videos (browser, risky)
 *    - Video watch simulation (browser)
 *  Uses mobile viewport emulation for best results.
 *  Cookie persistence, health tracking, and auto-recovery included.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { launchStealthBrowser, warmSession, detectCaptcha } = require('../../core/anti-detection');
const { humanType, humanClick, humanDelay, humanScroll, sleep } = require('../../core/human-behavior');
const RateLimiter = require('../../core/rate-limiter');
const DataManager = require('../../core/data-manager');
const { writeJSONAtomic } = require('../../core/atomic');
const ScheduleManager = require('../../core/schedule-manager');

class TikTokBot {
  constructor(options = {}) {
    this.username = options.username || process.env.TIKTOK_USERNAME || '';
    this.password = options.password || process.env.TIKTOK_PASSWORD || '';
    this.dataDir = options.dataDir || './data';
    this.log = options.log || console.log;

    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.cookieFile = path.join(this.dataDir, 'tiktok', 'cookies.json');

    // Health tracking
    this.health = {
      lastActionAt: 0,
      lastError: null,
      errorCount: 0,
      successCount: 0,
      startedAt: null,
      browserRestarts: 0
    };

    this.rateLimiter = new RateLimiter('tiktok', {
      hourly: 12, daily: 60, cooldown: 8000
    }, this.dataDir);

    this.data = new DataManager('tiktok', this.dataDir);
    this.data.setLog(this.log);

    this.schedule = new ScheduleManager('tiktok', './schedules');
    this.schedule.setLog(this.log);

    // Very conservative limits — TikTok bans aggressively
    this.rateLimiter.setActionLimits('follow', { hourly: 4, daily: 15, cooldown: 45000 });
    this.rateLimiter.setActionLimits('comment', { hourly: 6, daily: 25, cooldown: 20000 });
    this.rateLimiter.setActionLimits('like', { hourly: 8, daily: 30, cooldown: 12000 });
    this.rateLimiter.setActionLimits('post', { hourly: 1, daily: 5, cooldown: 120000 });
    this.rateLimiter.setActionLimits('watch', { hourly: 10, daily: 60, cooldown: 60000 });  // v84.4 warmFeed
  }

  /* ── Initialize with mobile viewport ───────────────────────── */
  async init() {
    try {
      // TikTok works best with mobile viewport
      const { browser, agent } = await launchStealthBrowser({
        headless: true,
        /* v84.5.2: optional residential/mobile proxy — Set TIKTOK_PROXY or
         * PROXY_URL in env. */
        proxy: process.env.TIKTOK_PROXY || process.env.PROXY_URL || null,
        agent: {
          name: 'mobile-chrome',
          ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.113 Mobile Safari/537.36',
          viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }
        }
      });
      this.browser = browser;
      this.page = await browser.newPage();
      this.health.startedAt = Date.now();

      // Set mobile-specific properties
      await this.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

      // Load saved cookies if they exist
      await this.loadCookies();

      this.log('info', 'tiktok', 'Browser launched with mobile viewport — cookies ' + (this.loggedIn ? 'loaded' : 'none saved'));
      return true;
    } catch (e) {
      this.log('error', 'tiktok', 'Init failed: ' + e.message);
      this.health.lastError = e.message;
      throw e;  // throw so multi-platform orchestrator can catch Chrome errors
    }
  }

  /* ── Cookie persistence ────────────────────────────────────── */
  async saveCookies() {
    if (!this.browser) return;
    try {
      const cookies = await this._tiktokSessionCookies();
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      writeJSONAtomic(this.cookieFile, cookies);
      this.log('info', 'tiktok', 'Cookies saved (' + cookies.length + ')');
    } catch (e) {
      this.log('warn', 'tiktok', 'Cookie save failed: ' + e.message);
    }
  }

  /* v84.5.1: page.cookies() can come back EMPTY on the shell-headless build
   * when TikTok swaps frames mid-load (we observed a logged-in page save 0
   * cookies). CDP Network.getAllCookies reads the WHOLE browser profile and
   * is immune to frame swaps; filter to TikTok domains, fallback to page. */
  async _tiktokSessionCookies() {
    try {
      const client = await this.page.createCDPSession();
      const res = await client.send('Network.getAllCookies');
      await client.detach().catch(() => {});
      return (res.cookies || []).filter(c => /tiktok|byteover/i.test(c.domain || ''));
    } catch (e) {
      return await this.page.cookies().catch(() => []);
    }
  }

  async loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        if (cookies.length) {
          await this.page.setCookie(...cookies);
          this.log('info', 'tiktok', 'Cookies loaded (' + cookies.length + ')');
        }
      }
    } catch (e) {
      this.log('warn', 'tiktok', 'Cookie load failed: ' + e.message);
    }
  }

  /* ── Login ─────────────────────────────────────────────────── */
  async login() {
    /* v84.5.1: guard BOTH browser and a LIVE page — the old !this.browser
     * check skipped init when the browser existed but this.page didn't,
     * which is exactly the "undefined (reading 'goto')" Connect crash */
    if (!this.browser || !this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      if (this.browser) { try { await this.browser.close(); } catch (e) {} this.browser = null; this.page = null; }
      await this.init();
    }

    try {
      this.log('info', 'tiktok', 'Logging in...');

      await this.page.goto('https://www.tiktok.com/login/phone-or-email', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Check if already logged in (cookies may have worked)
      /* v84.5.1: the login page ITSELF renders profile-ish icons, so the old
       * indicator-only check false-positived and saved ZERO cookies. Real
       * proof = a TikTok session cookie (sessionid / sessionid_ss / sid_guard). */
      try {
        const existing = await this._tiktokSessionCookies();
        const hasRealSession = existing.some(c => ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'].includes(c.name));
        if (hasRealSession) {
          this.loggedIn = true;
          await this.saveCookies();
          this.health.successCount++;
          this.data.addToHistory('login', { success: true, method: 'cookies' });
          this.log('info', 'tiktok', 'Already logged in (session cookie present)');
          return { success: true };
        }
      } catch (e) {}

      // Check for CAPTCHA
      const captcha = await detectCaptcha(this.page);
      if (captcha.detected) {
        this.log('warn', 'tiktok', 'CAPTCHA detected!');
        this.health.errorCount++;
        this.health.lastError = 'CAPTCHA detected';
        return { success: false, error: 'CAPTCHA detected' };
      }

      // Type username
      const usernameInput = await this.page.$('input[name="username"]');
      if (usernameInput) {
        await humanClick(this.page, 'input[name="username"]');
        await humanDelay(300, 800);
        await humanType(this.page, 'input[name="username"]', this.username, { wpm: 40 + Math.random() * 20 });
        await humanDelay(500, 1500);
      }

      // Type password
      const passwordInput = await this.page.$('input[type="password"]');
      if (passwordInput) {
        await humanClick(this.page, 'input[type="password"]');
        await humanDelay(300, 800);
        await humanType(this.page, 'input[type="password"]', this.password, { wpm: 45 + Math.random() * 20 });
        await humanDelay(800, 2000);
      }

      // Click login
      const loginBtn = await this.page.$('button[type="submit"]');
      if (loginBtn) {
        await humanClick(this.page, 'button[type="submit"]');
        await humanDelay(3000, 6000);
      }

      // Verify login (v84.5.1: real proof = session cookie, not just URL)
      const currentUrl = this.page.url();
      const postCk = await this._tiktokSessionCookies();
      const hasSession = postCk.some(c => ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt'].includes(c.name));
      if (currentUrl.includes('login') || !hasSession) {
        this.log('error', 'tiktok', 'Login failed (url: ' + currentUrl + ', session cookie: ' + hasSession + ')');
        this.health.errorCount++;
        this.health.lastError = 'Login failed — check credentials';
        return { success: false, error: currentUrl.includes('login')
          ? 'TikTok stayed on the login page — wrong credentials or a captcha/cchallenge; check TIKTOK_USERNAME/TIKTOK_PASSWORD'
          : 'TikTok left the login page but no session cookie was set — login not confirmed; retry Connect' };
      }

      this.loggedIn = true;
      await this.saveCookies();
      this.health.successCount++;
      this.data.addToHistory('login', { success: true });
      this.log('info', 'tiktok', 'Logged in successfully');
      return { success: true };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'Login error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Ensure logged in (auto-retry) ─────────────────────────── */
  async ensureReady() {
    if (this.loggedIn && this.page && !this.page.isClosed()) return true;
    this.log('info', 'tiktok', 'Re-establishing session...');
    const loginResult = await this.login();
    return loginResult.success;
  }

  /* ── Browser restart on crash ──────────────────────────────── */
  async restartBrowser() {
    this.log('warn', 'tiktok', 'Restarting browser...');
    try {
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {}
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.health.browserRestarts++;
    await this.init();
    return await this.login();
  }

  /* ── Follow user ───────────────────────────────────────────── */
  async follow(username) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('follow')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'tiktok', 'Following: @' + username);
      this.health.lastActionAt = Date.now();

      await this.page.goto('https://www.tiktok.com/@' + username, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Browse profile first (human-like)
      await humanScroll(this.page, 'down', 2);
      await humanDelay(3000, 8000);

      // Click follow
      const followBtn = await this.page.$('button[data-e2e="follow-button"]');
      if (followBtn) {
        await humanClick(this.page, 'button[data-e2e="follow-button"]');
        await humanDelay(2000, 4000);

        this.rateLimiter.record('follow');
        this.health.successCount++;
        this.data.addToList('following', { username, followedAt: Date.now() });
        this.data.addToHistory('follow', { username, success: true });
        this.log('info', 'tiktok', 'Followed: @' + username);
        return { success: true };
      }

      return { success: false, error: 'Follow button not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'Follow error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Comment on video ──────────────────────────────────────── */
  async comment(videoUrl, text) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('comment')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'tiktok', 'Commenting on: ' + videoUrl);
      this.health.lastActionAt = Date.now();

      await this.page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(3000, 6000);

      // Watch the video first (human-like)
      await humanDelay(5000, 15000);

      // Find comment input
      const commentInput = await this.page.$('[data-e2e="comment-input"]');
      if (commentInput) {
        await humanClick(this.page, '[data-e2e="comment-input"]');
        await humanDelay(500, 1500);

        await this.page.keyboard.type(text, { delay: 50 + Math.random() * 100 });
        await humanDelay(500, 2000);

        // Submit comment
        const submitBtn = await this.page.$('[data-e2e="comment-post"]');
        if (submitBtn) {
          await humanClick(this.page, '[data-e2e="comment-post"]');
          await humanDelay(2000, 4000);

          this.rateLimiter.record('comment');
          this.health.successCount++;
          this.data.addToHistory('comment', { videoUrl, success: true });
          this.log('info', 'tiktok', 'Commented on: ' + videoUrl);
          return { success: true };
        }
      }

      return { success: false, error: 'Comment input not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'Comment error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Like video ────────────────────────────────────────────── */
  async like(videoUrl) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('like')) return { success: false, error: 'Rate limited' };

    try {
      this.health.lastActionAt = Date.now();
      await this.page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(3000, 8000);

      const likeBtn = await this.page.$('[data-e2e="like-button"]');
      if (likeBtn) {
        await humanClick(this.page, '[data-e2e="like-button"]');
        await humanDelay(1000, 3000);

        this.rateLimiter.record('like');
        this.health.successCount++;
        this.data.addToHistory('like', { videoUrl, success: true });
        return { success: true };
      }

      return { success: false, error: 'Like button not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'Like error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Watch video simulation ────────────────────────────────── */
  async watchVideo(videoUrl) {
    if (!this.page) await this.init();

    try {
      this.log('info', 'tiktok', 'Watching: ' + videoUrl);
      this.health.lastActionAt = Date.now();
      await this.page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(3000, 6000);

      // Simulate watching with natural pauses
      const watchTime = 10000 + Math.random() * 60000;
      const startTime = Date.now();

      while (Date.now() - startTime < watchTime) {
        await humanDelay(2000, 8000);
        if (Math.random() < 0.3) await humanScroll(this.page, 'down', 1);
      }

      this.health.successCount++;
      this.data.addToHistory('watchVideo', { videoUrl, watchTime: Date.now() - startTime });
      return { success: true, watchTime: Date.now() - startTime };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'Watch error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ═══ v84.4: warmFeed — the automated "watch" task ═══════════
   * schedules/tiktok.json always promised a watchVideo task, but it
   * needed a videoUrl nobody supplies on a schedule, so TikTok had
   * ZERO automation. warmFeed is the schedule-safe version: open the
   * For You feed and watch 3-6 videos with human dwell time (15-45s
   * each). No likes, comments or follows — pure passive engagement
   * and session warming, driven by multi-platform's scheduler. */
  async warmFeed() {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('watch')) return { success: false, error: 'Rate limited' };

    try {
      this.health.lastActionAt = Date.now();
      await this.page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await humanDelay(3000, 6000);

      const captcha = await detectCaptcha(this.page);
      if (captcha.detected) {
        this.log('warn', 'tiktok', 'CAPTCHA on For You feed — aborting warmFeed');
        return { success: false, error: 'CAPTCHA detected' };
      }

      const videos = 3 + Math.floor(Math.random() * 4);   // 3-6 videos
      let watched = 0;
      for (let i = 0; i < videos; i++) {
        await sleep(15000 + Math.floor(Math.random() * 30000));   // dwell 15-45s
        await humanScroll(this.page, 'down', 1);                  // next video
        await humanDelay(800, 2000);
        watched++;
      }

      this.rateLimiter.record('watch');
      this.health.successCount++;
      this.data.addToHistory('watch', { videos: watched });
      this.log('info', 'tiktok', 'warmFeed: watched ' + watched + ' videos (passive engagement)');
      return { success: true, watched };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'tiktok', 'warmFeed error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Broadcast ─────────────────────────────────────────────── */
  async broadcast(message) {
    // TikTok doesn't have groups — broadcast = post as a comment on recent videos
    return { success: false, error: 'TikTok broadcast not supported — use comment() on specific videos' };
  }

  /* ── Health check ──────────────────────────────────────────── */
  async healthCheck() {
    const isAlive = this.browser && this.page && !this.page.isClosed();
    return {
      platform: 'tiktok',
      alive: isAlive,
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus()
    };
  }

  /* ── Status ────────────────────────────────────────────────── */
  getStatus() {
    return {
      platform: 'tiktok',
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus(),
      data: this.data.getStats(),
      schedule: this.schedule.getStatus()
    };
  }

  /* ── Cleanup ───────────────────────────────────────────────── */
  async close() {
    this.schedule.stopAllTasks();
    if (this.loggedIn) await this.saveCookies().catch(() => {});
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
    this.loggedIn = false;
    this.log('info', 'tiktok', 'Closed');
  }
}

module.exports = TikTokBot;
