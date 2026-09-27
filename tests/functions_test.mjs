// Regression suite for the Netlify functions (Node 18+ built-in test style).
// Usage: node functions_test.mjs [path/to/netlify/functions]
import { generateKeyPairSync, createVerify } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const DIR = process.argv[2] || new URL("../netlify/functions", import.meta.url).pathname;
const LABEL = DIR.includes("pre_audit") ? "PRE-AUDIT" : "PATCHED";
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x).slice(0, 300) : ""); } };
let bust = 0;
const load = async name => {
  const p = `${DIR}/${name}.mjs`;
  if (!fs.existsSync(p)) return null;
  return import(pathToFileURL(p).href + "?v=" + (++bust));
};

// ── Real RSA service account ──
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const SA_EMAIL = "firebase-adminsdk-test@atithibook-saas.iam.gserviceaccount.com";
function setEnv(extra) {
  for (const k of ["ADMIN_PASSWORD", "ADMIN_SECRET", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_SERVICE_ACCOUNT", "GEMINI_API_KEY", "GROQ_API_KEY", "VALID_LICENSES", "URL"]) delete process.env[k];
  Object.assign(process.env, extra || {});
}
const SA_ENV = { FIREBASE_CLIENT_EMAIL: SA_EMAIL, FIREBASE_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") }; // as pasted in Netlify
const ev = (method, body, headers) => ({ httpMethod: method, headers: Object.assign({ "x-nf-client-connection-ip": "203.0.113." + (++bust % 250) }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
const parse = r => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };

// ── Fake Google: OAuth + Firestore that enforces the HARDENED rules
// (anonymous reads of licenses/ and admin/ → 403), + Gemini recorder ──
const FS = {};
const calls = [];
function fsDoc(fields) {
  const conv = v => typeof v === "boolean" ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } } : { stringValue: String(v) };
  return { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, conv(v)])) };
}
globalThis.fetch = async (url, init) => {
  init = init || {};
  calls.push({ url: String(url), init });
  const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
  if (String(url) === "https://oauth2.googleapis.com/token") {
    const assertion = new URLSearchParams(init.body).get("assertion") || "";
    const [h, p, s] = assertion.split(".");
    const valid = createVerify("RSA-SHA256").update(h + "." + p).verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    return valid ? json(200, { access_token: "ya29.test", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
  }
  const m = String(url).match(/\/documents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    const authed = (init.headers || {}).Authorization === "Bearer ya29.test";
    if (/^(licenses|admin)\//.test(path) && !authed) return json(403, { error: { status: "PERMISSION_DENIED" } });
    return FS[path] ? json(200, FS[path]) : json(404, { error: { status: "NOT_FOUND" } });
  }
  if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
    return json(200, { candidates: [{ content: { parts: [{ text: "{\"name\":\"X\"}" }] } }] });
  }
  return json(500, {});
};

FS["licenses/ATITHI-HOTELGANGA01"] = fsDoc({ key: "ATITHI-HOTELGANGA01", plan: "PRO", active: true, phone: "9876543210", owner: "Suresh Kumar", features: ["family"] });
FS["licenses/ATITHI-REVOKED0001"] = fsDoc({ key: "ATITHI-REVOKED0001", plan: "PRO", active: false, phone: "9876543210" });

// ═════════ admin-auth ═════════
console.log("=== admin-auth.mjs ===");
const aa = await load("admin-auth");
check("admin-auth function exists", !!aa);
if (aa) {
  setEnv({});
  check("fails closed (503) with no env", (await aa.handler(ev("POST", { password: "x" }))).statusCode === 503);
  setEnv({ ADMIN_PASSWORD: "Str0ng-Server-Only-Pw!", ...SA_ENV });
  check("wrong password → 401", (await aa.handler(ev("POST", { password: "bizzsathi@2026" }))).statusCode === 401);
  check("non-string password → 401", (await aa.handler(ev("POST", { password: { $ne: "" } }))).statusCode === 401);
  check("GET → 405", (await aa.handler(ev("GET"))).statusCode === 405);
  const ok = await aa.handler(ev("POST", { password: "Str0ng-Server-Only-Pw!" }));
  const tok = parse(ok).token || "";
  check("correct password → 200 + token", ok.statusCode === 200 && tok.split(".").length === 3);
  if (tok) {
    const [h, p, s] = tok.split(".");
    const sigOk = createVerify("RSA-SHA256").update(h + "." + p).verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    const claims = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    check("token signature verifies with service-account public key", sigOk);
    check("token carries admin claim + fixed uid", claims.claims?.admin === true && claims.uid === "bizzsathi-admin");
    check("token audience is Identity Toolkit", claims.aud === "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
    check("token lifetime ≤ 3600s", claims.exp - claims.iat <= 3600);
    check("response never echoes the password", !ok.body.includes("Str0ng"));
  }
  const ip = { "x-nf-client-connection-ip": "198.51.100.7" };
  for (let i = 0; i < 5; i++) await aa.handler({ httpMethod: "POST", headers: ip, body: JSON.stringify({ password: "bad" + i }) });
  const locked = await aa.handler({ httpMethod: "POST", headers: ip, body: JSON.stringify({ password: "Str0ng-Server-Only-Pw!" }) });
  check("6th attempt from same IP locked out even with right password", locked.statusCode === 429);
  check("no wildcard CORS", !Object.values(ok.headers || {}).includes("*"));
}

// ═════════ manage-keys ═════════
console.log("=== manage-keys.mjs ===");
const mk = await load("manage-keys");
setEnv({ ADMIN_SECRET: "SuperSecretValue123" });
const r401 = await mk.handler(ev("GET", undefined, { "x-admin-key": "S" + "x".repeat(17) + "3" }));
const b401 = parse(r401);
check("401 on wrong key", r401.statusCode === 401);
check("401 body has NO diagnostic block", b401.diagnostic === undefined, b401);
check("401 body does not leak secret length/first/last char", !/19|S\.\.\.3/.test(r401.body), r401.body);
check("correct key still works", (await mk.handler(ev("GET", undefined, { "x-admin-key": "SuperSecretValue123" }))).statusCode === 200);

// ═════════ verify-access ═════════
console.log("=== verify-access.mjs ===");
const va = await load("verify-access");
setEnv({ ADMIN_SECRET: "AdminBypass#2026", ...SA_ENV });
let r = await va.handler(ev("POST", { licenseKey: "ATITHI-HOTELGANGA01", phone: "+91 98765 43210" }));
check("registered phone verifies under hardened rules (service-account read)", r.statusCode === 200 && parse(r).ok === true, parse(r));
r = await va.handler(ev("POST", { licenseKey: "ATITHI-HOTELGANGA01", phone: "9000000000" }));
check("wrong phone → 403", r.statusCode === 403);
r = await va.handler(ev("POST", { licenseKey: "ATITHI-REVOKED0001", phone: "9876543210" }));
check("revoked license cannot activate a new device", r.statusCode === 403, parse(r));
r = await va.handler(ev("POST", { licenseKey: "../admin/licenses", phone: "9876543210" }));
check("path-injection key rejected before any Firestore call", r.statusCode === 404 && !calls.some(c => c.url.includes("..")));
r = await va.handler(ev("POST", { licenseKey: "ATITHI-HOTELGANGA01", phone: "AdminBypass#2026" }));
check("admin bypass still works", r.statusCode === 200 && parse(r).adminOverride === true);
calls.length = 0;
fetch.__throwNext = true;
const origFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => { if (String(u).includes("/documents/")) throw new Error("SECRET-INTERNAL-DETAIL"); return origFetch(u, i); };
r = await va.handler(ev("POST", { licenseKey: "ATITHI-HOTELGANGA01", phone: "9876543210" }));
check("internal error text not echoed to client", !r.body.includes("SECRET-INTERNAL-DETAIL"), r.body);
globalThis.fetch = origFetch;

// ═════════ license-status ═════════
console.log("=== license-status.mjs ===");
const ls = await load("license-status");
check("license-status function exists", !!ls);
if (ls) {
  setEnv({ ...SA_ENV });
  r = await ls.handler(ev("POST", { licenseKey: "ATITHI-HOTELGANGA01" }));
  const d = parse(r);
  check("returns status fields", r.statusCode === 200 && d.found === true && d.plan === "PRO" && d.features.includes("family"), d);
  check("never returns phone or owner (no PII)", !("phone" in d) && !("owner" in d) && !r.body.includes("98765") && !r.body.includes("Suresh"));
  r = await ls.handler(ev("POST", { licenseKey: "ATITHI-NOPE000001" }));
  check("unknown key → found:false", parse(r).found === false);
  r = await ls.handler(ev("POST", { licenseKey: "ATITHI-X/../../admin" }));
  check("malformed key → 400", r.statusCode === 400);
}

// ═════════ scan ═════════
console.log("=== scan.mjs ===");
const sc = await load("scan");
setEnv({ GEMINI_API_KEY: "AIzaTESTKEY123", ...SA_ENV });
calls.length = 0;
r = await sc.handler(ev("POST", { license: "ATITHI-HOTELGANGA01", image: "QUJD", prompt: "Extract name as JSON" }));
check("valid license scans under hardened rules", r.statusCode === 200, parse(r));
const gem = calls.find(c => c.url.startsWith("https://generativelanguage.googleapis.com/"));
check("Gemini API key NOT in URL", gem && !gem.url.includes("AIzaTESTKEY123"), gem && gem.url);
check("Gemini API key sent in x-goog-api-key header", gem && (gem.init.headers || {})["x-goog-api-key"] === "AIzaTESTKEY123");
const gbody = gem ? JSON.parse(gem.init.body) : {};
check("server-side systemInstruction pins model to ID extraction", /identity documents/i.test(gbody.systemInstruction?.parts?.[0]?.text || ""));
r = await sc.handler(ev("POST", { license: "ATITHI-HOTELGANGA01", image: "<script>not-base64</script>", prompt: "x" }));
check("non-base64 image rejected", r.statusCode === 400);
r = await sc.handler(ev("POST", { license: { toUpperCase: 1 }, image: "QUJD", prompt: "x" }));
check("non-string license rejected cleanly (no 500)", r.statusCode === 400);
r = await sc.handler(ev("POST", { license: "ATITHI-REVOKED0001", image: "QUJD", prompt: "x" }));
check("revoked license denied", r.statusCode === 403);
r = await sc.handler({ httpMethod: "POST", headers: {}, body: "{not json" });
check("malformed JSON → 400 not 500", r.statusCode === 400);

console.log(`\n=== FUNCTIONS (${LABEL}): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
