// AtithiBook — Admin Panel Authentication (server-side)
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
//
// WHY THIS EXISTS
// The admin panel used to "log in" entirely inside the browser: the
// password was compared in JavaScript, a hardcoded default was always
// accepted, and a "Reset to Default" button sat on the login page. That
// gate protected nothing, because Firestore itself had no idea who was
// calling — so license documents had to be left world-writable for the
// panel to work at all.
//
// This function is now the ONLY way to become "admin":
//   1. The password is checked here, against the ADMIN_PASSWORD env var,
//      with a constant-time comparison and per-IP lockout.
//   2. On success it mints a short-lived Firebase Custom Token carrying
//      the claim { admin: true }, signed with the project's service
//      account (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY env vars).
//   3. The panel exchanges it via signInWithCustomToken(); from then on
//      every Firestore request carries a verified identity, and
//      firestore.rules allow license/admin/billing writes ONLY for
//      request.auth.token.admin == true.
//
// Fails CLOSED: missing env vars → 503, never an open door.

import { createSign, createHash, timingSafeEqual } from "node:crypto";

const ADMIN_UID = "bizzsathi-admin";
const CUSTOM_TOKEN_AUDIENCE = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const MAX_PASSWORD_LEN = 256;
const MIN_SERVER_PASSWORD_LEN = 8;

// ── Rate limiting (in-memory, per function instance) ──────────────────
// AUDIT-2 (F7): IPv4 / IPv6-/64 buckets, LRU eviction of unlocked buckets
// (never Map.clear(), which wiped every active lockout), plus an
// instance-wide failure budget: this endpoint guards ONE shared secret,
// so N attackers x 5 attempts each must not add up to an unlimited
// guessing rate. Exceeding the budget throttles everyone on this instance
// for the window — acceptable for an admin-only credential, and it fails
// closed.
const RL = { MAX_ATTEMPTS: 5, LOCK_MS: 15 * 60 * 1000, MAX_BUCKETS: 5000, EVICT_SCAN: 256 };
const GLOBAL_BUDGET = { MAX: 60, WINDOW_MS: 15 * 60 * 1000 };
const rateMap = new Map();
const globalFailures = { windowStart: 0, count: 0, alerted: false };

