// AtithiBook — License Status (for the hotel app's expiry/feature banner)
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
//
// WHY THIS EXISTS
// The hotel app used to read `licenses/{key}` straight from Firestore's
// public REST endpoint (and, as a fallback, the legacy `admin/licenses`
// document holding EVERY hotel's record). That required those documents
// to be world-readable, which exposed each hotel's registered phone
// numbers — the very value verify-access uses as a second factor — and
// the owner's name to anyone holding a key. With the fallback, a single
// request downloaded the whole customer list.
//
// This function reads with the service account (so the rules can now
// deny all public reads) and returns ONLY what the app displays:
// active / plan / expiry / features. No phone, no owner, no other hotel.

import { createSign } from "node:crypto";

const FIREBASE_PROJECT_ID = "atithibook-saas";
const LICENSE_KEY_RE = /^ATITHI-[A-Z0-9]{1,33}$/;

// ── Per-IP rate limit (in-memory, best-effort per instance) ──
const rateMap = new Map();
function allowRequest(ip) {
  const now = Date.now();
  const e = rateMap.get(ip) || { count: 0, windowStart: now };
  if (now - e.windowStart > 60000) { e.count = 0; e.windowStart = now; }
  e.count++;
  if (rateMap.size > 5000) rateMap.clear();
  rateMap.set(ip, e);
  return e.count <= 60;
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
  else console.error("license-status: FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY not set — falling back to unauthenticated read (fails once hardened rules are published).");
  return fetch(url, { headers });
}

function publicView(fields) {
  const f = fields || {};
  return {
    found: true,
    active: f.active?.booleanValue !== false,
    plan: typeof f.plan?.stringValue === "string" ? f.plan.stringValue : "",
    expiry: typeof f.expiry?.stringValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.expiry.stringValue) ? f.expiry.stringValue : null,
    features: (f.features?.arrayValue?.values || []).map(x => x.stringValue).filter(v => typeof v === "string" && v.length <= 40)
  };
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
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const ip = (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"])) || "unknown";
  if (!allowRequest(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: "Too many requests" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  const key = String(body.licenseKey || "").trim().toUpperCase();
  if (!LICENSE_KEY_RE.test(key)) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid license key format" }) };

  try {
    const direct = await firestoreGetDoc("licenses/" + encodeURIComponent(key));
    if (direct.ok) {
      const doc = await direct.json();
      if ((doc.fields?.key?.stringValue || "").toUpperCase() === key) {
        return { statusCode: 200, headers, body: JSON.stringify(publicView(doc.fields)) };
      }
    } else if (direct.status !== 404) {
      return { statusCode: 503, headers, body: JSON.stringify({ error: "UNAVAILABLE" }) };
    }

    // Not-yet-migrated hotel: legacy single-array document (server-side only now).
    const legacy = await firestoreGetDoc("admin/licenses");
    if (legacy.ok) {
      const doc = await legacy.json();
      const values = doc?.fields?.list?.arrayValue?.values || [];
      const hit = values.find(v => (v.mapValue?.fields?.key?.stringValue || "").toUpperCase() === key);
      if (hit) return { statusCode: 200, headers, body: JSON.stringify(publicView(hit.mapValue.fields)) };
      return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    }
    if (legacy.status === 404) return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    return { statusCode: 503, headers, body: JSON.stringify({ error: "UNAVAILABLE" }) };
  } catch (e) {
    console.error("license-status:", e && e.message ? e.message.slice(0, 160) : "unknown");
    return { statusCode: 503, headers, body: JSON.stringify({ error: "UNAVAILABLE" }) };
  }
}

export const __test = { publicView, LICENSE_KEY_RE, tokenCache };
