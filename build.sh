#!/bin/bash
set -e
echo "=== Build v22.0 ==="
if command -v yt-dlp &> /dev/null; then
  echo "yt-dlp already installed"
else
  echo "Installing yt-dlp..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/render/project/src/yt-dlp
  chmod +x /opt/render/project/src/yt-dlp
  cp /opt/render/project/src/yt-dlp /usr/local/bin/yt-dlp 2>/dev/null || true
fi
echo "Installing npm dependencies..."
npm install --production
echo "=== Build complete ==="
