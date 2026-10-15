// Browser test of admin.html → 🍽️ Menu (bulk menu upload) against the fake
// Firestore. Covers CSV + XLSX parsing, photo path via a mocked
// /api/menu-extract, review edits, merge vs replace (+ backup), XSS safety,
// and that the saved doc has exactly the shape the hotel app reads.
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SCRATCH = path.dirname(new URL(import.meta.url).pathname);
const DIR = path.join(SCRATCH, "..");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mi-test-"));
const FAKE = fs.readFileSync(path.join(SCRATCH, "fake_firebase.js"), "utf8");
const KEY = "ATITHI-MENU0001";
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log("  ✓", l); } else { fail++; console.log("  ✗ FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x).slice(0, 400) : ""); } };

// Test files
const csvPath = path.join(TMP, "menu.csv");
fs.writeFileSync(csvPath, '﻿Item,Price,Category,Veg\n"Aloo Paratha, with curd",80,Food,veg\nMasala Chai,25,Beverages,veg\nEgg Curry,150,Food,non-veg\n"<img src=x onerror=window.__xss=1>",10,Food,veg\nNo price item,,Food,veg\nCab to station,300,Service,\n');
let xlsxPath = process.env.MENU_XLSX || path.join(TMP, "menu.xlsx");
if (!fs.existsSync(xlsxPath)) {
  execFileSync("python3", ["-c", `import openpyxl,sys
wb=openpyxl.Workbook();ws=wb.active;ws.title="Menu";ws.append(["Hotel Test Menu"]);ws.append([])
ws.append(["S.No","Item Name","Category","Rate (Rs)","Veg/Non-veg"])
for r in [(1,"Paneer Tikka","Starters",220,"Veg"),(2,"Butter Chicken","Main course",340,"Non-Veg"),(3,"Cold Coffee","Beverages",90,"veg"),(4,"Iron / Press","Service",15,""),(5,"Masala Chai","Beverages",25,"V")]: ws.append(list(r))
wb.create_sheet("Notes").append(["ignore","me"]);wb.save(sys.argv[1])`, xlsxPath]);
}
const imgPath = path.join(TMP, "menu.png");
fs.writeFileSync(imgPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const server = http.createServer((req, res) => {
  let p = req.url.split("?")[0]; if (p === "/") p = "/admin.html";
  fs.readFile(path.join(DIR, p), (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html" : "text/javascript" }); res.end(d); });
});
await new Promise(r => server.listen(8943, r));
const browser = await chromium.launch(fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
let apiReq = null, apiMode = "ok";
await page.route("**/*", route => {
  const u = route.request().url();
  if (u.includes("firebase-app-compat")) return route.fulfill({ contentType: "text/javascript", body: FAKE });
  if (u.includes("gstatic.com") || u.includes("fonts.g")) return route.fulfill({ contentType: "text/javascript", body: "" });
  if (u.endsWith("/api/menu-extract")) {
    apiReq = { auth: route.request().headers()["authorization"], body: JSON.parse(route.request().postData() || "{}") };
    if (apiMode === "down") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "AI service abhi available nahi hai", code: "AI_UNAVAILABLE" }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [
      { name: "Veg Thali", price: 180, category: "food", veg: true }, { name: "Mutton Rogan Josh", price: 420, category: "food", veg: false },
      { name: "Fresh Lime Soda", price: 60, category: "beverage", veg: true }, { name: "Veg Thali", price: 180, category: "food", veg: true }
    ] }) });
  }
  if (u.startsWith("http://localhost:8943")) return route.continue();
  return route.fulfill({ status: 404, body: "" });
});
const pageErrors = []; page.on("pageerror", e => pageErrors.push(e.message));
const dialogs = []; page.on("dialog", async d => { dialogs.push(d.message().slice(0, 140)); await d.accept(); });
const downloads = []; page.on("download", async dl => { const p = await dl.path(); downloads.push({ name: dl.suggestedFilename(), text: fs.readFileSync(p, "utf8") }); });
const idle = async () => { for (let i = 0; i < 100; i++) { if (!(await page.evaluate(() => MI.busy))) return; await page.waitForTimeout(50); } };
const menuDoc = () => page.evaluate(k => window.__store["hotels/" + k + "/data/menu"], KEY);
const upload = async f => { await page.setInputFiles("#miFile", f); await page.waitForTimeout(150); await idle(); };

await page.goto("http://localhost:8943/admin.html", { waitUntil: "load" });
await page.waitForTimeout(400);
await page.evaluate(KEY => {
  window.__store["hotels/" + KEY + "/data/menu"] = { value: [
    { id: "x1", cat: "☕ Beverages", name: "Masala Chai", price: 20, sub: "", active: true },
    { id: "x2", cat: "🍛 Food", name: "Poha", price: 50, sub: "", active: true }
  ], ts: 1000 };
  licenses = [{ key: KEY, hotel: "Menu Palace", owner: "Mr M", plan: "PRO", active: true, date: "2026-09-01" }];
  firebase.auth().currentUser = { uid: "bizzsathi-admin", getIdToken: async () => "ADMIN.ID.TOKEN" };
}, KEY);

console.log("open");
await page.evaluate(() => openMenuImport(0)); await page.waitForTimeout(150);
check("modal opens with hotel name", (await page.locator("#miModal.open").count()) === 1 && (await page.locator("#miSub").innerText()).includes("Menu Palace"));
check("shows current menu count", (await page.locator("#miMsg").innerText()).includes("2 items"));

console.log("CSV → review → merge");
await upload(csvPath);
let n = await page.locator("#miRows tr").count();
check("CSV: 5 valid rows (no-price row dropped)", n === 5, n);
check("quoted comma kept in name", (await page.locator("#miRows tr input[type=text]").first().inputValue()) === "Aloo Paratha, with curd");
check("existing item shows price change tag", (await page.locator("#miRows").innerText()).includes("₹20 → ₹25"));
check("no XSS from item names", await page.evaluate(() => !window.__xss && !document.querySelector("#miRows img")));
// Untick the hostile row, edit a price
await page.locator("#miRows tr").nth(3).locator("input[type=checkbox]").uncheck();
await page.locator("#miRows tr").nth(2).locator("input[type=number]").fill("160");
await page.click("#miSaveBtn"); await idle();
let doc = await menuDoc();
const byName = nm => doc.value.find(m => m.name === nm);
check("merge: 2 old + 3 new = 5 items (Masala Chai updated not duplicated)", doc.value.length === 5, doc.value.map(m => m.name));
check("merge: same-name price updated, id kept", byName("Masala Chai").price === 25 && byName("Masala Chai").id === "x1");
check("merge: untouched old item kept", byName("Poha") && byName("Poha").price === 50);
check("edited price saved", byName("Egg Curry").price === 160 && byName("Egg Curry").veg === false);
check("unticked hostile row not saved", !doc.value.some(m => /img/.test(m.name)));
check("service → Services cat + transport sub", byName("Cab to station").cat === "🛎️ Services" && byName("Cab to station").sub === "transport");
check("app shape: id/cat/name/price/sub/active on every item", doc.value.every(m => typeof m.id === "string" && m.id && ["🍛 Food", "☕ Beverages", "🛎️ Services"].includes(m.cat) && typeof m.price === "number" && typeof m.sub === "string" && m.active === true));
check("ts bumped", doc.ts > 1000);
check("success message", (await page.locator("#miMsg").innerText()).includes("save ho gaya"));

console.log("XLSX (header on row 3, 2 sheets)");
await upload(xlsxPath);
n = await page.locator("#miRows tr").count();
check("XLSX: 5 rows from first sheet", n === 5, [n, await page.locator("#miMsg").innerText()]);
const names = await page.locator("#miRows input[type=text]").evaluateAll(els => els.map(e => e.value));
check("XLSX names read from shared strings", names.join("|") === "Paneer Tikka|Butter Chicken|Cold Coffee|Iron / Press|Masala Chai", names);
const cats = await page.locator("#miRows select[aria-label=Category]").evaluateAll(els => els.map(e => e.value));
check("XLSX categories guessed", cats.join("|") === "🍛 Food|🍛 Food|☕ Beverages|🛎️ Services|☕ Beverages", cats);
const vegs = await page.locator("#miRows select[aria-label=Veg]").evaluateAll(els => els.map(e => e.value));
check("XLSX veg column read", vegs[1] === "nv" && vegs[0] === "v", vegs);

console.log("Replace mode with backup");
await page.check('input[name="miMode"][value="replace"]');
await page.click("#miSaveBtn"); await idle(); await page.waitForTimeout(300);
doc = await menuDoc();
check("replace: exactly the 5 XLSX items", doc.value.length === 5 && !doc.value.some(m => m.name === "Poha"), doc.value.map(m => m.name));
check("replace asked for confirmation", dialogs.some(d => d.includes("Poora purana menu")));
check("backup JSON of old menu (5 items) downloaded", downloads.length === 1 && JSON.parse(downloads[0].text).length === 5, downloads.map(d => d.name));
check("iron → laundry sub", doc.value.find(m => m.name === "Iron / Press").sub === "laundry");

console.log("Photo → AI (mocked)");
await upload(imgPath);
check("mode reset to Merge for the new file", await page.isChecked('input[name="miMode"][value="merge"]'));
check("photo POSTed with admin bearer token", apiReq && apiReq.auth === "Bearer ADMIN.ID.TOKEN", apiReq && apiReq.auth);
check("photo sent as JPEG base64", apiReq && apiReq.body.mime === "image/jpeg" && /^[A-Za-z0-9+/=]+$/.test(apiReq.body.data));
n = await page.locator("#miRows tr").count();
check("AI duplicates removed (4 → 3 rows)", n === 3, n);
await page.click("#miSaveBtn"); await idle();
doc = await menuDoc();
check("AI items merged in (5 + 3 = 8)", doc.value.length === 8 && doc.value.find(m => m.name === "Mutton Rogan Josh").veg === false, doc.value.length);

console.log("errors");
apiMode = "down";
await upload(imgPath);
check("AI down → clear error, Excel suggestion", (await page.locator("#miMsg").innerText()).includes("AI service"));
const xls = path.join(TMP, "old.xls"); fs.writeFileSync(xls, "junk");
await upload(xls);
check(".xls → save-as-xlsx hint", (await page.locator("#miMsg").innerText()).includes(".xlsx"));
const empty = path.join(TMP, "empty.csv"); fs.writeFileSync(empty, "Item,Price\n");
await upload(empty);
check("empty sheet → 'koi item nahi mila'", (await page.locator("#miMsg").innerText()).includes("koi item"));
check("menu unchanged by failed uploads", (await menuDoc()).value.length === 8);

console.log("UI");
const btn = await page.evaluate(() => { renderLicenses && renderLicenses(); return !!document.querySelector('[onclick^="openMenuImport"]'); }).catch(() => null);
check("🍽️ Menu button on license card", btn === true || (fs.readFileSync(path.join(DIR, "admin.html"), "utf8").includes('onclick="openMenuImport(${i})"')));
if (process.env.SHOTS) {
  apiMode = "ok"; await upload(csvPath);
  await page.screenshot({ path: path.join(process.env.SHOTS, "admin_menu_upload.png"), fullPage: false });
}
check("no page errors", pageErrors.length === 0, pageErrors);
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
