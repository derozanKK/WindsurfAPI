# `?key=` query-parameter auth — status, risk, and removal plan

> **Status: supported, deprecated.** `?key=` still authenticates today. It is a
> compatibility carrier for Gemini-native clients, not the recommended form. No
> removal has shipped, and none can ship in a patch release. The phases below are
> a plan, not a schedule: each one needs an Owner decision and a release note.

## What is accepted today

`extractToken` (`src/server.js`) resolves the caller's key in this order:

1. `Authorization: Bearer <key>` — the first comma-delimited segment is used
2. `x-api-key: <key>`
3. `x-goog-api-key: <key>`
4. `?key=<key>` in the query string

The query form is parsed from `req.url` with `URL.searchParams.get('key')` and
trimmed. It is accepted on **every API route that calls `extractToken`**, not
only `/v1beta/models/*`; the Gemini routes are simply why it exists. A header
always wins when both are present.

The bundled `nginx.conf` defines `log_format main_no_query` and logs `$uri` —
the normalized path only — so the query string from the request line never
reaches its access log. The format also omits the `Referer` header: a `Referer`
is itself a URL, so a link clicked on a page that was opened with `?key=` would
copy that query into the log even when the request line is clean. Both
properties are pinned by `test/nginx-access-log.test.js` (`$request_uri`, `$args`
and `$http_referer` are forbidden in the format). The application itself does not
log the raw request line; the places that derive a path from `req.url` slice at
`?` (`src/server.js`).

## Why it is discouraged

A key in the query string is a key in the URL. URLs are retained in places a
header is not:

| Sink | What happens |
|---|---|
| Reverse-proxy access logs | nginx's default `combined` format logs `$request_uri`; the bundled config no longer does, but proxies you add are yours to configure |
| Browser history / bookmarks | opening a Gemini URL in a browser stores the key |
| `Referer` | a URL used as a link can leak the query to the next site (browsers usually strip it cross-origin, but not every client does); a proxy that logs the `Referer` header records it too — the bundled nginx does not log that header |
| Packet captures / support bundles | full request lines travel in both |
| Upstream logs | outside this project's control |

The chat key is the only credential on the API surface: it unlocks chat,
`/auth/status` and every model. It is not scoped to Gemini. The dashboard API
(`/dashboard/api/*`) uses its own operator credential; `?key=` is not one.

The app never logs the query string, and the bundled nginx no longer logs either
the request-line query or the `Referer` header that could repeat it. That reduces
the blast radius; it does not make the URL a safe carrier — browser history,
captures and any proxy you add still see the full URL.

## Use a header instead

All three header forms authenticate the same way:

```bash
# Gemini native (preferred for Gemini clients)
curl "http://HOST:3003/v1beta/models/MODEL:generateContent" \
  -H "x-goog-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'

# OpenAI-compatible clients
curl "http://HOST:3003/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"MODEL","messages":[{"role":"user","content":"hello"}]}'

# Anthropic SDKs
curl "http://HOST:3003/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H 'content-type: application/json' \
  -d '{"model":"MODEL","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

The Google GenAI SDK path in the README uses `x-goog-api-key`, so the Python/JS
SDK example needs no change:

```python
from google import genai
client = genai.Client(
    api_key="YOUR_API_KEY",
    http_options={"base_url": "http://HOST:3003"},
)
```

If a client can only build `?key=` URLs:

- keep it behind the bundled nginx (no request-line query, no `Referer` in the
  access log) and accept the residual exposure in browser history and captures;
  or
- put a small proxy in front that moves the parameter into `x-goog-api-key` and
  strips the query before forwarding.

Audit client configs for `?key=` / `key=` and migrate them before Phase 2. No
in-repo client uses the query form for this API; the remaining `?key=` strings in
the tree are Firebase upstream URLs (`src/dashboard/windsurf-login.js`), the
compatibility branch and its comment (`src/server.js`), and the nginx regression
test.

## Removal plan (proposed)

| Phase | Earliest version | Behavior | Status |
|---|---|---|---|
| 0 — current | 3.9.x | accepted; documented as compatibility-only | shipped |
| 1 — announce | first minor after this doc (3.10.0 or later) | still accepted; responses authenticated via `?key=` carry `Deprecation: true` and a `Sunset` date; a rate-limited `WARN` records a key hash (never the key); release notes name the migration | not implemented |
| 2 — default off | next major (4.0.0 or later) | `?key=` returns 401 `query_key_removed` unless the temporary escape hatch is set; the error names `x-goog-api-key` | not implemented |
| 3 — remove | following major (5.0.0 or later) | the escape hatch and the query-parsing branch are deleted | not implemented |

Proposed escape-hatch name for Phase 2: `WINDSURFAPI_ALLOW_QUERY_KEY=1`. It does
not exist today; setting it has no effect. It is named here so the name is not
invented twice.

Rules that keep the removal from surprising anyone:

- no removal in a patch release;
- at least one minor release between Phase 1 and Phase 2;
- every phase updates this file, both READMEs, and the release notes;
- Phase 2 and Phase 3 need an explicit Owner decision — the phases are a plan,
  not a promise of dates;
- if operator reports show a client that cannot send headers, extend Phase 1
  rather than breaking it.

## What this does not change

- `Authorization: Bearer`, `x-api-key` and `x-goog-api-key` keep working.
- The dashboard API keeps its own auth; this plan does not touch it.
- The nginx `$uri` format stays, and it must keep omitting `$http_referer` — a
  `Referer` URL can carry the query even when `$uri` is clean. Do not restore
  query logging for debugging; log a dedicated non-secret parameter instead.
