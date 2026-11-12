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
const PORT = 8989;
const SHOTS = process.env.SHOTS || "";
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const KEY = "ATITHI-GSTTEST1";
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
// Room invoice must never print the demo hotel's GSTIN (09AAACR5055K1Z5)
// when the hotel owner hasn't entered one.
const { ctx, page, errors } = await newPage(["history"], { ab_license_key: KEY, ab_verified_phone: "9876543210", ab_users: USERS });
await login(page, "owner", "OwnerPass@1");
const inv = (gstin) => page.evaluate(g => {
  CURRENT_PROFILE.hotelName = "Shanti Residency"; CURRENT_PROFILE.hotelGstin = g;
  const room = CURRENT_ROOMS[0] || { id: "101", type: "Standard", rate: 1000 };
  const b = { id: "BK1", invoiceNo: "INV-1", name: "Test Guest", roomId: room.id, checkIn: "2026-11-01", checkOut: "2026-11-02", roomTotal: room.rate || 1000, charges: [], status: "checkedout", paymentMode: "Cash" };
  return buildInvoiceHTML(b, room);
}, gstin);
let h = await inv("");
check("no GSTIN entered -> demo GSTIN NOT on invoice", !h.includes("09AAACR5055K1Z5"));
check("no GSTIN entered -> no 'GSTIN:' label printed", !/GSTIN:\s*</.test(h) && !h.includes("GSTIN: 09"));
check("hotel's own name still printed", h.includes("Shanti Residency"));
h = await inv("27ABCDE1234F1Z5");
check("hotel's own GSTIN printed when entered", h.includes("GSTIN: 27ABCDE1234F1Z5") && !h.includes("09AAACR5055K1Z5"));
// GST % columns: CGST and SGST are half the slab each (e.g. 5% → 2.5 + 2.5)
h = await page.evaluate(() => {
  const room = { id: "X1", type: "Deluxe", rate: 2250 };
  const b = { id: "BK2", invoiceNo: "INV-2", name: "Half Rate", roomId: "X1", checkIn: "2026-11-01", checkOut: "2026-11-02", roomTotal: 2250, charges: [], status: "checkedout", paymentMode: "Cash" };
  return buildInvoiceHTML(b, room);
});
const pcts = [...h.matchAll(/<td class="num">([\d.—]+)<\/td><td class="num">₹/g)].map(m => m[1]);
check("CGST % and SGST % show half the slab (2.5 + 2.5 for 5%)", pcts.length >= 2 && pcts[0] === "2.5" && pcts[1] === "2.5", pcts);
// no demo hotel details when the hotel hasn't entered them
h = await page.evaluate(() => { CURRENT_PROFILE.hotelEmail = ""; CURRENT_PROFILE.hotelTagline = ""; CURRENT_PROFILE.hotelPhone = ""; CURRENT_PROFILE.hotelAddr = "";
  const room = CURRENT_ROOMS[0] || { id: "101", type: "Standard", rate: 1000 };
  return buildInvoiceHTML({ id: "BK3", invoiceNo: "INV-3", name: "Demo Check", roomId: room.id, checkIn: "2026-11-01", checkOut: "2026-11-02", roomTotal: 1000, charges: [], status: "checkedout", paymentMode: "Cash" }, room); });
check("no demo email / tagline / address / phone on the bill", !h.includes("atithipalace") && !h.includes("Atithi Devo Bhava") && !h.includes("Sector 18") && !/Ph:\s*\+?91/.test(h), h.match(/.{0,60}(atithipalace|Atithi Devo|Sector 18).{0,40}/));
await ctx.close();

console.log("\n=== Login page: WhatsApp support ===");
{
  const { ctx, page } = await newPage(["history"], { ab_license_key: KEY, ab_verified_phone: "9876543210", ab_users: USERS });
  const links = await page.locator('[data-t="login-support"] a').evaluateAll(as => as.map(a => ({ href: a.href, text: a.textContent, target: a.target })));
  check("two WhatsApp support buttons on login", links.length === 2, links);
  check("8447992260 opens WhatsApp", links.some(l => l.href.startsWith("https://wa.me/918447992260") && l.target === "_blank"), links);
  check("9315660112 opens WhatsApp", links.some(l => l.href.startsWith("https://wa.me/919315660112") && l.target === "_blank"), links);
  check("login text is in English", (await page.locator("body").innerText()).includes("Enter your username and password"));
  await page.setViewportSize({ width: 360, height: 760 });
  const box = await page.locator('[data-t="login-support"]').boundingBox();
  check("support buttons fit a small phone screen", box && box.x >= 0 && box.x + box.width <= 360, box);
  await ctx.close();
}
await browser.close(); server.close();
console.log(`\n=== INVOICE GSTIN + CGST% + LOGIN SUPPORT (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
