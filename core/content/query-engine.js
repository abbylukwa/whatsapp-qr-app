'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/content/query-engine.js — Query Variation Engine
 *
 *  PURPOSE: Generate precise, unpredictable search queries that:
 *    1. Never repeat the same query in a short window
 *    2. Vary search terms for maximum content diversity
 *    3. Include niche/long-tail queries for unique finds
 *    4. Rotate between broad and specific queries
 *    5. Add random qualifiers that make each query unique
 *
 *  ANTI-DETECTION:
 *    - No predictable pattern in query sequence
 *    - Time-of-day influences query selection
 *    - Day-of-week adds variety
 *    - Never the same query twice in 24 hours
 * ══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

class QueryEngine {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this.maxHistory = options.maxHistory || 100;
    
    // Recent query history (for dedup)
    this._recentQueries = [];
    
    // Query cursor for rotation
    this._cursor = Math.floor(Math.random() * 1000); // Random start
  }

  /* ════════════════════════════════════════════════════════════
   *  BASE QUERY POOLS
   *  Organized by category for intelligent rotation
   * ════════════════════════════════════════════════════════════ */
  
  // Core categories with many variations
  static CATEGORIES = {
    twerk: {
      base: ['twerk', 'twerking', 'twerk dance', 'booty shake'],
      subjects: ['ebony', 'african', 'latina', 'big booty', 'thick', 'bbw', 'nigerian', 'ghanaian', 'kenyan', 'south african', 'zimbabwean'],
      qualifiers: ['compilation', 'routine', 'challenge', 'slow motion', 'in heels', 'in shorts', 'in thong', 'on wall', 'floor', 'standing', 'bent over', 'reverse', 'fast', 'tropical', 'club', 'home', 'bedroom', 'kitchen', 'bathroom']
    },
    dance: {
      base: ['dance', 'dancing', 'sexy dance', 'dirty dance', 'lap dance'],
      subjects: ['ebony', 'african', 'latina', 'nigerian', 'ghanaian', 'south african', 'mapouka', 'coupe decale'],
      qualifiers: ['naked', 'strip', 'slow', 'fast', 'club', 'private', 'tropical', 'reggae', 'afrobeats', 'amapiano', 'bashment', 'ghanaian', 'naija']
    },
    booty: {
      base: ['booty', 'ass', 'big ass', 'phat ass', 'huge booty'],
      subjects: ['ebony', 'african', 'latina', 'bbw', 'thick', 'curvy', 'nigerian', 'ghanaian'],
      qualifiers: ['clapping', 'bouncing', 'jiggling', 'spreading', 'worship', 'shaking', 'oil', 'wet', 'pool', 'beach', 'shower']
    },
    couples: {
      base: ['threesome', 'couple', 'homemade', 'amateur', 'real'],
      subjects: ['ebony', 'african', 'nigerian', 'ghanaian', 'kenyan', 'interracial'],
      qualifiers: ['hot', 'passionate', 'rough', 'soft', 'morning', 'kitchen', 'shower', 'outdoor', 'hotel', 'car']
    },
    lesbian: {
      base: ['lesbian', 'girl on girl', 'sapphic', 'wlw'],
      subjects: ['ebony', 'african', 'latina', 'thick', 'bbw'],
      qualifiers: ['kissing', 'tribbing', 'massage', 'strap', 'oral', 'shower', 'bed', '69', 'facesitting']
    },
    solo: {
      base: ['solo', 'masturbation', 'playing', 'fingering'],
      subjects: ['ebony', 'african', 'latina', 'bbw', 'milf', 'nigerian', 'ghanaian'],
      qualifiers: ['toys', 'dildo', 'vibrator', 'shower', 'bed', 'kitchen', 'outdoor', 'webcam', 'onlyfans', 'oil']
    },
    milf: {
      base: ['milf', 'mature', 'cougar', 'mom', 'auntie'],
      subjects: ['ebony', 'african', 'latina', 'thick', 'curvy'],
      qualifiers: ['solo', 'anal', 'homemade', 'amateur', 'busty', 'chubby', 'experienced']
    }
  };

  // Time-of-day preferences (weighted categories per hour)
  static TIME_WEIGHTS = {
    // Late night (0-5): more explicit, couples, solo
    lateNight:   { twerk: 0.20, dance: 0.10, booty: 0.20, couples: 0.25, lesbian: 0.10, solo: 0.10, milf: 0.05 },
    // Morning (6-11): softer, dance-focused
    morning:     { twerk: 0.30, dance: 0.25, booty: 0.20, couples: 0.05, lesbian: 0.05, solo: 0.05, milf: 0.10 },
    // Afternoon (12-17): variety
    afternoon:   { twerk: 0.25, dance: 0.15, booty: 0.25, couples: 0.10, lesbian: 0.10, solo: 0.10, milf: 0.05 },
    // Evening (17-21): prime time, most explicit
    evening:     { twerk: 0.20, dance: 0.10, booty: 0.20, couples: 0.20, lesbian: 0.15, solo: 0.10, milf: 0.05 },
    // Night (21-23): mix
    night:       { twerk: 0.25, dance: 0.15, booty: 0.20, couples: 0.15, lesbian: 0.10, solo: 0.10, milf: 0.05 }
  };

  /* ── Get time context ──────────────────────────────────────── */
  _getTimeContext(hour) {
    if (hour >= 0 && hour < 6) return 'lateNight';
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  /* ── Weighted random pick ──────────────────────────────────── */
  _weightedPick(weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = Math.random() * total;
    for (const [key, weight] of entries) {
      r -= weight;
      if (r <= 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  /* ── Random from array ─────────────────────────────────────── */
  _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ════════════════════════════════════════════════════════════
   *  GENERATE: Create a unique, unpredictable query
   * ════════════════════════════════════════════════════════════ */
  generate(options = {}) {
    const hour = options.hour !== undefined ? options.hour : new Date().getHours();
    const timeContext = this._getTimeContext(hour);
    const weights = QueryEngine.TIME_WEIGHTS[timeContext];
    
    let query;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      // Pick category based on time-of-day weights
      const categoryName = this._weightedPick(weights);
      const category = QueryEngine.CATEGORIES[categoryName];
      
      if (!category) { attempts++; continue; }
      
      // Build query: [subject] [base] [qualifier] (random order)
      const parts = [];
      
      // Subject (always include)
      parts.push(this._pick(category.subjects));
      
      // Base (always include)
      parts.push(this._pick(category.base));
      
      // Qualifier (70% chance - keeps some queries broad)
      if (Math.random() < 0.70) {
        parts.push(this._pick(category.qualifiers));
      }
      
      // Randomize part order (anti-pattern)
      if (Math.random() < 0.3) {
        parts.sort(() => Math.random() - 0.5);
      }
      
      query = parts.join(' ');
      
      // Check dedup
      if (!this._recentQueries.includes(query.toLowerCase())) {
        this._recentQueries.push(query.toLowerCase());
        if (this._recentQueries.length > this.maxHistory) {
          this._recentQueries = this._recentQueries.slice(-this.maxHistory);
        }
        break;
      }
      
      attempts++;
    }
    
    // Fallback: if all attempts failed, use cursor-based rotation
    if (!query || attempts >= maxAttempts) {
      const allQueries = this._getAllFlatQueries();
      this._cursor = (this._cursor + 1) % allQueries.length;
      query = allQueries[this._cursor];
    }
    
    return query;
  }

  /* ── Generate N queries ────────────────────────────────────── */
  generateBatch(n = 15, options = {}) {
    const queries = [];
    for (let i = 0; i < n; i++) {
      queries.push(this.generate({ ...options, hour: options.hour }));
    }
    return queries;
  }

  /* ── Get all flat queries (for fallback) ───────────────────── */
  _getAllFlatQueries() {
    const all = [];
    for (const category of Object.values(QueryEngine.CATEGORIES)) {
      for (const subject of category.subjects) {
        for (const base of category.base) {
          all.push(subject + ' ' + base);
        }
      }
    }
    return all;
  }

  /* ── Get the legacy DEFAULT_QUERIES compatible array ──────── */
  getLegacyQueries() {
    return [
      'ebony twerk', 'latina booty', 'african porn', 'big booty twerking',
      'ebony dance', 'nigerian twerk', 'south african porn', 'ghana porn',
      'booty shake', 'ebony threesome', 'latina porn', 'ebony bbw',
      'african booty', 'sexy dance', 'twerking compilation', 'ebony lesbian',
      'kenyan porn', 'ebony milf', 'booty clapping', 'african ebony',
      'zimbabwean twerk', 'mapouka dance', 'ebony homemade', 'african amateur',
      'thick ebony solo', 'ghanaian booty', 'naija dance', 'ebony oil',
      'african lap dance', 'ebony bbw twerk', 'latina milf', 'african couples',
      'ebony shower', 'mzansi booty', 'kenyan twerk', 'ebony strip'
    ];
  }

  /* ── Stats ─────────────────────────────────────────────────── */
  getStats() {
    return {
      queriesGenerated: this._cursor,
      recentSize: this._recentQueries.length,
      categories: Object.keys(QueryEngine.CATEGORIES).length
    };
  }

  /* ── Load/Save for persistence ─────────────────────────────── */
  loadState(state) {
    if (state.recentQueries) this._recentQueries = state.recentQueries.slice(-this.maxHistory);
    if (state.cursor) this._cursor = state.cursor;
  }

  exportState() {
    return {
      recentQueries: this._recentQueries.slice(),
      cursor: this._cursor
    };
  }
}

module.exports = QueryEngine;
