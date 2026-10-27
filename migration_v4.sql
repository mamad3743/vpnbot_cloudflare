-- مایگریشن نسخه ۴: استعلام/تمدید اشتراک‌های خارج از ربات + QR (فقط یک بار اجرا کن!)
-- پیش‌نیاز: migration_v2.sql و migration_v3.sql قبلا اجرا شده باشن. دیتابیس تازه؟ فقط schema.sql کافیه.
ALTER TABLE orders ADD COLUMN ext_id INTEGER;

CREATE TABLE IF NOT EXISTS ext_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  panel_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  created_at INTEGER,
  UNIQUE (user_id, panel_id, username)
);
