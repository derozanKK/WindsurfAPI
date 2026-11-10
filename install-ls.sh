#!/usr/bin/env bash
# Install / update the Windsurf language server binary.
#
# Default path (manifest-driven, fail-closed):
#   1. Read the reviewed pins from ls-pins.json.
#   2. Fetch https://windsurf-stable.codeium.com/api/versions.
#   3. Pick the newest pinned stable release (currently 3.10.67) and require
#      the manifest's commit + archive sha256 to match the pin.
#   4. Download the desktop archive, verify its sha256, extract the LS
#      member, verify the inner binary sha256 against the pin, then
#      atomically rename it into place.
#
# There is no silent fallback: an unreachable manifest, a missing sha256
# tool, an unpinned version, or any hash mismatch exits non-zero before the
# target is touched. The old third-party fallback hop is gone.
#
# Usage:
#   ./install-ls.sh                          # newest pinned stable release
#   ./install-ls.sh --version 3.10.67        # exact pinned upstream version
#   ./install-ls.sh --dry-run                # print the plan, write nothing
#   ./install-ls.sh --rollback               # pinned 3.5.17 mirror rollback
#   ./install-ls.sh --version 3.5.17 --allow-mirror
#   ./install-ls.sh --file /path/to/bin      # install a local binary
#   ./install-ls.sh /path/to/bin             # same
#   ./install-ls.sh --url <https-url> --sha256 <hex> [--allowed-host <host>]...
#
# Environment overrides:
#   WINDSURFAPI_LS_VERSION=3.10.67           # same as --version
#   WINDSURFAPI_LS_CHANNEL=stable|next       # manifest channel (default stable)
#   WINDSURFAPI_LS_MANIFEST_URL=<url|path>   # manifest override
#   WINDSURFAPI_LS_PINS=/path/to/ls-pins.json
#   WINDSURFAPI_LS_ALLOW_MIRROR=1            # permit mirror pins (3.5.17)
#   WINDSURFAPI_LS_ALLOW_UNPINNED=1          # permit versions absent from pins
#   WINDSURFAPI_LS_PLATFORM=linux-x64|linux-arm64|darwin-arm64|darwin-x64
#   LS_INSTALL_PATH=/path/to/binary          # install target
#   LS_INSTALL_STAGE_PATH=/path/to/staging   # internal: stage before publish
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
LS_VERSION="${WINDSURFAPI_LS_VERSION:-}"
LS_CHANNEL="${WINDSURFAPI_LS_CHANNEL:-stable}"
LS_MANIFEST="${WINDSURFAPI_LS_MANIFEST_URL:-}"
LS_PINS="${WINDSURFAPI_LS_PINS:-$SCRIPT_DIR/ls-pins.json}"
ALLOW_MIRROR="${WINDSURFAPI_LS_ALLOW_MIRROR:-0}"
ALLOW_UNPINNED="${WINDSURFAPI_LS_ALLOW_UNPINNED:-0}"
PLATFORM_OVERRIDE="${WINDSURFAPI_LS_PLATFORM:-}"
MIRROR_BASE="https://github.com/dwgx/windsurf-ls-release/releases/download"
# Test/ops hook: a fake curl can be pointed at this path without changing
# PATH (Git Bash prepends its own mingw64/bin, so PATH prepending is not
# reliable on Windows). Defaults to the system curl.
CURL_BIN="${WINDSURFAPI_LS_CURL:-curl}"

DRY_RUN=0
ROLLBACK=0
INPUT_FILE=""
INPUT_URL=""
INPUT_SHA=""
# Space-separated host allowlist for download/redirect hops. Empty means
# "stay on the host of the initial URL" (strict same-host redirect policy).
ALLOWED_HOSTS=""

log() { echo -e "\033[1;34m==>\033[0m $*"; }
err() { echo -e "\033[1;31m!!\033[0m  $*" >&2; }

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
}

# Git Bash/MSYS runs POSIX paths, but the Windows curl/tar/unzip/gzip binaries
# need native paths. Mixed mode (C:/...) works for both. On Linux/macOS
# cygpath is absent and this is a no-op.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

# GNU tar treats a C:/... argument as a remote host. Convert target paths
# back to POSIX form for MSYS tar/unzip/gzip on Git Bash.
posix_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s' "$1"
  fi
}

sha256_file() {
  # GNU coreutils prefixes the digest with a literal backslash when the file
  # name contains a backslash (Windows paths: C:\...). Strip it so callers
  # always compare 64 hex characters.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}' | sed 's/^\\//'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}' | sed 's/^\\//'
  elif command -v node >/dev/null 2>&1; then
    node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("sha256");f.createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>process.stdout.write(h.digest("hex")+"\n")).on("error",e=>{console.error(e.message);process.exit(1)})' "$(native_path "$1")"
  else
    return 127
  fi
}

# Authority (host[:port]) of an absolute URL, without userinfo/path/query.
url_authority() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  rest="${rest%%#*}"
  printf '%s' "${rest##*@}"
}

