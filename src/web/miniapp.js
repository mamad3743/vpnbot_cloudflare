/**
 * مینی‌اپ تلگرام (مخصوص مشتری‌ها) — /app و /app/api/*
 * ------------------------------------------------------
 * - احراز هویت: initData امضاشده‌ی تلگرام (HMAC-SHA256 با توکن ربات) توی هدر Authorization: tma <initData>
 * - فقط خواندن (سرویس‌ها، مصرف زنده، لینک/QR، قیمت‌ها، کیف پول، زیرمجموعه). اقدام‌ها (خرید/تمدید/شارژ) با لینک عمیق
 *   t.me/<bot>?start=... به همون جریان‌های ربات وصل میشن؛ هیچ منطق پرداختی دوباره‌نویسی نشده.
 * - از پنل وب قابل خاموش/روشنه (cfg.miniapp.enabled).
 */
import MINIAPP_HTML from "./miniapp.generated.js";
import { qrPng } from "../qr.js";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const err = (m, s = 400, extra = {}) => json({ ok: false, error: m, ...extra }, s);
const safeJson = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export const MINIAPP_DEFAULTS = { enabled: false, accent: "violet", title: "", banner: "", sections: { shop: true, wallet: true, referral: true, support: true } };
export const MINIAPP_ACCENTS = ["violet", "ocean", "emerald", "sunset", "rose", "gold"];
export const miniappCfg = (ui) => {
  const m = (ui && ui.miniapp) || {};
  return {
    enabled: m.enabled === true,
    accent: MINIAPP_ACCENTS.includes(m.accent) ? m.accent : "violet",
    title: String(m.title || "").slice(0, 40),
    banner: String(m.banner || "").slice(0, 200),
    sections: { ...MINIAPP_DEFAULTS.sections, ...(m.sections || {}) },
  };
};

// ---------- احراز هویت initData ----------
async function hmacRaw(keyBytes, msgBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, msgBytes);
}
/** خروجی: {user, auth_date} یا null */
export async function verifyInitData(botToken, raw, maxAgeSec = 86400) {
  if (!raw || !botToken || raw.length > 4096) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dcs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmacRaw(enc.encode("WebAppData"), enc.encode(botToken));
  const sig = hex(await hmacRaw(secret, enc.encode(dcs)));
  let d = sig.length ^ hash.length;
  for (let i = 0; i < sig.length; i++) d |= sig.charCodeAt(i) ^ (hash.charCodeAt(i) || 0);
  if (d !== 0) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec || authDate - Date.now() / 1000 > 300) return null;
  const user = safeJson(params.get("user"), null);
  if (!user || !user.id) return null;
  return { user, auth_date: authDate };
}

const CSP = [
  "default-src 'self'",
  "script-src 'unsafe-inline' https://telegram.org",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self' https://*.telegram.org https://telegram.org", // تلگرام وب/دسکتاپ مینی‌اپ رو توی iframe باز می‌کنه؛ 'self' برای پیش‌نمایش داخل پنل
  "base-uri 'none'",
].join("; ");

let botInfoCache = null;
async function botInfo(env, I) {
  if (botInfoCache && botInfoCache.exp > Date.now()) return botInfoCache.v;
  const r = await I.rawCall(env, "getMe", {}).catch(() => null);
  const v = r?.ok ? { username: r.result.username, name: r.result.first_name } : { username: "", name: "" };
  botInfoCache = { v, exp: Date.now() + (v.username ? 3600000 : 30000) };
  return v;
}

const serviceTitle = (o, names) => names[`o:${o.id}`] || (o.panel_id && o.panel_username ? o.panel_username : `${o.pname || "سرویس"} #${o.id}`);

