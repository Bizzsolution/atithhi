// AUDIT-2 browser regression suite (Playwright + in-memory fake Firebase).
// Runs the REAL index.html / admin.html. Every ✓ marked [regression] fails
// against the pre-audit-2 build.
//   node security_audit_2_browser_test.mjs [path/to/app-dir]
// Needs: playwright, react@18.3.1, react-dom@18.3.1 (devDependencies).
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
const PORT = 8971;
const KEY = "ATITHI-TESTHOTEL01";
const REG_PHONE = "9876543210";
const SECRET = "Adm1n-Bypass-Secret!";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ✓", label); }
  else { fail++; console.log("  ✗ FAIL:", label, extra !== undefined ? "-> " + JSON.stringify(extra).slice(0, 260) : ""); }
};
const legacyHash = pw => createHash("sha256").update(pw + "|AtithiSalt2024!").digest("hex");

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || !path.extname(p)) p = "/index.html";
  const f = path.join(APP, p);
  if (!f.startsWith(APP) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(f);
  res.writeHead(200, { "Content-Type": ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript" : "application/octet-stream" });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});

// verifyLog collects every /api/verify-access request body the app sends.
async function newPage(initStorage, verifyLog) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, serviceWorkers: "block" });
  if (initStorage) {
    await ctx.addInitScript(s => {
      if (sessionStorage.getItem("__seeded")) return;
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      sessionStorage.setItem("__seeded", "1");
    }, initStorage);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.accept());
  await page.route("**/*", async route => {
    const u = route.request().url();
    if (u.includes("unpkg.com/react-dom@")) return route.fulfill({ contentType: "text/javascript", body: REACT_DOM, headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.includes("unpkg.com/react@")) return route.fulfill({ contentType: "text/javascript", body: REACT, headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE_FB });
    if (u.includes("gstatic.com")) return route.fulfill({ contentType: "text/javascript", body: "/* stub */" });
    if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) return route.fulfill({ contentType: "text/css", body: "" });
    if (u.endsWith("/api/verify-access")) {
      let b = {};
      try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
      if (verifyLog) verifyLog.push(b);
      const digits = String(b.phone || "").replace(/\D/g, "").slice(-10);
      if (b.licenseKey === KEY && b.phone === SECRET) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, adminOverride: true, boundPhone: REG_PHONE }) });
      if (b.licenseKey === KEY && digits === REG_PHONE) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Phone number doesn't match our records for this license key." }) });
    }
    if (u.endsWith("/api/license-status")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ found: false }) });
    if (u.startsWith(`http://localhost:${PORT}`)) return route.continue();
    return route.fulfill({ status: 404, body: "" });
  });
  return { ctx, page, errors };
}
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
const users = async page => JSON.parse((await ls(page, "ab_users")) || "[]");
async function login(page, u, p) {
  await page.fill('input[placeholder="Enter username"]', u);
  await page.fill('input[placeholder="Enter password"]', p);
  await page.click("text=Login to Dashboard");
  await page.waitForTimeout(2500);
}
const bodyText = page => page.evaluate(() => document.body.innerText);

// ── F1-a: admin-override activation must not persist the secret ──
console.log("\n=== F1: ADMIN_SECRET never stored on the hotel device ===");
{
  const { ctx, page, errors } = await newPage(null, []);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  check("React loads (also proves the SRI hashes match the served files)", await page.evaluate(() => !!window.React && !!window.ReactDOM), errors);
  await page.fill('input[placeholder="ATITHI-XXXXXXXX"]', KEY);
  await page.fill('input[placeholder="+91 98765 43210"]', SECRET);
  await page.click("text=Activate & Start");
  await page.waitForTimeout(1500);
  const stored = await ls(page, "ab_verified_phone");
  check("activation via admin override succeeded", (await ls(page, "ab_license_key")) === KEY);
  check("[regression] ADMIN_SECRET is NOT written to localStorage", stored !== SECRET, { stored });
  check("[regression] the hotel's registered phone (boundPhone) is stored instead", stored === REG_PHONE, { stored });
  await ctx.close();
}

