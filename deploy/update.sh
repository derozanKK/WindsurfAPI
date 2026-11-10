#!/usr/bin/env bash
# deploy/update.sh — one-click Docker update for WindsurfAPI.
#
# Pull (or build) a new image, recreate only the application container, wait
# for GET /health, and automatically restore the image that was running before
# when the new one fails. The data volume is never touched: this script never
# runs `docker compose down`, never passes `-v`/`--volumes`, and never removes
# containers or volumes.
#
# Usage:
#   bash deploy/update.sh                  # pull ghcr.io/dwgx/windsurf-api:latest
#   bash deploy/update.sh --tag 3.9.52     # pull a pinned release tag
#   bash deploy/update.sh --image REF      # pull an arbitrary image reference
#   bash deploy/update.sh --build          # rebuild from this checkout instead
#   bash deploy/update.sh --rollback       # restore the last rollback point
#   bash deploy/update.sh --dry-run        # print the plan; change nothing
#
# Options:
#   --tag <tag>        Pin ghcr.io/dwgx/windsurf-api:<tag> (v prefix optional).
#   --image <ref>      Full image reference, e.g. a fork or a digest.
#   --build            `docker compose build` from this checkout, then update.
#   --rollback         Recreate the app from the saved rollback point and wait
#                      for /health. Does not pull.
#   --timeout <secs>   Health gate timeout (default 120; 0 = one attempt).
#   --dry-run          Preflight + print the exact plan. No pull, no build,
#                      no tag, no recreate, no state writes.
#   -h, --help         Show this help.
#
# Exit codes:
#   0  update succeeded and /health passed (or --dry-run preflight passed)
#   1  update failed; the previous image is running again (or was untouched)
#   2  update failed and the rollback also failed — manual intervention needed
#
# Environment (all optional):
#   WINDSURFAPI_IMAGE           Image reference; also read by docker-compose.yml.
#   WINDSURFAPI_COMPOSE_FILE    Compose file (default <repo>/docker-compose.yml).
#   WINDSURFAPI_PROJECT_DIR     Compose project directory, used to resolve
#                               relative bind mounts (default <repo>).
#   WINDSURFAPI_SERVICE         App service name (default windsurf-api).
#   WINDSURFAPI_LB_SERVICE      Load-balancer service for the /health URL
#                               (default nginx; falls back to the app container).
#   WINDSURFAPI_UPDATE_STATE_DIR  Rollback point + lock directory
#                               (default <repo>/.docker-data/update).
#   WINDSURFAPI_HEALTH_TIMEOUT  Seconds to wait for /health (default 120).
#   WINDSURFAPI_HEALTH_INTERVAL Seconds between probes (default 2).
#   WINDSURFAPI_DOCKER          Docker binary (default docker).
#
# The script never reads or prints .env, registry credentials, API keys or
# account data. Registry login is whatever `docker` already has.
#
# See docs/DOCKER-UPDATE.md for the operator-facing walkthrough.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

DEFAULT_IMAGE_REPO="ghcr.io/dwgx/windsurf-api"
DEFAULT_IMAGE="${DEFAULT_IMAGE_REPO}:latest"
COMPOSE_FILE="${WINDSURFAPI_COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
PROJECT_DIR="${WINDSURFAPI_PROJECT_DIR:-$ROOT_DIR}"
SERVICE="${WINDSURFAPI_SERVICE:-windsurf-api}"
LB_SERVICE="${WINDSURFAPI_LB_SERVICE:-nginx}"
STATE_DIR="${WINDSURFAPI_UPDATE_STATE_DIR:-$ROOT_DIR/.docker-data/update}"
STATE_FILE="$STATE_DIR/rollback-point.env"
SUCCESS_FILE="$STATE_DIR/last-success.env"
LOCK_DIR="$STATE_DIR/lock"
HEALTH_TIMEOUT="${WINDSURFAPI_HEALTH_TIMEOUT:-120}"
HEALTH_INTERVAL="${WINDSURFAPI_HEALTH_INTERVAL:-2}"
PROBE_TIMEOUT="${WINDSURFAPI_PROBE_TIMEOUT:-5}"
DOCKER_BIN="${WINDSURFAPI_DOCKER:-docker}"

MODE="pull"
TAG=""
IMAGE_OVERRIDE=""
DRY_RUN=0

