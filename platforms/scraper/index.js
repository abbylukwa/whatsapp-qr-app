'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/scraper/index.js — Intelligent Scraper REMOTE client
 *  (v84.1 full rewrite)
 *
 *  The old version tried to SPAWN a local sibling repo
 *  (`../intelligent-scraper`) that doesn't exist on Render, called
 *  /api/<type> endpoints the real service doesn't have, and was
 *  never started — so `scraper.fetchVideo()` on TwitterBot could
 *  never work and every tweet went out text-only.
 *
 *  This rewrite talks to the DEPLOYED scraper (SCRAPER_URL env,
 *  default https://intelligent-scraper.onrender.com) using its real
 *  v4.1 API:
 *      POST /search   {query, myLinks}   -> images
 *      GET  /gif      ?q=&myLinks        -> gifs
 *      POST /video    {query, myLinks}   -> video file (downloaded)
 *      POST /music    {query, myLinks}   -> audio file (downloaded)
 *      POST /download {url, kind}        -> direct file
 *      GET  /my-links                    -> slot diagnostics
 *      GET  /status, /health             -> diagnostics
 *
 *  LINK POLICY (owner requirement): the ONLY media sources are the
 *  owner's own slots — my_links.json on the scraper service, MYLINKS
 *  env, or per-request myLinks. This client forwards MYLINKS with
 *  EVERY request so the scraper never falls back to anything else.
 *  Downloader files are saved to a temp dir and handed to platform
 *  bots as local file paths ready for upload.
 * ══════════════════════════════════════════════════════════════ */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ScraperIntegration {
  constructor(options = {}) {
    this.log = options.log || console.log;
    // Accept both SCRAPER_URL (server.js convention) and scraperUrl option
    this.baseUrl = (options.scraperUrl || process.env.SCRAPER_URL ||
      process.env.SCRAPER || 'https://intelligent-scraper.onrender.com'
    ).replace(/\/+$/, '');
    this.token = options.token || process.env.SCRAPER_TOKEN || '';
    // MYLINKS forwarded with every request — owner's own slots ONLY
    this.myLinks = (options.myLinks || process.env.MYLINKS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    this.downloadDir = options.downloadDir || path.join(process.cwd(), 'data', 'scraper-media');
    this.timeoutMs = options.timeoutMs || 150000;  // downloads can be slow on free tier
    this.health = {
      startedAt: Date.now(),
      requestsServed: 0,
      lastRequest: null,
      errors: 0
    };
    this.running = true;   // remote service — always "running" from our POV
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /* ── Raw request with per-call stats ─────────────────────── */
  async _request(method, endpoint, data = null, params = null, timeout = this.timeoutMs) {
    const started = Date.now();
    try {
      const res = await axios({
        method,
        url: this.baseUrl + endpoint,
        data,
        params,
        headers: this._headers(),
        timeout
      });
      this.health.requestsServed++;
      this.health.lastRequest = Date.now();
      return res.data;
    } catch (e) {
      this.health.errors++;
      const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
      this.log('error', 'scraper', `${method} ${endpoint} failed: ${msg}`);
      throw new Error(`scraper ${endpoint}: ${msg}`);
    }
  }

  /* ── Download the mediaUrl the scraper produced to a local file ── */
  async _downloadToFile(mediaUrl, kind = 'video') {
    const extMap = { video: '.mp4', audio: '.mp3', image: '.jpg', gif: '.gif' };
    let ext = extMap[kind] || '.bin';
    try {
      const u = new URL(mediaUrl);
      const m = /\.(mp4|webm|mp3|m4a|ogg|wav|aac|jpe?g|png|webp|gif)(\?|$)/i.exec(u.pathname);
      if (m) ext = '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
    } catch (e) {}

    fs.mkdirSync(this.downloadDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(this.downloadDir, `${kind}_${id}${ext}`);

    const res = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout: this.timeoutMs,
      maxContentLength: 60 * 1024 * 1024,
      headers: { 'User-Agent': 'BreadBotScraperClient/4.1' }
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
      res.data.on('error', reject);
    });

    const size = fs.statSync(filePath).size;
    if (size < (kind === 'image' ? 12 * 1024 : 300 * 1024)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
      throw new Error(`downloaded file too small (${size}B) — likely a stub`);
    }
    return { filePath, size, ext };
  }

  /* ── PUBLIC: video for Twitter/X posts (THE MISSING METHOD) ──
   * Returns { ok, title, source, filePath, size } or { ok:false, error } */
  async fetchVideo(query, exclude = []) {
    try {
      const body = { query: String(query || '').slice(0, 100), myLinks: this.myLinks };
      if (Array.isArray(exclude) && exclude.length) body.exclude = exclude.slice(0, 10);
      const r = await this._request('POST', '/video', body);
      if (!r || !r.success || !r.mediaUrl) {
        return { ok: false, error: (r && r.hint) || 'no video returned' };
      }
      const dl = await this._downloadToFile(r.mediaUrl, 'video');
      return { ok: true, title: r.title || query, source: r.source || 'my_links', mediaUrl: r.mediaUrl, ...dl };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ── PUBLIC: music/audio ── */
  async fetchMusic(query) {
    try {
      const r = await this._request('POST', '/music', { query: String(query || '').slice(0, 100), myLinks: this.myLinks });
      if (!r || !r.success || !r.mediaUrl) return { ok: false, error: (r && r.hint) || 'no music returned' };
      const dl = await this._downloadToFile(r.mediaUrl, 'audio');
      return { ok: true, title: r.title || query, source: r.source || 'my_links', mediaUrl: r.mediaUrl, ...dl };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ── PUBLIC: images (URLs only — caller downloads or hotlinks) ── */
  async fetchImage(query) {
    try {
      const r = await this._request('POST', '/search', { query: String(query || '').slice(0, 100), myLinks: this.myLinks });
      if (!r || !r.success || !Array.isArray(r.images) || r.images.length === 0) {
        return { ok: false, error: 'no images returned' };
      }
      return { ok: true, images: r.images, source: r.source || 'my_links' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ── PUBLIC: gifs (URLs only) ── */
  async fetchGif(query) {
    try {
      const params = { q: String(query || '').slice(0, 100) };
      if (this.myLinks.length) params.myLinks = this.myLinks.join(',');
      const r = await this._request('GET', '/gif', null, params);
      if (!r || !r.success || !Array.isArray(r.gifs) || r.gifs.length === 0) {
        return { ok: false, error: 'no gifs returned' };
      }
      return { ok: true, gifs: r.gifs, source: 'my_links' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ── Generic media fetch (legacy getMedia name kept for compat) ── */
  async getMedia(query, type = 'video') {
    if (type === 'video') return this.fetchVideo(query);
    if (type === 'music' || type === 'audio') return this.fetchMusic(query);
    if (type === 'gif') return this.fetchGif(query);
    return this.fetchImage(query);
  }

  /* ── Owner slot diagnostics — proves the my_links-only pipeline ── */
  async getSlots() {
    try {
      return await this._request('GET', '/my-links', null, null, 20000);
    } catch (e) {
      return null;
    }
  }

  /* ── Health keep-alive probe (matches server.js keep-alive) ── */
  async ping() {
    try {
      await this._request('GET', '/health', null, null, 10000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── Cleanup our temp downloads (call from admin /cleantemp) ── */
  cleanupDownloads(maxAgeMs = 3600000) {
    let deleted = 0;
    try {
      if (!fs.existsSync(this.downloadDir)) return { deleted: 0 };
      const now = Date.now();
      for (const f of fs.readdirSync(this.downloadDir)) {
        const p = path.join(this.downloadDir, f);
        try {
          if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); deleted++; }
        } catch (e) {}
      }
    } catch (e) {}
    return { deleted };
  }

  getStatus() {
    return {
      running: this.running,
      mode: 'remote',
      baseUrl: this.baseUrl,
      myLinksCount: this.myLinks.length,
      downloadDir: this.downloadDir,
      health: { ...this.health, uptime: Date.now() - this.health.startedAt }
    };
  }

  /* Kept for API compat — no child process to stop anymore */
  close() {
    this.running = false;
    this.log('info', 'scraper', 'Remote scraper client closed');
  }
}

module.exports = ScraperIntegration;
