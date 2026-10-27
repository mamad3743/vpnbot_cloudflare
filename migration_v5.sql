-- مایگریشن نسخه ۵: دسته‌بندی محصولات (فقط یک بار اجرا کن!)
-- پیش‌نیاز: migration_v2 تا v4 قبلا اجرا شده باشن. دیتابیس تازه؟ فقط schema.sql کافیه.
ALTER TABLE products ADD COLUMN category_id INTEGER;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER
);