// ── F1-b: a secret persisted by an older build is purged, never re-sent ──
{
  const log = [];
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: SECRET }, log);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  check("[regression] a non-phone value left by an older build is purged on load", (await ls(page, "ab_verified_phone")) === null, { stored: await ls(page, "ab_verified_phone") });
  check("[regression] the purged value is never sent to /api/verify-access", !log.some(b => b.phone === SECRET), log);
  check("device stays activated (license key kept)", (await ls(page, "ab_license_key")) === KEY);
  await ctx.close();
}

// ── F5: PBKDF2 hashes for new installs ──
console.log("\n=== F5: staff password hashing ===");
{
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: REG_PHONE }, []);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await login(page, "owner", "owner123");
  const us = await users(page);
  check("default accounts created", us.length === 3, us.map(x => x.u));
  check("[regression] stored hashes are PBKDF2 with per-password salt", us.length === 3 && us.every(x => /^pbkdf2-sha256\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(x.p)), us.map(x => String(x.p).slice(0, 24)));
  check("[regression] salts differ between accounts", new Set(us.map(x => String(x.p).split("$")[2])).size === us.length);
  check("first login reaches the forced password change", /Update Password/i.test(await bodyText(page)));
  const cu = await page.evaluate(k => (window.__store["hotels/" + k + "/data/cu"] || {}).value, KEY);
  check("session object synced to the cloud carries no password hash", !cu || cu.p === undefined, cu);
  await ctx.close();
}

// ── F5: legacy hash upgrades transparently on login ──
{
  const legacyUsers = [
    { u: "owner", p: legacyHash("Legacy@123"), name: "Hotel Owner", role: "Owner", mustChange: false },
    { u: "admin", p: legacyHash("Mgr@12345"), name: "Rajesh Kumar", role: "Manager", mustChange: false },
    { u: "front", p: legacyHash("Front@1234"), name: "Priya Sharma", role: "Receptionist", mustChange: false }
  ];
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: REG_PHONE, ab_users: JSON.stringify(legacyUsers) }, []);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await login(page, "owner", "wrong-password");
  check("wrong password on a legacy hash is rejected", /Wrong credentials/i.test(await bodyText(page)));
  await login(page, "owner", "Legacy@123");
  const us = await users(page);
  const owner = us.find(x => x.u === "owner");
  check("legacy-hash account can still log in", !/Wrong credentials|Locked/i.test(await bodyText(page)) && !(await page.$('input[placeholder="Enter password"]')));
  check("[regression] its hash is upgraded to PBKDF2 on that login", owner && owner.p.indexOf("pbkdf2-sha256$") === 0, owner && owner.p.slice(0, 20));
  check("other accounts' legacy hashes are left untouched until they log in", us.find(x => x.u === "front").p === legacyHash("Front@1234"));
  await ctx.close();
}

// ── F4-a: change-password bypass removed ──
console.log("\n=== F4: password reset / change ===");
{
  const u0 = [
    { u: "owner", p: legacyHash("RealPass@1"), name: "Hotel Owner", role: "Owner", mustChange: true },
    { u: "front", p: legacyHash("Front@1234"), name: "Priya", role: "Receptionist", mustChange: false }
  ];
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: REG_PHONE, ab_users: JSON.stringify(u0) }, []);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await login(page, "owner", "RealPass@1");
  const before = (await users(page)).find(x => x.u === "owner").p;
  await page.fill('input[placeholder^="Current password"]', "admin123");
  await page.fill('input[placeholder^="New password"]', "Hijack@1234");
  await page.fill('input[placeholder="Confirm new password"]', "Hijack@1234");
  await page.click("text=Update Password");
  await page.waitForTimeout(1500);
  const after = (await users(page)).find(x => x.u === "owner").p;
  check("[regression] 'admin123' no longer passes as the current password of another account", before === after && /Current password is incorrect/i.test(await bodyText(page)), { changed: before !== after });
  if (await page.locator('input[placeholder^="Current password"]').count()) {
    await page.fill('input[placeholder^="Current password"]', "RealPass@1");
    await page.click("text=Update Password");
    await page.waitForTimeout(1800);
    const after2 = (await users(page)).find(x => x.u === "owner").p;
    check("the real current password still allows the change (stored as PBKDF2)", after2 !== before && after2.indexOf("pbkdf2-sha256$") === 0, after2.slice(0, 20));
  } else {
    check("the real current password still allows the change (stored as PBKDF2)", false, "change screen already gone — the bypass password was accepted");
  }
  await ctx.close();
}

