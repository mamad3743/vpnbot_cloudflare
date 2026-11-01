// بازیابی دامپ SQL (خروجی `wrangler d1 export` یا بکاپ شبانه‌ی ربات) داخل دیتابیس SQLite
// دامپ اول داخل یک دیتابیس موقت با همون اسکیمای خودش لود میشه و بعد ستون‌های مشترک هر جدول
// به دیتابیس اصلی منتقل میشه؛ پس حتی اگه دامپ از نسخه‌ی قدیمی‌تر ربات باشه (ستون کمتر) مشکلی نیست.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const SKIP = /^(sqlite_|_cf_|d1_)/;
const q = (n) => `"${String(n).replace(/"/g, '""')}"`;

export function toSqlText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const raw = b.length > 2 && b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b;
  return raw.toString("utf8");
}

// sqlite: دیتابیس اصلی (DatabaseSync) — schemaSql: محتوای schema.sql
export function restoreSql(sqlite, sqlText, schemaSql) {
  if (!/\b(INSERT|CREATE)\b/i.test(sqlText)) throw new Error("فایل SQL معتبر به نظر نمیاد.");
  const tmp = path.join(os.tmpdir(), `restore-${process.pid}-${Date.now()}.db`);
  try {
    const scratch = new DatabaseSync(tmp);
    scratch.exec(sqlText);
    scratch.close();

    sqlite.exec(schemaSql); // جدول‌های جدیدتر که تو دامپ قدیمی نیست
    sqlite.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS src`);
    const result = {};
    try {
      const tables = sqlite
        .prepare("SELECT name FROM src.sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name)
        .filter((n) => !SKIP.test(n));
      sqlite.exec("BEGIN");
      try {
        for (const t of tables) {
          const dst = sqlite.prepare(`PRAGMA main.table_info(${q(t)})`).all().map((c) => c.name);
          if (!dst.length) {
            result[t] = "skipped (not in schema)";
            continue;
          }
          const srcCols = sqlite.prepare(`PRAGMA src.table_info(${q(t)})`).all().map((c) => c.name);
          const common = srcCols.filter((c) => dst.includes(c));
          if (!common.length) continue;
          const cols = common.map(q).join(",");
          const info = sqlite.prepare(`INSERT OR REPLACE INTO main.${q(t)} (${cols}) SELECT ${cols} FROM src.${q(t)}`).run();
          result[t] = Number(info.changes);
        }
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    } finally {
      sqlite.exec("DETACH DATABASE src");
    }
    return result;
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
}
