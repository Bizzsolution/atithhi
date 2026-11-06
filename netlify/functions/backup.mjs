// AtithiBook — Scheduled server-side backups (Netlify Scheduled Function)
// No external npm dependencies — safe for drag-and-drop Netlify deploys.
//
// WHY: every hotel's data lives in a handful of whole-array documents that
// any device holding the license key may overwrite. A buggy save, a
// two-device race, or someone with the key writing `value: []` could wipe a
// legally-required guest register, and there was no copy anyone could roll
// back to. This function copies each hotel's important documents, once a
// day, into backups/{KEY}/snaps/{YYYY-MM-DD}__{doc} — a path NO client can
// write (firestore.rules: admin may read/list, nobody may write; this
// function uses the service account, which bypasses rules). The admin panel
// (Data Manager → 🛟 Auto Backups) lists and restores them.
//
// Schedule: netlify.toml → [functions."backup"] schedule = "@hourly".
// Each run handles the hotels whose key hashes to the current UTC hour, so
// every hotel is backed up once a day and no single run is long (Netlify
// scheduled functions have a ~30 s limit). Retention: BACKUP_KEEP_DAYS
// (default 14) daily snapshots; older ones are deleted.
//
// Env: FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (or
// FIREBASE_SERVICE_ACCOUNT), optional BACKUP_KEEP_DAYS.

import { createSign, createHash } from "node:crypto";

const FIREBASE_PROJECT_ID = "atithibook-saas";
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const LICENSE_KEY_RE = /^ATITHI-[A-Z0-9]{1,33}$/;
// Documents worth a daily copy. Archive months are added per run (this
// month + last month, incl. their _pN parts). Session/telemetry docs skipped.
const CORE_DOCS = ["bookings", "rooms", "users", "profile", "permissions", "reservations", "creditNotes", "menu", "audit"];
const TIME_BUDGET_MS = 24000;
const CONCURRENCY = 6;

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

async function api(method, path, body) {
  const sa = loadServiceAccount();
  if (!sa) throw new Error("NO_SERVICE_ACCOUNT");
  const r = await fetch(BASE + "/" + path, {
    method,
    headers: { Authorization: "Bearer " + await getAccessToken(sa), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(method + " " + path.split("?")[0] + " → HTTP " + r.status);
  return r.status === 204 ? {} : r.json();
}

// Every license key: per-document licenses/ collection + legacy array.
async function allLicenseKeys() {
  const keys = new Map(); // key -> active
  let pageToken = "";
  for (let guard = 0; guard < 50; guard++) {
    const q = "licenses?pageSize=300&mask.fieldPaths=key&mask.fieldPaths=active" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const page = await api("GET", q);
    for (const d of (page && page.documents) || []) {
      const k = String(d.fields?.key?.stringValue || d.name.split("/").pop() || "").toUpperCase();
      if (LICENSE_KEY_RE.test(k)) keys.set(k, d.fields?.active?.booleanValue !== false);
    }
    pageToken = page && page.nextPageToken;
    if (!pageToken) break;
  }
  try {
    const legacy = await api("GET", "admin/licenses");
    for (const v of legacy?.fields?.list?.arrayValue?.values || []) {
      const f = v.mapValue?.fields || {};
      const k = String(f.key?.stringValue || "").toUpperCase();
      if (LICENSE_KEY_RE.test(k) && !keys.has(k)) keys.set(k, f.active?.booleanValue !== false);
    }
  } catch (e) { /* legacy doc optional */ }
  return keys;
}

const hourOf = key => createHash("sha256").update(key).digest()[0] % 24;
const ymd = d => d.toISOString().slice(0, 10);
const monthKey = d => "bookings_archive_" + d.getUTCFullYear() + "_" + String(d.getUTCMonth() + 1).padStart(2, "0");

async function backupHotel(key, today) {
  const ids = [...CORE_DOCS];
  const now = new Date();
  for (const m of [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))]) {
    const mk = monthKey(m);
    const base = await api("GET", `hotels/${key}/data/${mk}?mask.fieldPaths=parts`).catch(() => null);
    if (!base) continue;
    ids.push(mk);
    const parts = Number(base.fields?.parts?.integerValue || base.fields?.parts?.doubleValue || 1);
    for (let i = 2; i <= Math.min(parts, 30); i++) ids.push(mk + "_p" + i);
  }
  let copied = 0;
  for (const id of ids) {
    const src = await api("GET", `hotels/${key}/data/${id}`);
    if (!src || !src.fields) continue;
    const fields = { ...src.fields, _backupAt: { integerValue: String(Date.now()) }, _srcDoc: { stringValue: id } };
    await api("PATCH", `backups/${key}/snaps/${today}__${id}`, { fields });
    copied++;
  }
  return copied;
}

async function pruneHotel(key, keepDays) {
  // Delete snapshots older than the retention window. Listing this one
  // hotel's snaps is cheap (≈ docs × days) and catches missed runs too.
  const cutoff = ymd(new Date(Date.now() - keepDays * 86400000));
  let pageToken = "", deleted = 0;
  for (let guard = 0; guard < 20; guard++) {
    const page = await api("GET", `backups/${key}/snaps?pageSize=300&mask.fieldPaths=_backupAt` + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""));
    for (const d of (page && page.documents) || []) {
      const id = d.name.split("/").pop();
      const day = id.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        const rel = d.name.split("/documents/")[1];
        await api("DELETE", rel).catch(() => {});
        deleted++;
      }
    }
    pageToken = page && page.nextPageToken;
    if (!pageToken) break;
  }
  return deleted;
}

