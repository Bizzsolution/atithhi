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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
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
await new Promise(r => server.listen(8941, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.route("**/*", route => {
  const u = route.request().url();
  if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE });
  if (u.includes("gstatic.com") || u.includes("fonts.g")) return route.fulfill({ contentType: "text/javascript", body: "" });
  if (u.startsWith("http://localhost:8941")) return route.continue();
  return route.fulfill({ status: 404, body: "" });
});
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
const answers = []; const dialogs = [];
page.on("dialog", async d => { dialogs.push(d.type() + ": " + d.message().slice(0, 120)); if (d.type() === "prompt") await d.accept(answers.shift() ?? ""); else if (d.type() === "confirm") await d.accept(); else await d.accept(); });
const downloads = [];
page.on("download", async dl => { const p = await dl.path(); downloads.push({ name: dl.suggestedFilename(), text: fs.readFileSync(p, "utf8") }); });
const waitDownloads = async n => { for (let i = 0; i < 50 && downloads.length < n; i++) await page.waitForTimeout(100); };
const idle = async () => { for (let i = 0; i < 60; i++) { if (!(await page.evaluate(() => DM.busy))) return; await page.waitForTimeout(50); } };

await page.goto("http://localhost:8941/admin.html", { waitUntil: "load" });
await page.waitForTimeout(400);

// ── seed fake Firestore ──
await page.evaluate(KEY => {
  const s = window.__store, H = "hotels/" + KEY + "/data/";
  s[H + "rooms"] = { value: [{ id: "r1", number: "101", type: "Deluxe" }, { id: "r2", number: "102", type: "Standard" }], ts: 1000 };
  s[H + "bookings"] = { value: [
    { id: "b1", name: "Ramesh Kumar", mobile: "9876500001", roomId: "r1", checkIn: 1758000000000, status: "checked-in", aadhaar: "XXXX-XXXX-1234" },
    { id: "b2", name: "=HYPERLINK(\"http://evil\")", mobile: "9876500002", roomId: "r2", checkIn: 1758100000000, status: "checked-out" },
    { id: "b3", name: "<img src=x onerror=window.__xss=1>", mobile: "9876500003", roomId: "r2", checkIn: 1758200000000, status: "checked-out" }
  ], ts: 2000 };
  s[H + "bookings_archive_2026_05"] = { value: [{ id: "a1", name: "Old Guest", checkIn: 1746000000000, status: "checked-out" }], ts: 1500 };
  s[H + "profile"] = { value: { hotelName: "Test Palace", gstin: "09ABCDE1234F1Z5", publicBookingToken: "PBTOKEN12345678" }, ts: 900 };
  s[H + "users"] = { value: [{ username: "admin", role: "Owner", passHash: "abc" }], ts: 800 };
  s[H + "invCounter_26-27"] = { value: 42 };
  s[H + "<img src=x onerror=window.__xss2=1>"] = { value: 1, ts: 1 }; // hostile doc id
  s["public_booking/PBTOKEN12345678"] = { name: "Test Palace" };
  s["public_booking/PBTOKEN12345678/requests/q1"] = { name: "Enquirer", phone: "9000000000" };
  s["licenses/" + KEY] = { key: KEY, active: true, plan: "PRO" };
  licenses = [{ key: KEY, hotel: "Test Palace", owner: "Mr Test", phone: "9876543210", plan: "PRO", active: true, date: "2026-09-01" }];
}, KEY);

console.log("open + list");
await page.evaluate(() => openDataManager(0)); await idle();
let listText = await page.locator("#dmBody").innerText();
check("modal opens", await page.locator("#dmModal.open").count() === 1);
check("lists all 6 safe documents", (await page.locator("#dmBody .dm-row").count()) === 7, await page.locator("#dmBody .dm-row").count()); // 6 docs + public booking row
check("hostile doc id skipped with a warning", (await page.locator("#dmMsg").innerText()).includes("skip"));
check("friendly labels shown", listText.includes("Archived bookings — May 2026") && listText.includes("Invoice number counter — FY 2026-27"));
check("public booking page + 1 enquiry shown", listText.includes("public_booking/PBTOKEN12345678") && /Enquiries:\s*1/.test(listText));
check("listMode full (admin list allowed)", await page.evaluate(() => DM.listMode) === "full");

