# 🏨 AtithiBook SaaS — Owner Guide (Dharamveer ke liye)

## Architecture Overview

```
Customer Phone
     │
     ▼
https://atithhi.netlify.app
     │  (enters license key)
     ▼
Netlify Function /api/scan
     │  (license verified, API key hidden)
     ▼
Google Gemini API
     │
     ▼
Aadhaar data back to customer
```

**Customer ko kabhi nahi pata**: API key, server details, kuch bhi.

---

## STEP 1 — Netlify Setup (One Time)

### 1a. Deploy karo
Yeh 4 files/folders drag karo Netlify pe:
```
index.html
manifest.json
netlify.toml
netlify/
  └── functions/
      └── scan.mjs
```

### 1b. Environment Variables set karo
Netlify Dashboard → Site → **Environment Variables** → Add:

| Key | Value |
|---|---|
| `GEMINI_API_KEY` | Apna Google AI Studio key (AIzaSy...) |
| `VALID_LICENSES` | Comma-separated license keys (below) |

Example VALID_LICENSES value:
```
ATITHI-HOTEL001,ATITHI-HOTEL002,ATITHI-HOTEL003
```

### 1c. Redeploy
Environment variables add karne ke baad **Trigger Deploy** karo.

---

## STEP 2 — License Key Generate Karo

Har customer ke liye ek unique key banao. Simple format:

```
ATITHI-[HOTELCODE]
```

Example keys:
```
ATITHI-RAJHOTEL
ATITHI-SHIVAM01
ATITHI-DELUXE22
ATITHI-SUNRISE1
```

**Rules:**
- Sirf capital letters aur numbers
- 8-20 characters after ATITHI-
- Har hotel ko alag key

---

## STEP 3 — Nayi Customer Add Karna

Jab koi hotel subscribe kare:

1. **License key banao**: e.g., `ATITHI-NEWHOTEL`
2. Netlify → **Environment Variables** → `VALID_LICENSES` edit karo
3. Nayi key add karo (comma se separate):
   ```
   ATITHI-HOTEL001,ATITHI-HOTEL002,ATITHI-NEWHOTEL
   ```
4. **Save** → **Trigger Deploy** (1 min lagta hai)
5. Customer ko WhatsApp pe bhejo:
   ```
   AtithiBook Hotel Management
   URL: https://atithhi.netlify.app
   License Key: ATITHI-NEWHOTEL
   Login: admin / admin123
   
   Pehli baar: URL kholo → License key enter karo → Activate
   ```

---

## STEP 4 — Customer ka License Expire Karna

Agar payment nahi aaya:

1. Netlify → **Environment Variables** → `VALID_LICENSES`
2. Us hotel ki key **remove** karo
3. Deploy
4. Customer ke app mein automatically "License expired" aayega

---

## STEP 5 — Pricing Strategy

### Recommended Plans:

| Plan | Price | Features |
|---|---|---|
| **Starter** | ₹499/month | 15 rooms, basic features |
| **Standard** | ₹799/month | 30 rooms, all features |
| **Premium** | ₹1499/month | Unlimited rooms, priority support |

### Per-scan cost (aapka):
- Google Gemini: ~₹0.01/scan (practically free)
- 100 check-ins/day × 30 days = 3000 scans/month = ~₹30

### Profit per customer:
- ₹499 revenue - ₹30 cost = **₹469 profit per hotel/month**
- 10 hotels = ₹4,690/month
- 50 hotels = ₹23,450/month

---

## STEP 6 — Customer Support

Agar customer bolta hai "kaam nahi kar raha":

**Check 1**: License key valid hai?
→ Netlify → VALID_LICENSES mein hai?

**Check 2**: Gemini API quota?
→ aistudio.google.com/apikey → Usage check karo
→ Free tier: 1500 req/day. Zyada chahiye? Paid plan le lo.

**Check 3**: Netlify function errors?
→ Netlify → Functions → Logs dekho

---

## Files Summary

| File | Purpose |
|---|---|
| `index.html` | Customer-facing app |
| `admin.html` | BizzSathi admin panel — licenses, feature control, Billing |
| `firestore.rules` | Security rules — must be published in Firebase Console separately from every code deploy |
| `manifest.json` | PWA (installable on phone) |
| `netlify.toml` | Server routing config + CSP headers |
| `netlify/functions/scan.mjs` | Backend — hides API key, does Aadhaar OCR |
| `netlify/functions/verify-access.mjs` | Phone-bound license verification |
| `netlify/functions/admin.mjs` | Admin panel's server-side auth check |
| `netlify/functions/manage-keys.mjs` | API-key status checker (Settings tab) |

---

## Quick Reference — Adding Customer

```
1. Key banao: ATITHI-XXXXX
2. Netlify env var VALID_LICENSES mein add karo
3. Deploy
4. WhatsApp karo: URL + Key + Login
5. Done ✅
```

---

## Billing Panel (Admin → 🧾 Billing tab)

Client (hotel) ko professional GST invoice banane/bhejне ke liye — Admin
Panel ke andar, Dashboard/Settings ke saamne wala tab.

**🔴 Vault ID — ise zaroor samjho:**
Saare invoices ek secret "Vault ID" (jaise `VABC123...`, 24 characters,
`V` se shuru) ke peeche cloud mein save hote hain. Yeh ID is browser ke
`localStorage` mein rehta hai — kahin doosri jagah automatically backup
nahi hota.

- **Pehli baar Billing tab kholne par** ek peela banner Vault ID copy
  karne ko bolega — usko kahin surakshit jagah (phone notes, password
  manager) save kar lo, phir "✅ Save kar liya" dabao.
- **Agar yeh ID kho gayi** (browser data clear ho gaya, naya device,
  vagera, bina copy kiye) — invoice history khud delete nahi hota, cloud
  mein rehta hai, lekin usse wapas jodना tabhi possible hai jab exact
  Vault ID pata ho. Isliye ise ek baar zaroor kahin likh ke rakho.
- **Doosre device se same invoices dekhne ke liye**: Billing → Settings
  → "Doosre device ka Vault ID paste karo" mein wahi ID daalo.
- Yeh ID **password jaisa hai** — kisi customer/hotel ke saath share mat
  karo (BizzSathi ki apni billing data hai, kisi hotel ki nahi).

