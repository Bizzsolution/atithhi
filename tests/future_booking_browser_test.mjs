// Future bookings + advance — browser test of the REAL index.html
// (Playwright + in-memory fake Firebase).
//   node future_booking_browser_test.mjs [path/to/app-dir]
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
const PORT = 8983;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-FUTURETEST1";
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
const FEATS2 = ["history", "csv_export", "roles"];
const { ctx, page, errors } = await newPage(FEATS2, STORE);
const msgs = [];
page.on("dialog", dl => msgs.push(dl.message()));
await login(page, "owner", "OwnerPass@1");
const LS = (pg, k) => pg.evaluate(k2 => JSON.parse(localStorage.getItem(k2) || "[]"), k);
const RM = id => page.evaluate(i => CURRENT_ROOMS.find(r => r.id === i), id);
const lastMsg = () => msgs[msgs.length - 1] || "";

console.log("\n=== Owner: create a FUTURE booking with advance ===");
check("Bookings tab visible", (await navLabels(page)).includes("Bookings"), await navLabels(page));
await nav(page, "Bookings");
await page.click('[data-t="res-new"]');
await page.selectOption('[data-t="f-room"]', "102");
await page.fill('[data-t="f-in"]', d(5)); await page.fill('[data-t="f-out"]', d(7));
await page.fill('[data-t="f-name"]', "Future Guest"); await page.fill('[data-t="f-mobile"]', "9811122233");
await page.fill('[data-t="f-adv"]', "2000");
await page.click('button:has-text("UPI")');
await page.click('[data-t="f-save"]');
await page.waitForTimeout(900);
let res = await LS(page, "ab_reservations");
check("reservation saved (status reserved)", res.length === 1 && res[0].status === "reserved" && res[0].roomId === "102" && res[0].checkIn === d(5), res);
check("advance ₹2000 UPI recorded on the reservation", res[0] && res[0].advances && res[0].advances[0].amount === 2000 && res[0].advances[0].mode === "UPI", res[0]);
check("room 102 is NOT occupied by a future booking", (await RM("102")).status === "empty");
check("no booking record / billing entry created", (await LS(page, "ab_bookings")).length === 0);
check("cloud copy saved", await page.evaluate(k => ((window.__store["hotels/" + k + "/data/reservations"] || {}).value || []).length === 1, KEY));
check("audit log has RESERVATION_ADDED", (await LS(page, "ab_audit")).some(a => a.action === "RESERVATION_ADDED"));

console.log("\n=== Occupancy only on that date ===");
await nav(page, "Dashboard");
const tile = id => page.locator('.ab-roommap > div', { hasText: id }).first().innerText();
check("today: room 102 shows free", /🟢/.test(await tile("102")), await tile("102"));
await page.fill('[data-t="map-date"]', d(5));
await page.waitForTimeout(400);
check("on arrival date: room 102 shows reserved 📅", /📅/.test(await tile("102")), await tile("102"));
await page.fill('[data-t="map-date"]', d(6)); await page.waitForTimeout(300);
check("second night still reserved", /📅/.test(await tile("102")));
await page.fill('[data-t="map-date"]', d(7)); await page.waitForTimeout(300);
check("check-out date: room free again", /🟢/.test(await tile("102")), await tile("102"));
await page.fill('[data-t="map-date"]', d(3)); await page.waitForTimeout(300);
check("before arrival: free", /🟢/.test(await tile("102")));
check("dashboard lists the future booking with advance", /Future Guest/.test(await page.locator('[data-t="arrivals"]').innerText()) && /2000/.test(await page.locator('[data-t="arrivals"]').innerText()));

console.log("\n=== Double-booking is blocked ===");
await nav(page, "Bookings");
await page.click('[data-t="res-new"]');
await page.selectOption('[data-t="f-room"]', "102");
await page.fill('[data-t="f-in"]', d(6)); await page.fill('[data-t="f-out"]', d(8));
await page.fill('[data-t="f-name"]', "Clash"); await page.fill('[data-t="f-mobile"]', "9000000000");
await page.click('[data-t="f-save"]'); await page.waitForTimeout(600);
check("overlapping dates rejected with a clear message", /already booked/.test(lastMsg()) && (await LS(page, "ab_reservations")).length === 1, lastMsg());
await page.fill('[data-t="f-in"]', d(7)); await page.fill('[data-t="f-out"]', d(8));
await page.click('[data-t="f-save"]'); await page.waitForTimeout(800);
check("back-to-back (arrive on previous check-out day) is allowed", (await LS(page, "ab_reservations")).length === 2);
// remove that second one again to keep the scenario simple
await page.locator('[data-res]', { hasText: "Clash" }).locator('[data-t="res-cancel"]').click();
await page.click('[data-t="cancel-ok"]'); await page.waitForTimeout(700);
check("cancel without advance works", (await LS(page, "ab_reservations")).find(r => r.name === "Clash").status === "cancelled");

