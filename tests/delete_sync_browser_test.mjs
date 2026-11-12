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
const PORT = 9011;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-DELSYNC01";
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
// Owner delete must reach the cloud (no red sync dot), and deletes that
// got stuck on a device under v5.22–v5.24.1 are sent up on next open.
// fake_firebase.js rejects `undefined` fields exactly like Firestore.
// ─────────────────────────────────────────────────────────────
console.log("\n=== Fresh delete syncs ===");
{
  const { ctx, page, errors } = await newPage(FE, STORE);
  await login(page, "owner", "OwnerPass@1");
  await checkInVia(page, "101", "Wrong Entry", "9810000101");
  const b = (await bookingsLS(page)).find(x => x.name === "Wrong Entry");
  await nav(page, "Billing");
  await page.click("text=Wrong Entry"); await page.waitForTimeout(600);
  await page.click('[data-t="owner-delete"]'); await page.waitForTimeout(300);
  await page.fill("#bd-reason", "wrong entry");
  await page.click('[data-t="bd-confirm"]'); await page.waitForTimeout(2500);
  const cb = (await cloud(page, "bookings")).value.find(x => x.id === b.id);
  check("deleted entry is 'deleted' in the cloud", cb && cb.status === "deleted", cb);
  check("no cloud write rejected", (await page.evaluate(() => window.__rejectedWrites.length)) === 0, await page.evaluate(() => window.__rejectedWrites));
  const dot = await page.locator('[title="Synced to cloud"], [title="Offline — data saved locally"]').first().innerText().catch(() => "");
  check("sync dot is green, not red", dot.includes("🟢"), dot);
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
}

console.log("\n=== A booking with no Aadhaar field no longer blocks saving ===");
{
  globalThis.__SEED = seedCloud({ bookings: [{ id: "BKNOAAD", name: "Legacy", roomId: "102", checkIn: d(-3), checkOut: d(-2), status: "checkedout", roomTotal: 800, charges: [] }] });
  const { ctx, page } = await newPage(FE, STORE);
  await login(page, "owner", "OwnerPass@1");
  await checkInVia(page, "103", "After Legacy", "9810000103");
  const cl = (await cloud(page, "bookings")).value;
  check("new check-in saved next to a booking without Aadhaar", cl.some(x => x.name === "After Legacy") && cl.some(x => x.id === "BKNOAAD"));
  check("no cloud write rejected", (await page.evaluate(() => window.__rejectedWrites.length)) === 0, await page.evaluate(() => window.__rejectedWrites));
  await ctx.close();
}

console.log("\n=== Stuck delete from the old version is sent up on open ===");
{
  const active = { id: "BKSTUCK1", name: "Stuck Guest", mobile: "9810000999", aadhaar: "XXXX XXXX 1234", roomId: "104", checkIn: d(0), checkOut: d(1), status: "active", roomTotal: 1000, charges: [], family: [] };
  const stub = { id: "BKSTUCK1", status: "deleted", prevStatus: "active", name: "Stuck Guest", roomId: "104", checkIn: d(0), checkOut: d(1), invoiceNo: null, grandTotal: null, deletedAt: new Date().toISOString(), deletedBy: "Owner", deleteReason: "declined", editedAt: new Date().toISOString(), createdAt: null };
  globalThis.__SEED = seedCloud({ bookings: [active] });
  const { ctx, page } = await newPage(FE, { ...STORE, ab_bookings: JSON.stringify([stub]) });
  await login(page, "owner", "OwnerPass@1");
  await page.waitForTimeout(2500);
  const cb = (await cloud(page, "bookings")).value.find(x => x.id === "BKSTUCK1");
  check("cloud copy now 'deleted' (stub, no mobile/Aadhaar)", cb && cb.status === "deleted" && !cb.mobile && !cb.aadhaar, cb);
  check("no cloud write rejected", (await page.evaluate(() => window.__rejectedWrites.length)) === 0);
  await ctx.close();
}
await browser.close(); server.close();
console.log(`\n=== DELETE SYNC (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