# Lowercase hostname of an absolute URL, without port/brackets.
url_host() {
  local authority
  authority="$(url_authority "$1")"
  if [[ "$authority" == \[*\]* ]]; then
    authority="${authority#\[}"
    authority="${authority%%\]*}"
  else
    authority="${authority%%:*}"
  fi
  printf '%s' "$authority" | tr '[:upper:]' '[:lower:]'
}

host_in_list() {
  local host="$1"
  local list="$2"
  local candidate
  for candidate in $list; do
    [[ "$host" == "$candidate" ]] && return 0
  done
  return 1
}

# Resolve a Location header against the URL that produced it (absolute,
# protocol-relative, root-relative, query-only and path-relative forms).
resolve_redirect() {
  local base="$1"
  local location="$2"
  case "$location" in
    https://*) printf '%s' "$location" ;;
    //*) printf '%s:%s' "${base%%:*}" "$location" ;;
    /*) printf '%s://%s%s' "${base%%://*}" "$(url_authority "$base")" "$location" ;;
    \?*) printf '%s%s' "${base%%\?*}" "$location" ;;
    *)
      local origin="${base%%://*}://$(url_authority "$base")"
      local rest="${base#*://}"
      rest="/${rest#*/}"
      rest="${rest%%\?*}"
      local dir="${rest%/*}"
      [[ "$dir" == "/" ]] && dir=""
      printf '%s%s/%s' "$origin" "$dir" "$location"
      ;;
  esac
}

# Download to $dest. When allowed_hosts is non-empty every hop (initial URL
# and each redirect Location) must use one of those exact hosts. When empty,
# redirects may not leave the initial URL's host. curl is invoked with
# --max-redirs 0 and each 3xx is followed here, so a redirect is validated
# BEFORE any bytes from the next host are fetched. This closes the old
# `curl -L` behaviour where an allowlisted github.com URL could bounce to an
# arbitrary host and still be installed.
download() {
  local url="$1"
  local dest="$2"
  local allowed_hosts="${3:-$ALLOWED_HOSTS}"
  case "$url" in
    file://*)
      local p="${url#file://}"
      # Windows file URLs look like file:///C:/...; Git Bash wants /c/... or C:/...
      case "$p" in
        /[A-Za-z]:/*) p="${p#/}" ;;
      esac
      if [[ ! -f "$p" ]]; then
        err "Local archive not found: $p"
        return 1
      fi
      cp -f "$p" "$dest"
      ;;
    https://*)
      local current="$url"
      local initial_host
      initial_host="$(url_host "$url")"
      local hops=0
      local max_hops=5
      local header_file="$WORK_DIR/download-headers.$$"
      while :; do
        local host
        host="$(url_host "$current")"
        if [[ -z "$host" ]]; then
          err "Invalid download URL: $current"
          return 1
        fi
        if [[ -n "$allowed_hosts" ]]; then
          if ! host_in_list "$host" "$allowed_hosts"; then
            err "Download host not allowed: $host (permitted: $allowed_hosts)"
            return 1
          fi
        elif [[ "$host" != "$initial_host" ]]; then
          err "Refusing redirect to a different host: $host (initial: $initial_host)"
          return 1
        fi
        : > "$header_file"
        local code
        if ! code="$("$CURL_BIN" -S --progress-bar --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
          --max-time 900 --max-filesize 600000000 --max-redirs 0 \
          -D "$header_file" -o "$dest" -w '%{http_code}' "$current")"; then
          err "Download failed: $current"
          return 1
        fi
        case "$code" in
          2??)
            rm -f "$header_file"
            return 0
            ;;
          301|302|303|307|308)
            local location
            location="$(awk 'BEGIN{IGNORECASE=1} /^[Ll]ocation:/{sub(/^[^:]*:[[:space:]]*/,""); sub(/\r$/,""); print; exit}' "$header_file")"
            if [[ -z "$location" ]]; then
              err "Redirect without a Location header: $current"
              return 1
            fi
            hops=$((hops + 1))
            if [[ "$hops" -gt "$max_hops" ]]; then
              err "Too many redirects (limit $max_hops): $url"
              return 1
            fi
            current="$(resolve_redirect "$current" "$location")"
            ;;
          *)
            err "Download failed with HTTP $code: $current"
            return 1
            ;;
        esac
      done
      ;;
    *)
      err "Refusing non-https download URL: $url"
      return 1
      ;;
  esac
}