console.log("\n=== Short stay BEFORE the reservation is allowed, overrun is not ===");
await nav(page, "Check-In");
await page.locator("select").first().selectOption("102");
let dts = page.locator('input[type="date"]');
await dts.nth(0).fill(d(0)); await dts.nth(1).fill(d(6));
await page.fill('input[placeholder="As on Aadhaar Card"]', "Walkin Short");
await page.fill('input[placeholder="As per Aadhaar"], textarea[placeholder="As per Aadhaar"]', "Delhi");
await page.fill('input[placeholder="+91 XXXXX XXXXX"]', "9810000001");
await page.locator('label:has-text("Guest Consent:") input[type="checkbox"]').check();
await page.click("text=Confirm Check-In"); await page.waitForTimeout(700);
check("stay running into the reservation is blocked", /booking hai/.test(lastMsg()) && (await LS(page, "ab_bookings")).length === 0, lastMsg());
dts = page.locator('input[type="date"]');
await dts.nth(1).fill(d(3));
await page.click("text=Confirm Check-In"); await page.waitForTimeout(1900);
let bks = await LS(page, "ab_bookings");
check("stay ending before arrival is checked in", bks.length === 1 && bks[0].roomId === "102" && bks[0].status === "active", bks);
check("room 102 occupied NOW", (await RM("102")).status === "occupied");
await nav(page, "Dashboard");
await page.fill('[data-t="map-date"]', d(5)); await page.waitForTimeout(300);
check("on the reservation date room 102 is reserved (not occupied)", /📅/.test(await tile("102")), await tile("102"));
await page.fill('[data-t="map-date"]', d(1)); await page.waitForTimeout(300);
check("on a day inside the walk-in stay it is occupied", /🔴/.test(await tile("102")), await tile("102"));

console.log("\n=== Reservation → Check-In Now carries advance into the bill ===");
await nav(page, "Bookings");
await page.click('[data-t="res-new"]');
await page.selectOption('[data-t="f-room"]', "103");
await page.fill('[data-t="f-in"]', d(0)); await page.fill('[data-t="f-out"]', d(2));
await page.fill('[data-t="f-name"]', "Arrival Guest"); await page.fill('[data-t="f-mobile"]', "9822233344");
await page.fill('[data-t="f-rate"]', "1000");
await page.fill('[data-t="f-adv"]', "500");
await page.click('[data-t="f-save"]'); await page.waitForTimeout(800);
// add more advance from the card
await page.locator('[data-res]', { hasText: "Arrival Guest" }).locator('[data-t="res-adv"]').click();
await page.fill('[data-t="adv-amt"]', "250");
await page.click('[data-t="adv-save"]'); await page.waitForTimeout(700);
res = await LS(page, "ab_reservations");
const ag = res.find(r => r.name === "Arrival Guest");
check("advance can be added later (500 + 250)", ag && ag.advances.length === 2 && ag.advances.reduce((t, a) => t + a.amount, 0) === 750, ag);
await page.locator('[data-res]', { hasText: "Arrival Guest" }).locator('[data-t="res-checkin"]').click();
await page.waitForTimeout(900);
check("check-in form opens pre-filled (name, mobile, room)", (await page.inputValue('input[placeholder="As on Aadhaar Card"]')) === "Arrival Guest" && (await page.inputValue('input[placeholder="+91 XXXXX XXXXX"]')) === "9822233344" && (await page.locator("select").first().inputValue()) === "103");
check("agreed rate ₹1000/night carried over", /1000/.test(await page.locator('text=night').first().innerText().catch(() => "")) || (await page.content()).includes("₹1,000") || (await page.content()).includes("2,000"));
check("existing advance shown in check-in form", /750/.test(await page.locator('[data-t="advance-card"]').innerText()));
await page.fill('input[placeholder="As per Aadhaar"], textarea[placeholder="As per Aadhaar"]', "Noida");
await page.fill('[data-t="ci-adv"]', "100");
await page.locator('label:has-text("Guest Consent:") input[type="checkbox"]').check();
await page.click("text=Confirm Check-In"); await page.waitForTimeout(2000);
bks = await LS(page, "ab_bookings");
const nb = bks.find(b => b.roomId === "103");
check("booking created, active", nb && nb.status === "active", nb);
check("advance 750 (reservation) + 100 (check-in) = 850 on booking", nb && nb.advance === 850 && nb.advances.length === 3, nb && nb.advances);
check("booking rate = 1000/night × 2 = 2000", nb && nb.roomTotal === 2000, nb && nb.roomTotal);
res = await LS(page, "ab_reservations");
check("reservation marked checked-in and linked", res.find(r => r.name === "Arrival Guest").status === "checkedin" && res.find(r => r.name === "Arrival Guest").bookingId === nb.id);
check("room 103 now occupied", (await RM("103")).status === "occupied");
check("only ONE booking for that guest (no duplicate)", bks.filter(b => b.name === "Arrival Guest").length === 1);

