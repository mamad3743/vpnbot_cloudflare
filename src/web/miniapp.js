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
      bot, percent: Number(percent) || 0, refLink: bot.username ? `https://t.me/${bot.username}?start=${uid}` : "",
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
