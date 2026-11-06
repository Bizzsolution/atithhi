// Minimal in-memory Firestore/Auth compat stub for browser tests of admin.html.
(function () {
  const store = window.__store = {};          // path -> data object
  window.__denyList = false;                  // simulate unpublished rules (list denied)
  window.__denyDelete = false;
  window.__writes = [];
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const err = code => { const e = new Error("Missing or insufficient permissions."); e.code = code; return e; };
  function snap(path) {
    const d = store[path];
    return { id: path.split("/").pop(), exists: d !== undefined, data: () => clone(d), ref: new DocRef(path) };
  }
  function DocRef(path) { this.path = path; this.id = path.split("/").pop(); }
  DocRef.prototype.get = async function () { return snap(this.path); };
  DocRef.prototype.set = async function (data, opts) {
    if (opts && opts.merge && store[this.path]) store[this.path] = Object.assign({}, store[this.path], clone(data));
    else store[this.path] = clone(data);
    window.__writes.push(["set", this.path]);
  };
  DocRef.prototype.update = DocRef.prototype.set;
  DocRef.prototype.delete = async function () {
    if (window.__denyDelete) throw err("permission-denied");
    delete store[this.path]; window.__writes.push(["delete", this.path]);
  };
  DocRef.prototype.collection = function (n) { return new CollRef(this.path + "/" + n); };
  DocRef.prototype.onSnapshot = function (cb) { cb(snap(this.path)); return () => {}; };
  function CollRef(path) { this.path = path; }
  CollRef.prototype.doc = function (id) { return new DocRef(this.path + "/" + id); };
  CollRef.prototype.get = async function () {
    if (window.__denyList) throw err("permission-denied");
    const pre = this.path + "/";
    const docs = Object.keys(store).filter(p => p.startsWith(pre) && !p.slice(pre.length).includes("/")).sort().map(snap);
    return { docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) };
  };
  CollRef.prototype.orderBy = function () { return this; };
  CollRef.prototype.limit = function () { return this; };
  CollRef.prototype.startAfter = function () { return this; };
  CollRef.prototype.where = function () { return this; };
  CollRef.prototype.onSnapshot = function () { return () => {}; };
  const db = {
    collection: n => new CollRef(n),
    settings() {}, enableNetwork: async () => {},
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); return this; },
        delete(ref) { ops.push(() => ref.delete()); return this; },
        update(ref, data) { ops.push(() => ref.set(data, { merge: true })); return this; },
        async commit() { for (const o of ops) await o(); }
      };
    },
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, d) => r.set(d) })
  };
  const auth = {
    currentUser: null,
    setPersistence: async () => {},
    signInWithCustomToken: async () => { auth.currentUser = { uid: "bizzsathi-admin", getIdTokenResult: async () => ({ claims: { admin: true } }) }; return { user: auth.currentUser }; },
    onAuthStateChanged: cb => { cb(auth.currentUser); return () => {}; },
    signOut: async () => { auth.currentUser = null; }
  };
  window.firebase = {
    initializeApp() {},
    firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => Date.now(), delete: () => null } }),
    auth: Object.assign(() => auth, { Auth: { Persistence: { NONE: "none", LOCAL: "local", SESSION: "session" } } })
  };
})();
