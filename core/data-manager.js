'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/data-manager.js — Persistent Data Storage Per Platform
 *  Each platform has its own JSON data files, completely isolated.
 *  Manages lists (groups to join, users to follow, etc.) with
 *  add/remove/dedup and auto-save.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

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
    // Try loading from file
    try {
      const file = path.join(this.dataDir, `${key}.json`);
      if (fs.existsSync(file)) {
        this.data[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
        return this.data[key];
      }
    } catch (e) {}
    return defaultVal;
  }

  set(key, value) {
    this.data[key] = value;
    try {
      const file = path.join(this.dataDir, `${key}.json`);
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
    // Check for duplicates by id or string match
    const isDup = list.some(existing =>
      (item.id && existing.id === item.id) ||
      (typeof item === 'string' && existing === item) ||
      (item.url && existing.url === item.url)
    );
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