# ─── Argument parsing ──────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ -n "${2:-}" ]] || { err "--version needs a value"; exit 2; }
      LS_VERSION="$2"; shift 2 ;;
    --channel)
      [[ -n "${2:-}" ]] || { err "--channel needs a value"; exit 2; }
      LS_CHANNEL="$2"; shift 2 ;;
    --manifest)
      [[ -n "${2:-}" ]] || { err "--manifest needs a value"; exit 2; }
      LS_MANIFEST="$2"; shift 2 ;;
    --pins)
      [[ -n "${2:-}" ]] || { err "--pins needs a value"; exit 2; }
      LS_PINS="$2"; shift 2 ;;
    --platform)
      [[ -n "${2:-}" ]] || { err "--platform needs a value"; exit 2; }
      PLATFORM_OVERRIDE="$2"; shift 2 ;;
    --file)
      [[ -n "${2:-}" ]] || { err "--file needs a value"; exit 2; }
      INPUT_FILE="$2"; shift 2 ;;
    --url)
      [[ -n "${2:-}" ]] || { err "--url needs a value"; exit 2; }
      INPUT_URL="$2"; shift 2 ;;
    --sha256)
      [[ -n "${2:-}" ]] || { err "--sha256 needs a value"; exit 2; }
      INPUT_SHA="$2"; shift 2 ;;
    --allowed-host)
      [[ -n "${2:-}" ]] || { err "--allowed-host needs a value"; exit 2; }
      ALLOWED_HOSTS="${ALLOWED_HOSTS:+$ALLOWED_HOSTS }$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; ALLOW_MIRROR=1; shift ;;
    --allow-mirror) ALLOW_MIRROR=1; shift ;;
    --allow-unpinned) ALLOW_UNPINNED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      err "Unknown option: $1"; usage >&2; exit 2 ;;
    *)
      if [[ -f "$1" ]]; then
        INPUT_FILE="$1"; shift
      else
        err "Unknown argument: $1"; usage >&2; exit 2
      fi
      ;;
  esac
done

if [[ -n "$INPUT_FILE" && -n "$INPUT_URL" ]]; then
  err "--file and --url are mutually exclusive"; exit 2
fi
if [[ "$ROLLBACK" == "1" && -n "$LS_VERSION" ]]; then
  err "--rollback and --version are mutually exclusive"; exit 2
fi

MODE="manifest"
if [[ -n "$INPUT_FILE" ]]; then
  MODE="file"
elif [[ -n "$INPUT_URL" ]]; then
  MODE="url"
fi

if [[ -n "$INPUT_SHA" ]]; then
  INPUT_SHA="$(printf '%s' "$INPUT_SHA" | tr 'A-F' 'a-f')"
  if [[ ! "$INPUT_SHA" =~ ^[0-9a-f]{64}$ ]]; then
    err "--sha256 must be 64 hex characters"; exit 2
  fi
fi

# ─── Platform detection ────────────────────────────────
if [[ -n "$PLATFORM_OVERRIDE" ]]; then
  TARGET_ID="$PLATFORM_OVERRIDE"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64)  TARGET_ID='linux-x64' ;;
        aarch64|arm64) TARGET_ID='linux-arm64' ;;
        *) err "Unsupported Linux arch: $arch"; exit 1 ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) TARGET_ID='darwin-x64' ;;
        arm64)  TARGET_ID='darwin-arm64' ;;
        *) err "Unsupported macOS arch: $arch"; exit 1 ;;
      esac
      ;;
    *)
      err "Unsupported OS: $os (only Linux and macOS are supported)"
      exit 1
      ;;
  esac
fi

case "$TARGET_ID" in
  linux-x64)
    ASSET='language_server_linux_x64'
    DEFAULT_PATH="/opt/windsurf/${ASSET}"
    MEMBER_PATH_DEFAULT='Devin/resources/app/extensions/windsurf/bin/language_server_linux_x64'
    COMPRESSION_DEFAULT='tar.gz'
    ;;
  linux-arm64)
    ASSET='language_server_linux_arm'
    DEFAULT_PATH="/opt/windsurf/${ASSET}"
    MEMBER_PATH_DEFAULT=''
    COMPRESSION_DEFAULT=''
    ;;
  darwin-arm64)
    ASSET='language_server_macos_arm'
    DEFAULT_PATH="$HOME/.windsurf/${ASSET}"
    MEMBER_PATH_DEFAULT='Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm'
    COMPRESSION_DEFAULT='zip'
    ;;
  darwin-x64)
    ASSET='language_server_macos_x64'
    DEFAULT_PATH="$HOME/.windsurf/${ASSET}"
    MEMBER_PATH_DEFAULT='Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_x64'
    COMPRESSION_DEFAULT='zip'
    ;;
  *)
    err "Unsupported target: $TARGET_ID"
    exit 1
    ;;
esac

# LS_INSTALL_STAGE_PATH lets the dashboard download/verify a custom binary in
# a sibling staging file; the route publishes it with rename after its own
# digest check. Normal installs have no stage path and write TARGET directly.
TARGET="${LS_INSTALL_STAGE_PATH:-${LS_INSTALL_PATH:-$DEFAULT_PATH}}"
log "Platform: $TARGET_ID → asset=$ASSET"
log "Target:   $TARGET"

