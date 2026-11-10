# Dashboard login flows

Four ways into the account pool. The dashboard probes the account first and
shows only the form that can work, so a password is never submitted for an
account that has none (that used to surface as `ERR_INVALID_CREDENTIALS`).

| Account shape | What the probe returns | What the dashboard shows |
|---|---|---|
| Password account | `has_password: true` | email + password |
| Email-code account (most OAuth signups) | `has_password: false`, email connection enabled | email + **verification code** form |
| OAuth-only account | `has_password: false`, no email connection | Google / GitHub + token box |
| No such account | `method: "not_found"` | "No Windsurf account uses this email" |
| Probe unavailable | nothing usable | password form, plus the code form as a fallback |

The probe is `POST /_devin-auth/connections` (`auth_method.has_password`), which
is exactly what windsurf.com's own login page branches on. `CheckUserLoginMethod`
returns `{}` for real accounts and is only an enrichment when connections cannot
answer.

## 1. Password login

1. Add-account modal → **登录** tab.
2. Type the email. The probe runs on blur and prints the detected method.
3. `has_password: true` → type the password → **登录**.
4. On success the account is added to the pool and the masked key is shown.

The backend never calls `password/login` when the probe says
`has_password: false`, and never counts that answer toward the per-email
lockout. If the probe is unavailable **and** the password is rejected, the
error carries `probeUnknown: true` and the UI offers the code / OAuth / token
alternatives instead of a dead end.

## 2. Email-code login

1. Type the email. The probe runs on blur; an account without a password shows
   the code form immediately.
2. Click **登录** (or **发送验证码**) — this calls
   `POST /_devin-auth/email/start` `{email, mode:"login", product:"Windsurf"}`.
   One send per click; the upstream `email_verification_token` stays in server
   memory keyed by an opaque `flowId` and is never returned to the browser.
3. The status line reads "Code sent to …", the send button counts down 30 s.
4. Type the 6-digit code → **验证并登录** →
   `POST /_devin-auth/email/complete` → Auth1 token → `WindsurfPostAuth` →
   `devin-session-token$…`, stored as the pool key.

Notes:

- The code is single-use upstream. A PostAuth failure keeps the Auth1 token for
  2 minutes so "retry the same code" works without a new email (max 3 exchange
  attempts).
- Only a positive "invalid verification code" answer feeds the email lockout. An
  expired token (`401 Invalid verification token`) drops the flow and locks
  nothing.
- **Mail not received?** Use *"没收到邮件？改用 app.devin.ai 发送"* under the code
  form. It calls `POST /api/auth1/email/start` on app.devin.ai (Devin's own
  payload: `{email, mode:"login"}`) and verifies on the same host. This is an
  explicit operator choice, not the automatic cross-host fallback, so it works
  with `DEVIN_CONNECT_LOGIN_HOST_FALLBACK` unset.
- The automatic fallback stays behind `DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1`:
  `email/start` falls through to the other host only on 404/405 (proof the
  endpoint is gone) and never after a transport error, because that could send
  a second email.

## 3. Token capture from windsurf.com

The token is rendered **on windsurf.com** after sign-in (`/editor/show-auth-token`
calls `GetOneTimeAuthToken` and shows the result); it never appears in the URL.
So there are two paths, depending on where the gateway runs.

### 3a. Gateway on another machine (the normal case) — one-click paste

1. **登录** tab → **从 windsurf.com 获取 Token**. A new tab opens on the official
   sign-in page (the same `response_type=token&redirect_uri=show-auth-token` URL
   the Windsurf editor uses). Sign in with Google, GitHub, or an email code.
2. The page then shows the token. Click its copy button (or select the address
   bar).
3. Back in the dashboard, click **从剪贴板粘贴** — it reads the clipboard,
   extracts the token from whatever was copied (bare token, `windsurf://…`
   deep link, or a full callback URL) and imports it in the same click.

The import goes to `POST /dashboard/api/windsurf-login/token`. It is stateless:
no `/oauth/start` session is required, so a valid token cannot fail with
`ERR_INVALID_STATE`. `auth1_…` intermediates are rejected (they are not pool
keys). The raw token is never echoed by the API and never logged.

If the clipboard API is unavailable (plain `http://LAN` is not a secure
context), paste manually into the box and click **用 Token 添加**.

### 3b. Gateway on the same machine — automated capture (CDP)

```bash
node scripts/token-capture.mjs --password <dashboard password> [--port 3456] [--timeout 300]
```

It launches a throwaway Chrome/Edge profile with remote debugging, opens the
sign-in page, waits for you to finish signing in, reads the `authToken` from the
`GetOneTimeAuthToken` response (falling back to the read-only input on the
show-auth-token page), and imports it through the same
`/windsurf-login/token` route. It prints only the masked account.

- The consent step is always yours; the script never types credentials and never
  requests an email code.
- The token is never written to disk. Add `--print` to echo it to stdout instead
  of importing (for pasting into another machine).
- Use `--browser <path>` when Chrome/Edge is not in a standard location.

## 4. Devin (app.devin.ai)

The same modal covers it, because both hosts speak the same Auth1 protocol:

- **Token import**: a token minted on app.devin.ai works in the token box —
  `devin-session-token$…` is stored as the pool key, a Firebase idToken goes
  through RegisterUser.
- **Email code**: the *"改用 app.devin.ai 发送"* action (or the
  `DEVIN_CONNECT_LOGIN_HOST_FALLBACK=1` automatic fallback) sends and verifies on
  `app.devin.ai/api/auth1/email/{start,complete}`.
- The probe remembers which host answered (`host` in the
  `/windsurf-login/probe` response) and starts the code flow there, so a
  windsurf.com outage does not send the request straight back into it.

`[UNVERIFIED]` The final hop — feeding an Auth1 token minted on app.devin.ai
into `WindsurfPostAuth` — is exercised by the same `postAuthDualPath` exchanger
as the windsurf.com token but has not been confirmed with a live Devin account.

## Errors you may see

| Code | Meaning | What to do |
|---|---|---|
| `ERR_NO_PASSWORD_OAUTH_ACCOUNT` | the account has no password | use the code form, OAuth, or a token |
| `ERR_EMAIL_NOT_FOUND` | no account for that address | check the address |
| `ERR_EMAIL_LOCKED` | 3 failed attempts for this address | wait out `retryAfterMs` |
| `ERR_EMAIL_CODE_COOLDOWN` | a code was just sent | the button counts down the remainder |
| `ERR_EMAIL_FLOW_EXPIRED` | the code/token expired or was used | request a new code |
| `ERR_EMAIL_VERIFY_UNAVAILABLE` | upstream did not answer; the code was **not** checked | retry the same code |
| `ERR_POSTAUTH_FAILED` | code accepted, session exchange failed | retry the same code within 2 min |
| `ERR_NO_TOKEN_IN_INPUT` | nothing token-shaped in the pasted text | copy the token itself or the whole URL |
| `ERR_INVALID_STATE` | only from the legacy state-bound `/oauth/callback` | use `/windsurf-login/token` |
