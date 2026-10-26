'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/facebook/index.js — Facebook Automation
 *  Uses Puppeteer + stealth for browser automation:
 *    - Login with human-like typing
 *    - Auto-join groups
 *    - Post in groups
 *    - Comment on posts
 *    - Timeline posts
 *    - Content adapter: same content as YouTube, adapted for FB
 *
 *  RATE LIMITS: Half of YouTube frequency (research-based)
 *    - YouTube uploads: 5/day → Facebook posts: 2-3/day
 *    - YouTube community: 2/day → Facebook timeline: 1/day
 *    - Facebook is MORE aggressive at detection than YouTube
 *
 *  ANTI-DETECTION (Facebook-specific):
 *    - Never post identical content to 5+ groups (instant flag)
 *    - Content similarity must be <30% between posts
 *    - Stagger 24-48h between same content on YT and FB
 *    - Post natively (not YouTube links — FB penalizes external reach)
 *    - No midnight-6AM posts (unnatural pattern)
 *    - Minimum 2 rest days/week
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { launchStealthBrowser, warmSession, detectCaptcha } = require('../../core/anti-detection');
const { humanType, humanClick, humanDelay, humanScroll, sleep, randomizeActionOrder } = require('../../core/human-behavior');
const RateLimiter = require('../../core/rate-limiter');
const DataManager = require('../../core/data-manager');
const { writeJSONAtomic } = require('../../core/atomic');
const ScheduleManager = require('../../core/schedule-manager');

class FacebookBot {
  constructor(options = {}) {
    this.email = options.email || process.env.FB_EMAIL || '';
    this.password = options.password || process.env.FB_PASSWORD || '';
    this.dataDir = options.dataDir || './data';
    this.log = options.log || console.log;

    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.cookieFile = path.join(this.dataDir, 'facebook', 'cookies.json');

    // Health tracking
    this.health = {
      lastActionAt: 0,
      lastError: null,
      errorCount: 0,
      successCount: 0,
      startedAt: null,
      browserRestarts: 0
    };

    this.rateLimiter = new RateLimiter('facebook', {
      hourly: 15, daily: 80, cooldown: 8000
    }, this.dataDir);

    this.data = new DataManager('facebook', this.dataDir);
    this.data.setLog(this.log);

    this.schedule = new ScheduleManager('facebook', './schedules');
    this.schedule.setLog(this.log);

    // ── HALF OF YOUTUBE FREQUENCY (research-based) ──────────
    // YouTube: 5 uploads/day → Facebook: 2-3 timeline posts/day
    // YouTube: 2 community/day → Facebook: 1 timeline/day
    // Facebook detects bots FASTER than YouTube — be extra conservative
    this.rateLimiter.setActionLimits('joinGroup', { hourly: 3, daily: 10, cooldown: 30000 });      // YT: 40/day → FB: 10/day
    this.rateLimiter.setActionLimits('postInGroup', { hourly: 4, daily: 20, cooldown: 20000 });     // YT: 50/day → FB: 20/day
    this.rateLimiter.setActionLimits('comment', { hourly: 5, daily: 25, cooldown: 12000 });         // YT: 50/day → FB: 25/day
    this.rateLimiter.setActionLimits('timelinePost', { hourly: 1, daily: 3, cooldown: 60000 });     // YT: 5/day → FB: 3/day (HALF)

    // Content history for similarity checking
    this._recentPosts = [];
    
    // Content pipeline (set by orchestrator)
    this.contentPipeline = null;
    this.interactionTracker = null;
    
    // WhatsApp group link queue for auto-join
    this._groupLinkQueue = [];
  }

  /* ── Wire content pipeline ─────────────────────────────────── */
  setContentPipeline(pipeline) {
    this.contentPipeline = pipeline;
  }

  setInteractionTracker(tracker) {
    this.interactionTracker = tracker;
  }

  /* ── Queue WhatsApp group links for auto-join ──────────────── */
  queueGroupLink(url) {
    if (url && (url.includes('facebook.com/groups') || url.includes('fb.com/groups') || url.includes('m.facebook.com/groups'))) {
      this._groupLinkQueue.push({ url, queuedAt: Date.now() });
      this.log('info', 'facebook', 'Group link queued from WhatsApp: ' + url);
      return true;
    }
    return false;
  }

