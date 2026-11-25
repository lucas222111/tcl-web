/**
 * Pre-seeded shell helpers placed inside /apps on the persistent ext2 disk image
 * so Tiny Core Linux users can mount storage, verify networking, install Wine,
 * and launch uploaded 32-bit Windows executables cleanly.
 */

export const GUEST_SCRIPTS = {
  'README.txt': `TinyCore WebVM Persistent Disk (/dev/sda1)
=========================================
Directory layout on this browser-persisted ext2 partition:
  /mnt/sda1/apps/          -> Uploaded Windows .exe/.msi files & helper scripts
  /mnt/sda1/tce/optional/  -> Tiny Core .tcz packages (persisted across reboots)
  /mnt/sda1/wineprefix/    -> Persistent Wine C: drive & registry (32-bit x86)

Quick commands inside a Tiny Core terminal (aterm):
  1. Mount this drive (if not auto-mounted):
       sudo mkdir -p /mnt/sda1 && sudo mount /dev/sda1 /mnt/sda1
  2. Verify DHCP & DNS over the browser relay:
       sh /mnt/sda1/apps/net-check.sh
  3. Install 32-bit Wine (~160 MB across 124 .tcz packages):
       sh /mnt/sda1/apps/install-wine.sh
  4. Run an uploaded 32-bit Windows .exe:
       sh /mnt/sda1/apps/run-win.sh /mnt/sda1/apps/yourapp.exe

Note: v86 emulates 32-bit x86 (i686). Wine inside Tiny Core 11.0 executes
32-bit Win32/Win16 programs, not native 64-bit (x86_64) Windows 10/11 binaries.
`,

  'net-check.sh': `#!/bin/sh
echo "=== TinyCore WebVM Network Check ==="
ifconfig -a
echo "Requesting DHCP lease on eth0..."
sudo udhcpc -n -q -t 5 -i eth0 || true
ip addr show eth0 2>/dev/null || ifconfig eth0
echo "Testing HTTP connectivity to repo.tinycorelinux.net..."
wget -q -T 10 --spider http://repo.tinycorelinux.net/11.x/x86/tcz/wine.tcz.info && echo "OK: Tiny Core repository reachable" || echo "WARN: Repo unreachable (check relay setting or offline .tcz drop)"
`,

  'install-wine.sh': `#!/bin/sh
set -e
echo "=== TinyCore WebVM: Wine 5.0.1 (32-bit x86) Setup ==="

if ! mountpoint -q /mnt/sda1 2>/dev/null; then
  sudo mkdir -p /mnt/sda1
  sudo mount /dev/sda1 /mnt/sda1
fi

sudo mkdir -p /mnt/sda1/tce/optional /mnt/sda1/wineprefix /mnt/sda1/apps
sudo chown -R tc:staff /mnt/sda1/tce /mnt/sda1/wineprefix /mnt/sda1/apps

if [ ! -e /etc/sysconfig/tcedir ] || [ "$(readlink -f /etc/sysconfig/tcedir)" != "/mnt/sda1/tce" ]; then
  sudo rm -rf /etc/sysconfig/tcedir
  sudo ln -s /mnt/sda1/tce /etc/sysconfig/tcedir
fi

if ! grep -q "swapfile" /proc/swaps 2>/dev/null; then
  FREE_KB=$(df -k /mnt/sda1 | awk 'NR==2 {print $4}')
  if [ "$FREE_KB" -gt 240000 ]; then
    echo "Creating 64 MB swapfile on /mnt/sda1/swapfile..."
    sudo dd if=/dev/zero of=/mnt/sda1/swapfile bs=1M count=64 2>/dev/null
    sudo chmod 600 /mnt/sda1/swapfile
    sudo mkswap /mnt/sda1/swapfile
    sudo swapon /mnt/sda1/swapfile
  fi
fi

if [ -f /mnt/sda1/tce/optional/wine.tcz ]; then
  echo "Found local wine.tcz in /mnt/sda1/tce/optional; loading..."
  tce-load -i /mnt/sda1/tce/optional/wine.tcz || tce-load -wi wine
else
  echo "Ensuring DHCP lease before downloading wine.tcz (124 packages, ~160 MB)..."
  sudo udhcpc -n -q -t 5 -i eth0 || true
  tce-load -wi wine
fi

export WINEPREFIX=/mnt/sda1/wineprefix
export WINEARCH=win32
export WINEDEBUG=-all
ln -sfn /mnt/sda1/wineprefix "$HOME/.wine"

if command -v wine >/dev/null 2>&1; then
  echo "Wine installed: $(wine --version)"
  echo "Initializing 32-bit Wine prefix at $WINEPREFIX..."
  wineboot --init || true
  echo "Ready! Run: sh /mnt/sda1/apps/run-win.sh /mnt/sda1/apps/yourapp.exe"
else
  echo "Wine binary not found after tce-load. Check network relay or disk space."
  exit 1
fi
`,

  'run-win.sh': `#!/bin/sh
if ! mountpoint -q /mnt/sda1 2>/dev/null; then
  sudo mkdir -p /mnt/sda1
  sudo mount /dev/sda1 /mnt/sda1
fi

if ! command -v wine >/dev/null 2>&1; then
  if [ -f /mnt/sda1/tce/optional/wine.tcz ]; then
    tce-load -i /mnt/sda1/tce/optional/wine.tcz
  else
    echo "Wine is not installed yet. Run: sh /mnt/sda1/apps/install-wine.sh"
    echo "Available files in /mnt/sda1/apps:"
    ls -lh /mnt/sda1/apps
    exit 1
  fi
fi

export WINEPREFIX=/mnt/sda1/wineprefix
export WINEARCH=win32
export WINEDEBUG=-all

if [ -z "$1" ]; then
  echo "=== Uploaded Apps in /mnt/sda1/apps ==="
  ls -lh /mnt/sda1/apps
  echo ""
  echo "Usage: sh /mnt/sda1/apps/run-win.sh /mnt/sda1/apps/<program.exe>"
  exit 0
fi

echo "Launching $1 with $(wine --version)..."
exec wine "$1"
`,
};
