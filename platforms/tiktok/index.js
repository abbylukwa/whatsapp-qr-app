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
  }

  /* ── Initialize with mobile viewport ───────────────────────── */
  async init() {
    try {
      // TikTok works best with mobile viewport
      const { browser, agent } = await launchStealthBrowser({
        headless: true,
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
      return false;
    }
  }

  /* ── Cookie persistence ────────────────────────────────────── */
  async saveCookies() {
    if (!this.browser) return;
    try {
      const cookies = await this.page.cookies();
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2));
      this.log('info', 'tiktok', 'Cookies saved (' + cookies.length + ')');
    } catch (e) {
      this.log('warn', 'tiktok', 'Cookie save failed: ' + e.message);
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
    if (!this.browser) await this.init();

    try {
      this.log('info', 'tiktok', 'Logging in...');

      await this.page.goto('https://www.tiktok.com/login/phone-or-email', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Check if already logged in (cookies may have worked)
      try {
        const profileIndicator = await this.page.$('[data-e2e="profile-icon"], [data-e2e="me-icon"], div[data-e2e="nav-profile"]');
        if (profileIndicator) {
          this.loggedIn = true;
          await this.saveCookies();
          this.health.successCount++;
          this.data.addToHistory('login', { success: true, method: 'cookies' });
          this.log('info', 'tiktok', 'Already logged in (cookies)');
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

      // Verify login
      const currentUrl = this.page.url();
      if (currentUrl.includes('login')) {
        this.log('error', 'tiktok', 'Login failed');
        this.health.errorCount++;
        this.health.lastError = 'Login failed — check credentials';
        return { success: false, error: 'Login failed — check credentials' };
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
