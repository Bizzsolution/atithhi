// Unit tests for netlify/functions/menu-extract.mjs — admin token check,
// input limits, model-output validation. No network: fetch is stubbed.
import { generateKeyPairSync, createSign } from "node:crypto";
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log("  ✓", l); } else { fail++; console.log("  ✗ FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x).slice(0, 300) : ""); } };

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
let aiReply = null, aiCalls = 0;
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("securetoken@system")) return { ok: true, headers: { get: () => "max-age=3600" }, json: async () => ({ keys: [jwk] }) };
  if (url.includes("generativelanguage")) { aiCalls++; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: aiReply }] } }] }) }; }
  throw new Error("unexpected fetch " + url);
};
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
function tok(over = {}, key = privateKey, hdr = {}) {
  const h = b64u({ alg: "RS256", kid: "k1", ...hdr });
  const p = b64u({ aud: "atithibook-saas", iss: "https://securetoken.google.com/atithibook-saas", sub: "bizzsathi-admin", admin: true, iat: now - 10, exp: now + 3000, ...over });
  const s = createSign("RSA-SHA256").update(h + "." + p).sign(key).toString("base64url");
  return h + "." + p + "." + s;
}
process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_MODELS = "gemini-flash-latest";
const mod = await import("../netlify/functions/menu-extract.mjs");
const { handler, __test } = mod;
let ipN = 0;
const call = (token, body, ip) => handler({ httpMethod: "POST", headers: { authorization: token ? "Bearer " + token : "", "x-nf-client-connection-ip": ip || ("10.0.0." + (++ipN)) }, body: JSON.stringify(body) });
const IMG = { mime: "image/jpeg", data: Buffer.from("fakejpegbytes").toString("base64") };

console.log("auth");
check("no token → 401", (await call("", IMG)).statusCode === 401);
check("garbage token → 401", (await call("a.b.c", IMG)).statusCode === 401);
check("wrong signing key → 401", (await call(tok({}, otherKey), IMG)).statusCode === 401);
check("wrong audience → 401", (await call(tok({ aud: "other-project" }), IMG)).statusCode === 401);
check("wrong issuer → 401", (await call(tok({ iss: "https://evil" }), IMG)).statusCode === 401);
check("expired → 401", (await call(tok({ exp: now - 600 }), IMG)).statusCode === 401);
check("alg none → 401", (await call(tok({}, privateKey, { alg: "none" }), IMG)).statusCode === 401);
check("hotel (non-admin) user → 403", (await call(tok({ sub: "hotel-user-1", admin: undefined }), IMG)).statusCode === 403);
check("admin uid without admin claim → 403", (await call(tok({ admin: false }), IMG)).statusCode === 403);
check("AI never called for rejected requests", aiCalls === 0, aiCalls);

console.log("input limits");
check("GET → 405", (await handler({ httpMethod: "GET", headers: {} })).statusCode === 405);
check("bad mime (svg) → 400", (await call(tok(), { mime: "image/svg+xml", data: IMG.data })).statusCode === 400);
check("too big → 413", (await call(tok(), { mime: "image/png", data: "A".repeat(6 * 1024 * 1024) })).statusCode === 413);
check("non-base64 → 400", (await call(tok(), { mime: "image/png", data: "<script>alert(1)</script>" })).statusCode === 400);

console.log("happy path");
aiReply = "```json\n" + JSON.stringify({ items: [
  { name: "Masala Chai", price: "₹20", category: "beverage", veg: true, section: "Hot drinks" },
  { name: "Chicken Biryani", price: 280, category: "food", veg: false },
  { name: "Laundry (per piece)", price: 30, category: "service" },
  { name: "", price: 50 }, { name: "Free water", price: 0 }, { name: "Gold plate", price: 999999 }
] }) + "\n```";
let r = await call(tok(), IMG);
let d = JSON.parse(r.body);
check("valid admin → 200", r.statusCode === 200, r);
check("3 valid items kept, junk dropped", d.items.length === 3, d.items);
check("price text cleaned (₹20 → 20)", d.items[0].price === 20);
check("categories mapped", d.items.map(i => i.category).join() === "beverage,food,service");
check("veg tri-state", d.items[0].veg === true && d.items[1].veg === false && d.items[2].veg === null);
check("response has no-store + nosniff", r.headers["Cache-Control"] === "no-store" && r.headers["X-Content-Type-Options"] === "nosniff");

console.log("model failures");
aiReply = "sorry I cannot read this";
r = await call(tok(), IMG);
check("unparseable model output → 502 UNREADABLE", r.statusCode === 502 && JSON.parse(r.body).code === "UNREADABLE");
delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
r = await call(tok(), IMG);
check("no AI key → 503 AI_UNAVAILABLE, no secrets in body", r.statusCode === 503 && JSON.parse(r.body).code === "AI_UNAVAILABLE" && !/key=|test-key/.test(r.body));

console.log("parseItems");
const p = __test.parseItems;
check("bare array accepted", p('[{"name":"Tea","price":10}]').length === 1);
check("name length capped at 60", p(JSON.stringify({ items: [{ name: "x".repeat(200), price: 5 }] }))[0].name.length === 60);
check("max 400 items", p(JSON.stringify({ items: Array.from({ length: 900 }, (_, i) => ({ name: "I" + i, price: 1 })) })).length === 400);
check("non-JSON → null", p("hello") === null);

console.log("rate limit");
let last;
for (let i = 0; i < 40; i++) last = await call("", IMG, "9.9.9.9");
check("per-IP rate limit → 429", last.statusCode === 429, last.statusCode);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
