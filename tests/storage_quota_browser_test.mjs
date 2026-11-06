// Full-phone-storage login test (client bug 2026-10-16: "Setting the value of
// 'ab_bf' exceeded the quota"). Fills localStorage to the brim the way years
// of check-ins did (ID photos stored 3-4x), then logs in.
//   node storage_quota_browser_test.mjs [path/to/app-dir]
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
const PORT = 8985;
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
  page.__dlg = [];
  page.on("dialog", d => { page.__dlg.push(d.message()); if (d.type() === "prompt") d.accept(prompts.shift() ?? ""); else d.accept(); });
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


const PHOTO = "data:image/jpeg;base64," + "A".repeat(180000); // ~180 KB, like a compressed ID photo
// Fill localStorage like a hotel phone after many check-ins, then pack the
// rest with data the guard must NOT delete (filler zz_*).
const fill = (page, opts) => page.evaluate(([PHOTO, opts]) => {
  const set = (window.StorageGuard && StorageGuard._origSet) ? (k, v) => StorageGuard._origSet.call(localStorage, k, v) : (k, v) => localStorage.setItem(k, v);
  let n = 0;
  if (opts.photos) {
    for (let i = 0; i < 6; i++) {
      try {
        set("ab_img_img_front_bk" + i, PHOTO + i); set("ab_img_front_bk" + i, PHOTO + i);
        set("ph_f_tmp" + i, PHOTO + i); set("ab_img_sig_bk" + i, "data:image/png;base64,SIG" + i);
        n++;
      } catch (e) { break; }
    }
  }
  let big = "Z".repeat(400000), j = 0;
  while (big.length > 16) { try { set("zz_keep_" + j, big); j++; } catch (e) { big = big.slice(0, big.length >> 1); } }
  return { photos: n, filler: j };
}, [PHOTO, opts || {}]);
const freeBytes = page => page.evaluate(() => { try { localStorage.setItem("__probe", "x".repeat(20000)); localStorage.removeItem("__probe"); return true; } catch (e) { return false; } });

console.log("\n=== Phone storage full of old check-in photos ===");
let t = await newPage(FEATS, STORE);
const r1 = await fill(t.page, { photos: true });
await t.page.reload({ waitUntil: "load" }); await t.page.waitForTimeout(1500);
await t.page.fill('input[placeholder="Enter username"]', "owner");
await t.page.fill('input[placeholder="Enter password"]', "WrongPass#1");
await t.page.click("text=Login to Dashboard");
await t.page.waitForTimeout(1500);
let body = await t.page.evaluate(() => document.body.innerText);
check("wrong password → normal 'Wrong credentials' message, not a storage error", /Wrong credentials/.test(body) && !/quota/i.test(body), body.match(/.{0,40}(quota|Wrong).{0,60}/i)?.[0]);
const idb = await t.page.evaluate(async () => {
  if (typeof ImgDB === "undefined") return null;
  for (let i = 0; i < 40 && Object.keys(localStorage).some(k => /^ab_img_|^ph_/.test(k)); i++) await new Promise(r => setTimeout(r, 100));
  return { left: Object.keys(localStorage).filter(k => /^ab_img_|^ph_/.test(k)), f0: (await ImgDB.get("img_front_bk0") || "").slice(-1), s0: await ImgDB.get("sig_bk0"), vault: (await WS.getRawImg("img_front_bk5") || "").slice(-1) };
});
check("all photos moved out of localStorage", idb && idb.left.length === 0, idb && idb.left);
check("vault photos readable from IndexedDB (front + signature)", idb && idb.f0 === "0" && idb.s0 === "data:image/png;base64,SIG0" && idb.vault === "5", idb);
check("filler data the guard must keep is untouched", await t.page.evaluate(n => Array.from({ length: n }, (_, i) => localStorage.getItem("zz_keep_" + i) != null).every(Boolean), r1.filler));
check("space available again after migration", await freeBytes(t.page));
await t.page.fill('input[placeholder="Enter password"]', "OwnerPass@1");
await t.page.click("text=Login to Dashboard");
await t.page.waitForTimeout(2500);
body = await t.page.evaluate(() => document.body.innerText);
check("correct password → dashboard opens", /GOOD (MORNING|AFTERNOON|EVENING)|Occupied/.test(body) && !/Login to Dashboard/.test(body), body.slice(0, 200));
const nw = await t.page.evaluate(async () => { await WS.setRawImg("img_front_NEW1", "data:image/jpeg;base64,NEWPHOTO"); return { ls: localStorage.getItem("ab_img_img_front_NEW1"), read: await WS.getRawImg("img_front_NEW1") }; });
check("new check-in photo goes to IndexedDB (not localStorage) and the vault reads it", nw.ls === null && nw.read === "data:image/jpeg;base64,NEWPHOTO", nw);
check("no page errors", t.errors.length === 0, t.errors);
await t.ctx.close();

console.log("\n=== Phone storage 100% full of data that must NOT be deleted ===");
t = await newPage(FEATS, STORE);
await fill(t.page, { photos: false });
await t.page.reload({ waitUntil: "load" }); await t.page.waitForTimeout(1500);
check("storage really is full", !(await freeBytes(t.page)));
await t.page.fill('input[placeholder="Enter username"]', "owner");
await t.page.fill('input[placeholder="Enter password"]', "WrongPass#1");
await t.page.click("text=Login to Dashboard");
await t.page.waitForTimeout(1500);
body = await t.page.evaluate(() => document.body.innerText);
check("wrong password still shows the real reason", /Wrong credentials/.test(body) && !/quota/i.test(body), body.match(/.{0,40}(quota|Wrong|storage).{0,60}/i)?.[0]);
await t.page.fill('input[placeholder="Enter password"]', "OwnerPass@1");
await t.page.click("text=Login to Dashboard");
await t.page.waitForTimeout(2500);
body = await t.page.evaluate(() => document.body.innerText);
check("storage-full warning shown to the owner (once a day)", (t.page.__dlg || []).some(m => /storage full/.test(m)), t.page.__dlg);
check("correct password logs in even with storage 100% full", /GOOD (MORNING|AFTERNOON|EVENING)|Occupied/.test(body) && !/Login to Dashboard/.test(body), body.match(/.{0,80}(quota|storage).{0,80}/i)?.[0] || body.slice(0, 160));
check("no page errors", t.errors.length === 0, t.errors);
await t.ctx.close();

console.log("\n=== New check-ins no longer duplicate photos into localStorage ===");
const src = fs.readFileSync(path.join(APP, "index.html"), "utf8");
check("no ab_img_front_/ph_ localStorage writes left in the app", !/localStorage\.setItem\(`ab_img_(front|back)_/.test(src) && !/localStorage\.setItem\("ph_"/.test(src));
check("demo passwords hidden once the hotel has staff logins", /!\(\(\) => \{ try \{ return localStorage\.getItem\("ab_users"\)/.test(src));

await browser.close(); server.close();
console.log(`\n=== STORAGE-FULL LOGIN (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
