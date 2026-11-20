'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/health-monitor.js — Health Monitoring System (Commercial Grade)
 *  Centralized health monitoring for the entire application.
 *
 *  Features:
 *    - Platform health checks (browser alive, logged in, responsive)
 *    - Memory/CPU monitoring with thresholds
 *    - Auto-recovery actions (restart browser, clear cache, etc.)
 *    - Health history and trend tracking
 *    - Webhook alerts on critical failures
 *    - Graceful degradation recommendations
 *    - System resource monitoring
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { writeJSONAtomic } = require('./atomic');
const os = require('os');

class HealthMonitor {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.dataDir = options.dataDir || './data';
    this.platforms = options.platforms || {}; // reference to platform instances
    this.checkInterval = options.checkInterval || 60000; // 1 minute
    this.historyFile = path.join(this.dataDir, 'health-history.json');
    this.history = [];
    this.checkTimer = null;
    this.alertCallbacks = [];
    this.startTime = Date.now();

    // Thresholds
    this.thresholds = {
      memoryPercent: options.memoryThreshold || 85, // alert at 85% memory
      cpuPercent: options.cpuThreshold || 80,
      errorRate: options.errorRateThreshold || 0.5, // 50% error rate
      browserRestarts: options.browserRestartThreshold || 5, // 5 restarts = problem
      staleMinutes: options.staleMinutes || 30 // no action in 30 min = stale
    };