  /* ════════════════════════════════════════════════════════════
   *  AUTO-POST: Timeline post from content pipeline
   *  HALF of YouTube frequency, Facebook-adapted
   * ════════════════════════════════════════════════════════════ */
  async autoTimelinePost() {
    if (!this.contentPipeline) {
      return { success: false, error: 'Content pipeline not wired' };
    }
    if (!this.isSafePostingTime()) {
      return { success: false, error: 'Unsafe posting time (midnight-6AM)' };
    }
    if (this.isRestDay()) {
      return { success: false, error: 'Rest day — no automated posts' };
    }
    
    const content = this.contentPipeline.getFacebookPost();
    if (!content || !content.text) {
      return { success: false, error: 'No content generated' };
    }
    
    this.log('info', 'facebook', 'Auto timeline post: ' + content.type + ' (' + (content.subject || '') + ')');
    const result = await this.timelinePost(content.text);
    
    if (result.success) {
      this.contentPipeline._recordPost('facebook', content.text, {
        type: content.type,
        subject: content.subject,
        template: content.template
      });
      
      if (this.interactionTracker) {
        this.interactionTracker.recordPost('facebook', {
          type: content.type,
          content: content.text.substring(0, 200),
          subject: content.subject,
          template: content.template
        });
      }
    }
    
    return { ...result, contentType: content.type, subject: content.subject };
  }

  /* ── Auto-join queued groups from WhatsApp ─────────────────── */
  async autoJoinQueuedGroups() {
    let joined = 0;
    const toJoin = this._groupLinkQueue.splice(0, 5); // Max 5 per cycle
    
    for (const item of toJoin) {
      if (!this.rateLimiter.canAct('joinGroup')) break;
      
      const result = await this.joinGroup(item.url);
      if (result.success) {
        joined++;
        this.log('info', 'facebook', 'Auto-joined group from WhatsApp: ' + item.url);
      }
      
      await new Promise(r => setTimeout(r, 10000 + Math.random() * 30000)); // 10-40s between joins
    }
    
    return { success: true, joined, remaining: this._groupLinkQueue.length };
  }

  /* ── Cross-post from YouTube (adapted, at HALF frequency) ─── */
  async autoCrossPostFromYouTube() {
    if (!this.contentPipeline) {
      return { success: false, error: 'Content pipeline not wired' };
    }
    if (!this.isSafePostingTime()) {
      return { success: false, error: 'Unsafe posting time' };
    }
    if (this.isRestDay()) {
      return { success: false, error: 'Rest day' };
    }
    
    // Get YouTube content and adapt for Facebook
    const ytContent = this.contentPipeline.getYouTubeCommunityPost();
    if (!ytContent || !ytContent.text) {
      return { success: false, error: 'No YouTube content to cross-post' };
    }
    
    const adapted = this.contentPipeline.adaptYouTubeForFacebook(ytContent);
    const result = await this.timelinePost(adapted.text);
    
    if (result.success) {
      this.contentPipeline._recordPost('facebook', adapted.text, {
        type: 'yt_crosspost',
        source: 'youtube'
      });
    }
    
    return { ...result, contentType: 'yt_crosspost' };
  }

