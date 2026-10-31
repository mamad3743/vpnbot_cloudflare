/**
 * پنل وب مدیریت ربات — API + صفحه
 * مسیرها: /panel (صفحه)، /panel/login?t= (لینک ورود از ربات)، /api/* (JSON)
 * ورود: رمز PANEL_PASSWORD  یا  لینک یک‌بار مصرف از دستور /panel داخل ربات (فقط ادمین‌ها)
 */
import PANEL_HTML from "./ui.generated.js";
import { stats as optStats, invalidateSettings, cacheJson, dropCache } from "./optimizer.js";
import { cfUsage, cfConfigured } from "./cfstats.js";

const enc = new TextEncoder();
const SESSION_DAYS = 7;
const TABLES = ["users", "products", "categories", "configs", "orders", "referrals", "channels", "exit_logs", "panels", "ext_services", "settings"];
const VERSION = "5.0.0";

let ORIGIN = "";
export function setOrigin(env, o) {
  ORIGIN = (env.PUBLIC_URL || o || ORIGIN || "").replace(/\/+$/, "");
}

// ---------- ابزارهای پایه ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randHex = (n = 24) => hex(crypto.getRandomValues(new Uint8Array(n)));
const int = (v, d = 0) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
const str = (v, max = 4000) => (v === undefined || v === null ? "" : String(v)).slice(0, max);
const safeJson = (s, d = {}) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || `${env.PANEL_PASSWORD || ""}|${env.BOT_TOKEN || ""}|${env.WEBHOOK_SECRET || ""}`;
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function signToken(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  return `${body}.${sig}`;
}
async function readToken(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expect = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  let got;
  try {
    got = unb64u(sig);
  } catch {
    return null;
  }
  if (got.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expect[i];
  if (diff) return null;
  const p = safeJson(new TextDecoder().decode(unb64u(body)), null);
  return p && p.e > Date.now() ? p : null;
}
async function safeEqual(env, a, b) {
  const k = await hmacKey(env);
  const x = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(String(a))));
  const y = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(String(b))));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const cookieOf = (request, name) => {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
};
const isHttps = (request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
async function sessionCookie(env, request, uid) {
  const tok = await signToken(env, { u: uid, e: Date.now() + SESSION_DAYS * 86400000 });
  return `vp_s=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(request) ? "; Secure" : ""}`;
}
const clientIp = (r) => (r.headers.get("cf-connecting-ip") || r.headers.get("x-forwarded-for") || "?").split(",")[0].trim();

// محدودیت تلاش ورود (۸ تلاش ناموفق در ۱۰ دقیقه)
async function rlCheck(env, ip) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(`rl:${ip}`).first();
  const v = safeJson(row?.value, { n: 0, t: 0 });
  return !(v.t > Date.now() - 600000 && v.n >= 8);
}
async function rlFail(env, ip) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(`rl:${ip}`).first();
  let v = safeJson(row?.value, { n: 0, t: 0 });
  if (v.t < Date.now() - 600000) v = { n: 0, t: Date.now() };
  v.n++;
  await env.DB.prepare("INSERT INTO state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(`rl:${ip}`, JSON.stringify(v), Date.now()).run();
}

export async function createLoginLink(env, userId) {
  const origin = ORIGIN;
  if (!origin) return null;
  const token = randHex(24);
  await env.DB.prepare("INSERT INTO state (key,value,updated_at) VALUES (?,?,?)")
    .bind(`plogin:${await sha256(token)}`, JSON.stringify({ u: userId, e: Date.now() + 300000 }), Date.now()).run();
  return `${origin}/panel/login?t=${token}`;
}

const adminList = (env) => (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------- روتر ----------
const routes = [];
const R = (method, path, fn) => routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn });

