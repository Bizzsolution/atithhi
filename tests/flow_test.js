const { JSDOM } = require("jsdom");
const fs = require("fs");
const { makeDB, installAdminAuth } = require("./mockdb.js");

const HTML = fs.readFileSync(require("path").join(__dirname, "..", "admin.html"), "utf8")
  // external SDK scripts removed so the mock DB below is the only backend
  .replace(/<script src="https:\/\/www\.gstatic\.com[^>]*><\/script>/g, "");

let pass = 0, fail = 0;
const check = (label, cond, extra) => { if (cond) pass++; else { fail++; console.log("  FAIL:", label, extra !== undefined ? "-> " + JSON.stringify(extra) : ""); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openDevice(db, seed, opts) {
  opts = opts || {};
  const dom = new JSDOM(HTML, { runScripts: "dangerously", url: "http://localhost/admin.html", pretendToBeVisual: true,
    beforeParse(w) { Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v)); } });
  const w = dom.window;
  w.console.warn = () => {}; w.console.error = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.navigator.clipboard = { writeText: async () => {} };
  if (opts.arrayUnion) w.firebase = { firestore: { FieldValue: { arrayUnion: (...k) => ({ __arrayUnion: k }) } } };
  w._db = db;
  w.confirm = () => true; w.alert = () => {}; w.prompt = () => null;
  await sleep(50);
  installAdminAuth(w, w._db);
  w.document.getElementById("adminPass").value = "bizzsathi@2026";
  w.doLogin();
  await waitSync(w);
  return w;
}
async function waitSync(w) {
  for (let i = 0; i < 60; i++) { await sleep(25); const t = w.document.getElementById("cloudSyncStatus").textContent; if (t !== "☁️ —") break; }
  await sleep(50);
}
const indicator = w => w.document.getElementById("cloudSyncStatus").textContent;
const lic = (w, key) => w.eval("licenses").find(l => l.key === key);

(async () => {
  const H = "ATITHI-HOTELGANGA01", H2 = "ATITHI-HOTELYAMUN02";
  const db = makeDB();
  // Cloud today: per-hotel docs are live; the legacy array still holds an OLD copy of H.
  db.store["licenses/" + H] = { key: H, hotel: "Hotel Ganga", owner: "Suresh", phone: "9876543210", plan: "PRO", active: true, features: ["dash", "rooms"] };
  db.store["licenses/" + H2] = { key: H2, hotel: "Hotel Yamuna", owner: "Ramesh", phone: "9811111111", plan: "BASIC", active: true, features: ["dash"] };
  db.store["admin/licenses"] = { list: [{ key: H, hotel: "Hotel Ganga", owner: "Suresh", phone: "9876543210", plan: "PRO", active: true, features: ["dash"] }] };
  const VA = "VABCDEFGHJKLMNPQRSTUVWXY";
  const deviceA = { ab_billing_vault: VA, ab_admin_licenses: JSON.stringify([db.store["licenses/" + H], db.store["licenses/" + H2]]) };

  console.log("=== 1. Main device login -> real cloud sync (not 'List Protected') ===");
  let A = await openDevice(db, deviceA);
  check("indicator shows ☁️ Synced", indicator(A) === "☁️ Synced", indicator(A));
  check("both hotels listed", A.eval("licenses").length === 2, A.eval("licenses").length);
  check("vault index created with both keys", JSON.stringify((db.store["admin_vault/" + VA] || {}).licenseKeys || []) === JSON.stringify([H, H2]), db.store["admin_vault/" + VA]);

  console.log("=== 2. Add a feature (ota_import) to Hotel Ganga ===");
  const idx = A.eval("licenses").findIndex(l => l.key === H);
  A.openFeatureControl(idx);
  A.document.querySelector('#featureList input[data-feat="ota_import"]').checked = true;
  A.saveFeatureControl();
  await sleep(100);
  check("cloud doc now has ota_import", db.store["licenses/" + H].features.includes("ota_import"), db.store["licenses/" + H].features);
  const featWrite = db.log.writes.filter(x => x.path === "licenses/" + H).pop();
  check("feature save wrote ONLY key+features (no stale owner/plan)", JSON.stringify(Object.keys(featWrite.data).sort()) === JSON.stringify(["features", "key"]), Object.keys(featWrite.data));

  console.log("=== 3. Click Migrate (old array has a STALE copy of Hotel Ganga) ===");
  const r = await A.eval("LicenseCloud").migrateOldArrayToNew();
  check("migrate ok", r.ok, r);
  check("migrate skipped existing hotel (0 written, 1 skipped)", r.migrated === 0 && r.skipped === 1, r);
  check("ota_import STILL present after migrate", db.store["licenses/" + H].features.includes("ota_import"), db.store["licenses/" + H].features);

  console.log("=== 4. Relogin on the same device ===");
  A = await openDevice(db, { ab_billing_vault: VA, ab_admin_licenses: A.localStorage.getItem("ab_admin_licenses") });
  check("still ☁️ Synced", indicator(A) === "☁️ Synced", indicator(A));
  check("ota_import still shown after relogin", lic(A, H).features.includes("ota_import"), lic(A, H).features);

  console.log("=== 5. Brand-new incognito window (empty localStorage) ===");
  const writesBefore = db.log.writes.length;
  let B = await openDevice(db, {});
  const demoCreated = Object.keys(db.store).filter(k => /licenses\/ATITHI-(TRIAL|BASIC|PRO0|DEMO)/.test(k));
  check("NO demo licenses created in cloud", demoCreated.length === 0, demoCreated);
  check("no license document overwritten by fresh device", db.log.writes.slice(writesBefore).filter(x => x.path.startsWith("licenses/")).length === 0,
    db.log.writes.slice(writesBefore).map(x => x.path));
  check("Vault card visible on fresh device", B.document.getElementById("vaultCard").style.display === "block");

  console.log("=== 6. Paste main device's Vault ID on the new device ===");
  B.document.getElementById("vaultPasteInput").value = VA;
  await B.useAdminVaultFromDashboard();
  await sleep(100);
  check("new device now ☁️ Synced", indicator(B) === "☁️ Synced", indicator(B));
  check("new device sees BOTH hotels", B.eval("licenses").length === 2, B.eval("licenses").map(l => l.key));
  check("new device sees ota_import", lic(B, H).features.includes("ota_import"));
  check("vault card hidden after paste", B.document.getElementById("vaultCard").style.display === "none");

  console.log("=== 7. Stale device edits phone -> must NOT revert features ===");
  const stale = JSON.parse(JSON.stringify(db.store["licenses/" + H])); stale.features = ["dash"]; // old copy without ota_import
  const C = await openDevice(db, { ab_billing_vault: VA, ab_admin_licenses: JSON.stringify([stale]) });
  // simulate panel holding a stale in-memory copy (e.g. tab left open) then editing phone
  C.eval(`licenses = ${JSON.stringify([stale])}; editModalIndex = 0;`);
  const cl = C.eval("licenses")[0]; cl.phone = "9000000000";
  C.saveLicenses(H, ["phone"]);
  await sleep(100);
  check("phone updated in cloud", db.store["licenses/" + H].phone === "9000000000");
  check("ota_import NOT reverted by stale device", db.store["licenses/" + H].features.includes("ota_import"), db.store["licenses/" + H].features);

  console.log("=== 8. New license on one device appears on the other ===");
  A.document.getElementById("hotelName").value = "Hotel Kaveri";
  A.document.getElementById("ownerName") && (A.document.getElementById("ownerName").value = "Mohan");
  A.document.getElementById("ownerPhone") && (A.document.getElementById("ownerPhone").value = "9822222222");
  const beforeKeys = ((db.store["admin_vault/" + VA] || {}).licenseKeys || []).length;
  if (typeof A.generateKey === "function") { A.generateKey(); await sleep(150); }
  const afterKeys = (db.store["admin_vault/" + VA] || {}).licenseKeys || [];
  check("new key added to vault index", afterKeys.length === beforeKeys + 1, { beforeKeys, after: afterKeys.length });
  const B2 = await openDevice(db, { ab_billing_vault: VA, ab_billing_vault_backedup: VA });
  check("other device sees the new hotel", B2.eval("licenses").some(l => l.hotel === "Hotel Kaveri"), B2.eval("licenses").map(l => l.hotel));
  check("newest hotel shown first", B2.eval("licenses")[0].hotel === "Hotel Kaveri", B2.eval("licenses")[0].hotel);

  console.log("=== 9. Rules NOT yet published -> honest message, zero writes ===");
  const db2 = makeDB({ rulesPublished: false });
  db2.store["licenses/" + H] = { key: H, hotel: "Hotel Ganga", plan: "PRO", active: true, features: ["dash", "ota_import"] };
  const D = await openDevice(db2, { ab_billing_vault: VA, ab_admin_licenses: JSON.stringify([{ key: H, hotel: "Hotel Ganga", plan: "PRO", active: true, features: ["dash"] }]) });
  check("indicator says Rules Update Needed", indicator(D) === "⚠️ Rules Update Needed", indicator(D));
  check("no writes to licenses when rules missing", db2.log.writes.filter(x => x.path.startsWith("licenses/")).length === 0, db2.log.writes.map(x => x.path));
  check("cloud features untouched", db2.store["licenses/" + H].features.includes("ota_import"));

  console.log("=== 10. arrayUnion path (real SDK) + pagination 250 hotels ===");
  const db3 = makeDB();
  const keys = []; for (let i = 0; i < 250; i++) { const k = "ATITHI-P" + String(i).padStart(9, "0"); keys.push(k); db3.store["licenses/" + k] = { key: k, hotel: "H" + i, plan: "BASIC", active: true, features: [], owner: "", phone: "" }; }
  db3.store["admin_vault/" + VA] = { licenseKeys: keys };
  const E = await openDevice(db3, { ab_billing_vault: VA, ab_billing_vault_backedup: VA }, { arrayUnion: true });
  check("first page = 200", E.eval("licenses").length === 200, E.eval("licenses").length);
  check("Load More visible", E.document.getElementById("loadMoreBtn").style.display === "block");
  await E.loadMoreLicenses();
  check("after Load More = 250", E.eval("licenses").length === 250, E.eval("licenses").length);
  await E.findLicenseByKey("ATITHI-P000000003");
  E.eval("LicenseIndex").add(["ATITHI-NEWKEY0001"]);
  await sleep(50);
  const vk = db3.store["admin_vault/" + VA].licenseKeys;
  check("arrayUnion appended without duplicates", vk.length === 251 && new Set(vk).size === 251, vk.length);

  console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH:", e.stack); process.exit(1); });
