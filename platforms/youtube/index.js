'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/youtube/index.js — YouTube Automation (UNOFFICIAL)
 *  100% browser automation via Puppeteer + stealth — NO API key.
 *
 *  Actions (all via browser, human-like):
 *    - Upload videos (title, description, tags, thumbnail, schedule)
 *    - Community posts (text, image, poll)
 *    - Upload Shorts
 *    - Subscribe to channels
 *    - Comment on videos
 *    - Like videos
 *    - Watch videos (real watch simulation)
 *    - Search videos
 *
 *  Rate limits based on research:
 *    - Uploads:    SAFE 1-5/day, RISKY 6-10, BAN 25+
 *    - Community:  SAFE 1-2/day, RISKY 6-10, BAN 10+
 *    - Comments:   SAFE 1-15/hr, RISKY 15-60, BAN 60+
 *    - Likes:      SAFE <100/hr, RISKY 300-500, BAN 500+
 *    - Subscribes: SAFE <20/hr,  RISKY 50-100, BAN 100+
 *
 *  Anti-detection: stealth browser, human typing, Bezier mouse,
 *  session warming, cookie persistence, fingerprint rotation,
 *  metadata variation, scheduling (not immediate publish).
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { launchStealthBrowser, warmSession, detectCaptcha, rotateFingerprint } = require('../../core/anti-detection');
const { humanType, humanClick, humanDelay, humanScroll, sleep, browseRandomly, randomizeActionOrder } = require('../../core/human-behavior');
const RateLimiter = require('../../core/rate-limiter');
const DataManager = require('../../core/data-manager');
const { writeJSONAtomic } = require('../../core/atomic');
const ScheduleManager = require('../../core/schedule-manager');

class YouTubeBot {
  constructor(options = {}) {
    this.email = options.email || process.env.YOUTUBE_EMAIL || '';
    this.password = options.password || process.env.YOUTUBE_PASSWORD || '';
    this.dataDir = options.dataDir || './data';
    this.log = options.log || console.log;

    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.cookieFile = path.join(this.dataDir, 'youtube', 'cookies.json');

    // Health tracking
    this.health = {
      lastActionAt: 0,
      lastError: null,
      errorCount: 0,
      successCount: 0,
      startedAt: null,
      browserRestarts: 0
    };

    this.rateLimiter = new RateLimiter('youtube', {
      hourly: 20, daily: 100, cooldown: 5000
    }, this.dataDir);

    this.data = new DataManager('youtube', this.dataDir);
    this.data.setLog(this.log);

    this.schedule = new ScheduleManager('youtube', './schedules');
    this.schedule.setLog(this.log);

    // ── Conservative rate limits based on research ──────────
    // Uploads: SAFE = 1-5/day → we use 3hr/5day to stay well within safe
    this.rateLimiter.setActionLimits('upload', { hourly: 1, daily: 5, cooldown: 180000 });  // 3 min between uploads
    // Community posts: SAFE = 1-2/day
    this.rateLimiter.setActionLimits('communityPost', { hourly: 1, daily: 2, cooldown: 120000 });
    // Shorts: same as uploads
    this.rateLimiter.setActionLimits('uploadShort', { hourly: 1, daily: 5, cooldown: 180000 });
    // Subscribe: SAFE <20/hr
    this.rateLimiter.setActionLimits('subscribe', { hourly: 10, daily: 40, cooldown: 12000 });
    // Comment: SAFE 1-15/hr
    this.rateLimiter.setActionLimits('comment', { hourly: 12, daily: 50, cooldown: 15000 });
    // Like: SAFE <100/hr
    this.rateLimiter.setActionLimits('like', { hourly: 15, daily: 60, cooldown: 8000 });
    // Watch: low risk
    this.rateLimiter.setActionLimits('watch', { hourly: 20, daily: 80, cooldown: 3000 });
    // Search: low risk
    this.rateLimiter.setActionLimits('search', { hourly: 30, daily: 120, cooldown: 4000 });

    // Spintax templates for content variation (anti-detection)
    this.spintax = {
      uploadDescriptions: [],
      communityTemplates: []
    };

    // Content pipeline (set by orchestrator after construction)
    this.contentPipeline = null;
    this.interactionTracker = null;
  }

  /* ── Wire content pipeline (called by orchestrator) ────────── */
  setContentPipeline(pipeline) {
    this.contentPipeline = pipeline;
  }

  setInteractionTracker(tracker) {
    this.interactionTracker = tracker;
  }

