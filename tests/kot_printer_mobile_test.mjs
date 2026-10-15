// Phone-size menu multi-select + KOT printer modes (print dialog 58/80 mm,
// Bluetooth ESC/POS via a mocked Web Bluetooth printer, RawBT intent).
//   node kot_printer_mobile_test.mjs [path/to/app-dir]
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


// Fake BLE thermal printer: records every byte written.
const BT_MOCK = () => {
  window.__btWrites = [];
  const chr = { properties: { write: true, writeWithoutResponse: true }, writeValueWithoutResponse: async v => { window.__btWrites.push(Array.from(new Uint8Array(v.buffer || v))); }, writeValue: async v => { window.__btWrites.push(Array.from(new Uint8Array(v.buffer || v))); } };
  const svc = { getCharacteristics: async () => [{ properties: { read: true } }, chr] };
  const dev = { id: "dev-1", name: "PT-210 BLE", gatt: { connected: false, connect: async function () { if (window.__btFail) throw new Error("GATT Server is disconnected"); this.connected = true; return this; }, getPrimaryServices: async () => [svc] } };
  Object.defineProperty(navigator, "bluetooth", { value: { requestDevice: async () => dev, getDevices: async () => [dev] }, configurable: true });
};

console.log("\n=== Phone (360×640): pick several items ===");
const { ctx, page, errors, popups } = await newPage(FEATS, STORE, { viewport: { width: 360, height: 640 } });
await login(page, "owner", "OwnerPass@1");
await nav(page, "Restaurant");
await page.click('button:has-text("Walk-in bill")');
await page.waitForTimeout(300);
const qty = n => page.locator(`button[aria-label="Kam karo ${n}"] + span`).innerText();
await page.click('button[aria-label="Aur jodo Chai"]');
check("menu list still visible after the first item", await page.locator('button[aria-label="Aur jodo Coffee"]').isVisible());
await page.click('button[aria-label="Aur jodo Coffee"]', { timeout: 5000 });
await page.click('button[aria-label="Aur jodo Coffee"]', { timeout: 5000 });
await page.click('button:has-text("🍛 Food")');
await page.click('button[aria-label="Aur jodo Dal Rice"]', { timeout: 5000 });
check("3 different items in the cart (Chai 1, Coffee 2, Dal Rice 1)", (await qty("Dal Rice")) === "1" && (await page.locator('text=/1× Chai, 2× Coffee, 1× Dal Rice/').count()) === 1);
const listBox = await page.locator('button[aria-label="Aur jodo Dal Rice"]').evaluate(b => b.closest(".scrollable").getBoundingClientRect().height);
check("menu list keeps a usable height on a small phone", listBox >= 150, listBox);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "m1_phone_multi.png") });

console.log("\n=== KOT: print dialog, 58 mm ===");
await page.evaluate(() => KotPrinter.set({ mode: "browser", width: 58 }));
let n0 = popups.length;
await page.evaluate(() => printKOT({ kot: "K900", date: localDateStr(), time: "10:05", by: "T", where: "Walk-in", items: [{ qty: 2, name: "Chai" }] }));
await page.waitForTimeout(500);
check("58 mm slip opened in print dialog", popups.length === n0 + 1 && /size:58mm/.test(await popups[popups.length - 1].content()));

console.log("\n=== KOT: Bluetooth direct (mock BLE printer) ===");
await page.evaluate(BT_MOCK);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);
await page.locator('input[name="kotmode"][value="bluetooth"]').check();
await page.click('button:has-text("Printer jodo")');
await page.waitForTimeout(400);
check("printer paired + remembered", (await page.evaluate(() => KotPrinter.get())).btName === "PT-210 BLE" && /PT-210 BLE jud gaya/.test(await page.evaluate(() => document.body.innerText)));
await page.selectOption('select[aria-label="Paper width"]', "58");
await page.selectOption('select[aria-label="KOT copies"]', "2");
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "m2_settings_printer.png"), fullPage: true });
n0 = popups.length;
await page.click('button:has-text("Test print")');
await page.waitForTimeout(600);
let bytes = await page.evaluate(() => [].concat(...window.__btWrites));
let txt = Buffer.from(bytes).toString("latin1");
check("test KOT sent as ESC/POS bytes (init + cut)", bytes[0] === 0x1b && bytes[1] === 0x40 && txt.includes("\x1dVB"));
check("2 copies printed", (txt.match(/KITCHEN ORDER/g) || []).length === 2);
check("58 mm = 32-column lines", txt.includes("-".repeat(32) + "\n") && !txt.includes("-".repeat(33)));
check("no print dialog when Bluetooth works", popups.length === n0);
await page.click("text=Back"); await page.waitForTimeout(400);