console.log("open bookings + search + XSS");
const bIdx = await page.evaluate(() => DM.docs.findIndex(d => d.id === "bookings"));
await page.evaluate(i => dmOpenDoc(i), bIdx);
check("3 booking records listed", await page.locator("#dmBody .dm-rec").count() === 3);
check("no XSS from record names / doc ids", await page.evaluate(() => !window.__xss && !window.__xss2 && !document.querySelector("#dmBody img")));
await page.fill("#dmSearch", "ramesh");
check("search filters to 1", await page.locator("#dmBody .dm-rec").count() === 1);
await page.fill("#dmSearch", "");

console.log("edit record");
await page.evaluate(() => dmEditRecord(0));
check("editor opens with record JSON", (await page.inputValue("#dmEdText")).includes("Ramesh Kumar"));
await page.fill("#dmEdText", (await page.inputValue("#dmEdText")).replace("Ramesh Kumar", "Ramesh K. Sharma"));
await page.click("#dmEdSave"); await idle();
let stored = await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"], KEY);
check("edit written to cloud", stored.value[0].name === "Ramesh K. Sharma", stored.value[0]);
check("ts bumped", stored.ts > 2000);
check("other records untouched", stored.value.length === 3 && stored.value[1].id === "b2");
check("editor closed + success msg", (await page.locator("#dmEditor.open").count()) === 0 && (await page.locator("#dmMsg").innerText()).includes("Saved"));

