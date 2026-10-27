-- اسکیمای دیتابیس ربات فروش کانفیگ (Cloudflare D1)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  wallet_balance INTEGER DEFAULT 0,
  referral_count INTEGER DEFAULT 0,
  referred_by INTEGER,
  is_banned INTEGER DEFAULT 0,
  registered INTEGER DEFAULT 0,
  used_trial INTEGER DEFAULT 0,
  last_wheel_spin INTEGER DEFAULT 0,
  joined_at INTEGER,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER DEFAULT 30,
  description TEXT DEFAULT '',
  is_trial INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  panel_id INTEGER,                 -- اگه ست باشه، سرویس خودکار روی همون پنل ساخته میشه
  data_limit_gb REAL DEFAULT 0,     -- حجم سرویس پنلی (0 = نامحدود)
  custom TEXT,                      -- JSON تنظیمات «حجم دلخواه»: min_gb,max_gb,min_days,max_days,price_per_gb,price_per_day (NULL = محصول عادی)
  category_id INTEGER               -- دسته‌بندی محصول (NULL = بدون دسته)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  config_text TEXT NOT NULL,
  is_used INTEGER DEFAULT 0,
  assigned_to INTEGER,
  assigned_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER,
  type TEXT NOT NULL,          -- 'purchase' | 'topup' | 'renew'
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'awaiting_receipt', -- awaiting_receipt|pending|processing|approved|rejected
  receipt_file_id TEXT,
  config_text TEXT,                 -- کانفیگ دستی یا لینک اشتراک پنل
  panel_id INTEGER,                 -- سرویس روی کدوم پنل ساخته شده
  panel_username TEXT,
  panel_extra TEXT,                 -- JSON: اطلاعات لازم برای تمدید (مثلا uuid در 3x-ui)
  renew_of INTEGER,                 -- برای سفارش تمدید: شناسه سفارش اصلی
  gb REAL,                          -- حجم انتخاب‌شده (حجم دلخواه/تمدید)؛ NULL = مقدار خود محصول
  days INTEGER,                     -- مدت انتخاب‌شده؛ NULL = مقدار خود محصول
  ext_id INTEGER,                   -- برای تمدید اشتراکِ خارج از ربات: شناسه‌ی ext_services
  created_at INTEGER,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS channels (
  ref TEXT PRIMARY KEY,
  title TEXT
);

CREATE TABLE IF NOT EXISTS exit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  channel_ref TEXT,
  left_at INTEGER
);

-- پنل‌های VPN (Marzban / PasarGuard / sanaei=3x-ui)
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,               -- marzban | pasarguard | sanaei
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  api_token TEXT,
  extra TEXT,                       -- JSON: sub_base, inbound_id, group_ids, protocols, flow
  enabled INTEGER DEFAULT 1
);

-- اشتراک‌هایی که خارج از ربات فروخته شدن و مشتری به حساب تلگرامش وصل کرده (استعلام/تمدید)
CREATE TABLE IF NOT EXISTS ext_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  panel_id INTEGER NOT NULL,
  username TEXT NOT NULL,           -- نام اشتراک روی پنل
  verified INTEGER DEFAULT 0,       -- 1 = مالکیت با فرستادن لینک اشتراک اثبات شده
  created_at INTEGER,
  UNIQUE (user_id, panel_id, username)
);

-- تنظیمات عمومی: شماره کارت، متن پشتیبانی/آموزش، درصد کمیسیون، جوایز گردونه
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- وضعیت‌های موقت (چندمرحله‌ای پنل ادمین + منتظر رسید کاربر)
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_configs_product_unused ON configs (product_id, is_used);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
