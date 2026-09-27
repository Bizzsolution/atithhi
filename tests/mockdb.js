// Shared in-memory Firestore that behaves like the PUBLISHED rules:
//  - collection-wide `list` on licenses/ is DENIED (throws permission-denied)
//  - admin_vault reads/writes allowed only when `rulesPublished` is true
//  - supports doc get/set(merge), batch, and an arrayUnion sentinel
function makeDB(opts) {
  opts = opts || {};
  const store = {};
  const log = { writes: [] };
  // hardenedRules (default ON): mirror the 2026-09 rules — licenses/,
  // admin/, admin_vault/ and billing/ require an authenticated admin.
  const state = { rulesPublished: opts.rulesPublished !== false, hardenedRules: opts.hardenedRules !== false, authed: false };
  const denied = () => { const e = new Error("Missing or insufficient permissions."); e.code = "permission-denied"; return e; };
  const ADMIN_ONLY = /^(licenses|admin|admin_vault|billing)\//;

  function applySet(path, data, merge) {
    const prev = store[path];
    const out = merge && prev ? Object.assign({}, prev) : {};
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__arrayUnion) {
        const cur = Array.isArray(out[k]) ? [...out[k]] : [];
        v.__arrayUnion.forEach(x => { if (!cur.includes(x)) cur.push(x); });
        out[k] = cur;
      } else out[k] = JSON.parse(JSON.stringify(v));
    }
    store[path] = out;
    log.writes.push({ path, data: JSON.parse(JSON.stringify(data, (k, v) => (v && v.__arrayUnion ? { arrayUnion: v.__arrayUnion } : v))) });
  }
  function guard(path) {
    if (path.startsWith("admin_vault/") && !state.rulesPublished) throw denied();
    if (state.hardenedRules && ADMIN_ONLY.test(path) && !state.authed) throw denied();
  }
  function docRef(path) {
    return {
      _path: path,
      async get() { guard(path); return { exists: path in store, data: () => JSON.parse(JSON.stringify(store[path])), id: path.split("/").pop() }; },
      async set(data, o) { guard(path); applySet(path, data, o && o.merge); },
      collection(sub) { return collRef(path + "/" + sub); }
    };
  }
  function collRef(cp) {
    return {
      doc(id) { return docRef(cp + "/" + id); },
      orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
      async get() {
        if (cp === "licenses") throw denied(); // list denied by rules
        if (state.hardenedRules && ADMIN_ONLY.test(cp + "/") && !state.authed) throw denied();
        const prefix = cp + "/";
        const docs = Object.keys(store).filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map(k => ({ id: k.slice(prefix.length), data: () => store[k] }));
        return { docs, forEach: f => docs.forEach(f), size: docs.length };
      }
    };
  }
  return {
    store, log, state,
    collection: n => collRef(n),
    batch() {
      const ops = [];
      return { set(ref, data, o) { ops.push([ref, data, o]); }, async commit() { ops.forEach(([ref, data, o]) => { guard(ref._path); applySet(ref._path, data, o && o.merge); }); } };
    },
    async runTransaction(fn) {
      return fn({ async get(ref) { return ref.get(); }, set(ref, data, o) { applySet(ref._path, data, o && o.merge); } });
    },
    enableNetwork: async () => {}, disableNetwork: async () => {}, settings: () => {}
  };
}
// Installs a fake /api/admin-auth + firebase.auth() into a jsdom window.
// Correct password → token → signInWithCustomToken flips db.state.authed,
// exactly as a real admin session unlocks the hardened rules.
function installAdminAuth(w, db, serverPassword) {
  const pw = serverPassword || "bizzsathi@2026";
  w.__authCalls = [];
  const realFetch = w.fetch;
  w.fetch = async (url, init) => {
    if (url === "/api/admin-auth") {
      const body = JSON.parse((init && init.body) || "{}");
      w.__authCalls.push(body);
      const ok = body.password === pw;
      return { ok, status: ok ? 200 : 401, json: async () => (ok ? { token: "mock.custom.token" } : { error: "Unauthorized" }) };
    }
    return realFetch ? realFetch(url, init) : Promise.reject(new Error("no network in test"));
  };
  const authObj = {
    async setPersistence() {},
    async signInWithCustomToken(t) {
      if (t !== "mock.custom.token") { const e = new Error("bad token"); e.code = "auth/invalid-custom-token"; throw e; }
      db.state.authed = true;
      return { user: { async getIdTokenResult() { return { claims: { admin: true } }; } } };
    },
    async signOut() { db.state.authed = false; }
  };
  const authFn = () => authObj;
  authFn.Auth = { Persistence: { NONE: "none" } };
  w.firebase = Object.assign(w.firebase || {}, { auth: authFn });
}
module.exports = { makeDB, installAdminAuth };