console.log("\n=== Billing: advance deducted at checkout ===");
await nav(page, "Billing");
await page.click("text=Arrival Guest"); await page.waitForTimeout(600);
const bm = await page.locator('[data-t="bm-adv"]').innerText();
check("bill shows advance and balance", /850/.test(bm) && /Baaki lena hai/.test(bm), bm);
// grand total = 2000 + 12% GST (₹1000 slab) = 2240 → balance 1390
const grand = await page.evaluate(() => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.roomId === "103"); return calcBillGST(b, CURRENT_ROOMS.find(r => r.id === "103"), CURRENT_ROOMS).grandTotal; });
check("balance = grand total − advance", new RegExp(String(grand - 850).replace(/(\d)(?=(\d{3})+$)/g, "$1,?")).test(bm), { grand, bm });
// add another advance from the in-house bill
await page.click('[data-t="bm-adv-open"]');
await page.fill('[data-t="bm-adv-amt"]', "150");
await page.click('[data-t="bm-adv-save"]'); await page.waitForTimeout(900);
check("advance can be added while in-house (850 → 1000)", (await LS(page, "ab_bookings")).find(b => b.roomId === "103").advance === 1000);
const invHtml = await page.evaluate(() => { const b = JSON.parse(localStorage.getItem("ab_bookings")).find(x => x.roomId === "103"); return buildInvoiceHTML(b, CURRENT_ROOMS.find(r => r.id === "103")); });
check("invoice shows 'Advance received' and the balance", /Advance received \(earlier\)/.test(invHtml) && /Balance received by/.test(invHtml) && new RegExp("₹" + (grand - 1000)).test(invHtml), invHtml.match(/Advance received[\s\S]{0,300}/)?.[0]);
check("invoice total itself is unchanged by advance", invHtml.includes("₹" + grand));
await page.click('button:has-text("Check Out & Settle")');
await page.waitForTimeout(300);
check("payment prompt shows total − advance = baaki", /Advance/.test(await page.locator("text=Payment kaise mila").innerText()));
await page.locator('button:has-text("UPI")').last().click();
await page.click('button:has-text("Confirm Check Out")'); await page.waitForTimeout(2200);
const done = (await LS(page, "ab_bookings")).find(b => b.roomId === "103");
check("checked out with advancePaid / balanceReceived recorded", done.status === "checkedout" && done.advancePaid === 1000 && done.balanceReceived === grand - 1000 && done.grandTotal === grand, done);
check("revenue = grand total (advance not double counted)", done.grandTotal === grand);

await page.click('button:has-text("← Back")'); await page.waitForTimeout(400);
console.log("\n=== Cancel with advance ===");
await nav(page, "Bookings");
await page.locator('[data-res]', { hasText: "Future Guest" }).locator('[data-t="res-cancel"]').click();
await page.click('[data-t="cancel-refund"]'); await page.waitForTimeout(800);
const fg = (await LS(page, "ab_reservations")).find(r => r.name === "Future Guest");
check("cancelled with advance refunded recorded", fg.status === "cancelled" && fg.advanceOutcome === "refunded", fg);
await nav(page, "Dashboard");
await page.fill('[data-t="map-date"]', d(5)); await page.waitForTimeout(300);
check("cancelled booking frees the room on that date", /🟢/.test(await tile("102")), await tile("102"));

console.log("\n=== Role access ===");
check("no page errors (owner)", errors.length === 0, errors);
await ctx.close();
const rp = await newPage(FEATS2, STORE);
await login(rp.page, "front", "Front@1234");
check("Receptionist (can check-in) sees Bookings", (await navLabels(rp.page)).includes("Bookings"), await navLabels(rp.page));
check("no page errors (receptionist)", rp.errors.length === 0, rp.errors);
await rp.ctx.close();
await browser.close(); server.close();
console.log(`\n=== FUTURE BOOKING + ADVANCE (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