if [[ "$MODE" == "manifest" && -z "$MEMBER_PATH_DEFAULT" ]]; then
  err "Upstream does not ship a language server for $TARGET_ID."
  err "Supported upstream targets: linux-x64, darwin-arm64, darwin-x64."
  err "Copy the binary from a desktop install and use: bash install-ls.sh --file <path>"
  exit 1
fi

# ─── Temp files ────────────────────────────────────────
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/windsurfapi-ls.XXXXXX")"
TMP_TARGET="${TARGET}.new.$$"
SIDECAR="${TARGET}.version.json"
TMP_SIDECAR="${SIDECAR}.new.$$"
# Keep the 345 MB archive on the target's filesystem, not in a possibly small
# /tmp. The final binary is written to a sibling temp path so the mv is an
# atomic rename; a running LS keeps its old inode and the next exec gets the
# new binary without ETXTBSY ("Text file busy").
TMP_ARCHIVE="${TARGET}.archive.$$"
TMP_MANIFEST="$WORK_DIR/manifest.json"
cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$TMP_TARGET" "$TMP_SIDECAR" "$TMP_ARCHIVE"
}
trap cleanup EXIT

INSTALLED_SHA=''

# ─── Manual modes ──────────────────────────────────────
if [[ "$MODE" == "file" ]]; then
  if [[ ! -f "$INPUT_FILE" ]]; then
    err "File not found: $INPUT_FILE"; exit 1
  fi
  actual="$(sha256_file "$INPUT_FILE")" || { err "No sha256 tool available (sha256sum, shasum, or node is required)"; exit 1; }
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "source=file"
    echo "file=$INPUT_FILE"
    echo "sha256=$actual"
    echo "install_path=$TARGET"
    exit 0
  fi
  mkdir -p "$(dirname "$TARGET")"
  log "Installing from local file: $INPUT_FILE"
  cp -f "$INPUT_FILE" "$TMP_TARGET"
  if [[ -n "$INPUT_SHA" && "$actual" != "$INPUT_SHA" ]]; then
    err "Checksum mismatch for $INPUT_FILE"
    err "Expected: $INPUT_SHA"
    err "Actual:   $actual"
    exit 1
  fi
  INSTALLED_SHA="$actual"
elif [[ "$MODE" == "url" ]]; then
  if [[ "$INPUT_URL" != https://* ]]; then
    err "Only https URLs are supported: $INPUT_URL"; exit 1
  fi
  # A05: a custom URL has no pin/manifest trust anchor, so the operator must
  # supply the expected digest. Refuse before any network I/O or filesystem
  # write. The old flow printed a warning and installed unverified bytes.
  if [[ -z "$INPUT_SHA" ]]; then
    err "--url requires --sha256 <64 hex characters>; refusing an unverified download"
    exit 2
  fi
  # Standalone GitHub release URLs legitimately redirect to GitHub's asset
  # CDNs. Keep that convenience without weakening the per-hop check: only
  # these fixed GitHub hosts are auto-allowed, and every other URL keeps the
  # strict same-host redirect policy.
  if [[ -z "$ALLOWED_HOSTS" ]]; then
    case "$(url_host "$INPUT_URL")" in
      github.com) ALLOWED_HOSTS="github.com objects.githubusercontent.com release-assets.githubusercontent.com api.github.com" ;;
    esac
  fi
  if [[ -n "$ALLOWED_HOSTS" ]]; then
    input_host="$(url_host "$INPUT_URL")"
    if ! host_in_list "$input_host" "$ALLOWED_HOSTS"; then
      err "Download host not allowed: $input_host (permitted: $ALLOWED_HOSTS)"
      exit 2
    fi
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "source=url"
    echo "url=$INPUT_URL"
    echo "sha256=$INPUT_SHA"
    echo "install_path=$TARGET"
    exit 0
  fi
  mkdir -p "$(dirname "$TARGET")"
  log "Downloading from: $INPUT_URL"
  download "$INPUT_URL" "$TMP_TARGET"
  actual="$(sha256_file "$TMP_TARGET")" || { err "No sha256 tool available (sha256sum, shasum, or node is required)"; exit 1; }
  if [[ "$actual" != "$INPUT_SHA" ]]; then
    err "Checksum mismatch for $INPUT_URL"
    err "Expected: $INPUT_SHA"
    err "Actual:   $actual"
    exit 1
  fi
  log "Binary sha256 verified: $actual"
  INSTALLED_SHA="$actual"
else
  # ─── Manifest mode ───────────────────────────────────
  if [[ -z "$LS_MANIFEST" ]]; then
    case "$LS_CHANNEL" in
      stable) LS_MANIFEST='https://windsurf-stable.codeium.com/api/versions' ;;
      next)   LS_MANIFEST='https://windsurf-next.codeium.com/api/versions' ;;
      *) err "Unsupported channel: $LS_CHANNEL (stable|next)"; exit 1 ;;
    esac
  fi

  command -v node >/dev/null 2>&1 || {
    err "Node.js is required to read the release manifest and pins"; exit 1
  }

  MANIFEST_IS_LOCAL=0
  MIRROR_PIN=0
  if [[ "$ROLLBACK" == "1" ]]; then
    MIRROR_PIN=1
  elif [[ -n "$LS_VERSION" && -f "$LS_PINS" ]]; then
    MIRROR_PIN="$(node -e '
