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
const PORT = 8998;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-OWNERTEST1";
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
// Admin bill settings applied in the app + Owner edit/delete +
// text (vector) PDF for WhatsApp
// ─────────────────────────────────────────────────────────────
const FY = (() => { const x = new Date(), y = x.getFullYear(), s = x.getMonth() + 1 >= 4 ? y : y - 1; return String(s).slice(-2) + "-" + String(s + 1).slice(-2); })();
const ADMINCFG = {
  invoice: { title: "TAX INVOICE", hotelName: "HOTEL SHASHI RESIDENCY", address: "Near Railway Junction, Mathura-281001 (U.P)", phone: "9520998899", gstin: "09AMMPC5395E2ZT",
    website: "www.hotelshashiresidency.com", roomSac: "996311", prefix: "HSR", pad: 0, fy: true, footerNote: "Issue Cheque/D.D. in favour of Hotel Shashi Residency\nPayable at Mathura",
    checkoutNote: "Check out time 12 noon", jurisdiction: "Mathura", signatory: "Authorised Signatory" },
  bookingPrefix: "HSR", floorNames: { "1": "Ground Floor" }
};
globalThis.__SEED = seedCloud({ adminConfig: ADMINCFG, ["invCounter_" + FY]: 7 });
const { ctx, page, errors } = await newPage(["history", "csv_export", "roles"], STORE);
await login(page, "owner", "OwnerPass@1");
await page.waitForTimeout(800);

console.log("\n=== Admin config reaches the app ===");
await checkInVia(page, "101", "Rajeev Kumar", "8171601030");
let bk = (await bookingsLS(page)).find(b => b.name === "Rajeev Kumar");
check("booking ID uses admin prefix HSR", bk && /^HSR[0-9A-Z]{6}$/.test(bk.id), bk && bk.id);
let html = await page.evaluate(id => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.id === id); return buildInvoiceHTML(b, CURRENT_ROOMS.find(r => r.id === b.roomId)); }, bk.id);
check("invoice header from admin (name, GSTIN, website)", html.includes("HOTEL SHASHI RESIDENCY") && html.includes("GSTIN: 09AMMPC5395E2ZT") && html.includes("www.hotelshashiresidency.com"));
check("room line uses admin HSN/SAC 996311", /<td class="center">996311<\/td>/.test(html));
check("footer: remark, cheque note, jurisdiction, signatory", html.includes("Check out time 12 noon") && html.includes("Payable at Mathura") && html.includes("SUBJECT TO MATHURA JURISDICTION") && html.includes("Authorised Signatory"));
await nav(page, "Rooms");
check("floor name shown in Rooms", (await page.locator("text=Ground Floor").count()) > 0);
await nav(page, "Dashboard");
await page.locator('button:has-text("✏️")').first().click(); await page.waitForTimeout(500);
const g = page.locator('[data-t="set-gstin"]');
check("Settings: GSTIN locked with admin value", (await g.count()) === 1 && (await g.isDisabled()) && (await g.inputValue()) === "09AMMPC5395E2ZT");
check("Settings: lock note shown", (await page.locator('[data-t="inv-locked-note"]').count()) === 1);
await page.getByRole("button", { name: "Cancel", exact: true }).first().click(); await page.waitForTimeout(400);

console.log("\n=== Owner edits an in-house entry ===");
await nav(page, "Billing");
await page.click("text=Rajeev Kumar"); await page.waitForTimeout(600);
check("Owner sees edit/delete in booking", (await page.locator('[data-t="owner-actions"]').count()) === 1);
await page.click('[data-t="owner-edit"]'); await page.waitForTimeout(300);
await page.fill("#be-name", "Rajeev Kumar Singh");
await page.selectOption("#be-roomId", "102");
await page.fill("#be-rate", "2250");
await page.click('[data-t="be-save"]'); await page.waitForTimeout(2200);
bk = (await bookingsLS(page)).find(b => b.id === bk.id);
check("name, room, rate updated", bk.name === "Rajeev Kumar Singh" && bk.roomId === "102" && bk.roomTotal === 2250 * nightsOf(bk), bk);
check("edit history kept", Array.isArray(bk.editHistory) && bk.editHistory.length === 1 && bk.editHistory[0].from.roomId === "101");
let rooms = (await cloud(page, "rooms")).value;
check("room 101 freed, 102 occupied by this booking", rooms.find(r => r.id === "101").status === "empty" && rooms.find(r => r.id === "102").status === "occupied" && rooms.find(r => r.id === "102").bookingId === bk.id);

console.log("\n=== Checkout -> bill number from admin series + text PDF ===");
await page.click('button:has-text("Check Out & Settle")'); await page.waitForTimeout(300);
await page.locator('button:has-text("Cash")').last().click();
await page.evaluate(() => { navigator.canShare = () => true; navigator.share = async d => { window.__shared = d.files[0]; }; });
await page.click('button:has-text("Confirm Check Out")'); await page.waitForTimeout(2600);
bk = (await bookingsLS(page)).find(b => b.id === bk.id);
check("bill number = HSR/" + FY + "/8", bk.invoiceNo === "HSR/" + FY + "/8", bk.invoiceNo);
await page.click('button:has-text("📤 Share on WhatsApp")'); await page.waitForTimeout(3000);
const shared = await page.evaluate(async () => { const f = window.__shared; if (!f) return null; return { name: f.name, type: f.type, text: await f.text() }; });
check("WhatsApp gets a PDF file", shared && shared.type === "application/pdf" && /^%PDF/.test(shared.text) && /\.pdf$/.test(shared.name), shared && { name: shared.name, type: shared.type });
check("PDF has real text (guest, bill no, hotel)", shared && shared.text.includes("Rajeev Kumar Singh") && shared.text.includes("HSR/" + FY + "/8") && shared.text.includes("HOTEL SHASHI RESIDENCY"));
check("PDF is not a picture of the bill", shared && !/\/Subtype\s*\/Image/.test(shared.text));
check("PDF carries jurisdiction + footer", shared && shared.text.includes("SUBJECT TO MATHURA JURISDICTION") && shared.text.includes("Payable at Mathura"));
await page.click('button:has-text("← Back")').catch(() => {}); await page.waitForTimeout(400);

