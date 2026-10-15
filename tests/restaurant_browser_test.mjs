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
const PORT = 8981;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-RESTOTEST01";
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
    if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE_FB });
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

console.log("\n=== Owner: restaurant counter → room bill ===");
const { ctx, page, errors, prompts, popups } = await newPage(FEATS, STORE);
await login(page, "owner", "OwnerPass@1");
check("Restaurant tab is visible when the add-on is on", (await navLabels(page)).includes("Restaurant"), await navLabels(page));

// Check a guest into room 102 through the real check-in screen.
await nav(page, "Check-In");
await page.locator("select").first().selectOption("102");
const dates = page.locator('input[type="date"]');
await dates.nth(0).fill(d(0)); await dates.nth(1).fill(d(2));
await page.fill('input[placeholder="As on Aadhaar Card"]', "Rajesh Sharma");
await page.fill('textarea[placeholder="As per Aadhaar"], input[placeholder="As per Aadhaar"]', "Lajpat Nagar, New Delhi");
await page.fill('input[placeholder="+91 XXXXX XXXXX"]', "9810012345");
await page.locator('label:has-text("Guest Consent:") input[type="checkbox"]').check();
await page.click("text=Confirm Check-In");
await page.waitForTimeout(1800);
check("guest checked in", (await bookingsLS(page)).some(b => b.roomId === "102" && b.status === "active"));

await nav(page, "Restaurant");
await page.click('button:has-text("Room 102")');
await page.waitForTimeout(300);
await page.click('button[aria-label="Aur jodo Chai"]');
await page.click('button[aria-label="Aur jodo Chai"]');
await page.click('button:has-text("🍛 Food")');
await page.click('button[aria-label="Aur jodo Dal Rice"]');
await shot(page, "1_counter_room");
const popupCountBefore = popups.length;
await page.click('button:has-text("Room 102 ke bill me jodo")');
await page.waitForTimeout(1500);
let bk = (await bookingsLS(page)).find(b => b.roomId === "102" && b.status === "active");
const ch = (bk && bk.charges) || [];
check("order lands on the room bill (2 lines)", ch.length === 2, ch);
check("each line is tagged Restaurant, time-stamped, attributed and carries its category", ch.every(c => c.src === "restaurant" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) && /^\d{2}:\d{2}$/.test(c.time) && c.by && c.cat && c.id && c.orderId), ch);
check("KOT number recorded on the order", ch.every(c => /^K\d{3}$/.test(c.kot)), ch.map(c => c.kot));
check("KOT kitchen slip opened for printing", popups.length === popupCountBefore + 1);
if (popups.length > popupCountBefore) {
  const kotHtml = await popups[popups.length - 1].content().catch(() => "");
  check("KOT slip lists the items and the room", /KITCHEN ORDER/.test(kotHtml) && /Chai/.test(kotHtml) && /Room 102/.test(kotHtml), kotHtml.slice(0, 200));
  await popups[popups.length - 1].close().catch(() => {});
}

// Room-service order from the Billing screen's Add Food modal.
await nav(page, "Billing");
await page.click("text=Rajesh Sharma");
await page.waitForTimeout(600);
await page.click("text=Add Food / Services");
await page.waitForTimeout(400);
await page.click('button:has-text("🛎️ Room Service")');
await page.click('button:has-text("☕ Beverages")').catch(() => {});
await page.click('button[aria-label="Aur jodo Coffee"]');
await shot(page, "2_addfood_modal");
await page.click('button:has-text("to Room Bill")');
await page.waitForTimeout(1500);
bk = (await bookingsLS(page)).find(b => b.roomId === "102" && b.status === "active");
const coffee = (bk.charges || []).find(c => c.name === "Coffee");
check("room-service order from Billing is tagged 'room'", coffee && coffee.src === "room" && coffee.time, coffee);