export async function handleWeb(request, env, ctx, I) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;

  const secHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };

  if (m === "GET" && p === "/panel") {
    return new Response(PANEL_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ...secHeaders,
      },
    });
  }
  if (m === "GET" && p === "/panel/manifest.webmanifest") {
    return json({
      name: "پنل ربات", short_name: "پنل", lang: "fa", dir: "rtl", start_url: "/panel", display: "standalone",
      background_color: "#080811", theme_color: "#080811",
      icons: [{ src: "/panel/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
    }, 200, { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" });
  }
  if (m === "GET" && p === "/panel/icon.svg") {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#080811"/><path d="M32 10 49 17v13c0 11-7 19-17 24C22 49 15 41 15 30V17z" fill="none" stroke="#c084fc" stroke-width="4" stroke-linejoin="round"/><path d="M26 31l5 5 9-10" fill="none" stroke="#fbbf24" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }
    );
  }

  // لینک ورود یک‌بار مصرف از ربات
  if (m === "GET" && p === "/panel/login") {
    const t = url.searchParams.get("t") || "";
    const row = t ? await env.DB.prepare("DELETE FROM state WHERE key=? RETURNING value").bind(`plogin:${await sha256(t)}`).first() : null;
    const v = safeJson(row?.value, null);
    if (!v || v.e < Date.now()) {
      return new Response(`<meta charset=utf-8><meta name=viewport content="width=device-width"><body style="font-family:Tahoma;background:#080811;color:#e4e1ef;display:grid;place-items:center;height:100vh;margin:0;text-align:center" dir=rtl><div>⛔ لینک نامعتبر یا منقضی شده.<br><br>داخل ربات دوباره <b>/panel</b> بفرست.</div>`, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", ...secHeaders } });
    }
    return new Response(null, { status: 302, headers: { Location: "/panel", "Set-Cookie": await sessionCookie(env, request, v.u), "Cache-Control": "no-store" } });
  }

  if (!p.startsWith("/api/")) return new Response("not found", { status: 404 });

  // ورود با رمز
  if (m === "POST" && p === "/api/login") {
    if (!env.PANEL_PASSWORD) return err("ورود با رمز فعال نیست؛ PANEL_PASSWORD رو ست کن یا داخل ربات /panel بزن.", 403);
    const ip = clientIp(request);
    if (!(await rlCheck(env, ip))) return err("تلاش زیاد. ۱۰ دقیقه بعد دوباره امتحان کن.", 429);
    const body = await request.json().catch(() => ({}));
    if (!(await safeEqual(env, str(body.password, 200), env.PANEL_PASSWORD))) {
      await rlFail(env, ip);
      return err("رمز اشتباهه.", 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, request, 0) });
  }
  if (m === "POST" && p === "/api/logout") {
    return json({ ok: true }, 200, { "Set-Cookie": "vp_s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
  }

  const session = await readToken(env, cookieOf(request, "vp_s"));
  if (!session) {
    if (p === "/api/me") return json({ ok: false, error: "unauth", passwordLogin: !!env.PANEL_PASSWORD }, 401);
    return err("unauth", 401);
  }
  if (m !== "GET") {
    if (request.headers.get("x-panel") !== "1") return err("bad request", 403);
    const o = request.headers.get("origin");
    if (o && o !== new URL(request.url).origin) return err("bad origin", 403);
  }

  for (const r of routes) {
    if (r.method !== m) continue;
    const mm = p.match(r.re);
    if (!mm) continue;
    const c = { request, env, url, I, session, params: mm.groups || {}, ctx };
    c.body = async () => (await request.json().catch(() => ({}))) || {};
    try {
      return await r.fn(c);
    } catch (e) {
      console.error("api error", p, e);
      return err(String(e?.message || e).slice(0, 300), 500);
    }
  }
  return err("not found", 404);
}

// ---------- me / overview ----------
R("GET", "/api/me", async ({ env, session }) =>
  json({
    ok: true, version: VERSION, runtime: env.RUNTIME === "node" ? "railway" : "cloudflare", user: session.u,
    kv: !!env.KV, cf: cfConfigured(env), password: !!env.PANEL_PASSWORD,
  })
);

const DAY = 86400000, TZ = 12600000; // ایران UTC+3:30
R("GET", "/api/overview", async ({ env, I }) => {
  await I.ensureCatSchema(env);
  const now = Date.now();
  const t0 = Math.floor((now + TZ) / DAY) * DAY - TZ;
  const d7 = t0 - 6 * DAY, d30 = t0 - 29 * DAY, d14 = t0 - 13 * DAY;
  const S = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const rs = await env.DB.batch([
    S(`SELECT COUNT(*) total, COALESCE(SUM(registered=1),0) reg, COALESCE(SUM(is_banned),0) banned, COALESCE(SUM(joined_at>=?),0) new_today,
       COALESCE(SUM(last_seen>=?),0) active24, COALESCE(SUM(wallet_balance),0) wallets FROM users`, t0, now - DAY),
    S(`SELECT COALESCE(SUM(status='pending'),0) pending,
       COALESCE(SUM(CASE WHEN status='approved' AND type IN ('purchase','renew') AND amount>0 AND t>=? THEN amount END),0) rev_today,
       COALESCE(SUM(CASE WHEN status='approved' AND type IN ('purchase','renew') AND amount>0 AND t>=? THEN amount END),0) rev_7,
       COALESCE(SUM(CASE WHEN status='approved' AND type IN ('purchase','renew') AND amount>0 THEN amount END),0) rev_30,
       COALESCE(SUM(CASE WHEN status='approved' AND type IN ('purchase','renew') AND amount>0 AND t>=? THEN 1 END),0) cnt_today,
       COALESCE(SUM(CASE WHEN status='approved' AND type='topup' AND t>=? THEN amount END),0) topup_today
       FROM (SELECT status,type,amount,COALESCE(decided_at,created_at) t FROM orders WHERE COALESCE(decided_at,created_at)>=? OR status='pending')`, t0, d7, t0, t0, d30),
    S(`SELECT CAST((COALESCE(decided_at,created_at)+?)/? AS INTEGER) d, COUNT(*) c, SUM(amount) s FROM orders
       WHERE status='approved' AND type IN ('purchase','renew') AND amount>0 AND COALESCE(decided_at,created_at)>=? GROUP BY d`, TZ, DAY, d14),
    S(`SELECT o.id,o.type,o.amount,o.user_id,o.created_at,(o.receipt_file_id IS NOT NULL) has_receipt,u.first_name,u.username,p.name pname
       FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN products p ON p.id=o.product_id WHERE o.status='pending' ORDER BY o.id DESC LIMIT 8`),
    S(`SELECT p.id,p.name,COALESCE(SUM(c.is_used=0),0) avail FROM products p LEFT JOIN configs c ON c.product_id=p.id
       WHERE p.enabled=1 AND p.panel_id IS NULL AND p.custom IS NULL AND p.is_trial=0 GROUP BY p.id HAVING avail<=3 LIMIT 6`),
    S(`SELECT (SELECT COUNT(*) FROM products WHERE enabled=1) products, (SELECT COUNT(*) FROM panels WHERE enabled=1) panels`),
  ]);
  const g = (i) => rs[i].results || [];
  const byDay = Object.fromEntries(g(2).map((r) => [r.d, r]));
  const base = Math.floor((t0 + TZ) / DAY);
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const k = base - i;
    series.push({ day: t0 - i * DAY, sum: byDay[k]?.s || 0, count: byDay[k]?.c || 0 });
  }
  return json({ ok: true, users: g(0)[0], orders: g(1)[0], series, pending: g(3), lowStock: g(4), counts: g(5)[0] });
});

// ---------- سفارش‌ها ----------
R("GET", "/api/orders", async ({ env, url }) => {
  const st = url.searchParams.get("status") || "", ty = url.searchParams.get("type") || "", q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, int(url.searchParams.get("page"), 1)), size = 20;
  const w = [], b = [];
  if (st) { w.push("o.status=?"); b.push(st); }
  if (ty) { w.push("o.type=?"); b.push(ty); }
  if (q) {
    w.push("(o.id=? OR o.user_id=? OR u.username LIKE ? OR u.first_name LIKE ?)");
    b.push(int(q, -1), int(q, -1), `%${q.replace(/^@/, "")}%`, `%${q}%`);
  }
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  const [tot, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) n FROM orders o LEFT JOIN users u ON u.id=o.user_id ${where}`).bind(...b),
    env.DB.prepare(`SELECT o.id,o.user_id,o.product_id,o.type,o.amount,o.status,o.created_at,o.decided_at,o.gb,o.days,o.panel_username,(o.receipt_file_id IS NOT NULL) has_receipt,
      u.first_name,u.username,p.name pname FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN products p ON p.id=o.product_id ${where}
      ORDER BY o.id DESC LIMIT ? OFFSET ?`).bind(...b, size, (page - 1) * size),
  ]);
  return json({ ok: true, total: tot.results[0].n, page, size, rows: rows.results });
});
R("GET", "/api/orders/:id/receipt", async ({ env, params, I }) => {
  const o = await env.DB.prepare("SELECT receipt_file_id FROM orders WHERE id=?").bind(params.id).first();
  if (!o?.receipt_file_id) return err("رسیدی ثبت نشده", 404);
  const f = await I.rawCall(env, "getFile", { file_id: o.receipt_file_id });
  if (!f.ok) return err(f.description || "خطا در گرفتن فایل از تلگرام", 502);
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  return new Response(r.body, { headers: { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, max-age=600" } });
});
R("POST", "/api/orders/:id/approve", async ({ env, params, I }) => {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(params.id).first();
  if (!order || order.status !== "pending") return err("این سفارش قبلا رسیدگی شده.");
  const r = await I.fulfillOrder(env, order);
  return r.ok ? json({ ok: true }) : err(I.reasonText(r));
});
R("POST", "/api/orders/:id/reject", async ({ env, params, I }) => {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(params.id).first();
  const rj = await env.DB.prepare("UPDATE orders SET status='rejected', decided_at=? WHERE id=? AND status='pending'").bind(Date.now(), params.id).run();
  if (!order || !(rj.meta && rj.meta.changes > 0)) return err("این سفارش قبلا رسیدگی شده.");
  await I.sendMessage(env, order.user_id, `❌ رسید سفارش #${order.id} تایید نشد. برای پیگیری با پشتیبانی تماس بگیر.`);
  await I.logEvent(env, "receipt", `❌ <b>رسید رد شد</b> (سفارش #${order.id}) — از پنل وب\n👤 ${await I.logUserTag(env, order.user_id)}\n💵 ${I.fmtMoney(order.amount)}`);
  return json({ ok: true });
});

// ---------- کاربران ----------
R("GET", "/api/users", async ({ env, url }) => {
  const q = (url.searchParams.get("q") || "").trim(), f = url.searchParams.get("f") || "";
  const page = Math.max(1, int(url.searchParams.get("page"), 1)), size = 20;
  const w = [], b = [];
  if (q) { w.push("(id=? OR username LIKE ? OR first_name LIKE ?)"); b.push(int(q, -1), `%${q.replace(/^@/, "")}%`, `%${q}%`); }
  if (f === "banned") w.push("is_banned=1");
  if (f === "rich") w.push("wallet_balance>0");
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  const order = f === "rich" ? "wallet_balance DESC" : "last_seen DESC";
  const [tot, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) n FROM users ${where}`).bind(...b),
    env.DB.prepare(`SELECT id,username,first_name,wallet_balance,referral_count,is_banned,registered,joined_at,last_seen FROM users ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...b, size, (page - 1) * size),
  ]);
  return json({ ok: true, total: tot.results[0].n, page, size, rows: rows.results });
});
R("GET", "/api/users/:id", async ({ env, params }) => {
  const [u, o] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM users WHERE id=?").bind(params.id),
    env.DB.prepare(`SELECT o.id,o.type,o.amount,o.status,o.created_at,p.name pname FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 15`).bind(params.id),
  ]);
  if (!u.results[0]) return err("کاربر پیدا نشد", 404);
  return json({ ok: true, user: u.results[0], orders: o.results });
});
R("POST", "/api/users/:id/ban", async ({ env, params, body }) => {
  const b = await body();
  await env.DB.prepare("UPDATE users SET is_banned=? WHERE id=?").bind(b.banned ? 1 : 0, params.id).run();
  return json({ ok: true });
});
R("POST", "/api/users/:id/wallet", async ({ env, params, body, I }) => {
  const b = await body();
  const delta = Math.round(num(b.delta, 0));
  if (!delta) return err("مبلغ نامعتبره");
  const r = await env.DB.prepare("UPDATE users SET wallet_balance = MAX(0, wallet_balance + ?) WHERE id=?").bind(delta, params.id).run();
  if (!(r.meta && r.meta.changes > 0)) return err("کاربر پیدا نشد", 404);
  if (b.notify) {
    await I.sendMessage(env, params.id, delta > 0 ? `💰 ${I.fmtMoney(delta)} به کیف پول شما اضافه شد.` : `💳 ${I.fmtMoney(-delta)} از کیف پول شما کم شد.`);
  }
  const u = await env.DB.prepare("SELECT wallet_balance FROM users WHERE id=?").bind(params.id).first();
  return json({ ok: true, balance: u.wallet_balance });
});
R("POST", "/api/users/:id/message", async ({ env, params, body, I }) => {
  const b = await body();
  const text = str(b.text, 3800).trim();
  if (!text) return err("متن خالیه");
  const r = await I.sendMessage(env, params.id, text);
  return r.ok ? json({ ok: true }) : err(r.description || "ارسال نشد");
});