  /* ── Content Adapter ────────────────────────────────────────
   *  Adapts YouTube content for Facebook:
   *  - Rewrites 40-50% of text (Facebook tone is different)
   *  - Shortens descriptions (FB audiences have shorter attention)
   *  - Adds Facebook-specific formatting (emojis, line breaks)
   *  - Ensures <30% similarity with recent posts (anti-detection)
   *  - Never posts YouTube links (FB penalizes external reach)
   *  - Staggers 24-48h from YouTube posting of same content
   * ─────────────────────────────────────────────────────────── */
  adaptYouTubeContent(ytContent) {
    const {
      title = '',
      description = '',
      tags = [],
      videoUrl = ''  // DON'T use this — FB penalizes external links
    } = ytContent;

    // Rewrite title for Facebook tone (casual, engaging)
    const fbTones = [
      'Check this out! 👀',
      'Thoughts on this? 💭',
      'You need to see this! 🔥',
      'What do you guys think? 🤔',
      'This is interesting...',
      'Drop your thoughts below! 👇',
      'Who can relate? 😅'
    ];
    const tone = fbTones[Math.floor(Math.random() * fbTones.length)];

    // Shorten description for FB (max ~300 chars, FB audiences don't read long)
    let fbDesc = description;
    if (fbDesc.length > 300) {
      fbDesc = fbDesc.substring(0, 280) + '...';
    }

    // Add line breaks for readability (FB formatting)
    fbDesc = fbDesc.replace(/\.\s+/g, '.\n\n');

    // Build Facebook post
    let fbPost = tone + '\n\n';
    if (title) fbPost += title + '\n\n';
    if (fbDesc) fbPost += fbDesc + '\n\n';

    // Add hashtags from YouTube tags (limited to 3-5 for FB)
    const fbTags = randomizeActionOrder(tags).slice(0, 3 + Math.floor(Math.random() * 3));
    if (fbTags.length > 0) {
      fbPost += fbTags.map(t => '#' + t.replace(/\s+/g, '')).join(' ');
    }

    // Check similarity with recent posts (must be <30%)
    const similarity = this._calculateSimilarity(fbPost);
    if (similarity > 0.3) {
      // Too similar — add more variation
      const variations = [
        '\n\nUpdate: ' + new Date().toLocaleDateString(),
        '\n\n[Posted ' + (Math.floor(Math.random() * 24) + 1) + 'h ago]',
        '\n\n---\nWhat are your thoughts on this?',
        '\n\n💬 Comment below!'
      ];
      fbPost += variations[Math.floor(Math.random() * variations.length)];
    }

    // Store for future similarity checks
    this._recentPosts.push(fbPost);
    if (this._recentPosts.length > 20) {
      this._recentPosts = this._recentPosts.slice(-20);
    }

    // NEVER include YouTube URL — FB penalizes external link reach
    // Instead, suggest posting native video separately

    return {
      text: fbPost,
      nativeVideoRecommended: true,  // Suggest uploading video natively to FB
      similarityToRecent: similarity,
      adaptedFrom: 'youtube'
    };
  }

  /* ── Simple text similarity (Jaccard) ─────────────────────── */
  _calculateSimilarity(text) {
    if (this._recentPosts.length === 0) return 0;

    const words = new Set(text.toLowerCase().split(/\s+/));
    let maxSim = 0;

    for (const recent of this._recentPosts) {
      const recentWords = new Set(recent.toLowerCase().split(/\s+/));
      const intersection = [...words].filter(w => recentWords.has(w));
      const union = new Set([...words, ...recentWords]);
      const sim = intersection.length / union.size;
      if (sim > maxSim) maxSim = sim;
    }

    return maxSim;
  }

  /* ── Check if current time is safe to post ────────────────── */
  isSafePostingTime() {
    const hour = new Date().getHours();
    // No posts midnight-6AM (unnatural pattern detected by FB)
    return hour >= 6 && hour < 24;
  }

  /* ── Check if today is a rest day ─────────────────────────── */
  isRestDay() {
    // 2 rest days per week: Sunday (0) and Wednesday (3)
    const day = new Date().getDay();
    return day === 0 || day === 3;
  }

  /* ── Spintax resolver ─────────────────────────────────────── */
  resolveSpintax(text) {
    let resolved = text;
    while (resolved.includes('{')) {
      resolved = resolved.replace(/\{([^{}]+)\}/g, (match, options) => {
        const parts = options.split('|');
        return parts[Math.floor(Math.random() * parts.length)];
      });
    }
    return resolved;
  }

  /* ── Vary text to avoid repetition ────────────────────────── */
  varyText(text) {
    const fillers = [
      'What do you all think? ',
      'Thoughts? ',
      'Let me know your opinion! ',
      'Comment below! ',
      'Share if you agree! '
    ];
    const filler = fillers[Math.floor(Math.random() * fillers.length)];
    return Math.random() > 0.5 ? filler + text : text + ' ' + filler;
  }

