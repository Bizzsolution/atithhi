// AtithiBook Admin API — License Management
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
// SECURITY: No hardcoded fallback password. Fails closed if env var missing.
// Rate-limited (in-memory, best-effort) against brute-force guessing.

import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(ha, hb);
}

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

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type,x-admin-key",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
  if (process.env.URL || process.env.DEPLOY_PRIME_URL) headers["Access-Control-Allow-Origin"] = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // ── FAIL CLOSED: if ADMIN_PASSWORD not configured server-side, deny all access ──
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: "Server not configured. Set ADMIN_PASSWORD env var in Netlify." }) };
  }

  // ── RATE LIMITING — prevent brute-force guessing ──
  const ip = clientBucket(event);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: rl.message }) };
  }

  // ── AUTH CHECK ──
  const adminKey = String(event.headers["x-admin-key"] || "");
  if (!adminKey || adminKey.length > 256 || !safeEqual(adminKey, ADMIN_PASSWORD)) {
    recordFailure(ip, rl.entry);
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  clearAttempts(ip);

  const licenses = (process.env.VALID_LICENSES || "")
    .split(",").map(k => k.trim().toUpperCase()).filter(Boolean);

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers, body: JSON.stringify({ licenses, total: licenses.length }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
}