// Invoice shows each order as its own line with source + time.
const inv = await page.evaluate(() => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.roomId === "102" && x.status === "active"); return buildInvoiceHTML(b, CURRENT_ROOMS.find(r => r.id === "102")); });
check("invoice shows 'Chai x2 (Restaurant, …)' as its own line", /Chai x2 \(Restaurant, \d{1,2}:\d{2} [AP]M\)/.test(inv));
check("invoice shows the room-service line separately", /Coffee \(Room Service, \d{1,2}:\d{2} [AP]M\)/.test(inv));
const G = await page.evaluate(() => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.roomId === "102" && x.status === "active"); return calcBillGST(b, CURRENT_ROOMS.find(r => r.id === "102"), CURRENT_ROOMS); });
const foodRaw = (bk.charges || []).filter(c => c.cat === "🍛 Food" || c.cat === "☕ Beverages").reduce((t, c) => t + c.price * c.qty, 0);
check("restaurant + room-service food taxed in the food bucket", foodRaw > 0 && G.foodAmt === foodRaw, { foodAmt: G.foodAmt, foodRaw });
check("food GST rate is 5% (no room above ₹7,500)", Math.abs(G.foodGSTRate - 0.05) < 1e-9, G.foodGSTRate);

// Void a wrong line (Owner) — needs a reason, moves to voidedCharges.
await shot(page, "3_booking_bill");
const before = (bk.charges || []).length;
prompts.push("Galti se juda");
await page.locator('button[aria-label="Remove Coffee from bill"]').click();
await page.waitForTimeout(1500);
bk = (await bookingsLS(page)).find(b => b.roomId === "102" && b.status === "active");
check("voided line is removed from the bill", (bk.charges || []).length === before - 1 && !(bk.charges || []).some(c => c.name === "Coffee"));
check("voided line kept in voidedCharges with who/why", (bk.voidedCharges || []).some(c => c.name === "Coffee" && c.voidReason === "Galti se juda" && c.voidBy), bk.voidedCharges);
check("void is in the audit log", await page.evaluate(() => JSON.parse(localStorage.getItem("ab_audit") || "[]").some(a => a.action === "CHARGE_VOIDED")));
await page.locator('button[aria-label="Close"], button:has-text("✕")').first().click().catch(() => {});
await page.waitForTimeout(400);

console.log("\n=== Menu editor ===");
await nav(page, "Restaurant");
await page.click('button:has-text("📋 Menu")');
await page.waitForTimeout(400);
await page.click("text=Naya item jodo");
await page.locator('input[aria-label="Item name"]').first().fill("Paneer Tikka");
await page.locator('input[aria-label="Price"]').first().fill("250");
await shot(page, "4_menu_editor");
await page.click("text=Menu save karo");
await page.waitForTimeout(1000);
const cloudMenu = await page.evaluate(k => (window.__store["hotels/" + k + "/data/menu"] || {}).value || [], KEY);
check("custom item saved to the hotel's cloud menu", cloudMenu.some(m => m.name === "Paneer Tikka" && m.price === 250 && m.cat === "🍛 Food"), cloudMenu.slice(0, 3));

console.log("\n=== Walk-in GST bill ===");
await page.click('button:has-text("Walk-in bill")');
await page.fill('input[aria-label="Customer name"]', "Amit");
await page.fill('input[aria-label="Search menu"]', "Paneer");
await page.click('button[aria-label="Aur jodo Paneer Tikka"]');
await page.click('button[aria-pressed]:has-text("UPI")');
await page.locator('input[type="checkbox"]').last().uncheck().catch(() => {});
await shot(page, "5_walkin");
await page.click('button:has-text("Bill banao")');
await page.waitForTimeout(1500);
const today = await page.evaluate(() => localDateStr());
const rb = await page.evaluate(([k, t]) => (window.__store["hotels/" + k + "/data/rbills_" + t.replace(/-/g, "_")] || {}).value || [], [KEY, today]);
check("walk-in bill saved in today's restaurant-bill document", rb.length === 1, rb);
const bill = rb[0] || {};
check("bill number from its own GST series (RB/yy-yy/nnnnnn)", /^RB\/\d{2}-\d{2}\/\d{6}\*?$/.test(bill.id || ""), bill.id);
check("GST 5% exclusive: ₹250 + ₹13 (CGST 6 + SGST 7 or similar) = ₹263", bill.taxable === 250 && bill.total === 263 && bill.cgst + bill.sgst === 13, bill);
check("payment mode + customer recorded", bill.payMode === "UPI" && bill.cust === "Amit");
await shot(page, "6_walkin_bill");
const overlayHtml = await page.evaluate(() => { const f = document.querySelector("iframe[title='Invoice']"); return f ? f.srcdoc : ""; });
check("bill opens as a printable restaurant tax invoice", /TAX INVOICE — RESTAURANT/.test(overlayHtml) && /Paneer Tikka/.test(overlayHtml), overlayHtml.slice(0, 120));
await page.click("text=← Back").catch(() => {});
await page.waitForTimeout(300);

