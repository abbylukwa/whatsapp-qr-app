'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/atomic.js — crash-safe JSON persistence (v84.1)
 *
 *  Every module used to write state with plain writeFileSync:
 *  a crash or OOM-kill mid-write left a truncated file, and on the
 *  next boot the corrupt file was silently discarded → total state
 *  loss (dedup lists, circadian state, rate limits, crash ledger…).
 *
 *  This helper makes every write atomic (tmp file + rename) and
 *  every read self-healing (corrupt file renamed to *.corrupt-<ts>
 *  instead of silently resetting), plus a guarded readJSON.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/** Atomic JSON write: writes to <file>.tmp-<pid> then renames over.
 *  rename(2) is atomic on POSIX, so a reader/crash never sees a
 *  half-written file. Creates parent dirs. Returns true on success. */
function writeJSONAtomic(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        try { console.error(`[atomic] write failed for ${file}: ${e.message}`); } catch (_) {}
        return false;
    }
}

/** Safe JSON read: returns fallback on missing file; on CORRUPT file
 *  quarantines it (rename to <file>.corrupt-<ts>) so the operator can
 *  see data was lost instead of it silently resetting every boot. */
function readJSONSafe(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        try {
            return JSON.parse(raw);
        } catch (e) {
            const quarantine = `${file}.corrupt-${Date.now()}`;
            try { fs.renameSync(file, quarantine); } catch (_) {}
            try { console.error(`[atomic] corrupt JSON quarantined: ${file} -> ${quarantine}`); } catch (_) {}
            return fallback;
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            try { console.error(`[atomic] read failed for ${file}: ${e.message}`); } catch (_) {}
        }
        return fallback;
    }
}

module.exports = { writeJSONAtomic, readJSONSafe };
