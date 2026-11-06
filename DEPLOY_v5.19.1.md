# AtithiBook v5.19.1 — Hardening + Stuck-room fix (Nov 2026)

## Kya badla (user ko koi naya step nahi; screens pixel-to-pixel same)

| # | Fix | File |
|---|---|---|
| 1 | Bookings ab Firestore transaction se merge hoti hain — doosre device ki booking/checkout overwrite nahi hoti | index.html |
| 2 | Room status sirf usi room ka update hota hai (doosre device ka occupied room empty nahi hota) | index.html |
| 3 | Bada hotel: live bookings doc 1 MiB se neeche rakhne ke liye auto-archive window size ke hisaab se chhota hota hai; month archive kai parts (`_p2`, `_p3`…) mein toot-ta hai | index.html, admin.html |
| 4 | Cloud sync fail hone par ab 🔴 + alert (pehle chupchaap fail hota tha) | index.html |
| 5 | Shared cloud `cu` se bina password Owner login band | index.html |
| 6 | Audit log ab "kisne kiya" sahi likhta hai (pehle "unknown", aur pehli logout ke baad band ho jaata tha) | index.html |
| 7 | CSV formula injection fix (Guest History, Audit, Register) — phone number waise hi | index.html |
| 8 | `users` / `rooms` ko khali list se overwrite nahi kar sakte | index.html |
| 9 | ADMIN_SECRET ab phone field mein master key nahi (sirf `ALLOW_SUPPORT_OVERRIDE=true` par) | verify-access.mjs |
| 10 | Roz ka server backup (14 din) + admin panel mein 🛟 Auto Backups → restore | backup.mjs, netlify.toml, admin.html, rules |
| 11 | Phase-2 rules mein wipe-guard (bookings ek baar mein max 300 kam, core lists khali nahi) | firestore.rules.phase2 |
| 12 | Atka room (occupied, par guest nahi — jaise Room 302): Rooms screen par "⚠️ Stuck" + tap karke free karo (pehle cloud check, audit log) | index.html |

## Deploy order (isi kram mein)

1. **Firestore rules (current):** Firebase Console → Firestore → Rules → `firestore.rules.clean` paste → Publish.
   (Sirf naya `backups` block juda hai. Rollback: purana rules file.)
2. **Netlify deploy** poora folder (index.html, admin.html, sw.js v5.19.1, netlify.toml, netlify/functions/).
   - Env vars check: `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (backup ke liye zaroori).
   - `ALLOW_SUPPORT_OVERRIDE` set **mat** karo (support ke liye: admin panel → license → phone number badlo).
   - **ADMIN_SECRET rotate karo** (naya random value).
3. **Backup check (next day):** Netlify → Functions → `backup` logs mein "backup hour N: hotels …" dikhe; admin panel → hotel → 🗂️ Data → 🛟 Auto Backups mein aaj ki date.
4. **Phase 2 rules (baad mein):**
   - Admin Data Manager mein har hotel ka `authVersion` document dikhe (sab devices naye build par).
   - Apne PC par: `cd tests && npx firebase emulators:exec --only firestore --project atithibook-saas "node firestore.rules.phase2.test.mjs"` → 0 failed.
   - Pehle 1–2 pilot hotels par dekho, phir `firestore.rules.phase2.clean` publish. Rollback: `firestore.rules.clean`.
5. **Console settings (5 min):** Firestore → Disaster recovery → Point-in-time recovery ON (Blaze); Google Cloud → APIs & Services → Credentials → Firebase web API key → HTTP referrer = sirf aapka domain; Budget alert set karo.

## Tests (sab chale, 0 fail)
node: functions 47, audit-2 26, menu-extract 27, admin-login 13, license 5, booking-notify 8, flow 29, billing 13, backup 12.
browser: stuck-room 11, restaurant 32, KOT 19, storage-full 15, audit-2 32, data-manager 56, menu-import 34, future-booking 44, hardening 21; smoke 10 tabs × 2 sizes, mobile+desktop screenshots identical to previous build.
security_poc_test: 3 of 4 attacks closed; staff-hash wala abhi khula (server-side staff login = next phase).
Rules tests (`firestore.rules.test.mjs`, `firestore.rules.phase2.test.mjs`) yahan emulator download block hone se nahi chale — upar wala command apne PC par chalao.
