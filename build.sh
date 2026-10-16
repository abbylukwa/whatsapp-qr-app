#!/bin/bash
set -e
echo "=== Build v82 ==="
echo "Installing npm dependencies..."
npm install --production
echo "Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome 2>/dev/null || echo "Chrome install skipped (may already exist)"
echo "=== Build complete ==="
