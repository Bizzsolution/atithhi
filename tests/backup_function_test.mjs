// Unit test for netlify/functions/backup.mjs against an in-memory Firestore REST mock.
//   node tests/backup_function_test.mjs
import { generateKeyPairSync, createHash } from "node:crypto";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log("  ✓", l); } else { fail++; console.log("  ✗ FAIL:", l, x !== undefined ? JSON.stringify(x).slice(0, 300) : ""); } };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_CLIENT_EMAIL = "sa@atithibook-saas.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");

const docs = new Map(); // relative path -> {fields}
const hourOf = k => createHash("sha256").update(k).digest()[0] % 24;
const H = new Date().getUTCHours();
// find two keys that hash to the current hour, one that doesn't
const mk = n => "ATITHI-" + n;
const keysNow = [], keysOther = [];
for (let i = 0; keysNow.length < 2 || keysOther.length < 1; i++) { const k = mk("T" + i.toString(36).toUpperCase().padStart(6, "0")); (hourOf(k) === H ? keysNow : keysOther).push(k); }
const [A, B] = keysNow, C = keysOther[0];
const arr = n => ({ arrayValue: { values: Array.from({ length: n }, (_, i) => ({ mapValue: { fields: { id: { stringValue: "BK" + i } } } })) } });
const now = new Date();
const monthKey = "bookings_archive_" + now.getUTCFullYear() + "_" + String(now.getUTCMonth() + 1).padStart(2, "0");
docs.set(`licenses/${A}`, { fields: { key: { stringValue: A }, active: { booleanValue: true } } });
docs.set(`licenses/${B}`, { fields: { key: { stringValue: B }, active: { booleanValue: false } } }); // revoked: skipped
docs.set(`licenses/${C}`, { fields: { key: { stringValue: C }, active: { booleanValue: true } } }); // other hour
docs.set(`hotels/${A}/data/bookings`, { fields: { value: arr(5), ts: { integerValue: "1" } } });
docs.set(`hotels/${A}/data/rooms`, { fields: { value: arr(3), ts: { integerValue: "1" } } });
docs.set(`hotels/${A}/data/users`, { fields: { value: arr(2), ts: { integerValue: "1" } } });
docs.set(`hotels/${A}/data/${monthKey}`, { fields: { value: arr(4), parts: { integerValue: "2" }, ts: { integerValue: "1" } } });
docs.set(`hotels/${A}/data/${monthKey}_p2`, { fields: { value: arr(4), ts: { integerValue: "1" } } });
docs.set(`hotels/${C}/data/bookings`, { fields: { value: arr(1) } });
const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
docs.set(`backups/${A}/snaps/${old}__bookings`, { fields: { value: arr(1) } });
const writes = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  const rel = decodeURIComponent(u.split("/documents/")[1] || "");
  const [p, qs] = rel.split("?");
  const m = (init.method || "GET").toUpperCase();
  if (m === "PATCH") { docs.set(p, JSON.parse(init.body)); writes.push(p); return new Response("{}", { status: 200 }); }
  if (m === "DELETE") { docs.delete(p); writes.push("DEL " + p); return new Response("{}", { status: 200 }); }
  if (docs.has(p)) return new Response(JSON.stringify({ name: "projects/x/databases/(default)/documents/" + p, ...docs.get(p) }), { status: 200 });
  // collection list
  const pre = p + "/";
  const kids = [...docs.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes("/"));
  if (kids.length) return new Response(JSON.stringify({ documents: kids.map(k => ({ name: "projects/x/databases/(default)/documents/" + k, ...docs.get(k) })) }), { status: 200 });
  if (p === "licenses" || p.endsWith("/snaps")) return new Response("{}", { status: 200 });
  return new Response("", { status: 404 });
};
const mod = await import(path.join(HERE, "../netlify/functions/backup.mjs"));
const today = new Date().toISOString().slice(0, 10);
console.log("=== backup.mjs ===");
const r = await mod.handler({ httpMethod: "POST", body: '{"next_run":"x"}' });
const body = JSON.parse(r.body);
check("run succeeds", r.statusCode === 200, body);
check("only active hotels whose key hashes to this hour are backed up", body.hotels === 1 && body.done === 1, body);
check("core docs copied into backups/{KEY}/snaps/{date}__{doc}", ["bookings", "rooms", "users"].every(d => docs.has(`backups/${A}/snaps/${today}__${d}`)));
check("archive month AND its _p2 part copied", docs.has(`backups/${A}/snaps/${today}__${monthKey}`) && docs.has(`backups/${A}/snaps/${today}__${monthKey}_p2`));
check("backup keeps the original value byte-for-byte", JSON.stringify(docs.get(`backups/${A}/snaps/${today}__bookings`).fields.value) === JSON.stringify(docs.get(`hotels/${A}/data/bookings`).fields.value));
check("backup records time + source doc", docs.get(`backups/${A}/snaps/${today}__rooms`).fields._srcDoc.stringValue === "rooms");
check("revoked hotel not backed up", ![...docs.keys()].some(k => k.startsWith(`backups/${B}/`)));
check("other-hour hotel not touched this run", ![...docs.keys()].some(k => k.startsWith(`backups/${C}/`)));
check("snapshot older than retention deleted", !docs.has(`backups/${A}/snaps/${old}__bookings`));
check("source hotel data never written", !writes.some(w => w.includes("hotels/")));
const r2 = await mod.handler({ httpMethod: "POST" });
check("second call within 10 min is skipped (no write storm)", JSON.parse(r2.body).skipped, r2.body);
mod.__test.reset();
check("GET is refused", (await mod.handler({ httpMethod: "GET" })).statusCode === 405);
console.log(`\n=== BACKUP FUNCTION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
