#!/usr/bin/env bash
set -euo pipefail

# NOTE: This script is tailored to my personal deployment setup.
# Change PI_HOST and PI_DIR to match your own server.
PI_HOST="derrick@pidata.decarb.us"
PI_DIR="/home/derrick/ecobee-mcp"

echo "==> Building..."
npm run build

echo "==> Syncing dist/ to Pi..."
rsync -avz --delete \
  dist \
  "$PI_HOST:$PI_DIR/"

echo "==> Syncing package files to Pi..."
rsync -avz \
  package.json package-lock.json \
  "$PI_HOST:$PI_DIR/"

echo "==> Installing production deps on Pi..."
ssh "$PI_HOST" "cd $PI_DIR && npm install --production"

echo "==> Restarting service..."
ssh "$PI_HOST" "sudo systemctl restart ecobee-mcp"

echo "==> Done! Checking status..."
ssh "$PI_HOST" "sudo systemctl status ecobee-mcp --no-pager"
