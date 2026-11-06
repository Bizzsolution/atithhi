// AUDIT-2 regression suite for the Netlify functions.
// Every check here FAILS against the pre-audit-2 functions and PASSES
// against the patched ones.
//   node security_audit_2_test.mjs [path/to/netlify/functions]
import { generateKeyPairSync, createVerify } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const DIR = process.argv[2] || new URL("../netlify/functions", import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✓", label); }
  else { fail++; console.log("  ✗ FAIL:", label, extra !== undefined ? "-> " + JSON.stringify(extra).slice(0, 240) : ""); }
};
let bust = 0;
const load = async name => import(pathToFileURL(`${DIR}/${name}.mjs`).href + "?v=" + (++bust));
const parse = r => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };

// ── Service account + fake Google (OAuth, Firestore REST, Gemini) ──
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_ENV = {
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-test@atithibook-saas.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n")
};
function setEnv(extra) {
  for (const k of ["ADMIN_PASSWORD", "ADMIN_SECRET", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_SERVICE_ACCOUNT", "GEMINI_API_KEY", "GROQ_API_KEY", "VALID_LICENSES", "URL", "ALLOW_SUPPORT_OVERRIDE"]) delete process.env[k];
  Object.assign(process.env, SA_ENV, extra || {});
}
const FS = {};
const fsDoc = fields => ({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } } : { stringValue: String(v) }])) });
const calls = [];
let geminiMode = "ok";
globalThis.fetch = async (url, init) => {
  init = init || {};
  url = String(url);
  calls.push({ url, init });
  const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
  if (url === "https://oauth2.googleapis.com/token") {
    const [h, p, s] = (new URLSearchParams(init.body).get("assertion") || "").split(".");
    const ok = createVerify("RSA-SHA256").update(h + "." + p).verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    return ok ? json(200, { access_token: "ya29.test", expires_in: 3600 }) : json(400, {});
  }
  const m = url.match(/\/documents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if ((init.headers || {}).Authorization !== "Bearer ya29.test") return json(403, {});
    return FS[path] ? json(200, FS[path]) : json(404, {});
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    if (geminiMode === "fail") return json(403, { error: { message: "PROJECT_SECRET_DETAIL: billing account 0X1-ABC disabled for project atithibook-saas" } });
    return json(200, { candidates: [{ content: { parts: [{ text: "{\"name\":\"X\"}" }] } }] });
  }
  return json(500, {});
};
const firestoreCalls = () => calls.filter(c => c.url.includes("firestore.googleapis.com")).length;

let ipSeq = 0;
const freshIp = () => "198.51.100." + ((++ipSeq % 250) + 1) + "";
const ev = (body, ip, headers) => ({
  httpMethod: "POST",
  headers: Object.assign({ "x-nf-client-connection-ip": ip || ("192.0.2." + ((++ipSeq % 250) + 1)) }, headers || {}),
  body: JSON.stringify(body)
});

FS["licenses/ATITHI-GOODHOTEL01"] = fsDoc({ key: "ATITHI-GOODHOTEL01", active: true, phone: "+91 98765 43210, 9811122233", plan: "PRO", features: ["family"] });
FS["licenses/ATITHI-REVOKED00001"] = fsDoc({ key: "ATITHI-REVOKED00001", active: false, phone: "9876500000", plan: "PRO" });
const SECRET = "Adm1n-Bypass-Secret!";

