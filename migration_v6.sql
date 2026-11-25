-- نسخه ۶: روی دیتابیس‌های موجود یک‌بار اجرا شود. برای دیتابیس تازه schema.sql کافی است.
CREATE TABLE IF NOT EXISTS resellers (
  user_id INTEGER PRIMARY KEY, commission_percent REAL NOT NULL DEFAULT 0,
  price_markup_percent REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL DEFAULT 'percent', discount_value INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER, expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL DEFAULT 'user', message TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, note TEXT DEFAULT '', admin_id INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT NOT NULL,
  target_type TEXT DEFAULT '', target_id TEXT DEFAULT '', details TEXT DEFAULT '', ip TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT, panel_id INTEGER, status TEXT NOT NULL,
  latency_ms INTEGER, message TEXT DEFAULT '', checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON tickets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
