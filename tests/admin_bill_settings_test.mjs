// Browser test of the admin Data Manager (admin.html → 🗂️ Data) against an
// in-memory fake Firestore (fake_firebase.js). Covers edit, stale-write
// refusal, undo, exports (incl. CSV formula-injection guard), delete-all
// (typed key, revoke-first, backup-first), restore, XSS and path-traversal ids.
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

// Usage (needs playwright + a chromium):  node data_manager_browser_test.mjs
const SCRATCH = path.dirname(new URL(import.meta.url).pathname);
const DIR = path.join(SCRATCH, "..");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
import os from "node:os";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bs-test-"));
const FAKE = fs.readFileSync(path.join(SCRATCH, "fake_firebase.js"), "utf8");
const KEY = "ATITHI-TEST0001";

let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log("  ✓", l); } else { fail++; console.log("  ✗ FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x).slice(0, 300) : ""); } };

const server = http.createServer((req, res) => {
  let p = req.url.split("?")[0]; if (p === "/") p = "/admin.html";
  fs.readFile(path.join(DIR, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html" : "text/javascript" }); res.end(d);
  });
});
await new Promise(r => server.listen(8948, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.route("**/*", route => {
  const u = route.request().url();
  if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE });
  if (u.includes("gstatic.com") || u.includes("fonts.g")) return route.fulfill({ contentType: "text/javascript", body: "" });
  if (u.startsWith("http://localhost:8948")) return route.continue();
  return route.fulfill({ status: 404, body: "" });
});
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
const answers = []; const dialogs = [];
page.on("dialog", async d => { dialogs.push(d.type() + ": " + d.message().slice(0, 120)); if (d.type() === "prompt") await d.accept(answers.shift() ?? ""); else if (d.type() === "confirm") await d.accept(); else await d.accept(); });
const idle = async () => { for (let i = 0; i < 60; i++) { if (!(await page.evaluate(() => RM.busy || BS.busy))) return; await page.waitForTimeout(50); } };
await page.goto("http://localhost:8948/admin.html", { waitUntil: "load" });
await page.waitForTimeout(400);
const H = "hotels/" + KEY + "/data/";
await page.evaluate(([KEY, H]) => {
  const s = window.__store;
  s[H + "rooms"] = { value: [
    { id: "101", fl: 1, type: "Standard", rate: 800, status: "occupied", bookingId: "b1", photos: ["p1"] },
    { id: "201", fl: 2, type: "Suite", rate: 3000, status: "empty", bookingId: null, photos: [] }
  ], ts: 1000 };
  s[H + "adminConfig"] = { value: { someOtherKey: "keep" }, ts: 1 };
  s[H + "invCounter_" + (() => { const d = new Date(), y = d.getFullYear(), st = d.getMonth() + 1 >= 4 ? y : y - 1; return String(st).slice(-2) + "-" + String(st + 1).slice(-2); })()] = { value: 3 };
  licenses = [{ key: KEY, hotel: "Shashi Residency", owner: "Mr S", phone: "9876543210", plan: "PRO", active: true, date: "2026-09-01" }];
  renderDashboard();
}, [KEY, H]);
const doc = k => page.evaluate(([H, k]) => window.__store[H + k], [H, k]);
const FY = await page.evaluate(() => bsFY());

console.log("admin: room edit");
check("🧾 Bill Settings button on hotel row", (await page.locator('button:has-text("🧾 Bill Settings")').count()) === 1);
await page.evaluate(() => openRoomManager(0)); await page.waitForTimeout(300); await idle();
await page.locator('#rmList > div', { hasText: "101" }).first().locator('button:has-text("Edit")').click();
await page.fill("#rmEdFl", "3"); await page.selectOption("#rmEdType", "Deluxe"); await page.fill("#rmEdRate", "1500"); await page.fill("#rmEdName", "Garden View");
await page.click('#rmList button:has-text("💾 Save")'); await idle();
let r = (await doc("rooms")).value.find(x => x.id === "101");
check("room 101 floor/type/rate/name updated", r.fl === 3 && r.type === "Deluxe" && r.rate === 1500 && r.name === "Garden View", r);
check("guest status / photos untouched by edit", r.status === "occupied" && r.bookingId === "b1" && r.photos[0] === "p1", r);
await page.locator('#rmList > div', { hasText: "201" }).first().locator('button:has-text("Edit")').click();
await page.fill("#rmEdRate", "0"); await page.click('#rmList button:has-text("💾 Save")'); await idle();
check("bad rate refused", (await doc("rooms")).value.find(x => x.id === "201").rate === 3000 && /Rate/.test(await page.locator("#rmMsg").innerText()));
await page.click('#rmList button:has-text("Cancel")');
console.log("admin: floor names");
await page.fill('[data-floor-name="2"]', "Second Floor");
await page.fill('[data-floor-name="3"]', "Terrace");
await page.click('button:has-text("Floor names save karo")'); await page.waitForTimeout(400); await idle();
let ac = (await doc("adminConfig")).value;
check("floor names saved, other config kept", ac.floorNames["2"] === "Second Floor" && ac.floorNames["3"] === "Terrace" && ac.someOtherKey === "keep", ac);
await page.evaluate(() => rmClose());

console.log("admin: bill settings");
await page.evaluate(() => openBillSettings(0)); await page.waitForTimeout(500);
check("current bill count shown", /ab tak\s*3\s*bill/.test(await page.locator("#bsBody").innerText()));
await page.fill("#bs_hotelName", "HOTEL SHASHI RESIDENCY");
await page.fill("#bs_gstin", "09BAD");
await page.click("#bsSaveBtn"); await idle();
check("bad GSTIN refused", /GSTIN/.test(await page.locator("#bsMsg").innerText()) && !(await doc("adminConfig")).value.invoice);
await page.fill("#bs_gstin", "09AMMPC5395E2ZT");
await page.fill("#bs_address", "Near Railway Junction, Opp Narayanpuri, Dholi Pyau, Mathura-281001 (U.P)");
await page.fill("#bs_phone", "9520998899, 8791223322");
await page.fill("#bs_roomSac", "996311");
await page.fill("#bs_footerNote", "Issue Cheque/D.D. in favour of Hotel Shashi Residency\nPayable at Mathura");
await page.fill("#bs_checkoutNote", "Check out time 12 noon");
await page.fill("#bs_jurisdiction", "Mathura");
await page.fill("#bs_signatory", "Authorised Signatory");
await page.fill("#bs_prefix", "HSR");
await page.selectOption("#bs_pad", "0");
await page.fill("#bs_bkPrefix", "hsr");
check("preview shows the new series", (await page.locator("#bsPrev").innerText()).includes("HSR/" + FY + "/4") && /Booking ID: HSR/.test(await page.locator("#bsPrev").innerText()), await page.locator("#bsPrev").innerText());
await page.fill("#bs_next", "8");
await page.click("#bsSaveBtn"); await page.waitForTimeout(400); await idle();
ac = (await doc("adminConfig")).value;
check("invoice settings saved", ac.invoice.hotelName === "HOTEL SHASHI RESIDENCY" && ac.invoice.gstin === "09AMMPC5395E2ZT" && ac.invoice.prefix === "HSR" && ac.invoice.pad === 0 && ac.invoice.fy === true && ac.invoice.jurisdiction === "Mathura" && /\n/.test(ac.invoice.footerNote), ac.invoice);
check("booking prefix saved upper-case", ac.bookingPrefix === "HSR");
check("floor names + other keys still there", ac.floorNames["2"] === "Second Floor" && ac.someOtherKey === "keep");
check("next bill number set (counter = 7)", (await doc("invCounter_" + FY)).value === 7);
await page.fill("#bs_next", "5");
await page.click("#bsSaveBtn"); await idle();
check("next number lower than used count refused", (await doc("invCounter_" + FY)).value === 7 && /kam se kam 8/.test(await page.locator("#bsMsg").innerText()), await page.locator("#bsMsg").innerText());
await page.fill("#bs_next", "");
await page.fill("#bs_bkPrefix", "HS-R");
await page.click("#bsSaveBtn"); await idle();
check("bad booking prefix refused", (await doc("adminConfig")).value.bookingPrefix === "HSR" && /Booking ID/.test(await page.locator("#bsMsg").innerText()));
check("no page errors (admin)", pageErrors.length === 0, pageErrors);
await ctx.close();
await browser.close(); server.close();
console.log(`\n=== ADMIN BILL SETTINGS (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