// ---------- دسته‌بندی‌ها ----------
R("GET", "/api/categories", async ({ env, I }) => {
  await I.ensureCatSchema(env);
  const { results } = await env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) products FROM categories c ORDER BY sort_order, id`).all();
  return json({ ok: true, rows: results });
});
R("POST", "/api/categories", async ({ env, body, I }) => {
  await I.ensureCatSchema(env);
  const b = await body();
  const name = str(b.name, 80).trim();
  if (!name) return err("نام دسته الزامیه");
  if (b.id) {
    await env.DB.prepare("UPDATE categories SET name=?, enabled=?, sort_order=? WHERE id=?").bind(name, b.enabled === false || b.enabled === 0 ? 0 : 1, int(b.sort_order), b.id).run();
    return json({ ok: true, id: b.id });
  }
  const r = await env.DB.prepare("INSERT INTO categories (name, enabled, sort_order, created_at) VALUES (?,1,?,?)").bind(name, int(b.sort_order), Date.now()).run();
  return json({ ok: true, id: r.meta.last_row_id });
});
R("DELETE", "/api/categories/:id", async ({ env, params }) => {
  await env.DB.batch([
    env.DB.prepare("UPDATE products SET category_id=NULL WHERE category_id=?").bind(params.id),
    env.DB.prepare("DELETE FROM categories WHERE id=?").bind(params.id),
  ]);
  return json({ ok: true });
});

// ---------- محصولات ----------
R("GET", "/api/products", async ({ env, I }) => {
  await I.ensureCatSchema(env);
  const { results } = await env.DB.prepare(`SELECT p.*, pn.name panel_name, c.name category_name, COALESCE(s.avail,0) avail, COALESCE(s.used,0) used
    FROM products p LEFT JOIN panels pn ON pn.id=p.panel_id LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN (SELECT product_id, SUM(is_used=0) avail, SUM(is_used=1) used FROM configs GROUP BY product_id) s ON s.product_id=p.id ORDER BY p.id DESC`).all();
  return json({ ok: true, rows: results.map((r) => ({ ...r, custom: safeJson(r.custom, null) })) });
});
R("POST", "/api/products", async ({ env, body, I }) => {
  await I.ensureCatSchema(env);
  const b = await body();
  const name = str(b.name, 120).trim();
  if (!name) return err("نام محصول الزامیه");
  const price = Math.round(num(b.price, 0));
  if (price < 0) return err("قیمت منفی نمیشه");
  let custom = null;
  if (b.custom) {
    const c = b.custom;
    const k = { min_gb: num(c.min_gb), max_gb: num(c.max_gb), min_days: int(c.min_days), max_days: int(c.max_days), price_per_gb: num(c.price_per_gb), price_per_day: num(c.price_per_day) };
    if (k.min_gb <= 0 || k.max_gb < k.min_gb) return err("بازه گیگ نامعتبره");
    if (k.min_days < 1 || k.max_days < k.min_days) return err("بازه روز نامعتبره");
    if (k.price_per_gb < 0 || k.price_per_day < 0) return err("قیمت‌ها منفی نمیشن");
    if (Math.round(k.min_gb * k.price_per_gb + k.min_days * k.price_per_day) <= 0) return err("قیمت کمترین بسته صفر میشه");
    custom = JSON.stringify(k);
  }
  const vals = [name, custom ? 0 : price, int(b.duration_days, 30), str(b.description, 1500), b.is_trial ? 1 : 0, b.enabled === false || b.enabled === 0 ? 0 : 1,
    b.panel_id ? int(b.panel_id) : null, num(b.data_limit_gb, 0), custom, b.category_id ? int(b.category_id) : null];
  if (b.is_trial) await env.DB.prepare("UPDATE products SET is_trial=0 WHERE is_trial=1").run(); // فقط یک محصول تست
  if (b.id) {
    await env.DB.prepare(`UPDATE products SET name=?, price=?, duration_days=?, description=?, is_trial=?, enabled=?, panel_id=?, data_limit_gb=?, custom=?, category_id=? WHERE id=?`).bind(...vals, b.id).run();
    return json({ ok: true, id: b.id });
  }
  const r = await env.DB.prepare(`INSERT INTO products (name, price, duration_days, description, is_trial, enabled, panel_id, data_limit_gb, custom, category_id) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(...vals).run();
  return json({ ok: true, id: r.meta.last_row_id });
});
R("DELETE", "/api/products/:id", async ({ env, params }) => {
  await env.DB.batch([env.DB.prepare("DELETE FROM products WHERE id=?").bind(params.id), env.DB.prepare("DELETE FROM configs WHERE product_id=?").bind(params.id)]);
  return json({ ok: true });
});
R("GET", "/api/products/:id/configs", async ({ env, params }) => {
  const { results } = await env.DB.prepare("SELECT id, config_text, is_used, assigned_to FROM configs WHERE product_id=? ORDER BY is_used, id LIMIT 200").bind(params.id).all();
  return json({ ok: true, rows: results });
});
R("POST", "/api/products/:id/configs", async ({ env, params, body }) => {
  const b = await body();
  const lines = str(b.text, 600000).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 1000);
  if (!lines.length) return err("هیچ کانفیگی وارد نشده");
  const stmts = [];
  for (let i = 0; i < lines.length; i += 40) {
    const chunk = lines.slice(i, i + 40);
    stmts.push(env.DB.prepare(`INSERT INTO configs (product_id, config_text) VALUES ${chunk.map(() => "(?,?)").join(",")}`).bind(...chunk.flatMap((l) => [params.id, l])));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, added: lines.length });
});
R("DELETE", "/api/configs/:id", async ({ env, params }) => {
  await env.DB.prepare("DELETE FROM configs WHERE id=? AND is_used=0").bind(params.id).run();
  return json({ ok: true });
});

