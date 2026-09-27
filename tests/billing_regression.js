const { JSDOM } = require("jsdom");
const fs = require("fs");
const { makeDB, installAdminAuth } = require("./mockdb.js");
const HTML = fs.readFileSync(require("path").join(__dirname, "..", "admin.html"), "utf8")
  .replace(/<script src="https:\/\/www\.gstatic\.com[^>]*><\/script>/g, "");
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x) : ""); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setVal = (w, id, v) => {
  const el = w.document.getElementById(id);
  const proto = el.tagName === "SELECT" ? "HTMLSelectElement" : el.tagName === "TEXTAREA" ? "HTMLTextAreaElement" : "HTMLInputElement";
  Object.getOwnPropertyDescriptor(w[proto].prototype, "value").set.call(el, v);
  el.dispatchEvent(new w.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const fillItem = (w, i, d, q, r) => {
  const inp = w.document.querySelectorAll("#blItems .bl-item")[i].querySelectorAll("input");
  const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
  [[0, d], [2, q], [3, r]].forEach(([n, v]) => { set.call(inp[n], String(v)); inp[n].dispatchEvent(new w.Event("input", { bubbles: true })); });
};

(async () => {
  const db = makeDB();
  const K = "ATITHI-HOTELGANGA01";
  db.store["licenses/" + K] = { key: K, hotel: "Hotel Ganga Vilas", owner: "Suresh Kumar", phone: "9876543210", plan: "PRO", active: true, features: [] };
  const dom = new JSDOM(HTML, { runScripts: "dangerously", url: "http://localhost/admin.html", pretendToBeVisual: true,
    beforeParse(w) { w.localStorage.setItem("ab_admin_licenses", JSON.stringify([db.store["licenses/" + K]])); } });
  const w = dom.window;
  w.console.warn = () => {}; w.console.error = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.navigator.clipboard = { writeText: async () => {} };
  w._db = db; w.confirm = () => true; w.prompt = () => "Client requested"; w.alert = () => {};
  await sleep(50);
  installAdminAuth(w, w._db);
  w.document.getElementById("adminPass").value = "bizzsathi@2026";
  w.doLogin();
  await sleep(400);
  check("licenses synced from cloud", w.document.getElementById("cloudSyncStatus").textContent === "☁️ Synced");

  w.switchTab("billing");
  await sleep(200);
  check("billing tab active", w.document.getElementById("panel-billing").classList.contains("active"));
  check("billing vault == admin vault (one ID)", w.Billing.vault() === w.adminVaultId());
  check("billing backup banner shown", w.document.getElementById("blVaultBanner").style.display === "block");
  check("client dropdown has the hotel", w.document.getElementById("blClientSel").innerHTML.includes("Hotel Ganga Vilas"));

  w.billingToggleSettings();
  setVal(w, "blSet_stateCode", "09"); setVal(w, "blSet_gstin", "09AAACB1234C1Z5");
  await w.billingSaveSettings();

  w.billingSelectClient(K); setVal(w, "blcState", "09");
  await w.billingIssue(); await sleep(50);
  const inv1 = w.Billing.invoices[0];
  check("invoice #1 numbered /0001", inv1 && /^BZS\/\d{2}-\d{2}\/0001$/.test(inv1.number), inv1 && inv1.number);
  check("same state -> CGST=SGST>0", inv1 && inv1.totals.cgst > 0 && inv1.totals.cgst === inv1.totals.sgst);

  w.billingResetDraft(); setVal(w, "blcName", "Sunrise Resort Goa"); setVal(w, "blcState", "30"); fillItem(w, 0, "Setup Fee", 1, 500);
  await w.billingIssue(); await sleep(50);
  const inv2 = w.Billing.invoices[0];
  check("invoice #2 numbered /0002", /\/0002$/.test(inv2.number), inv2.number);
  check("other state -> IGST", inv2.totals.taxType === "inter" && inv2.totals.igst > 0);

  w.billingOpenViewerById(inv1.id); setVal(w, "blMpRef", "UTR1"); await w.billingConfirmPaid();
  check("mark paid saved to cloud", Object.entries(db.store).some(([k, v]) => k.includes("/invoices/") && v.id === inv1.id && v.status === "paid"));
  await w.billingCancel(inv2.id);
  check("cancel keeps invoice", w.Billing.invoices.length === 2 && w.Billing.invoices.find(i => i.id === inv2.id).status === "cancelled");

  w.billingConfirmVaultBackedUp();
  check("confirming in billing also hides dashboard vault card", w.document.getElementById("vaultCard").style.display === "none");

  const bad = Object.keys(db.store).filter(k => k.startsWith("billing/") === false && k.startsWith("licenses/") && k !== "licenses/" + K);
  check("billing never created/altered license docs", bad.length === 0, bad);

  console.log(`=== BILLING REGRESSION: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH:", e.stack); process.exit(1); });