const fs = require("fs");
const [pinsFile, target, version] = process.argv.slice(1);
let pins;
try { pins = JSON.parse(fs.readFileSync(pinsFile, "utf8")); } catch { process.stdout.write("0"); process.exit(0); }
const releases = (pins && Array.isArray(pins.releases)) ? pins.releases : [];
const hit = releases.find(r => r && r.version === version && r.source === "mirror" && r.targets && r.targets[target]);
process.stdout.write(hit ? "1" : "0");
' "$(native_path "$LS_PINS")" "$TARGET_ID" "$LS_VERSION")" || MIRROR_PIN=0
  fi

  if [[ "$MIRROR_PIN" == "1" ]]; then
    log "Rollback pin selected; skipping the upstream manifest"
  elif [[ "$LS_MANIFEST" == https://* ]]; then
    log "Fetching manifest: $LS_MANIFEST"
    if ! curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 --max-filesize 8388608 \
      -o "$TMP_MANIFEST" "$LS_MANIFEST"; then
      err "Could not fetch the release manifest: $LS_MANIFEST"
      err "Refusing to fall back to the stale mirror. Use --rollback for the pinned 3.5.17 mirror."
      exit 1
    fi
  elif [[ "$LS_MANIFEST" == http://* ]]; then
    err "Refusing plain http manifest URL: $LS_MANIFEST"; exit 1
  elif [[ -f "$LS_MANIFEST" ]]; then
    cp -f "$LS_MANIFEST" "$TMP_MANIFEST"
    MANIFEST_IS_LOCAL=1
  else
    err "Manifest not found: $LS_MANIFEST"; exit 1
  fi

  plan="$(node - "$(native_path "$TMP_MANIFEST")" "$(native_path "$LS_PINS")" "$TARGET_ID" "$LS_VERSION" "$LS_CHANNEL" \
    "$ROLLBACK" "$ALLOW_UNPINNED" "$ALLOW_MIRROR" "$MANIFEST_IS_LOCAL" "$MIRROR_BASE" <<'NODE'
const fs = require('fs');
const path = require('path');

const [
  manifestFile, pinsFile, target, requested, channel, rollbackStr,
  allowUnpinnedStr, allowMirrorStr, manifestIsLocalStr, mirrorBase,
] = process.argv.slice(2);

const rollback = rollbackStr === '1';
const allowUnpinned = allowUnpinnedStr === '1';
const allowMirror = allowMirrorStr === '1';
const manifestIsLocal = manifestIsLocalStr === '1';

const fail = (msg) => { process.stderr.write('install-ls: ' + msg + '\n'); process.exit(1); };
const HEX64 = /^[0-9a-f]{64}$/;
const TARGETS = {
  'linux-x64': { member: 'Devin/resources/app/extensions/windsurf/bin/language_server_linux_x64', compression: 'tar.gz' },
  'darwin-arm64': { member: 'Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm', compression: 'zip' },
  'darwin-x64': { member: 'Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_x64', compression: 'zip' },
};
if (!TARGETS[target]) fail('unsupported target: ' + target);
const spec = TARGETS[target];

let pins = { schemaVersion: 1, releases: [] };
if (fs.existsSync(pinsFile)) {
  let raw;
  try { raw = fs.readFileSync(pinsFile, 'utf8'); } catch (e) { fail('cannot read pins ' + pinsFile + ': ' + e.message); }
  try { pins = JSON.parse(raw); } catch (e) { fail('cannot parse pins ' + pinsFile + ': ' + e.message); }
  if (!pins || pins.schemaVersion !== 1 || !Array.isArray(pins.releases)) fail('invalid pins file: ' + pinsFile);
} else if (!allowUnpinned) {
  fail('pins file not found: ' + pinsFile + ' (pass --allow-unpinned to bypass)');
}
const releases = pins.releases || [];
const pinFor = (v) => releases.find(r => r && r.version === v && r.targets && r.targets[target]);

function loadManifest() {
  let raw;
  try { raw = fs.readFileSync(manifestFile, 'utf8'); } catch (e) { fail('cannot read manifest: ' + e.message); }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { fail('manifest is not valid JSON: ' + e.message); }
  if (!Array.isArray(arr) || arr.length === 0) fail('manifest is not a non-empty array');
  return arr;
}

const entryFor = (x) => (x && x.manifest && x.manifest[target] && typeof x.manifest[target] === 'object') ? x.manifest[target] : null;
const verOf = (x) => {
  const m = entryFor(x);
  return String((x && x.version) || (m && m.windsurfVersion) || '');
};
const score = (x) => Math.max(0, ...Object.values((x && x.manifest) || {}).map(m => Number(m && m.timestamp) || 0));

function checkUrl(url, pinned) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('invalid download URL: ' + url); }
  if (parsed.protocol === 'file:') {
    if (!manifestIsLocal) fail('file:// archive URLs are only allowed with a local manifest');
    return;
  }
  if (parsed.protocol !== 'https:') fail('refusing non-https download URL: ' + url);
  if (!pinned) {
    const host = parsed.hostname;
    if (host !== 'windsurf-stable.codeiumdata.com' && host !== 'windsurf-next.codeiumdata.com') {
      fail('unpinned archive host not allowed: ' + host);
    }
  }
}

function emit(source, version, commit, url, archiveSha, member, binarySha, compression, archiveName, releaseTag, pinned, ch) {
  const fields = [source, version, commit, url, archiveSha, member, binarySha, compression, archiveName, releaseTag, pinned ? '1' : '0', ch];
  for (const value of fields) {
    if (/[|\r\n]/.test(String(value))) fail('resolved field contains a forbidden delimiter');
  }
  process.stdout.write(fields.join('|') + '\n');
}

let chosenPin = null;
let chosenEntry = null;
let source = 'upstream';

if (rollback) {
  const mirrors = releases.filter(r => r && r.source === 'mirror' && r.targets && r.targets[target]);
  mirrors.sort((a, b) => String(b.releasedAt || '').localeCompare(String(a.releasedAt || '')));
  if (!mirrors.length) fail('no mirror rollback pin for ' + target + ' in ' + pinsFile);
  chosenPin = mirrors[0];
  source = 'mirror';
} else if (requested) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(requested)) fail('invalid version: ' + requested);
  const p = pinFor(requested);
  if (p) {
    chosenPin = p;
    source = p.source === 'mirror' ? 'mirror' : 'upstream';
  } else if (allowUnpinned) {
    source = 'upstream';
  } else {
    fail('version ' + requested + ' is not pinned in ' + pinsFile + ' (pass --allow-unpinned to bypass)');
  }
}

