'use strict';
/* ══════════════════════════════════════════════════════════════
 *  multi-platform.js — Commercial-Grade Multi-Platform Orchestrator
 *  100% unofficial — all platforms use browser automation.
 *  No API keys needed — just email/password for each platform.
 *
 *  Platform isolation:
 *    - Each platform has its own browser, data dir, schedule, cookies
 *    - Activating/deactivating one doesn't affect others
 *    - Schedules are edited independently per platform
 *    - Rate limits are per-platform
 *    - Cookie persistence per platform (survive restarts)
 *
 *  Content Pipeline (DECOPLED — Twitter is INDEPENDENT):
 *    - Twitter → posts NSFW on its OWN schedule (excited girl persona)
 *    - Twitter → handles DMs independently ("this could be us")
 *    - WhatsApp → NSFW only in designated group, admin-triggered
 *    - Educational shorts → YouTube Shorts + Facebook
 *    - YouTube community posts → real engaging content
 *    - Facebook → adapted from YouTube at HALF frequency
 *
 *  Commercial features:
 *    - Health monitoring per platform
 *    - Auto-recovery on browser crash
 *    - Graceful degradation (one platform failing doesn't kill others)
 *    - Environment validation on startup
 *    - Structured logging
 *    - Auto-posting from content pipeline on schedule
 * ══════════════════════════════════════════════════════════════ */

const FacebookBot = require('./platforms/facebook');
const YouTubeBot = require('./platforms/youtube');
const TwitterBot = require('./platforms/twitter');
const TikTokBot = require('./platforms/tiktok');
const { getLogger } = require('./core/logger');
const SelfUpdate = require('./core/self-update');
const HealthMonitor = require('./core/health-monitor');
const CrashRecovery = require('./core/crash-recovery');
const ContentPipeline = require('./core/content/content-pipeline');
const { EducationalShortsGenerator } = require('./core/content/educational-shorts');
const InteractionTracker = require('./core/interaction-tracker');
const AntiDetectMeter = require('./core/anti-detect-meter');
const InternetMonitor = require('./core/internet-monitor');
const ScraperIntegration = require('./platforms/scraper');
const CircadianOrchestrator = require('./core/circadian-orchestrator');

class MultiPlatformManager {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.dataDir = options.dataDir || './data';
    this.platforms = {};
    this.initialized = false;
    this.startTime = Date.now();

    // Structured logger
    this.logger = getLogger({ service: 'multi-platform', logDir: this.dataDir + '/logs' });

    // Health monitoring for the manager itself
    this.health = {
      totalActions: 0,
      totalErrors: 0,
      lastHealthCheck: 0,
      platformCrashes: {}
    };

    // Create platform instances — ALL unofficial (browser automation)
    this.platforms.facebook = new FacebookBot({
      email: process.env.FB_EMAIL,
      password: process.env.FB_PASSWORD,
      dataDir: this.dataDir,
      log: this.log
    });

    this.platforms.youtube = new YouTubeBot({
      email: process.env.YOUTUBE_EMAIL,
      password: process.env.YOUTUBE_PASSWORD,
      dataDir: this.dataDir,
      log: this.log
    });

    this.platforms.twitter = new TwitterBot({
      username: process.env.TWITTER_USERNAME,
      password: process.env.TWITTER_PASSWORD,
      dataDir: this.dataDir,
      log: this.log
    });

    this.platforms.tiktok = new TikTokBot({
      username: process.env.TIKTOK_USERNAME,
      password: process.env.TIKTOK_PASSWORD,
      dataDir: this.dataDir,
      log: this.log
    });

    // Self-update system
    this.selfUpdate = new SelfUpdate({
      log: this.log,
      appDir: process.cwd(),
      autoUpdate: process.env.AUTO_UPDATE === 'true',
      checkInterval: parseInt(process.env.UPDATE_CHECK_INTERVAL) || 3600000
    });

    // Health monitor
    this.healthMonitor = new HealthMonitor({
      log: this.log,
      dataDir: this.dataDir,
      platforms: this.platforms,
      checkInterval: 60000
    });

    // Crash recovery
    this.crashRecovery = new CrashRecovery({
      log: this.log,
      dataDir: this.dataDir,
      maxRestarts: 5,
      installHandlers: options.installCrashHandlers !== false
    });

    // Cross-platform interaction tracker (bot knows all interactions)
    this.interactionTracker = new InteractionTracker({
      log: this.log,
      dataDir: this.dataDir + '/interactions'
    });