  /* ── Initialize and login ──────────────────────────────────── */
  async init() {
    try {
      const { browser, agent } = await launchStealthBrowser({
        headless: true,
        agent: undefined // random agent
      });
      this.browser = browser;
      this.page = await browser.newPage();
      this.health.startedAt = Date.now();

      // Load saved cookies if they exist
      await this.loadCookies();

      this.log('info', 'facebook', 'Browser launched with agent: ' + agent.name + ' — cookies ' + (this.loggedIn ? 'loaded' : 'none saved'));

      // Warm session
      await warmSession(this.page, {
        warmUrl: 'https://www.facebook.com/',
        actions: 5,
        log: this.log
      });

      return true;
    } catch (e) {
      this.log('error', 'facebook', 'Init failed: ' + e.message);
      this.health.lastError = e.message;
      throw e;  // throw so multi-platform orchestrator can catch Chrome errors
    }
  }

  /* ── Cookie persistence ────────────────────────────────────── */
  async saveCookies() {
    if (!this.browser) return;
    try {
      const cookies = await this.page.cookies();
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      writeJSONAtomic(this.cookieFile, cookies);
      this.log('info', 'facebook', 'Cookies saved (' + cookies.length + ')');
    } catch (e) {
      this.log('warn', 'facebook', 'Cookie save failed: ' + e.message);
    }
  }

