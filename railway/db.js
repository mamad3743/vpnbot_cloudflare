/**
 * سازگارکننده‌ی D1 و KV روی Node (Railway)
 * ----------------------------------------
 * - DB:  همون API دیتابیس D1 (prepare/bind/first/run/all/batch) روی SQLite داخلی Node
 *        (node:sqlite) — پس کد ربات بدون هیچ تغییری هم روی Cloudflare و هم اینجا کار می‌کنه.
 * - KV:  همون API کلادفلر KV (get/put/delete/list + TTL)، ذخیره‌شده توی همون فایل SQLite
 *        با یک لایه‌ی کش حافظه جلوش.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
const plain = (r) => (r ? { ...r } : r);
const returnsRows = (sql) => /^\s*(select|pragma|with|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;");
  return db;
}

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...p) {
    return new Stmt(this.db, this.sql, p.map(norm));
  }
  _meta(info) {
    return { changes: Number(info?.changes ?? 0), last_row_id: Number(info?.lastInsertRowid ?? 0), rows_read: 0, rows_written: Number(info?.changes ?? 0), duration: 0 };
  }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) {
      const results = st.all(...this.params).map(plain);
      return { success: true, results, meta: this._meta({ changes: 0 }) };
    }
    const info = st.run(...this.params);
    return { success: true, results: [], meta: this._meta(info) };
  }
  async first(col) {
    const row = plain(this.db.prepare(this.sql).get(...this.params)) ?? null;
    return col && row ? row[col] ?? null : row;
  }
  async run() {
    return this._exec();
  }
  async all() {
    return this._exec();
  }
  async raw() {
    const st = this.db.prepare(this.sql);
    st.setReturnArrays?.(true);
    return st.all(...this.params);
  }
}

export function makeD1(db) {
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

export function applySchema(db, schemaFile) {
  db.exec(fs.readFileSync(schemaFile, "utf8"));
}

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
