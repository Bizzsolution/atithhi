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

import { createSign, createHash, timingSafeEqual } from "node:crypto";

const FIREBASE_PROJECT_ID = "atithibook-saas";
const LICENSE_KEY_RE = /^ATITHI-[A-Z0-9]{1,33}$/;

const rateMap = new Map();
function checkRateLimit(ip) {
  const entry = rateMap.get(ip) || { attempts: 0, lockUntil: 0 };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Try again in ${mins} minute(s).` };
  }
  if (entry.lockUntil && Date.now() >= entry.lockUntil) { entry.attempts = 0; entry.lockUntil = 0; }
  return { allowed: true, entry };
}
function recordFailure(ip, entry) {
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts >= 5) entry.lockUntil = Date.now() + 15 * 60 * 1000;
  if (rateMap.size > 5000) rateMap.clear();
  rateMap.set(ip, entry);
}
function clearAttempts(ip) { rateMap.delete(ip); }

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

export async function handler(event) {
  const headers = responseHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"])) || "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.allowed) return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: rl.message }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  const licenseKey = String(body.licenseKey || "").trim().toUpperCase();
  const phone = String(body.phone || "").trim();

  if (!licenseKey || !phone) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "License key and phone number are both required." }) };
  }
  if (phone.length > 256) {
    recordFailure(ip, rl.entry);
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid phone number." }) };
  }

  // Admin bypass — constant-time, server-side only.
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && adminSecret.length >= 8 && safeEqual(phone, adminSecret)) {
    clearAttempts(ip);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, adminOverride: true }) };
  }

  if (!LICENSE_KEY_RE.test(licenseKey)) {
    recordFailure(ip, rl.entry);
    return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
  }

  try {
    let fields = null;
    const direct = await firestoreGetDoc("licenses/" + encodeURIComponent(licenseKey));
    if (direct.ok) {
      const doc = await direct.json();
      if ((doc.fields?.key?.stringValue || "").toUpperCase() === licenseKey) fields = doc.fields;
    } else if (direct.status !== 404) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not reach license records right now. Try again." }) };
    }

    if (!fields) {
      const legacy = await firestoreGetDoc("admin/licenses");
      if (!legacy.ok && legacy.status !== 404) {
        return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not reach license records right now. Try again." }) };
      }
      if (legacy.ok) {
        const doc = await legacy.json();
        const values = doc?.fields?.list?.arrayValue?.values || [];
        const hit = values.find(v => (v.mapValue?.fields?.key?.stringValue || "").toUpperCase() === licenseKey);
        if (hit) fields = hit.mapValue.fields;
      }
    }

    if (!fields) {
      recordFailure(ip, rl.entry);
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
    }

    // A revoked license must not activate new devices.
    if (fields.active?.booleanValue === false) {
      recordFailure(ip, rl.entry);
      return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "This license has been deactivated. Contact support." }) };
    }

    const recordedPhoneRaw = fields.phone?.stringValue || "";
    if (!recordedPhoneRaw) {
      // Legacy key with no phone on record — allowed, but now that license
      // documents are admin-write-only nobody can strip a phone to reach
      // this branch; only genuinely old keys land here.
      clearAttempts(ip);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, noPhoneOnRecord: true }) };
    }

    const recordedPhones = recordedPhoneRaw.split(",").map(p => normalizePhone(p)).filter(Boolean);
    const entered = normalizePhone(phone);
    if (entered && recordedPhones.some(p => safeEqual(p, entered))) {
      clearAttempts(ip);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    recordFailure(ip, rl.entry);
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Phone number doesn't match our records for this license key." }) };
  } catch (e) {
    console.error("verify-access:", e && e.message ? e.message.slice(0, 160) : "unknown");
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Verification failed. Try again in a moment." }) };
  }
}

export const __test = { safeEqual, normalizePhone, rateMap, tokenCache };
