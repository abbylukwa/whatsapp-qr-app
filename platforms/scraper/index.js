'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/scraper/index.js — Intelligent Scraper Integration
 *  Integrates abbylukwa/intelligent-scraper into the bot:
 *    - Scrape media (images, videos, GIFs) for content
 *    - Use scraped content for YouTube/Facebook posts
 *    - Hot-reloads my_links.json for dynamic source management
 *    - Admin can add sources via WhatsApp commands
 *
 *  Architecture: Runs scraper as a child process/API alongside
 *  the main bot. Content flows: Scraper → Content Pipeline →
 *  YouTube/Facebook posting.
 * ══════════════════════════════════════════════════════════════ */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

class ScraperIntegration {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.scraperDir = options.scraperDir || '../intelligent-scraper';
    this.port = options.port || 3456;
    this.token = options.token || process.env.SCRAPER_TOKEN || '';
    this.process = null;
    this.running = false;
    this.contentQueue = [];
    this.health = {
      startedAt: null,
      requestsServed: 0,
      lastRequest: null,
      errors: 0
    };
  }

  /* ── Start the scraper server ─────────────────────────────── */
  async start() {
    const scraperPath = path.resolve(this.scraperDir);
    if (!fs.existsSync(scraperPath)) {
      this.log('warn', 'scraper', `Scraper not found at ${scraperPath} — skipping`);
      return { success: false, error: 'Scraper directory not found' };
    }

    // Install dependencies if needed
    const nodeModules = path.join(scraperPath, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      this.log('info', 'scraper', 'Installing scraper dependencies...');
      try {
        execSync('npm install --production', { cwd: scraperPath, timeout: 120000 });
      } catch (e) {
        this.log('error', 'scraper', `npm install failed: ${e.message}`);
        return { success: false, error: 'Dependencies install failed' };
      }
    }

    // Start scraper as child process
    this.log('info', 'scraper', `Starting scraper on port ${this.port}...`);
    this.process = spawn('node', ['server.js'], {
      cwd: scraperPath,
      env: {
        ...process.env,
        PORT: String(this.port),
        SCRAPER_TOKEN: this.token
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (data) => {
      this.log('info', 'scraper', data.toString().trim());
    });

    this.process.stderr.on('data', (data) => {
      this.log('error', 'scraper', data.toString().trim());
    });

    this.process.on('exit', (code) => {
      this.running = false;
      this.log('warn', 'scraper', `Scraper exited with code ${code}`);
    });

    this.running = true;
    this.health.startedAt = Date.now();

    // Wait for server to be ready
    await this._waitForReady();
    this.log('info', 'scraper', 'Scraper ready');
    return { success: true };
  }

  /* ── Wait for server to respond ───────────────────────────── */
  async _waitForReady(maxWait = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const result = await this._request('GET', '/health');
        if (result) return true;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  /* ── Make request to scraper API ──────────────────────────── */
  async _request(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: this.port,
        path: endpoint,
        method,
        headers: { 'Content-Type': 'application/json' }
      };

      if (this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          this.health.requestsServed++;
          this.health.lastRequest = Date.now();
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      });

      req.on('error', (e) => {
        this.health.errors++;
        reject(e);
      });

      if (data) req.write(JSON.stringify(data));
      req.end();
    });
  }

  /* ── Get media from scraper ───────────────────────────────── */
  async getMedia(query, type = 'video') {
    try {
      const result = await this._request('GET', `/api/${type}?q=${encodeURIComponent(query)}`);
      return result;
    } catch (e) {
      this.log('error', 'scraper', `Media fetch failed: ${e.message}`);
      return null;
    }
  }

  /* ── Get available slots/sources ──────────────────────────── */
  async getSlots() {
    try {
      return await this._request('GET', '/api/slots');
    } catch (e) {
      return null;
    }
  }

  /* ── Add a source link (via API or file) ──────────────────── */
  async addSource(slotId, url) {
    // Update my_links.json directly
    const linksFile = path.join(this.scraperDir, 'my_links.json');
    try {
      if (fs.existsSync(linksFile)) {
        const links = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
        if (!links.slots) links.slots = [];
        links.slots.push({ id: slotId, url, type: 'video' });
        fs.writeFileSync(linksFile, JSON.stringify(links, null, 2));
        this.log('info', 'scraper', `Source added: ${slotId}`);
        return { success: true };
      }
    } catch (e) {
      this.log('error', 'scraper', `Add source failed: ${e.message}`);
    }
    return { success: false };
  }

  /* ── Get health/status ────────────────────────────────────── */
  getStatus() {
    return {
      running: this.running,
      port: this.port,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      queueSize: this.contentQueue.length
    };
  }

  /* ── Cleanup ──────────────────────────────────────────────── */
  close() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.running = false;
    this.log('info', 'scraper', 'Stopped');
  }
}

module.exports = ScraperIntegration;