    this.loadHistory();
  }

  /* ── Load/save health history ─────────────────────────────── */
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        // Keep last 1440 entries (24 hours at 1/min)
        if (this.history.length > 1440) {
          this.history = this.history.slice(-1440);
        }
      }
    } catch (e) {}
  }

  saveHistory() {
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      writeJSONAtomic(this.historyFile, this.history);
    } catch (e) {}
  }

  /* ── System resource check ────────────────────────────────── */
  getSystemHealth() {
    const mem = process.memoryUsage();

    /* v84.1 FIX: os.totalmem()/os.freemem() report the HOST machine's
     * memory, not the container's — on Render's 512MB free plan the
     * 85% alert could never fire. Read the cgroup limit first
     * (cgroup v2 then v1), fall back to os figures when absent. */
    let totalMem = os.totalmem();
    let containerMem = null;
    try {
      const v2 = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      if (v2 && v2 !== 'max') containerMem = parseInt(v2, 10);
    } catch (e) {}
    if (!containerMem) {
      try {
        const v1 = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
        if (v1) { const n = parseInt(v1, 10); if (n > 0 && n < totalMem) containerMem = n; }
      } catch (e) {}
    }
    if (containerMem) totalMem = containerMem;
    // "used" = the process footprint (the only thing we control) vs cap
    const usedMemPercent = (mem.rss / totalMem) * 100;

    return {
      uptime: Date.now() - this.startTime,
      processUptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        heapUsedPercent: (mem.heapUsed / mem.heapTotal) * 100
      },
      system: {
        totalMemory: totalMem,
        freeMemory: freeMem,
        usedMemoryPercent: usedMemPercent,
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg()
      },
      node: {
        version: process.version,
        pid: process.pid,
        platform: process.platform
      }
    };
  }

  /* ── Platform health check ────────────────────────────────── */
  async checkPlatformHealth(name, bot) {
    const health = {
      platform: name,
      timestamp: Date.now(),
      alive: false,
      loggedIn: false,
      errors: 0,
      successes: 0,
      restarts: 0,
      stale: false,
      issues: []
    };

    try {
      // Check if browser is alive
      if (bot.browser && bot.page && !bot.page.isClosed()) {
        health.alive = true;
      } else if (bot.schedule && bot.schedule.isEnabled()) {
        health.issues.push('Browser dead but platform enabled');
      }

      health.loggedIn = !!bot.loggedIn;

      // Check health stats
      if (bot.health) {
        health.errors = bot.health.errorCount || 0;
        health.successes = bot.health.successCount || 0;
        health.restarts = bot.health.browserRestarts || 0;

        // Calculate error rate
        const total = health.errors + health.successes;
        if (total > 0) {
          health.errorRate = health.errors / total;
          if (health.errorRate > this.thresholds.errorRate) {
            health.issues.push('High error rate: ' + (health.errorRate * 100).toFixed(1) + '%');
          }
        }

        // Check for staleness
        if (bot.health.lastActionAt > 0) {
          const staleMs = Date.now() - bot.health.lastActionAt;
          if (staleMs > this.thresholds.staleMinutes * 60000) {
            health.stale = true;
            health.issues.push('No action in ' + Math.round(staleMs / 60000) + ' minutes');
          }
        }

        // Check restart count
        if (health.restarts >= this.thresholds.browserRestarts) {
          health.issues.push('Excessive browser restarts: ' + health.restarts);
        }
      }

      // Check schedule
      if (bot.schedule) {
        health.enabled = bot.schedule.isEnabled();
      }

    } catch (e) {
      health.issues.push('Health check error: ' + e.message);
    }

    health.healthy = health.issues.length === 0 && health.alive;
    return health;
  }

  /* ── Run full health check ────────────────────────────────── */
  async runFullCheck() {
    const result = {
      timestamp: Date.now(),
      system: this.getSystemHealth(),
      platforms: {},
      alerts: [],
      overall: 'healthy'
    };

    // System health alerts
    if (result.system.system.usedMemoryPercent > this.thresholds.memoryPercent) {
      result.alerts.push({
        level: 'warning',
        message: 'High memory usage: ' + result.system.system.usedMemoryPercent.toFixed(1) + '%',
        metric: 'memory',
        value: result.system.system.usedMemoryPercent
      });
    }

    if (result.system.system.loadAvg[0] > this.thresholds.cpuPercent / 100) {
      result.alerts.push({
        level: 'warning',
        message: 'High CPU load: ' + (result.system.system.loadAvg[0] * 100).toFixed(1) + '%',
        metric: 'cpu',
        value: result.system.system.loadAvg[0]
      });
    }

    // Platform health
    let hasUnhealthy = false;
    for (const [name, bot] of Object.entries(this.platforms)) {
      result.platforms[name] = await this.checkPlatformHealth(name, bot);

      if (!result.platforms[name].healthy) {
        hasUnhealthy = true;
      }

      // Generate alerts for platform issues
      for (const issue of result.platforms[name].issues) {
        result.alerts.push({
          level: result.platforms[name].alive ? 'warning' : 'critical',
          platform: name,
          message: issue
        });
      }
    }

    // Overall status
    if (result.alerts.some(a => a.level === 'critical')) {
      result.overall = 'critical';
    } else if (hasUnhealthy || result.alerts.length > 0) {
      result.overall = 'degraded';
    }

    // Save to history
    this.history.push({
      timestamp: result.timestamp,
      overall: result.overall,
      alerts: result.alerts.length,
      platformSummary: Object.fromEntries(
        Object.entries(result.platforms).map(([n, p]) => [n, p.healthy ? 'ok' : 'unhealthy'])
      )
    });
    if (this.history.length > 1440) {
      this.history = this.history.slice(-1440);
    }
    this.saveHistory();

    // Fire alert callbacks
    if (result.alerts.length > 0) {
      for (const cb of this.alertCallbacks) {
        try { cb(result.alerts, result); } catch (e) {}
      }
    }

    return result;
  }

  /* ── Auto-recovery actions ────────────────────────────────── */
  async attemptRecovery(name, bot) {
    const actions = [];

    // Try restarting browser
    if (!bot.browser || (bot.page && bot.page.isClosed())) {
      this.log('warn', 'health', name + ': Attempting browser restart...');
      try {
        if (bot.restartBrowser) {
          const result = await bot.restartBrowser();
          actions.push({
            action: 'browserRestart',
            success: result.success,
            error: result.error
          });
        }
      } catch (e) {
        actions.push({ action: 'browserRestart', success: false, error: e.message });
      }
    }

    return actions;
  }

  /* ── Register alert callback ──────────────────────────────── */
  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  /* ── Start periodic monitoring ────────────────────────────── */
  startMonitoring() {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(async () => {
      try {
        const result = await this.runFullCheck();

        // Auto-recovery for critical platforms
        for (const [name, platformHealth] of Object.entries(result.platforms)) {
          if (!platformHealth.healthy && platformHealth.enabled) {
            const bot = this.platforms[name];
            if (bot) {
              await this.attemptRecovery(name, bot);
            }
          }
        }
      } catch (e) {
        this.log('error', 'health', 'Health check failed: ' + e.message);
      }
    }, this.checkInterval);

    this.log('info', 'health', 'Health monitoring started (interval: ' + (this.checkInterval / 1000) + 's)');
  }

  stopMonitoring() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      this.log('info', 'health', 'Health monitoring stopped');
    }
  }

  /* ── Status ───────────────────────────────────────────────── */
  getStatus() {
    return {
      monitoring: !!this.checkTimer,
      checkInterval: this.checkInterval,
      thresholds: this.thresholds,
      historySize: this.history.length,
      lastCheck: this.history.length > 0
        ? new Date(this.history[this.history.length - 1].timestamp).toISOString()
        : 'never',
      recentHistory: this.history.slice(-10)
    };
  }

  /* ── Cleanup ──────────────────────────────────────────────── */
  close() {
    this.stopMonitoring();
    this.saveHistory();
  }
}

module.exports = HealthMonitor;
