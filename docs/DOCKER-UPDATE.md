# One-command Docker updates

`deploy/update.sh` updates a Compose deployment of WindsurfAPI in one command:

```bash
bash deploy/update.sh
```

It pulls the new image, recreates **only** the `windsurf-api` service, waits for
`GET /health`, and automatically restores the image that was running before if
anything fails. The data volume is never touched. No Watchtower, no Compose
profile, and no Docker socket mount are required — the script runs on the host
with the same Docker CLI you already use.

## Quick start

First install (once):

```bash
cp .env.example .env          # then edit API_KEY / DASHBOARD_PASSWORD
docker compose up -d          # or: docker compose up -d --build
```

Every update after that:

```bash
bash deploy/update.sh
```

Common variants:

```bash
bash deploy/update.sh --tag 3.9.52     # pin a release tag (leading "v" is accepted)
bash deploy/update.sh --image ghcr.io/you/windsurf-api:latest   # fork / custom ref
bash deploy/update.sh --build          # rebuild from this checkout instead of pulling
bash deploy/update.sh --dry-run        # preflight + print the plan; change nothing
bash deploy/update.sh --rollback       # restore the saved rollback point
```

Run `bash deploy/update.sh --help` for the full flag list.

## What the script does

1. **Preflight** — `docker compose` v2 is present, the daemon is reachable, and
   the compose file validates.
2. **Lock** — `.docker-data/update/lock/` serializes updaters. A stale lock is
   recovered only when its owner PID is provably gone.
3. **Capture** — records the running container's image ID and image reference in
   `.docker-data/update/rollback-point.env`, and tags the old image as
   `ghcr.io/dwgx/windsurf-api:rollback`.
4. **Fetch** — `docker compose pull windsurf-api` (default) or
   `docker compose build windsurf-api` (`--build`). Pull/build failures exit
   before the running container is touched.
5. **Recreate** — `docker compose up -d --no-deps --no-build windsurf-api`.
   Only the app service is recreated; nginx keeps running.
6. **Health gate** — polls `/health` until it returns HTTP 200 with
   `"status":"ok"`, or the timeout expires (default 120 s, `--timeout N`).
   The probe goes through the published nginx port
   (`docker compose port nginx 80`), falls back to the app port, and finally to
   `docker compose exec` inside the container.
7. **Rollback on failure** — retags the previous image back to its original
   reference, runs
   `docker compose up -d --no-deps --no-build --force-recreate windsurf-api`,
   and re-runs the health gate.

On success the script writes `.docker-data/update/last-success.env` (image ID,
reference, timestamp, reported version) for diagnostics.

## Data safety

The script never runs any of these:

```text
docker compose down
docker compose up -v / --volumes
docker volume rm
docker rm
rm -rf
```

Compose reuses the bind mounts from `docker-compose.yml`:

| Host path | Container path | Holds |
|---|---|---|
| `./.docker-data/data` | `/data` | `accounts.json`, `proxy.json`, `stats.json`, `runtime-config.json`, `model-access.json`, `logs/` |
| `./.docker-data/opt/windsurf` | `/opt/windsurf` | Language Server binary + data |
| `./.docker-data/tmp/windsurf-workspace` | `/tmp/windsurf-workspace` | temporary workspace |

The rollback point lives in `./.docker-data/update/`, which is not mounted into
the container. `docker compose up` recreates containers but keeps volumes and
bind mounts; only a manual `docker compose down -v` (or `docker volume rm`)
destroys data. Do not run those during an update.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Update succeeded and `/health` passed. `--dry-run` preflight also exits `0`. |
| `1` | Update failed. The previous image is running again and healthy, or the pull/build failed before anything was recreated. |
| `2` | Update failed **and** the rollback failed (or there was no previous image). Manual intervention required; data is still untouched. |

## Pinning and image overrides

`docker-compose.yml` now resolves the app image through a variable:

```yaml
image: ${WINDSURFAPI_IMAGE:-ghcr.io/dwgx/windsurf-api:latest}
```

So all of these work:

```bash
bash deploy/update.sh --tag 3.9.52
WINDSURFAPI_IMAGE=ghcr.io/you/windsurf-api:latest bash deploy/update.sh
# or put WINDSURFAPI_IMAGE=... in .env
```

The script exports `WINDSURFAPI_IMAGE` for its own Compose calls, so `--tag`
works even when `.env` pins something else. The registry is whatever `docker`
is already logged in to; the script never reads, writes, or prints credentials.
If the GHCR package is private, run `docker login ghcr.io` once on the host.

## Environment overrides

All optional; the defaults match the checked-in `docker-compose.yml`.

