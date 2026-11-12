// 2026-10 hardening (data-loss, scale, session) — browser test of the REAL index.html
// (Playwright + in-memory fake Firebase).
//   node hardening_browser_test.mjs [path/to/app-dir]
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(process.argv[2] || path.join(HERE, ".."));
const require = createRequire(import.meta.url);
const pkgDir = name => path.dirname(require.resolve(name + "/package.json"));
const REACT = fs.readFileSync(path.join(pkgDir("react"), "umd/react.production.min.js"));
const REACT_DOM = fs.readFileSync(path.join(pkgDir("react-dom"), "umd/react-dom.production.min.js"));
const FAKE_FB = fs.readFileSync(path.join(HERE, "fake_firebase.js"), "utf8");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const PORT = 8995;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-QRTEST1";
const legacyHash = pw => createHash("sha256").update(pw + "|AtithiSalt2024!").digest("hex");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✓", label); }
  else { fail++; console.log("  ✗ FAIL:", label, extra !== undefined ? "-> " + JSON.stringify(extra).slice(0, 300) : ""); }
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || !path.extname(p)) p = "/index.html";
  const f = path.join(APP, p);
  if (!f.startsWith(APP) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html; charset=utf-8" : p.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));
const CAM = process.env.QR_CAM || path.join(HERE, "fixtures", "aadhaar_cam.y4m");
const browser = await chromium.launch({ ...(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + CAM] });

async function newPage(features, storage, ctxOpts) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: "block", ...(ctxOpts || {}) });
  await ctx.addInitScript(s => {
    if (sessionStorage.getItem("__seeded")) return;
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    sessionStorage.setItem("__seeded", "1");
  }, storage);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const prompts = [];
  page.on("dialog", d => { if (d.type() === "prompt") d.accept(prompts.shift() ?? ""); else d.accept(); });
  const popups = [];
  ctx.on("page", p => popups.push(p));
  await page.route("**/*", async route => {
    const u = route.request().url();
    if (u.includes("unpkg.com/react-dom@")) return route.fulfill({ contentType: "text/javascript", body: REACT_DOM, headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.includes("unpkg.com/react@")) return route.fulfill({ contentType: "text/javascript", body: REACT, headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE_FB + (globalThis.__SEED || "") });
    if (u.includes("gstatic.com")) return route.fulfill({ contentType: "text/javascript", body: "/* stub */" });
    if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return route.fulfill({ contentType: "text/css", body: "" });
    if (u.endsWith("/api/verify-access")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    if (u.endsWith("/api/license-status")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ found: true, active: true, plan: "PREM", expiry: null, features }) });
    if (u.startsWith(`http://localhost:${PORT}`)) return route.continue();
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return { ctx, page, errors, prompts, popups };
}
async function login(page, u, p) {
  await page.fill('input[placeholder="Enter username"]', u);
  await page.fill('input[placeholder="Enter password"]', p);
  await page.click("text=Login to Dashboard");
  await page.waitForTimeout(2200);
}
const nav = async (page, label) => { await page.locator(`button:has-text("${label}")`).last().click(); await page.waitForTimeout(700); };
const navLabels = page => page.evaluate(() => [...document.querySelectorAll("button span:last-child")].map(s => s.textContent.trim()).filter(Boolean));
const bookingsLS = page => page.evaluate(() => JSON.parse(localStorage.getItem("ab_bookings") || "[]"));
const d = off => { const x = new Date(); x.setDate(x.getDate() + off); return x.toISOString().slice(0, 10); };

const FEATS = ["history", "csv_export", "roles", "restaurant"];
const USERS = JSON.stringify([
  { u: "owner", p: legacyHash("OwnerPass@1"), name: "Rakesh", role: "Owner", mustChange: false },
  { u: "admin", p: legacyHash("Mgr@12345"), name: "Manager", role: "Manager", mustChange: false },
  { u: "front", p: legacyHash("Front@1234"), name: "Front", role: "Receptionist", mustChange: false }
]);
const STORE = { ab_license_key: KEY, ab_verified_phone: "9876543210", ab_users: USERS };
const FE = ["history", "csv_export", "roles"];
const seedCloud = obj => "\n;(function(){" + Object.entries(obj).map(([k, v]) => `window.__store[${JSON.stringify("hotels/" + KEY + "/data/" + k)}] = ${JSON.stringify({ value: v, ts: Date.now() })};`).join("") + "})();";
const cloud = (pg, k) => pg.evaluate(([key, d]) => window.__store["hotels/" + key + "/data/" + d], [KEY, k]);
async function checkInVia(page, room, name, mobile) {
  await nav(page, "Check-In");
  await page.locator("select").first().selectOption(room);
  const dts = page.locator('input[type="date"]');
  await dts.nth(0).fill(d(0)); await dts.nth(1).fill(d(1));
  await page.fill('input[placeholder="As on Aadhaar Card"]', name);
  await page.fill('input[placeholder="As per Aadhaar"], textarea[placeholder="As per Aadhaar"]', "Delhi");
  await page.fill('input[placeholder="+91 XXXXX XXXXX"]', mobile);
  await page.locator('label:has-text("Guest Consent:") input[type="checkbox"]').check();
  await page.click("text=Confirm Check-In");
  await page.waitForTimeout(2200);
}

