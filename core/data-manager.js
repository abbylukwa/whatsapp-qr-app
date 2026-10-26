'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/data-manager.js — Persistent Data Storage Per Platform
 *  Each platform has its own JSON data files, completely isolated.
 *  Manages lists (groups to join, users to follow, etc.) with
 *  add/remove/dedup and auto-save.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { writeJSONAtomic, readJSONSafe } = require('./atomic');

class DataManager {
  constructor(platform, dataDir = './data') {
    this.platform = platform;
    this.dataDir = path.join(dataDir, platform);
    this.data = {};
    this.lists = {};
    this.log = () => {};
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  setLog(fn) { this.log = fn; }

  /* ── Key-value storage ─────────────────────────────────────── */
  get(key, defaultVal = null) {
    if (this.data[key] !== undefined) return this.data[key];
    // Try loading from file — v84.1: readJSONSafe quarantines corrupt
    // files instead of silently discarding them (silent data loss).
    try {
      const file = path.join(this.dataDir, `${key}.json`);
      if (fs.existsSync(file)) {
        const loaded = readJSONSafe(file, null);
        if (loaded !== null) {
          this.data[key] = loaded;
          return this.data[key];
        }
      }
    } catch (e) {}
    return defaultVal;
  }

  set(key, value) {
    this.data[key] = value;
    try {
      const file = path.join(this.dataDir, `${key}.json`);
      writeJSONAtomic(file, value);
    } catch (e) {
      this.log('error', 'data', `Failed to save ${key}: ${e.message}`);
    }
  }

  /* ── List management (add/remove/dedup) ───────────────────── */
  getList(name) {
    if (!this.lists[name]) {
      this.lists[name] = this.get(`list_${name}`, []);
    }
    return this.lists[name];
  }

  addToList(name, item) {
    const list = this.getList(name);
    // v84.1 FIX: `item.id && …` treated id=0 and other falsy ids as
    // "no id", letting duplicates in. Compare with hasOwnProperty-style
    // truth handling and cover mixed string/object lists.
    const isDup = list.some(existing => {
      if (typeof item === 'string') return existing === item;
      if (item.id !== undefined && item.id !== null) return existing && existing.id === item.id;
      if (item.url) return existing && existing.url === item.url;
      return existing === item;
    });
    if (isDup) return false;
    list.push(item);
    this.set(`list_${name}`, list);
    this.log('info', 'data', `Added to ${name}: ${item.id || item.url || item}`);
    return true;
  }

  removeFromList(name, predicate) {
    const list = this.getList(name);
    const idx = list.findIndex(predicate);
    if (idx === -1) return false;
    const removed = list.splice(idx, 1)[0];
    this.set(`list_${name}`, list);
    this.log('info', 'data', `Removed from ${name}: ${removed.id || removed.url || removed}`);
    return true;
  }

  listSize(name) {
    return this.getList(name).length;
  }

  /* ── History tracking ──────────────────────────────────────── */
  addToHistory(action, details = {}) {
    const history = this.getList('history');
    history.push({
      action,
      details,
      timestamp: Date.now()
    });
    // Keep last 500 entries
    if (history.length > 500) {
      this.lists['history'] = history.slice(-500);
    }
    this.set('list_history', this.lists['history']);
  }

  getHistory(limit = 20) {
    return this.getList('history').slice(-limit);
  }

  /* ── Stats ─────────────────────────────────────────────────── */
  getStats() {
    const stats = {
      platform: this.platform,
      lists: {}
    };
    for (const name of Object.keys(this.lists)) {
      stats.lists[name] = this.lists[name].length;
    }
    return stats;
  }
}

module.exports = DataManager;
