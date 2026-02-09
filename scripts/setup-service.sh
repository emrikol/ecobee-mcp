#!/usr/bin/env bash
set -euo pipefail

# Run this ON the target server to install the systemd service.
# NOTE: This script is tailored to my personal setup.
# Change the User, WorkingDirectory, EnvironmentFile, and ReadWritePaths
# in the service unit below to match your own server.

SERVICE_FILE="/etc/systemd/system/ecobee-mcp.service"

sudo tee "$SERVICE_FILE" > /dev/null << 'EOF'
[Unit]
Description=Ecobee MCP Server
After=network.target

[Service]
Type=simple
User=derrick
WorkingDirectory=/home/derrick/ecobee-mcp
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/home/derrick/ecobee-mcp/.env
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/derrick/ecobee-mcp

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ecobee-mcp
sudo systemctl start ecobee-mcp

echo "Service installed and started."
echo "Check status: sudo systemctl status ecobee-mcp"
echo "View logs: journalctl -u ecobee-mcp -f"