// ─────────────────────────────────────────────────────────────
// Aadhaar Secure QR — parser + live camera scan (fake camera feed of a
// synthetic UIDAI-format Secure QR, version 31 like real cards)
// ─────────────────────────────────────────────────────────────
const FX = path.join(HERE, "fixtures");
const V2 = fs.readFileSync(path.join(FX, "aadhaar_v2.txt"), "utf8").trim();
const V1 = fs.readFileSync(path.join(FX, "aadhaar_v1.txt"), "utf8").trim();
const { ctx, page, errors } = await newPage(["qr", "history"], STORE, { permissions: ["camera"] });

console.log("\n=== Parser ===");
let r = await page.evaluate(t => parseAadhaarSecureQR(t), V2);
check("V2: name / dob / gender", r.format === "secure_qr" && r.name === "Rajesh Kumar Sharma" && r.dob === "15-08-1985" && r.gender === "Male", r);
check("V2: address assembled", /H No 708/.test(r.address) && /PIN 281001/.test(r.address) && /Uttar Pradesh/.test(r.address), r.address);
check("V2: only last 4 of Aadhaar kept", r.aadhaar === "XXXX XXXX 1234", r.aadhaar);
check("V2: verify facts (format ok, version, mobile last 4)", r.verify && r.verify.structureOk && r.verify.version === "V2" && r.verify.mobileLast4 === "4321" && r.verify.aadhaarLast4 === "1234", r.verify);
r = await page.evaluate(t => parseAadhaarSecureQR(t), V1);
check("V1 (no version marker): fields read", r.format === "secure_qr" && r.name === "Rajesh Kumar Sharma" && r.verify.version === "V1" && r.verify.hasMobile === true && r.verify.hasEmail === true, r.verify);
r = await page.evaluate(() => parseAadhaarSecureQR("12345678901234567890123"));
check("random digits rejected", r.format === "unsupported");
let msg = await page.evaluate(t => parseAadhaarSecureQR(t).then(x => aadhaarQrVerifyMsg(x, "9876504321")), V2);
check("verify message: mobile match", /Asli UIDAI Secure QR/.test(msg) && /4321 ✅ match/.test(msg), msg);
msg = await page.evaluate(t => parseAadhaarSecureQR(t).then(x => aadhaarQrVerifyMsg(x, "9876501111")), V2);
check("verify message: mobile mismatch flagged", /match nahi/.test(msg), msg);

console.log("\n=== Live scan (fake camera) ===");
await login(page, "owner", "OwnerPass@1");
await nav(page, "Check-In");
await page.click('button:has-text("📷 Live QR Scan")');
let filled = false;
for (let i = 0; i < 40 && !filled; i++) {
  await page.waitForTimeout(500);
  filled = (await page.inputValue('input[placeholder="As on Aadhaar Card"]').catch(() => "")) === "Rajesh Kumar Sharma";
}
check("live scanner reads the dense Secure QR and fills the name", filled);
check("scanner closes after success", (await page.locator('text=📷 Live QR Scan').count()) >= 1 && (await page.locator('[data-t="qr-still"]').count()) === 0);
const addr = await page.inputValue('input[placeholder="As per Aadhaar"], textarea[placeholder="As per Aadhaar"]').catch(() => "");
check("address filled", /New Krishna Nagar/.test(addr), addr);
check("verification line shown", (await page.locator("text=Asli UIDAI Secure QR").count()) > 0);

console.log("\n=== Still photo button ===");
await page.fill('input[placeholder="As on Aadhaar Card"]', "");
await page.click('button:has-text("📷 Live QR Scan")'); await page.waitForTimeout(300);
await page.evaluate(() => { const b = document.querySelector('[data-t="qr-still"]'); b && b.click(); });
let ok2 = false;
for (let i = 0; i < 30 && !ok2; i++) { await page.waitForTimeout(400); ok2 = (await page.inputValue('input[placeholder="As on Aadhaar Card"]').catch(() => "")) === "Rajesh Kumar Sharma"; }
check("📸 Photo khicho also reads it", ok2);
check("no page errors", errors.length === 0, errors);
await ctx.close();
await browser.close(); server.close();
console.log(`\n=== AADHAAR QR (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
