// AtithiBook — Phone-Bound License Verification
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
//
// Ensures a license key can only be activated on a device where the
// entered phone number matches what the admin recorded when generating
// that key. ADMIN_SECRET doubles as a bypass code, checked SERVER-SIDE
// ONLY with a constant-time comparison.
//
// SECURITY CHANGES (audit 2026-09):
//  • License records are now read with the service account. The hardened
//    firestore.rules deny ALL public reads of licenses/ and admin/, so the
//    registered phone numbers — the second factor this function checks —
//    are no longer downloadable by anyone who merely holds the key.
//  • Key format is validated before any Firestore path is built.
//  • Admin bypass uses timingSafeEqual (no timing oracle on ADMIN_SECRET).
//  • Internal error messages are no longer echoed to the client.
//
// AD-1 REMEDIATION (audit follow-up, see SECURITY_AUDIT.md):
//  • On any successful verification, also mint a Firebase custom token
//    bound to THIS hotel — uid "hotel:<KEY>:<deviceId>", claim
//    {hotelId: <KEY>}. index.html signs into it (best-effort; see the
//    HotelAuth module in index.html), so firestore.rules can eventually
//    require a verified identity instead of trusting knowledge of the
//    license key alone. Phase 1 (this change): issue tokens; rules still
//    ALSO accept the legacy key-shape check, so no already-deployed device
//    is broken by this. Phase 2 (later, once admin/authVersion adoption
//    looks complete): rules drop the legacy check and require
//    request.auth.token.hotelId only.
//  • Token minting NEVER blocks or fails the verification result itself —
//    if signing fails for any reason (missing service account, etc.) the
//    response is still returned exactly as before, just without a token.

import { createSign, createHash, timingSafeEqual } from "node:crypto";

const FIREBASE_PROJECT_ID = "atithibook-saas";
const LICENSE_KEY_RE = /^ATITHI-[A-Z0-9]{1,33}$/;
const DEVICE_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CUSTOM_TOKEN_AUDIENCE = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