# Captured before the update; used by the rollback path.
CID=""
OLD_ID=""
OLD_REF=""
ACTIVE=""
COMPOSE_IMAGE=""
FIRST_INSTALL=0

PROBE_BODY=""

usage() {
  sed -n '2,/^set -uo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

log() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# One definition of the compose invocation, shared by `compose` and the
# exec-fallback probe (which must run it under a timeout).
COMPOSE_CMD=("$DOCKER_BIN" compose --project-directory "$PROJECT_DIR" -f "$COMPOSE_FILE")

compose() {
  "${COMPOSE_CMD[@]}" "$@"
}

compose_display() {
  printf 'docker compose --project-directory %s -f %s' "$PROJECT_DIR" "$COMPOSE_FILE"
}

validate_tag() {
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
    || die "invalid tag '$1' (Docker tags allow letters, digits, '_', '.', '-')"
}

validate_image_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] \
    || die "invalid image reference '$1'"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --pull) MODE="pull" ;;
      --build) MODE="build" ;;
      --rollback) MODE="rollback" ;;
      --tag)
        [ $# -ge 2 ] || die "--tag requires a value"
        [ -n "$2" ] || die "--tag requires a non-empty value"
        TAG="$2"; shift
        ;;
      --tag=*)
        TAG="${1#*=}"
        [ -n "$TAG" ] || die "--tag requires a non-empty value"
        ;;
      --image)
        [ $# -ge 2 ] || die "--image requires a value"
        [ -n "$2" ] || die "--image requires a non-empty value"
        IMAGE_OVERRIDE="$2"; shift
        ;;
      --image=*)
        IMAGE_OVERRIDE="${1#*=}"
        [ -n "$IMAGE_OVERRIDE" ] || die "--image requires a non-empty value"
        ;;
      --timeout)
        [ $# -ge 2 ] || die "--timeout requires a value"
        HEALTH_TIMEOUT="$2"; shift
        ;;
      --timeout=*) HEALTH_TIMEOUT="${1#*=}" ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1' (try --help)" ;;
    esac
    shift
  done

  [ -n "$TAG" ] && [ -n "$IMAGE_OVERRIDE" ] && die "--tag and --image are mutually exclusive"
  if [ "$MODE" = "rollback" ] && { [ -n "$TAG" ] || [ -n "$IMAGE_OVERRIDE" ]; }; then
    die "--rollback cannot be combined with --tag/--image"
  fi
  [[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout must be a non-negative integer"
  [[ "$HEALTH_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "WINDSURFAPI_HEALTH_INTERVAL must be a number"
  [[ "$PROBE_TIMEOUT" =~ ^[0-9]+$ ]] || die "WINDSURFAPI_PROBE_TIMEOUT must be an integer"

  if [ -n "$TAG" ]; then
    validate_tag "$TAG"
    # Accept the GitHub release spelling (v3.9.52) but keep tags that merely
    # start with a letter (e.g. "v2-custom" stays "v2-custom").
    if [[ "$TAG" =~ ^v[0-9] ]]; then
      TAG="${TAG#v}"
      validate_tag "$TAG"
    fi
  fi
  [ -n "$IMAGE_OVERRIDE" ] && validate_image_ref "$IMAGE_OVERRIDE"
}

preflight() {
  command -v "$DOCKER_BIN" >/dev/null 2>&1 \
    || die "docker is not installed or not on PATH (looked for '$DOCKER_BIN')"
  [ -f "$COMPOSE_FILE" ] \
    || die "compose file not found: $COMPOSE_FILE (set WINDSURFAPI_COMPOSE_FILE)"
  compose version >/dev/null 2>&1 \
    || die "docker compose v2 is required ('docker compose version' failed)"
  "$DOCKER_BIN" info >/dev/null 2>&1 \
    || die "cannot reach the Docker daemon (start Docker or fix socket permissions)"
  compose config --quiet >/dev/null 2>&1 \
    || die "docker compose rejected $COMPOSE_FILE"
  if { [ -n "$TAG" ] || [ -n "$IMAGE_OVERRIDE" ]; } \
     && ! grep -q 'WINDSURFAPI_IMAGE' "$COMPOSE_FILE" 2>/dev/null; then
    die "$COMPOSE_FILE hardcodes image:; --tag/--image need the \${WINDSURFAPI_IMAGE:-...} form"
  fi
}

acquire_lock() {
  mkdir -p "$STATE_DIR" || die "cannot create state directory $STATE_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local pid=""
  if [ -r "$LOCK_DIR/pid" ]; then
    read -r pid < "$LOCK_DIR/pid" || true
  else
    # A crash between `mkdir` and writing the pid leaves no proof of death.
    # Fail closed instead of stealing a lock that may be live.
    die "lock exists without an owner pid; inspect and remove $LOCK_DIR manually"
  fi
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    die "another update is already running (pid $pid, lock $LOCK_DIR)"
  fi

  # The owner is provably gone. Move the stale directory aside atomically so
  # only one contender can recover it.
  local quarantine="$LOCK_DIR.stale-$$-$RANDOM" moved_pid=""
  if ! mv "$LOCK_DIR" "$quarantine" 2>/dev/null; then
    die "could not recover the stale update lock at $LOCK_DIR"
  fi
  if [ -r "$quarantine/pid" ]; then
    read -r moved_pid < "$quarantine/pid" || true
  fi
  if [ "$moved_pid" != "$pid" ]; then
    # Another contender recovered and recreated the lock between our read and
    # the rename. Put it back rather than deleting a live owner's lock.
    mv "$quarantine" "$LOCK_DIR" 2>/dev/null || true
    die "update lock changed while recovering; retry"
  fi
  rm -f "$quarantine/pid"
  rmdir "$quarantine" 2>/dev/null || true
  mkdir "$LOCK_DIR" 2>/dev/null \
    || die "could not create the update lock at $LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

release_lock() {
  [ -d "$LOCK_DIR" ] || return 0
  local pid=""
  if [ -r "$LOCK_DIR/pid" ]; then
    read -r pid < "$LOCK_DIR/pid" || true
  fi
  [ "$pid" = "$$" ] || return 0
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

current_container() {
  compose ps -q "$SERVICE" 2>/dev/null | head -n1
}

inspect_field() {
  "$DOCKER_BIN" inspect --format "$1" "$2" 2>/dev/null || true
}

compose_image() {
  local yaml picked
  yaml="$(compose config 2>/dev/null)" || return 1
  [ -n "$yaml" ] || return 1
  # Resolve the image of THIS service, not "the first image in the file":
  # docker compose config --images lists nginx first, so a fork image without
  # "windsurf" in its name would otherwise be mistaken for the load balancer.
  picked="$(printf '%s\n' "$yaml" | tr -d '\r' | awk -v svc="$SERVICE" '
    $0 == "  " svc ":" { inside = 1; next }
    inside && /^  [^ ].*:$/ { exit }
    inside && /^    image:/ { sub(/^    image:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }
  ')"
  [ -n "$picked" ] || return 1
  printf '%s' "$picked"
}

capture_current() {
  CID="$(current_container)"
  OLD_ID=""
  OLD_REF=""
  if [ -n "$CID" ]; then
    OLD_ID="$(inspect_field '{{.Image}}' "$CID")"
    OLD_REF="$(inspect_field '{{.Config.Image}}' "$CID")"
  else
    FIRST_INSTALL=1
  fi
  COMPOSE_IMAGE="$(compose_image || true)"
}

resolve_active_image() {
  local explicit=0
  if [ -n "$IMAGE_OVERRIDE" ]; then
    ACTIVE="$IMAGE_OVERRIDE"
    explicit=1
  elif [ -n "$TAG" ]; then
    ACTIVE="$DEFAULT_IMAGE_REPO:$TAG"
    explicit=1
  elif [ -n "${WINDSURFAPI_IMAGE:-}" ]; then
    validate_image_ref "$WINDSURFAPI_IMAGE"
    ACTIVE="$WINDSURFAPI_IMAGE"
    explicit=1
  elif [ -n "$OLD_REF" ]; then
    ACTIVE="$OLD_REF"
  elif [ -n "$COMPOSE_IMAGE" ]; then
    ACTIVE="$COMPOSE_IMAGE"
  else
    ACTIVE="$DEFAULT_IMAGE"
  fi
  # Export only when we are overriding Compose or preserving the reference the
  # running container was created from. On a first install with no flags, let
  # Compose resolve its own image (a fork may not use the default repo at all).
  if [ "$explicit" = "1" ] || [ -n "$OLD_REF" ]; then
    export WINDSURFAPI_IMAGE="$ACTIVE"
  fi
}

short_id() {
  local id="$1"
  id="${id#sha256:}"
  printf '%s' "${id:0:12}"
}

write_state() {
  local file="$1" id="$2" ref="$3" extra="${4:-}"
  mkdir -p "$STATE_DIR" || return 1
  {
    printf 'image_id=%s\n' "$id"
    printf 'image_ref=%s\n' "$ref"
    printf 'saved_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    if [ -n "$extra" ]; then
      printf '%s\n' "$extra"
    fi
  } > "$file.tmp" || return 1
  mv "$file.tmp" "$file"
}

read_rollback_point() {
  [ -r "$STATE_FILE" ] || return 1
  ROLLBACK_ID="$(sed -n 's/^image_id=//p' "$STATE_FILE" | head -n1)"
  ROLLBACK_REF="$(sed -n 's/^image_ref=//p' "$STATE_FILE" | head -n1)"
  [[ "$ROLLBACK_ID" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || return 1
  [ -n "$ROLLBACK_REF" ] || return 1
}

published_url() {
  local service="$1" port="$2" published host hostport
  published="$(compose port "$service" "$port" 2>/dev/null | head -n1)"
  [ -n "$published" ] || return 1
  host="${published%:*}"
  hostport="${published##*:}"
  host="${host#[}"
  host="${host%]}"
  case "$host" in
    ""|"0.0.0.0"|"::"|"*") host="127.0.0.1" ;;
  esac
  printf 'http://%s:%s/health' "$host" "$hostport"
}

resolve_health_url() {
  published_url "$LB_SERVICE" 80 && return 0
  published_url "$SERVICE" 3003 && return 0
  return 1
}

body_is_ok() {
  printf '%s' "$PROBE_BODY" | tr -d '[:space:]' | grep -q '"status":"ok"'
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# Run a command with a hard wall-clock limit. Uses timeout(1) when present
# (Linux, busybox); macOS has no timeout in the base system, so fall back to a
# background watchdog. Returns 124 when the limit is hit, matching timeout(1).
# A zero limit disables the bound (same convention as curl --max-time).
run_with_timeout() {
  local seconds="$1" pid ticks limit out status
  shift
  if [ "$seconds" -eq 0 ] 2>/dev/null; then
    "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  # Watchdog fallback. Capture into a file, not the caller's pipe: a killed
  # child may leave a grandchild holding stdout, and the command substitution
  # would then wait for that fd even though the bound already fired.
  out="$(mktemp "${TMPDIR:-/tmp}/windsurfapi-probe.XXXXXX")" || return 1
  "$@" >"$out" 2>/dev/null &
  pid=$!
  ticks=0
  limit=$((seconds * 10))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$out"
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
  status=$?
  cat "$out"
  rm -f "$out"
  return "$status"
}

probe_exec() {
  local fetch_signal=""
  # The shell-level bound below is what saves us when `compose exec` itself is
  # wedged (daemon/CLI hang). The AbortSignal bounds the in-container fetch when
  # the app's event loop is wedged but the exec still starts. Both are needed:
  # the gate exists precisely for a container that is running but unresponsive.
  if [ "$PROBE_TIMEOUT" -gt 0 ]; then
    fetch_signal=",{signal:AbortSignal.timeout($((PROBE_TIMEOUT * 1000)))}"
  fi
  PROBE_BODY="$(run_with_timeout "$PROBE_TIMEOUT" "${COMPOSE_CMD[@]}" exec -T "$SERVICE" \
    node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/health'${fetch_signal}).then(async r=>{const t=await r.text();if(!r.ok)process.exit(1);process.stdout.write(t)}).catch(()=>process.exit(1))" \
    2>/dev/null)" || return 1
  body_is_ok
}

probe_once() {
  local url="$1"
  PROBE_BODY=""
  if [ -n "$url" ]; then
    if command -v curl >/dev/null 2>&1; then
      PROBE_BODY="$(curl -fsS --max-time "$PROBE_TIMEOUT" "$url" 2>/dev/null)" || return 1
      body_is_ok && return 0
      return 1
    fi
    if command -v wget >/dev/null 2>&1; then
      PROBE_BODY="$(wget -q -O - --timeout="$PROBE_TIMEOUT" "$url" 2>/dev/null)" || return 1
      body_is_ok && return 0
      return 1
    fi
    if command -v node >/dev/null 2>&1; then
      PROBE_BODY="$(run_with_timeout "$PROBE_TIMEOUT" node -e "fetch(process.argv[1]).then(async r=>{const t=await r.text();if(!r.ok)process.exit(1);process.stdout.write(t)}).catch(()=>process.exit(1))" "$url" 2>/dev/null)" || return 1
      body_is_ok && return 0
      return 1
    fi
  fi
  probe_exec
}

container_state() {
  local cid state
  cid="$(current_container)"
  if [ -z "$cid" ]; then
    printf 'missing'
    return 0
  fi
  state="$(inspect_field '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}' "$cid")"
  printf '%s' "${state:-unknown}"
}

health_gate() {
  local url deadline last_state="" state now
  url="$(resolve_health_url || true)"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))

  if [ -n "$url" ]; then
    log "Waiting for $url (${HEALTH_TIMEOUT}s timeout)..."
  else
    log "Waiting for /health inside the $SERVICE container (${HEALTH_TIMEOUT}s timeout)..."
  fi

  while :; do
    if probe_once "$url"; then
      return 0
    fi

    state="$(container_state)"
    if [ "$state" != "$last_state" ]; then
      log "  container: $state"
      last_state="$state"
    fi
    case "$state" in
      exited*|dead*|missing)
        return 1
        ;;
    esac

    now=$(date +%s)
    [ "$now" -ge "$deadline" ] && return 1
    sleep "$HEALTH_INTERVAL"
  done
}

health_failure_detail() {
  if [ -n "$PROBE_BODY" ]; then
    log "  last response: $(printf '%s' "$PROBE_BODY" | tr '\n' ' ' | cut -c1-240)"
  fi
  log "  container state: $(container_state)"
  log "  logs: $(compose_display) logs --tail=80 $SERVICE"
}

print_health_ok() {
  local version commit
  version="$(json_field "$PROBE_BODY" version)"
  commit="$(json_field "$PROBE_BODY" commit)"
  [ -n "$version" ] && log "  /health version: $version"
  [ -n "$commit" ] && log "  /health commit:  $commit"
}

rollback_target_ref() {
  local ref="$1"
  if [ -z "$ref" ] || [[ "$ref" == *"@"* ]]; then
    printf '%s:rollback' "$DEFAULT_IMAGE_REPO"
  else
    printf '%s' "$ref"
  fi
}

restore_image() {
  local id="$1" ref="$2" target
  target="$(rollback_target_ref "$ref")"
  log "Rolling back to $target ($(short_id "$id"))..."
  "$DOCKER_BIN" tag "$id" "$target" >/dev/null 2>&1 || {
    err "could not tag $target as the previous image ($id)"
    return 1
  }
  export WINDSURFAPI_IMAGE="$target"
  if ! compose up -d --no-deps --no-build --force-recreate "$SERVICE"; then
    err "rollback recreate failed"
    return 1
  fi
  return 0
}

rollback_and_exit() {
  local reason="$1" failed_id="${2:-}" target
  log "UPDATE FAILED: $reason"

  if [ -z "$OLD_ID" ]; then
    err "no previous image was recorded (first install), so there is nothing to roll back to."
    health_failure_detail
    log "Fix the cause, then retry: bash deploy/update.sh${TAG:+ --tag $TAG}"
    exit 2
  fi

  target="$(rollback_target_ref "$OLD_REF")"
  if ! restore_image "$OLD_ID" "$OLD_REF"; then
    health_failure_detail
    err "automatic rollback failed. Manual recovery:"
    log "  $DOCKER_BIN tag $OLD_ID $target"
    log "  WINDSURFAPI_IMAGE=$target $(compose_display) up -d --no-deps --force-recreate $SERVICE"
    exit 2
  fi

  if health_gate; then
    log "ROLLED BACK: the previous image is running and /health passed."
    print_health_ok
    if [ -n "$failed_id" ]; then
      log "The failed image is still on disk for diagnosis:"
      log "  $DOCKER_BIN image inspect $failed_id"
    fi
    exit 1
  fi

  err "the rollback container is also unhealthy; manual intervention is required."
  health_failure_detail
  exit 2
}

manual_rollback() {
  local target
  if ! read_rollback_point; then
    die "no valid rollback point at $STATE_FILE (run an update first)"
  fi
  log "Manual rollback to $(short_id "$ROLLBACK_ID") ($ROLLBACK_REF)"
  "$DOCKER_BIN" image inspect "$ROLLBACK_ID" >/dev/null 2>&1 \
    || die "rollback image $ROLLBACK_ID is no longer present locally"
  OLD_ID="$ROLLBACK_ID"
  OLD_REF="$ROLLBACK_REF"
  target="$(rollback_target_ref "$ROLLBACK_REF")"
  if ! restore_image "$ROLLBACK_ID" "$ROLLBACK_REF"; then
    health_failure_detail
    exit 2
  fi
  if health_gate; then
    log "ROLLED BACK: $target is running and /health passed."
    print_health_ok
    exit 0
  fi
  err "the rollback container is unhealthy; manual intervention is required."
  health_failure_detail
  exit 2
}

print_plan() {
  local health_url plan_up plan_rollback
  health_url="$(resolve_health_url || true)"
  log "WindsurfAPI Docker update plan (dry run — nothing will change)"
  log "  compose file:  $COMPOSE_FILE"
  log "  project dir:   $PROJECT_DIR"
  log "  service:       $SERVICE"
  log "  mode:          $MODE"
  log "  image:         $ACTIVE"
  if [ -n "$CID" ]; then
    log "  running:       $(short_id "$CID") image $(short_id "$OLD_ID") ($OLD_REF)"
  else
    log "  running:       (none — first install; automatic rollback unavailable)"
  fi
  if [ -n "$health_url" ]; then
    log "  health gate:   $health_url (${HEALTH_TIMEOUT}s)"
  else
    log "  health gate:   inside $SERVICE container (${HEALTH_TIMEOUT}s)"
  fi
  log "  rollback point: $STATE_FILE"
  log "  data volumes:  untouched (no down, no -v, no rm)"

  if [ "$MODE" = "rollback" ]; then
    log "  plan:"
    if read_rollback_point; then
      log "  saved rollback: $(short_id "$ROLLBACK_ID") ($ROLLBACK_REF)"
      log "    1. $DOCKER_BIN tag $ROLLBACK_ID $ROLLBACK_REF"
    else
      log "  saved rollback: (none valid at $STATE_FILE)"
      log "    1. (would fail: no valid rollback point)"
    fi
    log "    2. $(compose_display) up -d --no-deps --no-build --force-recreate $SERVICE"
    log "    3. poll /health"
    return 0
  fi

  log "  plan:"
  if [ -n "$OLD_ID" ]; then
    log "    1. $DOCKER_BIN tag $OLD_ID $(rollback_target_ref "$OLD_REF")  # keep rollback image"
  else
    log "    1. (no previous image to tag)"
  fi
  if [ "$MODE" = "build" ]; then
    log "    2. $(compose_display) build $SERVICE"
  else
    log "    2. $(compose_display) pull $SERVICE"
  fi
  if [ "$FIRST_INSTALL" = "1" ]; then
    plan_up="up -d --no-build"
  else
    plan_up="up -d --no-deps --no-build $SERVICE"
  fi
  log "    3. $(compose_display) $plan_up"
  log "    4. poll /health for ${HEALTH_TIMEOUT}s"
  if [ -n "$OLD_ID" ]; then
    log "    5. on failure: $DOCKER_BIN tag $OLD_ID $(rollback_target_ref "$OLD_REF")"
    plan_rollback="up -d --no-deps --no-build --force-recreate $SERVICE"
    log "       WINDSURFAPI_IMAGE=$(rollback_target_ref "$OLD_REF") $(compose_display) $plan_rollback"
    log "       then poll /health again; exit 1 if healthy, 2 if not"
  else
    log "    5. on failure: exit 2 (no rollback image)"
  fi
}

run_update() {
  local new_id new_cid new_ref saved_ref up_args=()

  if [ -n "$OLD_ID" ]; then
    saved_ref="${OLD_REF:-$(rollback_target_ref "")}"
    write_state "$STATE_FILE" "$OLD_ID" "$saved_ref" \
      || log "WARNING: could not write the rollback point to $STATE_FILE"
    "$DOCKER_BIN" tag "$OLD_ID" "$(rollback_target_ref "$OLD_REF")" >/dev/null 2>&1 \
      || log "WARNING: could not tag the previous image for convenience rollback"
  fi

  if [ "$MODE" = "build" ]; then
    export_build_metadata
    log "Building $ACTIVE from $ROOT_DIR..."
    if ! compose build "$SERVICE"; then
      err "docker compose build failed; the running container was not touched."
      exit 1
    fi
  else
    log "Pulling $ACTIVE..."
    if ! compose pull "$SERVICE"; then
      err "image pull failed; the running container was not touched."
      log "If this image is built locally (fork or pre-release tag), retry with:"
      log "  bash deploy/update.sh --build"
      exit 1
    fi
  fi

  new_id="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$ACTIVE" 2>/dev/null || true)"
  if [ -n "$new_id" ] && [ "$new_id" = "$OLD_ID" ]; then
    log "Image unchanged ($(short_id "$new_id")); recreating to confirm health only."
  elif [ -n "$new_id" ]; then
    log "Image: $(short_id "$OLD_ID") -> $(short_id "$new_id")"
  fi

  if [ "$FIRST_INSTALL" = "1" ]; then
    up_args=(-d --no-build)
    log "Starting the stack for the first time..."
  else
    up_args=(-d --no-deps --no-build)
    log "Recreating $SERVICE..."
  fi
  if [ "$FIRST_INSTALL" = "1" ]; then
    compose up "${up_args[@]}" || rollback_and_exit "docker compose up failed" "$new_id"
  else
    compose up "${up_args[@]}" "$SERVICE" || rollback_and_exit "docker compose up failed" "$new_id"
  fi

  if ! health_gate; then
    rollback_and_exit "/health did not pass within ${HEALTH_TIMEOUT}s" "$new_id"
  fi

  # Report what Compose actually started, not what we predicted: a fork image,
  # a digest pin, or a .env override may resolve differently from ACTIVE.
  new_cid="$(current_container)"
  new_ref="$(inspect_field '{{.Config.Image}}' "$new_cid")"
  new_id="$(inspect_field '{{.Image}}' "$new_cid")"

  log "UPDATE OK: ${new_ref:-$ACTIVE} is running and /health passed."
  print_health_ok
  write_state "$SUCCESS_FILE" "${new_id:-unknown}" "${new_ref:-$ACTIVE}" \
    "version=$(json_field "$PROBE_BODY" version)" 2>/dev/null || true
  log "Data volumes were not touched. Rollback point: $STATE_FILE"
}

export_build_metadata() {
  local version commit branch commit_date commit_message
  if [ -z "${BUILD_VERSION:-}" ] && [ -r "$ROOT_DIR/package.json" ]; then
    version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n1)"
    [ -n "$version" ] && export BUILD_VERSION="$version"
  fi
  command -v git >/dev/null 2>&1 || return 0
  git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if [ -z "${BUILD_COMMIT:-}" ]; then
    commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
    [ -n "$commit" ] && export BUILD_COMMIT="$commit"
  fi
  if [ -z "${BUILD_BRANCH:-}" ]; then
    branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ -n "$branch" ] && export BUILD_BRANCH="$branch"
  fi
  if [ -z "${BUILD_COMMIT_DATE:-}" ]; then
    commit_date="$(git -C "$ROOT_DIR" log -1 --pretty=%cI 2>/dev/null || true)"
    [ -n "$commit_date" ] && export BUILD_COMMIT_DATE="$commit_date"
  fi
  if [ -z "${BUILD_COMMIT_MESSAGE:-}" ]; then
    commit_message="$(git -C "$ROOT_DIR" log -1 --pretty=%s 2>/dev/null || true)"
    [ -n "$commit_message" ] && export BUILD_COMMIT_MESSAGE="$commit_message"
  fi
}

main() {
  parse_args "$@"
  preflight
  capture_current
  resolve_active_image

  if [ "$DRY_RUN" = "1" ]; then
    print_plan
    exit 0
  fi

  acquire_lock
  trap release_lock EXIT INT TERM

  if [ "$MODE" = "rollback" ]; then
    manual_rollback
  fi

  run_update
}

main "$@"