// ── F4-b: forgot-password needs the registered phone, verified server-side ──
{
  const u0 = [{ u: "owner", p: legacyHash("OwnerPass@1"), name: "Hotel Owner", role: "Owner", mustChange: false }];
  const log = [];
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: REG_PHONE, ab_users: JSON.stringify(u0) }, log);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await page.click("text=Forgot Password?");
  await page.waitForTimeout(400);
  const inputs = page.locator("input");
  await page.fill('input[placeholder="Enter your username"]', "owner");
  await page.fill('input[placeholder="ATITHI-XXXXXXXX"]', KEY);
  const phoneField = page.locator('input[type="tel"]');
  if (await phoneField.count()) await phoneField.fill("9000000001");
  log.length = 0;
  await page.click("text=Verify Identity");
  await page.waitForTimeout(1200);
  const reached = (await page.locator('input[type="password"]').count()) > 0;
  check("[regression] license key alone (plus a wrong phone) does NOT unlock the reset step", !reached, { inputs: await inputs.count() });
  check("[regression] the identity check is done server-side (/api/verify-access)", log.length >= 1 && log[0].licenseKey === KEY, log);
  if (await phoneField.count()) {
    await phoneField.fill("+91 98765 43210");
    await page.click("text=Verify Identity");
    await page.waitForTimeout(1200);
    const pw = page.locator('input[type="password"]');
    check("correct registered phone unlocks the reset step", (await pw.count()) >= 2);
    if ((await pw.count()) >= 2) {
      await pw.nth(0).fill("short1");
      await pw.nth(1).fill("short1");
      await page.locator("button").filter({ hasText: /reset|update|save/i }).first().click();
      await page.waitForTimeout(800);
      check("reset enforces the 8-character minimum", (await users(page))[0].p === legacyHash("OwnerPass@1"));
      await pw.nth(0).fill("Brand@New12");
      await pw.nth(1).fill("Brand@New12");
      await page.locator("button").filter({ hasText: /reset|update|save/i }).first().click();
      await page.waitForTimeout(1500);
      const p = (await users(page))[0].p;
      check("reset stores the new password as PBKDF2", p.indexOf("pbkdf2-sha256$") === 0, p.slice(0, 20));
    }
  } else {
    check("correct registered phone unlocks the reset step", false, "no phone field on the reset screen");
  }
  await ctx.close();
}

