#!/bin/bash
# v19 Render build script — yt-dlp-exec auto-manages its binary (no manual yt-dlp needed)
set -e
echo "=== Build v19: DownloaderX (yt-dlp-exec auto-manages yt-dlp binary) ==="

echo "=== Installing npm dependencies ==="
npm install --production

echo "=== Build complete ==="
