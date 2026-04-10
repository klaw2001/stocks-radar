#!/bin/bash
set -e

echo "=== Results Radar v2 — VPS Setup ==="

# 1. Install Node (if not present)
if ! command -v node &>/dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# 2. Install build tools (needed for better-sqlite3 native module)
if ! dpkg -s build-essential &>/dev/null 2>&1; then
  echo "Installing build tools for sqlite3..."
  sudo apt-get update && sudo apt-get install -y build-essential python3
fi

# 3. Install Puppeteer / Chromium system dependencies
echo "Installing Puppeteer system dependencies (Chromium)..."
sudo apt-get install -y \
  libgbm-dev \
  libxkbcommon-x11-0 \
  libgtk-3-0 \
  libasound2 \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libpango-1.0-0 \
  libcairo2 \
  libatspi2.0-0 \
  libxshmfence1 \
  xvfb

# 4. Install production dependencies (includes puppeteer + Chromium download)
echo "Installing npm dependencies (this downloads Chromium, ~170MB)..."
npm install --omit=dev

# 5. Set up env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo ">>> Edit .env with your settings:"
  echo "    nano .env"
  echo ""
  echo "    Required: USERS, SESSION_SECRET, ADMIN_KEY"
  echo "    Optional: X_BEARER_TOKEN, TIJORI_CONCALL_MONITOR_API_KEY"
fi

# 6. Install PM2 globally
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi

echo ""
echo "=== Setup complete. Next steps: ==="
echo "  1. Edit .env:           nano .env"
echo "  2. Start app:           pm2 start ecosystem.config.js"
echo "  3. Save PM2 on reboot:  pm2 save && pm2 startup"
echo "  4. View logs:           pm2 logs results-radar"
echo ""
echo "App will run on http://localhost:5000"
echo "Set up Nginx to reverse proxy port 5000 to your domain."
echo ""
echo "Twitter/X Note: Requires X API Basic tier (\$100/mo) for real sentiment."
echo "  Get a Bearer token at: https://developer.twitter.com/en/portal/dashboard"