| Variable | Default | Purpose |
|---|---|---|
| `WINDSURFAPI_IMAGE` | compose default | Image reference; also read by `docker-compose.yml`. |
| `WINDSURFAPI_COMPOSE_FILE` | `<repo>/docker-compose.yml` | Compose file to update. |
| `WINDSURFAPI_PROJECT_DIR` | `<repo>` | Compose project directory (resolves relative bind mounts). |
| `WINDSURFAPI_SERVICE` | `windsurf-api` | App service name. |
| `WINDSURFAPI_LB_SERVICE` | `nginx` | Service whose published port is used for `/health`. |
| `WINDSURFAPI_UPDATE_STATE_DIR` | `<repo>/.docker-data/update` | Rollback point + lock. |
| `WINDSURFAPI_HEALTH_TIMEOUT` | `120` | Health gate seconds (`--timeout` wins). |
| `WINDSURFAPI_HEALTH_INTERVAL` | `2` | Seconds between probes. |
| `WINDSURFAPI_DOCKER` | `docker` | Docker binary. |
| `COMPOSE_PROJECT_NAME` | directory name | Compose project; honored by both Compose and the script. |

## Local builds and forks

Use `--build` when the image is built locally or the tag is not published:

```bash
bash deploy/update.sh --build
```

The script fills the Dockerfile's `BUILD_VERSION`, `BUILD_COMMIT`,
`BUILD_BRANCH`, `BUILD_COMMIT_DATE` and `BUILD_COMMIT_MESSAGE` build args from
`package.json` / `git` when they are not already set, so `/health` reports the
commit that is actually running. Rollback still works: the previous image ID is
kept and retagged.

If a plain `pull` fails with `manifest unknown` / `not found`, the tag is not in
the registry — retry with `--build` (the script prints this hint too).

## Health gate details

`/health` is served by the app and proxied by the bundled nginx. A successful
gate requires HTTP 200 **and** `"status":"ok"` in the body; a 200 HTML error
page or a 502 from nginx does not pass. The script also fails fast if the app
container is `exited` or `dead`.

After the app container is recreated, nginx's `resolver ... valid=10s` can serve
a brief 502 until it re-resolves the new container IP. The polling loop absorbs
that window.

Tune it with:

```bash
bash deploy/update.sh --timeout 300
```

## Manual rollback and recovery

Restore the image that was running before the most recent update:

```bash
bash deploy/update.sh --rollback
```

If the automatic rollback also failed, recover by hand:

```bash
docker compose ps
docker compose logs --tail=200 windsurf-api

# Retag the saved image and recreate only the app
docker tag <old-image-id> ghcr.io/dwgx/windsurf-api:latest
WINDSURFAPI_IMAGE=ghcr.io/dwgx/windsurf-api:latest \
  docker compose up -d --no-deps --force-recreate windsurf-api

curl -fsS http://127.0.0.1:3003/health
```

The previous image ID is in `.docker-data/update/rollback-point.env` and is also
tagged `ghcr.io/dwgx/windsurf-api:rollback`. To go back to a specific published
release instead, run `bash deploy/update.sh --tag <version>`.

A stale lock after a killed run:

```bash
cat .docker-data/update/lock/pid    # confirm the PID is not running
rmdir .docker-data/update/lock      # only when the owner is gone
```

The script performs the same check automatically on the next run.

## In-dashboard update vs this script

The dashboard's "check for update" button can also update a Compose deployment,
but only when `/var/run/docker.sock` is mounted into the container. That mount
is effectively root on the host, which is why it is commented out by default in
`docker-compose.yml`.

The dashboard path is now health-gated like this script and trusts only a
digest, never a tag:

1. It resolves the running tag through the daemon's
   `GET /distribution/<repo>:<tag>/json` endpoint (no layer download) and
   requires the result to equal the digest in `<DATA_DIR>/image-digest.txt`.
   Missing or mismatched verification material refuses the update before any
   pull or container create. Download `image-digest.txt` from the matching
   GitHub Release (and verify its `.sigstore.json` bundle with
   `cosign verify-blob`) and place it in the data directory first; a
   digest-pinned `WINDSURFAPI_IMAGE=repo@sha256:…` is an explicit operator pin.
2. Before any pull or recreate it records the running image ID, the rollback tag
   and the Compose project/service in `<DATA_DIR>/self-update-docker.json`. If
   that record cannot be written, the update is refused.
3. The app image is pulled by digest; the `docker:24-cli` deployer is pinned by
   digest and every `docker compose up` uses `--no-build`, so Compose can never
   build from the on-disk checkout.
4. The deployer sidecar recreates the stack, polls `/health` inside the app
   container, and on failure restores the previous image as
   `<repo>:rollback` and recreates the app service from it.
5. The deployer container is **not** auto-removed: its exit code is the durable
   outcome (0 healthy · 1 rolled back healthy · 2 rollback failed · 3 recreate
   failed) until the next `/self-update/check` records it in the journal and
   removes the container.