function clientBucket(event) {
  const h = (event && event.headers) || {};
  const raw = String(h["x-nf-client-connection-ip"] || h["client-ip"] || "").trim().slice(0, 64);
  if (!raw) return "unknown";
  if (raw.indexOf(":") === -1) return raw;
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  const clean = raw.split("%")[0].toLowerCase();
  const halves = clean.split("::");
  if (halves.length > 2) return "v6:invalid";
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? new Array(Math.max(0, 8 - head.length - tail.length)).fill("0") : [];
  const groups = head.concat(fill, tail);
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return "v6:invalid";
  return "v6:" + groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":");
}
function evictIfFull() {
  if (rateMap.size < RL.MAX_BUCKETS) return;
  const now = Date.now();
  let scanned = 0;
  for (const [k, v] of rateMap) {
    if (scanned++ >= RL.EVICT_SCAN) break;
    if (!v.lockUntil || v.lockUntil <= now) { rateMap.delete(k); if (rateMap.size < RL.MAX_BUCKETS) return; }
  }
  const oldest = rateMap.keys().next();
  if (!oldest.done) rateMap.delete(oldest.value);
}
function globalBudgetExhausted() {
  const now = Date.now();
  if (now - globalFailures.windowStart > GLOBAL_BUDGET.WINDOW_MS) { globalFailures.windowStart = now; globalFailures.count = 0; globalFailures.alerted = false; }
  const exhausted = globalFailures.count >= GLOBAL_BUDGET.MAX;
  if (exhausted && !globalFailures.alerted) {
    // Visible in Netlify → Functions → logs. A trip means a distributed
    // guessing campaign (or someone deliberately locking the admin out).
    globalFailures.alerted = true;
    console.error("SECURITY: instance-wide failed-auth budget exhausted (" + GLOBAL_BUDGET.MAX + " failures / 15 min) — throttling all callers on this instance.");
  }
  return exhausted;
}
function checkRateLimit(bucket) {
  if (globalBudgetExhausted()) return { allowed: false, message: "Too many failed attempts on this server. Try again in 15 minutes." };
  const entry = rateMap.get(bucket) || { attempts: 0, lockUntil: 0 };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Locked for ${mins} more minute(s).` };
  }
  if (entry.lockUntil && Date.now() >= entry.lockUntil) { entry.attempts = 0; entry.lockUntil = 0; }
  return { allowed: true, entry };
}
function recordFailure(bucket, entry) {
  globalBudgetExhausted();
  globalFailures.count++;
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts >= RL.MAX_ATTEMPTS) entry.lockUntil = Date.now() + RL.LOCK_MS;
  rateMap.delete(bucket);
  evictIfFull();
  rateMap.set(bucket, entry);
}
function clearAttempts(bucket) { rateMap.delete(bucket); }

// ── Constant-time comparison: hash both sides to equal length first so
// timingSafeEqual never throws and length is not leaked either. ──
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ── Service account loader. Preferred: FIREBASE_CLIENT_EMAIL +
// FIREBASE_PRIVATE_KEY (smaller — Netlify/AWS cap ALL function env vars
// at 4 KB combined). Also accepts the whole JSON in
// FIREBASE_SERVICE_ACCOUNT (raw or base64). ──
function loadServiceAccount() {
  let email = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  let key = process.env.FIREBASE_PRIVATE_KEY || "";
  if ((!email || !key) && process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    const decoders = [
      () => JSON.parse(raw),
      () => JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    ];
    for (const decode of decoders) {
      try {
        const j = decode();
        if (j && typeof j.client_email === "string" && typeof j.private_key === "string") {
          email = j.client_email.trim();
          key = j.private_key;
          break;
        }
      } catch { /* try the next encoding */ }
    }
  }
  if (!email || !key) return null;
  key = key.replace(/\\n/g, "\n").trim();
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) return null;
  return { email, key };
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJwt(sa, payload) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createSign("RSA-SHA256").update(header + "." + body).sign(sa.key);
  return header + "." + body + "." + b64url(signature);
}
function mintAdminCustomToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(sa, {
    iss: sa.email,
    sub: sa.email,
    aud: CUSTOM_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 3600, // Firebase maximum for custom tokens
    uid: ADMIN_UID,
    claims: { admin: true }
  });
}

function responseHeaders() {
  const h = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export async function handler(event) {
  const headers = responseHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
  if (ADMIN_PASSWORD.length < MIN_SERVER_PASSWORD_LEN) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: `Server not configured: set ADMIN_PASSWORD (min ${MIN_SERVER_PASSWORD_LEN} chars) in Netlify environment variables.` }) };
  }
  const sa = loadServiceAccount();
  if (!sa) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: "Server not configured: set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Netlify environment variables." }) };
  }

  const ip = clientBucket(event);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) return { statusCode: 429, headers, body: JSON.stringify({ error: rl.message }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length > MAX_PASSWORD_LEN) {
    recordFailure(ip, rl.entry);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!safeEqual(password, ADMIN_PASSWORD)) {
    recordFailure(ip, rl.entry);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  clearAttempts(ip);

  try {
    const token = mintAdminCustomToken(sa);
    return { statusCode: 200, headers, body: JSON.stringify({ token, uid: ADMIN_UID, expiresIn: 3600 }) };
  } catch (e) {
    // Never echo key material; the message from createSign is generic.
    console.error("admin-auth: token signing failed —", e && e.message ? e.message.slice(0, 120) : "unknown");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not issue session. Check FIREBASE_PRIVATE_KEY format." }) };
  }
}

// Exposed for the regression test suite only.
export const __test = { safeEqual, loadServiceAccount, signJwt, mintAdminCustomToken, rateMap, globalFailures, clientBucket };