  /* ════════════════════════════════════════════════════════════
   *  AUTO-POST: Community post from content pipeline
   *  Generates real content and posts it.
   * ════════════════════════════════════════════════════════════ */
  async autoCommunityPost() {
    if (!this.contentPipeline) {
      return { success: false, error: 'Content pipeline not wired' };
    }
    
    const content = this.contentPipeline.getYouTubeCommunityPost();
    if (!content || !content.text) {
      return { success: false, error: 'No content generated' };
    }
    
    this.log('info', 'youtube', 'Auto community post: ' + content.type + ' (' + (content.subject || '') + ')');
    const result = await this.communityPost({ text: content.text });
    
    if (result.success) {
      this.contentPipeline._recordPost('youtube', content.text, {
        type: content.type,
        subject: content.subject,
        template: content.template
      });
      
      if (this.interactionTracker) {
        this.interactionTracker.recordPost('youtube', {
          type: content.type,
          content: content.text.substring(0, 200),
          subject: content.subject,
          template: content.template
        });
      }
    }
    
    return { ...result, contentType: content.type, subject: content.subject };
  }

  /* ── Auto-post a YouTube Short (from pipeline) ─────────────── */
  async autoShort() {
    if (!this.contentPipeline) {
      return { success: false, error: 'Content pipeline not wired' };
    }
    
    const content = this.contentPipeline.getYouTubeShortContent();
    if (!content || !content.text) {
      return { success: false, error: 'No short content generated' };
    }
    
    this.log('info', 'youtube', 'Auto Short: ' + content.type + ' (' + (content.subject || '') + ')');
    
    // If there's a video file, upload it. Otherwise create a community post as text-only short.
    // For now, post as community (text) since we need Blender/TTS for video
    const result = await this.communityPost({
      text: '🎬 SHORT: ' + content.title + '\n\n' + content.text
    });
    
    if (result.success) {
      this.contentPipeline._recordPost('youtube', content.text, {
        type: content.type,
        subject: content.subject,
        template: content.template
      });
    }
    
    return { ...result, contentType: content.type, subject: content.subject };
  }

  /* ── Auto-engage: watch + like + comment on a video ────────── */
  async autoEngage(query) {
    const searchQuery = query || ['science', 'education', 'how to', 'fun facts', 'productivity'][Math.floor(Math.random() * 5)];
    
    // Search for a video
    const results = await this.search(searchQuery);
    if (!results || results.length === 0) {
      return { success: false, error: 'No videos found for: ' + searchQuery };
    }
    
    const video = results[Math.floor(Math.random() * Math.min(3, results.length))];
    const watchResult = await this.watchVideo(video.url);
    const likeResult = await this.like(video.url);
    
    // Comment from pipeline
    let commentResult = { success: false };
    if (this.contentPipeline) {
      const content = this.contentPipeline.getYouTubeCommunityPost();
      if (content && content.text) {
        commentResult = await this.comment(video.url, content.text.substring(0, 200));
      }
    }
    
    return {
      success: watchResult.success || likeResult.success || commentResult.success,
      video: video.url,
      watched: watchResult.success,
      liked: likeResult.success,
      commented: commentResult.success
    };
  }

  /* ── Spintax resolver ─────────────────────────────────────── */
  resolveSpintax(text) {
    // Resolves {option1|option2|option3} patterns
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
    // Add slight variation: shuffle sentences, add/remove filler
    const fillers = [
      'Hey everyone! ', 'What do you think? ', 'Let me know below! ',
      'Check this out! ', 'Thoughts? ', 'Interesting stuff! ',
      'Would love to hear your opinion. ', 'Share your thoughts! '
    ];
    const randomFiller = fillers[Math.floor(Math.random() * fillers.length)];
    // Randomly prepend or append filler (50% chance each)
    if (Math.random() > 0.5) {
      return randomFiller + text;
    }
    return text + ' ' + randomFiller;
  }

  /* ── Generate safe schedule time ──────────────────────────── */
  getSafeScheduleTime() {
    // Schedule videos 30-120 minutes in the future (avoids "instant publish" flag)
    const delay = 30 + Math.floor(Math.random() * 90); // 30-120 min
    const scheduledDate = new Date(Date.now() + delay * 60000);
    return {
      date: scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
      iso: scheduledDate.toISOString()
    };
  }

  /* ── Initialize browser with cookie persistence ────────────── */
  async init() {
    try {
      const { browser, agent } = await launchStealthBrowser({ headless: true });
      this.browser = browser;
      this.page = await browser.newPage();
      this.health.startedAt = Date.now();

      // Load saved cookies if they exist
      await this.loadCookies();

      this.log('info', 'youtube', 'Browser launched (' + agent.name + ') — cookies ' + (this.loggedIn ? 'loaded' : 'none saved'));
      return true;
    } catch (e) {
      this.log('error', 'youtube', 'Init failed: ' + e.message);
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
      this.log('info', 'youtube', 'Cookies saved (' + cookies.length + ')');
    } catch (e) {
      this.log('warn', 'youtube', 'Cookie save failed: ' + e.message);
    }
  }

