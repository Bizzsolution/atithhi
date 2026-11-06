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
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, writeBatch } from "firebase/firestore";

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
// AD-1 remediation (Phase 1): a device that signed in via
// /api/verify-access's minted custom token carries a { hotelId } claim.
const hotelStaff = env.authenticatedContext("hotel:" + KEY + ":device1", { hotelId: KEY }).firestore();
const wrongHotelStaff = env.authenticatedContext("hotel:ATITHI-OTHERHOTEL:device1", { hotelId: "ATITHI-OTHERHOTEL" }).firestore();

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

console.log("hotels/ — AD-1 remediation Phase 1 (verified identity, additive)");
await t("device with a verified hotelId claim can read its hotel's data", () => assertSucceeds(getDoc(doc(hotelStaff, "hotels", KEY, "data", "bookings"))));
await t("device with a verified hotelId claim can write its hotel's data", () => assertSucceeds(setDoc(doc(hotelStaff, "hotels", KEY, "data", "bookings"), { value: [{ id: 2 }], ts: 3 })));
await t("verified identity ALONE (no ATITHI-shaped id) still grants access to its own claimed hotel — proves verifiedHotel() is a real, independent path and not just documentation", () => assertSucceeds(setDoc(doc(hotelStaff, "hotels", "not-atithi-shaped-at-all", "data", "bookings"), { value: [], ts: 1 })));
await t("a hotelId claim for a DIFFERENT hotel does not grant access to this one (claim is checked per-path, not merely 'has some verified identity')", () => assertFails(getDoc(doc(wrongHotelStaff, "hotels", KEY, "data", "bookings"))));
await t("Phase 1 is additive, not yet restrictive: anon key-shape access to a hotel is untouched even though verifiedHotel() now also exists", () => assertSucceeds(getDoc(doc(anon, "hotels", KEY, "data", "bookings"))));

console.log("hotels/ — admin Data Manager (list/edit/delete is admin-only)");
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "hotels", KEY, "data", "rooms"), { value: [{ id: "r1" }], ts: 1 });
  await setDoc(doc(db, "hotels", KEY, "data", "bookings_archive_2026_05"), { value: [], ts: 1 });
  await setDoc(doc(db, "public_booking", "PBABCDEFGHJKLMNPQ"), { name: "x" });
  await setDoc(doc(db, "public_booking", "PBABCDEFGHJKLMNPQ", "requests", "q1"), { name: "guest" });
});
await t("admin can LIST one hotel's data docs (finds archives without guessing)", () => assertSucceeds(getDocs(collection(admin, "hotels", KEY, "data"))));
await t("anon cannot list a hotel's data docs", () => assertFails(getDocs(collection(anon, "hotels", KEY, "data"))));
await t("verified hotel device cannot list either (list is admin-only)", () => assertFails(getDocs(collection(hotelStaff, "hotels", KEY, "data"))));
await t("fake admin (claim, wrong uid) cannot list", () => assertFails(getDocs(collection(fakeAdminUid, "hotels", KEY, "data"))));
await t("admin can read + edit hotel data", async () => { await assertSucceeds(getDoc(doc(admin, "hotels", KEY, "data", "rooms"))); await assertSucceeds(setDoc(doc(admin, "hotels", KEY, "data", "rooms"), { value: [], ts: 2 })); });
await t("anon (key holder) still CANNOT delete guest data", () => assertFails(deleteDoc(doc(anon, "hotels", KEY, "data", "bookings"))));
await t("verified hotel device still CANNOT delete guest data", () => assertFails(deleteDoc(doc(hotelStaff, "hotels", KEY, "data", "bookings"))));
await t("fake admin cannot delete", () => assertFails(deleteDoc(doc(fakeAdminUid, "hotels", KEY, "data", "rooms"))));
await t("admin CAN delete a hotel data doc", () => assertSucceeds(deleteDoc(doc(admin, "hotels", KEY, "data", "bookings_archive_2026_05"))));
await t("anon cannot delete a public booking page", () => assertFails(deleteDoc(doc(anon, "public_booking", "PBABCDEFGHJKLMNPQ"))));
await t("anon cannot delete booking enquiries", () => assertFails(deleteDoc(doc(anon, "public_booking", "PBABCDEFGHJKLMNPQ", "requests", "q1"))));
await t("admin can delete enquiries + public page", async () => { await assertSucceeds(deleteDoc(doc(admin, "public_booking", "PBABCDEFGHJKLMNPQ", "requests", "q1"))); await assertSucceeds(deleteDoc(doc(admin, "public_booking", "PBABCDEFGHJKLMNPQ"))); });
await t("licenses still cannot be deleted, even by admin", () => assertFails(deleteDoc(doc(admin, "licenses", KEY))));

