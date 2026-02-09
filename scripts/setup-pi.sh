#!/usr/bin/env bash
set -euo pipefail

# Run this ON the target server for one-time setup.
# NOTE: This script is tailored to my personal setup.
# Change APP_DIR (and paths in the .env template) to match your own server.

APP_DIR="/home/derrick/ecobee-mcp"
PLUGINS_DIR="$APP_DIR/plugins"

echo "==> Creating directories..."
mkdir -p "$APP_DIR" "$PLUGINS_DIR"

echo "==> Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Verify Node 20+
MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [ "$MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required, found $NODE_VERSION"
  exit 1
fi

echo "==> Creating .env template..."
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << 'EOF'
# Ecobee MCP Server Configuration
PORT=3000
MCP_AUTH_TOKEN=CHANGE_ME_TO_A_RANDOM_TOKEN
CREDENTIALS_PATH=/home/derrick/ecobee-mcp/credentials.json
AUTH_MODE=readonly
# ENABLE_PLUGINS=1
EOF
  chmod 600 "$APP_DIR/.env"
  echo "Created .env template at $APP_DIR/.env - EDIT THIS FILE"
else
  echo ".env already exists, skipping"
fi

echo "==> Setting permissions..."
chmod 700 "$APP_DIR"
chmod 700 "$PLUGINS_DIR"

echo "==> Done! Next steps:"
echo "1. Edit $APP_DIR/.env with your auth token"
echo "2. Place credentials.json in $APP_DIR/"
echo "3. Run deploy.sh from your dev machine"
echo "4. Run setup-service.sh on this Pi to install systemd service"
