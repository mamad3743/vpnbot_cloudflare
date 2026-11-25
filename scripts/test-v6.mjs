import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migration_v6.sql', import.meta.url), 'utf8');
const baseSchema = schema.split('-- نسخه ۶:')[0];

// تست ارتقای دیتابیس موجود (مایگریشن دوبار هم باید بی‌خطر باشد).
const oldDb = new DatabaseSync(':memory:');
oldDb.exec(baseSchema);
oldDb.exec(migration);
oldDb.exec(migration);

// تست دیتابیس تازه.
const freshDb = new DatabaseSync(':memory:');
freshDb.exec(schema);

for (const db of [oldDb, freshDb]) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  for (const name of ['resellers','coupons','tickets','ticket_messages','transactions','audit_logs','server_health']) assert.ok(tables.has(name), `missing ${name}`);
  db.prepare("INSERT INTO users(id,username,first_name,wallet_balance) VALUES(1001,'testuser','Test',50000)").run();
  db.prepare("INSERT INTO resellers(user_id,commission_percent,price_markup_percent,enabled,created_at,updated_at) VALUES(1001,10,5,1,1,1)").run();
  db.prepare("INSERT INTO coupons(code,discount_type,discount_value,created_at) VALUES('TEST10','percent',10,1)").run();
  const ticket = db.prepare("INSERT INTO tickets(user_id,subject,created_at,updated_at) VALUES(1001,'Test ticket',1,1)").run();
  db.prepare("INSERT INTO ticket_messages(ticket_id,sender_id,sender_type,message,created_at) VALUES(?,1001,'user','Hello',1)").run(Number(ticket.lastInsertRowid));
  db.prepare("INSERT INTO transactions(user_id,type,amount,balance_after,created_at) VALUES(1001,'wallet_adjustment',1000,51000,1)").run();
  db.prepare("INSERT INTO audit_logs(action,created_at) VALUES('test',1)").run();
  db.prepare("INSERT INTO server_health(status,checked_at) VALUES('ok',1)").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM resellers').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM coupons').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ticket_messages').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n,1);
}
oldDb.close(); freshDb.close();
console.log('نسخه ۶: تست اسکیمای تازه، مایگریشن تکرارپذیر و درج داده‌ها موفق بود.');
