// AtithiBook — Phone-Bound License Verification
// Ensures a license key can only be activated on a device where the
// entered phone number matches what the admin recorded when generating
// that key — so a leaked/found key alone is useless without also knowing
// the registered phone number. ADMIN_SECRET (already used elsewhere as the
// trusted admin credential) doubles as a bypass code here, checked
// SERVER-SIDE ONLY — it is never sent to or readable by the client, unlike
// a client-side check which anyone could extract from the page source.

const rateMap = new Map();
function checkRateLimit(ip) {
  const entry = rateMap.get(ip) || { attempts: 0, lockUntil: 0 };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Try again in ${mins} minute(s).` };
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

// Normalize so "+91 98765 43210", "91-9876543210", "9876543210" etc. all
// compare equal — keep only digits, then drop a leading "91" country code
// if the result is longer than a plain 10-digit Indian mobile number.
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  return digits.slice(-10); // last 10 digits, in case of stray leading zeros etc.
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": process.env.URL || process.env.DEPLOY_PRIME_URL || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  const ip = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: rl.message }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
  const licenseKey = String(body.licenseKey || "").trim().toUpperCase();
  const phone = String(body.phone || "").trim();

  if (!licenseKey || !phone) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "License key and phone number are both required." }) };
  }

  // Admin bypass — checked server-side only, never exposed to the client.
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && phone === adminSecret) {
    clearAttempts(ip);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, adminOverride: true }) };
  }

  try {
    const url = `https://firestore.googleapis.com/v1/projects/atithibook-saas/databases/(default)/documents/admin/licenses`;
    const r = await fetch(url);
    if (!r.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: "Could not reach license records right now. Try again." }) };
    }
    const doc = await r.json();
    const values = doc?.fields?.list?.arrayValue?.values || [];
    const entry = values.find(v => (v.mapValue?.fields?.key?.stringValue || "").toUpperCase() === licenseKey);

    if (!entry) {
      recordFailure(ip, rl.entry);
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "License key not found." }) };
    }

    const recordedPhoneRaw = entry.mapValue?.fields?.phone?.stringValue || "";
    if (!recordedPhoneRaw) {
      // No phone was ever registered for this key (e.g. an older key from
      // before this feature existed) — fail open rather than lock out an
      // existing legitimate hotel that never had a phone recorded.
      clearAttempts(ip);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, noPhoneOnRecord: true }) };
    }

    // A key can have MULTIPLE registered phones (e.g. Owner + Manager, each
    // on their own device) — comma-separated. Matching ANY one is enough.
    const recordedPhones = recordedPhoneRaw.split(",").map(p => normalizePhone(p)).filter(Boolean);
    if (recordedPhones.includes(normalizePhone(phone))) {
      clearAttempts(ip);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    recordFailure(ip, rl.entry);
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Phone number doesn't match our records for this license key." }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Verification failed: " + e.message }) };
  }
}
