// فایل خودکار — ویرایش نکن؛ از scripts/build-ui.mjs ساخته میشه
export default [
 "CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY,\n  username TEXT,\n  first_name TEXT,\n  wallet_balance INTEGER DEFAULT 0,\n  referral_count INTEGER DEFAULT 0,\n  referred_by INTEGER,\n  is_banned INTEGER DEFAULT 0,\n  registered INTEGER DEFAULT 0,\n  used_trial INTEGER DEFAULT 0,\n  last_wheel_spin INTEGER DEFAULT 0,\n  joined_at INTEGER,\n  last_seen INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS products (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  price INTEGER NOT NULL DEFAULT 0,\n  duration_days INTEGER DEFAULT 30,\n  description TEXT DEFAULT '',\n  is_trial INTEGER DEFAULT 0,\n  enabled INTEGER DEFAULT 1,\n  panel_id INTEGER,                 \n  data_limit_gb REAL DEFAULT 0,     \n  custom TEXT,                      \n  category_id INTEGER               \n)",
 "CREATE TABLE IF NOT EXISTS categories (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  enabled INTEGER DEFAULT 1,\n  sort_order INTEGER DEFAULT 0,\n  created_at INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS configs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  product_id INTEGER NOT NULL,\n  config_text TEXT NOT NULL,\n  is_used INTEGER DEFAULT 0,\n  assigned_to INTEGER,\n  assigned_at INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS orders (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  user_id INTEGER NOT NULL,\n  product_id INTEGER,\n  type TEXT NOT NULL,          \n  amount INTEGER NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'awaiting_receipt', \n  receipt_file_id TEXT,\n  config_text TEXT,                 \n  panel_id INTEGER,                 \n  panel_username TEXT,\n  panel_extra TEXT,                 \n  renew_of INTEGER,                 \n  gb REAL,                          \n  days INTEGER,                     \n  ext_id INTEGER,                   \n  created_at INTEGER,\n  decided_at INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS referrals (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  referrer_id INTEGER NOT NULL,\n  referred_id INTEGER NOT NULL UNIQUE,\n  created_at INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS channels (\n  ref TEXT PRIMARY KEY,\n  title TEXT\n)",
 "CREATE TABLE IF NOT EXISTS exit_logs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  user_id INTEGER,\n  channel_ref TEXT,\n  left_at INTEGER\n)",
 "CREATE TABLE IF NOT EXISTS panels (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  type TEXT NOT NULL,               \n  base_url TEXT NOT NULL,\n  username TEXT,\n  password TEXT,\n  api_token TEXT,\n  extra TEXT,                       \n  enabled INTEGER DEFAULT 1\n)",
 "CREATE TABLE IF NOT EXISTS ext_services (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  user_id INTEGER NOT NULL,\n  panel_id INTEGER NOT NULL,\n  username TEXT NOT NULL,           \n  verified INTEGER DEFAULT 0,       \n  created_at INTEGER,\n  UNIQUE (user_id, panel_id, username)\n)",
 "CREATE TABLE IF NOT EXISTS settings (\n  key TEXT PRIMARY KEY,\n  value TEXT\n)",
 "CREATE TABLE IF NOT EXISTS state (\n  key TEXT PRIMARY KEY,\n  value TEXT,\n  updated_at INTEGER\n)",
 "CREATE INDEX IF NOT EXISTS idx_configs_product_unused ON configs (product_id, is_used)",
 "CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id)",
 "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)"
];
