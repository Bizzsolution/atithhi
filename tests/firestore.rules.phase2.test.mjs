// Phase-2 rules regression suite (firestore.rules.phase2) — REAL rules engine.
// Run BEFORE publishing Phase 2:
//   npx firebase emulators:exec --only firestore --project atithibook-saas "node firestore.rules.phase2.test.mjs"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = await initializeTestEnvironment({
  projectId: "atithibook-saas",
  firestore: { rules: fs.readFileSync(path.join(here, "..", "firestore.rules.phase2"), "utf8") }
});
const KEY = "ATITHI-HOTELGANGA01", REVOKED = "ATITHI-REVOKED0001";
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "—", e.message); } }
const recs = n => Array.from({ length: n }, (_, i) => ({ id: "BK" + i }));
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "licenses", KEY), { key: KEY, active: true });
  await setDoc(doc(db, "licenses", REVOKED), { key: REVOKED, active: false });
  await setDoc(doc(db, "hotels", KEY, "data", "bookings"), { value: recs(1000), ts: 1 });
  await setDoc(doc(db, "hotels", KEY, "data", "rooms"), { value: recs(10), ts: 1 });
  await setDoc(doc(db, "hotels", KEY, "data", "users"), { value: recs(3), ts: 1 });
  await setDoc(doc(db, "hotels", KEY, "data", "cu"), { value: { u: "owner" }, ts: 1 });
  await setDoc(doc(db, "hotels", REVOKED, "data", "bookings"), { value: recs(5), ts: 1 });
});
const anon = env.unauthenticatedContext().firestore();
const hotel = env.authenticatedContext("hotel:" + KEY + ":d1", { hotelId: KEY }).firestore();
const other = env.authenticatedContext("hotel:ATITHI-OTHERHOTEL:d1", { hotelId: "ATITHI-OTHERHOTEL" }).firestore();
const revoked = env.authenticatedContext("hotel:" + REVOKED + ":d1", { hotelId: REVOKED }).firestore();
const admin = env.authenticatedContext("bizzsathi-admin", { admin: true }).firestore();
const B = id => doc(hotel, "hotels", KEY, "data", id);

console.log("key alone is no longer enough");
await t("anon with the license key can NOT read bookings", () => assertFails(getDoc(doc(anon, "hotels", KEY, "data", "bookings"))));
await t("anon with the license key can NOT write", () => assertFails(setDoc(doc(anon, "hotels", KEY, "data", "rooms"), { value: [], ts: 2 })));
await t("anon can NOT create junk under a random hotel id", () => assertFails(setDoc(doc(anon, "hotels", "ATITHI-JUNK0001", "data", "x"), { value: 1 })));
await t("verified hotel device reads its data", () => assertSucceeds(getDoc(B("bookings"))));
await t("another hotel's token cannot read", () => assertFails(getDoc(doc(other, "hotels", KEY, "data", "bookings"))));
await t("revoked license token is locked out", () => assertFails(getDoc(doc(revoked, "hotels", REVOKED, "data", "bookings"))));

console.log("wipe guard");
await t("normal save (add a booking) allowed", () => assertSucceeds(setDoc(B("bookings"), { value: recs(1001), ts: 3 }, { merge: true })));
await t("archive-sized shrink (−300) allowed", () => assertSucceeds(setDoc(B("bookings"), { value: recs(701), ts: 4 }, { merge: true })));
await t("bigger shrink (−301) denied", () => assertFails(setDoc(B("bookings"), { value: recs(400), ts: 5 }, { merge: true })));
await t("bookings = [] denied", () => assertFails(setDoc(B("bookings"), { value: [], ts: 6 }, { merge: true })));
await t("bookings replaced by a non-list denied", () => assertFails(setDoc(B("bookings"), { value: "x", ts: 6 }, { merge: true })));
await t("rooms = [] denied", () => assertFails(setDoc(B("rooms"), { value: [], ts: 7 }, { merge: true })));
await t("delete one room allowed", () => assertSucceeds(setDoc(B("rooms"), { value: recs(9), ts: 8 }, { merge: true })));
await t("remove one staff user allowed", () => assertSucceeds(setDoc(B("users"), { value: recs(2), ts: 9 }, { merge: true })));
await t("users = [] denied", () => assertFails(setDoc(B("users"), { value: [], ts: 10 }, { merge: true })));
await t("cu = null (logout) allowed", () => assertSucceeds(setDoc(B("cu"), { value: null, ts: 11 }, { merge: true })));
await t("first-time create of a doc allowed", () => assertSucceeds(setDoc(B("reservations"), { value: [], ts: 12 })));
await t("admin restore may shrink anything", () => assertSucceeds(setDoc(doc(admin, "hotels", KEY, "data", "bookings"), { value: recs(10), ts: 13 })));

console.log("backups");
await t("hotel cannot read/list backups", () => assertFails(getDocs(collection(hotel, "backups", KEY, "snaps"))));
await t("admin can list backups", () => assertSucceeds(getDocs(collection(admin, "backups", KEY, "snaps"))));

await env.cleanup();
console.log(`\n=== FIRESTORE RULES PHASE 2: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