console.log("\n=== Restaurant staff login (now in ⚙️ Settings) ===");
check("staff password box is NOT on the Restaurant tab any more", !(await page.evaluate(() => document.body.innerText)).includes("Restaurant staff login"));
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(500);
const setText = await page.evaluate(() => document.body.innerText);
check("Settings shows password change, KOT printer and staff login", /SETTINGS/.test(setText) && /KOT Printer/.test(setText) && /Restaurant staff login/.test(setText));
await page.fill('input[aria-label="Restaurant staff password"]', "Rasoi@2026");
await page.click('button:has-text("Set karo")');
await page.waitForTimeout(800);
check("success message shown in Settings", (await page.evaluate(() => document.body.innerText)).includes("Login taiyaar"));
await page.click("text=Back");
await page.waitForTimeout(400);
const users = await page.evaluate(() => JSON.parse(localStorage.getItem("ab_users")));
const ru = users.find(u => u.u === "restaurant");
check("Owner created a 'restaurant' login (PBKDF2, role Restaurant)", ru && ru.role === "Restaurant" && ru.p.indexOf("pbkdf2-sha256$") === 0, ru);
check("no page errors (owner session)", errors.length === 0, errors);
await ctx.close();

{
  const s2 = { ...STORE, ab_users: JSON.stringify(users) };
  const t = await newPage(FEATS, s2);
  await login(t.page, "restaurant", "Rasoi@2026");
  const labels = await navLabels(t.page);
  check("Restaurant login sees ONLY the Restaurant tab", labels.includes("Restaurant") && !labels.includes("Dashboard") && !labels.includes("Billing") && !labels.includes("Rooms"), labels);
  const body = await t.page.evaluate(() => document.body.innerText);
  check("Restaurant login lands on the counter, not the revenue dashboard", /Room bill me jodo/.test(body) && !/Today\s*Revenue/i.test(body));
  check("Restaurant login cannot edit the menu or create logins", !/📋 Menu/.test(body) && !/Restaurant staff login/.test(body));
  await t.page.click('button[aria-label="Settings"]');
  await t.page.waitForTimeout(400);
  const st = await t.page.evaluate(() => document.body.innerText);
  check("Restaurant login: Settings has KOT printer but no staff-login box", /KOT Printer/.test(st) && !/Restaurant staff login/.test(st));
  await t.ctx.close();
}

console.log("\n=== Add-on switched off ===");
{
  const t = await newPage(["history", "csv_export", "roles"], STORE);
  await login(t.page, "owner", "OwnerPass@1");
  const labels = await navLabels(t.page);
  check("Owner does not see Restaurant when the add-on is off", !labels.includes("Restaurant"), labels);
  await t.ctx.close();
}
{
  const s3 = { ...STORE, ab_users: JSON.stringify(users) };
  const t = await newPage(["history", "csv_export", "roles"], s3);
  await login(t.page, "restaurant", "Rasoi@2026");
  const body = await t.page.evaluate(() => document.body.innerText);
  check("Restaurant login with add-on off gets a neutral screen (no dashboard)", /koi section chalu nahi/.test(body) && !/Today\s*Revenue/i.test(body), body.slice(0, 200));
  await t.ctx.close();
}

await browser.close();
server.close();
console.log(`\n=== RESTAURANT (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
