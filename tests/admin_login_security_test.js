// Regression: admin panel must NOT grant access client-side.
// Usage: node admin_login_security_test.js [path/to/admin.html]
const { JSDOM } = require("jsdom");
const fs = require("fs");
const { makeDB, installAdminAuth } = require("./mockdb.js");
const FILE = process.argv[2] || require("path").join(__dirname, "..", "admin.html");
const HTML = fs.readFileSync(FILE, "utf8").replace(/<script src="https:\/\/www\.gstatic\.com[^>]*><\/script>/g, "");
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x) : ""); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERVER_PW = "Str0ng-Server-Only-Pw!";

async function open(seed) {
  const db = makeDB();
  db.store["licenses/ATITHI-HOTELGANGA01"] = { key: "ATITHI-HOTELGANGA01", hotel: "Hotel Ganga", plan: "PRO", active: true, features: [] };
  const dom = new JSDOM(HTML, { runScripts: "dangerously", url: "http://localhost/admin.html", pretendToBeVisual: true,
    beforeParse(w) { Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v)); } });
  const w = dom.window;
  w.console.warn = () => {}; w.console.error = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.navigator.clipboard = { writeText: async () => {} };
  w.confirm = () => true; w.alert = () => {}; w.prompt = () => null;
  await sleep(50);
  w._db = db;
  installAdminAuth(w, db, SERVER_PW);
  return { w, db };
}
async function tryLogin(w, pw) {
  w.document.getElementById("adminPass").value = pw;
  await w.doLogin();
  await sleep(150);
  return w.document.getElementById("app").style.display === "block";
}

(async () => {
  console.log("=== A. Old hardcoded default password must be rejected ===");
  let { w, db } = await open();
  check("default 'bizzsathi@2026' does NOT open the panel", !(await tryLogin(w, "bizzsathi@2026")));
  check("no Firestore session granted", db.state.authed === false);
  check("zero license writes", db.log.writes.filter(x => x.path.startsWith("licenses/")).length === 0);

  console.log("=== B. A password planted in localStorage must not work ===");
  ({ w, db } = await open({ ab_admin_pwd: "attacker-chosen" }));
  check("localStorage-planted password rejected", !(await tryLogin(w, "attacker-chosen")));
  check("plaintext ab_admin_pwd purged on load", w.localStorage.getItem("ab_admin_pwd") === null);

  console.log("=== C. No client-side reset path ===");
  check("no 'Reset to Default' button", !/Reset to Default/i.test(w.document.body.innerHTML));
  check("no resetAdminToDefault() function", typeof w.resetAdminToDefault !== "function");

  console.log("=== D. Correct server password → authenticated session ===");
  ({ w, db } = await open());
  check("server password opens the panel", await tryLogin(w, SERVER_PW));
  check("password was sent to /api/admin-auth", w.__authCalls.length === 1 && w.__authCalls[0].password === SERVER_PW);
  check("Firestore session is authenticated", db.state.authed === true);
  check("password field cleared after login", w.document.getElementById("adminPass").value === "");

  console.log("=== E. Wrong password → lockout counter, no session ===");
  ({ w, db } = await open());
  for (let i = 0; i < 5; i++) await tryLogin(w, "wrong" + i);
  const err = w.document.getElementById("loginErr").textContent;
  check("locked after 5 failures", /Locked/i.test(err), err);
  check("still no session", db.state.authed === false);

  console.log(`=== ADMIN LOGIN SECURITY (${FILE.includes("pre_audit") ? "PRE-AUDIT" : "PATCHED"}): ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH:", e.stack); process.exit(1); });
