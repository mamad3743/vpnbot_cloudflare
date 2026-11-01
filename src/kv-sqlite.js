// KV سازگار با Cloudflare KV روی SQLite محلی (برای Railway) — همون API: get/put/delete/list + TTL
// داده‌ها توی همون فایل دیتابیس (جدول kv) ذخیره میشن و یه کش حافظه جلوشونه.
/** KV سازگار با Cloudflare KV */
export function makeKV(db) {
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, exp INTEGER)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_kv_exp ON kv (exp)");
  const mem = new Map(); // key -> { v, exp }
  const MAX_MEM = 2000;
  const stats = { reads: 0, writes: 0, deletes: 0, lists: 0, memHits: 0 };
  const nowS = () => Math.floor(Date.now() / 1000);
  const sGet = db.prepare("SELECT value, exp FROM kv WHERE key=?");
  const sPut = db.prepare("INSERT INTO kv (key,value,exp) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, exp=excluded.exp");
  const sDel = db.prepare("DELETE FROM kv WHERE key=?");
  const remember = (key, v, exp) => {
    if (mem.size >= MAX_MEM) mem.delete(mem.keys().next().value);
    mem.set(key, { v, exp });
  };
  const alive = (exp) => !exp || exp > nowS();
  return {
    stats,
    async get(key, opts) {
      stats.reads++;
      const type = typeof opts === "string" ? opts : opts?.type || "text";
      let val;
      const m = mem.get(key);
      if (m && alive(m.exp)) {
        stats.memHits++;
        val = m.v;
      } else {
        const row = sGet.get(key);
        if (!row || !alive(row.exp)) {
          mem.delete(key);
          return null;
        }
        val = row.value;
        remember(key, val, row.exp);
      }
      if (type === "json") return JSON.parse(val);
      if (type === "arrayBuffer") return new TextEncoder().encode(val).buffer;
      return val;
    },
    async put(key, value, opts = {}) {
      stats.writes++;
      const v = typeof value === "string" ? value : value instanceof ArrayBuffer ? new TextDecoder().decode(value) : String(value);
      const exp = opts.expiration ? Math.floor(opts.expiration) : opts.expirationTtl ? nowS() + Math.floor(opts.expirationTtl) : null;
      sPut.run(key, v, exp);
      remember(key, v, exp);
    },
    async delete(key) {
      stats.deletes++;
      sDel.run(key);
      mem.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      stats.lists++;
      const rows = db.prepare("SELECT key, exp FROM kv WHERE key LIKE ? ESCAPE '\\' AND key > ? AND (exp IS NULL OR exp > ?) ORDER BY key LIMIT ?")
        .all(prefix.replace(/[\\%_]/g, "\\$&") + "%", cursor || "", nowS(), limit + 1);
      const more = rows.length > limit;
      const keys = rows.slice(0, limit).map((r) => ({ name: r.key, ...(r.exp ? { expiration: r.exp } : {}) }));
      return { keys, list_complete: !more, cursor: more ? keys[keys.length - 1].name : undefined };
    },
    purge() {
      return Number(db.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?").run(nowS()).changes);
    },
    count() {
      return db.prepare("SELECT COUNT(*) n FROM kv").get().n;
    },
  };
}
