#!/bin/bash
# Render build script — pre-installs yt-dlp binary
set -e
echo "=== Build v18: Pre-installing yt-dlp ==="

# Check if yt-dlp is already available
if command -v yt-dlp &> /dev/null; then
  echo "yt-dlp already installed: $(yt-dlp --version)"
else
  echo "Installing yt-dlp..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/render/project/src/yt-dlp
  chmod +x /opt/render/project/src/yt-dlp
  # Also put in PATH
  cp /opt/render/project/src/yt-dlp /usr/local/bin/yt-dlp 2>/dev/null || true
  echo "yt-dlp installed: $(/opt/render/project/src/yt-dlp --version)"
fi

echo "=== Installing npm dependencies ==="
npm install --production

echo "=== Build complete ==="
