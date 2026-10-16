'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/crash-recovery.js — Crash Recovery System (Commercial Grade)
 *  Handles process crashes, unhandled errors, and automatic recovery.
 *
 *  Features:
 *    - Global error handlers (uncaughtException, unhandledRejection)
 *    - Crash logging with stack traces
 *    - Auto-restart with exponential backoff
 *    - Crash rate limiting (don't restart loop)
 *    - State preservation across crashes
 *    - Graceful shutdown coordination
 *    - Watchdog timer for stuck processes
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

class CrashRecovery {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.dataDir = options.dataDir || './data';
    this.maxRestarts = options.maxRestarts || 5;       // max restarts in window
    this.restartWindow = options.restartWindow || 300000; // 5 minute window
    this.backoffBase = options.backoffBase || 2000;     // 2s base backoff
    this.backoffMax = options.backoffMax || 60000;      // 60s max backoff
    this.watchdogTimeout = options.watchdogTimeout || 120000; // 2 min watchdog
    this.stateFile = path.join(this.dataDir, 'crash-state.json');
    this.crashes = [];
    this.restartCount = 0;
    this.isShuttingDown = false;
    this.shutdownCallbacks = [];
    this.watchdogTimer = null;
    this.watchdogCallback = options.watchdogCallback || null;
    this.lastWatchdogKick = Date.now();
    this.installHandlers = options.installHandlers !== false; // default true

    // Load crash state
    this.loadState();

    // Install global handlers (can be disabled for testing)
    if (this.installHandlers) {
      this._installHandlers();
    }
  }

  /* ── Load/save crash state ────────────────────────────────── */
  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.crashes = data.crashes || [];
        this.restartCount = data.restartCount || 0;
      }
    } catch (e) {}
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        crashes: this.crashes.slice(-50), // keep last 50
        restartCount: this.restartCount,
        lastSave: Date.now()
      }, null, 2));
    } catch (e) {}
  }

  /* ── Install global error handlers ────────────────────────── */
  _installHandlers() {
    // Uncaught exception handler
    process.on('uncaughtException', (err) => {
      this.recordCrash('uncaughtException', err);

      if (!this.isShuttingDown) {
        this.log('fatal', 'crash-recovery', 'UNCAUGHT EXCEPTION: ' + err.message);
        this.log('fatal', 'crash-recovery', 'Stack: ' + err.stack);

        // Decide whether to restart or exit
        if (this.shouldRestart()) {
          this.scheduleRestart('uncaughtException');
        } else {
          this.log('fatal', 'crash-recovery', 'Too many crashes — exiting');
          this.gracefulShutdown(1);
        }
      }
    });

    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      this.recordCrash('unhandledRejection', reason);

      this.log('error', 'crash-recovery', 'UNHANDLED REJECTION: ' + (reason?.message || reason));

      // For rejections, we don't restart — just log
      // Most unhandled rejections are non-fatal
    });

    // SIGINT handler (Ctrl+C)
    process.on('SIGINT', () => {
      this.log('info', 'crash-recovery', 'SIGINT received — shutting down gracefully');
      this.gracefulShutdown(0);
    });

    // SIGTERM handler (kill)
    process.on('SIGTERM', () => {
      this.log('info', 'crash-recovery', 'SIGTERM received — shutting down gracefully');
      this.gracefulShutdown(0);
    });
  }

  /* ── Record a crash ───────────────────────────────────────── */
  recordCrash(type, error) {
    const crash = {
      type,
      message: error?.message || String(error),
      stack: error?.stack || '',
      timestamp: Date.now(),
      pid: process.pid,
      memory: process.memoryUsage()
    };

    this.crashes.push(crash);
    this.saveState();

    this.log('error', 'crash-recovery', 'Crash recorded: ' + type + ' — ' + crash.message);
  }

  /* ── Check if restart is safe ─────────────────────────────── */
  shouldRestart() {
    const now = Date.now();
    const recentCrashes = this.crashes.filter(
      c => now - c.timestamp < this.restartWindow
    );

    if (recentCrashes.length >= this.maxRestarts) {
      this.log('warn', 'crash-recovery', 'Restart limit reached: ' + recentCrashes.length + ' crashes in ' + (this.restartWindow / 1000) + 's');
      return false;
    }

    return true;
  }

  /* ── Schedule restart with exponential backoff ────────────── */
  scheduleRestart(reason) {
    const delay = Math.min(
      this.backoffBase * Math.pow(2, this.restartCount),
      this.backoffMax
    );

    this.restartCount++;
    this.saveState();

    this.log('warn', 'crash-recovery', 'Restarting in ' + (delay / 1000) + 's (attempt ' + this.restartCount + ', reason: ' + reason + ')');

    setTimeout(() => {
      // Run shutdown callbacks then restart
      this.runShutdownCallbacks().then(() => {
        // Reset restart count on successful restart
        this.restartCount = 0;
        this.saveState();
        // Note: actual restart is handled by process manager (PM2, systemd, etc.)
        // We just clean up and exit with code 0 to trigger restart
        process.exit(0);
      });
    }, delay);
  }

  /* ── Graceful shutdown ────────────────────────────────────── */
  async gracefulShutdown(exitCode = 0) {
    if (this.isShuttingDown) return; // prevent double shutdown
    this.isShuttingDown = true;

    this.log('info', 'crash-recovery', 'Starting graceful shutdown...');

    // Stop watchdog
    this.stopWatchdog();

    // Run shutdown callbacks
    try {
      await this.runShutdownCallbacks();
    } catch (e) {
      this.log('error', 'crash-recovery', 'Shutdown callback error: ' + e.message);
    }

    // Save final state
    this.saveState();

    this.log('info', 'crash-recovery', 'Shutdown complete');

    // Force exit after timeout
    setTimeout(() => {
      process.exit(exitCode);
    }, 5000);

    // If all callbacks complete quickly, exit now
    process.exitCode = exitCode;
  }

  /* ── Shutdown callback management ─────────────────────────── */
  onShutdown(callback) {
    this.shutdownCallbacks.push(callback);
  }

  async runShutdownCallbacks() {
    const results = [];
    for (const cb of this.shutdownCallbacks) {
      try {
        const result = await cb();
        results.push({ success: true });
      } catch (e) {
        results.push({ success: false, error: e.message });
        this.log('error', 'crash-recovery', 'Shutdown callback failed: ' + e.message);
      }
    }
    return results;
  }

  /* ── Watchdog timer ───────────────────────────────────────── */
  startWatchdog() {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastWatchdogKick;
      if (elapsed > this.watchdogTimeout) {
        this.log('warn', 'crash-recovery', 'Watchdog: process appears stuck (' + (elapsed / 1000) + 's since last kick)');
        if (this.watchdogCallback) {
          try { this.watchdogCallback(); } catch (e) {}
        }
      }
    }, 30000); // check every 30s

    this.log('info', 'crash-recovery', 'Watchdog started (timeout: ' + (this.watchdogTimeout / 1000) + 's)');
  }

  kickWatchdog() {
    this.lastWatchdogKick = Date.now();
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /* ── Status ───────────────────────────────────────────────── */
  getStatus() {
    const now = Date.now();
    const recentCrashes = this.crashes.filter(c => now - c.timestamp < this.restartWindow);

    return {
      isShuttingDown: this.isShuttingDown,
      totalCrashes: this.crashes.length,
      recentCrashes: recentCrashes.length,
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
      canRestart: this.shouldRestart(),
      lastCrash: this.crashes.length > 0
        ? new Date(this.crashes[this.crashes.length - 1].timestamp).toISOString()
        : 'never',
      watchdog: {
        active: !!this.watchdogTimer,
        lastKick: new Date(this.lastWatchdogKick).toISOString(),
        stuckFor: Math.round((Date.now() - this.lastWatchdogKick) / 1000) + 's'
      }
    };
  }

  /* ── Cleanup ──────────────────────────────────────────────── */
  close() {
    this.stopWatchdog();
    this.saveState();
  }
}

module.exports = CrashRecovery;
