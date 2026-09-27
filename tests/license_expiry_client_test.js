// Regression: hotel app must never download the all-hotels legacy list,
// and must get its status from /api/license-status.
// Usage: node license_expiry_client_test.js [path/to/index.html]
const fs = require("fs");
const FILE = process.argv[2] || require("path").join(__dirname, "..", "index.html");
const src = fs.readFileSync(FILE, "utf8");
const start = src.indexOf("async function checkLicenseExpiry()");
let depth = 0, i = src.indexOf("{", start), end = i;
for (; end < src.length; end++) { if (src[end] === "{") depth++; else if (src[end] === "}") { depth--; if (!depth) break; } }
const fnSrc = src.slice(start, end + 1);

let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x) : ""); } };

async function run(scenario) {
  const calls = [];
  const localStorage = { getItem: k => (k === "ab_license_key" ? "atithi-hotelganga01" : null) };
  const fetch = async (url) => {
    calls.push(String(url));
    if (url === "/api/license-status") {
      if (scenario === "endpoint-ok") return { ok: true, status: 200, json: async () => ({ found: true, active: true, plan: "PRO", expiry: "2099-12-31", features: ["family"] }) };
      if (scenario === "endpoint-down") return { ok: false, status: 503, json: async () => ({}) };
    }
    if (String(url).includes("/documents/licenses/")) return { ok: false, status: 403, json: async () => ({}) }; // hardened rules
    if (String(url).includes("/documents/admin/licenses")) return { ok: true, status: 200, json: async () => ({ fields: { list: { arrayValue: { values: [{ mapValue: { fields: { key: { stringValue: "ATITHI-HOTELGANGA01" }, phone: { stringValue: "9876543210" } } } }] } } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const fn = new Function("fetch", "localStorage", "console", fnSrc + "; return checkLicenseExpiry;")(fetch, localStorage, { warn() {} });
  const result = await fn();
  return { calls, result };
}

(async () => {
  let r = await run("endpoint-ok");
  check("uses /api/license-status", r.calls[0] === "/api/license-status", r.calls);
  check("maps status correctly", r.result && r.result.status === "ok" && r.result.plan === "PRO" && r.result.features.includes("family"), r.result);
  check("never downloads legacy all-hotels list", !r.calls.some(u => u.includes("/admin/licenses")), r.calls);

  r = await run("endpoint-down");
  check("endpoint down → still never downloads legacy list", !r.calls.some(u => u.includes("/admin/licenses")), r.calls);
  check("endpoint down + hardened rules → null (no false alarm)", r.result === null, r.result);

  console.log(`=== CLIENT LICENSE CHECK (${FILE.includes("pre_audit") ? "PRE-AUDIT" : "PATCHED"}): ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("CRASH:", e.stack); process.exit(1); });