console.log("invalid JSON rejected");
await page.evaluate(() => dmEditRecord(1));
await page.fill("#dmEdText", "{ broken json");
await page.click("#dmEdSave"); await idle();
check("bad JSON → error, nothing written", (await page.locator("#dmEdErr").innerText()).includes("JSON galat") && (await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"].value[1].id, KEY)) === "b2");
await page.evaluate(() => dmCloseEditor());

console.log("conflict detection (hotel changed data meanwhile)");
await page.evaluate(k => { const d = window.__store["hotels/" + k + "/data/bookings"]; d.value.push({ id: "b4", name: "Walk-in" }); d.ts = Date.now() + 5; }, KEY);
await page.evaluate(() => dmEditRecord(0));
await page.fill("#dmEdText", (await page.inputValue("#dmEdText")).replace("Ramesh K. Sharma", "SHOULD NOT SAVE"));
await page.click("#dmEdSave"); await idle();
stored = await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"], KEY);
check("stale write refused — hotel's new booking kept", stored.value.length === 4 && stored.value[0].name === "Ramesh K. Sharma", stored.value.map(b => b.name));
check("conflict message shown", (await page.locator("#dmEdErr").innerText()).includes("badal diya"));
await page.evaluate(() => dmCloseEditor());
await page.evaluate(() => dmRefresh()); await idle();
check("after refresh: 4 records", await page.locator("#dmBody .dm-rec").count() === 4);

console.log("delete record + undo");
await page.evaluate(() => dmDeleteRecord(3)); await idle();
stored = await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"], KEY);
check("record deleted", stored.value.length === 3 && !stored.value.some(b => b.id === "b4"));
check("undo button enabled", await page.locator("#dmUndoBtn").isEnabled());
await page.evaluate(() => dmUndo()); await idle();
stored = await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"], KEY);
check("undo restored the record", stored.value.length === 4 && stored.value.some(b => b.id === "b4"));

console.log("raw edit of an object doc (profile)");
await page.evaluate(() => { dmBackToList(); dmOpenDoc(DM.docs.findIndex(d => d.id === "profile")); dmRawEdit(); });
const prof = JSON.parse(await page.inputValue("#dmEdText"));
delete prof.gstin; prof.hotelName = "Test Palace Grand";
await page.fill("#dmEdText", JSON.stringify(prof));
await page.click("#dmEdSave"); await idle();
const sp = await page.evaluate(k => window.__store["hotels/" + k + "/data/profile"], KEY);
check("profile field changed", sp.value.hotelName === "Test Palace Grand");
check("removed field really removed (full replace, not merge)", !("gstin" in sp.value), sp.value);

console.log("exports");
downloads.length = 0;
await page.evaluate(() => dmExportFull()); await waitDownloads(1);
const full = downloads[0] && JSON.parse(downloads[0].text);
check("full backup downloaded", !!full && full.format === "atithibook-admin-backup" && full.hotelId === "ATITHI-TEST0001");
check("backup has all 6 docs + public booking", full && Object.keys(full.documents).length === 6 && full.publicBooking && full.publicBooking.requests.length === 1, full && Object.keys(full.documents));
check("backup file name has no weird chars", /^atithibook-ATITHI-TEST0001-full-backup-\d{4}-\d\d-\d\d\.json$/.test(downloads[0].name), downloads[0].name);
downloads.length = 0;
await page.evaluate(() => dmExportRegister()); await waitDownloads(1);
const csv = downloads[0] ? downloads[0].text : "";
check("register CSV has BOM + header", csv.charCodeAt(0) === 0xFEFF && /_source,id,name/.test(csv), csv.slice(0, 80));
check("register merges live + archive (5 rows)", csv.trim().split(/\r\n/).length === 6, csv.trim().split(/\r\n/).length);
check("CSV formula injection neutralised", csv.includes("\"'=HYPERLINK(\"\"http://evil\"\")\"") && !/\n=HYPERLINK|,=HYPERLINK/.test(csv));
check("register oldest first (archive guest first)", csv.split(/\r\n/)[1].includes("Old Guest"));
check("date-less booking goes last", csv.trim().split(/\r\n/).pop().includes("Walk-in"));

console.log("delete single doc (non-critical) + undo recreates");
downloads.length = 0;
await page.evaluate(() => dmDeleteDoc(DM.docs.findIndex(d => d.id === "invCounter_26-27"))); await idle(); await waitDownloads(1);
check("auto-backup of the doc downloaded before delete", downloads.length === 1 && downloads[0].text.includes("invCounter_26-27"));
check("counter doc deleted", await page.evaluate(k => !("hotels/" + k + "/data/invCounter_26-27" in window.__store), KEY));
await page.evaluate(() => dmUndo()); await idle();
check("undo recreated deleted doc", await page.evaluate(k => (window.__store["hotels/" + k + "/data/invCounter_26-27"] || {}).value === 42, KEY));

console.log("critical doc needs typed DELETE");
answers.push("delete please");
await page.evaluate(() => dmDeleteDoc(DM.docs.findIndex(d => d.id === "rooms"))); await idle();
check("wrong confirmation → rooms NOT deleted", await page.evaluate(k => !!window.__store["hotels/" + k + "/data/rooms"], KEY));

console.log("probe fallback when rules not published");
await page.evaluate(() => { window.__denyList = true; }); await page.evaluate(() => dmRefresh()); await idle();
check("probe mode finds known docs incl. archive + counter", await page.evaluate(() => DM.listMode === "probe" && ["bookings", "bookings_archive_2026_05", "invCounter_26-27", "profile"].every(id => DM.docs.some(d => d.id === id))));
check("probe mode warns about rules", (await page.locator("#dmBody").innerText()).includes("rules abhi publish nahi"));
await page.evaluate(() => { window.__denyList = false; }); await page.evaluate(() => dmRefresh()); await idle();

console.log("delete ALL (typed key, revoke, backup first)");
downloads.length = 0;
const writesBeforeDA = await page.evaluate(() => window.__writes.length);
await page.evaluate(() => dmOpenDeleteAll());
check("delete button disabled until key typed", await page.locator("#dmDaGo").isDisabled());
await page.fill("#dmDaConfirm", "ATITHI-WRONG");
check("wrong key keeps it disabled", await page.locator("#dmDaGo").isDisabled());
await page.fill("#dmDaConfirm", KEY.toLowerCase());
check("correct key (any case) enables it", await page.locator("#dmDaGo").isEnabled());
await page.click("#dmDaGo"); await page.waitForTimeout(300); await idle(); await waitDownloads(1);
const remaining = await page.evaluate(k => Object.keys(window.__store).filter(p => p.startsWith("hotels/" + k + "/data/") && !p.includes("<img")), KEY);
check("all hotel docs deleted", remaining.length === 0, remaining);
check("public booking page + requests deleted", await page.evaluate(() => !Object.keys(window.__store).some(p => p.startsWith("public_booking/"))));
check("license revoked in cloud", await page.evaluate(k => window.__store["licenses/" + k].active === false, KEY));
check("license revoked in panel list", await page.evaluate(() => licenses[0].active === false));
const pre = downloads.find(d => d.name.includes("BEFORE-DELETE"));
check("BEFORE-DELETE backup downloaded with all docs", !!pre && Object.keys(JSON.parse(pre.text).documents).length === 6);
check("write order: license revoked before any data deleted", await page.evaluate(([k, b]) => { const w = window.__writes.slice(b); const lic = w.findIndex(x => x[1] === "licenses/" + k); const del = w.findIndex(x => x[0] === "delete"); return lic >= 0 && del > lic; }, [KEY, writesBeforeDA]));
check("empty-state shown", (await page.locator("#dmBody").innerText()).includes("koi data nahi mila"));

console.log("restore from backup file");
const bfile = path.join(TMP, "restore_backup.json"); fs.writeFileSync(bfile, pre.text);
answers.push(KEY);
await page.setInputFiles("#dmRestoreFile", bfile); await page.waitForTimeout(400); await idle();
const restored = await page.evaluate(k => Object.keys(window.__store).filter(p => p.startsWith("hotels/" + k + "/data/") && !p.includes("<img")).length, KEY);
check("all 6 docs restored", restored === 6, restored);
check("restored content intact", await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"].value.length === 4 && window.__store["hotels/" + k + "/data/profile"].value.hotelName === "Test Palace Grand", KEY));
answers.push("ATITHI-NOPE");
const before = await page.evaluate(() => window.__writes.length);
await page.setInputFiles("#dmRestoreFile", bfile); await page.waitForTimeout(300); await idle();
check("restore with wrong typed key writes nothing", await page.evaluate(b => window.__writes.length === b, before));
const evil = path.join(TMP, "evil_backup.json");
fs.writeFileSync(evil, JSON.stringify({ format: "atithibook-admin-backup", version: 1, hotelId: KEY, documents: { "../../licenses/ATITHI-FREE": { value: 1 }, "ok_doc": { value: 2 } } }));
answers.push(KEY);
await page.setInputFiles("#dmRestoreFile", evil); await page.waitForTimeout(300); await idle();
check("path-traversal doc id in backup is skipped, safe one restored", await page.evaluate(k => !Object.keys(window.__store).some(p => p.includes("ATITHI-FREE")) && !!window.__store["hotels/" + k + "/data/ok_doc"], KEY));

console.log("🛟 auto backups (server snapshots)");
await page.evaluate(k => {
  window.__store["backups/" + k + "/snaps/2026-10-28__bookings"] = { value: [{ id: "old1", name: "Backup Guest" }], ts: 1, _backupAt: Date.now(), _srcDoc: "bookings" };
  window.__store["backups/" + k + "/snaps/2026-10-28__rooms"] = { value: [{ id: "101" }], ts: 1, _backupAt: Date.now(), _srcDoc: "rooms" };
  window.__store["backups/" + k + "/snaps/junk-id"] = { value: 1 };
}, KEY);
await page.evaluate(() => dmOpenAutoBackups()); await idle();
const abText = await page.locator("#dmBody").innerText();
check("auto backups listed by day (junk ids ignored)", /2026-10-28/.test(abText) && /bookings/.test(abText) && /rooms/.test(abText) && !/junk-id/.test(abText), abText.slice(0, 200));
answers.push("WRONG-KEY");
await page.evaluate(() => dmAutoRestore("2026-10-28", DM.auto["2026-10-28"].findIndex(x => x.src === "bookings"))); await idle();
check("wrong key → nothing restored", await page.evaluate(k => !window.__store["hotels/" + k + "/data/bookings"].value.some(b => b.id === "old1"), KEY));
answers.push(KEY);
await page.evaluate(() => dmAutoRestore("2026-10-28", DM.auto["2026-10-28"].findIndex(x => x.src === "bookings"))); await idle();
const rb = await page.evaluate(k => window.__store["hotels/" + k + "/data/bookings"], KEY);
check("auto backup restored over live bookings, backup-only fields stripped", rb.value.length === 1 && rb.value[0].id === "old1" && rb._backupAt === undefined && rb._srcDoc === undefined, rb);

console.log("permission-denied surfaces a clear message");
await page.evaluate(() => { window.__denyDelete = true; });
await page.evaluate(() => dmDeleteDoc(DM.docs.findIndex(d => d.id === "ok_doc"))); await idle();
check("rules hint shown on permission-denied", (await page.locator("#dmMsg").innerText()).includes("firestore.rules publish"));

check("no page errors", pageErrors.length === 0, pageErrors);
console.log(`\n=== DATA MANAGER (browser): ${pass} passed, ${fail} failed ===`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