  async loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        if (cookies.length) {
          await this.page.setCookie(...cookies);
          this.log('info', 'facebook', 'Cookies loaded (' + cookies.length + ')');
        }
      }
    } catch (e) {
      this.log('warn', 'facebook', 'Cookie load failed: ' + e.message);
    }
  }

  /* ── Login ─────────────────────────────────────────────────── */
  async login() {
    if (!this.page) await this.init();

    try {
      this.log('info', 'facebook', 'Logging in...');

      await this.page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 4000);

      // Check if already logged in (cookies may have worked)
      try {
        const alreadyIn = await this.page.$('[data-testid="left_nav_item_Home"], a[href*="/feed/"], [aria-label="Home"]');
        if (alreadyIn) {
          this.loggedIn = true;
          await this.saveCookies();
          this.health.successCount++;
          this.data.addToHistory('login', { success: true, method: 'cookies' });
          this.log('info', 'facebook', 'Already logged in (cookies)');
          return { success: true };
        }
      } catch (e) {}

      // Check for CAPTCHA
      const captcha = await detectCaptcha(this.page);
      if (captcha.detected) {
        this.log('warn', 'facebook', 'CAPTCHA detected on login page!');
        this.health.errorCount++;
        this.health.lastError = 'CAPTCHA detected';
        return { success: false, error: 'CAPTCHA detected' };
      }

      // Type email with human-like behavior
      await humanType(this.page, '#email', this.email, { wpm: 50 + Math.random() * 30 });
      await humanDelay(500, 1500);

      // Type password
      await humanType(this.page, '#pass', this.password, { wpm: 55 + Math.random() * 25 });
      await humanDelay(800, 2000);

      // Click login button
      await humanClick(this.page, '[type="submit"]');
      await humanDelay(3000, 6000);

      // Check if login succeeded
      const currentUrl = this.page.url();
      if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
        this.log('error', 'facebook', 'Login failed - still on login page or checkpoint');
        this.health.errorCount++;
        this.health.lastError = 'Login failed - check credentials or 2FA';
        return { success: false, error: 'Login failed - check credentials or 2FA' };
      }

      this.loggedIn = true;
      await this.saveCookies();
      this.health.successCount++;
      this.data.addToHistory('login', { success: true });
      this.log('info', 'facebook', 'Logged in successfully');
      return { success: true };

    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'facebook', 'Login error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Ensure logged in (auto-retry) ─────────────────────────── */
  async ensureReady() {
    if (this.loggedIn && this.page && !this.page.isClosed()) return true;
    this.log('info', 'facebook', 'Re-establishing session...');
    const loginResult = await this.login();
    return loginResult.success;
  }

  /* ── Browser restart on crash ──────────────────────────────── */
  async restartBrowser() {
    this.log('warn', 'facebook', 'Restarting browser...');
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

  /* ── Auto-join group ───────────────────────────────────────── */
  async joinGroup(groupUrl) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('joinGroup')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'facebook', `Joining group: ${groupUrl}`);
      this.health.lastActionAt = Date.now();

      await this.page.goto(groupUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Scroll to see the join button
      await humanScroll(this.page, 'down', 2);

      // Look for join button
      // v84.1 FIX: ':has-text()' is a PLAYWRIGHT pseudo-class — Puppeteer's
      // page.$() throws on it, and the try/catch swallowed the error so
      // these two selectors NEVER matched. Puppeteer ≥20 supports
      // 'xpath/' prefixed selectors — use those instead.
      const joinSelectors = [
        '[aria-label="Join"]',
        '[aria-label="Join Group"]',
        'xpath/.//div[@role="button"][.//span[contains(text(), "Join")]]',
        'xpath/.//span[contains(text(), "Join Group")]'
      ];

      for (const selector of joinSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            await humanClick(this.page, selector);
            await humanDelay(2000, 4000);

            // Handle any popup
            try {
              const confirmBtn = await this.page.$('[aria-label="Confirm"]');
              if (confirmBtn) await humanClick(this.page, '[aria-label="Confirm"]');
            } catch (e) {}

            this.rateLimiter.record('joinGroup');
            this.health.successCount++;
            this.data.addToList('joinedGroups', { url: groupUrl, joinedAt: Date.now() });
            this.data.addToHistory('joinGroup', { groupUrl, success: true });
            this.log('info', 'facebook', `Joined group: ${groupUrl}`);
            return { success: true };
          }
        } catch (e) {}
      }

      return { success: false, error: 'Join button not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'facebook', `Join group error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /* ── Post in group (with content variation) ────────────────── */
  async postInGroup(groupUrl, message) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('postInGroup')) return { success: false, error: 'Rate limited' };
    if (!this.isSafePostingTime()) return { success: false, error: 'Unsafe posting time (midnight-6AM)' };
    if (this.isRestDay()) return { success: false, error: 'Rest day — no automated posts' };

    try {
      this.log('info', 'facebook', `Posting in group: ${groupUrl}`);
      this.health.lastActionAt = Date.now();

      // Vary the message to avoid identical content detection
      const variedMessage = this.varyText(message);

      await this.page.goto(groupUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(3000, 6000);

      // Find the post composer
      const postSelectors = [
        '[aria-label="Create a public post"]',
        '[aria-label="Write something..."]',
        '[placeholder="Write something..."]',
        '[data-placeholder="Write something..."]'
      ];

      for (const selector of postSelectors) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await humanClick(this.page, selector);
            await humanDelay(1000, 2000);
            await humanType(this.page, selector, variedMessage, { wpm: 35 + Math.random() * 25 });
            await humanDelay(1000, 3000);

            // Find and click post button
            // v84.1 FIX: :has-text() was Playwright-only (never matched)
            const postBtnSelectors = [
              '[aria-label="Post"]',
              'xpath/.//div[@role="button"][.//span[contains(text(), "Post")]]'
            ];

            for (const btnSelector of postBtnSelectors) {
              try {
                const btn = await this.page.$(btnSelector);
                if (btn) {
                  await humanClick(this.page, btnSelector);
                  await humanDelay(2000, 4000);

                  this.rateLimiter.record('postInGroup');
                  this.health.successCount++;
                  this.data.addToHistory('postInGroup', { groupUrl, success: true });
                  this.log('info', 'facebook', `Posted in group: ${groupUrl}`);
                  return { success: true };
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      return { success: false, error: 'Post composer not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'facebook', `Post error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /* ── Comment on a post ─────────────────────────────────────── */
  async commentOnPost(postUrl, comment) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('comment')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'facebook', `Commenting on: ${postUrl}`);
      this.health.lastActionAt = Date.now();

      await this.page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Read/scroll first (human-like)
      await humanScroll(this.page, 'down', 2);
      await humanDelay(1000, 3000);

      const variedComment = this.varyText(comment);
      const commentSelectors = [
        '[aria-label="Write a comment"]',
        '[placeholder="Write a comment..."]',
        '[contenteditable="true"][aria-label="Comment"]'
      ];

      for (const selector of commentSelectors) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await humanClick(this.page, selector);
            await humanDelay(500, 1500);
            await humanType(this.page, selector, variedComment, { wpm: 40 + Math.random() * 30 });
            await humanDelay(500, 2000);

            // Press Enter or click comment button
            await this.page.keyboard.press('Enter');
            await humanDelay(2000, 4000);

            this.rateLimiter.record('comment');
            this.health.successCount++;
            this.data.addToHistory('comment', { postUrl, success: true });
            this.log('info', 'facebook', `Commented on: ${postUrl}`);
            return { success: true };
          }
        } catch (e) {}
      }

      return { success: false, error: 'Comment field not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'facebook', `Comment error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /* ── Timeline post (HALF of YouTube frequency) ────────────── */
  async timelinePost(message) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('timelinePost')) return { success: false, error: 'Rate limited — half YouTube frequency' };
    if (!this.isSafePostingTime()) return { success: false, error: 'Unsafe posting time (midnight-6AM)' };
    if (this.isRestDay()) return { success: false, error: 'Rest day — no automated posts' };

    try {
      this.log('info', 'facebook', 'Posting to timeline...');
      this.health.lastActionAt = Date.now();

      const variedMessage = this.varyText(message);

      await this.page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 4000);

      const postSelectors = [
        '[aria-label="Create a post"]',
        '[aria-label="What\'s on your mind?"]',
        '[placeholder="What\'s on your mind?"]'
      ];

      for (const selector of postSelectors) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await humanClick(this.page, selector);
            await humanDelay(1000, 2000);
            await humanType(this.page, selector, variedMessage, { wpm: 35 + Math.random() * 20 });
            await humanDelay(1000, 3000);

            // Click post button
            const postBtn = await this.page.$('[aria-label="Post"]');
            if (postBtn) {
              await humanClick(this.page, '[aria-label="Post"]');
              await humanDelay(2000, 4000);

              this.rateLimiter.record('timelinePost');
              this.health.successCount++;
              this.data.addToHistory('timelinePost', { success: true });
              this.log('info', 'facebook', 'Timeline post successful');
              return { success: true };
            }
          }
        } catch (e) {}
      }

      return { success: false, error: 'Post composer not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'facebook', `Timeline post error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /* ── Cross-post from YouTube (adapted, not identical) ─────── */
  async crossPostFromYouTube(ytContent) {
    const adapted = this.adaptYouTubeContent(ytContent);

    if (adapted.similarityToRecent > 0.5) {
      this.log('warn', 'facebook', 'Cross-post skipped — too similar to recent post (' + Math.round(adapted.similarityToRecent * 100) + '%)');
      return { success: false, error: 'Content too similar to recent post', similarity: adapted.similarityToRecent };
    }

    this.log('info', 'facebook', 'Cross-posting from YouTube (adapted for Facebook)');
    return await this.timelinePost(adapted.text);
  }

  /* ── Broadcast (post to all joined groups, varied content) ── */
  async broadcast(message) {
    const groups = this.data.getList('joinedGroups');
    const results = { sent: 0, failed: 0 };

    // Check safe posting conditions
    if (!this.isSafePostingTime()) {
      return { sent: 0, failed: 0, error: 'Unsafe posting time' };
    }
    if (this.isRestDay()) {
      return { sent: 0, failed: 0, error: 'Rest day' };
    }

    // NEVER post identical content to 5+ groups (instant flag)
    const maxGroupsPerBroadcast = Math.min(groups.length, 4);

    for (const group of groups.slice(0, maxGroupsPerBroadcast)) {
      // Vary message per group (critical for FB detection avoidance)
      const variedMessage = this.varyText(message);
      const result = await this.postInGroup(group.url, variedMessage);
      if (result.success) results.sent++;
      else results.failed++;
      await humanDelay(8000, 20000); // longer delay between FB groups
    }

    return results;
  }

  /* ── Health check ──────────────────────────────────────────── */
  async healthCheck() {
    const isAlive = this.browser && this.page && !this.page.isClosed();
    return {
      platform: 'facebook',
      alive: isAlive,
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus()
    };
  }

  /* ── Status ────────────────────────────────────────────────── */
  getStatus() {
    return {
      platform: 'facebook',
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus(),
      data: this.data.getStats(),
      schedule: this.schedule.getStatus(),
      safePostingTime: this.isSafePostingTime(),
      restDay: this.isRestDay()
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
    this.log('info', 'facebook', 'Closed');
  }
}

module.exports = FacebookBot;
