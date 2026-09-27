// Firestore rules regression suite — runs against the REAL rules engine.
//
// Run (needs Java 11+ and Node 18+):
//   cd tests
//   npm init -y && npm i -D firebase-tools@13 @firebase/rules-unit-testing@3 firebase@10
//   npx firebase emulators:exec --only firestore --project atithibook-saas "node firestore.rules.test.mjs"
//
// Every "DENY" case below SUCCEEDED against the pre-audit rules — i.e. this
// file fails on the old firestore.rules and passes on the hardened one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = await initializeTestEnvironment({
  projectId: "atithibook-saas",
  firestore: { rules: fs.readFileSync(path.join(here, "..", "firestore.rules"), "utf8") }
});

const KEY = "ATITHI-HOTELGANGA01";
const VAULT = "VABCDEFGHJKLMNPQRSTUVWXY";
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "—", e.message); }
}

await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "licenses", KEY), { key: KEY, plan: "PRO", active: true, phone: "9876543210", features: ["family"] });
  await setDoc(doc(db, "admin", "licenses"), { list: [{ key: KEY, phone: "9876543210" }] });
  await setDoc(doc(db, "admin_vault", VAULT), { licenseKeys: [KEY] });
  await setDoc(doc(db, "billing", VAULT, "invoices", "INV1"), { number: "BZS/26-27/0001" });
  await setDoc(doc(db, "hotels", KEY, "data", "bookings"), { value: [], ts: 1 });
});

const anon = env.unauthenticatedContext().firestore();
const admin = env.authenticatedContext("bizzsathi-admin", { admin: true }).firestore();
const fakeAdminUid = env.authenticatedContext("attacker", { admin: true }).firestore();
const adminUidNoClaim = env.authenticatedContext("bizzsathi-admin", {}).firestore();

console.log("licenses/");
await t("anon cannot forge a new PRO license", () => assertFails(setDoc(doc(anon, "licenses", "ATITHI-FREEPRO999"), { key: "ATITHI-FREEPRO999", plan: "PRO", active: true })));
await t("anon cannot re-activate / change phone of an existing license", () => assertFails(setDoc(doc(anon, "licenses", KEY), { key: KEY, active: true, phone: "9111111111" }, { merge: true })));
await t("anon cannot read registered phones", () => assertFails(getDoc(doc(anon, "licenses", KEY))));
await t("token with admin claim but wrong uid denied", () => assertFails(getDoc(doc(fakeAdminUid, "licenses", KEY))));
await t("admin uid without claim denied", () => assertFails(getDoc(doc(adminUidNoClaim, "licenses", KEY))));
await t("admin can read", () => assertSucceeds(getDoc(doc(admin, "licenses", KEY))));
await t("admin can write (field-level merge)", () => assertSucceeds(setDoc(doc(admin, "licenses", KEY), { key: KEY, features: ["family", "ota_import"] }, { merge: true })));
await t("admin cannot write a doc whose key field mismatches its id", () => assertFails(setDoc(doc(admin, "licenses", "ATITHI-OTHER00001"), { key: KEY })));
await t("nobody can list licenses (even admin)", () => assertFails(getDocs(collection(admin, "licenses"))));

console.log("admin/ (legacy array)");
await t("anon cannot read the whole customer list", () => assertFails(getDoc(doc(anon, "admin", "licenses"))));
await t("anon cannot overwrite/inject into the legacy list", () => assertFails(setDoc(doc(anon, "admin", "licenses"), { list: [] })));
await t("admin can read legacy list (migration)", () => assertSucceeds(getDoc(doc(admin, "admin", "licenses"))));

console.log("admin_vault/ + billing/");
await t("vault ID alone (anon) cannot read index", () => assertFails(getDoc(doc(anon, "admin_vault", VAULT))));
await t("vault ID alone (anon) cannot read invoices", () => assertFails(getDocs(collection(anon, "billing", VAULT, "invoices"))));
await t("admin can read index", () => assertSucceeds(getDoc(doc(admin, "admin_vault", VAULT))));
await t("admin can list own invoices", () => assertSucceeds(getDocs(collection(admin, "billing", VAULT, "invoices"))));
await t("admin_vault rejects extra fields", () => assertFails(setDoc(doc(admin, "admin_vault", VAULT), { licenseKeys: [], evil: 1 })));

console.log("unchanged paths (no regression)");
await t("hotel app (anon + key) still reads its own data", () => assertSucceeds(getDoc(doc(anon, "hotels", KEY, "data", "bookings"))));
await t("hotel app still writes its own data", () => assertSucceeds(setDoc(doc(anon, "hotels", KEY, "data", "bookings"), { value: [{ id: 1 }], ts: 2 })));
await t("public booking snapshot still world-readable", () => assertSucceeds(getDoc(doc(anon, "public_booking", "PBABCDEFGHJKLMNPQ"))));
await t("unknown collection denied by default", () => assertFails(getDoc(doc(admin, "whatever", "x"))));

await env.cleanup();
console.log(`\n=== FIRESTORE RULES: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
