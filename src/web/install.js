/**
 * نصب‌کننده‌ی تحت وب (/install) — هم روی Cloudflare Workers هم Railway
 * ----------------------------------------------------------------------
 * مراحل: کد نصب ← توکن ربات ← ادمین (تشخیص خودکار یا دستی) ← رمز پنل ← تایید و ست‌کردن وبهوک
 *
 * - تنظیمات داخل دیتابیس (کلید install_cfg در جدول settings) ذخیره میشن؛ چون Worker نمی‌تونه secret بنویسه.
 *   متغیرهای محیطی (اگه ست باشن) همیشه اولویت دارن؛ پس دیپلوی‌های قبلی بدون تغییر کار می‌کنن.
 * - این کلیدها (install_*) از بکاپ‌ها و کش KV بیرون نگه داشته میشن تا توکن توی فایل بکاپ نیفته.
 * - امنیت: بدون «کد نصب» هیچ مرحله‌ای کار نمیکنه (وگرنه هر کسی که زودتر به /install برسه ربات خودش رو نصب می‌کنه).
 */
import INSTALL_HTML from "./install.generated.js";
import SCHEMA from "./schema.generated.js";

const enc = new TextEncoder();
const CFG_KEY = "install_cfg";
const PENDING_KEY = "install_pending";
const TG = (t) => `https://api.telegram.org/bot${t}`;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const err = (m, s = 400) => json({ ok: false, error: m }, s);
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const randHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
const randCode = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const safeJson = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
export const adminList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// ---------- رمز پنل: هش نمکی (HMAC-SHA256) ----------
async function hmacHex(keyStr, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
export async function hashPassword(pw) {
  const salt = randHex(12);
  return `${salt}:${await hmacHex(salt, pw)}`;
}
export async function verifyPassword(pw, stored) {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  const x = await hmacHex(salt, String(pw));
  let d = x.length ^ h.length;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ (h.charCodeAt(i) || 0);
  return d === 0;
}

// ---------- پیکربندی ذخیره‌شده ----------
let cfgCache = null;
export function invalidateInstallCfg() {
  cfgCache = null;
}
export async function getInstallCfg(env, fresh = false) {
  if (!fresh && cfgCache && cfgCache.exp > Date.now()) return cfgCache.v;
  let v = {};
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(CFG_KEY).first();
    v = safeJson(r?.value, {}) || {};
  } catch {
    v = {}; // دیتابیس هنوز ساخته نشده
  }
  cfgCache = { v, exp: Date.now() + 15000 };
  return v;
}
export async function saveInstallCfg(env, cfg) {
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(CFG_KEY, JSON.stringify(cfg)).run();
  invalidateInstallCfg();
}

export const isInstalled = (env) => !!(env.BOT_TOKEN && adminList(env.ADMIN_IDS).length && env.WEBHOOK_SECRET);

/** متغیرهای محیطی + مقادیر ذخیره‌شده توسط نصب‌کننده (محیط همیشه برنده‌ست) */
export async function resolveEnv(env) {
  if (env.BOT_TOKEN && env.ADMIN_IDS && env.WEBHOOK_SECRET && env.PANEL_PASSWORD) return env; // کاملا از محیط → بدون هیچ کوئری اضافه
  if (!env.DB) return env;
  const cfg = await getInstallCfg(env);
  const fill = {};
  const from = [];
  for (const k of ["BOT_TOKEN", "ADMIN_IDS", "WEBHOOK_SECRET", "SESSION_SECRET"]) {
    if (!env[k] && cfg[k]) {
      fill[k] = cfg[k];
      from.push(k);
    }
  }
  if (!env.PANEL_PASSWORD && cfg.PANEL_PASSWORD_HASH) {
    fill.PANEL_PASSWORD_HASH = cfg.PANEL_PASSWORD_HASH;
    from.push("PANEL_PASSWORD_HASH");
  }
  if (!from.length) return env;
  if (env.RUNTIME === "node") {
    // سرور Node یک env ثابت داره؛ لیست «از دیتابیس اومده‌ها» رو جمع می‌کنیم (بازنویسی نمی‌کنیم)
    fill.__fromDb = [...new Set([...(env.__fromDb || []), ...from])];
    return Object.assign(env, fill);
  }
  return { ...env, ...fill, __fromDb: from };
}

// ---------- ساخت جدول‌ها (روی D1 تازه) ----------
let schemaOk = false;
export async function ensureSchema(env) {
  if (schemaOk) return;
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").first().catch(() => null);
  if (!row) await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaOk = true;
}

