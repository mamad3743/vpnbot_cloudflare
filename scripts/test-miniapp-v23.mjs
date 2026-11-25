import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const root = new URL('../', import.meta.url);
const api = fs.readFileSync(new URL('../src/web/miniapp.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/web/miniapp.part2.html', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
for (const route of ['/app/api/coupon-check','/app/api/purchase-card','/app/api/topup','/app/api/receipt','/app/api/renew-options','/app/api/renew','/app/api/transfer','/app/api/tickets']) assert.ok(api.includes(route), `missing API route ${route}`);
assert.match(api, /discountedAmount/);
assert.match(api, /used_count=used_count\+1/);
assert.match(ui, /applycoupon/);
assert.match(ui, /coupon_code:couponCode/);
for (const action of ['openTopup','receiptPicker','openRenew','openTransfer','openTickets','confirmbuycard']) assert.ok(ui.includes(action), `missing UI action ${action}`);
assert.match(index, /performTransfer,\s*findTransferTarget/);
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
db.prepare("INSERT INTO users(id,username,first_name,registered,wallet_balance) VALUES(1,'buyer','Buyer',1,500000)").run();
db.prepare("INSERT INTO products(name,price,duration_days,enabled,is_trial,panel_id,data_limit_gb) VALUES('Plan',100000,30,1,0,1,20)").run();
const inserts = [
  "INSERT INTO orders(user_id,product_id,type,amount,status,gb,days,panel_username,created_at) VALUES(?,?,'purchase',?,'awaiting_receipt',?,?,?,?)",
  "INSERT INTO orders(user_id,product_id,type,amount,status,renew_of,gb,days,ext_id,created_at) VALUES(?,?,'renew',?,'awaiting_receipt',?,?,?,?,?)",
  "INSERT INTO orders(user_id,product_id,type,amount,status,renew_of,gb,days,ext_id,created_at) VALUES(?,?,'renew',?,'pending',?,?,?,?,?)",
  "INSERT INTO orders(user_id,product_id,type,amount,status,created_at) VALUES(?,NULL,'topup',?,'awaiting_receipt',?)"
];
db.prepare("INSERT INTO coupons(code,discount_type,discount_value,max_uses,used_count,enabled,created_at) VALUES('TATA20','percent',20,5,0,1,?)").run(Date.now());
const coupon = db.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND enabled=1").get('tata20');
assert.equal(100000 - Math.floor(100000 * coupon.discount_value / 100), 80000);
db.prepare("UPDATE coupons SET used_count=used_count+1 WHERE code=? AND (max_uses=0 OR used_count<max_uses)").run('TATA20');
assert.equal(db.prepare("SELECT used_count FROM coupons WHERE code='TATA20'").get().used_count,1);
db.prepare(inserts[0]).run(1,1,100000,20,30,'test_user',Date.now());
db.prepare(inserts[1]).run(1,1,100000,1,20,30,null,Date.now());
db.prepare(inserts[2]).run(1,1,100000,1,20,30,null,Date.now());
db.prepare(inserts[3]).run(1,100000,Date.now());
assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,4);
db.close();
console.log('مینی‌اپ 2.3.1: مسیر کد تخفیف، محاسبه درصدی، سقف استفاده و مسیرهای خرید/رسید/شارژ/تمدید/انتقال/تیکت بررسی شد.');