    // ═══ CONTENT PIPELINE — The core content system ═══════════
    // Sources content from educational shorts, fun facts, trending,
    // motivational, and NSFW (WhatsApp → Twitter cross-post)
    this.contentPipeline = new ContentPipeline({
      log: this.log,
      dataDir: this.dataDir + '/content',
      interactionTracker: this.interactionTracker,
      ttsEngine: 'edge-tts',
      videoEngine: 'static-image'
    });

    // Educational Shorts content generator (legacy, still available)
    this.contentGenerator = new EducationalShortsGenerator({
      log: this.log,
      dataDir: this.dataDir + '/content',
      ttsEngine: 'edge-tts',
      videoEngine: 'blender-eevee'
    });

    // Wire content pipeline to ALL platform bots
    for (const bot of Object.values(this.platforms)) {
      if (bot.setContentPipeline) bot.setContentPipeline(this.contentPipeline);
      if (bot.setInteractionTracker) bot.setInteractionTracker(this.interactionTracker);
    }

    // Anti-detection test meter
    this.antiDetectMeter = new AntiDetectMeter({
      log: this.log
    });

    // Internet connectivity & update monitor
    this.internetMonitor = new InternetMonitor({
      log: this.log,
      updateChecker: this.selfUpdate
    });

    // Scraper integration (intelligent-scraper)
    this.scraper = new ScraperIntegration({
      log: this.log,
      scraperDir: '../intelligent-scraper',
      token: process.env.SCRAPER_TOKEN || ''
    });

    // Wire scraper to Twitter (for independent NSFW content sourcing)
    if (this.platforms.twitter.setScraper) {
      this.platforms.twitter.setScraper(this.scraper);
    }

    // ═══ CIRCADIAN ORCHESTRATOR — Human rest/activity rhythm ═══
    // Implements: 5hr inactive with 4% activity, morning/evening peaks,
    // ultradian cycles (90-min micro-rests), random life events
    this.circadian = new CircadianOrchestrator({
      log: this.log,
      dataDir: this.dataDir,
      timezone: process.env.TIMEZONE || 'America/Los_Angeles'
    });