// ---------- پنل‌های VPN ----------
const maskPanel = (r) => {
  const { password, api_token, extra, ...rest } = r;
  return { ...rest, extra: safeJson(extra), has_password: !!password, has_token: !!api_token };
};
R("GET", "/api/vpnpanels", async ({ env, I }) => {
  const { results } = await env.DB.prepare("SELECT *, (SELECT COUNT(*) FROM products WHERE panel_id=panels.id) products FROM panels ORDER BY id DESC").all();
  return json({ ok: true, types: I.PANEL_TYPES, rows: results.map(maskPanel) });
});
R("POST", "/api/vpnpanels", async ({ env, body, I }) => {
  const b = await body();
  const type = str(b.type, 20);
  if (!I.PANEL_TYPES[type]) return err("نوع پنل نامعتبره");
  const name = str(b.name, 80).trim(), base_url = str(b.base_url, 300).trim().replace(/\/+$/, "");
  if (!name) return err("نام پنل الزامیه");
  if (!/^https?:\/\//i.test(base_url)) return err("آدرس پنل باید با http:// یا https:// شروع بشه");
  if (I.isIpHost(base_url) && env.RUNTIME !== "node") return err("آدرس IP خام روی Cloudflare Workers کار نمیکنه (خطای 1003)؛ از دامنه با SSL استفاده کن.");
  const x = b.extra || {};
  const extra = {};
  const sub = str(x.sub_base, 300).trim().replace(/\/+$/, "");
  if (sub) extra.sub_base = sub;
  if (x.flow) extra.flow = str(x.flow, 60).trim();
  if (type === "marzban" && x.protocols) {
    const arr = (Array.isArray(x.protocols) ? x.protocols : String(x.protocols).split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (arr.some((s) => !["vless", "vmess", "trojan", "shadowsocks"].includes(s))) return err("پروتکل نامعتبره");
    if (arr.length) extra.protocols = arr;
  }
  if (type === "pasarguard" && x.group_ids) {
    const arr = (Array.isArray(x.group_ids) ? x.group_ids : String(x.group_ids).split(",")).map((s) => int(s)).filter((n) => n > 0);
    if (arr.length) extra.group_ids = arr;
  }
  if (type === "sanaei") {
    if (!int(x.inbound_id)) return err("آیدی اینباند (عدد) الزامیه");
    extra.inbound_id = int(x.inbound_id);
    if (!/^https?:\/\//i.test(sub)) return err("آدرس ساب (با http/https) الزامیه");
  }
  let old = null;
  if (b.id) old = await env.DB.prepare("SELECT * FROM panels WHERE id=?").bind(b.id).first();
  const username = str(b.username, 120).trim();
  const password = b.password ? str(b.password, 200) : old?.password || "";
  const token = b.clear_token ? "" : b.api_token ? str(b.api_token, 400) : old?.api_token || "";
  if (!token && (!username || !password)) return err("یوزرنیم و پسورد الزامیه (یا توکن API برای سنایی)");
  const enabled = b.enabled === false || b.enabled === 0 ? 0 : 1;
  let id = b.id;
  if (old) {
    await env.DB.prepare("UPDATE panels SET name=?, type=?, base_url=?, username=?, password=?, api_token=?, extra=?, enabled=? WHERE id=?")
      .bind(name, type, base_url, username, password, token, JSON.stringify(extra), enabled, b.id).run();
  } else {
    const r = await env.DB.prepare("INSERT INTO panels (name,type,base_url,username,password,api_token,extra,enabled) VALUES (?,?,?,?,?,?,?,?)")
      .bind(name, type, base_url, username, password, token, JSON.stringify(extra), enabled).run();
    id = r.meta.last_row_id;
  }
  I.clearPanelCache();
  return json({ ok: true, id });
});
R("DELETE", "/api/vpnpanels/:id", async ({ env, params, I }) => {
  await env.DB.batch([env.DB.prepare("UPDATE products SET panel_id=NULL WHERE panel_id=?").bind(params.id), env.DB.prepare("DELETE FROM panels WHERE id=?").bind(params.id)]);
  I.clearPanelCache();
  return json({ ok: true });
});
R("POST", "/api/vpnpanels/:id/test", async ({ env, params, I }) => {
  const pn = await I.getPanel(env, params.id);
  if (!pn) return err("پنل پیدا نشد", 404);
  try {
    return json({ ok: true, message: await I.panelTest(pn) });
  } catch (e) {
    return err(String(e?.message || e));
  }
});

// ---------- تنظیمات ----------
const SIMPLE_KEYS = { card_number: 60, card_holder: 80, support_text: 3500, tutorial_text: 3500, bot_display_name: 80 };
R("GET", "/api/settings", async ({ env, I }) => {
  const g = (k, d = "") => I.getSetting(env, k, d);
  const [ui, log, wheel] = await Promise.all([I.loadUiCfg(env), I.getLogCfg(env), I.getWheelPrizes(env)]);
  const { results: channels } = await env.DB.prepare("SELECT ref, title FROM channels").all();
  return json({
    ok: true,
    simple: {
      card_number: await g("card_number"), card_holder: await g("card_holder"), support_text: await g("support_text"),
      tutorial_text: await g("tutorial_text"), bot_display_name: await g("bot_display_name", "ربات فروش کانفیگ"),
      referral_percent: await g("referral_percent", "10"), auto_backup: await g("auto_backup", "0"), backup_every_h: await g("backup_every_h", "24"),
    },
    wheel,
    ui: {
      menu: ui.menu, roles: ui.roles, rules_enabled: ui.rules_enabled !== false, rules_text: ui.rules_text || "", rules_btn: ui.rules_btn || "",
      qr_enabled: ui.qr_enabled !== false, ext_verify: ui.ext_verify !== false,
    },
    defaults: { rules_text: I.DEFAULT_RULES_TEXT, rules_btn: I.DEFAULT_RULES_BTN, menu: I.MENU_ITEMS },
    log: { chat_id: log.chat_id, off: log.off, topics: Object.entries(I.LOG_TOPICS).map(([k, v]) => ({ key: k, label: v.label })) },
    channels,
  });
});

const TG_HTML_OK = /^(?:[^<]|<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a(?: href="[^"]*")?|tg-spoiler|blockquote)>)*$/;
R("POST", "/api/settings", async ({ env, body, I, session }) => {
  const b = await body();
  if (b.simple) {
    for (const [k, max] of Object.entries(SIMPLE_KEYS)) if (k in b.simple) await I.setSetting(env, k, str(b.simple[k], max));
    if ("referral_percent" in b.simple) {
      const n = num(b.simple.referral_percent, -1);
      if (n < 0 || n > 100) return err("درصد کمیسیون باید بین ۰ تا ۱۰۰ باشه");
      await I.setSetting(env, "referral_percent", String(n));
    }
    if ("auto_backup" in b.simple) await I.setSetting(env, "auto_backup", b.simple.auto_backup === "1" || b.simple.auto_backup === true ? "1" : "0");
    if ("backup_every_h" in b.simple) await I.setSetting(env, "backup_every_h", String([6, 12, 24, 72, 168].includes(int(b.simple.backup_every_h)) ? int(b.simple.backup_every_h) : 24));
  }
  if (Array.isArray(b.wheel)) {
    const w = b.wheel.map((x) => ({ label: str(x.label, 60).trim(), amount: Math.max(0, Math.round(num(x.amount))), weight: Math.max(0, num(x.weight)) })).filter((x) => x.label);
    if (!w.length || !w.some((x) => x.weight > 0)) return err("حداقل یک جایزه با وزن بیشتر از صفر لازمه");
    await I.setSetting(env, "wheel_prizes", JSON.stringify(w));
  }
  if (b.ui) {
    const cfg = await I.loadUiCfg(env);
    const u = b.ui;
    if (u.menu && typeof u.menu === "object") {
      for (const [key, v] of Object.entries(u.menu)) {
        const def = I.MENU_ITEMS.find((m) => m.key === key);
        if (!def) continue;
        const cur = { ...(cfg.menu[key] || {}) };
        if ("label" in v) { const l = str(v.label, 60).trim(); if (l && l !== def.label) { if (cur.label && cur.label !== l) cur.aliases = [...new Set([...(cur.aliases || []), cur.label])].slice(-5); cur.label = l; } else delete cur.label; }
        if ("style" in v) { if (v.style && v.style !== def.style && I.VALID_STYLES.includes(v.style)) cur.style = v.style; else delete cur.style; }
        if ("hidden" in v) { if (v.hidden && key !== "admin") cur.hidden = true; else delete cur.hidden; }
        if (Object.keys(cur).length) cfg.menu[key] = cur; else delete cfg.menu[key];
      }
    }
    if (u.roles && typeof u.roles === "object") {
      for (const r of ["primary", "success", "danger"]) if (r in u.roles) { if (I.VALID_STYLES.includes(u.roles[r]) && u.roles[r] !== r) cfg.roles[r] = u.roles[r]; else delete cfg.roles[r]; }
    }
    if ("rules_enabled" in u) cfg.rules_enabled = !!u.rules_enabled;
    if ("qr_enabled" in u) cfg.qr_enabled = !!u.qr_enabled;
    if ("ext_verify" in u) cfg.ext_verify = !!u.ext_verify;
    if ("rules_btn" in u) { const t = str(u.rules_btn, 60).trim(); if (t && t !== I.DEFAULT_RULES_BTN) cfg.rules_btn = t; else delete cfg.rules_btn; }
    if ("rules_text" in u) {
      const t = str(u.rules_text, 3500).trim();
      if (t && t !== I.DEFAULT_RULES_TEXT) {
        if (!TG_HTML_OK.test(t)) return err("متن قوانین HTML نامعتبر داره (فقط b, i, u, s, code, pre, a, blockquote مجازه).");
        cfg.rules_text = t;
      } else delete cfg.rules_text;
    }
    await I.saveUiCfg(env, cfg);
  }
  if (b.log) {
    const cfg = await I.getLogCfg(env);
    if (Array.isArray(b.log.off)) cfg.off = b.log.off.filter((k) => I.LOG_TOPICS[k]);
    if ("chat_id" in b.log) {
      if (b.log.chat_id === null || b.log.chat_id === "") { cfg.chat_id = null; cfg.topics = {}; }
      else { const c = int(b.log.chat_id, 0); if (!c) return err("آیدی گروه نامعتبره (مثل -1001234567890)"); if (c !== cfg.chat_id) cfg.topics = {}; cfg.chat_id = c; }
    }
    await I.saveLogCfg(env, cfg);
    if (b.log.test) for (const k of Object.keys(I.LOG_TOPICS)) await I.logEvent(env, k, `🧪 پیام تست از پنل وب — ${I.LOG_TOPICS[k].label}`);
  }
  if (b.rules_preview) {
    const cfg = await I.loadUiCfg(env);
    const to = session.u || adminList(env)[0];
    const text = str(b.rules_preview_text || cfg.rules_text || I.DEFAULT_RULES_TEXT, 3500);
    if (!TG_HTML_OK.test(text)) return err("HTML نامعتبره");
    const r = await I.rawCall(env, "sendMessage", { chat_id: to, text, parse_mode: "HTML" });
    if (!r.ok) return err(r.description || "تلگرام متن رو نپذیرفت");
  }
  return json({ ok: true });
});
R("POST", "/api/channels", async ({ env, body }) => {
  const b = await body();
  const ref = str(b.ref, 80).trim();
  if (!/^@[A-Za-z0-9_]{4,}$/.test(ref) && !/^-100\d+$/.test(ref)) return err("آیدی کانال باید مثل @mychannel یا -100123... باشه");
  await env.DB.prepare("INSERT INTO channels (ref,title) VALUES (?,?) ON CONFLICT(ref) DO UPDATE SET title=excluded.title").bind(ref, str(b.title, 80).trim() || ref).run();
  return json({ ok: true });
});
R("DELETE", "/api/channels", async ({ env, url }) => {
  await env.DB.prepare("DELETE FROM channels WHERE ref=?").bind(url.searchParams.get("ref") || "").run();
  return json({ ok: true });
});

// ---------- پیام همگانی (تکه‌تکه از مرورگر؛ سازگار با سقف تماس‌های پلن رایگان) ----------
R("POST", "/api/broadcast", async ({ env, body, I, session }) => {
  const b = await body();
  const text = str(b.text, 3800).trim();
  if (!text) return err("متن خالیه");
  if (b.test) {
    const to = session.u || adminList(env)[0];
    const r = await I.sendMessage(env, to, text);
    return r.ok ? json({ ok: true }) : err(r.description || "ارسال نشد");
  }
  const offset = Math.max(0, int(b.offset)), limit = Math.min(40, Math.max(1, int(b.limit, 30)));
  const total = offset === 0 ? (await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE registered=1 AND is_banned=0").first()).n : undefined;
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE registered=1 AND is_banned=0 ORDER BY id LIMIT ? OFFSET ?").bind(limit, offset).all();
  let sent = 0, failed = 0;
  for (const u of results) {
    try { const r = await I.sendMessage(env, u.id, text, I.mainMenuKeyboard(I.isAdmin(env, u.id))); r.ok ? sent++ : failed++; } catch { failed++; }
  }
  return json({ ok: true, sent, failed, next: offset + results.length, done: results.length < limit, total });
});

// ---------- مصرف و سلامت ----------
R("GET", "/api/usage", async ({ env, url }) => {
  const fresh = url.searchParams.get("fresh") === "1";
  const lite = url.searchParams.get("lite") === "1"; // نسخه‌ی سبک برای هدر (بدون شمارش جدول‌ها و بدون API کلادفلر)
  const out = { ok: true, runtime: env.RUNTIME === "node" ? "railway" : "cloudflare", optimizer: { ...optStats }, kvBound: !!env.KV };
  if (lite) return json(out);
  const tableCounts = await env.DB.batch(TABLES.map((t) => env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`)));
  out.tables = Object.fromEntries(TABLES.map((t, i) => [t, tableCounts[i].results[0].n]));
  if (env.RUNTIME === "node") {
    out.node = typeof env.RUNTIME_STATS === "function" ? await env.RUNTIME_STATS() : {};
  } else if (cfConfigured(env)) {
    if (fresh) dropCache("cfusage");
    out.cf = await cacheJson(env, "cfusage", 300, () => cfUsage(env));
  } else {
    out.cf = null;
  }
  return json(out);
});
R("POST", "/api/cache/clear", async ({ env, I }) => {
  await invalidateSettings(env);
  dropCache("cfusage");
  I.clearPanelCache();
  return json({ ok: true });
});

// ---------- بکاپ / بازیابی ----------
async function liveColumns(env, table) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return results.map((r) => r.name);
}
R("GET", "/api/backup/meta", async ({ env, I }) => {
  await I.ensureCatSchema(env);
  const counts = await env.DB.batch(TABLES.map((t) => env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`)));
  return json({ ok: true, tables: TABLES.map((t, i) => ({ name: t, rows: counts[i].results[0].n })), version: VERSION, runtime: env.RUNTIME === "node" ? "railway" : "cloudflare" });
});
R("GET", "/api/backup/table", async ({ env, url }) => {
  const name = url.searchParams.get("name");
  if (!TABLES.includes(name)) return err("جدول نامعتبره");
  const offset = Math.max(0, int(url.searchParams.get("offset"))), limit = Math.min(1000, Math.max(1, int(url.searchParams.get("limit"), 500)));
  const columns = await liveColumns(env, name);
  const { results } = await env.DB.prepare(`SELECT * FROM ${name} ORDER BY ${name === "settings" || name === "channels" ? "rowid" : "id"} LIMIT ? OFFSET ?`).bind(limit, offset).all();
  return json({ ok: true, columns, rows: results.map((r) => columns.map((c) => r[c] ?? null)), done: results.length < limit });
});
R("POST", "/api/restore", async ({ env, body, I }) => {
  const b = await body();
  const t = b.table;
  if (!TABLES.includes(t)) return err("جدول نامعتبره");
  await I.ensureCatSchema(env);
  const live = await liveColumns(env, t);
  const cols = (Array.isArray(b.columns) ? b.columns : []).map((c, i) => [c, i]).filter(([c]) => live.includes(c));
  if (!cols.length) return err("ستون‌های جدول با دیتابیس نمیخونه");
  const stmts = [];
  if (b.first && b.mode !== "merge") stmts.push(env.DB.prepare(`DELETE FROM ${t}`));
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 100);
  const sql = `INSERT OR REPLACE INTO ${t} (${cols.map(([c]) => c).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  for (const r of rows) stmts.push(env.DB.prepare(sql).bind(...cols.map(([, i]) => (r[i] === undefined ? null : r[i]))));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, inserted: rows.length });
});
R("POST", "/api/restore/finish", async ({ env, I }) => {
  await invalidateSettings(env);
  I.clearPanelCache();
  return json({ ok: true });
});

export async function buildBackup(env) {
  const out = { format: "vpnbot-backup", version: 1, panel_version: VERSION, created_at: Date.now(), runtime: env.RUNTIME === "node" ? "railway" : "cloudflare", tables: {} };
  for (const t of TABLES) {
    const columns = await liveColumns(env, t);
    const rows = [];
    for (let off = 0; ; off += 1000) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${t} ORDER BY ${t === "settings" || t === "channels" ? "rowid" : "id"} LIMIT 1000 OFFSET ?`).bind(off).all();
      for (const r of results) rows.push(columns.map((c) => r[c] ?? null));
      if (results.length < 1000) break;
    }
    out.tables[t] = { columns, rows };
  }
  return out;
}
export async function sendBackupToAdmins(env, I) {
  const data = JSON.stringify(await buildBackup(env));
  if (data.length > 45_000_000) throw new Error("حجم بکاپ از سقف ۵۰ مگابایتی تلگرام بیشتره");
  const name = `vpnbot-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
  let ok = 0, last = "";
  for (const id of adminList(env)) {
    const form = new FormData();
    form.append("chat_id", id);
    form.append("caption", "💾 بکاپ ربات (از پنل وب)\nاز بخش «بکاپ و بازیابی» پنل قابل بازیابیه.");
    form.append("document", new Blob([data], { type: "application/json" }), name);
    const r = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: form })).json();
    if (r.ok) ok++; else last = r.description || "";
  }
  if (!ok) throw new Error(last || "ارسال نشد (ادمین‌ها اول به ربات /start بزنن)");
  await I.setSetting(env, "last_backup_at", String(Date.now()));
  return ok;
}
R("POST", "/api/backup/telegram", async ({ env, I }) => json({ ok: true, sent: await sendBackupToAdmins(env, I) }));

export async function runScheduled(env, I) {
  try {
    await env.DB.prepare("DELETE FROM state WHERE (key LIKE 'plogin:%' OR key LIKE 'rl:%') AND updated_at < ?").bind(Date.now() - 86400000).run();
    if ((await I.getSetting(env, "auto_backup", "0")) !== "1") return;
    const every = int(await I.getSetting(env, "backup_every_h", "24"), 24) * 3600000;
    const last = int(await I.getSetting(env, "last_backup_at", "0"), 0);
    if (Date.now() - last < every - 600000) return;
    await sendBackupToAdmins(env, I);
  } catch (e) {
    console.error("scheduled", e);
    await I.logEvent(env, "errors", `🔥 <b>خطای بکاپ خودکار</b>\n<code>${I.escapeHtml(String(e?.message || e)).slice(0, 400)}</code>`);
  }
}

// ---------- سیستم / وبهوک ----------
R("GET", "/api/system", async ({ env, I }) => {
  const [me, wh] = await Promise.all([I.rawCall(env, "getMe", {}).catch(() => null), I.rawCall(env, "getWebhookInfo", {}).catch(() => null)]);
  const expected = env.WEBHOOK_SECRET && ORIGIN ? `${ORIGIN}/webhook/${env.WEBHOOK_SECRET}` : null;
  const cur = wh?.result?.url || "";
  return json({
    ok: true, version: VERSION, runtime: env.RUNTIME === "node" ? "railway" : "cloudflare", origin: ORIGIN,
    bot: me?.ok ? { username: me.result.username, name: me.result.first_name } : null,
    webhook: wh?.ok ? { url_set: !!cur, matches: !!expected && cur === expected, pending: wh.result.pending_update_count, last_error: wh.result.last_error_message || null, last_error_at: (wh.result.last_error_date || 0) * 1000 } : null,
    env: {
      BOT_TOKEN: !!env.BOT_TOKEN, ADMIN_IDS: adminList(env).length, WEBHOOK_SECRET: !!env.WEBHOOK_SECRET, PANEL_PASSWORD: !!env.PANEL_PASSWORD,
      SESSION_SECRET: !!env.SESSION_SECRET, KV: !!env.KV, CF_API_TOKEN: !!env.CF_API_TOKEN, CF_ACCOUNT_ID: !!env.CF_ACCOUNT_ID,
      D1_DATABASE_ID: !!env.D1_DATABASE_ID, KV_NAMESPACE_ID: !!env.KV_NAMESPACE_ID, NO_BUTTON_STYLE: env.NO_BUTTON_STYLE === "1",
    },
  });
});
R("POST", "/api/system/webhook", async ({ env, body, I }) => {
  const b = await body();
  if (b.action === "delete") {
    const r = await I.rawCall(env, "deleteWebhook", { drop_pending_updates: !!b.drop });
    return r.ok ? json({ ok: true }) : err(r.description || "خطا");
  }
  if (!env.WEBHOOK_SECRET) return err("WEBHOOK_SECRET ست نشده");
  if (!ORIGIN.startsWith("https://")) return err("آدرس عمومی HTTPS مشخص نیست (PUBLIC_URL)");
  const r = await I.rawCall(env, "setWebhook", { url: `${ORIGIN}/webhook/${env.WEBHOOK_SECRET}`, allowed_updates: ["message", "callback_query", "chat_member"], drop_pending_updates: !!b.drop });
  return r.ok ? json({ ok: true }) : err(r.description || "خطا");
});
