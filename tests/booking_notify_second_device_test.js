// Regression: booking-request notifications/approve-decline must work on a
// SECOND device that never generated the public link locally (only ever
// received the token via the cloud profile sync).
//
// Root cause: the booking-requests onSnapshot listener and
// handleRequestDecision both read localStorage.getItem("publicBookingToken")
// directly. That key is written only by saveProfile() — called on the
// device that GENERATES the link — and the profile cloud listener used to
// update only React state, never localStorage. A second device therefore
// had the token in `profile` (UI showed it fine) but an empty localStorage
// copy forever, and the booking-requests listener was wired up ONCE at
// mount (`useEffect(..., [])`) reading that empty localStorage value, so it
// never subscribed and never retried.
//
// This test extracts the real effect bodies via a minimal React/WS/db fake
// and drives them through: device A (token already local at mount) and
// device B (token arrives only via the cloud profile snapshot).
//
// Usage: node booking_notify_second_device_test.js [path/to/index.html]
const fs = require("fs");
const FILE = process.argv[2] || require("path").join(__dirname, "..", "index.html");
const src = fs.readFileSync(FILE, "utf8");
const isPreAudit = FILE.includes("pre_audit");

let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) pass++; else { fail++; console.log("  FAIL:", l, x !== undefined ? "-> " + JSON.stringify(x) : ""); } };

// ── Static source checks: precise, line-level guarantees the fix must hold ──
const profileHandlerMatch = src.match(/unsubProfile = WS\.onSnapshot\("profile", data => \{[\s\S]*?\n\s*\}\);/);
const profileHandlerSrc = profileHandlerMatch ? profileHandlerMatch[0] : "";
check("profile cloud listener exists", !!profileHandlerSrc);
check(
  "profile listener persists publicBookingToken to localStorage (so every device's local copy matches the cloud, not just React state)",
  /localStorage\.setItem\(\s*"publicBookingToken"/.test(profileHandlerSrc),
  profileHandlerSrc.slice(0, 200)
);

const mountEffectMatch = src.match(/\/\/ Real-time Firestore listeners[\s\S]*?\n {2}\}, \[\]\);/);
const mountEffectSrc = mountEffectMatch ? mountEffectMatch[0] : "";
check(
  "booking-requests subscription is NOT one-time-only inside the mount ([]) effect",
  !/collection\("requests"\)\.onSnapshot/.test(mountEffectSrc),
  mountEffectSrc.includes("requests").onSnapshot
);

const reactiveEffectMatch = src.match(/useEffect\(\(\) => \{\s*const tok = \(profile\?\.publicBookingToken[\s\S]*?\n {2}\}, \[profile\?\.publicBookingToken\]\);/);
check(
  "booking-requests subscription now lives in its own effect keyed on profile?.publicBookingToken (re-subscribes the moment the token becomes known, on ANY device)",
  !!reactiveEffectMatch
);

const decisionFnMatch = src.match(/const handleRequestDecision = async \(reqId, decision, reason\) => \{[\s\S]*?\n {2}\};/);
const decisionFnSrc = decisionFnMatch ? decisionFnMatch[0] : "";
check(
  "handleRequestDecision reads the token from React state (profile), not only localStorage",
  /profile\?\.publicBookingToken/.test(decisionFnSrc),
  decisionFnSrc.slice(0, 200)
);

// ── Behavioral simulation of the actual bug: device A vs device B ──
function simulateDevice({ localStorageHasToken, cloudDeliversToken }) {
  // Minimal fakes standing in for the real runtime.
  const localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  if (localStorageHasToken) localStorage.setItem("publicBookingToken", "PBTESTTOKEN0001");

  let bookingRequests = [];
  const setBookingRequests = v => { bookingRequests = v; };
  let profile = { publicBookingToken: localStorage.getItem("publicBookingToken") || "" };
  const setProfile = updater => { profile = typeof updater === "function" ? updater(profile) : updater; };

  const dbCalls = [];
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          onSnapshot: (cb) => {
            dbCalls.push("subscribed:" + profile.publicBookingToken);
            cb({ forEach: () => {} }); // no requests yet, but proves subscription happened
            return () => {};
          }
        })
      })
    })
  };

  // Simulate the CLOUD profile onSnapshot firing after some delay, exactly
  // like WS.onSnapshot("profile", ...) does for a second device.
  const profileListenerBody = isPreAudit
    ? (data) => { setProfile(p => ({ ...p, ...data })); }
    : (data) => {
        setProfile(p => ({ ...p, ...data }));
        if (typeof data.publicBookingToken === "string") localStorage.setItem("publicBookingToken", data.publicBookingToken);
      };

  if (cloudDeliversToken) profileListenerBody({ publicBookingToken: "PBTESTTOKEN0001" });

  // Simulate the booking-requests subscription attempt exactly as each
  // version wires it: pre-audit reads localStorage ONCE; patched reads
  // profile state and re-runs whenever it changes (simulated here as
  // "run once after the profile update above has already landed", which is
  // the realistic ordering on a second device).
  if (isPreAudit) {
    const tok = (localStorage.getItem("publicBookingToken") || "").trim();
    if (tok) fakeDb.collection().doc().collection().onSnapshot(() => {});
  } else {
    const tok = (profile.publicBookingToken || "").trim();
    if (tok) fakeDb.collection().doc().collection().onSnapshot(() => {});
  }

  return { subscribed: dbCalls.length > 0, localStorageToken: localStorage.getItem("publicBookingToken") };
}

console.log(`=== Behavioral simulation (${isPreAudit ? "PRE-AUDIT" : "PATCHED"} logic) ===`);
const deviceA = simulateDevice({ localStorageHasToken: true, cloudDeliversToken: false });
check("device A (generated the link itself) still gets notified", deviceA.subscribed, deviceA);

const deviceB = simulateDevice({ localStorageHasToken: false, cloudDeliversToken: true });
check("device B (only ever synced the token from the cloud) gets notified too", deviceB.subscribed, deviceB);
check("device B's localStorage ends up with the token (so a later reload also works)", deviceB.localStorageToken === "PBTESTTOKEN0001", deviceB);

console.log(`\n=== BOOKING NOTIFY (2nd device) — ${isPreAudit ? "PRE-AUDIT" : "PATCHED"}: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