// ═══ F1 — verify-access admin bypass ═══
console.log("\n=== F1: verify-access admin bypass ===");
setEnv({ ALLOW_SUPPORT_OVERRIDE: "true", ADMIN_SECRET: SECRET });
let va = await load("verify-access");
let r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: SECRET, deviceId: "dev-1" }));
check("bypass on a real license succeeds", r.statusCode === 200 && parse(r).ok === true, parse(r));
check("bypass returns the hotel's registered phone as boundPhone (so the app never stores the secret)", parse(r).boundPhone === "9876543210", parse(r));
check("bypass response never echoes the secret", !r.body.includes(SECRET));
r = await va.handler(ev({ licenseKey: "ATITHI-DOESNOTEXIST1", phone: SECRET }));
check("bypass for a NON-EXISTENT license is refused (404)", r.statusCode === 404 && parse(r).ok === false, parse(r));
check("…and mints no token", parse(r).token === undefined);
r = await va.handler(ev({ licenseKey: "ATITHI-REVOKED00001", phone: SECRET }));
check("bypass for a REVOKED license is refused (403)", r.statusCode === 403, parse(r));
r = await va.handler(ev({ licenseKey: "not-a-key/../../admin", phone: SECRET }));
check("bypass with a malformed key is refused before anything else (404)", r.statusCode === 404 && parse(r).adminOverride === undefined, parse(r));
setEnv({ ALLOW_SUPPORT_OVERRIDE: "true", ADMIN_SECRET: SECRET, VALID_LICENSES: "ATITHI-ENVONLYKEY1:2099-12-31" });
va = await load("verify-access");
r = await va.handler(ev({ licenseKey: "ATITHI-ENVONLYKEY1", phone: SECRET }));
check("bypass still works for a legacy VALID_LICENSES-only key (boundPhone empty)", r.statusCode === 200 && parse(r).boundPhone === "", parse(r));
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "(+91) 98111-22233" }));
check("normal phone verification still works with formatted numbers", r.statusCode === 200 && parse(r).ok === true, parse(r));
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "\u202A+91 98765 43210\u202C" }));
check("numbers pasted from Android/WhatsApp contacts (bidi marks) still verify", r.statusCode === 200 && parse(r).ok === true, parse(r));
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "98765/43210" }));
check("numbers typed with a slash separator still verify", r.statusCode === 200 && parse(r).ok === true, parse(r));

// ═══ F7 — limiter hardening (verify-access) ═══
console.log("\n=== F7: rate limiter (verify-access) ===");
setEnv({ ALLOW_SUPPORT_OVERRIDE: "true", ADMIN_SECRET: SECRET });
va = await load("verify-access");
let last;
for (let i = 1; i <= 6; i++) last = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "9000000000" }, "2001:db8:abcd:12::" + i.toString(16)));
check("6th wrong attempt from rotating addresses in ONE IPv6 /64 is locked out (429)", last.statusCode === 429, { status: last.statusCode });

setEnv({ ALLOW_SUPPORT_OVERRIDE: "true", ADMIN_SECRET: SECRET });
va = await load("verify-access");
for (let i = 0; i < 5; i++) await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "9000000000" }, "203.0.113.77"));
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "9000000000" }, "203.0.113.77"));
check("attacker IP is locked", r.statusCode === 429);
for (let i = 0; i < 5100; i++) {
  const ip = "10." + ((i >> 16) & 255) + "." + ((i >> 8) & 255) + "." + (i & 255);
  await va.handler(ev({ licenseKey: "BAD", phone: "9000000000" }, ip)); // format failure: no Firestore call
}
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "9000000000" }, "203.0.113.77"));
check("flooding 5,100 other source IPs does NOT wipe the attacker's lockout", r.statusCode === 429, { status: r.statusCode });

setEnv({ ALLOW_SUPPORT_OVERRIDE: "true", ADMIN_SECRET: SECRET });
va = await load("verify-access");
let throttled = 0;
for (let i = 0; i < 80; i++) {
  const x = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "guess-" + i + "-zz" }, "100.64." + (i >> 8) + "." + (i & 255)));
  if (x.statusCode === 429) throttled++;
}
check("distributed ADMIN_SECRET guessing (80 IPs × 1 try) hits the instance-wide budget", throttled >= 10, { throttled });
r = await va.handler(ev({ licenseKey: "ATITHI-GOODHOTEL01", phone: "98765 43210" }, "100.65.0.1"));
check("…while real phone-number verifications are NOT throttled by that budget", r.statusCode === 200, { status: r.statusCode });

