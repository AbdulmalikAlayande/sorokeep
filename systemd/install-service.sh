#!/usr/bin/env bash
# install-service.sh — Install and enable the sorokeep-daemon systemd service.
# Must be run as root (or with sudo).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/sorokeep-daemon.service"
DEST="/etc/systemd/system/sorokeep-daemon.service"

if [[ $EUID -ne 0 ]]; then
  echo "Error: this script must be run as root." >&2
  exit 1
fi

cp "$SERVICE_FILE" "$DEST"
chmod 644 "$DEST"

systemctl daemon-reload
systemctl enable sorokeep-daemon
systemctl start sorokeep-daemon

echo "sorokeep-daemon installed and started."
echo "Check status with: systemctl status sorokeep-daemon"
echo "Follow logs with:  journalctl -u sorokeep-daemon -f"