if (source === 'mirror') {
  if (!allowMirror) fail('version ' + chosenPin.version + ' is a mirror rollback pin; re-run with --allow-mirror (or --rollback)');
  const t = chosenPin.targets[target];
  if (!t || typeof t !== 'object') fail('mirror pin has no ' + target + ' target');
  if (!HEX64.test(t.archiveSha256 || '')) fail('mirror pin ' + chosenPin.version + ' has no archive sha256 for ' + target);
  if (!HEX64.test(t.binarySha256 || '')) fail('mirror pin ' + chosenPin.version + ' has no binary sha256 for ' + target);
  if (typeof t.archive !== 'string' || !t.archive) fail('mirror pin ' + chosenPin.version + ' has no archive name for ' + target);
  if (typeof chosenPin.releaseTag !== 'string' || !/^v[0-9A-Za-z._+-]+$/.test(chosenPin.releaseTag)) fail('mirror pin ' + chosenPin.version + ' has no valid releaseTag');
  const url = mirrorBase + '/' + chosenPin.releaseTag + '/' + t.archive;
  emit('mirror', chosenPin.version, chosenPin.commit || '', url, t.archiveSha256, '', t.binarySha256, t.compression || 'gzip', t.archive, chosenPin.releaseTag, true, chosenPin.channel || channel);
  process.exit(0);
}

const manifest = loadManifest();
const candidates = manifest.filter(x => entryFor(x));
if (!candidates.length) fail('manifest has no ' + target + ' entries');

if (requested && chosenPin) {
  const x = candidates.find(c => verOf(c) === requested);
  if (!x) fail('upstream manifest no longer lists ' + requested + ' for ' + target);
  const t = chosenPin.targets[target];
  const m = entryFor(x);
  if (!HEX64.test(t.archiveSha256 || '')) fail('pin ' + requested + ' has no archive sha256 for ' + target);
  if (!HEX64.test(t.binarySha256 || '')) fail('pin ' + requested + ' has no binary sha256 for ' + target);
  if (m.sha256hash !== t.archiveSha256) fail('manifest archive sha256 for ' + requested + '/' + target + ' does not match the pin');
  if (chosenPin.commit && m.version !== chosenPin.commit) fail('manifest commit for ' + requested + '/' + target + ' does not match the pin');
  if (t.member && t.member !== spec.member) fail('pin member path for ' + requested + '/' + target + ' does not match the expected path');
  chosenEntry = x;
} else if (requested) {
  const x = candidates.find(c => verOf(c) === requested);
  if (!x) fail('upstream manifest has no ' + requested + ' entry for ' + target);
  chosenEntry = x;
} else {
  const pinnedUpstream = releases.filter(r => r && r.source !== 'mirror' && (r.channel || 'stable') === channel && r.targets && r.targets[target]);
  const confirmed = [];
  let mismatch = '';
  for (const r of pinnedUpstream) {
    const x = candidates.find(c => verOf(c) === r.version);
    if (!x) continue;
    const t = r.targets[target];
    const m = entryFor(x);
    if (!HEX64.test(t.archiveSha256 || '') || !HEX64.test(t.binarySha256 || '')) {
      mismatch = 'pin ' + r.version + ' is incomplete for ' + target;
      continue;
    }
    if (m.sha256hash !== t.archiveSha256) {
      mismatch = 'manifest archive sha256 for ' + r.version + '/' + target + ' does not match the pin';
      continue;
    }
    if (r.commit && m.version !== r.commit) {
      mismatch = 'manifest commit for ' + r.version + '/' + target + ' does not match the pin';
      continue;
    }
    confirmed.push({ r, x });
  }
  if (confirmed.length) {
    confirmed.sort((a, b) => score(b.x) - score(a.x));
    chosenPin = confirmed[0].r;
    chosenEntry = confirmed[0].x;
  } else if (allowUnpinned) {
    // Explicit escape hatch: no pinned release matched, so take the newest
    // manifest entry. Archive verification still happens in bash.
    chosenEntry = candidates.slice().sort((a, b) => score(b) - score(a))[0];
  } else if (mismatch) {
    fail(mismatch);
  } else if (!pinnedUpstream.length) {
    fail('no pinned upstream release for ' + target + ' in ' + pinsFile);
  } else {
    fail('no pinned release for ' + target + ' matches the upstream manifest (pins: ' + pinnedUpstream.map(r => r.version).join(', ') + ')');
  }
}

