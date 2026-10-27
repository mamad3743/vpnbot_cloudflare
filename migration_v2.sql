-- مایگریشن برای دیتابیس‌های موجود (فقط یک بار اجرا کن!)
-- اگه دیتابیس تازه می‌سازی، به‌جای این فایل از schema.sql استفاده کن.
ALTER TABLE products ADD COLUMN panel_id INTEGER;
ALTER TABLE products ADD COLUMN data_limit_gb REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN panel_id INTEGER;
ALTER TABLE orders ADD COLUMN panel_username TEXT;
ALTER TABLE orders ADD COLUMN panel_extra TEXT;
ALTER TABLE orders ADD COLUMN renew_of INTEGER;

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  api_token TEXT,
  extra TEXT,
  enabled INTEGER DEFAULT 1
);