console.log("\n=== Owner edits a settled bill ===");
const before = bk.grandTotal;
await nav(page, "Vault");
await page.click("text=Rajeev Kumar Singh"); await page.waitForTimeout(800);
await page.click('[data-t="owner-edit"]'); await page.waitForTimeout(300);
await page.fill("#be-rate", "1800");
await page.click('[data-t="be-save"]'); await page.waitForTimeout(500);
check("settled bill edit needs a reason", (await bookingsLS(page)).find(b => b.id === bk.id).grandTotal === before);
await page.fill("#be-reason", "rate galat dala tha");
await page.click('[data-t="be-save"]'); await page.waitForTimeout(2200);
let ed = (await bookingsLS(page)).find(b => b.id === bk.id);
const expectG = await page.evaluate(id => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.id === id); const t = { ...b, status: "active" }; delete t.gstBreakdown; return calcBillGST(t, CURRENT_ROOMS.find(r => r.id === b.roomId), CURRENT_ROOMS, b.gstBreakdown.gstMode).grandTotal; }, bk.id);
check("settled bill totals rebuilt (rate 1800)", ed.status === "checkedout" && ed.roomTotal === 1800 * nightsOf(ed) && ed.grandTotal === expectG && ed.grandTotal < before && ed.invoiceNo === bk.invoiceNo, { before, after: ed.grandTotal, expectG });

console.log("\n=== Owner deletes ===");
await checkInVia(page, "103", "Declined Guest", "9810000099");
const dgb = (await bookingsLS(page)).find(b => b.name === "Declined Guest");
await nav(page, "Billing");
await page.click("text=Declined Guest"); await page.waitForTimeout(600);
await page.click('[data-t="owner-delete"]'); await page.waitForTimeout(300);
await page.fill("#bd-reason", "guest ne mana kar diya");
await page.click('[data-t="bd-confirm"]'); await page.waitForTimeout(2200);
rooms = (await cloud(page, "rooms")).value;
check("cancelled check-in: room 103 free again", rooms.find(r => r.id === "103").status === "empty");
let cb = (await cloud(page, "bookings")).value.find(b => b.id === dgb.id);
check("cloud keeps only a small stub (no mobile / ID / address)", cb && cb.status === "deleted" && !cb.mobile && !cb.aadhaar && !cb.address && cb.deleteReason === "guest ne mana kar diya", cb);
await nav(page, "Billing");
check("deleted entry gone from Billing", (await page.locator("text=Declined Guest").count()) === 0);
const merged = await page.evaluate(([id]) => mergeBookingLists([{ id, status: "active", name: "Declined Guest" }], [{ id, status: "deleted" }], new Set()), [dgb.id]);
check("an old copy on another device cannot bring it back", merged[0].status === "deleted");
const merged3 = await page.evaluate(() => mergeBookingLists([{ id: "Y", status: "deleted" }], [{ id: "Y", status: "checkedout", grandTotal: 5 }], new Set()));
check("deleting a settled bill reaches the cloud copy", merged3[0].status === "deleted");
const merged2 = await page.evaluate(() => mergeBookingLists([{ id: "X", status: "active", name: "Old", editedAt: "2026-01-01" }], [{ id: "X", status: "active", name: "New", editedAt: "2026-02-01" }], new Set()));
check("a newer Owner edit from another device wins over an old copy", merged2[0].name === "New");
await nav(page, "Vault");
await page.click("text=Rajeev Kumar Singh"); await page.waitForTimeout(800);
await page.click('[data-t="owner-delete"]'); await page.waitForTimeout(300);
await page.fill("#bd-reason", "galat entry");
await page.click('[data-t="bd-confirm"]'); await page.waitForTimeout(2200);
cb = (await cloud(page, "bookings")).value.find(b => b.id === bk.id);
check("settled bill deleted -> stub keeps bill number + reason", cb && cb.status === "deleted" && cb.invoiceNo === bk.invoiceNo && cb.deleteReason === "galat entry" && cb.prevStatus === "checkedout");
check("deleted bill gone from Vault list", (await page.locator("text=Rajeev Kumar Singh").count()) === 0);
check("no page errors", errors.length === 0, errors);
await ctx.close();

console.log("\n=== Manager: no edit/delete ===");
{
  const { ctx, page } = await newPage(["history", "csv_export", "roles"], STORE);
  await login(page, "admin", "Mgr@12345");
  await checkInVia(page, "104", "Mgr Guest", "9810000077").catch(() => {});
  await nav(page, "Billing");
  await page.click("text=Mgr Guest").catch(() => {}); await page.waitForTimeout(600);
  check("Manager does not see owner edit/delete", (await page.locator('[data-t="owner-actions"]').count()) === 0);
  await ctx.close();
}
await browser.close(); server.close();
console.log(`\n=== OWNER EDIT + BILL CONFIG + PDF (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
function nightsOf(b) { return Math.max(1, Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / 86400000)); }