const m = entryFor(chosenEntry);
const version = verOf(chosenEntry);
const commit = String(m.version || '');
const url = String(m.url || '');
const archiveSha = String(m.sha256hash || '');
if (!HEX64.test(archiveSha)) fail('manifest entry ' + version + ' has an invalid sha256hash');
const t = chosenPin ? (chosenPin.targets[target] || {}) : {};
if (chosenPin) {
  if (t.archiveSha256 !== archiveSha) fail('pin/manifest archive sha256 mismatch for ' + version + '/' + target);
  if (!HEX64.test(t.binarySha256 || '')) fail('pin ' + version + ' has no binary sha256 for ' + target);
  if (t.member && t.member !== spec.member) fail('pin member path for ' + version + '/' + target + ' does not match the expected path');
}
const pinned = !!chosenPin;
if (!pinned && !allowUnpinned) fail('refusing unpinned release ' + version);
checkUrl(url, pinned);
const archiveName = (t.archive && String(t.archive)) || path.basename(new URL(url).pathname) || 'archive';
emit('upstream', version, commit, url, archiveSha, spec.member, pinned ? t.binarySha256 : '', spec.compression, archiveName, '', pinned, chosenPin && chosenPin.channel ? chosenPin.channel : channel);
NODE
)" || { err "Could not resolve a language server release"; exit 1; }

  IFS='|' read -r SOURCE VERSION COMMIT URL ARCHIVE_SHA MEMBER_PATH BINARY_SHA COMPRESSION ARCHIVE_NAME RELEASE_TAG PINNED CHANNEL <<< "$plan"

  if [[ -z "$VERSION" || -z "$URL" || -z "$ARCHIVE_SHA" ]]; then
    err "Resolver returned an incomplete plan"; exit 1
  fi
  if [[ ! "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]]; then
    err "Resolver returned an invalid archive sha256"; exit 1
  fi
  if [[ -z "$COMPRESSION" ]]; then
    err "Resolver returned no archive type for $TARGET_ID"; exit 1
  fi
  if [[ "$COMPRESSION" != "gzip" && -z "$MEMBER_PATH" ]]; then
    err "Resolver returned no archive member for $TARGET_ID"; exit 1
  fi
  if [[ "$PINNED" == "1" && ! "$BINARY_SHA" =~ ^[0-9a-f]{64}$ ]]; then
    err "Resolver returned an invalid binary sha256"; exit 1
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "version=$VERSION"
    echo "commit=$COMMIT"
    echo "channel=$CHANNEL"
    echo "target=$TARGET_ID"
    echo "source=$SOURCE"
    echo "url=$URL"
    echo "archive=$ARCHIVE_NAME"
    echo "archive_sha256=$ARCHIVE_SHA"
    echo "member=$MEMBER_PATH"
    if [[ -n "$BINARY_SHA" ]]; then
      echo "binary_sha256=$BINARY_SHA"
    else
      echo "binary_sha256=unpinned"
    fi
    echo "pinned=$PINNED"
    echo "install_path=$TARGET"
    exit 0
  fi

  # Manifest mode is already hash-pinned, but redirect hops still get the
  # same host validation as custom URLs. GitHub release downloads legitimately
  # bounce to its asset CDNs; everything else must stay on the initial host.
  manifest_hosts="$(url_host "$URL")"
  case "$manifest_hosts" in
    github.com) manifest_hosts="$manifest_hosts objects.githubusercontent.com release-assets.githubusercontent.com" ;;
  esac
  ALLOWED_HOSTS="$manifest_hosts"
  mkdir -p "$(dirname "$TARGET")"
  log "Installing Windsurf LS $VERSION ($TARGET_ID, $SOURCE)"
  log "Downloading: $URL"
  download "$URL" "$TMP_ARCHIVE"

  log "Verifying archive sha256..."
  actual_archive_sha="$(sha256_file "$TMP_ARCHIVE")" || {
    err "No sha256 tool available (sha256sum, shasum, or node is required)"; exit 1
  }
  if [[ "$actual_archive_sha" != "$ARCHIVE_SHA" ]]; then
    err "Archive checksum mismatch for $ARCHIVE_NAME"
    err "Expected: $ARCHIVE_SHA"
    err "Actual:   $actual_archive_sha"
    exit 1
  fi
  log "Archive sha256 verified: $actual_archive_sha"

  if [[ -n "$MEMBER_PATH" ]]; then
    log "Extracting: $MEMBER_PATH"
  else
    log "Decompressing: $ARCHIVE_NAME"
  fi
  case "$COMPRESSION" in
    tar.gz)
      command -v tar >/dev/null 2>&1 || { err "tar is required to extract $ARCHIVE_NAME"; exit 1; }
      if ! tar -xOf "$(posix_path "$TMP_ARCHIVE")" "$MEMBER_PATH" > "$TMP_TARGET"; then
        err "Could not extract $MEMBER_PATH from $ARCHIVE_NAME"; exit 1
      fi
      ;;
    zip)
      command -v unzip >/dev/null 2>&1 || { err "unzip is required to extract $ARCHIVE_NAME"; exit 1; }
      if ! unzip -p "$(posix_path "$TMP_ARCHIVE")" "$MEMBER_PATH" > "$TMP_TARGET"; then
        err "Could not extract $MEMBER_PATH from $ARCHIVE_NAME"; exit 1
      fi
      ;;
    gzip)
      command -v gzip >/dev/null 2>&1 || { err "gzip is required to decompress $ARCHIVE_NAME"; exit 1; }
      if ! gzip -dc "$(posix_path "$TMP_ARCHIVE")" > "$TMP_TARGET"; then
        err "Could not decompress $ARCHIVE_NAME"; exit 1
      fi
      ;;
    *)
      err "Unsupported archive type: $COMPRESSION"; exit 1 ;;
  esac

  if [[ ! -s "$TMP_TARGET" ]]; then
    err "Extracted binary is empty (member not found: $MEMBER_PATH)"; exit 1
  fi

  actual_bin_sha="$(sha256_file "$TMP_TARGET")" || {
    err "No sha256 tool available (sha256sum, shasum, or node is required)"; exit 1
  }
  if [[ -n "$BINARY_SHA" ]]; then
    if [[ "$actual_bin_sha" != "$BINARY_SHA" ]]; then
      err "Binary checksum mismatch for $ASSET"
      err "Expected: $BINARY_SHA"
      err "Actual:   $actual_bin_sha"
      exit 1
    fi
    log "Binary sha256 verified: $actual_bin_sha"
  else
    log "WARNING: no pinned binary sha256 for $VERSION/$TARGET_ID; computed $actual_bin_sha"
  fi
  INSTALLED_SHA="$actual_bin_sha"
  rm -f "$TMP_ARCHIVE"