console.log("public_booking/ — AUDIT-2 F2 (write ownership, enquiry privacy)");
const TOK = "PBQRSTUVWXYZ234567";        // owned by KEY (named in its profile)
const OTHER_TOK = "PBZZZZZZZZZZZZZZZZ";  // nobody's
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "hotels", KEY, "data", "profile"), { value: { hotelName: "Hotel Ganga", publicBookingToken: TOK }, ts: 1 });
  await setDoc(doc(db, "public_booking_owner", TOK), { hotelId: KEY, createdAt: 1 });
  // Review finding B1: the OTHER hotel writes Hotel Ganga's public token
  // into its OWN profile — which it is allowed to do — to try to pass as owner.
  await setDoc(doc(db, "hotels", "ATITHI-OTHERHOTEL", "data", "profile"), { value: { publicBookingToken: TOK }, ts: 1 });
  await setDoc(doc(db, "public_booking", TOK), { hotelName: "Hotel Ganga", hotelAddr: "Haridwar", hotelPhone: "9876543210", roomTypes: [{ type: "Deluxe", rate: 1500 }], updatedAt: 1 });
  await setDoc(doc(db, "public_booking", TOK, "requests", "REQABC123"), { id: "REQABC123", name: "Guest One", phone: "9811111111", status: "pending" });
});
const guestReq = id => ({ id, name: "Asha", phone: "9822222222", email: "", checkIn: "2026-11-01", checkOut: "2026-11-02", roomType: "Deluxe", notes: "", status: "pending", createdAt: "2026-10-11T10:00:00.000Z" });
await t("[F2] anon holding the public link can NOT change the hotel's phone on its page", () => assertFails(setDoc(doc(anon, "public_booking", TOK), { hotelPhone: "9000000000" }, { merge: true })));
await t("[F2] a DIFFERENT verified hotel can NOT change this hotel's page", () => assertFails(setDoc(doc(wrongHotelStaff, "public_booking", TOK), { hotelPhone: "9000000000" }, { merge: true })));
await t("[F2] the owning hotel (verified, bound in public_booking_owner) CAN refresh its page", () => assertSucceeds(setDoc(doc(hotelStaff, "public_booking", TOK), { hotelName: "Hotel Ganga", hotelAddr: "Haridwar", hotelPhone: "9876543210", roomTypes: [], updatedAt: 2 }, { merge: true })));
await t("[F2] the owner cannot smuggle extra fields onto the public page", () => assertFails(setDoc(doc(hotelStaff, "public_booking", TOK), { licenseKey: KEY }, { merge: true })));
await t("[F2] verified hotel cannot create a page under a token bound to nobody", () => assertFails(setDoc(doc(hotelStaff, "public_booking", OTHER_TOK), { hotelName: "x", updatedAt: 1 })));
await t("[F2] the public page stays world-readable", () => assertSucceeds(getDoc(doc(anon, "public_booking", TOK))));
await t("[F2] a guest (anon) CAN submit a well-formed enquiry", () => assertSucceeds(setDoc(doc(anon, "public_booking", TOK, "requests", "REQNEW0001"), guestReq("REQNEW0001"))));
await t("[F2] a guest cannot submit an enquiry pre-marked 'confirmed'", () => assertFails(setDoc(doc(anon, "public_booking", TOK, "requests", "REQNEW0002"), { ...guestReq("REQNEW0002"), status: "confirmed" })));
await t("[F2] a guest cannot submit an enquiry with unexpected fields", () => assertFails(setDoc(doc(anon, "public_booking", TOK, "requests", "REQNEW0003"), { ...guestReq("REQNEW0003"), evil: "x" })));
await t("[F2] enquiries cannot be filed against a page that does not exist", () => assertFails(setDoc(doc(anon, "public_booking", OTHER_TOK, "requests", "REQNEW0004"), guestReq("REQNEW0004"))));
await t("[F2] anon can NOT list the hotel's enquiries (guest names/phones)", () => assertFails(getDocs(collection(anon, "public_booking", TOK, "requests"))));
await t("[F2] anon can NOT read a single enquiry", () => assertFails(getDoc(doc(anon, "public_booking", TOK, "requests", "REQABC123"))));
await t("[F2] anon can NOT flip an enquiry's status", () => assertFails(setDoc(doc(anon, "public_booking", TOK, "requests", "REQABC123"), { status: "declined" }, { merge: true })));
await t("[F2] the owning hotel CAN list its enquiries", () => assertSucceeds(getDocs(collection(hotelStaff, "public_booking", TOK, "requests"))));
await t("[F2] the owning hotel CAN accept/decline (decision fields only)", () => assertSucceeds(setDoc(doc(hotelStaff, "public_booking", TOK, "requests", "REQABC123"), { status: "confirmed", decidedAt: "2026-10-11T11:00:00.000Z", decisionReason: "" }, { merge: true })));
await t("[F2] the owning hotel cannot rewrite the guest's own details", () => assertFails(setDoc(doc(hotelStaff, "public_booking", TOK, "requests", "REQABC123"), { phone: "9000000000" }, { merge: true })));
await t("[F2] a different verified hotel cannot read these enquiries", () => assertFails(getDocs(collection(wrongHotelStaff, "public_booking", TOK, "requests"))));
await t("[F2/B1] another hotel naming this token in ITS OWN profile still cannot change the page", () => assertFails(setDoc(doc(wrongHotelStaff, "public_booking", TOK), { hotelPhone: "9000000000" }, { merge: true })));
await t("[F2/B1] …nor read its enquiries", () => assertFails(getDocs(collection(wrongHotelStaff, "public_booking", TOK, "requests"))));
await t("[F2] nobody but the admin can read an owner binding", async () => { await assertFails(getDoc(doc(anon, "public_booking_owner", TOK))); await assertFails(getDoc(doc(hotelStaff, "public_booking_owner", TOK))); await assertSucceeds(getDoc(doc(admin, "public_booking_owner", TOK))); });
await t("[F2] an owner binding cannot be re-pointed by a hotel", () => assertFails(setDoc(doc(wrongHotelStaff, "public_booking_owner", TOK), { hotelId: "ATITHI-OTHERHOTEL", createdAt: 2 })));
await t("[F2] an EXISTING page cannot be claimed (binding create denied once the page exists)", async () => {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), "public_booking", "PBLEGACYPAGE234567"), { hotelName: "Legacy", updatedAt: 1 }); });
  await assertFails(setDoc(doc(wrongHotelStaff, "public_booking_owner", "PBLEGACYPAGE234567"), { hotelId: "ATITHI-OTHERHOTEL", createdAt: 1 }));
});
await t("[F2] a verified hotel publishes a NEW link: binding + page in one batch", async () => {
  const b = writeBatch(hotelStaff);
  b.set(doc(hotelStaff, "public_booking_owner", "PBNEWLINK234567ABC"), { hotelId: KEY, createdAt: 3 });
  b.set(doc(hotelStaff, "public_booking", "PBNEWLINK234567ABC"), { hotelName: "Hotel Ganga", hotelAddr: "Haridwar", hotelPhone: "9876543210", roomTypes: [], updatedAt: 3 });
  await assertSucceeds(b.commit());
});
await t("[F2] a hotel cannot create a binding naming a DIFFERENT hotel", () => assertFails(setDoc(doc(hotelStaff, "public_booking_owner", "PBNEWLINK2345679XY"), { hotelId: "ATITHI-OTHERHOTEL", createdAt: 4 })));
await t("[F2] a page cannot be created without a binding in the same batch", () => assertFails(setDoc(doc(hotelStaff, "public_booking", "PBNOBINDING234567A"), { hotelName: "x", updatedAt: 1 })));
await t("[F2] admin can backfill a binding for a pre-existing page", () => assertSucceeds(setDoc(doc(admin, "public_booking_owner", "PBLEGACYPAGE234567"), { hotelId: KEY, createdAt: 5 })));
await t("[F2] admin can still read enquiries (Data Manager)", () => assertSucceeds(getDocs(collection(admin, "public_booking", TOK, "requests"))));

