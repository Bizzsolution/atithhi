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
const PORT = 8987;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-FEATTEST1";
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
    if (u.endsWith("/api/license-status")) return features === "FAIL" ? route.fulfill({ status: 500, body: "" }) : route.fulfill({ contentType: "application/json", body: JSON.stringify({ found: true, active: true, plan: "PREM", expiry: null, features }) });
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
const BASE = { ab_license_key: KEY, ab_verified_phone: "9876543210", ab_users: USERS };
const navHas = async (page, label) => (await navLabels(page)).includes(label);

console.log("\n=== Only the features admin switched ON are shown ===");
{
  const { ctx, page, errors } = await newPage(["history"], BASE);
  await login(page, "owner", "OwnerPass@1");
  check("history ON -> History tab shown", await navHas(page, "History"));
  check("roles OFF -> Access tab hidden", !(await navHas(page, "Access")));
  check("storage OFF -> Storage tab hidden", !(await navHas(page, "Storage")));
  check("restaurant OFF -> Restaurant tab hidden", !(await navHas(page, "Restaurant")));
  await page.locator('button:has-text("Rooms")').last().click(); await page.waitForTimeout(600);
  check("room_edit OFF -> no add-room button", (await page.locator('button:has-text("+ Add Room")').count()) === 0);
  check("feature list remembered on device", await page.evaluate(k => JSON.parse(localStorage.getItem("ab_feat_cache")).key === k && JSON.stringify(JSON.parse(localStorage.getItem("ab_feat_cache")).features) === '["history"]', KEY));
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
}
console.log("\n=== Check fails on a device that never got the list: nothing paid shown ===");
{
  const { ctx, page, errors } = await newPage("FAIL", BASE);
  await login(page, "owner", "OwnerPass@1");
  check("History hidden (was shown before: fail-open)", !(await navHas(page, "History")));
  check("Access hidden", !(await navHas(page, "Access")));
  { const L = await navLabels(page); check("basic tabs still there (Dashboard, Rooms, Check-In, Billing)", ["Dashboard", "Rooms", "Check-In", "Billing"].every(l => L.includes(l)), L); }
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
}
console.log("\n=== Check fails but device remembers last list: that list is used ===");
{
  const { ctx, page, errors } = await newPage("FAIL", { ...BASE, ab_feat_cache: JSON.stringify({ key: KEY, features: ["history", "roles"] }) });
  await login(page, "owner", "OwnerPass@1");
  check("History shown from remembered list", await navHas(page, "History"));
  check("Access shown from remembered list", await navHas(page, "Access"));
  check("Storage still hidden", !(await navHas(page, "Storage")));
  await page.locator('button:has-text("Rooms")').last().click(); await page.waitForTimeout(600);
  check("room_edit not in list -> no add-room button", (await page.locator('button:has-text("+ Add Room")').count()) === 0);
  check("no page errors", errors.length === 0, errors);
  await ctx.close();
}
console.log("\n=== Remembered list of ANOTHER license key is ignored ===");
{
  const { ctx, page } = await newPage("FAIL", { ...BASE, ab_feat_cache: JSON.stringify({ key: "ATITHI-OTHER9", features: ["history"] }) });
  await login(page, "owner", "OwnerPass@1");
  check("other hotel's cached features not applied", !(await navHas(page, "History")));
  await ctx.close();
}
console.log("\n=== Admin switches a feature OFF while app is open: hidden when app comes back ===");
{
  let feats = ["history", "roles"];
  const { ctx, page } = await newPage(["history", "roles"], BASE);
  await page.route("**/api/license-status", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({ found: true, active: true, plan: "PREM", expiry: null, features: feats }) }));
  await login(page, "owner", "OwnerPass@1");
  check("History shown at start", await navHas(page, "History"));
  feats = ["roles"];
  // simulate app going to background and returning after > 5 minutes
  await page.evaluate(() => { const real = Date.now; const t0 = real(); Date.now = () => t0 + 6 * 60 * 1000 + (real() - t0); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(1200);
  check("History hidden after admin switched it off", !(await navHas(page, "History")));
  check("Access still shown", await navHas(page, "Access"));
  await ctx.close();
}
await browser.close(); server.close();
console.log(`\n=== FEATURE GATING (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
