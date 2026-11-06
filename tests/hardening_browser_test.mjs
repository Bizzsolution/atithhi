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
const PORT = 8991;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-HARDENTEST1";
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

console.log("\n=== Session: shared cloud 'cu' no longer logs anyone in ===");
globalThis.__SEED = seedCloud({ cu: { u: "owner", name: "Rakesh", role: "Owner" }, users: JSON.parse(USERS) });
let p = await newPage(FE, { ab_license_key: KEY, ab_verified_phone: "9876543210", ab_cu: JSON.stringify({ u: "owner", name: "Rakesh", role: "Owner" }) });
await p.page.waitForTimeout(2000);
check("fresh device with key + phone lands on the LOGIN screen (no password-less Owner)", (await p.page.locator('input[placeholder="Enter password"]').count()) === 1);
check("stale cloud 'cu' document cleared", (await cloud(p.page, "cu")).value === null);
check("local ab_cu edit does not grant a session", await p.page.evaluate(() => JSON.parse(localStorage.getItem("ab_cu") || "null") === null));
await p.ctx.close();
globalThis.__SEED = "";

console.log("\n=== Multi-device: a booking/room saved by ANOTHER device is not overwritten ===");
p = await newPage(FE, STORE);
await login(p.page, "owner", "OwnerPass@1");
await checkInVia(p.page, "101", "First Guest", "9810000001");
// Another device checks in room 103 and the change has not reached this device yet:
await p.page.evaluate(k => {
  const b = window.__store["hotels/" + k + "/data/bookings"];
  b.value.push({ id: "BKREMOTE1", roomId: "103", name: "Remote Guest", mobile: "9000000003", status: "active", checkIn: new Date().toISOString().slice(0, 10), checkOut: new Date(Date.now() + 86400000).toISOString().slice(0, 10), charges: [] });
  const r = window.__store["hotels/" + k + "/data/rooms"];
  r.value = r.value.map(x => x.id === "103" ? { ...x, status: "occupied", bookingId: "BKREMOTE1" } : x);
}, KEY);
await checkInVia(p.page, "102", "Second Guest", "9810000002");
let bk = (await cloud(p.page, "bookings")).value;
check("cloud keeps the other device's booking AND both of ours", ["First Guest", "Second Guest", "Remote Guest"].every(n => bk.some(b => b.name === n)), bk.map(b => b.name));
let rm = (await cloud(p.page, "rooms")).value;
check("room 103 (occupied by the other device) is NOT reset to empty", rm.find(r => r.id === "103").status === "occupied" && rm.find(r => r.id === "102").status === "occupied", rm.slice(0, 3));
await nav(p.page, "Billing");
check("the other device's guest now also shows on this device", /Remote Guest/.test(await p.page.content()));
// remote checkout must not be undone by a stale local save
await p.page.evaluate(k => { const b = window.__store["hotels/" + k + "/data/bookings"]; b.value = b.value.map(x => x.name === "First Guest" ? { ...x, status: "checkedout", checkOutActual: new Date().toISOString().slice(0, 10), grandTotal: 999 } : x); }, KEY);
await checkInVia(p.page, "104", "Third Guest", "9810000004");
bk = (await cloud(p.page, "bookings")).value;
check("a checkout done on another device is not undone", bk.find(b => b.name === "First Guest").status === "checkedout", bk.find(b => b.name === "First Guest"));
check("audit log records WHO did it (not 'unknown')", await p.page.evaluate(() => JSON.parse(localStorage.getItem("ab_audit") || "[]").filter(x => x.action === "CHECKIN").every(x => /Rakesh \(Owner\)/.test(x.user))), await p.page.evaluate(() => JSON.parse(localStorage.getItem("ab_audit") || "[]").slice(-3)));
check("merge unit: charges added elsewhere are kept, voided ones are not resurrected", await p.page.evaluate(() => {
  const l = [{ id: "A", status: "active", charges: [{ id: "c1" }], voidedCharges: [{ id: "c3" }] }];
  const s = [{ id: "A", status: "active", charges: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] }, { id: "B", status: "active" }, { id: "ARCH", status: "checkedout" }];
  const m = mergeBookingLists(l, s, new Set(["ARCH"]));
  return m.length === 2 && m[0].charges.map(c => c.id).join() === "c1,c2" && m[1].id === "B";
}));
check("wipe guard: users/rooms cannot be overwritten with []", await p.page.evaluate(async k => { await WS.set("users", []); await WS.set("rooms", []); return window.__store["hotels/" + k + "/data/rooms"].value.length > 0 && JSON.parse(localStorage.getItem("ab_users")).length > 0; }, KEY));
console.log("\n=== CSV formula injection ===");
const csv = await p.page.evaluate(() => bookingsToCSV([{ id: "BK1", name: '=HYPERLINK("http://evil","x")', mobile: "+91 98100 12345", roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-02", status: "checkedout", roomTotal: 100, charges: [] }], CURRENT_ROOMS));
const row = csv.split(/\r?\n/)[1] || "";
check("formula neutralised in Guest-History CSV", /"'=HYPERLINK/.test(row) && !/,"?=HYPERLINK/.test(row), row.slice(0, 120));
check("phone number stays readable (no apostrophe)", row.includes("+91 98100 12345") && !row.includes("'+91"), row.slice(0, 160));
check("no page errors", p.errors.length === 0, p.errors);
await p.ctx.close();

console.log("\n=== Scale: big hotel stays under Firestore's 1 MiB per document ===");
const old = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
const mkBk = i => ({ id: "BKOLD" + i, roomId: "201", name: "Old Guest " + i, mobile: "98" + String(10000000 + i), address: "House " + i + ", Lajpat Nagar Part 2, New Delhi 110024", status: "checkedout", checkIn: old, checkOut: old, checkOutActual: old, grandTotal: 3990, subTotal: 3560, gstAmt: 430, invoiceNo: "INV/26-27/" + String(i).padStart(6, "0"), charges: Array.from({ length: 6 }, (_, j) => ({ id: "c" + i + "_" + j, name: "Masala Chai", price: 30, qty: 2, cat: "☕ Beverages", src: "restaurant", date: old, time: "09:15", by: "Restaurant Staff" })), gstBreakdown: Object.fromEntries(Array.from({ length: 80 }, (_, j) => ["field" + j, 1234.5])) });
const many = Array.from({ length: 600 }, (_, i) => mkBk(i));
globalThis.__SEED = seedCloud({ bookings: many });
p = await newPage(FE, { ...STORE, ab_bookings: JSON.stringify(many) });
await login(p.page, "owner", "OwnerPass@1");
const before = JSON.stringify((await cloud(p.page, "bookings")).value).length;
await checkInVia(p.page, "105", "New Guest", "9810000005");
const live = (await cloud(p.page, "bookings")).value;
const liveBytes = JSON.stringify(live).length;
check("live bookings doc was over the safe size (" + Math.round(before / 1024) + " KB) and is now under 1 MiB (" + Math.round(liveBytes / 1024) + " KB)", before > 1000000 && liveBytes < 1000000, { before, liveBytes });
check("new check-in saved in live doc", live.some(b => b.name === "New Guest"));
const mk = "bookings_archive_" + old.slice(0, 4) + "_" + old.slice(5, 7);
const base = await cloud(p.page, mk);
const p2 = await p.page.evaluate(([k, m]) => window.__store["hotels/" + k + "/data/" + m + "_p2"], [KEY, mk]);
check("month archive split into parts, each under 1 MiB", base && base.parts >= 2 && p2 && JSON.stringify(base).length < 1000000 && JSON.stringify(p2).length < 1000000, { parts: base && base.parts, b: base && JSON.stringify(base).length, p2: p2 && JSON.stringify(p2).length });
const archivedCount = await p.page.evaluate(m => WS.getArchiveMonth(m).then(a => a.length), mk);
check("no record lost: live + archive = 600 old + 1 new", archivedCount + live.length === 601, { archivedCount, live: live.length });
const ids = new Set([...(await p.page.evaluate(m => WS.getArchiveMonth(m).then(a => a.map(x => x.id)), mk)), ...live.map(b => b.id)]);
check("no duplicates between live and archive", ids.size === 601);
check("archived records have no photos / raw IDs (sanitised)", await p.page.evaluate(m => WS.getArchiveMonth(m).then(a => a.every(x => !x.photoFront && !x.signature)), mk));
await checkInVia(p.page, "201", "Another Guest", "9810000006");
const live2 = (await cloud(p.page, "bookings")).value;
const arch2 = await p.page.evaluate(m => WS.getArchiveMonth(m).then(a => a.length), mk);
check("next save archives the rest — still nothing lost", arch2 + live2.length === 602 && JSON.stringify(live2).length < 1000000, { arch2, live: live2.length });
check("no page errors (scale)", p.errors.length === 0, p.errors);
await p.ctx.close();
globalThis.__SEED = "";

await browser.close(); server.close();
console.log(`\n=== HARDENING (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