// ---------- کد نصب ----------
const installCode = (env) => {
  const c = String(env.INSTALL_CODE || "").trim();
  return c.length >= 6 && c !== "change-me" ? c : null;
};
async function codeToken(code, exp) {
  return `${exp}.${await hmacHex(code, `install|${exp}`)}`;
}
async function isUnlocked(request, env) {
  const code = installCode(env);
  if (!code) return false;
  const m = (request.headers.get("cookie") || "").match(/(?:^|; )vp_i=([^;]+)/);
  if (!m) return false;
  const [exp] = m[1].split(".");
  return Number(exp) > Date.now() && m[1] === (await codeToken(code, exp));
}
const clientIp = (r) => (r.headers.get("cf-connecting-ip") || r.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
async function rlBlocked(env, ip) {
  const r = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(`rl:inst:${ip}`).first();
  const v = safeJson(r?.value, { n: 0, t: 0 });
  return v.t > Date.now() - 600000 && v.n >= 8;
}
async function rlFail(env, ip) {
  const r = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(`rl:inst:${ip}`).first();
  let v = safeJson(r?.value, { n: 0, t: 0 });
  if (v.t < Date.now() - 600000) v = { n: 0, t: Date.now() };
  v.n++;
  await env.DB.prepare("INSERT INTO state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(`rl:inst:${ip}`, JSON.stringify(v), Date.now()).run();
}

// ---------- وضعیت در حال نصب ----------
const getPending = async (env) => safeJson((await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(PENDING_KEY).first())?.value, null);
const setPending = (env, p) =>
  env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(PENDING_KEY, JSON.stringify(p)).run();
const delPending = (env) => env.DB.prepare("DELETE FROM settings WHERE key=?").bind(PENDING_KEY).run();

async function tg(token, method, payload) {
  const r = await fetch(`${TG(token)}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
  return r.json().catch(() => ({ ok: false, description: "پاسخ نامعتبر از تلگرام" }));
}

const hookUrl = (origin, pend) => (origin.startsWith("https://") ? `${origin}/webhook/${pend.secret}` : "");

const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** وبهوک موقت: فقط پیام «/start <کد>» رو برای تشخیص آیدی ادمین می‌پذیره (قبل از پایان نصب) */
export async function handleInstallWebhook(request, env, url) {
  if (!env.DB || isInstalled(env) || !url.pathname.startsWith("/webhook/")) return null;
  const pend = await getPending(env).catch(() => null);
  if (!pend || url.pathname !== `/webhook/${pend.secret}`) return null;
  let upd;
  try {
    upd = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const m = upd.message;
  if (m && m.chat?.type === "private" && String(m.text || "").includes(pend.claim_code)) {
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "";
    pend.claimed = { id: m.from.id, name };
    await setPending(env, pend);
    await tg(pend.token, "sendMessage", { chat_id: m.chat.id, text: `✅ شناسایی شدی: ${name} (${m.from.id})\nبرگرد به صفحه‌ی نصب و ادامه بده.` });
  }
  return new Response("ok");
}

/** مسیرهای /install و /install/api/* */
export async function handleInstall(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!env.DB) {
    return new Response("<meta charset=utf-8><body dir=rtl style='font-family:Tahoma;padding:30px'>⚠️ اتصال دیتابیس (D1 با نام <b>DB</b>) در wrangler.toml تنظیم نشده.", { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  await ensureSchema(env);

  if (isInstalled(env)) {
    if (p === "/install") return Response.redirect(`${url.origin}/panel`, 302);
    return err("ربات قبلا نصب شده.", 404);
  }

  if (request.method === "GET" && p === "/install") {
    return new Response(INSTALL_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (!p.startsWith("/install/api/")) return err("not found", 404);

  if (request.method !== "GET") {
    if (request.headers.get("x-panel") !== "1") return err("bad request", 403);
    const o = request.headers.get("origin");
    if (o && o !== url.origin) return err("bad origin", 403);
  }
  const body = async () => (await request.json().catch(() => ({}))) || {};
  const code = installCode(env);
  const unlocked = await isUnlocked(request, env);
  const https = url.origin.startsWith("https://");

  if (request.method === "GET" && p === "/install/api/state") {
    const pend = unlocked ? await getPending(env) : null;
    return json({
      ok: true, runtime: env.RUNTIME === "node" ? "railway" : "cloudflare", origin: url.origin, https,
      codeMissing: !code, codeInLog: !!env.INSTALL_CODE_AUTO, unlocked,
      pending: pend ? { bot: pend.bot, claim_code: pend.claim_code, claimed: pend.claimed || null, webhook_url: hookUrl(url.origin, pend) } : null,
    });
  }

  if (request.method === "POST" && p === "/install/api/unlock") {
    if (!code) return err("کد نصب روی سرور تنظیم نشده.", 403);
    const ip = clientIp(request);
    if (await rlBlocked(env, ip)) return err("تلاش زیاد. ۱۰ دقیقه بعد دوباره امتحان کن.", 429);
    const b = await body();
    const given = String(b.code || "").trim();
    let diff = given.length ^ code.length;
    for (let i = 0; i < code.length; i++) diff |= (given.charCodeAt(i) || 0) ^ code.charCodeAt(i);
    if (diff !== 0) {
      await rlFail(env, ip);
      return err("کد نصب اشتباهه.", 401);
    }
    const exp = Date.now() + 3600000;
    return json({ ok: true }, 200, { "Set-Cookie": `vp_i=${await codeToken(code, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${https ? "; Secure" : ""}` });
  }

  if (!unlocked) return err("اول کد نصب رو وارد کن.", 401);

  // --- مرحله ۱: توکن ربات ---
  if (request.method === "POST" && p === "/install/api/token") {
    const token = String((await body()).token || "").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) return err("فرمت توکن درست نیست (مثل 123456:ABC-DEF...).");
    const me = await tg(token, "getMe");
    if (!me.ok) return err(`تلگرام توکن رو نپذیرفت: ${me.description || "نامعتبر"}`);
    const prev = await getPending(env);
    const pend = {
      token, secret: prev?.token === token ? prev.secret : randHex(16), claim_code: prev?.token === token ? prev.claim_code : randCode(8),
      bot: { username: me.result.username, name: me.result.first_name }, claimed: prev?.token === token ? prev.claimed || null : null, created: Date.now(),
    };
    await setPending(env, pend);
    let canClaim = false;
    if (https) {
      const r = await tg(token, "setWebhook", { url: `${url.origin}/webhook/${pend.secret}`, allowed_updates: ["message"] });
      canClaim = !!r.ok;
    }
    return json({ ok: true, bot: pend.bot, claim_code: pend.claim_code, canClaim, claimed: pend.claimed, webhook_url: hookUrl(url.origin, pend) });
  }
  if (request.method === "GET" && p === "/install/api/claim") {
    const pend = await getPending(env);
    return json({ ok: true, claimed: pend?.claimed || null });
  }

  // --- تست وب‌هوک: تلگرام آدرس رو شناخته و خطایی نداره؟ ---
  if (request.method === "POST" && p === "/install/api/ping") {
    const pend = await getPending(env);
    if (!pend) return err("اول توکن ربات رو وارد کن.");
    const r = await tg(pend.token, "getWebhookInfo");
    if (!r.ok) return err(`تلگرام: ${r.description || "خطا"}`);
    const want = hookUrl(url.origin, pend);
    return json({ ok: true, matches: !!want && r.result.url === want, url: r.result.url || "", pending: r.result.pending_update_count || 0, last_error: r.result.last_error_message || null });
  }
  // --- شروع مجدد ---
  if (request.method === "POST" && p === "/install/api/reset") {
    const pend = await getPending(env);
    if (pend) await tg(pend.token, "deleteWebhook", { drop_pending_updates: false });
    await delPending(env);
    return json({ ok: true });
  }

  // --- مرحله آخر: ذخیره + وبهوک ---
  if (request.method === "POST" && p === "/install/api/finish") {
    const pend = await getPending(env);
    if (!pend) return err("اول توکن ربات رو وارد کن.");
    const b = await body();
    const admins = [...new Set((Array.isArray(b.admins) ? b.admins : adminList(b.admins)).map((x) => String(x).trim()).filter(Boolean))];
    if (!admins.length) return err("حداقل یک ادمین لازمه.");
    if (admins.some((a) => !/^\d{5,15}$/.test(a))) return err("آیدی عددی ادمین باید فقط عدد باشه (۵ تا ۱۵ رقم).");
    const password = String(b.password || "");
    if (password.length < 8 || password.length > 200) return err("رمز پنل باید حداقل ۸ کاراکتر باشه.");

    const cfg = {
      BOT_TOKEN: pend.token, ADMIN_IDS: admins.join(","), WEBHOOK_SECRET: pend.secret,
      PANEL_PASSWORD_HASH: await hashPassword(password), installed_at: Date.now(),
    };
    // وبهوک نهایی (با همه‌ی انواع آپدیت). روی Node بدون https وبهوک ممکن نیست؛ سرور خودش long polling میزنه
    let webhook = "skipped";
    if (https) {
      const r = await tg(pend.token, "setWebhook", { url: `${url.origin}/webhook/${pend.secret}`, allowed_updates: ["message", "callback_query", "chat_member"] });
      if (!r.ok) return err(`ست‌کردن وبهوک ناموفق بود: ${r.description || "؟"}`);
      webhook = "set";
    } else {
      await tg(pend.token, "deleteWebhook", { drop_pending_updates: false });
    }
    await saveInstallCfg(env, cfg);
    await delPending(env);
    let notified = 0;
    for (const a of admins) {
      const r = await tg(pend.token, "sendMessage", {
        chat_id: a, parse_mode: "HTML",
        text: `✅ <b>ربات نصب شد!</b>\n\nبرای ورود به پنل وب همین‌جا دستور /panel رو بفرست.\n(یا از آدرس ${https ? url.origin + "/panel" : "پنل"} با رمزی که ساختی وارد شو.)\n\nبرای شروع /start بزن.`,
      });
      if (r.ok) notified++;
    }
    // Node: سرویس‌های ربات (وبهوک/polling/بکاپ شبانه/پیام همگانی) رو راه می‌اندازه
    if (typeof env.onInstalled === "function") {
      try {
        await env.onInstalled(cfg, url.origin);
      } catch (e) {
        console.error("onInstalled", e);
      }
    }
    return json({ ok: true, webhook, notified, admins: admins.length, panel: `${url.origin}/panel` });
  }
  return err("not found", 404);
}