export async function handleMiniApp(request, env, ctx, I) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (request.method === "GET" && (p === "/app" || p === "/app/")) {
    return new Response(MINIAPP_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (!p.startsWith("/app/api/")) return err("not found", 404);

  const ui = await I.loadUiCfg(env);
  const cfg = miniappCfg(ui);
  if (!cfg.enabled) return err("مینی‌اپ غیرفعاله.", 403, { disabled: true });

  // ---- احراز هویت ----
  const auth = request.headers.get("authorization") || "";
  const init = auth.startsWith("tma ") ? auth.slice(4) : "";
  const v = await verifyInitData(env.BOT_TOKEN, init);
  if (!v) return err("احراز هویت ناموفق؛ مینی‌اپ رو از داخل تلگرام دوباره باز کن.", 401);
  const uid = v.user.id;
  const row = await I.getUser(env, uid);
  const admin = I.isAdmin(env, uid);
  const botOn = (await I.getSetting(env, "bot_enabled", "1")) !== "0";
  const maintenance = { on: !botOn && !admin, text: await I.getSetting(env, "bot_off_text", "") };
  if (!row || !row.registered) return json({ ok: true, registered: false, app: { title: cfg.title, accent: cfg.accent }, maintenance, bot: await botInfo(env, I) });
  if (row.is_banned && !admin) return err("دسترسی شما به ربات مسدود شده.", 403, { banned: true });

  // ---- bootstrap ----
  if (p === "/app/api/bootstrap") {
    const bot = await botInfo(env, I);
    const names = await I.loadSvcNames(env, uid);
    const [os, es] = await env.DB.batch([
      env.DB.prepare(
        `SELECT o.id, o.amount, o.panel_id, o.panel_username, o.decided_at, o.created_at, p.name pname, p.is_trial
         FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.user_id=? AND o.type='purchase' AND o.status='approved' ORDER BY o.id DESC LIMIT 40`
      ).bind(uid),
      env.DB.prepare("SELECT id, username, created_at FROM ext_services WHERE user_id=? ORDER BY id DESC LIMIT 20").bind(uid),
    ]);
    const services = [
      ...os.results.map((o) => ({ kind: "o", id: o.id, title: serviceTitle(o, names), product: o.pname || "", at: o.decided_at || o.created_at, live: !!o.panel_id, free: !o.amount, renewable: !!(o.panel_id && !o.is_trial) })),
      ...es.results.map((e) => ({ kind: "e", id: e.id, title: names[`e:${e.id}`] || e.username, product: "اشتراک قبلی", at: e.created_at, live: true, free: false, renewable: true })),
    ];
    const percent = await I.getSetting(env, "referral_percent", "10");
    return json({
      ok: true, registered: true, maintenance,
      user: { id: uid, name: row.first_name || v.user.first_name || "", username: row.username || v.user.username || "", wallet: row.wallet_balance || 0, referrals: row.referral_count || 0, admin },
      app: { title: cfg.title || (await I.getSetting(env, "bot_display_name", "")) || bot.name, accent: cfg.accent, banner: cfg.banner, sections: cfg.sections },
      bot, percent: Number(percent) || 0, payment: { card_number: await I.getSetting(env, "card_number", ""), card_holder: await I.getSetting(env, "card_holder", "") }, refLink: bot.username ? `https://t.me/${bot.username}?start=${uid}` : "",
      services, transferEnabled: ui.transfer_enabled !== false,
      texts: cfg.sections.support ? { support: await I.getSetting(env, "support_text", ""), tutorial: await I.getSetting(env, "tutorial_text", "") } : {},
    });
  }

  // ---- جزئیات سرویس (+ مصرف زنده) ----
  if (p === "/app/api/service" || p === "/app/api/service/qr") {
    const kind = url.searchParams.get("kind") === "e" ? "e" : "o";
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return err("شناسه نامعتبره.");
    let usage = null, usageErr = false, link = null, title = "", product = "", renewable = false, transferable = false, free = false;
    const names = await I.loadSvcNames(env, uid);
    if (kind === "o") {
      const o = await env.DB.prepare(
        `SELECT o.*, p.name pname, p.is_trial FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.user_id=? AND o.type='purchase' AND o.status='approved'`
      ).bind(id, uid).first();
      if (!o) return err("این سرویس پیدا نشد.", 404);
      title = serviceTitle({ ...o }, names); product = o.pname || ""; link = o.config_text || null; free = !o.amount;
      renewable = !!(o.panel_id && !o.is_trial); transferable = !!o.amount;
      if (o.panel_id && p === "/app/api/service") {
        try {
          const panel = await I.getPanel(env, o.panel_id);
          if (!panel) throw new Error("no panel");
          usage = await I.panelUsage(panel, { username: o.panel_username, extra: safeJson(o.panel_extra, {}) });
        } catch {
          usageErr = true;
        }
      }
    } else {
      const ext = await I.loadExtForUser(env, ui, uid, id);
      if (!ext) return err("این اشتراک پیدا نشد.", 404);
      title = names[`e:${id}`] || ext.username; product = "اشتراک قبلی"; renewable = true; transferable = true;
      try {
        const panel = await I.getPanel(env, ext.panel_id);
        if (!panel) throw new Error("no panel");
        const found = await I.panelFindUser(panel, ext.username);
        if (!found) throw new Error("not found");
        usage = found; link = found.subUrl || null;
      } catch {
        usageErr = true;
      }
    }
    if (p === "/app/api/service/qr") {
      if (!link || ui.qr_enabled === false) return err("QR در دسترس نیست.", 404);
      return new Response(qrPng(link), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=300" } });
    }
    return json({
      ok: true, kind, id, title, product, free, renewable, transferable: transferable && ui.transfer_enabled !== false,
      usage: usage ? { total: usage.total || 0, used: usage.used || 0, expire: usage.expire || 0, status: usage.status || "active" } : null, usageErr,
      link, isSub: /^https?:\/\//i.test(link || ""), qr: !!link && ui.qr_enabled !== false,
    });
  }

  // ---- فروشگاه ----
  if (p === "/app/api/plans") {
    if (!cfg.sections.shop) return err("این بخش غیرفعاله.", 403);
    const products = await I.listProducts(env);
    const cats = await I.listCategories(env, { onlyEnabled: false });
    const known = new Set(cats.map((c) => c.id)), enabled = new Set(cats.filter((c) => c.enabled).map((c) => c.id));
    const catOf = (x) => (x.category_id && known.has(x.category_id) ? x.category_id : 0);
    const visible = products.filter((x) => catOf(x) === 0 || enabled.has(catOf(x)));
    const stock = Object.fromEntries(((await env.DB.prepare("SELECT product_id, COUNT(*) n FROM configs WHERE is_used=0 GROUP BY product_id").all()).results || []).map((r) => [r.product_id, r.n]));
    const best = await env.DB.prepare("SELECT product_id FROM orders WHERE type='purchase' AND status='approved' AND amount>0 GROUP BY product_id ORDER BY COUNT(*) DESC LIMIT 1").first();
    const items = visible.map((x) => {
      const custom = safeJson(x.custom, null);
      return {
        id: x.id, name: x.name, price: x.price, days: x.duration_days, gb: x.data_limit_gb || 0, cat: catOf(x), desc: x.description || "",
        panel: !!x.panel_id, custom: custom ? { min_gb: custom.min_gb, max_gb: custom.max_gb, min_days: custom.min_days, max_days: custom.max_days, price_per_gb: custom.price_per_gb, price_per_day: custom.price_per_day || 0 } : null,
        soldOut: !x.panel_id && !custom && !(stock[x.id] > 0),
      };
    });
    return json({
      ok: true, best: best?.product_id || null, items,
      categories: cats.filter((c) => c.enabled && visible.some((x) => catOf(x) === c.id)).map((c) => ({ id: c.id, name: c.name, count: visible.filter((x) => catOf(x) === c.id).length })),
      hasOthers: visible.some((x) => catOf(x) === 0) && cats.some((c) => c.enabled),
    });
  }

  // ---- اعتبارسنجی کد تخفیف ----
  if (p === "/app/api/coupon-check" && request.method === "POST") {
    if (ui.features?.coupons === false) return err("کد تخفیف فعلاً غیرفعاله.",403);
    if (!cfg.sections.shop) return err("فروشگاه غیرفعاله.",403);
    let body; try { body = await request.json(); } catch { return err("درخواست نامعتبره."); }
    const code = String(body.code || "").trim().toUpperCase().replace(/\s+/g, "");
    const productId = Number(body.product_id);
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();
    if (!product) return err("محصول در دسترس نیست.",404);
    let subtotal = Number(product.price || 0); const custom = safeJson(product.custom,null);
    if (custom) {
      const gb=Number(body.gb), days=Number(body.days);
      if (!product.panel_id || !Number.isFinite(gb) || !Number.isFinite(days) || gb<custom.min_gb || gb>custom.max_gb || days<custom.min_days || days>custom.max_days) return err("حجم یا مدت معتبر نیست.");
      subtotal=Math.round(gb*Number(custom.price_per_gb||0)+days*Number(custom.price_per_day||0));
    }
    if (!code) return json({ok:true,subtotal,discount:0,amount:subtotal,code:""});
    const c=await env.DB.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND enabled=1").bind(code).first();
    const now=Date.now();
    if(!c) return err("کد تخفیف معتبر نیست.");
    if(c.starts_at && now<Number(c.starts_at)) return err("زمان استفاده از این کد هنوز شروع نشده.");
    if(c.expires_at && now>Number(c.expires_at)) return err("اعتبار این کد به پایان رسیده.");
    if(Number(c.max_uses)>0 && Number(c.used_count)>=Number(c.max_uses)) return err("ظرفیت استفاده از این کد تمام شده.");
    const discount=Math.min(subtotal, c.discount_type==="fixed"?Number(c.discount_value):Math.floor(subtotal*Number(c.discount_value)/100));
    const amount=Math.max(0,subtotal-discount);
    return json({ok:true,code:c.code,subtotal,discount,amount});
  }

  // ---- ثبت سفارش خرید با کارت‌به‌کارت ----
  if (p === "/app/api/purchase-card" && request.method === "POST") {
    if (ui.features?.coupons === false && String((await request.clone().json().catch(()=>({}))).coupon_code||"").trim()) return err("کد تخفیف فعلاً غیرفعاله.",403);
    if (!cfg.sections.shop) return err("فروشگاه غیرفعاله.",403);
    let body;try{body=await request.json()}catch{return err("درخواست نامعتبره.")}
    const productId=Number(body.product_id);const product=await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();
    if(!product)return err("این محصول دیگر در دسترس نیست.",404);
    let gb=null,days=null,amount=Number(product.price||0);const custom=safeJson(product.custom,null);
    if(custom){gb=Number(body.gb);days=Number(body.days);if(!product.panel_id||!Number.isFinite(gb)||!Number.isFinite(days)||gb<custom.min_gb||gb>custom.max_gb||days<custom.min_days||days>custom.max_days)return err("حجم یا مدت خارج از محدوده مجازه.");amount=Math.round(gb*Number(custom.price_per_gb||0)+days*Number(custom.price_per_day||0));}
    if(!Number.isSafeInteger(amount)||amount<=0)return err("قیمت محصول معتبر نیست.");
    const couponCode=String(body.coupon_code||"").trim().toUpperCase().replace(/\s+/g,"");
    if(couponCode){const c=await env.DB.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND enabled=1").bind(couponCode).first();const now=Date.now();if(!c||(c.starts_at&&now<Number(c.starts_at))||(c.expires_at&&now>Number(c.expires_at))||(Number(c.max_uses)>0&&Number(c.used_count)>=Number(c.max_uses)))return err("کد تخفیف معتبر نیست یا ظرفیت آن تمام شده.");amount=Math.max(0,amount-(c.discount_type==="fixed"?Number(c.discount_value):Math.floor(amount*Number(c.discount_value)/100)));if(amount<=0)return err("مبلغ نهایی سفارش باید بیشتر از صفر باشد.");}
    const card=await I.getSetting(env,"card_number","");if(!card||card==="تنظیم نشده")return err("شماره کارت هنوز تنظیم نشده.",409);
    if(!product.panel_id){const stock=await env.DB.prepare("SELECT COUNT(*) n FROM configs WHERE product_id=? AND is_used=0").bind(productId).first();if(!(Number(stock?.n)>0))return err("موجودی این محصول تمام شده.",409);}
    const username=product.panel_id?`t${String(uid).slice(-8)}${Date.now().toString(36).slice(-6)}`.slice(0,20):null;
    const ins=await env.DB.prepare("INSERT INTO orders(user_id,product_id,type,amount,status,gb,days,panel_username,created_at) VALUES(?,?,'purchase',?,'awaiting_receipt',?,?,?,?)").bind(uid,productId,amount,gb,days,username,Date.now()).run();
    if(couponCode) await env.DB.prepare("UPDATE coupons SET used_count=used_count+1 WHERE code=? COLLATE NOCASE AND enabled=1 AND (max_uses=0 OR used_count<max_uses)").bind(couponCode).run();
    return json({ok:true,order_id:ins.meta.last_row_id,amount,card_number:card,card_holder:await I.getSetting(env,"card_holder","")});
  }

  // ---- ثبت خرید مستقیم داخل مینی‌اپ (پرداخت از کیف پول) ----
  if (p === "/app/api/purchase" && request.method === "POST") {
    if (ui.features?.coupons === false && String((await request.clone().json().catch(()=>({}))).coupon_code||"").trim()) return err("کد تخفیف فعلاً غیرفعاله.",403);
    if (!cfg.sections.shop) return err("فروشگاه غیرفعاله.", 403);
    let body;
    try { body = await request.json(); } catch { return err("درخواست نامعتبره."); }
    const productId = Number(body.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) return err("محصول نامعتبره.");
    let couponCode=String(body.coupon_code||"").trim().toUpperCase().replace(/\s+/g,"");
    let discountedAmount=null;
    if(couponCode){const product=await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();if(!product)return err("محصول دیگر در دسترس نیست.",404);let subtotal=Number(product.price||0);const custom=safeJson(product.custom,null);if(custom){const gb=Number(body.gb),days=Number(body.days);if(!product.panel_id||!Number.isFinite(gb)||!Number.isFinite(days)||gb<custom.min_gb||gb>custom.max_gb||days<custom.min_days||days>custom.max_days)return err("حجم یا مدت معتبر نیست.");subtotal=Math.round(gb*Number(custom.price_per_gb||0)+days*Number(custom.price_per_day||0));}const c=await env.DB.prepare("SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND enabled=1").bind(couponCode).first();const now=Date.now();if(!c||(c.starts_at&&now<Number(c.starts_at))||(c.expires_at&&now>Number(c.expires_at))||(Number(c.max_uses)>0&&Number(c.used_count)>=Number(c.max_uses)))return err("کد تخفیف معتبر نیست یا ظرفیت آن تمام شده.");const discount=Math.min(subtotal,c.discount_type==="fixed"?Number(c.discount_value):Math.floor(subtotal*Number(c.discount_value)/100));discountedAmount=subtotal-discount;if(discountedAmount<=0)return err("مبلغ نهایی سفارش باید بیشتر از صفر باشد.");}
    const result = await I.purchaseMiniApp(env, uid, productId, body.gb ?? null, body.days ?? null, discountedAmount);
    if(result.ok && couponCode) await env.DB.prepare("UPDATE coupons SET used_count=used_count+1 WHERE code=? COLLATE NOCASE AND enabled=1 AND (max_uses=0 OR used_count<max_uses)").bind(couponCode).run();
    if (!result.ok) return err(result.error || "خرید انجام نشد.", result.insufficient ? 409 : 400, { insufficient: !!result.insufficient, refunded: !!result.refunded });
    const user = await I.getUser(env, uid);
    return json({ ok: true, order_id: result.order_id, amount: result.amount, wallet: user?.wallet_balance || 0 });
  }

  // ---- شارژ کیف پول با کارت‌به‌کارت ----
  if (p === "/app/api/topup" && request.method === "POST") {
    if (!cfg.sections.wallet) return err("کیف پول غیرفعاله.", 403);
    let body; try { body = await request.json(); } catch { return err("درخواست نامعتبره."); }
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount < 10000 || amount > 50000000) return err("مبلغ شارژ باید بین ۱۰ هزار تا ۵۰ میلیون تومان باشه.");
    const card = await I.getSetting(env, "card_number", "");
    if (!card || card === "تنظیم نشده") return err("شماره کارت هنوز توسط مدیر تنظیم نشده.", 409);
    const ins = await env.DB.prepare("INSERT INTO orders(user_id,product_id,type,amount,status,created_at) VALUES(?,NULL,'topup',?,'awaiting_receipt',?)").bind(uid, amount, Date.now()).run();
    return json({ok:true,order_id:ins.meta.last_row_id,amount,card_number:card,card_holder:await I.getSetting(env,"card_holder","")});
  }

  // ---- ارسال رسید از داخل مینی‌اپ ----
  if (p === "/app/api/receipt" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const orderId = Number(form?.get("order_id")); const file = form?.get("receipt");
    if (!Number.isSafeInteger(orderId) || !file || typeof file.arrayBuffer !== "function") return err("فایل رسید یا شماره سفارش معتبر نیست.");
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type || "") || file.size > 8*1024*1024) return err("رسید باید تصویر JPG، PNG یا WEBP و حداکثر ۸ مگابایت باشه.");
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND status='awaiting_receipt'").bind(orderId,uid).first();
    if (!order) return err("این سفارش در انتظار رسید نیست یا قبلاً ارسال شده.",404);
    const token = env.BOT_TOKEN; if (!token) return err("اتصال تلگرام تنظیم نشده.",503);
    const fd = new FormData(); fd.set("chat_id",String(uid)); fd.set("photo",file,file.name||"receipt.jpg"); fd.set("caption",`رسید سفارش #${orderId} دریافت شد؛ در انتظار بررسی مدیر.`);
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`,{method:"POST",body:fd});
    const tgJson = await tgRes.json().catch(()=>null);
    if (!tgJson?.ok) return err("ارسال رسید به تلگرام ناموفق بود؛ دوباره تلاش کن.",502);
    const photos=tgJson.result?.photo||[]; const fileId=photos[photos.length-1]?.file_id;
    if(!fileId)return err("تلگرام شناسه رسید را برنگرداند.",502);
    const changed=await env.DB.prepare("UPDATE orders SET status='pending',receipt_file_id=? WHERE id=? AND user_id=? AND status='awaiting_receipt'").bind(fileId,orderId,uid).run();
    if(!(changed.meta?.changes>0))return err("وضعیت سفارش تغییر کرده؛ صفحه را تازه کن.",409);
    const buyer=await I.getUser(env,uid); const product=order.product_id?await env.DB.prepare("SELECT name FROM products WHERE id=?").bind(order.product_id).first():null;
    const title=order.type==="topup"?"شارژ کیف پول":order.type==="renew"?"تمدید سرویس":"خرید اشتراک";
    const caption=`🧾 رسید جدید — ${title}\nکاربر: ${buyer?.username?"@"+buyer.username:buyer?.first_name||uid} (${uid})\n${product?"محصول: "+product.name+"\\n":""}مبلغ: ${Number(order.amount).toLocaleString("en-US")} تومان\nشماره سفارش: #${orderId}`;
    const kb={inline_keyboard:[[{text:"✅ تایید",callback_data:`adm:ord_ok:${orderId}`},{text:"❌ رد",callback_data:`adm:ord_no:${orderId}`}]]};
    for(const adminId of (env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean)) await I.rawCall(env,"sendPhoto",{chat_id:adminId,photo:fileId,caption,reply_markup:kb}).catch(()=>{});
    await I.logEvent(env,"receipt",`🧾 <b>رسید جدید از مینی‌اپ</b> (سفارش #${orderId})\n👤 ${await I.logUserTag(env,uid)}\n💵 ${I.fmtMoney(order.amount)}`,{photo:fileId}).catch(()=>{});
    return json({ok:true,order_id:orderId,status:"pending"});
  }

  // ---- فهرست پلن‌های قابل تمدید برای سرویس متعلق به کاربر ----
  if (p === "/app/api/renew-options") {
    const kind=url.searchParams.get("kind")==="e"?"e":"o", id=Number(url.searchParams.get("id"));
    if(!Number.isSafeInteger(id)||id<=0)return err("سرویس نامعتبره.");
    let panelId=null,username="",base=null;
    if(kind==="o") { base=await env.DB.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND type='purchase' AND status='approved'").bind(id,uid).first(); panelId=base?.panel_id; username=base?.panel_username||""; }
    else { base=await I.loadExtForUser(env,ui,uid,id); panelId=base?.panel_id; username=base?.username||""; }
    if(!base||!panelId)return err("این سرویس قابلیت تمدید خودکار نداره.",404);
    const products=await env.DB.prepare("SELECT id,name,price,duration_days,data_limit_gb,custom FROM products WHERE enabled=1 AND is_trial=0 AND panel_id=? ORDER BY price ASC").bind(panelId).all();
    const items=(products.results||[]).map(x=>{const c=safeJson(x.custom,null);return c?{id:x.id,name:x.name,custom:true,min_gb:c.min_gb,max_gb:c.max_gb,min_days:c.min_days,max_days:c.max_days,price_per_gb:c.price_per_gb,price_per_day:c.price_per_day||0}:{id:x.id,name:x.name,price:x.price,days:x.duration_days,gb:x.data_limit_gb||0}});
    return json({ok:true,kind,id,username,items});
  }

  // ---- تمدید مستقیم از داخل مینی‌اپ ----
  if (p === "/app/api/renew" && request.method === "POST") {
    let body;try{body=await request.json()}catch{return err("درخواست نامعتبره.")}
    const kind=body.kind==="e"?"e":"o", serviceId=Number(body.service_id), productId=Number(body.product_id), method=body.method==="card"?"card":"wallet";
    if(!Number.isSafeInteger(serviceId)||!Number.isSafeInteger(productId))return err("شناسه نامعتبره.");
    let base=null,panelId=null,extId=null;
    if(kind==="o"){base=await env.DB.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND type='purchase' AND status='approved'").bind(serviceId,uid).first();panelId=base?.panel_id;}
    else{base=await I.loadExtForUser(env,ui,uid,serviceId);panelId=base?.panel_id;extId=serviceId;}
    const product=panelId?await env.DB.prepare("SELECT * FROM products WHERE id=? AND panel_id=? AND enabled=1 AND is_trial=0").bind(productId,panelId).first():null;
    if(!base||!product)return err("پلن تمدید معتبر نیست.",404);
    const custom=safeJson(product.custom,null);let gb=Number(product.data_limit_gb||0),days=Number(product.duration_days||0),amount=Number(product.price);
    if(custom){gb=Number(body.gb);days=Number(body.days);if(!Number.isFinite(gb)||!Number.isFinite(days)||gb<custom.min_gb||gb>custom.max_gb||days<custom.min_days||days>custom.max_days)return err("حجم یا مدت خارج از محدوده مجازه.");amount=Math.round(gb*Number(custom.price_per_gb||0)+days*Number(custom.price_per_day||0));}
    if(!Number.isSafeInteger(amount)||amount<=0)return err("قیمت نامعتبره.");
    if(method==="card"){
      const card=await I.getSetting(env,"card_number","");if(!card||card==="تنظیم نشده")return err("شماره کارت تنظیم نشده.",409);
      const ins=await env.DB.prepare("INSERT INTO orders(user_id,product_id,type,amount,status,renew_of,gb,days,ext_id,created_at) VALUES(?,?,'renew',?,'awaiting_receipt',?,?,?,?,?)").bind(uid,productId,amount,kind==="o"?serviceId:null,gb,days,extId,Date.now()).run();
      return json({ok:true,method:"card",order_id:ins.meta.last_row_id,amount,card_number:card,card_holder:await I.getSetting(env,"card_holder","")});
    }
    const debit=await env.DB.prepare("UPDATE users SET wallet_balance=wallet_balance-? WHERE id=? AND wallet_balance>=?").bind(amount,uid,amount).run();
    if(!(debit.meta?.changes>0))return err("موجودی کیف پول کافی نیست.",409,{insufficient:true});
    let orderId=null;
    try{
      const ins=await env.DB.prepare("INSERT INTO orders(user_id,product_id,type,amount,status,renew_of,gb,days,ext_id,created_at) VALUES(?,?,'renew',?,'pending',?,?,?,?,?)").bind(uid,productId,amount,kind==="o"?serviceId:null,gb,days,extId,Date.now()).run();orderId=ins.meta.last_row_id;
      const order=await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();const result=await I.fulfillOrder(env,order);
      if(!result.ok){await env.DB.prepare("UPDATE users SET wallet_balance=wallet_balance+? WHERE id=?").bind(amount,uid).run();await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(orderId).run();return err("تمدید انجام نشد؛ مبلغ به کیف پول برگشت.",409,{refunded:true});}
      const user=await I.getUser(env,uid);return json({ok:true,method:"wallet",order_id:orderId,wallet:user?.wallet_balance||0});
    }catch(e){await env.DB.prepare("UPDATE users SET wallet_balance=wallet_balance+? WHERE id=?").bind(amount,uid).run().catch(()=>{});if(orderId)await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(orderId).run().catch(()=>{});return err("خطا در تمدید؛ مبلغ به کیف پول برگشت.",500,{refunded:true});}
  }

  // ---- انتقال سرویس داخل مینی‌اپ ----
  if(p==="/app/api/transfer"&&request.method==="POST"){
    if(ui.transfer_enabled===false)return err("انتقال سرویس غیرفعاله.",403);
    let body;try{body=await request.json()}catch{return err("درخواست نامعتبره.")}
    const kind=body.kind==="e"?"e":"o",id=Number(body.id),target=String(body.target||"").trim();if(!Number.isSafeInteger(id)||id<=0||!target)return err("اطلاعات انتقال کامل نیست.");
    const found=await I.findTransferTarget(env,target,uid);if(found.error)return err(found.error);
    const result=await I.performTransfer(env,ui,uid,kind,id,found.user.id);if(!result.ok)return err(result.error||"انتقال انجام نشد.",409);return json({ok:true,label:result.label,to:result.toTag,notified:result.notified});
  }

  // ---- تیکت‌های پشتیبانی کاربر ----
  if ((p === "/app/api/tickets" || /^\/app\/api\/tickets\//.test(p)) && ui.features?.tickets === false) return err("پشتیبانی تیکتی فعلاً غیرفعاله.",403);
  if (p === "/app/api/tickets" && request.method === "GET") {
    const rows=await env.DB.prepare("SELECT t.id,t.subject,t.status,t.created_at,t.updated_at,(SELECT message FROM ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) last_message FROM tickets t WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 30").bind(uid).all();
    return json({ok:true,items:rows.results||[]});
  }
  if (p === "/app/api/tickets" && request.method === "POST") {
    let body;try{body=await request.json()}catch{return err("درخواست نامعتبره.")}
    const subject=String(body.subject||"").trim().slice(0,120),message=String(body.message||"").trim().slice(0,3500);
    if(!subject||!message)return err("موضوع و متن پیام رو وارد کن.");
    const now=Date.now();const ins=await env.DB.prepare("INSERT INTO tickets(user_id,subject,status,priority,created_at,updated_at) VALUES(?,?,'open','normal',?,?)").bind(uid,subject,now,now).run();const id=ins.meta.last_row_id;
    await env.DB.prepare("INSERT INTO ticket_messages(ticket_id,sender_id,sender_type,message,created_at) VALUES(?,?,'user',?,?)").bind(id,uid,message,now).run();
    for(const adminId of (env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean))await I.sendMessage(env,adminId,`🎫 تیکت جدید #${id}\nکاربر: ${uid}\nموضوع: ${subject}\n\n${message}`).catch(()=>{});
    return json({ok:true,id});
  }
  if (/^\/app\/api\/tickets\/\d+$/.test(p) && request.method === "GET") {
    const id=Number(p.split("/").pop());const ticket=await env.DB.prepare("SELECT id,subject,status,created_at,updated_at FROM tickets WHERE id=? AND user_id=?").bind(id,uid).first();if(!ticket)return err("تیکت پیدا نشد.",404);
    const messages=await env.DB.prepare("SELECT sender_type,message,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id ASC LIMIT 200").bind(id).all();return json({ok:true,ticket,messages:messages.results||[]});
  }

  const ticketReplyMatch=p.match(/^\/app\/api\/tickets\/(\d+)\/reply$/);
  if(ticketReplyMatch&&request.method==="POST"){
    const id=Number(ticketReplyMatch[1]);let body;try{body=await request.json()}catch{return err("درخواست نامعتبره.")};const message=String(body.message||"").trim().slice(0,3500);if(!message)return err("متن پیام خالیه.");
    const ticket=await env.DB.prepare("SELECT id,status FROM tickets WHERE id=? AND user_id=?").bind(id,uid).first();if(!ticket)return err("تیکت پیدا نشد.",404);if(ticket.status==="closed")return err("این تیکت بسته شده.",409);
    const now=Date.now();await env.DB.batch([env.DB.prepare("INSERT INTO ticket_messages(ticket_id,sender_id,sender_type,message,created_at) VALUES(?,?,'user',?,?)").bind(id,uid,message,now),env.DB.prepare("UPDATE tickets SET status='open',updated_at=? WHERE id=?").bind(now,id)]);
    for(const adminId of (env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean))await I.sendMessage(env,adminId,`✉️ پیام جدید تیکت #${id}\nکاربر: ${uid}\n\n${message}`).catch(()=>{});
    return json({ok:true});
  }

  // ---- کیف پول ----
  if (p === "/app/api/wallet") {
    if (!cfg.sections.wallet) return err("این بخش غیرفعاله.", 403);
    const { results } = await env.DB.prepare(
      `SELECT o.id, o.type, o.amount, o.status, o.created_at, o.decided_at, p.name pname FROM orders o LEFT JOIN products p ON p.id=o.product_id
       WHERE o.user_id=? AND o.status IN ('approved','pending','awaiting_receipt','rejected') AND (o.amount>0) ORDER BY o.id DESC LIMIT 40`
    ).bind(uid).all();
    return json({ ok: true, balance: row.wallet_balance || 0, items: results.map((o) => ({ id: o.id, type: o.type, amount: o.amount, status: o.status, at: o.decided_at || o.created_at, name: o.pname || "" })) });
  }

  return err("not found", 404);
}