// Real order from the counter goes to the Bluetooth printer
await page.evaluate(() => { window.__btWrites = []; });
await page.click('button:has-text("Walk-in bill")').catch(() => {});
await page.fill('input[aria-label="Search menu"]', "Chai");
await page.click('button[aria-label="Aur jodo Chai"]');
check("KOT checkbox shows the printer in use", /Bluetooth: PT-210 BLE/.test(await page.evaluate(() => document.body.innerText)));
await page.fill('input[aria-label="Kitchen note"]', "kam cheeni — ₹ test");
await page.click('button:has-text("Bill banao")');
await page.waitForTimeout(1500);
txt = Buffer.from(await page.evaluate(() => [].concat(...window.__btWrites))).toString("latin1");
check("walk-in order KOT printed over Bluetooth with items + note", /KOT K\d{3}/.test(txt) && /x Chai/.test(txt) && /kam cheeni - Rs test/.test(txt), txt.slice(0, 200));
check("only printable ASCII sent (₹ → Rs, no UTF-8 garbage)", Buffer.from(await page.evaluate(() => [].concat(...window.__btWrites))).every(b => b < 0x80));
await page.click("text=← Back").catch(() => {});
await page.waitForTimeout(300);

console.log("\n=== KOT: Bluetooth fails → falls back to print dialog ===");
const alerts = [];
page.on("dialog", d => alerts.push(d.message()));
await page.evaluate(() => { window.__btFail = true; BtPrinter.chr = null; BtPrinter.device.gatt.connected = false; });
n0 = popups.length;
const res = await page.evaluate(() => printKOT({ kot: "K901", date: localDateStr(), time: "10:06", by: "T", where: "Room 101", items: [{ qty: 1, name: "Coffee" }] }));
await page.waitForTimeout(500);
check("fallback opened the print dialog and reported why", popups.length === n0 + 1 && res.via === "browser" && /Bluetooth/.test(res.error || ""), res);

console.log("\n=== KOT: RawBT (Android) ===");
const a = await newPage(FEATS, STORE, { viewport: { width: 360, height: 640 }, userAgent: "Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36" });
await login(a.page, "owner", "OwnerPass@1");
await a.page.click('button[aria-label="Settings"]');
await a.page.waitForTimeout(400);
check("RawBT option enabled on Android", await a.page.locator('input[name="kotmode"][value="rawbt"]').isEnabled());
await a.page.locator('input[name="kotmode"][value="rawbt"]').check();
await a.page.evaluate(() => { window.__go = []; KotPrinter.go = u => window.__go.push(u); });
await a.page.click('button:has-text("Test print")');
await a.page.waitForTimeout(400);
const go = await a.page.evaluate(() => window.__go[0] || "");
check("RawBT intent URL with base64 ESC/POS", /^intent:base64,[A-Za-z0-9+/=]+#Intent;scheme=rawbt;package=ru\.a402d\.rawbtprinter;end;$/.test(go), go.slice(0, 80));
const decoded = Buffer.from(go.slice("intent:base64,".length, go.indexOf("#")), "base64").toString("latin1");
check("RawBT payload is the KOT (80 mm, 48 cols)", /KITCHEN ORDER/.test(decoded) && decoded.includes("-".repeat(48)));
check("no page errors (android)", a.errors.length === 0, a.errors);
await a.ctx.close();

{
  const d = await newPage(FEATS, STORE);
  await login(d.page, "owner", "OwnerPass@1");
  await d.page.click('button[aria-label="Settings"]');
  await d.page.waitForTimeout(400);
  check("desktop/non-Android: RawBT option disabled, browser default", !(await d.page.locator('input[name="kotmode"][value="rawbt"]').isEnabled()) && await d.page.locator('input[name="kotmode"][value="browser"]').isChecked());
  await d.ctx.close();
}

check("no page errors (phone)", errors.length === 0, errors);
await ctx.close();
await browser.close(); server.close();
console.log(`\n=== KOT PRINTER + PHONE MENU (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
