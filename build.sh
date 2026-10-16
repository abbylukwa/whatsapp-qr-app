#!/bin/bash
set -e
echo "=== Build v83 ==="
echo "Installing npm dependencies..."
npm install --production
echo "Chrome will be provided by @sparticuz/chromium at runtime (cloud-optimized for Render)"
echo "=== Build complete ==="