    // Auto-posting state
    this._autoPostTimers = {};
    this._autoPostRunning = false;
  }

  /* ── Validate environment ───────────────────────────────────── */
  validateEnv() {
    const issues = [];
    const config = {
      facebook: { email: process.env.FB_EMAIL, password: process.env.FB_PASSWORD },
      youtube: { email: process.env.YOUTUBE_EMAIL, password: process.env.YOUTUBE_PASSWORD },
      twitter: { username: process.env.TWITTER_USERNAME, password: process.env.TWITTER_PASSWORD },
      tiktok: { username: process.env.TIKTOK_USERNAME, password: process.env.TIKTOK_PASSWORD }
    };

    for (const [name, creds] of Object.entries(config)) {
      const hasUser = !!(creds.email || creds.username);
      const hasPass = !!creds.password;
      if (hasUser && !hasPass) issues.push(name + ': has username/email but no password');
      if (!hasUser && hasPass) issues.push(name + ': has password but no username/email');
    }

    return { valid: issues.length === 0, issues };
  }

  /* ── Initialize all platforms ──────────────────────────────── */
  async init() {
    this.log('info', 'multi-platform', 'Initializing multi-platform manager (all unofficial, browser automation)...');

    // Validate environment
    const envCheck = this.validateEnv();
    if (!envCheck.valid) {
      for (const issue of envCheck.issues) {
        this.log('warn', 'multi-platform', 'Config: ' + issue);
      }
    }

    // Auto-enable platforms that have credentials but schedule is disabled
    const platformCreds = {
      facebook:  !!(process.env.FB_EMAIL && process.env.FB_PASSWORD),
      youtube:   !!(process.env.YOUTUBE_EMAIL && process.env.YOUTUBE_PASSWORD),
      twitter:   !!(process.env.TWITTER_USERNAME && process.env.TWITTER_PASSWORD),
      tiktok:    !!(process.env.TIKTOK_USERNAME && process.env.TIKTOK_PASSWORD)
    };

    for (const [name, bot] of Object.entries(this.platforms)) {
      const hasCreds = platformCreds[name];

      // If credentials exist but schedule is disabled, auto-enable it
      if (hasCreds && !bot.schedule.isEnabled()) {
        this.log('info', 'multi-platform', name + ' has credentials — auto-enabling schedule');
        bot.schedule.enable();
      }

      if (bot.schedule.isEnabled()) {
        this.log('info', 'multi-platform', name + ' is enabled — initializing browser...');
        try {
          await bot.init();
          this.log('info', 'multi-platform', name + ' browser initialized (login required before posting)');
        } catch (e) {
          this.log('error', 'multi-platform', name + ' init failed: ' + e.message);
          this.health.platformCrashes[name] = (this.health.platformCrashes[name] || 0) + 1;
        }
      } else {
        this.log('info', 'multi-platform', name + ' has no credentials — disabled');
      }
    }

    // Start periodic health monitoring (every 5 minutes)
    this.healthMonitorInterval = setInterval(() => {
      this.runHealthCheck().catch(e => {
        this.log('error', 'multi-platform', 'Health check error: ' + e.message);
      });
    }, 300000);

    // Start auto-posting scheduler (circadian-aware)
    this.startAutoPosting();

    // Start Twitter's INDEPENDENT NSFW posting (excited girl persona)
    // This is NOT from WhatsApp — Twitter sources its own content
    const tw = this.platforms.twitter;
    if (tw && tw.schedule.isEnabled()) {
      tw.startIndependentNSFW();
      this.log('info', 'multi-platform', 'Twitter independent NSFW started (excited girl persona)');
    }

    // Start fingerprint rotation timer (every 3-6 hours)
    this._startFingerprintRotation();

    this.initialized = true;
    this.log('info', 'multi-platform', 'Multi-platform manager ready (Twitter INDEPENDENT, content pipeline active, auto-posting started)');
  }

  /* ════════════════════════════════════════════════════════════
   *  AUTO-POSTING SCHEDULER
   *  Runs on timers to post content from the pipeline:
   *    - YouTube: community post every 8h, short every 4h, engage every 2h
   *    - Facebook: timeline post every 8h, cross-post every 12h, join groups every 4h
   *    - Twitter: tweet every 2h, reply to comments every 3h
   *  All with jitter for anti-detection
   * ════════════════════════════════════════════════════════════ */
  startAutoPosting() {
    if (this._autoPostRunning) return;
    this._autoPostRunning = true;
    
    const jitter = () => Math.random() * 600000; // 0-10 min jitter
    
    // ── YouTube ──────────────────────────────────────────────
    // Community post: every 8h (SAFE: 1-2/day)
    this._autoPostTimers.ytCommunity = setInterval(() => {
      this._autoPost('youtube', 'community').catch(e =>
        this.log('error', 'multi-platform', 'YT auto community error: ' + e.message));
    }, 8 * 3600000 + jitter());
    
    // Short: every 4h (SAFE: 2-5/day)
    this._autoPostTimers.ytShort = setInterval(() => {
      this._autoPost('youtube', 'short').catch(e =>
        this.log('error', 'multi-platform', 'YT auto short error: ' + e.message));
    }, 4 * 3600000 + jitter());
    
    // Engage (watch/like/comment): every 2h
    this._autoPostTimers.ytEngage = setInterval(() => {
      this._autoPost('youtube', 'engage').catch(e =>
        this.log('error', 'multi-platform', 'YT auto engage error: ' + e.message));
    }, 2 * 3600000 + jitter());
    
    // ── Facebook ─────────────────────────────────────────────
    // Timeline post: every 8h (HALF YouTube: 2-3/day)
    this._autoPostTimers.fbTimeline = setInterval(() => {
      this._autoPost('facebook', 'timeline').catch(e =>
        this.log('error', 'multi-platform', 'FB auto timeline error: ' + e.message));
    }, 8 * 3600000 + jitter());
    
    // Cross-post from YouTube: every 12h
    this._autoPostTimers.fbCrosspost = setInterval(() => {
      this._autoPost('facebook', 'crosspost').catch(e =>
        this.log('error', 'multi-platform', 'FB auto crosspost error: ' + e.message));
    }, 12 * 3600000 + jitter());
    
    // Join queued groups: every 4h
    this._autoPostTimers.fbJoinGroups = setInterval(() => {
      this._autoPost('facebook', 'joinGroups').catch(e =>
        this.log('error', 'multi-platform', 'FB auto join groups error: ' + e.message));
    }, 4 * 3600000 + jitter());
    
    // ── Twitter ──────────────────────────────────────────────
    // Tweet: every 2h (5-10/day)
    this._autoPostTimers.tweet = setInterval(() => {
      this._autoPost('twitter', 'tweet').catch(e =>
        this.log('error', 'multi-platform', 'TW auto tweet error: ' + e.message));
    }, 2 * 3600000 + jitter());
    
    // Reply to comments: every 3h
    this._autoPostTimers.twReply = setInterval(() => {
      this._autoPost('twitter', 'reply').catch(e =>
        this.log('error', 'multi-platform', 'TW auto reply error: ' + e.message));
    }, 3 * 3600000 + jitter());
    
    // Process NSFW queue: REMOVED — Twitter is now independent
    // Twitter posts NSFW on its own schedule using startIndependentNSFW()
    this._autoPostTimers.twDMCheck = setInterval(() => {
      this._autoPost('twitter', 'dm').catch(e =>
        this.log('error', 'multi-platform', 'TW DM check error: ' + e.message));
    }, 45 * 60000 + jitter());
    
    this.log('info', 'multi-platform', 'Auto-posting started (YT: community/short/engage, FB: timeline/crosspost/join, TW: tweet/reply/dm/INDEPENDENT_NSF)');
  }

  stopAutoPosting() {
    this._autoPostRunning = false;
    for (const [name, timer] of Object.entries(this._autoPostTimers)) {
      clearInterval(timer);
    }
    this._autoPostTimers = {};
    this.log('info', 'multi-platform', 'Auto-posting stopped');
  }

  /* ── Fingerprint rotation (every 3-6 hours) ──────────────── */
  _startFingerprintRotation() {
    const rotateAll = async () => {
      for (const [name, bot] of Object.entries(this.platforms)) {
        if (bot.browser && bot.schedule.isEnabled()) {
          try {
            const { rotateFingerprint } = require('./core/anti-detection');
            await rotateFingerprint(bot.browser);
            this.log('info', 'multi-platform', name + ' fingerprint rotated');
          } catch (e) {
            this.log('warn', 'multi-platform', name + ' fingerprint rotation failed: ' + e.message);
          }
        }
      }
    };
    // Rotate every 3-6 hours (randomized)
    const scheduleNext = () => {
      const interval = (3 + Math.random() * 3) * 3600000; // 3-6 hours
      this._fingerprintTimer = setTimeout(async () => {
        await rotateAll();
        scheduleNext();
      }, interval);
    };
    scheduleNext();
  }

  async _autoPost(platform, action) {
    const bot = this.platforms[platform];
    if (!bot || !bot.schedule.isEnabled()) {
      return; // Platform not enabled
    }

    // ═══ CIRCADIAN GATE — Ask the circadian engine if we should act ═══
    const actionCategory = (action === 'engage' || action === 'reply' || action === 'joinGroups') ? 'passive' : 'full';
    const circadianDecision = this.circadian.shouldAct(actionCategory);
    if (!circadianDecision.shouldAct) {
      if (circadianDecision.delay > 0) {
        this.log('info', 'multi-platform', 'Circadian: delaying ' + platform + '/' + action + ' by ' + Math.round(circadianDecision.delay / 60000) + 'min (' + circadianDecision.reason + ')');
        // Re-schedule after delay
        setTimeout(() => this._autoPost(platform, action), circadianDecision.delay);
      } else {
        this.log('info', 'multi-platform', 'Circadian: skipping ' + platform + '/' + action + ' (' + circadianDecision.reason + ')');
      }
      return;
    }
    const activityLevel = circadianDecision.activityLevel || this.circadian.getActivityLevel();
    this.log('info', 'multi-platform', 'Circadian: ' + platform + '/' + action + ' OK (activity: ' + Math.round(activityLevel * 100) + '%, ' + circadianDecision.reason + ')');
    
    // Auto-login if not logged in but has browser and credentials
    if (!bot.loggedIn) {
      // Check if bot has credentials and browser
      const hasCreds = (bot.email || bot.username) && bot.password;
      if (hasCreds && bot.browser) {
        this.log('info', 'multi-platform', platform + ' not logged in — attempting auto-login...');
        try {
          const loginResult = await bot.login();
          if (!loginResult.success) {
            this.log('warn', 'multi-platform', platform + ' auto-login failed: ' + (loginResult.error || 'unknown'));
            return;
          }
          this.log('info', 'multi-platform', platform + ' auto-login succeeded');
        } catch (e) {
          this.log('error', 'multi-platform', platform + ' auto-login error: ' + e.message);
          return;
        }
      } else {
        return; // No credentials or no browser — skip
      }
    }
    
    this.health.totalActions++;
    
    try {
      let result;
      
      switch (platform + ':' + action) {
        // YouTube
        case 'youtube:community':
          result = await bot.autoCommunityPost();
          break;
        case 'youtube:short':
          result = await bot.autoShort();
          break;
        case 'youtube:engage':
          result = await bot.autoEngage();
          break;
        
        // Facebook
        case 'facebook:timeline':
          result = await bot.autoTimelinePost();
          break;
        case 'facebook:crosspost':
          result = await bot.autoCrossPostFromYouTube();
          break;
        case 'facebook:joinGroups':
          result = await bot.autoJoinQueuedGroups();
          break;
        
        // Twitter
        case 'twitter:tweet':
          result = await bot.autoTweet();
          break;
        case 'twitter:reply':
          result = await bot.autoReplyToComments();
          break;
        case 'twitter:dm':
          result = await bot.handleDMs();
          break;
        
        // DEPRECATED: nsfwQueue no longer used — Twitter is independent
        // case 'twitter:nsfwQueue':
        //   result = await bot.processNSFWQueue();
        //   break;
        
        default:
          this.log('warn', 'multi-platform', 'Unknown auto-post action: ' + platform + ':' + action);
          return;
      }
      
      if (result && result.success) {
        this.log('info', 'multi-platform', 'Auto-post OK: ' + platform + '/' + action);
      } else if (result) {
        this.log('warn', 'multi-platform', 'Auto-post failed: ' + platform + '/' + action + ' — ' + (result.error || 'unknown'));
      }
    } catch (e) {
      this.health.totalErrors++;
      this.log('error', 'multi-platform', 'Auto-post error: ' + platform + '/' + action + ' — ' + e.message);
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  DEPRECATED: onNSFWVideoSent — NO LONGER USED
   *  Twitter is now INDEPENDENT from WhatsApp.
   *  This method is kept as a no-op for backward compat.
   * ════════════════════════════════════════════════════════════ */
  onNSFWVideoSent(videoData) {
    // NO-OP: Twitter is independent. It posts NSFW on its own.
    // WhatsApp NSFW stays in WhatsApp only.
    this.log('info', 'multi-platform', 'onNSFWVideoSent: DEPRECATED — Twitter is independent, not cross-posting');
  }

  /* ── Queue Facebook group link from WhatsApp ──────────────── */
  onGroupLinkReceived(url) {
    if (this.platforms.facebook.queueGroupLink) {
      this.platforms.facebook.queueGroupLink(url);
    }
  }

  /* ── Health monitoring ─────────────────────────────────────── */
  async runHealthCheck() {
    this.health.lastHealthCheck = Date.now();
    const results = {};

    for (const [name, bot] of Object.entries(this.platforms)) {
      if (!bot.schedule.isEnabled()) continue;

      try {
        const hc = await bot.healthCheck();
        results[name] = hc;

        // Auto-recover crashed browsers
        if (!hc.alive && bot.schedule.isEnabled()) {
          this.log('warn', 'multi-platform', name + ' browser crashed — auto-restarting...');
          try {
            const restartResult = await bot.restartBrowser();
            if (restartResult.success) {
              this.log('info', 'multi-platform', name + ' recovered successfully');
            } else {
              this.log('error', 'multi-platform', name + ' recovery failed: ' + (restartResult.error || 'unknown'));
              this.health.platformCrashes[name] = (this.health.platformCrashes[name] || 0) + 1;
            }
          } catch (e) {
            this.log('error', 'multi-platform', name + ' restart error: ' + e.message);
          }
        }
      } catch (e) {
        results[name] = { alive: false, error: e.message };
      }
    }

    return results;
  }

  /* ── Platform control ──────────────────────────────────────── */
  async enablePlatform(name) {
    const bot = this.platforms[name];
    if (!bot) return { success: false, error: 'Unknown platform: ' + name };

    bot.schedule.enable();
    if (!bot.browser) {
      try {
        await bot.init();
        this.log('info', 'multi-platform', name + ' enabled and initialized');
      } catch (e) {
        this.log('error', 'multi-platform', name + ' init failed: ' + e.message);
        this.health.platformCrashes[name] = (this.health.platformCrashes[name] || 0) + 1;
      }
    }
    return { success: true };
  }

  disablePlatform(name) {
    const bot = this.platforms[name];
    if (!bot) return { success: false, error: 'Unknown platform: ' + name };

    bot.schedule.disable();
    // Save cookies before disabling
    if (bot.loggedIn && bot.saveCookies) {
      bot.saveCookies().catch(() => {});
    }
    this.log('info', 'multi-platform', name + ' disabled');
    return { success: true };
  }

  async loginPlatform(name) {
    const bot = this.platforms[name];
    if (!bot) return { success: false, error: 'Unknown platform: ' + name };

    if (!bot.schedule.isEnabled()) {
      return { success: false, error: name + ' is disabled — enable first with !' + name + ' on' };
    }

    return await bot.login();
  }

  getPlatform(name) {
    return this.platforms[name] || null;
  }

  /* ── Broadcast to all active platforms ─────────────────────── */
  async broadcastAll(message) {
    const results = {};
    this.health.totalActions++;

    for (const [name, bot] of Object.entries(this.platforms)) {
      if (bot.schedule.isEnabled() && bot.loggedIn) {
        this.log('info', 'multi-platform', 'Broadcasting to ' + name + '...');
        try {
          results[name] = await bot.broadcast(message);
        } catch (e) {
          results[name] = { success: false, error: e.message };
          this.health.totalErrors++;
        }
      } else {
        results[name] = { skipped: true, reason: bot.schedule.isEnabled() ? 'not logged in' : 'disabled' };
      }
    }

    return results;
  }

  /* ── Get all platform statuses ─────────────────────────────── */
  getAllStatuses() {
    const statuses = {};
    for (const [name, bot] of Object.entries(this.platforms)) {
      statuses[name] = bot.getStatus();
    }
    return statuses;
  }

  /* ── Format status for WhatsApp display ────────────────────── */
  formatStatus() {
    const statuses = this.getAllStatuses();
    const lines = ['MULTI-PLATFORM STATUS (all unofficial)\n'];

    const icons = { facebook: 'FB', youtube: 'YT', twitter: 'TW', tiktok: 'TT' };

    for (const [name, status] of Object.entries(statuses)) {
      const icon = icons[name] || '??';
      const enabled = status.schedule.enabled;
      const loggedIn = status.loggedIn;
      lines.push(icon + ' ' + name.toUpperCase() + ': ' +
        (enabled ? 'ON' : 'OFF') +
        (loggedIn ? ' Logged in' : ' Not logged in'));

      // Health info
      if (status.health) {
        const h = status.health;
        const uptimeMin = h.uptime ? Math.round(h.uptime / 60000) : 0;
        if (h.successCount > 0 || h.errorCount > 0) {
          lines.push('  Actions: ' + h.successCount + ' ok / ' + h.errorCount + ' fail | Uptime: ' + uptimeMin + 'min');
        }
        if (h.browserRestarts > 0) {
          lines.push('  Browser restarts: ' + h.browserRestarts);
        }
      }

      // Scheduled tasks count
      if (status.schedule && status.schedule.tasks && status.schedule.tasks.length > 0) {
        const activeTasks = status.schedule.tasks.filter(t => t.enabled).length;
        lines.push('  Tasks: ' + activeTasks + '/' + status.schedule.tasks.length + ' active');
      }
      lines.push('');
    }

    // Content pipeline stats
    const cpStats = this.contentPipeline.getStats();
    lines.push('Content Pipeline:');
    lines.push('  YT: ' + cpStats.postedContent.youtube + ' posted | ' + Math.round(cpStats.youtubeMix.educational * 100) + '% edu + ' + Math.round(cpStats.youtubeMix.funFacts * 100) + '% fun');
    lines.push('  FB: ' + cpStats.postedContent.facebook + ' posted');
    lines.push('  TW: ' + cpStats.postedContent.twitter + ' posted (INDEPENDENT — no WhatsApp cross-post)');
    lines.push('');
    
    // Twitter INDEPENDENT NSFW details
    const tw = this.platforms.twitter;
    if (tw) {
      lines.push('Twitter (INDEPENDENT):');
      lines.push('  NSFW: ' + (tw._independentNSFWEnabled ? 'ON' : 'OFF') + ' | Posted: ' + tw._independentPostCount + ' | Mood: ' + Math.round(tw._moodLevel * 100) + '%');
      lines.push('  DMs: ' + (tw._dmEnabled ? 'ON' : 'OFF') + ' | DMs handled: ' + tw._dmCount);
      lines.push('  Auto-reply: ' + (tw._autoReplyEnabled ? 'ON' : 'OFF') + ' | Replied to: ' + tw._repliedTo.size + ' tweets');
      const capStats = tw.nsfwCaptions.getStats();
      lines.push('  Captions generated: ' + (capStats.captionsGenerated || 0));
      lines.push('');
    }

    // Manager health
    lines.push('Manager uptime: ' + Math.round((Date.now() - this.startTime) / 60000) + 'min');
    lines.push('Auto-posting: ' + (this._autoPostRunning ? 'ACTIVE' : 'STOPPED'));
    if (Object.keys(this.health.platformCrashes).length > 0) {
      lines.push('Crashes: ' + JSON.stringify(this.health.platformCrashes));
    }

    // Circadian rhythm status
    if (this.circadian) {
      lines.push('\n' + this.circadian.formatStatus());
    }

    return lines.join('\n');
  }

  /* ── Handle platform command from WhatsApp ─────────────────── */
  async handleCommand(platform, action, args) {
    const bot = this.platforms[platform];
    if (!bot) return 'Unknown platform: ' + platform;

    switch (action) {
      case 'on':
        await this.enablePlatform(platform);
        return platform.toUpperCase() + ' enabled. Login with: !' + platform + ' login';

      case 'off':
        this.disablePlatform(platform);
        return platform.toUpperCase() + ' disabled.';

      case 'status': {
        const status = bot.getStatus();
        const icon = { facebook: 'FB', youtube: 'YT', twitter: 'TW', tiktok: 'TT' }[platform] || '??';
        let msg = icon + ' ' + platform.toUpperCase() + ' STATUS\n';
        msg += 'Enabled: ' + (status.schedule.enabled ? 'YES' : 'NO') + '\n';
        msg += 'Logged in: ' + (status.loggedIn ? 'YES' : 'NO') + '\n';

        // Health
        if (status.health) {
          const h = status.health;
          const uptimeMin = h.uptime ? Math.round(h.uptime / 60000) : 0;
          msg += 'Uptime: ' + uptimeMin + 'min\n';
          msg += 'Actions: ' + (h.successCount || 0) + ' ok / ' + (h.errorCount || 0) + ' fail\n';
          if (h.lastError) msg += 'Last error: ' + h.lastError + '\n';
          if (h.browserRestarts > 0) msg += 'Browser restarts: ' + h.browserRestarts + '\n';
        }

        if (status.schedule && status.schedule.tasks && status.schedule.tasks.length > 0) {
          msg += 'Scheduled tasks: ' + status.schedule.tasks.length + '\n';
          for (const task of status.schedule.tasks.slice(0, 5)) {
            msg += '  - ' + task.name + ': ' + (task.enabled ? 'ON' : 'OFF') + ' (runs: ' + task.runCount + ')\n';
          }
        }
        return msg.trim();
      }

      case 'login':
        const loginResult = await this.loginPlatform(platform);
        return loginResult.success
          ? platform.toUpperCase() + ' logged in successfully!'
          : platform.toUpperCase() + ' login failed: ' + (loginResult.error || 'unknown error');

      case 'restart':
        if (!bot.restartBrowser) return platform.toUpperCase() + ' does not support restart';
        this.log('info', 'multi-platform', 'Manual restart requested for ' + platform);
        const restartResult = await bot.restartBrowser();
        return restartResult.success
          ? platform.toUpperCase() + ' restarted successfully!'
          : platform.toUpperCase() + ' restart failed: ' + (restartResult.error || 'unknown');

      case 'post':
        // Manual post from content pipeline
        return await this._manualPost(platform, args);

      case 'detect':
        // Run anti-detection audit
        return this._runDetectAudit(platform);

      case 'circadian':
        // Circadian rhythm status
        return this.circadian ? this.circadian.formatStatus() : 'Circadian orchestrator not initialized';

      case 'schedule':
        // Show today's circadian schedule
        if (this.circadian) {
          const today = this.circadian.getTodaySchedule();
          let msg = 'TODAY SCHEDULE (' + today.dayName + (today.isRestDay ? ' - REST DAY' : '') + ')\n';
          for (const slot of today.schedule) {
            if (slot.activityLevel > 0) {
              const bar = '█'.repeat(Math.round(slot.activityLevel * 20));
              const hour = slot.hour.toString().padStart(2, '0');
              msg += hour + ':00 | ' + bar + ' ' + Math.round(slot.activityLevel * 100) + '% | ' + slot.category + '\n';
            }
          }
          return msg.trim();
        }
        return 'Circadian not initialized';

      case 'nsfw':
        // Manual NSFW cross-post trigger
        return await this._manualNSFWPost(platform, args);

      case 'replies':
        // Trigger auto-reply scan now
        if (platform === 'twitter') {
          const replyResult = await this.platforms.twitter.autoReplyToComments();
          return replyResult.success
            ? 'Twitter: ' + replyResult.repliesSent + ' replies sent'
            : 'Twitter reply failed: ' + (replyResult.error || 'unknown');
        }
        return platform + ' does not support auto-reply';

      case 'queue':
        // Show NSFW queue status
        if (platform === 'twitter') {
          const tw = this.platforms.twitter;
          return 'Twitter NSFW queue: ' + tw._nsfwQueue.length + ' pending, ' + tw._nsfwPostedCount + ' posted, ' + tw._postedMediaHashes.size + ' unique media';
        }
        return 'Queue not available for ' + platform;

      default:
        return 'Unknown action: ' + action + '. Use: on|off|status|login|restart|post|detect|circadian|schedule|nsfw|replies|queue';
    }
  }

  /* ── Manual post from content pipeline ─────────────────────── */
  async _manualPost(platform, args) {
    const bot = this.platforms[platform];
    if (!bot || !bot.loggedIn) {
      return platform.toUpperCase() + ' not logged in. Login first.';
    }
    
    try {
      let result;
      
      switch (platform) {
        case 'youtube':
          if (args === 'short') {
            result = await bot.autoShort();
          } else if (args === 'engage') {
            result = await bot.autoEngage();
          } else {
            result = await bot.autoCommunityPost();
          }
          break;
        
        case 'facebook':
          if (args === 'crosspost') {
            result = await bot.autoCrossPostFromYouTube();
          } else {
            result = await bot.autoTimelinePost();
          }
          break;
        
        case 'twitter':
          if (args === 'nsfw') {
            const nsfw = this.contentPipeline.getTwitterNSFWPost();
            if (nsfw) {
              result = await bot.tweet(nsfw.text);
            } else {
              return 'No NSFW in queue. Send videos on WhatsApp first.';
            }
          } else if (args === 'reply') {
            result = await bot.autoReplyToComments();
          } else {
            result = await bot.autoTweet();
          }
          break;
        
        default:
          return platform.toUpperCase() + ' manual post not supported yet.';
      }
      
      if (result && result.success) {
        return platform.toUpperCase() + ' posted: ' + (result.contentType || 'content') + (result.subject ? ' (' + result.subject + ')' : '');
      }
      return platform.toUpperCase() + ' post failed: ' + (result?.error || 'unknown');
    } catch (e) {
      return platform.toUpperCase() + ' post error: ' + e.message;
    }
  }

  /* ── Manual NSFW cross-post from WhatsApp queue ────────────── */
  async _manualNSFWPost(platform, args) {
    if (platform !== 'twitter') {
      return 'NSFW cross-post only supported for Twitter';
    }
    const tw = this.platforms.twitter;
    if (!tw.loggedIn) {
      return 'Twitter not logged in. Use: !tw login';
    }
    const result = await tw.processNSFWQueue();
    if (result.success) {
      return 'Twitter NSFW: ' + result.posted + ' posted, ' + result.remaining + ' remaining in queue';
    }
    return 'Twitter NSFW: ' + (result.error || 'no items to post');
  }

  /* ── Run anti-detection audit ──────────────────────────────── */
  _runDetectAudit(platform) {
    const bot = this.platforms[platform];
    if (!bot) return 'Unknown platform: ' + platform;
    
    const result = this.antiDetectMeter.audit(platform, bot, {
      accountAge: 30,
      totalActions: bot.health.successCount + bot.health.errorCount,
      hasPosted: bot.health.successCount > 0
    });
    
    let msg = platform.toUpperCase() + ' DETECTION AUDIT\n';
    msg += 'Score: ' + result.overallScore + '/100 (' + result.level + ')\n\n';
    
    for (const [name, check] of Object.entries(result.checks)) {
      msg += name + ': ' + check.score + '/100 (weight: ' + check.weight + ')\n';
      msg += '  ' + check.details + '\n';
    }
    
    if (result.recommendations && result.recommendations.length > 0) {
      msg += '\nRecommendations:\n';
      for (const rec of result.recommendations) {
        msg += '  - ' + rec + '\n';
      }
    }
    
    return msg.trim();
  }

  /* ── Get content pipeline stats ────────────────────────────── */
  getContentStats() {
    return this.contentPipeline.getStats();
  }

  /* ── Cleanup ───────────────────────────────────────────────── */
  async close() {
    this.log('info', 'multi-platform', 'Shutting down all platforms...');
    
    this.stopAutoPosting();
    
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval);
    }

    // Close modern systems
    if (this.healthMonitor) this.healthMonitor.close();
    if (this.selfUpdate) this.selfUpdate.close();
    if (this.crashRecovery) this.crashRecovery.close();
    if (this.circadian) this.circadian.close();
    if (this._fingerprintTimer) clearTimeout(this._fingerprintTimer);

    for (const [name, bot] of Object.entries(this.platforms)) {
      try {
        await bot.close();
      } catch (e) {
        this.log('error', 'multi-platform', name + ' close error: ' + e.message);
      }
    }
    this.log('info', 'multi-platform', 'All platforms closed');
  }
}

module.exports = MultiPlatformManager;
