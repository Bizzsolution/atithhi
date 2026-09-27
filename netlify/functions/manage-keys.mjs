// AtithiBook — API Key Status Checker
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
//
// IMPORTANT ARCHITECTURE NOTE:
// Netlify Functions are isolated per-file — scan.mjs and this function do NOT
// share memory. True "update key instantly without redeploy" requires a shared
// persistent store (e.g. Netlify Blobs or Firestore), which either breaks
// drag-and-drop deploys (Blobs needs npm install) or needs service-account auth
// (Firestore REST). To keep deploys 100% reliable, this function is STATUS-ONLY:
// it tells the admin whether keys are configured, and the actual key value must
// be set/changed in Netlify dashboard → Environment Variables (takes ~10-20 sec
// to go live after "Deploy" → "Trigger deploy" → "Clear cache and deploy").

import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const rateMap = new Map();
function checkRateLimit(ip) {
  const entry = rateMap.get(ip) || { attempts: 0, lockUntil: 0 };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Locked for ${mins} more minute(s).` };
  }
  return { allowed: true, entry };
}
function recordFailure(ip, entry) {
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts >= 5) entry.lockUntil = Date.now() + 15 * 60 * 1000;
  rateMap.set(ip, entry);
  if (rateMap.size > 5000) rateMap.clear();
}
function clearAttempts(ip) { rateMap.delete(ip); }

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
  // Same-origin callers need no CORS header; never fall back to "*".
  if (process.env.URL || process.env.DEPLOY_PRIME_URL) headers["Access-Control-Allow-Origin"] = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const validAdminKey = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;
  if (!validAdminKey) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: "Server not configured. Set ADMIN_SECRET env var in Netlify." }) };
  }

  const ip = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: rl.message }) };
  }

  const adminKey = String(event.headers["x-admin-key"] || event.headers["X-Admin-Key"] || "").trim();
  // Constant-time compare. The former 401 "diagnostic" block disclosed the
  // secret's length plus its first and last characters — ADMIN_SECRET is
  // also verify-access's bypass code, so that was a partial credential
  // leak to any unauthenticated caller. Removed entirely.
  if (!adminKey || adminKey.length > 256 || !safeEqual(adminKey, validAdminKey.trim())) {
    recordFailure(ip, rl.entry);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  clearAttempts(ip);

  if (event.httpMethod === "GET") {
    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        groq: {
          configured: !!groqKey,
          masked: groqKey ? "gsk_..." + groqKey.slice(-4) : null
        },
        gemini: {
          configured: !!geminiKey,
          masked: geminiKey ? "AIza..." + geminiKey.slice(-4) : null
        },
        note: "To change a key: Netlify dashboard → Site settings → Environment variables → edit GROQ_API_KEY / GEMINI_API_KEY → Deploys → Trigger deploy → Clear cache and deploy. Takes ~20-30 seconds."
      })
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
}