let lastRunAt = 0;
export async function handler(event) {
  const started = Date.now();
  // Scheduled invocations arrive as POST with {next_run}. Anything else, or
  // a burst of calls on one instance, is ignored — this function only ever
  // copies data into an admin-only area, but it should not be a free
  // "make lots of writes" button either.
  if (event && event.httpMethod && event.httpMethod !== "POST") return { statusCode: 405, body: "" };
  if (started - lastRunAt < 10 * 60 * 1000) return { statusCode: 200, body: JSON.stringify({ skipped: "ran recently" }) };
  lastRunAt = started;
  if (!loadServiceAccount()) {
    console.error("backup: service account env vars missing — no backups taken");
    return { statusCode: 500, body: JSON.stringify({ error: "not configured" }) };
  }
  const keepDays = Math.max(3, Math.min(60, Number(process.env.BACKUP_KEEP_DAYS) || 14));
  const hour = new Date().getUTCHours();
  const today = ymd(new Date());
  let done = 0, docs = 0, failed = 0, pruned = 0, skippedTime = 0;
  try {
    const keys = await allLicenseKeys();
    const mine = [...keys.entries()].filter(([k, active]) => active && hourOf(k) === hour).map(([k]) => k);
    let i = 0;
    const worker = async () => {
      while (i < mine.length) {
        const key = mine[i++];
        if (Date.now() - started > TIME_BUDGET_MS) { skippedTime++; continue; }
        try {
          docs += await backupHotel(key, today);
          pruned += await pruneHotel(key, keepDays);
          done++;
        } catch (e) {
          failed++;
          console.error("backup " + key.slice(0, 10) + "…: " + String(e && e.message || e).slice(0, 120));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`backup hour ${hour}: hotels ${done}/${mine.length}, docs ${docs}, pruned ${pruned}, failed ${failed}, out-of-time ${skippedTime}`);
    return { statusCode: 200, body: JSON.stringify({ hour, hotels: mine.length, done, docs, pruned, failed, skippedTime }) };
  } catch (e) {
    console.error("backup run failed:", String(e && e.message || e).slice(0, 200));
    return { statusCode: 500, body: JSON.stringify({ error: "backup failed" }) };
  }
}

export const __test = { hourOf, backupHotel, pruneHotel, allLicenseKeys, tokenCache, reset: () => { lastRunAt = 0; } };
