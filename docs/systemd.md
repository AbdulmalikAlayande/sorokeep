# Running sorokeep as a systemd Service

This guide covers installing the sorokeep monitoring daemon as a persistent systemd service on Linux so it survives reboots and auto-restarts on failure.

## Prerequisites

- Linux with systemd (systemd 232+)
- `sorokeep` installed and available on `$PATH` (e.g. via `npm link` after `npm run build`)
- Root / sudo access

## Quick Install

```bash
# From the repo root
sudo bash systemd/install-service.sh
```

The script will:
1. Copy `systemd/sorokeep-daemon.service` to `/etc/systemd/system/`
2. Run `systemctl daemon-reload`
3. Enable the service to start on boot
4. Start it immediately

## Manual Install

```bash
sudo cp systemd/sorokeep-daemon.service /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/sorokeep-daemon.service
sudo systemctl daemon-reload
sudo systemctl enable sorokeep-daemon
sudo systemctl start sorokeep-daemon
```

## Managing the Service

```bash
# Check current status
systemctl status sorokeep-daemon

# Follow live logs (journald)
journalctl -u sorokeep-daemon -f

# Stop / start / restart
sudo systemctl stop sorokeep-daemon
sudo systemctl start sorokeep-daemon
sudo systemctl restart sorokeep-daemon

# Disable auto-start on boot
sudo systemctl disable sorokeep-daemon
```

## Configuration

### Network and RPC URL

Edit `/etc/systemd/system/sorokeep-daemon.service` and update the `ExecStart` line:

```ini
ExecStart=/usr/bin/sorokeep daemon --network mainnet --rpc-url https://your-rpc.example.com
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart sorokeep-daemon
```

### Environment Variables (secret key for auto-extend)

Uncomment the `EnvironmentFile` line in the service file and create the file:

```ini
EnvironmentFile=/etc/sorokeep/env
```

```bash
sudo mkdir -p /etc/sorokeep
echo "STELLAR_SECRET_KEY=S..." | sudo tee /etc/sorokeep/env
sudo chmod 600 /etc/sorokeep/env
```

### Running as a Non-Root User

It is recommended to run the daemon as a dedicated user. Uncomment the `User` and `Group` lines in the service file and create the user:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin sorokeep
# Ensure the sorokeep data directory is owned by that user
sudo chown -R sorokeep:sorokeep ~/.sorokeep
```

Then update the service file:

```ini
User=sorokeep
Group=sorokeep
```

## Logging

All daemon output is captured by journald. Filter by the `sorokeep` identifier:

```bash
# All logs
journalctl -u sorokeep-daemon

# Since last boot
journalctl -u sorokeep-daemon -b

# Last 100 lines
journalctl -u sorokeep-daemon -n 100

# Real-time
journalctl -u sorokeep-daemon -f
```

## Uninstalling

```bash
sudo systemctl stop sorokeep-daemon
sudo systemctl disable sorokeep-daemon
sudo rm /etc/systemd/system/sorokeep-daemon.service
sudo systemctl daemon-reload
```