  async loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        if (cookies.length) {
          await this.page.setCookie(...cookies);
          this.log('info', 'youtube', 'Cookies loaded (' + cookies.length + ')');
        }
      }
    } catch (e) {
      this.log('warn', 'youtube', 'Cookie load failed: ' + e.message);
    }
  }

  /* ── Login via browser ─────────────────────────────────────── */
  async login() {
    if (!this.browser) await this.init();

    try {
      this.log('info', 'youtube', 'Navigating to YouTube...');

      await this.page.goto('https://www.youtube.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await warmSession(this.page, { actions: 3, log: this.log });

      // Check if already logged in (cookies may have worked)
      const avatar = await this.page.$('#avatar-btn');
      if (avatar) {
        this.loggedIn = true;
        await this.saveCookies();
        this.data.addToHistory('login', { success: true, method: 'cookies' });
        this.log('info', 'youtube', 'Already logged in (cookies)');
        return { success: true };
      }

      // Need to login with credentials
      if (!this.email || !this.password) {
        return { success: false, error: 'Set YOUTUBE_EMAIL and YOUTUBE_PASSWORD in env' };
      }

      this.log('info', 'youtube', 'Logging in with credentials...');

      // Click sign in
      await humanClick(this.page, 'a[aria-label="Sign in"]');
      await humanDelay(2000, 4000);

      // Type email
      const emailInput = await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
      if (emailInput) {
        await humanType(this.page, 'input[type="email"]', this.email, { wpm: 45 + Math.random() * 20 });
        await humanDelay(500, 1500);
        await this.page.keyboard.press('Enter');
        await humanDelay(2000, 4000);
      }

      // Type password
      const passInput = await this.page.waitForSelector('input[type="password"]', { timeout: 15000 });
      if (passInput) {
        await humanType(this.page, 'input[type="password"]', this.password, { wpm: 50 + Math.random() * 20 });
        await humanDelay(500, 2000);
        await this.page.keyboard.press('Enter');
        await humanDelay(3000, 6000);
      }

      // Check for CAPTCHA
      const captcha = await detectCaptcha(this.page);
      if (captcha.detected) {
        this.log('warn', 'youtube', 'CAPTCHA detected on login!');
        return { success: false, error: 'CAPTCHA detected — may need manual verification' };
      }

      // Verify login
      await this.page.goto('https://www.youtube.com/', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 3000);

      const avatarAfter = await this.page.$('#avatar-btn');
      if (avatarAfter) {
        this.loggedIn = true;
        await this.saveCookies();
        this.health.successCount++;
        this.data.addToHistory('login', { success: true, method: 'credentials' });
        this.log('info', 'youtube', 'Logged in successfully');
        return { success: true };
      }

      return { success: false, error: 'Login failed — check credentials or 2FA' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Login error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Ensure logged in (auto-retry) ─────────────────────────── */
  /* ── v84.2: UNOFFICIAL verification (no YouTube API anywhere) ──
   * checkLoginState: cheap cookie/browser session check without typing creds.
   * verifyViaFeed: "did my upload land" via the PUBLIC channel RSS feed —
   * no API key, no quota, no OAuth. Works forever. */
  async checkLoginState() {
    let cookies = 0;
    try { cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')).length; } catch (e) {}
    if (this.browser && this.page && !this.page.isClosed()) {
      try {
        await this.page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const avatar = await this.page.$('#avatar-btn');
        if (avatar) { this.loggedIn = true; return { ok: true, method: 'browser', cookies, loggedIn: true }; }
        return { ok: true, method: 'browser', cookies, loggedIn: false };
      } catch (e) { return { ok: false, method: 'browser', cookies, error: e.message }; }
    }
    return { ok: cookies > 0, method: 'cookies-only', cookies, loggedIn: null,
      note: cookies ? 'cookies saved — browser check runs on next browser action' : 'no saved session' };
  }

  async verifyViaFeed(expectedVideoIdOrTitle) {
    let channelId = null;
    try {
      const ch = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'youtube', 'channel.json'), 'utf8'));
      channelId = ch.channelId || null;
    } catch (e) {}
    if (!channelId) return { ok: false, error: 'no channel ID saved yet — captured automatically on first Studio login/upload' };
    const axios = require('axios');
    const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId);
    try {
      const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (BreadBot verify)' } });
      const xml = String(r.data || '');
      const ids = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]);
      const titles = [...xml.matchAll(/<media:title>([^<]+)<\/media:title>/g)].map(m => m[1]);
      const latest = ids.map((id, i) => ({ videoId: id, title: titles[i] || '' }));
      let match = null;
      if (expectedVideoIdOrTitle) {
        const needle = String(expectedVideoIdOrTitle).toLowerCase();
        match = latest.find(v => v.videoId.toLowerCase() === needle || v.title.toLowerCase().includes(needle)) || null;
      }
      return { ok: true, channelId, feedVideos: latest.length, latest: latest.slice(0, 5), match };
    } catch (e) { return { ok: false, channelId, error: e.message }; }
  }

  /* capture the channel ID from the Studio page — enables the RSS verify */
  async captureChannelId() {
    try {
      if (!this.page || this.page.isClosed()) return null;
      const chId = await this.page.evaluate(() => {
        try {
          const s = JSON.stringify(window.ytInitialData || {});
          const m = s.match(/"externalChannelId":"(UC[\w-]{22})"/) || s.match(/"channelId":"(UC[\w-]{22})"/);
          return m ? m[1] : null;
        } catch (e) { return null; }
      });
      if (chId) {
        writeJSONAtomic(path.join(this.dataDir, 'youtube', 'channel.json'),
          { channelId: chId, savedAt: new Date().toISOString() });
        this.log('info', 'youtube', 'Channel ID captured for API-free verification: ' + chId);
      }
      return chId || null;
    } catch (e) { return null; }
  }

  async ensureReady() {
    if (this.loggedIn && this.page && !this.page.isClosed()) return true;
    this.log('info', 'youtube', 'Re-establishing session...');
    const loginResult = await this.login();
    return loginResult.success;
  }

  /* ── Browser restart on crash ──────────────────────────────── */
  async restartBrowser() {
    this.log('warn', 'youtube', 'Restarting browser...');
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

  /* ════════════════════════════════════════════════════════════
   *  UPLOAD VIDEO — The primary posting action for YouTube
   *  Goes to YouTube Studio, fills upload form with human behavior.
   *  Always schedules 30-120 min into future (not immediate).
   *  Varies metadata to avoid content fingerprinting.
   * ════════════════════════════════════════════════════════════ */
  async uploadVideo(options = {}) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('upload')) return { success: false, error: 'Rate limited — safe upload limit reached' };

    const {
      videoPath,
      title = '',
      description = '',
      tags = [],
      category = 'People & Blogs',
      visibility = 'scheduled',    // 'public', 'unlisted', 'private', 'scheduled'
      thumbnailPath = null,
      madeForKids = false
    } = options;

    if (!videoPath || !fs.existsSync(videoPath)) {
      return { success: false, error: 'Video file not found: ' + videoPath };
    }

    try {
      this.log('info', 'youtube', 'Uploading video: ' + title);
      this.health.lastActionAt = Date.now();

      // Navigate to YouTube Studio upload
      await this.page.goto('https://studio.youtube.com/channel/UC/videos/upload', {
        waitUntil: 'networkidle2', timeout: 30000
      });
      await humanDelay(3000, 6000);
      /* v84.2: capture channel ID → enables API-free upload verification (RSS feed) */
      await this.captureChannelId();

      // Check for CAPTCHA
      const captchaCheck = await detectCaptcha(this.page);
      if (captchaCheck.detected) {
        this.log('warn', 'youtube', 'CAPTCHA on Studio page — aborting upload');
        return { success: false, error: 'CAPTCHA detected on YouTube Studio' };
      }

      // Upload the video file via file chooser
      const fileInput = await this.page.$('input[type="file"]');
      if (!fileInput) {
        return { success: false, error: 'Upload file input not found' };
      }

      await fileInput.uploadFile(videoPath);
      this.log('info', 'youtube', 'Video file selected, waiting for upload dialog...');
      await humanDelay(5000, 10000);

      // Fill in title (with slight variation for anti-detection)
      const variedTitle = this.varyText(title);
      const titleSelectors = [
        '#title-textarea',
        'div[aria-label="Title"]',
        'ytcp-social-suggestion-text-entry[id="title"]'
      ];

      for (const sel of titleSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(500, 1000);
            await humanType(this.page, sel, variedTitle, { wpm: 30 + Math.random() * 15 });
            break;
          }
        } catch (e) {}
      }
      await humanDelay(1000, 2000);

      // Fill in description (with variation)
      const variedDescription = this.varyText(description);
      const descSelectors = [
        '#description-textarea',
        'div[aria-label="Description"]',
        'ytcp-social-suggestion-text-entry[id="description"]'
      ];

      for (const sel of descSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(500, 1000);
            await humanType(this.page, sel, variedDescription, { wpm: 25 + Math.random() * 15 });
            break;
          }
        } catch (e) {}
      }
      await humanDelay(1000, 2000);

      // Add tags (with random order for variation)
      if (tags.length > 0) {
        const shuffledTags = randomizeActionOrder(tags);
        const tagInputSelectors = [
          'input[aria-label="Tags"]',
          'ytcp-chip-bar input'
        ];

        for (const sel of tagInputSelectors) {
          try {
            const el = await this.page.$(sel);
            if (el) {
              for (const tag of shuffledTags) {
                await humanClick(this.page, sel);
                await humanType(this.page, sel, tag, { wpm: 40 + Math.random() * 20 });
                await this.page.keyboard.press('Enter');
                await humanDelay(300, 800);
              }
              break;
            }
          } catch (e) {}
        }
      }

      // Set "Made for kids" option
      try {
        const kidsSelect = madeForKids ? ' MADE_FOR_KIDS' : ' NOT_MADE_FOR_KIDS';
        const radioButton = await this.page.$(`[name="madeForKids"][value="${kidsSelect}"]`);
        if (radioButton) {
          await humanClick(this.page, `[name="madeForKids"][value="${kidsSelect}"]`);
          await humanDelay(500, 1000);
        }
      } catch (e) {}

      // Set visibility/schedule
      await this._setVisibility(visibility);

      // Upload thumbnail if provided
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        await this._uploadThumbnail(thumbnailPath);
      }

      // Wait for video processing (with patience — humans wait)
      this.log('info', 'youtube', 'Waiting for video processing...');
      await humanDelay(10000, 20000);

      // Click "Save" or "Publish" button
      const saveSelectors = [
        '#save-button',
        'button[aria-label="Save"]',
        '#done-button',
        'button[aria-label="Publish"]'
      ];

      for (const sel of saveSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            await humanClick(this.page, sel);
            await humanDelay(3000, 6000);
            break;
          }
        } catch (e) {}
      }

      // Record success
      this.rateLimiter.record('upload');
      this.health.successCount++;
      const scheduleInfo = visibility === 'scheduled' ? this.getSafeScheduleTime() : null;
      this.data.addToHistory('upload', {
        title: variedTitle,
        visibility,
        scheduledFor: scheduleInfo?.iso,
        success: true,
        timestamp: Date.now()
      });
      this.data.addToList('uploadedVideos', {
        title: variedTitle,
        visibility,
        scheduledFor: scheduleInfo?.iso,
        uploadedAt: Date.now()
      });

      this.log('info', 'youtube', 'Video uploaded successfully: ' + variedTitle);
      return { success: true, title: variedTitle, visibility, scheduledFor: scheduleInfo };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Upload error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Set visibility (public/unlisted/private/scheduled) ─── */
  async _setVisibility(visibility) {
    try {
      // Click the visibility dropdown/tab
      const visTabSelectors = [
        'ytcp-visibility-select',
        '[aria-label="Visibility"]',
        '#visibility-select'
      ];

      for (const sel of visTabSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(1000, 2000);
            break;
          }
        } catch (e) {}
      }

      if (visibility === 'scheduled') {
        // Select "Schedule" option
        const scheduleSelectors = [
          '[value="SCHEDULED"]',
          'tp-yt-paper-radio-button[name="SCHEDULED"]'
        ];
        for (const sel of scheduleSelectors) {
          try {
            const el = await this.page.$(sel);
            if (el) {
              await humanClick(this.page, sel);
              await humanDelay(1000, 2000);

              // Set schedule date/time (30-120 min in future)
              const schedule = this.getSafeScheduleTime();
              const dateInput = await this.page.$('input[aria-label="Schedule date"]');
              if (dateInput) {
                await humanClick(this.page, 'input[aria-label="Schedule date"]');
                await humanDelay(500, 1000);
                // Clear and type new date
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('a');
                await this.page.keyboard.up('Control');
                await humanType(this.page, 'input[aria-label="Schedule date"]', schedule.date, { wpm: 30 });
                await this.page.keyboard.press('Enter');
              }

              const timeInput = await this.page.$('input[aria-label="Schedule time"]');
              if (timeInput) {
                await humanClick(this.page, 'input[aria-label="Schedule time"]');
                await humanDelay(500, 1000);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('a');
                await this.page.keyboard.up('Control');
                await humanType(this.page, 'input[aria-label="Schedule time"]', schedule.time, { wpm: 30 });
                await this.page.keyboard.press('Enter');
              }

              await humanDelay(500, 1500);
              break;
            }
          } catch (e) {}
        }
      } else {
        // Select the specific visibility option
        const visMap = {
          'public': 'PUBLIC',
          'unlisted': 'UNLISTED',
          'private': 'PRIVATE'
        };
        const value = visMap[visibility] || 'UNLISTED';
        const optionSelectors = [
          `[value="${value}"]`,
          `tp-yt-paper-radio-button[name="${value}"]`
        ];
        for (const sel of optionSelectors) {
          try {
            const el = await this.page.$(sel);
            if (el) {
              await humanClick(this.page, sel);
              await humanDelay(500, 1000);
              break;
            }
          } catch (e) {}
        }
      }

      // Click "Done" to close the visibility dialog
      const doneSelectors = [
        '#done-button',
        'button[aria-label="Done"]'
      ];
      for (const sel of doneSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(500, 1000);
            break;
          }
        } catch (e) {}
      }
    } catch (e) {
      this.log('warn', 'youtube', 'Visibility set error: ' + e.message);
    }
  }

  /* ── Upload thumbnail ─────────────────────────────────────── */
  async _uploadThumbnail(thumbnailPath) {
    try {
      const thumbSelectors = [
        '[aria-label="Upload thumbnail"]',
        '#thumbnail-upload-button'
      ];

      for (const sel of thumbSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(1000, 2000);

            const fileInput = await this.page.$('input[type="file"][accept*="image"]');
            if (fileInput) {
              await fileInput.uploadFile(thumbnailPath);
              await humanDelay(3000, 5000);
              this.log('info', 'youtube', 'Thumbnail uploaded');
            }
            break;
          }
        } catch (e) {}
      }
    } catch (e) {
      this.log('warn', 'youtube', 'Thumbnail upload error: ' + e.message);
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  COMMUNITY POST — Text/image/poll post on channel
   *  SAFE: 1-2 per day. Post natively (not link to video).
   * ════════════════════════════════════════════════════════════ */
  async communityPost(options = {}) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('communityPost')) return { success: false, error: 'Rate limited — community post limit reached' };

    const {
      text = '',
      imagePath = null,
      poll = null  // { question: '', options: ['a','b','c'] }
    } = options;

    if (!text && !imagePath && !poll) {
      return { success: false, error: 'Must provide text, image, or poll' };
    }

    try {
      this.log('info', 'youtube', 'Creating community post...');
      this.health.lastActionAt = Date.now();

      // Navigate to community tab
      await this.page.goto('https://studio.youtube.com/channel/UC/community', {
        waitUntil: 'networkidle2', timeout: 30000
      });
      await humanDelay(3000, 5000);

      // Click "Create post" button
      const createPostSelectors = [
        'button[aria-label="Create post"]',
        '#create-post-button',
        'a[aria-label="Create post"]'
      ];

      for (const sel of createPostSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(2000, 4000);
            break;
          }
        } catch (e) {}
      }

      // Type the post text (with variation)
      const variedText = this.varyText(text);
      const postInputSelectors = [
        '[contenteditable="true"][aria-label="Text"]',
        '#post-text',
        'div[contenteditable="true"]'
      ];

      for (const sel of postInputSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(500, 1000);
            await humanType(this.page, sel, variedText, { wpm: 30 + Math.random() * 20 });
            break;
          }
        } catch (e) {}
      }
      await humanDelay(1000, 2000);

      // Add image if provided
      if (imagePath && fs.existsSync(imagePath)) {
        const imgInput = await this.page.$('input[type="file"][accept*="image"]');
        if (imgInput) {
          await imgInput.uploadFile(imagePath);
          await humanDelay(3000, 6000);
        }
      }

      // Add poll if provided
      if (poll && poll.question && poll.options?.length >= 2) {
        const pollBtn = await this.page.$('button[aria-label="Add poll"]');
        if (pollBtn) {
          await humanClick(this.page, 'button[aria-label="Add poll"]');
          await humanDelay(1000, 2000);

          // Type poll question
          const pollQInput = await this.page.$('[aria-label="Poll question"]');
          if (pollQInput) {
            await humanType(this.page, '[aria-label="Poll question"]', poll.question, { wpm: 35 });
            await humanDelay(500, 1000);
          }

          // Type poll options
          for (let i = 0; i < Math.min(poll.options.length, 5); i++) {
            const optSel = `[aria-label="Option ${i + 1}"]`;
            const optEl = await this.page.$(optSel);
            if (optEl) {
              await humanType(this.page, optSel, poll.options[i], { wpm: 35 });
              await humanDelay(300, 800);
            }
          }
        }
      }

      // Click "Post" button
      const postBtnSelectors = [
        'button[aria-label="Post"]',
        '#post-button'
      ];

      for (const sel of postBtnSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            await humanClick(this.page, sel);
            await humanDelay(3000, 5000);

            this.rateLimiter.record('communityPost');
            this.health.successCount++;
            this.data.addToHistory('communityPost', { text: variedText.substring(0, 50), success: true });
            this.log('info', 'youtube', 'Community post created');
            return { success: true };
          }
        } catch (e) {}
      }

      return { success: false, error: 'Post button not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Community post error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  UPLOAD SHORT — Upload a YouTube Short (< 60s vertical video)
   *  Same rate limits as regular uploads.
   * ════════════════════════════════════════════════════════════ */
  async uploadShort(options = {}) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('uploadShort')) return { success: false, error: 'Rate limited — short upload limit reached' };

    const {
      videoPath,
      title = '',
      description = ''
    } = options;

    if (!videoPath || !fs.existsSync(videoPath)) {
      return { success: false, error: 'Video file not found: ' + videoPath };
    }

    try {
      this.log('info', 'youtube', 'Uploading Short: ' + title);
      this.health.lastActionAt = Date.now();

      // Navigate to Shorts upload
      await this.page.goto('https://www.youtube.com/upload_shorts', {
        waitUntil: 'networkidle2', timeout: 30000
      });
      await humanDelay(3000, 5000);

      // Upload file
      const fileInput = await this.page.$('input[type="file"]');
      if (!fileInput) {
        return { success: false, error: 'Short upload input not found' };
      }

      await fileInput.uploadFile(videoPath);
      await humanDelay(5000, 10000);

      // Fill title
      const variedTitle = this.varyText(title);
      const titleSelectors = [
        '#title-textarea',
        'div[aria-label="Title"]',
        'ytcp-social-suggestion-text-entry[id="title"]'
      ];

      for (const sel of titleSelectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            await humanClick(this.page, sel);
            await humanDelay(500, 1000);
            await humanType(this.page, sel, variedTitle, { wpm: 30 + Math.random() * 15 });
            break;
          }
        } catch (e) {}
      }
      await humanDelay(1000, 2000);

      // Fill description
      if (description) {
        const variedDesc = this.varyText(description);
        const descSelectors = [
          '#description-textarea',
          'div[aria-label="Description"]'
        ];

        for (const sel of descSelectors) {
          try {
            const el = await this.page.$(sel);
            if (el) {
              await humanClick(this.page, sel);
              await humanDelay(500, 1000);
              await humanType(this.page, sel, variedDesc, { wpm: 25 + Math.random() * 15 });
              break;
            }
          } catch (e) {}
        }
      }

      // Click publish
      await humanDelay(5000, 10000);
      const publishSelectors = [
        '#done-button',
        'button[aria-label="Publish"]',
        '#save-button'
      ];

      for (const sel of publishSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            await humanClick(this.page, sel);
            await humanDelay(3000, 6000);
            break;
          }
        } catch (e) {}
      }

      this.rateLimiter.record('uploadShort');
      this.health.successCount++;
      this.data.addToHistory('uploadShort', { title: variedTitle, success: true });
      this.log('info', 'youtube', 'Short uploaded: ' + variedTitle);
      return { success: true, title: variedTitle };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Short upload error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Subscribe to channel (browser) ────────────────────────── */
  async subscribe(channelUrl) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('subscribe')) return { success: false, error: 'Rate limited' };

    try {
      const url = channelUrl.startsWith('http') ? channelUrl : 'https://www.youtube.com/@' + channelUrl;
      this.log('info', 'youtube', 'Subscribing to: ' + url);

      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Browse the channel first (human-like)
      await humanScroll(this.page, 'down', 2);
      await humanDelay(2000, 5000);

      // Find subscribe button
      const subSelectors = [
        '#subscribe-button button',
        'yt-button-shape button[aria-label="Subscribe"]',
        'button[aria-label="Subscribe"]',
        '#subscribe-button style-scope ytd-subscribe-button-renderer'
      ];

      for (const selector of subSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            const text = await this.page.evaluate(el => el.textContent || el.getAttribute('aria-label'), btn);
            if (text && text.toLowerCase().includes('subscribe')) {
              await humanClick(this.page, selector);
              await humanDelay(2000, 4000);

              this.rateLimiter.record('subscribe');
              this.health.successCount++;
              this.data.addToList('subscribed', { url, subscribedAt: Date.now() });
              this.data.addToHistory('subscribe', { url, success: true });
              this.log('info', 'youtube', 'Subscribed to: ' + url);
              return { success: true };
            }
          }
        } catch (e) {}
      }

      return { success: false, error: 'Subscribe button not found (already subscribed?)' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Subscribe error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Comment on video (browser) ────────────────────────────── */
  async comment(videoUrl, text) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('comment')) return { success: false, error: 'Rate limited' };

    try {
      const url = videoUrl.startsWith('http') ? videoUrl : 'https://www.youtube.com/watch?v=' + videoUrl;
      this.log('info', 'youtube', 'Commenting on: ' + url);

      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Watch part of the video first (human-like engagement)
      await humanDelay(5000, 15000);

      // Scroll to comments section
      await humanScroll(this.page, 'down', 4);
      await humanDelay(2000, 4000);

      // Find comment input
      const commentSelectors = [
        '#contenteditable-root[contenteditable="true"]',
        'yt-formatted-string[contenteditable="true"]',
        'div#placeholder-area',
        '#simplebox-placeholder'
      ];

      for (const selector of commentSelectors) {
        try {
          const el = await this.page.$(selector);
          if (el) {
            await humanClick(this.page, selector);
            await humanDelay(1000, 2000);

            // Type comment with human-like behavior (add variation)
            const variedComment = this.varyText(text);
            await this.page.keyboard.type(variedComment, { delay: 40 + Math.random() * 80 });
            await humanDelay(1000, 3000);

            // Find and click comment submit button
            const submitSelectors = [
              '#submit-button',
              'yt-button-renderer#submit-button button',
              'button[aria-label="Comment"]'
            ];

            for (const subSel of submitSelectors) {
              try {
                const subBtn = await this.page.$(subSel);
                if (subBtn) {
                  await humanClick(this.page, subSel);
                  await humanDelay(2000, 4000);

                  this.rateLimiter.record('comment');
                  this.health.successCount++;
                  this.data.addToHistory('comment', { videoUrl: url, success: true });
                  this.log('info', 'youtube', 'Commented on: ' + url);
                  return { success: true };
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      return { success: false, error: 'Comment input not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Comment error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Like video (browser) ──────────────────────────────────── */
  async like(videoUrl) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('like')) return { success: false, error: 'Rate limited' };

    try {
      const url = videoUrl.startsWith('http') ? videoUrl : 'https://www.youtube.com/watch?v=' + videoUrl;
      this.log('info', 'youtube', 'Liking: ' + url);

      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(3000, 8000);

      // Watch a bit first
      await humanDelay(5000, 15000);

      // Find like button
      const likeSelectors = [
        '#like-button button',
        'ytd-toggle-button-renderer#like-button button',
        'button[aria-label="like"]',
        'button[aria-label="Like"]'
      ];

      for (const selector of likeSelectors) {
        try {
          const btn = await this.page.$(selector);
          if (btn) {
            const isLiked = await this.page.evaluate(el => {
              const aria = el.getAttribute('aria-pressed');
              return aria === 'true';
            }, btn);

            if (isLiked) {
              return { success: false, error: 'Already liked' };
            }

            await humanClick(this.page, selector);
            await humanDelay(1000, 3000);

            this.rateLimiter.record('like');
            this.health.successCount++;
            this.data.addToHistory('like', { videoUrl: url, success: true });
            this.log('info', 'youtube', 'Liked: ' + url);
            return { success: true };
          }
        } catch (e) {}
      }

      return { success: false, error: 'Like button not found' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Like error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Watch video simulation (browser) ──────────────────────── */
  async watchVideo(videoUrl) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('watch')) return { success: false, error: 'Rate limited' };

    try {
      const url = videoUrl.startsWith('http') ? videoUrl : 'https://www.youtube.com/watch?v=' + videoUrl;
      this.log('info', 'youtube', 'Watching: ' + url);

      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      const watchTime = 30000 + Math.random() * 120000; // 30s - 2.5min
      const startTime = Date.now();

      while (Date.now() - startTime < watchTime) {
        const action = Math.random();
        if (action < 0.4) {
          await humanDelay(3000, 10000); // watching
        } else if (action < 0.7) {
          await humanScroll(this.page, 'down', 1); // reading description
        } else if (action < 0.85) {
          await humanScroll(this.page, 'down', 2); // scrolling to comments
        } else {
          await humanScroll(this.page, 'up', 1); // scrolling back up
        }
      }

      this.rateLimiter.record('watch');
      this.health.successCount++;
      const elapsed = Date.now() - startTime;
      this.data.addToHistory('watchVideo', { videoUrl: url, watchTime: elapsed });
      this.log('info', 'youtube', 'Watched ' + Math.round(elapsed / 1000) + 's of: ' + url);
      return { success: true, watchTime: elapsed };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Watch error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Search videos (browser) ───────────────────────────────── */
  async search(query, maxResults = 10) {
    if (!await this.ensureReady()) return [];
    if (!this.rateLimiter.canAct('search')) return [];

    try {
      this.log('info', 'youtube', 'Searching: ' + query);

      await this.page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 4000);

      // Scroll to load results
      for (let i = 0; i < 3; i++) {
        await humanScroll(this.page, 'down', 3);
        await humanDelay(1000, 2000);
      }

      // Extract video links
      const videos = await this.page.evaluate((limit) => {
        const results = [];
        const elements = document.querySelectorAll('a#video-title, ytd-video-renderer a#video-title-link');
        for (const el of elements) {
          if (results.length >= limit) break;
          const href = el.getAttribute('href') || '';
          const title = el.textContent?.trim() || '';
          const match = href.match(/[?&]v=([^&]+)/);
          if (match && title) {
            results.push({ videoId: match[1], title, url: 'https://www.youtube.com' + href });
          }
        }
        return results;
      }, maxResults);

      this.rateLimiter.record('search');
      this.health.successCount++;
      this.data.addToHistory('search', { query, results: videos.length });
      this.log('info', 'youtube', 'Found ' + videos.length + ' results for: ' + query);
      return videos;
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'youtube', 'Search error: ' + e.message);
      return [];
    }
  }

  /* ── Broadcast (post community post + comment on recent videos) */
  async broadcast(message) {
    const results = { sent: 0, failed: 0, actions: [] };

    // First: community post (if rate allows)
    const cp = await this.communityPost({ text: message });
    if (cp.success) {
      results.sent++;
      results.actions.push({ action: 'communityPost', success: true });
    } else {
      results.failed++;
      results.actions.push({ action: 'communityPost', success: false, error: cp.error });
    }

    // Then: comment on recent videos from subscribed channels
    const subscribed = this.data.getList('subscribed');
    for (const channel of subscribed.slice(0, 3)) {
      const videos = await this.search(channel.url, 1);
      if (videos.length > 0) {
        const r = await this.comment(videos[0].url, message);
        if (r.success) {
          results.sent++;
          results.actions.push({ action: 'comment', video: videos[0].url, success: true });
        } else {
          results.failed++;
          results.actions.push({ action: 'comment', video: videos[0].url, success: false });
        }
        await humanDelay(10000, 25000);
      }
    }

    return results;
  }

  /* ── Health check ──────────────────────────────────────────── */
  async healthCheck() {
    const isAlive = this.browser && this.page && !this.page.isClosed();
    return {
      platform: 'youtube',
      alive: isAlive,
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus()
    };
  }

  /* ── Status ────────────────────────────────────────────────── */
  getStatus() {
    return {
      platform: 'youtube',
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
    this.log('info', 'youtube', 'Closed');
  }
}

module.exports = YouTubeBot;
