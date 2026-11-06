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
const PORT = 8997;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-STUCKROOM01";
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
// Stuck room (occupied, no active booking) — Heera Continental room 302 case.
const FE = ["history", "csv_export", "roles"];
const msgs = [];
const today = new Date().toISOString().slice(0, 10), tmr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const rooms = [{ id: "301", fl: 3, type: "Standard", rate: 1000, status: "empty" }, { id: "302", fl: 3, type: "Standard", rate: 1000, status: "occupied", bookingId: "BKGONE" }, { id: "303", fl: 3, type: "Standard", rate: 1000, status: "occupied", bookingId: "BKREAL" }, { id: "304", fl: 3, type: "Standard", rate: 1000, status: "occupied", bookingId: "BKOLDID" }];
const bookings = [{ id: "BKREAL", roomId: "303", name: "Rakesh", mobile: "9", status: "active", checkIn: today, checkOut: tmr, charges: [] }, { id: "BKOTHER", roomId: "304", name: "Link Broken Guest", mobile: "9", status: "active", checkIn: today, checkOut: tmr, charges: [] }];
globalThis.__SEED = "\n;(function(){window.__store['hotels/" + KEY + "/data/rooms']=" + JSON.stringify({ value: rooms, ts: 1 }) + ";window.__store['hotels/" + KEY + "/data/bookings']=" + JSON.stringify({ value: bookings, ts: 1 }) + ";})();";
const { ctx, page, errors } = await newPage(FE, { ...STORE, ab_rooms: JSON.stringify(rooms), ab_bookings: JSON.stringify(bookings) });
page.on("dialog", dl => msgs.push(dl.message()));
await login(page, "owner", "OwnerPass@1");
await nav(page, "Rooms"); await page.waitForTimeout(600);
const row = id => page.locator('div', { hasText: new RegExp("^" + id) }).filter({ has: page.locator("text=" + id) });
const txt = await page.locator(".scrollable").first().innerText();
check("room 302 shows '⚠️ Stuck' and a hint", /Stuck/.test(txt) && /room free karo/.test(txt), txt.slice(0, 400));
check("room 303 (real guest) still shows Occupied + guest name", /Rakesh/.test(txt));
check("room 304 with broken id link finds its guest by room", /Link Broken Guest/.test(txt));
// tap 303 -> booking modal opens as before
await page.locator("text=Rakesh").first().click(); await page.waitForTimeout(500);
check("normal occupied room opens the bill (checkout possible)", await page.locator('button:has-text("Check Out & Settle")').count() > 0);
await page.keyboard.press("Escape"); await page.locator('button:has-text("✕")').first().click().catch(() => {});
await nav(page, "Dashboard"); await nav(page, "Rooms"); await page.waitForTimeout(400);
// another device's guest exists on the server for 302? -> must NOT free it
await page.evaluate(k => { const b = window.__store["hotels/" + k + "/data/bookings"]; b.value.push({ id: "BKNEW", roomId: "302", name: "Server Only Guest", mobile: "9", status: "active", checkIn: new Date().toISOString().slice(0,10), checkOut: new Date(Date.now()+86400000).toISOString().slice(0,10), charges: [] }); }, KEY);
await page.locator("text=Koi guest nahi").first().click(); await page.waitForTimeout(900);
check("if the server has a guest in 302, the room is NOT freed — that guest's bill opens", await page.locator('text=Server Only Guest').count() > 0 && (await page.evaluate(k => window.__store["hotels/" + k + "/data/rooms"].value.find(r => r.id === "302").status, KEY)) === "occupied");
await page.evaluate(k => { const b = window.__store["hotels/" + k + "/data/bookings"]; b.value = b.value.filter(x => x.id !== "BKNEW"); }, KEY);
await page.reload({ waitUntil: "load" }); await page.waitForTimeout(1500);
await login(page, "owner", "OwnerPass@1");
await nav(page, "Rooms"); await page.waitForTimeout(500);
await page.locator("text=Koi guest nahi").first().click(); await page.waitForTimeout(1200);
const r302 = await page.evaluate(k => window.__store["hotels/" + k + "/data/rooms"].value.find(r => r.id === "302"), KEY);
check("stuck room freed after confirm (cloud)", r302.status === "empty" && !r302.bookingId, r302);
check("other rooms untouched", await page.evaluate(k => { const v = window.__store["hotels/" + k + "/data/rooms"].value; return v.find(r => r.id === "303").status === "occupied" && v.find(r => r.id === "304").status === "occupied"; }, KEY));
check("confirm message explained the situation", msgs.some(m => /koi active guest nahi/.test(m)), msgs);
check("audit log records the release", await page.evaluate(() => JSON.parse(localStorage.getItem("ab_audit") || "[]").some(a => a.action === "ROOM_RELEASED_STUCK")));
await nav(page, "Check-In"); await page.waitForTimeout(400);
check("302 now selectable for a new check-in", await page.locator("select").first().locator('option[value="302"]').count() === 1);
check("no page errors", errors.length === 0, errors);
await ctx.close(); await browser.close(); server.close();
console.log(`\n=== STUCK ROOM FIX (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
