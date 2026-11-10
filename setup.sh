#!/usr/bin/env bash
set -e

echo "=== WindsurfAPI Setup ==="

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Darwin:arm64)   LS_PATH="$HOME/.windsurf/language_server_macos_arm"; LS_DATA_DIR="$HOME/.windsurf/data" ;;
  Darwin:x86_64)  LS_PATH="$HOME/.windsurf/language_server_macos_x64"; LS_DATA_DIR="$HOME/.windsurf/data" ;;
  Linux:x86_64|Linux:amd64)
                  LS_PATH="/opt/windsurf/language_server_linux_x64"; LS_DATA_DIR="/opt/windsurf/data" ;;
  Linux:aarch64|Linux:arm64)
                  LS_PATH="/opt/windsurf/language_server_linux_arm"; LS_DATA_DIR="/opt/windsurf/data" ;;
  *)              LS_PATH="/opt/windsurf/language_server_linux_x64"; LS_DATA_DIR="/opt/windsurf/data" ;;
esac

# Create directories
echo "[1/4] Creating directories..."
mkdir -p "$(dirname "$LS_PATH")"
mkdir -p "$LS_DATA_DIR/db"
mkdir -p /tmp/windsurf-workspace

# Check LS binary. Its presence decides the default backend below: without a
# language server the ONLY working backend is DEVIN_CONNECT (pure HTTP), so we
# enable it in the generated .env instead of leaving the user on the Cascade
# path with a missing binary. Matters most on macOS, where the binary has to be
# extracted from Windsurf.app by hand.
if [ -f "$LS_PATH" ]; then
  chmod +x "$LS_PATH"
  LS_FOUND=1
  echo "[2/4] Language Server found at $LS_PATH"
else
  LS_FOUND=0
  echo "[2/4] Language Server not found at $LS_PATH"
  if [ "$OS" = "Darwin" ]; then
    echo "       That's fine on macOS — defaulting to DEVIN_CONNECT (pure HTTP, no binary)."
    echo "       Only needed for the legacy Cascade backend; copy it out of Windsurf.app if you want that:"
    echo "       \"\$HOME/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/$(basename "$LS_PATH")\""
  else
    echo "       Defaulting to DEVIN_CONNECT (pure HTTP, no binary needed)."
    echo "       For the legacy Cascade backend, place the binary there and chmod +x it."
  fi
fi

# Generate .env if not exists
if [ ! -f .env ]; then
  echo "[3/4] Generating .env..."
  # Backend default follows what the machine can actually run (see [2/4]).
  # NOTE: config.js only force-enables DEVIN_CONNECT for the packaged .exe
  # (IS_PACKAGED), so a source install MUST set it here or it falls through to
  # Cascade and demands the language_server binary.
  if [ "$LS_FOUND" = "1" ]; then
    DEVIN_CONNECT_LINE="# DEVIN_CONNECT=1"
    RELOGIN_LINE="# DEVIN_CONNECT_AUTO_RELOGIN=1"
  else
    DEVIN_CONNECT_LINE="DEVIN_CONNECT=1"
    RELOGIN_LINE="DEVIN_CONNECT_AUTO_RELOGIN=1"
  fi
  # Chat API and dashboard both FAIL CLOSED with empty secrets, even on a
  # loopback bind ("local bind" is not "no proxy"). Source installs must set
  # API_KEY + DASHBOARD_PASSWORD, or opt in to local open access:
  # WINDSURFAPI_ALLOW_UNAUTHENTICATED=1 / DASHBOARD_ALLOW_NO_AUTH=1.
  if [ "$OS" = "Darwin" ]; then
    HOST_LINE="HOST=127.0.0.1"
  else
    HOST_LINE="# HOST=127.0.0.1"
  fi
  cat > .env << ENVEOF
PORT=3003
$HOST_LINE
# Empty API_KEY is fail-closed (401) even on 127.0.0.1.
API_KEY=
DATA_DIR=
# Must be a DEVIN_CONNECT-resolvable name. Matches src/config.js when unset.
# Legacy Cascade alias claude-4.5-sonnet-thinking is mapped:false on Connect:
# default WINDSURFAPI_STRICT_MODEL=1 returns 400; =0 degrades to free selector.
DEFAULT_MODEL=claude-sonnet-4.6
MAX_TOKENS=8192
LOG_LEVEL=info
# Empty DASHBOARD_PASSWORD is fail-closed even on localhost.
DASHBOARD_PASSWORD=
ALLOW_PRIVATE_PROXY_HOSTS=

# ===== Backend: DEVIN_CONNECT (recommended, binary-less) =====
# Pure HTTP to Devin cloud — no language_server binary needed. Add a Devin
# account via the dashboard "登录取号" page, or scripts/devin-connect-login.mjs.
# The LS_* lines below are only for the legacy Cascade backend; leave as-is if
# you use DEVIN_CONNECT.
$DEVIN_CONNECT_LINE
$RELOGIN_LINE
# Required for auto-relogin to actually persist credentials (32+ chars):
# DEVIN_CONNECT_CRED_KEY=

# ===== Legacy Cascade backend (language server) =====
LS_BINARY_PATH=$LS_PATH
LS_DATA_DIR=$LS_DATA_DIR
LS_PORT=42100
ENVEOF
  echo "       Edit .env to set your API_KEY and DASHBOARD_PASSWORD"
  if [ "$LS_FOUND" = "1" ]; then
    echo "       For the Devin backend: uncomment DEVIN_CONNECT=1 and add an account"
  else
    echo "       DEVIN_CONNECT=1 enabled (no language server present)"
  fi
else
  echo "[3/4] .env already exists, skipping"
fi

# Check Node.js version
NODE_VER=$(node -v 2>/dev/null | sed 's/^v//')
if [ -z "$NODE_VER" ]; then
  echo "[4/4] WARNING: Node.js not found. Install Node.js >= 22.13"
elif ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  echo "[4/4] WARNING: Node.js v$NODE_VER detected, need >= 22.13"
else
  echo "[4/4] Node.js $(node -v) OK"
fi

echo ""
echo "=== Done ==="
echo "Start:     node src/index.js"
echo "Dev:       node --watch src/index.js"
echo "Dashboard: http://localhost:3003/dashboard"
if [ "$LS_FOUND" != "1" ]; then
  echo ""
  echo "Backend:   DEVIN_CONNECT (no language server needed)"
  echo "Next:      add an account, or every request will 401 —"
  echo "             dashboard \"登录取号\" page, or:"
  echo "             LOGIN_REAL=1 node scripts/devin-connect-login.mjs <email> <password>"
fi