// ── Rate limiting (in-memory, per function instance) ──────────────────
// AUDIT-2 (F7) hardening of the previous limiter:
//  • Buckets are keyed by IPv4 address or IPv6 /64 prefix. Keying on the
//    full IPv6 address let one client rotate through the 2^64 addresses
//    of its own allocation and get 5 fresh attempts per address.
//  • Overflow EVICTS the oldest unlocked buckets instead of Map.clear().
//    clear() let anyone who could generate ~5000 source addresses wipe
//    every active lockout, including their own.
//  • A separate instance-wide budget throttles inputs that are not
//    phone-shaped — the only inputs that can be ADMIN_SECRET guesses —
//    so a distributed guessing campaign is capped per instance without
//    ever throttling real hotel staff typing real phone numbers.
const RL = { MAX_ATTEMPTS: 5, LOCK_MS: 15 * 60 * 1000, MAX_BUCKETS: 5000, EVICT_SCAN: 256 };
const SECRET_BUDGET = { MAX: 60, WINDOW_MS: 15 * 60 * 1000 };
const rateMap = new Map();
const secretBudget = { windowStart: 0, count: 0, alerted: false };

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
  // Every scanned bucket is an active lockout: drop the oldest one rather
  // than grow without bound. Locked buckets only reach the front of the
  // map after MAX_BUCKETS newer failures, so this is a last resort.
  const oldest = rateMap.keys().next();
  if (!oldest.done) rateMap.delete(oldest.value);
}
function checkRateLimit(bucket) {
  const entry = rateMap.get(bucket) || { attempts: 0, lockUntil: 0 };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Try again in ${mins} minute(s).` };
  }
  if (entry.lockUntil && Date.now() >= entry.lockUntil) { entry.attempts = 0; entry.lockUntil = 0; }
  return { allowed: true, entry };
}
function recordFailure(bucket, entry) {
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts >= RL.MAX_ATTEMPTS) entry.lockUntil = Date.now() + RL.LOCK_MS;
  rateMap.delete(bucket);          // re-insert at the young end of the LRU order
  evictIfFull();
  rateMap.set(bucket, entry);
}
function clearAttempts(bucket) { rateMap.delete(bucket); }
function secretBudgetExhausted() {
  const now = Date.now();
  if (now - secretBudget.windowStart > SECRET_BUDGET.WINDOW_MS) { secretBudget.windowStart = now; secretBudget.count = 0; secretBudget.alerted = false; }
  const exhausted = secretBudget.count >= SECRET_BUDGET.MAX;
  if (exhausted && !secretBudget.alerted) {
    secretBudget.alerted = true;
    console.error("SECURITY: verify-access non-phone input budget exhausted (" + SECRET_BUDGET.MAX + " / 15 min) — likely ADMIN_SECRET guessing; admin override paused on this instance.");
  }
  return exhausted;
}
function consumeSecretBudget() { secretBudgetExhausted(); secretBudget.count++; }

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// Normalize so "+91 98765 43210", "91-9876543210", "9876543210" etc. all
// compare equal — keep only digits, drop a leading "91" country code.
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  return digits.slice(-10);
}

// A real phone entry: digits with optional +, spaces, dashes or brackets,
// normalizing to exactly 10 digits. Anything else (letters, symbols) can
// only be an ADMIN_SECRET attempt or garbage.
// Invisible formatting characters (bidi marks, zero-width spaces, BOM)
// that Android contacts / WhatsApp wrap around copied numbers.
const INVISIBLE_FORMAT_RE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
function isPhoneShaped(raw) {
  const s = String(raw || "").replace(INVISIBLE_FORMAT_RE, "").trim();
  return /^[0-9+\s\-()./]{7,28}$/.test(s) && normalizePhone(s).length === 10;
}

// VALID_LICENSES env fallback ("KEY" or "KEY:YYYY-MM-DD", comma-separated).
function envLicenseListed(licenseKey) {
  return (process.env.VALID_LICENSES || "").split(",")
    .map(e => (e.trim().split(":")[0] || "").toUpperCase())
    .some(k => k && k === licenseKey);
}

// ── Service-account Firestore access (bypasses rules; server-only) ──
function loadServiceAccount() {
  let email = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  let key = process.env.FIREBASE_PRIVATE_KEY || "";
  if ((!email || !key) && process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    for (const decode of [() => JSON.parse(raw), () => JSON.parse(Buffer.from(raw, "base64").toString("utf8"))]) {
      try {
        const j = decode();
        if (j && typeof j.client_email === "string" && typeof j.private_key === "string") { email = j.client_email.trim(); key = j.private_key; break; }
      } catch { /* try the next encoding */ }
    }
  }
  if (!email || !key) return null;
  key = key.replace(/\\n/g, "\n").trim();
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) return null;
  return { email, key };
}
const b64url = input => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function signJwt(sa, payload) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return header + "." + body + "." + b64url(createSign("RSA-SHA256").update(header + "." + body).sign(sa.key));
}
const tokenCache = { value: null, exp: 0, pending: null };
async function getAccessToken(sa) {
  if (tokenCache.value && tokenCache.exp - 60000 > Date.now()) return tokenCache.value;
  if (tokenCache.pending) return tokenCache.pending;
  tokenCache.pending = (async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const assertion = signJwt(sa, { iss: sa.email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString()
      });
      if (!r.ok) throw new Error("OAuth token exchange failed (HTTP " + r.status + ")");
      const d = await r.json();
      if (!d.access_token) throw new Error("OAuth token exchange returned no access_token");
      tokenCache.value = d.access_token;
      tokenCache.exp = Date.now() + (Number(d.expires_in) || 3600) * 1000;
      return tokenCache.value;
    } finally { tokenCache.pending = null; }
  })();
  return tokenCache.pending;
}
// AD-1: mint a hotel-scoped custom token. Best-effort — returns null (never
// throws) on any failure, since a missing/misconfigured service account
// must not break the verification response clients already depend on.
function mintHotelToken(licenseKey, deviceId) {
  try {
    const sa = loadServiceAccount();
    if (!sa) return null;
    if (!LICENSE_KEY_RE.test(licenseKey)) return null;
    const safeDevice = DEVICE_ID_RE.test(deviceId || "") ? deviceId : "unknown";
    const now = Math.floor(Date.now() / 1000);
    return signJwt(sa, {
      iss: sa.email,
      sub: sa.email,
      aud: CUSTOM_TOKEN_AUDIENCE,
      iat: now,
      exp: now + 3600,
      uid: `hotel:${licenseKey}:${safeDevice}`,
      claims: { hotelId: licenseKey }
    });
  } catch (e) {
    console.error("verify-access: hotel token minting failed —", e && e.message ? e.message.slice(0, 120) : "unknown");
    return null;
  }
}

async function firestoreGetDoc(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const sa = loadServiceAccount();
  const headers = {};
  if (sa) headers.Authorization = "Bearer " + await getAccessToken(sa);
  else console.error("verify-access: FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY not set — falling back to unauthenticated read (fails once hardened rules are published).");
  return fetch(url, { headers });
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

// Looks a license up in licenses/{KEY}, then the legacy admin/licenses
// array. Returns the Firestore field map, or null when the key is absent
// from both. Throws Error("UNAVAILABLE") when Firestore cannot answer, so
// "could not check" is never confused with "checked and not found".
async function lookupLicense(licenseKey) {
  const direct = await firestoreGetDoc("licenses/" + encodeURIComponent(licenseKey));
  if (direct.ok) {
    const doc = await direct.json();
    if ((doc.fields?.key?.stringValue || "").toUpperCase() === licenseKey) return doc.fields;
  } else if (direct.status !== 404) {
    throw new Error("UNAVAILABLE");
  }
  const legacy = await firestoreGetDoc("admin/licenses");
  if (!legacy.ok && legacy.status !== 404) throw new Error("UNAVAILABLE");
  if (legacy.ok) {
    const doc = await legacy.json();
    const values = doc?.fields?.list?.arrayValue?.values || [];
    const hit = values.find(v => (v.mapValue?.fields?.key?.stringValue || "").toUpperCase() === licenseKey);
    if (hit) return hit.mapValue.fields;
  }
  return null;
}

function registeredPhones(fields) {
  return String(fields?.phone?.stringValue || "").split(",").map(p => normalizePhone(p)).filter(p => p.length === 10);
}

export async function handler(event) {
  const headers = responseHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  const bucket = clientBucket(event);
  const rl = checkRateLimit(bucket);
  if (!rl.allowed) return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: rl.message }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  if (!body || typeof body !== "object") body = {};
  const licenseKey = String(typeof body.licenseKey === "string" ? body.licenseKey : "").trim().toUpperCase();
  const phone = String(typeof body.phone === "string" ? body.phone : "").trim();
  const deviceId = String(typeof body.deviceId === "string" ? body.deviceId : "").trim();

  if (!licenseKey || !phone) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "License key and phone number are both required." }) };
  }
  if (phone.length > 256) {
    recordFailure(bucket, rl.entry);
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid phone number." }) };
  }
  // AUDIT-2 (F1): the key format is validated BEFORE the admin bypass. The
  // bypass used to answer ok:true for any string at all, which made it a
  // free oracle for ADMIN_SECRET with no license involved.
  if (!LICENSE_KEY_RE.test(licenseKey)) {
    recordFailure(bucket, rl.entry);
    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
  }

  const phoneShaped = isPhoneShaped(phone);
  if (!phoneShaped && secretBudgetExhausted()) {
    return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: "Too many attempts. Try again later." }) };
  }

  let fields;
  try {
    fields = await lookupLicense(licenseKey);
  } catch (e) {
    console.error("verify-access:", e && e.message ? e.message.slice(0, 160) : "unknown");
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not reach license records right now. Try again." }) };
  }

  // Admin bypass — constant-time, server-side only.
  // AUDIT-2 (F1): (a) only for a license that actually exists (Firestore or
  // the VALID_LICENSES env list) and is not revoked; (b) the response
  // carries `boundPhone` — the hotel's own registered number — which the
  // app stores as the device's verified phone INSTEAD of what was typed.
  // Older builds persisted the typed value, i.e. ADMIN_SECRET itself, in
  // the hotel device's localStorage and re-sent it on every boot.
  // SECURITY (2026-10 hardening): typing ADMIN_SECRET into the phone field
  // used to unlock ANY hotel — one shared secret, typed on customer devices,
  // was a master key to every hotel's data. It is now OFF unless the
  // Netlify env var ALLOW_SUPPORT_OVERRIDE is exactly "true" (turn it on only
  // for a support visit, then off again). The normal support path is: admin
  // panel → edit the license's phone list → hotel enters that phone.
  const adminSecret = process.env.ALLOW_SUPPORT_OVERRIDE === "true" ? process.env.ADMIN_SECRET : "";
  if (adminSecret && adminSecret.length >= 8 && safeEqual(phone, adminSecret)) {
    if (!fields && !envLicenseListed(licenseKey)) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
    }
    if (fields && fields.active?.booleanValue === false) {
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "This license has been deactivated. Restore it in the admin panel first." }) };
    }
    clearAttempts(bucket);
    const token = mintHotelToken(licenseKey, deviceId);
    const boundPhone = fields ? (registeredPhones(fields)[0] || "") : "";
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, adminOverride: true, boundPhone, ...(token ? { token } : {}) }) };
  }
  if (!phoneShaped) consumeSecretBudget();

  if (!fields) {
    recordFailure(bucket, rl.entry);
    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
  }

  // A revoked license must not activate new devices.
  if (fields.active?.booleanValue === false) {
    recordFailure(bucket, rl.entry);
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "This license has been deactivated. Contact support." }) };
  }

  const recordedPhoneRaw = fields.phone?.stringValue || "";
  if (!recordedPhoneRaw) {
    // Legacy key with no phone on record — allowed, but license documents
    // are admin-write-only, so nobody can strip a phone to reach this
    // branch; only genuinely old keys land here.
    clearAttempts(bucket);
    const token = mintHotelToken(licenseKey, deviceId);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, noPhoneOnRecord: true, ...(token ? { token } : {}) }) };
  }

  const entered = normalizePhone(phone);
  if (phoneShaped && entered && registeredPhones(fields).some(p => safeEqual(p, entered))) {
    clearAttempts(bucket);
    const token = mintHotelToken(licenseKey, deviceId);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...(token ? { token } : {}) }) };
  }

  recordFailure(bucket, rl.entry);
  return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Phone number doesn't match our records for this license key." }) };
}

export const __test = { safeEqual, normalizePhone, isPhoneShaped, clientBucket, rateMap, secretBudget, tokenCache, mintHotelToken, DEVICE_ID_RE, LICENSE_KEY_RE };