// ── F2: a new public booking link is published WITH its owner binding ──
console.log("\n=== F2: public booking owner binding ===");
{
  const { ctx, page } = await newPage({ ab_license_key: KEY, ab_verified_phone: REG_PHONE }, []);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(async () => {
    const tok = "PBTESTLINK234567AB";
    const r = await publishPublicBookingSnapshot(tok, { hotelName: "Atithi Palace", hotelAddr: "x".repeat(1500), hotelPhone: "9876543210" }, [{ type: "Deluxe", rate: 1500 }], { claim: true });
    return { r, owner: window.__store["public_booking_owner/" + tok] || null, page: window.__store["public_booking/" + tok] || null };
  });
  check("publishing a NEW link succeeds", res.r && res.r.ok === true, res.r);
  check("[regression] the owner binding public_booking_owner/{token} is written with this hotel's id", res.owner && res.owner.hotelId === KEY, res.owner);
  check("[regression] snapshot fields are capped to the rule limits (address ≤ 1000 chars)", res.page && res.page.hotelAddr.length === 1000, res.page && res.page.hotelAddr.length);
  const res2 = await page.evaluate(async () => {
    const tok = "PBTESTLINK234567AB";
    const before = JSON.stringify(window.__store["public_booking_owner/" + tok]);
    const r = await publishPublicBookingSnapshot(tok, { hotelName: "Atithi Palace 2" }, []);
    return { r, unchanged: JSON.stringify(window.__store["public_booking_owner/" + tok]) === before, name: window.__store["public_booking/" + tok].hotelName };
  });
  check("refreshing an existing link updates the page and leaves the binding untouched", res2.r.ok === true && res2.unchanged && res2.name === "Atithi Palace 2", res2);
  await ctx.close();
}
{
  const { ctx, page } = await newPage(null, []);
  page.removeAllListeners("dialog");
  const asked = [];
  page.on("dialog", d => { asked.push(d.message().slice(0, 80)); d.dismiss(); });
  await page.goto(`http://localhost:${PORT}/admin.html`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  const out = await page.evaluate(async () => {
    if (typeof backfillBookingOwners !== "function") return { missing: true };
    const s = window.__store;
    // A: legit pre-patch link — page name matches the admin-recorded name.
    s["hotels/ATITHI-HOTELAAAA01/data/profile"] = { value: { publicBookingToken: "PBAAAAAAAAAAAAAAAA" }, ts: 1 };
    s["public_booking/PBAAAAAAAAAAAAAAAA"] = { hotelName: "Ganga View Hotel", updatedAt: 1 };
    // B/C: two profiles name the same token (one copied it).
    s["hotels/ATITHI-HOTELBBBB01/data/profile"] = { value: { publicBookingToken: "PBSHAREDTOKEN23456" }, ts: 1 };
    s["hotels/ATITHI-HOTELCCCC01/data/profile"] = { value: { publicBookingToken: "PBSHAREDTOKEN23456" }, ts: 1 };
    s["public_booking/PBSHAREDTOKEN23456"] = { hotelName: "Hotel Bee", updatedAt: 1 };
    // D: sole claimant of a ROTATED-AWAY link of someone else (names differ).
    s["hotels/ATITHI-HOTELDDDD01/data/profile"] = { value: { publicBookingToken: "PBOLDLINKOFOTHER23" }, ts: 1 };
    s["public_booking/PBOLDLINKOFOTHER23"] = { hotelName: "Ganga View Hotel", updatedAt: 1 };
    licenses = [
      { key: "ATITHI-HOTELAAAA01", hotel: "Ganga View Hotel" },
      { key: "ATITHI-HOTELBBBB01", hotel: "Hotel Bee" },
      { key: "ATITHI-HOTELCCCC01", hotel: "Hotel Cee" },
      { key: "ATITHI-HOTELDDDD01", hotel: "Dee Residency" }
    ];
    const r = await backfillBookingOwners({ force: true });
    return { r, a: s["public_booking_owner/PBAAAAAAAAAAAAAAAA"] || null, shared: s["public_booking_owner/PBSHAREDTOKEN23456"] || null, stolen: s["public_booking_owner/PBOLDLINKOFOTHER23"] || null };
  });
  check("[regression] admin backfills the owner binding for a provable pre-existing link", !out.missing && out.a && out.a.hotelId === "ATITHI-HOTELAAAA01", out);
  check("[regression] a token named by two hotels' profiles is NOT auto-bound (admin is asked)", !out.missing && out.shared === null && asked.length >= 1, { shared: out.shared, asked });
  check("[regression] a sole claimant whose hotel name does not match the page is NOT auto-bound (rotated-link hijack)", !out.missing && out.stolen === null, out.stolen);
  await ctx.close();
}

// ── F10: admin payment QR is generated locally ──
console.log("\n=== F10: admin payment QR ===");
{
  const { ctx, page } = await newPage(null, []);
  const external = [];
  page.on("request", r => { if (/qrserver/.test(r.url())) external.push(r.url()); });
  await page.goto(`http://localhost:${PORT}/admin.html`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  const src = await page.evaluate(() => typeof qrImageUrl === "function" ? qrImageUrl("upi://pay?pa=test@upi&pn=BizzSathi&am=499&cu=INR&tn=T") : null);
  check("[regression] payment QR is a locally generated data: URL", typeof src === "string" && src.indexOf("data:image/") === 0, src && src.slice(0, 60));
  check("[regression] no request to api.qrserver.com", external.length === 0 && !(src || "").includes("qrserver"), external);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n=== AUDIT-2 BROWSER: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
