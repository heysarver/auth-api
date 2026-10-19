# Boothwright dedicated AS browser continuation slice

Base: `7868077153d9adeb10beb971d104ec150b74ce9b`
Branch: `feat/boothwright-browser-continuation`
Worktree: `/home/asarver/workspace/boothwright-browser-continuation`

## Implemented

Default-off `BOOTHWRIGHT_BROWSER_ENABLED=true` mounts AS-owned `/login` and `/consent` before Turnstile, after existing rate limiting. Enablement requires MARKETKIT_OAUTH_ENABLED, explicit issuer, signing secret, dedicated Google configuration and exact configured surface paths. No shared default configuration, provider options, migrations or existing app login flows changed.

Installed `@better-auth/oauth-provider` and `better-auth` are 1.7.7. Inspected actual exported `verifyOAuthQueryParams`, signed parameter names, social `oauth_query` before-hook/serverContext, callback after-hook and `/oauth2/consent` session middleware. Signature and expiration are checked with that exported API before rendering or submission. Query remains unchanged inside a domain-separated HMAC form ticket. Unsigned extra keys, duplicate scalar parameters, wrong exact client/redirect/resource, invalid scopes and non-S256 requests are refused.

Server-rendered native forms require same-origin POST, unpredictable HttpOnly/SameSite CSRF cookie, signed ticket and five-minute expiration. Consent ticket binds exact signed query, current session id, CSRF nonce and route. Allow/deny are explicit; consent runs through the real provider handler, without skipConsent. HTML escaping, no-store, no-referrer, strict CSP and frame denial apply. Google initiation forwards every provider state Set-Cookie header. Redirect destinations are restricted to Google accounts origin for social initiation and registered redirect origin/path for provider consent results; signed redirect_uri itself must match the configured registration exactly.

## Executed evidence

Logs under `evidence/browser-continuation/`:
- `clean-install.log`: `npm ci --no-audit --no-fund`, exit 0, added 540 packages. Deprecation notices for node-domexception/glob and install-script approval notices for esbuild/protobufjs remain; no dependency edits.
- `build.log`: `npm run build`, TypeScript exit 0.
- `browser-provider.log`: targeted real-provider/browser-handler suite, 2 files / 15 tests passed.
- `regression.log`: full regression, 31 files / 390 tests passed.

The real handler fixture runs anonymous S256 authorize -> rendered login -> Google social initiation -> actual `/callback/google` state/continuation hook -> rendered authenticated consent -> allow -> authorization code -> token -> JWKS signature verification and exact session user subject. Google token transport and profile are bounded test-only fixtures, with unexpected network calls rejected. No live credentials or network identity verification is used. Explicit deny produces access_denied. Also exercises tampered resource, expired provider continuation, unsigned returnTo, unsigned continuation, no-session consent, missing CSRF cookie, changed session and forged form ticket. Existing real-provider tests cover wrong PKCE, exact redirect, cross-resource, refresh narrowing/widening/replay, stable subject and legacy regression suite.

Test-first failures were observed before implementation. An expiry test initially used Date.now mocking and did not expire provider's new Date comparison; corrected to fake Date/system time, inspected provider source and reran successfully. Social cookies were explicitly preserved before callback fixture execution.

## Remaining acceptance / operational blockers

- This proves native HTML route logic and real provider handlers in-process, not a launched headless browser's DOM interaction or deployed ingress/server behavior. No screenshot or live browser acceptance claimed.
- Real Google sign-in, Boothwright Google client registration, resolved GOOGLE_REDIRECT_URI and dedicated issuer/basePath compatibility require deployed approved wiring; fixture verifies default root callback `/callback/google` only. Credentials elsewhere are not evidence Boothwright wiring is complete.
- Dedicated DB/migrations/signing secrets, exact public issuer/resource/redirect contract, immutable images, ingress/NetworkPolicy and live health remain release gates from the parent report. Ensure production registration requires consent (`skipConsent=false`); this slice does not alter live client rows.
- Andrew retains final real Google/ChatGPT user acceptance. No fixture pass substitutes for that.
- No merge, push, deployment, live DB change, credential change or GitOps replacement. Original dirty tree preserved by fresh worktree. No recursive delegation.