// ═══ F7 — admin-auth ═══
console.log("\n=== F7: rate limiter (admin-auth) ===");
setEnv({ ADMIN_PASSWORD: "Correct-Horse-Battery-1" });
let aa = await load("admin-auth");
let aaThrottled = 0;
for (let i = 0; i < 80; i++) {
  const x = await aa.handler(ev({ password: "wrong-" + i }, "100.70." + (i >> 8) + "." + (i & 255)));
  if (x.statusCode === 429) aaThrottled++;
}
check("admin password guessing spread over 80 IPs hits the instance-wide failure budget", aaThrottled >= 10, { aaThrottled });

// ═══ F6 — scan.mjs ═══
console.log("\n=== F6: scan ===");
setEnv({ GEMINI_API_KEY: "AIzaTEST", VALID_LICENSES: "ATITHI-REVOKED00001,ATITHI-GOODHOTEL01" });
let sc = await load("scan");
r = await sc.handler(ev({ license: "ATITHI-REVOKED00001", image: "QUJD", prompt: "Extract" }));
check("key REVOKED in Firestore stays revoked even if listed in VALID_LICENSES (403)", r.statusCode === 403, { status: r.statusCode, body: parse(r) });
r = await sc.handler(ev({ license: "ATITHI-GOODHOTEL01", image: "QUJD", prompt: "Extract" }));
check("active key still scans", r.statusCode === 200, { status: r.statusCode });

setEnv({ GEMINI_API_KEY: "AIzaTEST" });
sc = await load("scan");
calls.length = 0;
let sc429 = 0;
for (let i = 0; i < 80; i++) {
  const x = await sc.handler(ev({ license: "ATITHI-RANDOMGUESS" + i, image: "QUJD", prompt: "x" }, "198.18.0.9"));
  if (x.statusCode === 429) sc429++;
}
check("unauthenticated key-guessing from one client is rate-limited before license lookup", sc429 >= 40, { sc429 });
check("…bounding Firestore reads (≤ 2 per allowed request)", firestoreCalls() <= 2 * (80 - sc429) + 2, { firestoreCalls: firestoreCalls(), allowed: 80 - sc429 });
calls.length = 0;
for (let i = 0; i < 5; i++) await sc.handler(ev({ license: "ATITHI-SAMEBOGUSKEY", image: "QUJD", prompt: "x" }, "198.18.1." + (i + 1)));
check("repeating one bogus key is served from the negative cache (≤ 2 Firestore reads total)", firestoreCalls() <= 2, { firestoreCalls: firestoreCalls() });
if (sc.__test && sc.__test.notFoundCache) {
  const seeded = Date.now() - 30000;
  sc.__test.notFoundCache.set("ATITHI-SAMEBOGUSKEY", seeded);
  await sc.handler(ev({ license: "ATITHI-SAMEBOGUSKEY", image: "QUJD", prompt: "x" }, "198.18.3.1")); // cache hit
  check("a cache hit does NOT refresh the negative-cache timestamp", sc.__test.notFoundCache.get("ATITHI-SAMEBOGUSKEY") === seeded, { seeded, now: sc.__test.notFoundCache.get("ATITHI-SAMEBOGUSKEY") });
  sc.__test.notFoundCache.set("ATITHI-SAMEBOGUSKEY", Date.now() - 61000);
  FS["licenses/ATITHI-SAMEBOGUSKEY"] = fsDoc({ key: "ATITHI-SAMEBOGUSKEY", active: true });
  r = await sc.handler(ev({ license: "ATITHI-SAMEBOGUSKEY", image: "QUJD", prompt: "x" }, "198.18.2.1"));
  check("after the 60 s TTL a newly issued key is accepted", r.statusCode === 200, { status: r.statusCode });
} else {
  check("negative cache is inspectable for the TTL test", false, "no __test.notFoundCache export");
}

setEnv({ GEMINI_API_KEY: "AIzaTEST" });
sc = await load("scan");
geminiMode = "fail";
r = await sc.handler(ev({ license: "ATITHI-GOODHOTEL01", image: "QUJD", prompt: "Extract" }));
geminiMode = "ok";
check("provider failure → 503", r.statusCode === 503, { status: r.statusCode });
check("provider error text (account/billing details) is NOT returned to the client", !r.body.includes("PROJECT_SECRET_DETAIL") && parse(r).details === undefined, r.body);

console.log(`\n=== AUDIT-2 FUNCTIONS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
