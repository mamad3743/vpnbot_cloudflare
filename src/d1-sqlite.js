// لایه‌ی سازگار با D1 روی SQLite محلی (برای Railway / هر سرور Node)
// فقط همون بخشی از API که ربات استفاده می‌کنه: prepare().bind().first()/all()/run() و batch/exec
// بدون وابستگی خارجی: از node:sqlite (داخل Node 22.13+) استفاده میشه.
import { DatabaseSync } from "node:sqlite";

const isRead = (sql) => /^\s*(select|with|pragma|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);

// D1 مقادیر عددی صحیح رو INTEGER ذخیره می‌کنه؛ boolean/undefined رو هم تبدیل می‌کنیم
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return v;
}
const plain = (row) => (row ? { ...row } : row);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  _args() {
    return this.params.map(norm);
  }
  async first(col) {
    const stmt = this.db.prepare(this.sql);
    if (!isRead(this.sql)) {
      stmt.run(...this._args());
      return null;
    }
    const row = stmt.get(...this._args());
    if (!row) return null;
    return col ? (row[col] ?? null) : plain(row);
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    if (!isRead(this.sql)) {
      const info = stmt.run(...this._args());
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    const rows = stmt.all(...this._args()).map(plain);
    return { results: rows, success: true, meta: { changes: 0 } };
  }
  async run() {
    const stmt = this.db.prepare(this.sql);
    if (isRead(this.sql)) {
      stmt.all(...this._args());
      return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...this._args());
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  return db;
}

export function createD1(db) {
  return {
    prepare: (sql) => new Statement(db, sql),
    async exec(sql) {
      db.exec(sql);
      return { count: 1 };
    },
    async batch(statements) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) out.push(isRead(s.sql) ? await s.all() : await s.run()); // SELECT داخل batch هم نتیجه برمی‌گردونه (مثل D1)
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
  };
}