`POST /dashboard/api/self-update` therefore returns
`{ ok: true, state: "pending-recreate", verified: false, rollbackPoint: … }`:
`ok` means the deployer was started, not that the new container is healthy.
Success is only reported after the restart by
`GET /dashboard/api/self-update/check` →
`dockerSelfUpdate.state === "confirmed"` (or `rolled-back`, `rollback-failed`,
`recreate-failed`, `unverified`). A deployer failure is no longer
indistinguishable from a verified rollback.

Do not trigger both at the same time: the script's lock only serializes script
runs, not the dashboard's deployer sidecar.

## Dashboard self-update states (git and docker)

Both update paths write a durable journal before mutating and keep their
rollback point until the restarted process proves it serves the expected
commit/image.

| Path | Journal | Confirmed by | Retry evidence |
|---|---|---|---|
| git (`POST /self-update`, `/self-update/rollback`) | `data/self-update-journal.json` | `/self-update/check` → `selfUpdate.state === "confirmed"` when the running commit matches | `data/self-update-before.json` is retained until confirmed |
| docker (`POST /self-update` when git is unavailable) | `<DATA_DIR>/self-update-docker.json` | `/self-update/check` → `dockerSelfUpdate.state === "confirmed"` from the deployer exit code | previous image ID + `<repo>:rollback` tag |

A rollback whose restart cannot be scheduled returns
`{ ok: false, error: "ERR_RESTART_NOT_SCHEDULED", state: "restart-not-scheduled",
rollbackPointRetained: true }` — the reset is on disk, but nothing will relaunch
the gateway, so it is not a successful rollback. Retry after fixing the
supervisor, or restart the process manually.


## Smoke tests

No daemon, no containers, no secrets:

```bash
# Print the resolved plan and validate compose/daemon access
bash deploy/update.sh --dry-run

# Exercise pull/build → recreate → health → rollback against fake docker/curl
node --test test/docker-oneclick-update.test.js
# same suite through the npm alias
npm run smoke:docker-update
```

The integration cases in the Node test run on Linux/macOS; on Windows they are
skipped (Windows cannot exec the fake `#!/usr/bin/env bash` shims from `PATH`),
while the static contract checks still run.

For a real end-to-end check, run against a disposable Compose project in its own
directory so it cannot share `.docker-data` with the real deployment:

```bash
tmp="$(mktemp -d)"
cp docker-compose.yml nginx.conf "$tmp"/
[ -f .env ] && cp .env "$tmp"/ || true
COMPOSE_PROJECT_NAME=windsurfapi-smoke PORT=3999 \
  docker compose -f "$tmp/docker-compose.yml" up -d

COMPOSE_PROJECT_NAME=windsurfapi-smoke PORT=3999 \
  WINDSURFAPI_COMPOSE_FILE="$tmp/docker-compose.yml" \
  WINDSURFAPI_PROJECT_DIR="$tmp" \
  WINDSURFAPI_UPDATE_STATE_DIR="$tmp/update" \
  bash deploy/update.sh

COMPOSE_PROJECT_NAME=windsurfapi-smoke \
  docker compose -f "$tmp/docker-compose.yml" down   # no -v: keeps its data
```

`WINDSURFAPI_PROJECT_DIR` makes relative bind mounts resolve inside `$tmp`
instead of the real checkout. Use `--dry-run` first if you only want to validate
the wiring.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `docker compose v2 is required` | Install the Compose v2 plugin (`docker compose version`), not legacy `docker-compose`. |
| `cannot reach the Docker daemon` | Start Docker, or add your user to the `docker` group (Linux). |
| `image pull failed` | Check `docker login ghcr.io`, the tag name, and network access. The running container was not touched. |
| `manifest unknown` on pull | The tag is not published; use `--build` or a published tag. |
| `/health did not pass` | The script already rolled back. Inspect `docker compose logs --tail=200 windsurf-api` and `.docker-data/update/`. |
| `rollback also failed` | Use the manual recovery block above; volumes are intact. |
| `another update is already running` | Wait, or remove a stale lock after confirming the PID is gone. |
| Update succeeded but the version is old | `docker compose pull` may have hit a cached tag; check `docker image inspect`, then retry with an explicit `--tag`. |

## Security notes

- No credentials, `.env` contents, account data, or API keys are read or logged
  by the script. Registry auth stays in `docker`'s credential store.
- No Docker socket is mounted, no privileged container is created, and no
  Watchtower-style agent is installed.
- State files contain only image IDs, image references, timestamps, and the
  version string reported by `/health`.
- The script runs with the invoking user's Docker permissions; anyone who can
  run it can already control the Docker daemon.
