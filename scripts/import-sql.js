// بازیابی بکاپ (یا خروجی `wrangler d1 export`) داخل دیتابیس SQLite ربات — روی سیستم خودت یا داخل کانتینر
// استفاده:  node scripts/import-sql.js dump.sql        (یا backup-....sql.gz)
// معمولاً لازم نیست؛ روی Railway از آدرس /restore استفاده کن (README).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/d1-sqlite.js";
import { restoreSql, toSqlText } from "../src/restore.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) {
  console.error("استفاده: node scripts/import-sql.js <dump.sql | backup.sql.gz>");
  process.exit(1);
}
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH = process.env.DB_PATH || (volume ? path.join(volume, "bot.db") : path.join(root, "data", "bot.db"));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = openDatabase(DB_PATH);
const result = restoreSql(db, toSqlText(fs.readFileSync(file)), fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();
console.log(`✅ بازیابی انجام شد → ${DB_PATH}`);
console.table(result);