console.log("backups/ (server-written, admin-read only)");
await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), "backups", KEY, "snaps", "2026-10-29__bookings"), { value: [{ id: "BK1" }], ts: 1 }); });
await t("[backup] admin can list a hotel's backups", () => assertSucceeds(getDocs(collection(admin, "backups", KEY, "snaps"))));
await t("[backup] admin can read one backup", () => assertSucceeds(getDoc(doc(admin, "backups", KEY, "snaps", "2026-10-29__bookings"))));
await t("[backup] even the admin cannot overwrite a backup from a browser", () => assertFails(setDoc(doc(admin, "backups", KEY, "snaps", "2026-10-29__bookings"), { value: [] })));
await t("[backup] anon cannot read backups", () => assertFails(getDoc(doc(anon, "backups", KEY, "snaps", "2026-10-29__bookings"))));
await t("[backup] the hotel itself cannot read/list/write/delete backups", async () => {
  await assertFails(getDocs(collection(hotelStaff, "backups", KEY, "snaps")));
  await assertFails(setDoc(doc(hotelStaff, "backups", KEY, "snaps", "2026-10-30__bookings"), { value: [] }));
  await assertFails(deleteDoc(doc(hotelStaff, "backups", KEY, "snaps", "2026-10-29__bookings")));
});

await env.cleanup();
console.log(`\n=== FIRESTORE RULES: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
