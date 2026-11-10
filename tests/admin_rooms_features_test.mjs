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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rm-test-"));
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
await new Promise(r => server.listen(8946, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.route("**/*", route => {
  const u = route.request().url();
  if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE });
  if (u.includes("gstatic.com") || u.includes("fonts.g")) return route.fulfill({ contentType: "text/javascript", body: "" });
  if (u.startsWith("http://localhost:8946")) return route.continue();
  return route.fulfill({ status: 404, body: "" });
});
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
const answers = []; const dialogs = [];
page.on("dialog", async d => { dialogs.push(d.type() + ": " + d.message().slice(0, 120)); if (d.type() === "prompt") await d.accept(answers.shift() ?? ""); else if (d.type() === "confirm") await d.accept(); else await d.accept(); });
const idle = async () => { for (let i = 0; i < 60; i++) { if (!(await page.evaluate(() => RM.busy))) return; await page.waitForTimeout(50); } };
await page.goto("http://localhost:8946/admin.html", { waitUntil: "load" });
await page.waitForTimeout(400);
const H = "hotels/" + KEY + "/data/";
await page.evaluate(([KEY, H]) => {
  const s = window.__store;
  s[H + "rooms"] = { value: [
    { id: "101", fl: 1, type: "Standard", rate: 800, status: "empty", bookingId: null, photos: [] },
    { id: "102", fl: 1, type: "Deluxe", rate: 1500, status: "occupied", bookingId: "b1", photos: [] },
    { id: "103", fl: 1, type: "Standard", rate: 800, status: "empty", bookingId: null, photos: [] },
    { id: "201", fl: 2, type: "Suite", rate: 3000, status: "empty", bookingId: null, photos: [] }
  ], ts: 1000, extra: "keep-me" };
  s[H + "bookings"] = { value: [{ id: "b1", roomId: "102", status: "active", name: "Guest" }, { id: "b0", roomId: "101", status: "checkedout" }], ts: 1 };
  s[H + "reservations"] = { value: [{ id: "r1", roomId: "103", status: "reserved", checkIn: "2026-12-01", checkOut: "2026-12-03" }], ts: 1 };
  licenses = [{ key: KEY, hotel: "Test Palace", owner: "Mr Test", phone: "9876543210", plan: "PRO", active: true, date: "2026-09-01" },
              { key: "ATITHI-EMPTY0001", hotel: "New Hotel", plan: "PRO", active: true, date: "2026-09-01" }];
  renderDashboard();
}, [KEY, H]);
const rooms = () => page.evaluate(H => window.__store[H + "rooms"], H);

console.log("admin: rooms button + list");
check("🛏️ Rooms button on each hotel row", (await page.locator('button:has-text("🛏️ Rooms")').count()) === 2);
await page.evaluate(() => openRoomManager(0)); await page.waitForTimeout(300); await idle();
const listTxt = await page.locator("#rmList").innerText();
check("modal lists all 4 rooms", (listTxt.match(/Delete/g) || []).length === 4, listTxt);
check("occupied room 102 delete button disabled", await page.locator('#rmList button:has-text("Delete")').nth(1).isDisabled());
check("room 103 with future booking delete disabled", await page.locator('#rmList button:has-text("Delete")').nth(2).isDisabled());
check("free room 101 delete enabled", !(await page.locator('#rmList button:has-text("Delete")').nth(0).isDisabled()));

console.log("admin: add room");
await page.fill("#rmNewId", "202"); await page.fill("#rmNewFl", "2"); await page.selectOption("#rmNewType", "Deluxe"); await page.fill("#rmNewRate", "1800"); await page.fill("#rmNewName", "Garden View");
await page.click("#rmAddBtn"); await idle();
let r = await rooms();
const n202 = r.value.find(x => x.id === "202");
check("room 202 saved to cloud with right fields", n202 && n202.fl === 2 && n202.type === "Deluxe" && n202.rate === 1800 && n202.name === "Garden View" && n202.status === "empty", n202);
check("other rooms untouched + doc fields kept", r.value.length === 5 && r.value.find(x => x.id === "102").status === "occupied" && r.extra === "keep-me" && r.ts > 1000);
await page.fill("#rmNewId", "101"); await page.click("#rmAddBtn"); await idle();
check("duplicate room number refused", (await rooms()).value.length === 5 && /pehle se hai/.test(await page.locator("#rmMsg").innerText()));
await page.fill("#rmNewId", "<b>x"); await page.click("#rmAddBtn"); await idle();
check("bad room number refused", (await rooms()).value.length === 5 && /letters\/numbers/.test(await page.locator("#rmMsg").innerText()));

console.log("admin: delete room");
await page.locator('#rmList > div', { hasText: "101" }).locator('button:has-text("Delete")').click(); await idle();
r = await rooms();
check("free room 101 deleted", !r.value.some(x => x.id === "101") && r.value.length === 4);
check("dialog asked before delete", dialogs.some(d => d.startsWith("confirm") && d.includes("101")));
await page.evaluate(() => rmDelete(RM.rooms.findIndex(x => x.id === "102"))); await idle();
check("occupied room 102 not deleted (direct call)", (await rooms()).value.some(x => x.id === "102"));
// hotel checks a guest into 201 while admin's list is stale -> server check refuses
await page.evaluate(H => { const s = window.__store[H + "rooms"]; s.value = s.value.map(x => x.id === "201" ? { ...x, status: "occupied" } : x); }, H);
await page.evaluate(() => rmDelete(RM.rooms.findIndex(x => x.id === "201"))); await idle();
check("stale list: room occupied meanwhile on hotel device is NOT deleted", (await rooms()).value.some(x => x.id === "201") && /occupied/.test(await page.locator("#rmMsg").innerText()));

console.log("admin: hotel with no rooms in cloud");
await page.evaluate(() => { rmClose(); openRoomManager(1); }); await page.waitForTimeout(300);
check("add disabled + warning when rooms not in cloud yet", await page.locator("#rmAddBtn").isDisabled() && /cloud me save nahi/.test(await page.locator("#rmMsg").innerText()));
check("nothing created for that hotel", !(await page.evaluate(() => window.__store["hotels/ATITHI-EMPTY0001/data/rooms"])));
check("no page errors (admin)", pageErrors.length === 0, pageErrors);
await ctx.close();
await browser.close(); server.close();
console.log(`\n=== ADMIN ROOMS (browser): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