fi

# ─── Atomic install ────────────────────────────────────
if [[ "$MODE" == "manifest" ]]; then
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sidecar_json="$(node -e '
const [version, commit, archiveSha, binarySha, url, archive, source, pinned, installedAt] = process.argv.slice(1);
process.stdout.write(JSON.stringify({windsurfVersion: version, commit, archiveSha256: archiveSha, binarySha256: binarySha, downloadUrl: url, archive, resolver: source, pinned: pinned === "1", installedAt}) + "\n");
' "$VERSION" "$COMMIT" "$ARCHIVE_SHA" "$INSTALLED_SHA" "$URL" "$ARCHIVE_NAME" "$SOURCE" "$PINNED" "$installed_at")"
  printf '%s' "$sidecar_json" > "$TMP_SIDECAR"
fi

chmod +x "$TMP_TARGET"
mv -f "$TMP_TARGET" "$TARGET"

if [[ "$MODE" == "manifest" ]]; then
  mv -f "$TMP_SIDECAR" "$SIDECAR"
  log "Wrote metadata: $SIDECAR"
else
  # A local/custom binary has no manifest metadata; do not leave a stale
  # sidecar describing the previous manifest install.
  rm -f "$SIDECAR"
fi

rm -rf "$WORK_DIR"
trap - EXIT

size="$(du -h "$TARGET" | cut -f1)"
sha_short="$(printf '%s' "$INSTALLED_SHA" | cut -c1-16)"
log "Installed: $TARGET ($size, sha256:${sha_short}...)"

if [[ "$TARGET_ID" == darwin-* ]]; then
  log ""
  log "macOS users: set this in your .env:"
  log "  LS_BINARY_PATH=$TARGET"
fi
