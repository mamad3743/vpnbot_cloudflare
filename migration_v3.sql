-- مایگریشن نسخه ۳: محصول «حجم دلخواه» (فقط یک بار اجرا کن!)
-- پیش‌نیاز: قبلا migration_v2.sql اجرا شده باشه. دیتابیس تازه؟ فقط schema.sql کافیه.
ALTER TABLE products ADD COLUMN custom TEXT;
ALTER TABLE orders ADD COLUMN gb REAL;
ALTER TABLE orders ADD COLUMN days INTEGER;
