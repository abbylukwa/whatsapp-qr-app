'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/logger.js — Structured Logging System (Commercial Grade)
 *  JSON-structured logs with levels, rotation, and persistence.
 *  Supports:
 *    - Multiple levels: debug, info, warn, error, fatal
 *    - Structured JSON output with timestamps and context
 *    - Log file rotation (size-based)
 *    - Per-platform log streams
 *    - Performance metrics logging
 *    - Alert thresholds (auto-escalate on error rates)
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_LOG_FILES = 5;
const ALERT_WINDOW = 60000; // 1 minute window for error rate alerts
const ALERT_THRESHOLD = 10; // 10 errors in window triggers alert

class Logger {
  constructor(options = {}) {
    this.serviceName = options.service || 'bot';
    this.level = options.level || (process.env.LOG_LEVEL || 'info');
    this.logDir = options.logDir || './logs';
    this.console = options.console !== false;
    this.file = options.file !== false;
    this.json = options.json !== false;
    this.sessionId = uuid();
    this.errorCounts = [];
    this.metrics = { totalLogs: 0, byLevel: {}, byPlatform: {} };

    // Initialize log directory
    if (this.file) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch (e) {}
    }

    // Bind level methods
    this.debug = this._log.bind(this, 'debug');
    this.info = this._log.bind(this, 'info');
    this.warn = this._log.bind(this, 'warn');
    this.error = this._log.bind(this, 'error');
    this.fatal = this._log.bind(this, 'fatal');
  }

  /* ── Core log method ──────────────────────────────────────── */
  _log(level, platform, message, meta = {}) {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      platform: platform || 'system',
      session: this.sessionId,
      message,
      ...meta
    };

    // Track metrics
    this.metrics.totalLogs++;
    this.metrics.byLevel[level] = (this.metrics.byLevel[level] || 0) + 1;
    this.metrics.byPlatform[platform] = (this.metrics.byPlatform[platform] || 0) + 1;

    // Track error rate for alerts
    if (LOG_LEVELS[level] >= LOG_LEVELS.error) {
      this.errorCounts.push(Date.now());
      this._checkAlertThreshold();
    }

    // Console output
    if (this.console) {
      const prefix = this.json
        ? JSON.stringify(entry)
        : `[${entry.timestamp}] [${level.toUpperCase()}] [${platform}] ${message}`;
      const output = level === 'error' || level === 'fatal' ? 'stderr' : 'stdout';
      process[output].write(prefix + '\n');
    }

    // File output
    if (this.file) {
      this._writeToFile(entry);
    }
  }

  /* ── File writing with rotation ───────────────────────────── */
  _writeToFile(entry) {
    try {
      const logFile = path.join(this.logDir, `${this.serviceName}.log`);
      const line = JSON.stringify(entry) + '\n';

      // Check rotation
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size >= MAX_LOG_SIZE) {
          this._rotateLog(logFile);
        }
      }

      fs.appendFileSync(logFile, line);
    } catch (e) {
      // Failsafe — never let logging crash the app
    }
  }

  /* ── Log rotation ─────────────────────────────────────────── */
  _rotateLog(logFile) {
    try {
      // Shift existing rotated files
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const oldFile = `${logFile}.${i}`;
        const newFile = `${logFile}.${i + 1}`;
        if (fs.existsSync(oldFile)) {
          fs.renameSync(oldFile, newFile);
        }
      }
      // Move current to .1
      fs.renameSync(logFile, `${logFile}.1`);
    } catch (e) {}
  }

  /* ── Alert threshold check ────────────────────────────────── */
  _checkAlertThreshold() {
    const now = Date.now();
    // Clean old entries
    this.errorCounts = this.errorCounts.filter(t => now - t < ALERT_WINDOW);

    if (this.errorCounts.length >= ALERT_THRESHOLD) {
      this._log('warn', 'system', 'ALERT: Error rate threshold exceeded', {
        errorsInWindow: this.errorCounts.length,
        window: ALERT_WINDOW,
        threshold: ALERT_THRESHOLD
      });
    }
  }

  /* ── Performance timer ────────────────────────────────────── */
  timer(operation) {
    const start = Date.now();
    return {
      end: (meta = {}) => {
        const duration = Date.now() - start;
        this._log('info', 'perf', `${operation} completed`, {
          operation,
          durationMs: duration,
          ...meta
        });
        return duration;
      }
    };
  }

  /* ── Get metrics ──────────────────────────────────────────── */
  getMetrics() {
    return {
      ...this.metrics,
      errorRate: this.errorCounts.length,
      session: this.sessionId,
      uptime: Date.now() - (this.metrics.startTime || Date.now())
    };
  }

  /* ── Create child logger for a platform ──────────────────── */
  child(platform) {
    const childLogger = new Logger({
      service: this.serviceName + ':' + platform,
      level: this.level,
      logDir: this.logDir,
      console: this.console,
      file: this.file,
      json: this.json
    });
    childLogger.sessionId = this.sessionId;
    return childLogger;
  }
}

/* ── Singleton factory ─────────────────────────────────────── */
let defaultLogger = null;

function getLogger(options = {}) {
  if (!defaultLogger) {
    defaultLogger = new Logger(options);
  }
  return defaultLogger;
}

function resetLogger() {
  defaultLogger = null;
}

module.exports = { Logger, getLogger, resetLogger, LOG_LEVELS };
