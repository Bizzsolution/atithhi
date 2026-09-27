# AtithiBook SaaS — Security Audit & Remediation (2026-09)

**Scope:** `index.html` (hotel PWA), `admin.html` (BizzSathi panel), `firestore.rules`, `netlify/functions/*.mjs`, `netlify.toml`
**Runtime / trust model:** Static PWA on Netlify CDN + Netlify Functions (Node 22, AWS Lambda), Firebase Firestore, **no end-user identity provider before this audit**. Multi-tenant: one Firestore project holds every hotel.
**Method:** Manual review of every trust boundary, then proof-by-test: each regression test below was run against the **pre-audit** code (must fail) and the **patched** code (must pass).

| Suite | Pre-audit | Patched |
|---|---|---|
| `tests/functions_test.mjs` (Netlify functions, real RSA keys, fake Google APIs enforcing hardened rules) | 3 pass / **17 fail** | **36 / 36** |
| `tests/admin_login_security_test.js` (admin.html in jsdom) | 4 pass / **9 fail** | **13 / 13** |
| `tests/license_expiry_client_test.js` (index.html license check) | 0 pass / **5 fail** | **5 / 5** |
| `tests/booking_notify_second_device_test.js` (index.html — 2nd-device booking notifications, found during this audit's own multi-device testing) | 2 pass / **6 fail** | **8 / 8** |
| `tests/flow_test.js` + `tests/billing_regression.js` (no-regression: vault sync, migrate, billing) | — | **42 / 42** |
| `tests/firestore.rules.test.mjs` (real rules engine via emulator) | written; **not executable in the audit sandbox** (emulator download blocked) — run locally, see bottom | — |

---

## Findings summary

| ID | Severity | Title |
|---|---|---|
| C-1 | **Critical** | License registry (`licenses/*`) world-writable and world-readable |
| C-2 | **Critical** | Legacy `admin/*` documents world-writable and world-readable (full customer list) |
| C-3 | **Critical** | Admin panel authentication is client-side only |
| H-1 | High | `manage-keys` 401 response leaks secret length + first/last character |
| M-1 | Medium | Non-constant-time secret comparisons; internal errors echoed to clients |
| M-2 | Medium | OCR endpoint usable as a general LLM proxy; provider API key in URL; weak input typing |
| M-3 | Medium | Revoked licenses can still activate new devices |
| L-1 | Low | CORS `*` fallback; per-instance in-memory rate limits |
| AD-1 | Architectural Debt | Hotel data authorised by knowledge of the license key alone |
| AD-2 | Architectural Debt | Public-booking token scope, staff password hashing, dead admin "reset hotel password", CSP `unsafe-inline` |

---

#### [Severity: Critical] — C-1: License registry world-writable and world-readable

1. **Mechanics & root cause**
   - `firestore.rules` (pre-audit lines 171–181): `match /licenses/{licenseKey} { allow get: if true; allow create, update: if validHotelId(licenseKey); }`
   - The app has no Firebase Auth, so `request.auth` is always `null`. The only write condition was the *shape* of the document ID. The comment even noted "writes have to remain open for [the admin panel] to function at all".
   - `scan.mjs::checkFirestoreLicense`, `verify-access.mjs` and `index.html::checkLicenseExpiry` all treat this collection as the source of truth.

2. **Exploitation & impact**
   - `curl -X PATCH https://firestore.googleapis.com/v1/projects/atithibook-saas/databases/(default)/documents/licenses/ATITHI-FREEPRO999 -d '{"fields":{"key":{"stringValue":"ATITHI-FREEPRO999"},"active":{"booleanValue":true},"plan":{"stringValue":"PRO"},"features":{...}}}'` → a working PRO license. `/api/scan` accepts it → **unlimited Gemini/Groq usage billed to BizzSathi**.
   - Same request on an existing key: un-revoke a non-paying hotel, enable paid features, or **replace the registered phone with the attacker's** → defeats `verify-access`'s phone binding → attacker activates the app for that hotel → full guest register (names, phones, addresses, masked Aadhaar).
   - Reads (`get: if true`) return owner name and registered phones to anyone holding a key (the "second factor" is readable with the first).
   - **Integrity:** total. **Confidentiality:** owner PII + phone second factor. **Availability:** any hotel can be revoked by anyone (`active:false`). **Tenant isolation:** broken.

3. **Patch** (`firestore.rules`, `admin.html::doLogin`, new `netlify/functions/admin-auth.mjs`, service-account reads in `scan.mjs` / `verify-access.mjs` / new `license-status.mjs`)
   ```
   function isAdmin() {
     return request.auth != null
       && request.auth.uid == 'bizzsathi-admin'
       && request.auth.token.admin == true;
   }
   match /licenses/{licenseKey} {
     allow get: if isAdmin();
     allow list: if false;
     allow create, update: if isAdmin()
       && validHotelId(licenseKey)
       && request.resource.data.key == licenseKey
       && request.resource.data.size() <= 40;
     allow delete: if false;
   }
   ```
   - Layer 1 (identity): `admin-auth.mjs` verifies `ADMIN_PASSWORD` server-side and mints a Firebase Custom Token `{uid:"bizzsathi-admin", claims:{admin:true}}` signed RS256 with the service account using only `node:crypto` (no npm deps — drag-and-drop deploys still work). Custom claims cannot be set by a client.
   - Layer 2 (rules): writes require that identity **and** the uid **and** the key-shape **and** `data.key == docId` **and** a field-count cap.
   - Layer 3 (server reads): the functions read licenses with an OAuth2 access token from the same service account (bypasses rules by design), so public reads can be closed without breaking scanning or verification.
   - Layer 4 (client): the hotel app now gets `active/plan/expiry/features` from `/api/license-status`, which never returns phone/owner.
   - `admin.html::pushMany` normalises `key` to the upper-cased document id so every admin write satisfies `data.key == licenseKey`.

4. **Invariant** — *Capability-based authorisation:* no Firestore path that controls money or identity may be writable by a principal whose identity the rules cannot verify. Server-trusted fields (license state, entitlements, second factors) are written only by a principal holding a server-minted claim, and read by clients only through a minimal-projection endpoint.

5. **Tests** — `tests/functions_test.mjs` ("registered phone verifies under hardened rules", "valid license scans under hardened rules", "never returns phone or owner"); `tests/firestore.rules.test.mjs` ("anon cannot forge a new PRO license", "anon cannot re-activate / change phone", "anon cannot read registered phones", "token with admin claim but wrong uid denied").

---

#### [Severity: Critical] — C-2: Legacy `admin/*` documents world-writable and world-readable

1. **Mechanics** — pre-audit rules `match /admin/{docId} { allow get: if true; allow create, update: if true; }`. `admin/licenses` holds **every** hotel's license (key, owner, phone, plan) in one array. `index.html::checkLicenseExpiry` downloaded it on **every hotel device** as a fallback; `scan.mjs` and `verify-access.mjs` trusted it as a license source.
2. **Impact** — one anonymous GET = the full customer list **including every license key**, i.e. read/write access to every hotel's guest register (see AD-1). One anonymous PUT = inject forged licenses (free OCR, bypass phone check) or wipe it (outage for every un-migrated hotel).
3. **Patch** — rules: `allow get, create, update: if isAdmin()`. Functions read it via service account. `index.html::checkLicenseExpiry` rewritten: `/api/license-status` first; transitional fallback reads only the hotel's own `licenses/{key}`; the all-hotels fallback is **removed from the client**.
4. **Invariant** — *No bulk-tenant document is ever readable by a tenant.* Cross-tenant aggregates live server-side only.
5. **Tests** — `tests/license_expiry_client_test.js` ("never downloads legacy all-hotels list", both with endpoint up and down); rules test "anon cannot read the whole customer list", "anon cannot overwrite/inject into the legacy list".

---

#### [Severity: Critical] — C-3: Admin panel authentication is client-side only

1. **Mechanics** — `admin.html::doLogin` (pre-audit ~L1064): `if (p === storedAdminPwd || p === DEFAULT_ADMIN_PANEL_PASSWORD)`. The default `bizzsathi@2026` was hard-coded in the page source and **always accepted, even after a custom password was set**. The login page had a "Reset to Default Password" button. Custom passwords were stored in plaintext in `localStorage.ab_admin_pwd`.
2. **Impact** — anyone who opens `/admin.html` is admin. (Before C-1/C-2 were fixed this gate was cosmetic anyway; after fixing them, the panel needs a real identity or it cannot work at all — the two fixes are coupled.)
3. **Patch** — `doLogin` is now async: `POST /api/admin-auth` → `signInWithCustomToken` with `Persistence.NONE` (session dies with the tab) → verifies `claims.admin === true` before revealing the UI. Removed: default password constant, local password storage (and **purges** any stored value on load), reset button, `changeAdminPassword()`. Password is rotated only via the `ADMIN_PASSWORD` env var. Server side: constant-time compare, 5-attempt/15-min per-IP lockout, fails closed (503) if `ADMIN_PASSWORD` (< 8 chars) or the service account is missing.
4. **Invariant** — *The browser never decides authorisation.* Every privilege is a server-minted, cryptographically verifiable claim checked by the data layer.
5. **Tests** — `tests/admin_login_security_test.js`: default password rejected; localStorage-planted password rejected and purged; no reset path; correct server password → authenticated Firestore session; lockout after 5 failures. `tests/functions_test.mjs` admin-auth block: token signature verifies with the SA public key, carries `admin:true`, fixed uid, correct audience, ≤ 3600 s, never echoes the password, 6th attempt locked even with the right password.

---

#### [Severity: High] — H-1: `manage-keys` 401 response leaks the secret

1. **Mechanics** — `manage-keys.mjs` L51–71 ("TEMPORARY DIAGNOSTIC") returned `expectedLength`, `expectedFirstLast` (`"S...3"`) and which env var was in use to **any unauthenticated caller**.
2. **Impact** — `ADMIN_SECRET` is also the `verify-access` bypass code (activates any hotel's app without the phone). Disclosing length + 2 characters cuts brute-force cost and confirms guesses. Verified live in the pre-audit test run: body contained `"expectedLength":19,"expectedFirstLast":"S...3"`.
3. **Patch** — diagnostic block deleted; `safeEqual()` (SHA-256 both sides → `timingSafeEqual`), 256-char input cap, `Cache-Control: no-store`, no `*` CORS.
4. **Invariant** — *Authentication failures are indistinguishable:* one status, one body, constant time, regardless of why they failed.
5. **Tests** — "401 body has NO diagnostic block", "401 body does not leak secret length/first/last char".

---

#### [Severity: Medium] — M-1: Timing-unsafe comparisons; internal errors echoed

1. **Mechanics** — `admin.mjs` `adminKey !== ADMIN_PASSWORD`; `manage-keys.mjs` same; `verify-access.mjs` `phone === adminSecret`; `verify-access` returned `"Verification failed: " + e.message`.
2. **Impact** — remote timing oracle on secrets (noisy over the network, but free to fix); internal error strings can disclose upstream details.
3. **Patch** — shared pattern in every function:
   ```js
   function safeEqual(a, b) {
     const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
     const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
     return timingSafeEqual(ha, hb);
   }
   ```
   Hashing first makes lengths equal (no throw, no length leak). Phone comparisons also use it. Errors are logged server-side (truncated) and the client gets a fixed message.
4. **Invariant** — secrets are compared only through `safeEqual`; client-facing error bodies are constants.
5. **Tests** — "internal error text not echoed to client"; admin-auth wrong/non-string password → 401.

---

#### [Severity: Medium] — M-2: OCR endpoint as a general LLM proxy; API key in URL

1. **Mechanics** — `scan.mjs` forwarded a client-supplied `prompt` (≤1000 chars) with no system constraint; Gemini key sent as `?key=` in the URL; `license`/`image` not type-checked (`{toUpperCase:1}` → 500); malformed JSON → 500.
2. **Impact** — combined with C-1 (forged licenses) = free general-purpose multimodal LLM billed to BizzSathi. URL-borne keys land in proxy/CDN/provider logs.
3. **Patch** — server-pinned `systemInstruction` (Gemini) / `system` message (Groq) restricting output to ID-field JSON; key moved to `x-goog-api-key` header; model name URL-encoded; strict typing for `license`, `image`, `prompt`, `scanContext ∈ {undefined,"family"}`; base64 charset check on `image`; license-format gate before any lookup; JSON parse failure → 400; provider error details truncated to 200 chars.
4. **Invariant** — *Every paid upstream call is bound to a server-owned purpose* (fixed system instruction) and to a license the server itself read.
5. **Tests** — "Gemini API key NOT in URL", "…sent in x-goog-api-key header", "server-side systemInstruction pins model", "non-base64 image rejected", "non-string license rejected cleanly", "malformed JSON → 400".

---

#### [Severity: Medium] — M-3: Revoked licenses could activate new devices

1. **Mechanics** — `verify-access.mjs` never read `active`; a revoked key + matching phone returned `ok:true`.
2. **Patch** — `if (fields.active?.booleanValue === false) → 403 "This license has been deactivated"`.
3. **Invariant** — every entitlement check evaluates `active` and `expiry` server-side.
4. **Tests** — "revoked license cannot activate a new device", "revoked license denied" (scan).

---

#### [Severity: Low] — L-1: CORS fallback `*`; in-memory rate limits

- **Fix applied:** `Access-Control-Allow-Origin` is sent only when Netlify provides `URL`/`DEPLOY_PRIME_URL`, never `*` (all callers are same-origin, so nothing breaks). `Cache-Control: no-store` on all function responses.
- **Residual:** rate limits live in each Lambda instance's memory, so parallel instances / cold starts reset them. Proper fix needs a shared counter (Firestore document with the service account, or Netlify Blobs). Not done here because it adds a write per request; revisit if abuse is observed. Keys are 32¹² random, so brute-forcing a key is infeasible regardless.

---

#### [Architectural Debt] — AD-1: Hotel data authorised by knowledge of the license key alone

- **What:** `hotels/{key}/**` is readable/writable by anyone who knows the key (documented in the rules header). The license key is a shared, never-rotated bearer secret typed on shared devices; `verify-access`'s phone check is advisory because a client can talk to Firestore directly.
- **Why not flipped in this change:** fixing it requires every hotel device to hold a per-hotel identity **before** the rules change; flipping the rules first would lock every live hotel out mid-shift. That violates the zero-side-effect constraint, so it must be a two-phase rollout.
- **Remediation plan (the infrastructure for it now exists — `admin-auth.mjs` shows the exact token-minting code):**
  1. `verify-access.mjs`: on success, mint a custom token `{uid: "hotel:<KEY>:<deviceId>", claims:{hotelId:<KEY>}}` (same `signJwt` as `admin-auth.mjs`).
  2. `index.html`: load `firebase-auth-compat`, call `signInWithCustomToken` after activation with `Persistence.LOCAL`; on app start, if not signed in, re-run verify-access silently with the stored phone.
  3. Ship, wait until usage shows all active devices have updated (e.g. log a `authVersion` field in `hotels/{key}/data/profile`).
  4. Change rules to `allow get, create, update: if request.auth.token.hotelId == hotelId;`.
  5. Revocation becomes real: revoking a license = revoke that uid's refresh tokens (Admin API) + `active:false`.
- **Invariant target:** tenant isolation enforced by verified identity, not by secrecy of an identifier.

#### [Architectural Debt] — AD-2: Smaller structural items

- **Public booking:** `public_booking/{token}` is writable by anyone holding the token (defacement of one hotel's public page only); `requests/*` readable by token holders (a few enquirers' names/phones). Closes with AD-1 (staff writes require `hotelId` claim).
- **Staff passwords:** SHA-256 with a static salt (`|AtithiSalt2024!`) — fast hash; anyone with the key can read hashes and crack short PINs offline. Since the key already grants the data, impact is low today; after AD-1, move to PBKDF2 (WebCrypto, ≥ 210 000 iterations, per-user salt).
- **Admin "Reset Hotel Staff Password"** writes to the admin device's own `localStorage`, which the hotel app never reads — the feature does nothing and sends the new password over WhatsApp. Replace with a server-side reset once AD-1 exists.
- **CSP `script-src 'unsafe-inline'`** is required by the single-file architecture; mitigated by consistent output escaping (`escHtml`/`blEsc` reviewed — no unescaped sinks found in invoice/booking templates). Long-term: move scripts to external files and use hashes/nonces.

---

## Bug fix found during this audit's own multi-device testing — 2nd device never got booking-request notifications

Not a security hole (both devices already had legitimate access to the same hotel), but reported by the owner while re-testing after this audit and root-caused/fixed in the same pass, so it is recorded here rather than opened separately.

1. **Mechanics** (`index.html`) — the booking-requests real-time listener and `handleRequestDecision` both read `localStorage.getItem("publicBookingToken")` directly. That key is written only by `saveProfile()`, called on the device that **generates** the public booking link. The cloud `profile` listener (`WS.onSnapshot("profile", ...)`) only ever called `setProfile(...)` — React state — never `localStorage.setItem`. The listener subscription itself lived inside a mount-only `useEffect(..., [])`, reading that (empty) localStorage value exactly once.
2. **Impact** — a second device logged in with the same license key had the token correctly displayed in the UI (React state was fine) but its `localStorage` copy stayed empty forever, since it never generated the link itself. Its booking-requests listener never subscribed, so new enquiries from the public link never appeared — and if staff on that device tried to approve/decline a request they'd seen some other way, `handleRequestDecision` also read the empty localStorage key and silently failed to write the decision back.
3. **Patch:**
   - Profile listener now also persists `publicBookingToken` to `localStorage` (same key `saveProfile` already uses), so every device's local copy converges with the cloud value.
   - The booking-requests subscription moved out of the mount-only effect into its own `useEffect(..., [profile?.publicBookingToken])` — it (re)subscribes the moment the token becomes known via React state, on any device, rather than only at the exact millisecond of mount.
   - `handleRequestDecision` now reads `profile?.publicBookingToken` (React state) with the old localStorage read kept only as a fallback.
4. **Invariant** — *A value the UI already displays correctly must come from the same source of truth every code path reads.* Two independent copies of the same fact (React state vs. localStorage) drift the moment only one of them is updated.
5. **Tests** — `tests/booking_notify_second_device_test.js`: static checks that the profile listener persists the token, that the subscription is no longer inside the `[]` effect, and that it now lives in an effect keyed on `profile?.publicBookingToken`; behavioral simulation of "device A" (generated the link, already had it in localStorage) and "device B" (only ever received it via cloud sync) — pre-audit code: 2/8 pass (device B never subscribes); patched: 8/8.

---

## Deployment order (must be followed — wrong order causes an outage)

1. **Firebase Console → Authentication → Get started** (one-time; no sign-in provider needs enabling — custom tokens work without one).
2. **Firebase Console → Project settings → Service accounts → Generate new private key** (downloads a JSON).
3. **Netlify → Environment variables** — add:
   - `FIREBASE_CLIENT_EMAIL` = the JSON's `client_email`
   - `FIREBASE_PRIVATE_KEY` = the JSON's `private_key` (paste as-is, including `-----BEGIN PRIVATE KEY-----`)
   - `ADMIN_PASSWORD` = a new strong password (≥ 12 chars). This is now the admin-panel login.
   *(Use the two separate variables, not the whole JSON — Netlify/AWS cap all function env vars at 4 KB combined.)*
4. **Deploy the new zip.** At this point the **old** rules are still live, so everything keeps working; the new code simply starts using the service account.
5. **Verify:** admin panel login with the new password → "☁️ Synced"; one hotel scan works; one hotel's expiry banner shows.
6. **Only then publish the new `firestore.rules`.**
7. Later: once every hotel is migrated, delete the `admin/licenses` document.

**Rollback:** re-publish the previous rules (kept in Firebase's rules history) — the new code works under both.

## Running the tests locally

```
cd tests
npm install
npm test            # functions + admin + client + regression suites (Node 18+)
npm run test:rules  # real Firestore rules engine via emulator (needs Java 11+)
```
