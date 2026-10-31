/**
 * ربات فروش کانفیگ VPN - Cloudflare Workers + D1
 * ------------------------------------------------
 * امکانات: خرید اشتراک، تمدید، تست رایگان، کیف پول+شارژ (کارت‌به‌کارت با تایید دستی ادمین)،
 * زیرمجموعه‌گیری با کمیسیون، گردونه شانس، عضویت اجباری، پنل مدیریت کامل دکمه‌ای.
 *
 * ENV (secret): BOT_TOKEN, ADMIN_IDS (کاما جدا), WEBHOOK_SECRET
 * Binding: DB (D1)  |  اختیاری: KV (کش تنظیمات) + پنل وب (/panel)
 */

import { PANEL_TYPES, hydratePanel, randomId, isIpHost, customPort, panelCreateUser, panelUsage, panelRenew, panelTest, panelFindUser, panelRenewExisting, ownsSubscription, clearPanelCache } from "./panels.js";
import { qrPng } from "./qr.js";
import { getSettingCached, setSettingCached } from "./web/optimizer.js";
import { handleWeb, runScheduled, setOrigin, createLoginLink } from "./web/api.js";

const TG = (token) => `https://api.telegram.org/bot${token}`;

// ---------- شخصی‌سازی ظاهر: متن/رنگ دکمه‌ها و قوانین ----------
const MENU_ITEMS = [
  { key: "buy", label: "🛍 خرید اشتراک", style: "success" },
  { key: "renew", label: "♻️ تمدید سرویس", style: "primary" },
  { key: "trial", label: "🔑 تست رایگان", style: "primary" },
  { key: "wheel", label: "🎰 گردونه شانس", style: "primary" },
  { key: "services", label: "📦 سرویس‌های من", style: "primary" },
  { key: "wallet", label: "💰 کیف پول + شارژ", style: "primary" },
  { key: "referral", label: "🤝 زیرمجموعه‌گیری", style: "primary" },
  { key: "pricing", label: "💳 تعرفه اشتراک‌ها", style: "primary" },
  { key: "support", label: "☎️ پشتیبانی", style: "danger" },
  { key: "tutorial", label: "📚 آموزش اتصال", style: "primary" },
  { key: "lookup", label: "🔎 استعلام/تمدید اشتراک قبلی", style: "primary" },
  { key: "admin", label: "🛠 پنل مدیریت", style: "primary" },
];
const MENU_BY_KEY = Object.fromEntries(MENU_ITEMS.map((m) => [m.key, m]));
const COLOR_EMOJI = { primary: "🟦", success: "🟩", danger: "🟥", none: "⬜" };
const COLOR_NAME = { primary: "آبی", success: "سبز", danger: "قرمز", none: "بدون رنگ" };
const VALID_STYLES = ["primary", "success", "danger", "none"];

const DEFAULT_RULES_BTN = "✅ قوانین رو می‌پذیرم";
const DEFAULT_RULES_TEXT =
  "📜 <b>قوانین و شرایط استفاده</b>\n\n" +
  "۱. سرویس‌ها فقط برای استفاده شخصی هستن و اشتراک‌گذاری لینک/کانفیگ با دیگران مجاز نیست.\n" +
  "۲. بعد از تحویل سرویس، بازگشت وجه ممکن نیست مگر در صورت مشکل فنی از سمت ما.\n" +
  "۳. مسئولیت استفاده از سرویس با خود شماست.\n" +
  "۴. هرگونه سوءاستفاده (تقلب در رفرال، ساخت حساب‌های متعدد برای تست رایگان و ...) باعث مسدود شدن حساب میشه.\n" +
  "۵. پشتیبانی فقط از طریق همین ربات انجام میشه.\n\n" +
  "با زدن دکمه زیر، قوانین رو خوندی و قبول می‌کنی.";

// تنظیمات از دیتابیس خونده میشه ولی کش میشه (سقف ۵۰ کوئری در هر اجرا روی پلن رایگان)
const uiCache = new WeakMap();
async function loadUiCfg(env) {
  const hit = uiCache.get(env.DB);
  if (hit && hit.exp > Date.now()) return hit.cfg;
  let cfg = {};
  try {
    cfg = JSON.parse(await getSetting(env, "ui_cfg", "{}")) || {};
  } catch {
    cfg = {};
  }
  cfg.menu = cfg.menu || {};
  cfg.roles = cfg.roles || {};
  uiCache.set(env.DB, { cfg, exp: Date.now() + 20000 });
  return cfg;
}
async function saveUiCfg(env, cfg) {
  await setSetting(env, "ui_cfg", JSON.stringify(cfg));
  uiCache.set(env.DB, { cfg, exp: Date.now() + 20000 });
}
const menuLabel = (cfg, key) => cfg.menu[key]?.label || MENU_BY_KEY[key].label;
const menuStyle = (cfg, key) => cfg.menu[key]?.style || MENU_BY_KEY[key].style;
// متن هر دکمه (فعلی، پیش‌فرض یا قدیمی) رو به کلید منو تبدیل می‌کنه؛ پس کیبوردهای قدیمی روی گوشی کاربرها هم کار می‌کنن
function resolveMenuKey(cfg, text) {
  if (!text) return null;
  for (const it of MENU_ITEMS) {
    const c = cfg.menu[it.key];
    if (text === it.label || text === c?.label || (c?.aliases || []).includes(text)) return it.key;
  }
  return null;
}

// ---------- استایل رنگی دکمه‌ها (Bot API: style = primary آبی | success سبز | danger قرمز) ----------
// فقط روی کلاینت‌های جدید (بعد از فوریه ۲۰۲۶) دیده میشه؛ روی قدیمی‌ها دکمه معمولی نشون داده میشه.
const STYLED_METHODS = new Set(["sendMessage", "editMessageText", "sendPhoto", "editMessageReplyMarkup"]);
function pickRole(btn) {
  const d = btn.callback_data || "";
  if (/^adm:(ord_no|pdel_confirm|pndel_confirm|cfgdel|ban|pdel|pndel):/.test(d)) return "danger";
  if (/^adm:(ord_ok|unban):/.test(d) || /^(paywallet|paycard|renewwallet|renewcard|cpw|cpc|xw|xc|xv|xk):/.test(d) || d === "check_membership") return "success";
  return "primary";
}
function styleMarkup(markup, cfg) {
  if (!markup) return markup;
  const roles = cfg?.roles || {};
  const done = (b, style) => {
    const { _key, ...rest } = b;
    delete rest.style;
    if (style && style !== "none") rest.style = style;
    return rest;
  };
  const mapBtn = (b) => {
    if (!b || typeof b !== "object") return b;
    if (b._key) {
      const it = MENU_BY_KEY[b._key];
      const c = cfg?.menu?.[b._key];
      return { ...done(b, c?.style || it.style), text: c?.label || it.label };
    }
    if (b.style) return done(b, b.style); // استایل صریح (مثلا دکمه سبز قوانین)
    const role = pickRole(b);
    return done(b, roles[role] || role);
  };
  const out = { ...markup };
  if (markup.inline_keyboard) out.inline_keyboard = markup.inline_keyboard.map((row) => row.map(mapBtn));
  if (markup.keyboard) {
    out.keyboard = markup.keyboard
      .map((row) => row.filter((b) => !(b && b._key && b._key !== "admin" && cfg?.menu?.[b._key]?.hidden)).map(mapBtn))
      .filter((row) => row.length);
  }
  return out;
}
const stripStyle = (markup) => JSON.parse(JSON.stringify(markup, (k, v) => (k === "style" ? undefined : v)));

async function rawCall(env, method, payload) {
  const res = await fetch(`${TG(env.BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
async function tgCall(env, method, payload) {
  let p = payload;
  if (p && p.reply_markup && STYLED_METHODS.has(method)) {
    const cfg = await loadUiCfg(env);
    let m = styleMarkup(p.reply_markup, cfg);
    if (env.NO_BUTTON_STYLE === "1") m = stripStyle(m);
    p = { ...p, reply_markup: m };
  }
  let res = await rawCall(env, method, p);
  // اگه تلگرام استایل رو نپذیرفت، یک‌بار بدون استایل دوباره می‌فرستیم تا ربات از کار نیفته
  if (!res.ok && p && p.reply_markup && /style|button/i.test(res.description || "")) {
    res = await rawCall(env, method, { ...p, reply_markup: stripStyle(p.reply_markup) });
  }
  return res;
}
// آپلود فایل (برای QR): multipart/form-data
async function tgUpload(env, method, fields, fileField, fileName, bytes) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  form.append(fileField, new Blob([bytes], { type: "image/png" }), fileName);
  const res = await fetch(`${TG(env.BOT_TOKEN)}/${method}`, { method: "POST", body: form });
  return res.json();
}
// QR کد لینک رو (بدون هیچ سرویس بیرونی) می‌سازه و می‌فرسته؛ اگه خاموش یا ناموفق بود null/خطا برمی‌گردونه
async function sendQrPhoto(env, chatId, link, caption, extra = {}) {
  try {
    const cfg = await loadUiCfg(env);
    if (cfg.qr_enabled === false) return null;
    const png = qrPng(String(link));
    let markup = extra.reply_markup ? styleMarkup(extra.reply_markup, cfg) : undefined;
    if (markup && env.NO_BUTTON_STYLE === "1") markup = stripStyle(markup);
    const fields = { chat_id: chatId, caption, parse_mode: "HTML", reply_markup: markup };
    let r = await tgUpload(env, "sendPhoto", fields, "photo", "qr.png", png);
    if (!r.ok && markup && /style|button/i.test(r.description || "")) {
      r = await tgUpload(env, "sendPhoto", { ...fields, reply_markup: stripStyle(markup) }, "photo", "qr.png", png);
    }
    return r;
  } catch {
    return null;
  }
}
// ارسال لینک اشتراک به‌همراه QR (کپشن عکس حداکثر ۱۰۲۴ کاراکتره؛ اگه بلندتر بود متن و QR جدا میرن)
async function deliverLink(env, chatId, text, link, extra = {}) {
  const cfg = await loadUiCfg(env);
  const qrOn = cfg.qr_enabled !== false;
  if (qrOn && text.length <= 1000) {
    const r = await sendQrPhoto(env, chatId, link, text, extra);
    if (r && r.ok) return;
  }
  await sendMessage(env, chatId, text, extra);
  if (qrOn && text.length > 1000) await sendQrPhoto(env, chatId, link, "📲 QR کد اشتراک", {});
}

const sendMessage = (env, chatId, text, extra = {}) =>
  tgCall(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
const sendPhoto = (env, chatId, photo, caption, extra = {}) =>
  tgCall(env, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra });
const answerCallback = (env, id, text, showAlert = false) =>
  tgCall(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
const editMessageText = (env, chatId, messageId, text, extra = {}) =>
  tgCall(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtMoney = (n) => Number(n || 0).toLocaleString("fa-IR") + " تومان";

function isAdmin(env, userId) {
  return (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).includes(String(userId));
}

// ---------- دیتابیس: کاربران ----------
const getUser = (env, id) => env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();

async function touchUser(env, tgUser) {
  const existing = await getUser(env, tgUser.id);
  const now = Date.now();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users (id, username, first_name, wallet_balance, referral_count, registered, joined_at, last_seen)
       VALUES (?,?,?,0,0,0,?,?)`
    ).bind(tgUser.id, tgUser.username || null, tgUser.first_name || null, now, now).run();
    return await getUser(env, tgUser.id);
  }
  await env.DB.prepare("UPDATE users SET username=?, first_name=?, last_seen=? WHERE id=?")
    .bind(tgUser.username || null, tgUser.first_name || null, now, tgUser.id).run();
  return existing;
}

// ---------- تنظیمات عمومی ----------
async function getSetting(env, key, fallback = "") {
  return getSettingCached(env, key, fallback);
}
async function setSetting(env, key, value) {
  await setSettingCached(env, key, value);
}

// ---------- وضعیت موقت (state machine) ----------
async function stateGet(env, key) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind(key).first();
  return row ? row.value : null;
}
async function stateSet(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}
async function stateDelete(env, key) {
  await env.DB.prepare("DELETE FROM state WHERE key=?").bind(key).run();
}
const getAdminState = (env, adminId) => stateGet(env, `admin_state:${adminId}`);
const setAdminState = (env, adminId, obj) => stateSet(env, `admin_state:${adminId}`, JSON.stringify(obj));
const clearAdminState = (env, adminId) => stateDelete(env, `admin_state:${adminId}`);
const getUserState = (env, userId) => stateGet(env, `user_state:${userId}`);
const setUserState = (env, userId, obj) => stateSet(env, `user_state:${userId}`, JSON.stringify(obj));
const clearUserState = (env, userId) => stateDelete(env, `user_state:${userId}`);

// ---------- عضویت اجباری ----------
async function getChannels(env) {
  const { results } = await env.DB.prepare("SELECT ref, title FROM channels").all();
  return results || [];
}
function channelLink(ch) {
  if (ch.ref && ch.ref.startsWith("@")) return `https://t.me/${ch.ref.slice(1)}`;
  return null;
}
async function checkMembership(env, userId) {
  const channels = await getChannels(env);
  const missing = [];
  for (const ch of channels) {
    try {
      const r = await tgCall(env, "getChatMember", { chat_id: ch.ref, user_id: userId });
      const status = r?.result?.status;
      if (!status || ["left", "kicked"].includes(status)) missing.push(ch);
    } catch {
      missing.push(ch);
    }
  }
  return { ok: missing.length === 0, missing };
}
function membershipKeyboard(missing) {
  const rows = missing.map((ch) => {
    const link = channelLink(ch) || `https://t.me/${String(ch.ref).replace("@", "")}`;
    return [{ text: `📢 عضویت در ${ch.title || ch.ref}`, url: link }];
  });
  rows.push([{ text: "✅ عضو شدم، بررسی کن", callback_data: "check_membership" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// ---------- منوها ----------
function mainMenuKeyboard(admin) {
  const k = (key) => ({ text: MENU_BY_KEY[key].label, _key: key }); // متن/رنگ نهایی در tgCall از تنظیمات اعمال میشه
  const rows = [
    [k("buy"), k("renew")],
    [k("trial"), k("wheel")],
    [k("services"), k("wallet")],
    [k("referral"), k("pricing")],
    [k("support"), k("tutorial")],
    [k("lookup")],
  ];
  if (admin) rows.push([k("admin")]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function adminMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 مدیریت محصولات", callback_data: "adm:products" }],
        [{ text: "🔌 مدیریت پنل‌ها", callback_data: "adm:panels" }],
        [{ text: "🧾 رسیدهای در انتظار", callback_data: "adm:orders" }],
        [{ text: "💳 تنظیم شماره کارت", callback_data: "adm:cardset" }],
        [{ text: "🤝 درصد کمیسیون زیرمجموعه", callback_data: "adm:refset" }],
        [{ text: "🎰 تنظیم جوایز گردونه", callback_data: "adm:wheelset" }],
        [{ text: "☎️ متن پشتیبانی/آموزش", callback_data: "adm:texts" }],
        [{ text: "🌍 کانال‌های اجباری", callback_data: "adm:channels" }],
        [{ text: "👥 مدیریت کاربران", callback_data: "adm:users" }],
        [{ text: "🔎 اشتراک قبلی و QR", callback_data: "adm:sub" }],
        [{ text: "📜 قوانین", callback_data: "adm:rules" }],
        [{ text: "🎨 شخصی‌سازی دکمه‌ها", callback_data: "adm:ui" }],
        [{ text: "📣 گروه گزارش", callback_data: "adm:log" }],
        [{ text: "📊 آمار", callback_data: "adm:stats" }],
        [{ text: "📢 پیام همگانی", callback_data: "adm:broadcast" }],
      ],
    },
  };
}

// ---------- محصولات و کانفیگ ----------
// اگه مایگریشن v5 اجرا نشده باشه، جدول/ستون دسته‌بندی خودش ساخته میشه (بی‌خطره؛ اگه از قبل باشه نادیده گرفته میشه)
let catSchemaReady = false;
async function ensureCatSchema(env) {
  if (catSchemaReady) return;
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at INTEGER)"
    ).run();
  } catch (e) {
    console.error("categories table", e);
  }
  try {
    await env.DB.prepare("ALTER TABLE products ADD COLUMN category_id INTEGER").run();
  } catch {
    // ستون از قبل هست
  }
  catSchemaReady = true;
}
async function listCategories(env, { onlyEnabled = true } = {}) {
  const q = `SELECT * FROM categories ${onlyEnabled ? "WHERE enabled=1 " : ""}ORDER BY sort_order, id`;
  try {
    const { results } = await env.DB.prepare(q).all();
    return results || [];
  } catch {
    await ensureCatSchema(env);
    try {
      const { results } = await env.DB.prepare(q).all();
      return results || [];
    } catch {
      return [];
    }
  }
}
// منوی خرید مشتری: اگه دسته‌بندی فعالی (با محصول) باشه اول دسته‌ها نشون داده میشن؛ catId: null = ریشه | 0 = «سایر» | عدد = دسته
async function buildBuyView(env, catId = null) {
  const products = await listProducts(env);
  if (!products.length) return { text: "فعلا محصولی برای فروش ثبت نشده." };
  const allCats = await listCategories(env, { onlyEnabled: false });
  const known = new Set(allCats.map((c) => c.id));
  const enabledIds = new Set(allCats.filter((c) => c.enabled).map((c) => c.id));
  const catOf = (p) => (p.category_id && known.has(p.category_id) ? p.category_id : 0);
  const visible = products.filter((p) => catOf(p) === 0 || enabledIds.has(catOf(p)));
  if (!visible.length) return { text: "فعلا محصولی برای فروش ثبت نشده." };
  const prodRow = (p) => [
    { text: p.custom ? `🧮 ${p.name} — از ${fmtMoney(p.price)}` : `${p.name} — ${fmtMoney(p.price)}`, callback_data: `buy:${p.id}` },
  ];
  const cats = allCats.filter((c) => c.enabled && visible.some((p) => catOf(p) === c.id));
  if (!cats.length) return { text: "یکی از پلن‌ها رو انتخاب کن:", reply_markup: { inline_keyboard: visible.map(prodRow) } };
  if (catId === null) {
    const rows = cats.map((c) => [{ text: `${c.name} (${visible.filter((p) => catOf(p) === c.id).length})`, callback_data: `buycat:${c.id}` }]);
    const others = visible.filter((p) => catOf(p) === 0).length;
    if (others) rows.push([{ text: `📦 سایر (${others})`, callback_data: "buycat:0" }]);
    return { text: "🗂 دسته‌بندی مورد نظرت رو انتخاب کن:", reply_markup: { inline_keyboard: rows } };
  }
  const list = visible.filter((p) => catOf(p) === catId);
  if (!list.length) return { text: "این دسته‌بندی فعلا محصولی نداره.", reply_markup: { inline_keyboard: [[{ text: "🔙 دسته‌بندی‌ها", callback_data: "buycats" }]] } };
  const title = catId === 0 ? "📦 سایر" : allCats.find((c) => c.id === catId)?.name || "";
  return {
    text: `${escapeHtml(title)}\nیکی از پلن‌ها رو انتخاب کن:`,
    reply_markup: { inline_keyboard: [...list.map(prodRow), [{ text: "🔙 دسته‌بندی‌ها", callback_data: "buycats" }]] },
  };
}
async function listProducts(env, { onlyEnabled = true, excludeTrial = true } = {}) {
  let sql = "SELECT * FROM products WHERE 1=1";
  if (onlyEnabled) sql += " AND enabled=1";
  if (excludeTrial) sql += " AND is_trial=0";
  sql += " AND (custom IS NULL OR panel_id IS NOT NULL)"; // حجم دلخواه بدون پنل قابل فروش نیست
  sql += " ORDER BY price ASC";
  const { results } = await env.DB.prepare(sql).all();
  return results || [];
}

async function claimConfig(env, productId) {
  for (let i = 0; i < 3; i++) {
    const row = await env.DB.prepare(
      "SELECT id, config_text FROM configs WHERE product_id=? AND is_used=0 LIMIT 1"
    ).bind(productId).first();
    if (!row) return null;
    const res = await env.DB.prepare(
      "UPDATE configs SET is_used=1, assigned_at=? WHERE id=? AND is_used=0"
    ).bind(Date.now(), row.id).run();
    if (res.meta && res.meta.changes > 0) return row.config_text;
  }
  return null;
}
async function configStock(env, productId) {
  const row = await env.DB.prepare(
    "SELECT SUM(CASE WHEN is_used=0 THEN 1 ELSE 0 END) as avail, SUM(CASE WHEN is_used=1 THEN 1 ELSE 0 END) as used FROM configs WHERE product_id=?"
  ).bind(productId).first();
  return { avail: row?.avail || 0, used: row?.used || 0 };
}

// ---------- ابزارهای کمکی ----------
async function getPanel(env, id) {
  if (!id) return null;
  return hydratePanel(await env.DB.prepare("SELECT * FROM panels WHERE id=?").bind(id).first());
}
async function notifyAdmins(env, text) {
  const admins = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of admins) await sendMessage(env, a, text);
  await logEvent(env, "errors", text);
}

// ---------- گزارش‌دهی به گروه (هر نوع گزارش یک تاپیک جدا؛ تاپیک‌ها خودکار ساخته میشن) ----------
const LOG_TOPICS = {
  users: { name: "👤 کاربران", color: 7322096, label: "👤 کاربران جدید / خروج" },
  trial: { name: "🎁 تست رایگان", color: 9367192, label: "🎁 تست رایگان" },
  receipt: { name: "🧾 رسیدها", color: 16766590, label: "🧾 رسیدهای ارسالی" },
  orders: { name: "🛒 خرید و تمدید", color: 13338331, label: "🛒 خرید و تمدید" },
  wallet: { name: "💰 کیف پول", color: 16749490, label: "💰 شارژ کیف پول" },
  errors: { name: "⚠️ خطاها", color: 16478047, label: "⚠️ خطاها" },
};
async function getLogCfg(env) {
  const c = safeJson(await getSetting(env, "log_cfg", ""));
  return { chat_id: c.chat_id || null, topics: c.topics || {}, off: Array.isArray(c.off) ? c.off : [] };
}
const saveLogCfg = (env, cfg) => setSetting(env, "log_cfg", JSON.stringify(cfg));
async function ensureLogTopic(env, cfg, key) {
  const def = LOG_TOPICS[key];
  if (!def) return null;
  const r = await rawCall(env, "createForumTopic", { chat_id: cfg.chat_id, name: def.name, icon_color: def.color });
  if (r.ok && r.result?.message_thread_id) {
    cfg.topics[key] = r.result.message_thread_id;
    await saveLogCfg(env, cfg);
    return cfg.topics[key];
  }
  return { error: r.description || "unknown" };
}
// هیچ‌وقت خطا پرت نمی‌کنه تا گزارش‌دهی جلوی کار اصلی ربات رو نگیره
async function logEvent(env, key, text, { photo = null } = {}) {
  try {
    const cfg = await getLogCfg(env);
    if (!cfg.chat_id || cfg.off.includes(key)) return;
    let tid = cfg.topics[key] || null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!tid) {
        const t = await ensureLogTopic(env, cfg, key);
        tid = typeof t === "number" ? t : null; // گروه فروم نیست/دسترسی نیست → بدون تاپیک می‌فرستیم
      }
      const base = { chat_id: cfg.chat_id, ...(tid ? { message_thread_id: tid } : {}) };
      const r = photo
        ? await rawCall(env, "sendPhoto", { ...base, photo, caption: text.slice(0, 1000), parse_mode: "HTML" })
        : await rawCall(env, "sendMessage", { ...base, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true });
      if (r.ok) return;
      if (tid && /thread not found|TOPIC_DELETED|TOPIC_CLOSED|topic.*(deleted|closed)/i.test(r.description || "")) {
        delete cfg.topics[key];
        await saveLogCfg(env, cfg);
        tid = null;
        continue;
      }
      console.error("log send failed", r.description);
      return;
    }
  } catch (e) {
    console.error("logEvent error", e);
  }
}
async function logUserTag(env, userId) {
  const u = await getUser(env, userId).catch(() => null);
  const name = u?.first_name ? escapeHtml(u.first_name) : "-";
  return `${name}${u?.username ? ` (@${escapeHtml(u.username)})` : ""} — <code>${userId}</code>`;
}
async function logOrderResult(env, order, result) {
  try {
    if (order.type !== "topup" && order.amount === 0 && !order.ext_id) return; // تست رایگان جدا گزارش میشه
    const tag = await logUserTag(env, order.user_id);
    const p = order.product_id ? await env.DB.prepare("SELECT name FROM products WHERE id=?").bind(order.product_id).first() : null;
    const ext = order.ext_id ? await env.DB.prepare("SELECT username FROM ext_services WHERE id=?").bind(order.ext_id).first() : null;
    const kind = order.type === "topup" ? "شارژ کیف پول" : order.type === "renew" ? "تمدید" : "خرید";
    const method = order.receipt_file_id ? "کارت‌به‌کارت" : "کیف پول";
    if (!result.ok) {
      if (result.reason === "already") return;
      await logEvent(
        env,
        "errors",
        `❌ <b>${kind} ناموفق</b> (سفارش #${order.id})\n👤 ${tag}\n📦 ${escapeHtml(p?.name || "-")}\n💵 ${fmtMoney(order.amount)}\n🧩 ${escapeHtml(String(result.detail || result.reason || ""))}`
      );
      return;
    }
    if (order.type === "topup") {
      await logEvent(env, "wallet", `💰 <b>شارژ کیف پول تایید شد</b> (سفارش #${order.id})\n👤 ${tag}\n💵 ${fmtMoney(order.amount)}`);
      return;
    }
    const extra = [];
    if (ext) extra.push(`🔗 اشتراک: <code>${escapeHtml(ext.username)}</code>`);
    if (order.gb != null || order.days != null) extra.push(`📊 ${order.gb > 0 ? trimNum(order.gb) + " گیگ" : "-"} | ⏳ ${order.days || "-"} روز`);
    await logEvent(
      env,
      "orders",
      [`${order.type === "renew" ? "♻️" : "🛒"} <b>${kind} موفق</b> (سفارش #${order.id})`, `👤 ${tag}`, `📦 ${escapeHtml(p?.name || "-")}`, ...extra, `💵 ${fmtMoney(order.amount)} — ${method}`].join("\n")
    );
  } catch (e) {
    console.error("logOrderResult", e);
  }
}
const safeJson = (v) => {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};
function fmtBytes(b) {
  const n = Number(b || 0);
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2).replace(/\.?0+$/, "") + " گیگ";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + " مگ";
  return (n / 1024).toFixed(0) + " کیلو";
}
function fmtExpire(sec) {
  if (!sec) return "نامحدود";
  const d = new Date(sec * 1000).toLocaleDateString("fa-IR");
  const left = Math.ceil((sec * 1000 - Date.now()) / 86400000);
  return left >= 0 ? `${d} (${left.toLocaleString("fa-IR")} روز مانده)` : `${d} (منقضی شده)`;
}
// ---------- ارقام و محصول حجم دلخواه ----------
const normDigits = (s) =>
  String(s ?? "")
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/٫/g, ".");
const parseNum = (s) => {
  const t = normDigits(s).replace(/[,،\s]/g, "");
  return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
};
const parseMoney = (s) => parseInt(normDigits(s).replace(/[^\d]/g, ""), 10);
const trimNum = (n) => String(Math.round(Number(n) * 100) / 100);
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const customOf = (pr) => (pr && pr.custom ? safeJson(pr.custom) : null);
const customPrice = (c, gb, days) => Math.max(0, Math.round(gb * c.price_per_gb + days * (c.price_per_day || 0)));
const customValid = (c, gb, days) =>
  Number.isFinite(gb) && Number.isInteger(days) && gb >= c.min_gb && gb <= c.max_gb && days >= c.min_days && days <= c.max_days;
const NICE_GB = [1, 2, 3, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000];
const NICE_DAYS = [7, 15, 30, 60, 90, 180, 365];
function pickPresets(min, max, nice) {
  let arr = [...new Set([min, max, ...nice.filter((x) => x > min && x < max)])].sort((a, b) => a - b);
  if (arr.length > 6) arr = [...new Set(Array.from({ length: 6 }, (_, i) => arr[Math.round((i * (arr.length - 1)) / 5)]))];
  return arr;
}
// ورودی ادمین (فیلدهای جدا شده با |) → تنظیمات حجم دلخواه
function parseCustomFields(f) {
  const n = f.map((x) => parseNum(x));
  const [min_gb, max_gb, min_days, max_days, price_per_gb] = n;
  const price_per_day = f[5] === undefined || f[5] === "" || f[5] === "-" ? 0 : n[5];
  if ([min_gb, max_gb, min_days, max_days, price_per_gb, price_per_day].some((x) => !Number.isFinite(x))) {
    return { error: "همه فیلدها باید عدد باشن (قیمت هر روز اختیاریه)." };
  }
  if (min_gb <= 0 || max_gb < min_gb) return { error: "بازه گیگ نامعتبره (حداقل > 0 و حداکثر ≥ حداقل)." };
  if (!Number.isInteger(min_days) || !Number.isInteger(max_days) || min_days < 1 || max_days < min_days) {
    return { error: "بازه روز نامعتبره (عدد صحیح؛ حداقل ≥ 1 و حداکثر ≥ حداقل)." };
  }
  if (price_per_gb < 0 || price_per_day < 0) return { error: "قیمت‌ها نمی‌تونن منفی باشن." };
  const c = { min_gb, max_gb, min_days, max_days, price_per_gb, price_per_day };
  if (customPrice(c, min_gb, min_days) <= 0) return { error: "قیمت کمترین بسته صفر میشه؛ قیمت هر گیگ یا هر روز رو بیشتر کن." };
  return { c };
}
const CUSTOM_HELP =
  "🧮 محصول حجم دلخواه — مشتری حجم و مدت رو خودش انتخاب می‌کنه و قیمت خودکار حساب میشه.\n\n" +
  "فرمت (با | جدا کن):\nنام | حداقل گیگ | حداکثر گیگ | حداقل روز | حداکثر روز | قیمت هر گیگ | قیمت هر روز (اختیاری) | توضیحات (اختیاری)\n\n" +
  "مثال:\nحجم دلخواه | 5 | 200 | 30 | 365 | 2000 | 0 | هر مقدار که می‌خوای\n\n" +
  "قیمت = (گیگ × قیمت هر گیگ) + (روز × قیمت هر روز)\n" +
  "مثلا ۵۰ گیگ و ۹۰ روز با هر گیگ ۲٬۰۰۰ و هر روز ۱۰۰ → ۱۰۹٬۰۰۰ تومان.\n\nبرای لغو: /cancel";

// پایه‌ی تمدید: سفارش خرید تایید‌شده‌ی پنلی (غیر تست) + محاسبه‌ی حجم/مدت/قیمت تمدید
const RENEW_COLS = `o.gb as o_gb, o.days as o_days, p.name as pname, p.price as pprice, p.duration_days as pdays, p.data_limit_gb as pgb, p.custom as pcustom`;
const RENEW_WHERE = `o.user_id=? AND o.type='purchase' AND o.status='approved' AND o.panel_id IS NOT NULL AND p.enabled=1 AND p.is_trial=0`;
function renewPlan(r) {
  const c = r.pcustom ? safeJson(r.pcustom) : null;
  const gb = r.o_gb ?? r.pgb ?? 0;
  const days = r.o_days ?? r.pdays ?? 0;
  return { gb, days, price: c && c.price_per_gb != null ? customPrice(c, gb, days) : r.pprice };
}

const genPanelUsername = (userId) => `bot${userId}x${randomId(4)}`;
const reasonText = (r) =>
  r.reason === "out_of_stock" ? "موجودی کانفیگ این محصول تموم شده! اول کانفیگ اضافه کن."
  : r.reason === "already" ? "این سفارش قبلا رسیدگی شده یا در حال پردازشه."
  : `خطا: ${r.detail || r.reason}`;

// قفل اتمیک روی سفارش تا با دوبار زدن دکمه تایید، دو بار سرویس ساخته نشه
async function withOrderLock(env, order, fn) {
  const lock = await env.DB.prepare("UPDATE orders SET status='processing' WHERE id=? AND status='pending'").bind(order.id).run();
  if (!(lock.meta && lock.meta.changes > 0)) return { ok: false, reason: "already" };
  const unlock = () => env.DB.prepare("UPDATE orders SET status='pending' WHERE id=? AND status='processing'").bind(order.id).run();
  try {
    const r = await fn();
    if (!r.ok) await unlock();
    return r;
  } catch (e) {
    await unlock();
    return { ok: false, reason: "error", detail: String(e?.message || e) };
  }
}

async function sendServiceMessage(env, order, product, link, { renewed = false } = {}) {
  const isLink = /^https?:\/\//i.test(link);
  const head = renewed ? "✅ سرویس شما تمدید شد!" : order.amount > 0 ? "✅ خرید شما تایید شد!" : "🎁 سرویس تست شما آماده‌ست!";
  const gb = order.gb ?? product?.data_limit_gb ?? 0;
  const days = order.days ?? product?.duration_days ?? 0;
  const lines = [head, "", `📦 محصول: ${escapeHtml(product?.name || "-")}`];
  if (product?.panel_id) {
    lines.push(`📊 حجم: ${gb > 0 ? trimNum(gb) + " گیگ" : "نامحدود"} | ⏳ مدت: ${days > 0 ? days + " روز" : "نامحدود"}`);
  }
  lines.push("", isLink ? "🔗 لینک اشتراک (کپی کن و داخل برنامه Import کن):" : "🔑 کانفیگ شما:", `<code>${escapeHtml(link)}</code>`);
  const cfg = await loadUiCfg(env);
  const extra = cfg.menu.tutorial?.hidden ? {} : { reply_markup: { inline_keyboard: [[{ text: "📚 آموزش اتصال", callback_data: "tutorial" }]] } };
  await deliverLink(env, order.user_id, lines.join("\n"), link, extra);
}

// ---------- کمیسیون زیرمجموعه‌گیری ----------
async function payCommission(env, order) {
  if (!(order.amount > 0)) return;
  const buyer = await getUser(env, order.user_id);
  if (!buyer || !buyer.referred_by) return;
  const percent = parseFloat((await getSetting(env, "referral_percent", "10")) || "10");
  const commission = Math.floor((order.amount * percent) / 100);
  if (commission <= 0) return;
  await env.DB.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?").bind(commission, buyer.referred_by).run();
  await sendMessage(
    env,
    buyer.referred_by,
    `🤝 یکی از زیرمجموعه‌های شما خرید کرد!\n💰 ${fmtMoney(commission)} کمیسیون به کیف پول شما اضافه شد.`
  );
}

// ---------- تکمیل سفارش‌ها (اتمیک) ----------
// خروجی: { ok:true } یا { ok:false, reason: out_of_stock|panel_error|already|error, detail }
async function fulfillPurchase(env, order) {
  return withOrderLock(env, order, async () => {
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(order.product_id).first();
    if (!product) return { ok: false, reason: "no_product", detail: "محصول پیدا نشد" };
    const now = Date.now();
    let link;
    if (product.panel_id) {
      const panel = await getPanel(env, product.panel_id);
      if (!panel || !panel.enabled) return { ok: false, reason: "panel_error", detail: "پنل متصل به این محصول پیدا نشد یا غیرفعاله." };
      let created;
      try {
        created = await panelCreateUser(panel, {
          username: genPanelUsername(order.user_id),
          gb: order.gb ?? product.data_limit_gb ?? 0,
          days: order.days ?? product.duration_days ?? 0,
          note: `tg:${order.user_id} order:${order.id}`,
        });
      } catch (e) {
        return { ok: false, reason: "panel_error", detail: e.message };
      }
      await env.DB.prepare(
        "UPDATE orders SET status='approved', config_text=?, decided_at=?, panel_id=?, panel_username=?, panel_extra=? WHERE id=?"
      ).bind(created.subUrl, now, panel.id, created.panelUsername, JSON.stringify(created.extra || {}), order.id).run();
      link = created.subUrl;
    } else {
      const cfg = await claimConfig(env, order.product_id);
      if (!cfg) return { ok: false, reason: "out_of_stock" };
      await env.DB.prepare("UPDATE orders SET status='approved', config_text=?, decided_at=? WHERE id=?").bind(cfg, now, order.id).run();
      link = cfg;
    }
    await sendServiceMessage(env, order, product, link);
    await payCommission(env, order);
    return { ok: true };
  });
}

// تمدید اشتراکی که خارج از ربات ساخته شده (روی همون اکانت پنل، با نگه‌داشتن بقیه‌ی تنظیماتش)
async function fulfillRenewExt(env, order) {
  const ext = await env.DB.prepare("SELECT * FROM ext_services WHERE id=?").bind(order.ext_id).first();
  const product = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(order.product_id).first();
  if (!ext || !product) return { ok: false, reason: "panel_error", detail: "اشتراک یا محصول پیدا نشد." };
  const panel = await getPanel(env, ext.panel_id);
  if (!panel || !panel.enabled) return { ok: false, reason: "panel_error", detail: "پنل این اشتراک پیدا نشد یا غیرفعاله." };
  const gb = order.gb ?? product.data_limit_gb ?? 0;
  const days = order.days ?? product.duration_days ?? 0;
  try {
    const found = await panelFindUser(panel, ext.username);
    if (!found) return { ok: false, reason: "panel_error", detail: "اشتراک توی پنل پیدا نشد (شاید حذف شده)." };
    await panelRenewExisting(panel, found, { gb, days });
  } catch (e) {
    return { ok: false, reason: "panel_error", detail: e.message };
  }
  await env.DB.prepare("UPDATE orders SET status='approved', decided_at=? WHERE id=?").bind(Date.now(), order.id).run();
  await sendMessage(
    env,
    order.user_id,
    `✅ اشتراک «${escapeHtml(ext.username)}» تمدید شد!\n\n📊 حجم: ${gb > 0 ? trimNum(gb) + " گیگ" : "نامحدود"} | ⏳ مدت: ${days > 0 ? days + " روز" : "نامحدود"}\nمصرف قبلی ریست شد و لینک اشتراکت تغییری نکرده.`
  );
  await payCommission(env, order);
  return { ok: true };
}

async function fulfillRenew(env, order) {
  return withOrderLock(env, order, async () => {
    if (order.ext_id) return fulfillRenewExt(env, order);
    const base = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(order.renew_of).first();
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(order.product_id).first();
    if (!base || !base.panel_id || !product) return { ok: false, reason: "panel_error", detail: "سرویس اصلی پیدا نشد." };
    const panel = await getPanel(env, base.panel_id);
    if (!panel) return { ok: false, reason: "panel_error", detail: "پنل این سرویس پیدا نشد (شاید حذف شده)." };
    try {
      await panelRenew(panel, {
        username: base.panel_username,
        extra: safeJson(base.panel_extra),
        gb: order.gb ?? product.data_limit_gb ?? 0,
        days: order.days ?? product.duration_days ?? 0,
      });
    } catch (e) {
      return { ok: false, reason: "panel_error", detail: e.message };
    }
    await env.DB.prepare("UPDATE orders SET status='approved', decided_at=?, panel_id=?, panel_username=? WHERE id=?")
      .bind(Date.now(), base.panel_id, base.panel_username, order.id).run();
    await sendServiceMessage(env, order, { ...product, panel_id: base.panel_id }, base.config_text, { renewed: true });
    await payCommission(env, order);
    return { ok: true };
  });
}

async function fulfillTopup(env, order) {
  return withOrderLock(env, order, async () => {
    await env.DB.prepare("UPDATE orders SET status='approved', decided_at=? WHERE id=?").bind(Date.now(), order.id).run();
    await env.DB.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?").bind(order.amount, order.user_id).run();
    await sendMessage(env, order.user_id, `✅ شارژ کیف پول شما تایید شد.\n💰 مبلغ ${fmtMoney(order.amount)} به کیف پول اضافه شد.`);
    return { ok: true };
  });
}

const fulfillOrder = async (env, order) => {
  const result = await (order.type === "topup" ? fulfillTopup(env, order) : order.type === "renew" ? fulfillRenew(env, order) : fulfillPurchase(env, order));
  await logOrderResult(env, order, result);
  return result;
};

// ---------- ثبت‌نام کاربر ----------
async function completeRegistration(env, tgUser, referrerId) {
  const userId = tgUser.id;
  const user = await getUser(env, userId);
  if (user && user.registered) return;

  const now = Date.now();
  await env.DB.prepare("UPDATE users SET registered=1, joined_at=? WHERE id=?").bind(now, userId).run();

  if (referrerId && String(referrerId) !== String(userId)) {
    const refUser = await getUser(env, referrerId);
    if (refUser && refUser.registered) {
      try {
        await env.DB.prepare("INSERT INTO referrals (referrer_id, referred_id, created_at) VALUES (?,?,?)")
          .bind(referrerId, userId, now).run();
        await env.DB.prepare("UPDATE users SET referral_count=referral_count+1 WHERE id=?").bind(referrerId).run();
        await env.DB.prepare("UPDATE users SET referred_by=? WHERE id=?").bind(referrerId, userId).run();
        await sendMessage(env, referrerId, "🎉 یک نفر با لینک دعوت شما عضو شد! از خریدهای بعدیش کمیسیون می‌گیری.");
      } catch {
        // قبلا رفرال شده -> نادیده گرفته میشه (ضد تقلب)
      }
    }
  }

  await logEvent(
    env,
    "users",
    `👤 <b>کاربر جدید</b>\n${await logUserTag(env, userId)}${referrerId && String(referrerId) !== String(userId) ? `\n🤝 معرف: <code>${referrerId}</code>` : ""}`
  );
  const botName = await getSetting(env, "bot_display_name", "ربات فروش کانفیگ");
  await sendMessage(
    env,
    userId,
    `سلام «${escapeHtml(tgUser.first_name || "")}» 👋\nبه ${escapeHtml(botName)} خوش اومدی!\n\nاز منوی زیر می‌تونی خرید کنی، تست بگیری، کیف پولت رو شارژ کنی و خیلی کارای دیگه 👇`,
    mainMenuKeyboard(isAdmin(env, userId))
  );
}

// ---------- شروع فرآیند خرید/شارژ (نمایش شماره کارت و درخواست رسید) ----------
async function startCardPayment(env, chatId, userId, orderId, amount) {
  const cardNumber = await getSetting(env, "card_number", "تنظیم نشده");
  const cardHolder = await getSetting(env, "card_holder", "");
  await setUserState(env, userId, { action: "awaiting_receipt", order_id: orderId });
  await sendMessage(
    env,
    chatId,
    [
      `💳 لطفا مبلغ <b>${fmtMoney(amount)}</b> رو به شماره کارت زیر واریز کن:`,
      ``,
      `<code>${escapeHtml(cardNumber)}</code>`,
      cardHolder ? `به نام: ${escapeHtml(cardHolder)}` : "",
      ``,
      `بعد از واریز، عکس رسید رو همینجا بفرست تا ادمین تایید کنه.`,
    ].filter(Boolean).join("\n")
  );
}

async function notifyAdminsNewReceipt(env, order, fileId) {
  const admins = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const buyer = await getUser(env, order.user_id);
  const uname = buyer?.username ? `@${buyer.username}` : buyer?.first_name || String(order.user_id);
  let productLine = "";
  if (order.type === "purchase" || order.type === "renew") {
    const p = await env.DB.prepare("SELECT name FROM products WHERE id=?").bind(order.product_id).first();
    productLine = `محصول: ${p?.name || "-"}\n`;
    if (order.ext_id) {
      const ex = await env.DB.prepare("SELECT username FROM ext_services WHERE id=?").bind(order.ext_id).first();
      productLine += `اشتراک خارج از ربات: ${ex?.username || "-"}\n`;
    }
  }
  const caption = [
    order.type === "purchase" ? "🧾 رسید خرید جدید" : order.type === "renew" ? "🧾 رسید تمدید سرویس" : "🧾 رسید شارژ کیف پول جدید",
    `کاربر: ${uname} (${order.user_id})`,
    productLine,
    `مبلغ: ${fmtMoney(order.amount)}`,
    `شماره سفارش: #${order.id}`,
  ].filter(Boolean).join("\n");

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ تایید", callback_data: `adm:ord_ok:${order.id}` },
          { text: "❌ رد", callback_data: `adm:ord_no:${order.id}` },
        ],
      ],
    },
  };
  for (const adminId of admins) {
    await sendPhoto(env, adminId, fileId, caption, kb);
  }
}

// ---------- گردونه شانس ----------
function defaultWheelPrizes() {
  return [
    { label: "🎉 ۵۰ هزار تومان", amount: 50000, weight: 5 },
    { label: "✨ ۲۰ هزار تومان", amount: 20000, weight: 15 },
    { label: "🙂 ۱۰ هزار تومان", amount: 10000, weight: 30 },
    { label: "😢 پوچ", amount: 0, weight: 50 },
  ];
}
async function getWheelPrizes(env) {
  const raw = await getSetting(env, "wheel_prizes", "");
  if (!raw) return defaultWheelPrizes();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : defaultWheelPrizes();
  } catch {
    return defaultWheelPrizes();
  }
}
function pickWeighted(prizes) {
  const total = prizes.reduce((s, p) => s + (p.weight || 1), 0);
  let r = Math.random() * total;
  for (const p of prizes) {
    r -= p.weight || 1;
    if (r <= 0) return p;
  }
  return prizes[prizes.length - 1];
}

// ---------- قوانین ----------
async function needsRules(env, cfg, userId) {
  if (cfg.rules_enabled === false) return false;
  return (await stateGet(env, `rules_ok:${userId}`)) === null;
}
async function sendRules(env, chatId, cfg, { preview = false } = {}) {
  const text = cfg.rules_text || DEFAULT_RULES_TEXT;
  const markup = {
    inline_keyboard: [[{ text: cfg.rules_btn || DEFAULT_RULES_BTN, callback_data: preview ? "noop" : "rules_ok", style: "success" }]],
  };
  const r = await sendMessage(env, chatId, text, { reply_markup: markup });
  if (!r.ok) {
    // اگه متن HTML نامعتبر بود، بدون فرمت می‌فرستیم تا کاربر گیر نکنه
    await tgCall(env, "sendMessage", { chat_id: chatId, text: text.replace(/<[^>]*>/g, ""), reply_markup: markup });
  }
}
// ادامه مسیر /start بعد از پذیرش قوانین: عضویت اجباری ← ثبت‌نام (با رفرال ذخیره‌شده)
async function continueStart(env, tgUser, chatId) {
  const userId = tgUser.id;
  const { ok, missing } = await checkMembership(env, userId);
  if (!ok) {
    await sendMessage(env, chatId, "برای استفاده از ربات، ابتدا عضو کانال(های) زیر بشید:", membershipKeyboard(missing));
    return;
  }
  const dbUser = await getUser(env, userId);
  if (dbUser && dbUser.registered) {
    await sendMessage(env, chatId, "خوش برگشتی! از منوی زیر استفاده کن:", mainMenuKeyboard(isAdmin(env, userId)));
    return;
  }
  const pendingRef = await stateGet(env, `pending_ref:${userId}`);
  await stateDelete(env, `pending_ref:${userId}`);
  await completeRegistration(env, tgUser, pendingRef || null);
}

// ---------- هندل پیام ----------
// دستورات گروه گزارش (/setlog و ...) فقط توسط ادمین‌های ربات؛ بقیه‌ی پیام‌های گروه نادیده گرفته میشن
async function handleGroupMessage(env, message) {
  const text = (message.text || "").trim();
  const m = text.match(/^\/(setlog|unsetlog|logtest)(@\w+)?(\s|$)/i);
  if (!m) return;
  const chatId = message.chat.id;
  const threadExtra = message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
  if (!message.from || !isAdmin(env, message.from.id)) return;
  const cmd = m[1].toLowerCase();
  const cfg = await getLogCfg(env);
  if (cmd === "unsetlog") {
    if (String(cfg.chat_id) !== String(chatId)) return;
    await saveLogCfg(env, { chat_id: null, topics: {}, off: cfg.off });
    await sendMessage(env, chatId, "🔕 گزارش‌دهی به این گروه قطع شد.", threadExtra);
    return;
  }
  if (cmd === "logtest") {
    if (String(cfg.chat_id) !== String(chatId)) {
      await sendMessage(env, chatId, "این گروه هنوز به‌عنوان گروه گزارش تنظیم نشده. اول /setlog بفرست.", threadExtra);
      return;
    }
    for (const key of Object.keys(LOG_TOPICS)) await logEvent(env, key, `🧪 پیام تست — ${LOG_TOPICS[key].label}`);
    return;
  }
  // setlog: ثبت گروه + ساخت همه‌ی تاپیک‌ها
  const fresh = { chat_id: chatId, topics: {}, off: cfg.off };
  await saveLogCfg(env, fresh);
  let firstError = null;
  for (const key of Object.keys(LOG_TOPICS)) {
    const t = await ensureLogTopic(env, fresh, key);
    if (typeof t !== "number") {
      firstError = t?.error || "unknown";
      break;
    }
  }
  if (firstError) {
    await sendMessage(
      env,
      chatId,
      `✅ گروه به‌عنوان گروه گزارش ثبت شد، ولی ساخت تاپیک ناموفق بود:\n<code>${escapeHtml(firstError)}</code>\n\nبرای تاپیک‌بندی:\n۱) توی تنظیمات گروه گزینه‌ی <b>Topics</b> رو روشن کن (گروه باید سوپرگروه/فروم باشه)\n۲) ربات رو ادمین کن و دسترسی <b>Manage Topics</b> بده\n۳) دوباره /setlog بفرست\n\nتا اون موقع گزارش‌ها بدون تاپیک همینجا میان.`,
      threadExtra
    );
    return;
  }
  await sendMessage(env, chatId, "✅ گزارش‌دهی فعال شد و تاپیک‌ها ساخته شدن. از این به بعد تست رایگان، رسیدها، خریدها، شارژها، کاربران جدید و خطاها اینجا گزارش میشن.\n\n🧪 تست: /logtest\n🔕 قطع: /unsetlog", threadExtra);
}

async function handleMessage(env, message) {
  if (message.chat.type !== "private") {
    await handleGroupMessage(env, message);
    return;
  }
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || "").trim();

  const dbUser = await touchUser(env, message.from);
  if (dbUser.is_banned && !isAdmin(env, userId)) {
    await sendMessage(env, chatId, "🚫 دسترسی شما به ربات مسدود شده است.");
    return;
  }

  const cfg = await loadUiCfg(env);
  const mk = resolveMenuKey(cfg, text);

  // ---------- تایید قوانین (قبل از هر کاری) ----------
  const rulesNeeded = await needsRules(env, cfg, userId);
  if (rulesNeeded && !text.startsWith("/start") && !isAdmin(env, userId)) {
    await sendRules(env, chatId, cfg);
    return;
  }

  // ---------- لینک ورود به پنل وب (فقط ادمین‌ها) ----------
  if (isAdmin(env, userId) && /^\/panel(@\w+)?$/i.test(text)) {
    const link = await createLoginLink(env, userId);
    if (!link) {
      await sendMessage(env, chatId, "⚠️ آدرس عمومی Worker مشخص نیست. یک‌بار آدرس پنل رو توی مرورگر باز کن و دوباره /panel بزن.");
    } else {
      await sendMessage(
        env,
        chatId,
        `🖥 <b>پنل وب</b>\nلینک ورود یک‌بار مصرفه و ۵ دقیقه اعتبار داره:\n${link}`,
        { disable_web_page_preview: true }
      );
    }
    return;
  }

  // ورودی «متن دکمه» ادمین باید قبل از تشخیص منو بررسی بشه (وگرنه متن تکراری به‌جای چک، دکمه دیگه رو اجرا می‌کنه)
  if (isAdmin(env, userId) && !message.photo) {
    const rawA = await getAdminState(env, userId);
    if (rawA) {
      const stA = JSON.parse(rawA);
      if (stA.action === "ui_label") {
        await handleAdminStateInput(env, chatId, userId, text, stA, message);
        return;
      }
    }
  }

  // ---------- دکمه‌های خاموش ----------
  if (mk && mk !== "admin" && cfg.menu[mk]?.hidden) {
    await sendMessage(env, chatId, "⛔ این بخش فعلاً غیرفعاله.");
    return;
  }

  // ---------- عکس رسید ----------
  if (message.photo && message.photo.length) {
    const raw = await getUserState(env, userId);
    const st = raw ? JSON.parse(raw) : null;
    if (!st || st.action !== "awaiting_receipt") {
      await sendMessage(env, chatId, "الان منتظر رسیدی از شما نیستم. اول از منو گزینه مورد نظر رو انتخاب کن.");
      return;
    }
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(st.order_id).first();
    if (!order || order.user_id !== userId || order.status !== "awaiting_receipt") {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "این سفارش دیگه معتبر نیست.");
      return;
    }
    const fileId = message.photo[message.photo.length - 1].file_id;
    await env.DB.prepare("UPDATE orders SET status='pending', receipt_file_id=? WHERE id=?").bind(fileId, order.id).run();
    await clearUserState(env, userId);
    await sendMessage(env, chatId, "✅ رسید شما ارسال شد و در انتظار تایید ادمینه. نتیجه رو اینجا بهت اطلاع میدیم.");
    await notifyAdminsNewReceipt(env, { ...order, status: "pending" }, fileId);
    {
      const kindR = order.type === "topup" ? "شارژ کیف پول" : order.type === "renew" ? "تمدید" : "خرید";
      const pr = order.product_id ? await env.DB.prepare("SELECT name FROM products WHERE id=?").bind(order.product_id).first() : null;
      await logEvent(
        env,
        "receipt",
        `🧾 <b>رسید جدید — ${kindR}</b> (سفارش #${order.id})\n👤 ${await logUserTag(env, userId)}${pr ? `\n📦 ${escapeHtml(pr.name)}` : ""}\n💵 ${fmtMoney(order.amount)}\n⏳ در انتظار تایید ادمین`,
        { photo: fileId }
      );
    }
    return;
  }

  // ---------- /start ----------
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const refParam = parts[1] ? parts[1].trim() : null;
    const referrerId = refParam && /^\d+$/.test(refParam) ? refParam : null;

    if (rulesNeeded) {
      if (referrerId) await stateSet(env, `pending_ref:${userId}`, referrerId);
      await sendRules(env, chatId, cfg);
      return;
    }

    const { ok, missing } = await checkMembership(env, userId);
    if (!ok) {
      if (referrerId) await stateSet(env, `pending_ref:${userId}`, referrerId);
      await sendMessage(env, chatId, "برای استفاده از ربات، ابتدا عضو کانال(های) زیر بشید:", membershipKeyboard(missing));
      return;
    }
    if (dbUser.registered) {
      await sendMessage(env, chatId, "خوش برگشتی! از منوی زیر استفاده کن:", mainMenuKeyboard(isAdmin(env, userId)));
      return;
    }
    await completeRegistration(env, message.from, referrerId);
    return;
  }

  if (!dbUser.registered) {
    const { ok, missing } = await checkMembership(env, userId);
    if (!ok) {
      await sendMessage(env, chatId, "برای استفاده از ربات، ابتدا عضو کانال(های) زیر بشید:", membershipKeyboard(missing));
      return;
    }
  }

  // ---------- منوی کاربر ----------
  if (mk === "buy") {
    const { ok, missing } = await checkMembership(env, userId);
    if (!ok) {
      await sendMessage(env, chatId, "ابتدا عضو کانال(های) زیر بشید:", membershipKeyboard(missing));
      return;
    }
    const view = await buildBuyView(env);
    await sendMessage(env, chatId, view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
    return;
  }

  if (mk === "lookup") {
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM panels WHERE enabled=1").first())?.c || 0;
    if (!cnt) {
      await sendMessage(env, chatId, "این بخش هنوز راه‌اندازی نشده.");
      return;
    }
    await setUserState(env, userId, { action: "ext_name", ts: Date.now() });
    await sendMessage(env, chatId, "🔎 اسم اشتراکت (یوزرنیم) رو دقیقا همون‌طور که بهت داده شده بفرست (حروف بزرگ/کوچک مهمه):\n\nبرای لغو: /cancel");
    return;
  }

  if (mk === "renew") {
    // سرویس‌های پنلی: تمدید واقعی روی همون اکانت (محصول تست رایگان قابل تمدید نیست)
    const panelSvc = await env.DB.prepare(
      `SELECT o.id, o.panel_username, ${RENEW_COLS} FROM orders o JOIN products p ON p.id=o.product_id
       WHERE ${RENEW_WHERE} ORDER BY o.decided_at DESC LIMIT 10`
    ).bind(userId).all();
    // سرویس‌های دستی (کانفیگ ثابت): تمدید = خرید دوباره همون پلن
    const manual = await env.DB.prepare(
      `SELECT DISTINCT p.id, p.name, p.price FROM orders o JOIN products p ON p.id=o.product_id
       WHERE o.user_id=? AND o.type='purchase' AND o.status='approved' AND o.panel_id IS NULL
         AND p.enabled=1 AND p.is_trial=0 AND p.custom IS NULL`
    ).bind(userId).all();
    const rows = [];
    for (const o of panelSvc.results || []) {
      const plan = renewPlan(o);
      rows.push([{ text: `♻️ ${o.pname} #${String(o.panel_username).slice(-4)} — ${fmtMoney(plan.price)}`, callback_data: `renew:${o.id}` }]);
    }
    for (const pr of manual.results || []) {
      rows.push([{ text: `${pr.name} — ${fmtMoney(pr.price)}`, callback_data: `buy:${pr.id}` }]);
    }
    if (!rows.length) {
      await sendMessage(env, chatId, "شما هنوز سرویس قابل تمدیدی ندارید. اول از «🛍 خرید اشتراک» یه پلن بگیر.");
      return;
    }
    await sendMessage(env, chatId, "کدوم سرویس رو می‌خوای تمدید کنی؟", { reply_markup: { inline_keyboard: rows } });
    return;
  }

  if (mk === "trial") {
    const { ok, missing } = await checkMembership(env, userId);
    if (!ok) {
      await sendMessage(env, chatId, "ابتدا عضو کانال(های) زیر بشید:", membershipKeyboard(missing));
      return;
    }
    if (dbUser.used_trial) {
      await sendMessage(env, chatId, "شما قبلا از تست رایگان استفاده کردید.");
      return;
    }
    const trialProduct = await env.DB.prepare("SELECT * FROM products WHERE is_trial=1 AND enabled=1 LIMIT 1").first();
    if (!trialProduct) {
      await sendMessage(env, chatId, "فعلا تست رایگان فعال نیست.");
      return;
    }
    // قفل اتمیک: با کلیک سریع، فقط یک تست ساخته میشه
    const mark = await env.DB.prepare("UPDATE users SET used_trial=1 WHERE id=? AND used_trial=0").bind(userId).run();
    if (!(mark.meta && mark.meta.changes > 0)) {
      await sendMessage(env, chatId, "شما قبلا از تست رایگان استفاده کردید.");
      return;
    }
    const ins = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, created_at) VALUES (?,?,'purchase',0,'pending',?)"
    ).bind(userId, trialProduct.id, Date.now()).run();
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(ins.meta.last_row_id).first();
    const result = await fulfillPurchase(env, order);
    if (result.ok) {
      await logEvent(env, "trial", `🎁 <b>تست رایگان گرفته شد</b>\n👤 ${await logUserTag(env, userId)}\n📦 ${escapeHtml(trialProduct.name)}`);
    }
    if (!result.ok) {
      await env.DB.prepare("UPDATE users SET used_trial=0 WHERE id=?").bind(userId).run();
      await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(order.id).run();
      if (result.reason === "out_of_stock") {
        await sendMessage(env, chatId, "موجودی تست رایگان فعلا تموم شده.");
        await logEvent(env, "errors", `📭 موجودی تست رایگان تموم شده! (کاربر <code>${userId}</code> تست خواست)`);
      } else {
        await sendMessage(env, chatId, "فعلا امکان ساخت سرویس تست نیست. کمی بعد دوباره امتحان کن.");
        await notifyAdmins(env, `⚠️ خطا در ساخت تست رایگان برای کاربر ${userId}:\n${result.detail || result.reason}`);
      }
    }
    return;
  }

  if (mk === "wheel") {
    const now = Date.now();
    const last = dbUser.last_wheel_spin || 0;
    const dayMs = 24 * 60 * 60 * 1000;
    if (now - last < dayMs) {
      const remainH = Math.ceil((dayMs - (now - last)) / (60 * 60 * 1000));
      await sendMessage(env, chatId, `⏳ فردا دوباره امتحان کن! (${remainH} ساعت دیگه)`);
      return;
    }
    const prizes = await getWheelPrizes(env);
    const prize = pickWeighted(prizes);
    await env.DB.prepare("UPDATE users SET last_wheel_spin=?, wallet_balance=wallet_balance+? WHERE id=?")
      .bind(now, prize.amount || 0, userId).run();
    await sendMessage(
      env,
      chatId,
      `🎰 نتیجه گردونه: ${prize.label}\n${prize.amount > 0 ? `💰 ${fmtMoney(prize.amount)} به کیف پولت اضافه شد!` : "این بار شانس نداشتی، فردا دوباره امتحان کن."}`
    );
    return;
  }

  if (mk === "services") {
    const { results } = await env.DB.prepare(
      `SELECT o.*, p.name as pname FROM orders o LEFT JOIN products p ON p.id=o.product_id
       WHERE o.user_id=? AND o.type='purchase' AND o.status='approved' ORDER BY o.decided_at DESC LIMIT 10`
    ).bind(userId).all();
    const exts = (
      await env.DB.prepare("SELECT * FROM ext_services WHERE user_id=? AND (verified=1 OR ?=1) ORDER BY id DESC LIMIT 5")
        .bind(userId, cfg.ext_verify === false ? 1 : 0).all()
    ).results || [];
    if (!results.length && !exts.length) {
      await sendMessage(env, chatId, "هنوز هیچ سرویس فعالی نداری.");
      return;
    }
    // مصرف زنده از پنل (سقف تعداد، برای رد نشدن از محدودیت درخواست‌های Worker)
    const usages = await Promise.all(
      results.map(async (o, i) => {
        if (!o.panel_id || i >= 5) return null;
        try {
          const panel = await getPanel(env, o.panel_id);
          if (!panel) throw new Error("پنل پیدا نشد");
          return { ok: true, u: await panelUsage(panel, { username: o.panel_username, extra: safeJson(o.panel_extra) }) };
        } catch (e) {
          return { ok: false, err: e.message };
        }
      })
    );
    const extInfo = await Promise.all(
      exts.map(async (e) => {
        try {
          const panel = await getPanel(env, e.panel_id);
          if (!panel) throw new Error("پنل پیدا نشد");
          const found = await panelFindUser(panel, e.username);
          return found ? { ok: true, panel, found } : { ok: false };
        } catch {
          return { ok: false };
        }
      })
    );
    const blocks = results.map((o, i) => {
      const lines = [`📦 <b>${escapeHtml(o.pname || "-")}</b> — ${new Date(o.decided_at).toLocaleDateString("fa-IR")}`];
      const us = usages[i];
      if (us && us.ok) {
        lines.push(`📊 مصرف: ${fmtBytes(us.u.used)} از ${us.u.total ? fmtBytes(us.u.total) : "نامحدود"}`);
        lines.push(`⏳ انقضا: ${fmtExpire(us.u.expire)}`);
        if (us.u.status && us.u.status !== "active") lines.push(`⚠️ وضعیت: ${escapeHtml(us.u.status)}`);
      } else if (us) {
        lines.push("⚠️ دریافت مصرف از پنل ممکن نشد");
      }
      lines.push(`<code>${escapeHtml(o.config_text)}</code>`);
      return lines.join("\n");
    });
    exts.forEach((e, i) => {
      const x = extInfo[i];
      const lines = [`🔎 <b>${escapeHtml(e.username)}</b> (اشتراک قبلی)${x.ok ? ` — ${escapeHtml(x.panel.name)}` : ""}`];
      if (x.ok) {
        lines.push(`📊 مصرف: ${fmtBytes(x.found.used)} از ${x.found.total ? fmtBytes(x.found.total) : "نامحدود"}`);
        lines.push(`⏳ انقضا: ${fmtExpire(x.found.expire)}`);
        if (x.found.status !== "active") lines.push(`وضعیت: ${STATUS_FA[x.found.status] || escapeHtml(x.found.status)}`);
        if (x.found.subUrl) lines.push(`<code>${escapeHtml(x.found.subUrl)}</code>`);
      } else {
        lines.push("⚠️ دریافت اطلاعات از پنل ممکن نشد");
      }
      blocks.push(lines.join("\n"));
    });
    // دکمه‌های QR
    const qrRows = [];
    if (cfg.qr_enabled !== false) {
      for (const o of results) if (o.config_text && qrRows.length < 10) qrRows.push([{ text: `📲 QR ${o.pname || ""} #${o.id}`.slice(0, 40), callback_data: `qr:o:${o.id}` }]);
      exts.forEach((e, i) => {
        if (extInfo[i].ok && extInfo[i].found.subUrl && qrRows.length < 10) qrRows.push([{ text: `📲 QR ${e.username}`.slice(0, 40), callback_data: `qr:e:${e.id}` }]);
      });
    }
    // محدودیت طول پیام تلگرام (۴۰۹۶): در چند پیام می‌فرستیم؛ دکمه‌ها زیر آخرین پیام
    const chunks = [];
    let chunk = "";
    for (const b of blocks) {
      if (chunk && chunk.length + b.length > 3500) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += (chunk ? "\n\n" : "") + b;
    }
    if (chunk) chunks.push(chunk);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      await sendMessage(env, chatId, chunks[i], last && qrRows.length ? { reply_markup: { inline_keyboard: qrRows } } : {});
    }
    return;
  }

  if (mk === "wallet") {
    const presets = [50000, 100000, 200000, 500000];
    const rows = presets.map((a) => [{ text: fmtMoney(a), callback_data: `topup:${a}` }]);
    rows.push([{ text: "✏️ مبلغ دلخواه", callback_data: "topupcustom" }]);
    await sendMessage(env, chatId, `💰 موجودی فعلی کیف پول: ${fmtMoney(dbUser.wallet_balance)}\n\nچقدر می‌خوای شارژ کنی؟`, {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (mk === "referral") {
    const me = await tgCall(env, "getMe", {});
    const botUsername = me?.result?.username;
    const percent = await getSetting(env, "referral_percent", "10");
    await sendMessage(
      env,
      chatId,
      `🤝 لینک اختصاصی زیرمجموعه‌گیری شما:\nhttps://t.me/${botUsername}?start=${userId}\n\n👥 تعداد زیرمجموعه: ${dbUser.referral_count}\n💵 درصد کمیسیون شما از هر خرید: ${percent}%\n💰 موجودی کیف پول: ${fmtMoney(dbUser.wallet_balance)}`
    );
    return;
  }

  if (mk === "pricing") {
    const products = await listProducts(env);
    if (!products.length) {
      await sendMessage(env, chatId, "فعلا محصولی ثبت نشده.");
      return;
    }
    const lines = products.map((p) => {
      const c = customOf(p);
      if (c) {
        return `🧮 <b>${escapeHtml(p.name)}</b> (حجم دلخواه)\n📊 ${trimNum(c.min_gb)} تا ${trimNum(c.max_gb)} گیگ | ⏳ ${c.min_days} تا ${c.max_days} روز\n💵 هر گیگ ${fmtMoney(c.price_per_gb)}${c.price_per_day ? ` + هر روز ${fmtMoney(c.price_per_day)}` : ""}\n${escapeHtml(p.description || "")}`;
      }
      return `📦 <b>${escapeHtml(p.name)}</b>\n${fmtMoney(p.price)} — ${p.duration_days} روز\n${escapeHtml(p.description || "")}`;
    });
    await sendMessage(env, chatId, lines.join("\n\n"));
    return;
  }

  if (mk === "support") {
    const t = await getSetting(env, "support_text", "پشتیبانی هنوز توسط ادمین تنظیم نشده.");
    await sendMessage(env, chatId, t);
    return;
  }

  if (mk === "tutorial") {
    const t = await getSetting(env, "tutorial_text", "آموزش هنوز توسط ادمین تنظیم نشده.");
    await sendMessage(env, chatId, t);
    return;
  }

  if (mk === "admin" || text === "/admin") {
    if (!isAdmin(env, userId)) return;
    await sendMessage(env, chatId, "پنل مدیریت:", adminMainMenu());
    return;
  }

  // ---------- دستورات کانال اجباری (ادمین) ----------
  if (isAdmin(env, userId) && text.startsWith("/addchannel")) {
    const arg = text.replace("/addchannel", "").trim();
    if (!arg) {
      await sendMessage(env, chatId, "فرمت درست: /addchannel @channelusername");
      return;
    }
    await env.DB.prepare("INSERT INTO channels (ref, title) VALUES (?,?) ON CONFLICT(ref) DO NOTHING").bind(arg, arg).run();
    await sendMessage(env, chatId, `${arg} به عضویت اجباری اضافه شد.`);
    return;
  }
  if (isAdmin(env, userId) && text.startsWith("/delchannel")) {
    const arg = text.replace("/delchannel", "").trim();
    await env.DB.prepare("DELETE FROM channels WHERE ref=?").bind(arg).run();
    await sendMessage(env, chatId, `${arg} حذف شد.`);
    return;
  }
  if (isAdmin(env, userId) && text === "/channels") {
    const channels = await getChannels(env);
    await sendMessage(env, chatId, channels.length ? channels.map((c) => `• ${c.ref}`).join("\n") : "کانالی ثبت نشده.");
    return;
  }

  // ---------- روتینگ وضعیت چندمرحله‌ای ----------
  if (isAdmin(env, userId)) {
    const raw = await getAdminState(env, userId);
    if (raw) {
      await handleAdminStateInput(env, chatId, userId, text, JSON.parse(raw), message);
      return;
    }
  }
  const rawUS = await getUserState(env, userId);
  if (rawUS) {
    await handleUserStateInput(env, chatId, userId, text, JSON.parse(rawUS));
    return;
  }

  await sendMessage(env, chatId, "از منوی زیر استفاده کن:", mainMenuKeyboard(isAdmin(env, userId)));
}

// ---------- ورودی‌های چندمرحله‌ای کاربر عادی ----------
// ---------- اشتراک‌های خارج از ربات ----------
const STATUS_FA = { active: "فعال ✅", limited: "حجم تموم شده ⛔", expired: "منقضی شده ⛔", disabled: "غیرفعال ⛔", on_hold: "در انتظار شروع ⏸" };

// جلوگیری از حدس‌زدن اسم‌ها: حداکثر ۱۲ تلاش در هر ۱۰ دقیقه برای هر کاربر (ادمین مستثنا)
async function extRateOk(env, userId) {
  if (isAdmin(env, userId)) return true;
  const key = `ext_rl:${userId}`;
  const now = Date.now();
  let st = safeJson(await stateGet(env, key));
  if (!st.t || now - st.t > 10 * 60 * 1000) st = { t: now, n: 0 };
  st.n++;
  await stateSet(env, key, JSON.stringify(st));
  return st.n <= 12;
}
async function extSearch(env, name) {
  const { results } = await env.DB.prepare("SELECT * FROM panels WHERE enabled=1 ORDER BY id LIMIT 6").all();
  const hits = [];
  const errors = [];
  for (const row of results || []) {
    const panel = hydratePanel(row);
    try {
      const found = await panelFindUser(panel, name);
      if (found) hits.push({ panel, found });
    } catch (e) {
      errors.push(`${panel.name}: ${e.message}`);
    }
  }
  return { hits, errors };
}
async function getExtLookup(env, userId) {
  const st = safeJson(await stateGet(env, `ext_lookup:${userId}`));
  return st.ts && Date.now() - st.ts < 15 * 60 * 1000 && Array.isArray(st.items) ? st.items : null;
}
// نتیجه‌ی استعلام idx رو دوباره (تازه) از پنل می‌خونه
async function resolveExt(env, userId, idx) {
  const item = (await getExtLookup(env, userId))?.[idx];
  if (!item) return { error: "زمان این استعلام تموم شده؛ دوباره اسم اشتراک رو بفرست." };
  const panel = await getPanel(env, item.panel_id);
  if (!panel || !panel.enabled) return { error: "این پنل در دسترس نیست." };
  let found;
  try {
    found = await panelFindUser(panel, item.username);
  } catch (e) {
    return { error: e.message };
  }
  if (!found) return { error: "این اشتراک دیگه توی پنل پیدا نشد." };
  return { item, panel, found };
}
async function showExtDetails(env, chatId, idx, panel, found) {
  const remain = found.total ? Math.max(0, found.total - found.used) : null;
  const text = [
    `🔎 <b>${escapeHtml(found.username)}</b> — پنل: ${escapeHtml(panel.name)}`,
    `وضعیت: ${STATUS_FA[found.status] || escapeHtml(found.status)}`,
    `📊 مصرف: ${fmtBytes(found.used)} از ${found.total ? fmtBytes(found.total) : "نامحدود"}${remain !== null ? ` (باقی‌مانده: ${fmtBytes(remain)})` : ""}`,
    `⏳ انقضا: ${fmtExpire(found.expire)}`,
  ].join("\n");
  await sendMessage(env, chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "♻️ تمدید این اشتراک", callback_data: `xr:${idx}` }]] },
  });
}
const getExtBinding = (env, userId, panelId, username) =>
  env.DB.prepare("SELECT * FROM ext_services WHERE user_id=? AND panel_id=? AND username=?").bind(userId, panelId, username).first();
async function bindExt(env, userId, panelId, username, verified) {
  await env.DB.prepare(
    `INSERT INTO ext_services (user_id, panel_id, username, verified, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, panel_id, username) DO UPDATE SET verified = MAX(verified, excluded.verified)`
  ).bind(userId, panelId, username, verified ? 1 : 0, Date.now()).run();
  return getExtBinding(env, userId, panelId, username);
}
// آیا این کاربر مجازه لینک/تمدید این اشتراک رو بگیره؟
async function extAccess(env, cfg, userId, panel, found) {
  const verifyOn = cfg.ext_verify !== false;
  const b = await getExtBinding(env, userId, panel.id, found.username);
  if (b && (b.verified === 1 || !verifyOn)) return { allowed: true, ext: b };
  if (!verifyOn) return { allowed: true, ext: await bindExt(env, userId, panel.id, found.username, false) };
  if (!found.subUrl) return { allowed: false, noLink: true };
  return { allowed: false, needProof: true };
}
// ext فقط وقتی معتبره که مال همین کاربر باشه و (تایید‌شده باشه یا تایید مالکیت خاموش باشه)
async function loadExtForUser(env, cfg, userId, extId) {
  const ext = await env.DB.prepare("SELECT * FROM ext_services WHERE id=? AND user_id=?").bind(extId, userId).first();
  if (!ext) return null;
  return ext.verified === 1 || cfg.ext_verify === false ? ext : null;
}
async function showExtPlans(env, chatId, ext) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM products WHERE panel_id=? AND enabled=1 AND is_trial=0 ORDER BY (custom IS NOT NULL), price"
  ).bind(ext.panel_id).all();
  if (!results.length) {
    await sendMessage(env, chatId, "برای تمدید این اشتراک هنوز پلنی تعریف نشده؛ با پشتیبانی تماس بگیر.");
    return;
  }
  const rows = results.map((pr) =>
    pr.custom
      ? [{ text: `🧮 ${pr.name} — از ${fmtMoney(pr.price)}`, callback_data: `xz:${ext.id}:${pr.id}` }]
      : [{ text: `${pr.name} — ${fmtMoney(pr.price)}`, callback_data: `xq:${ext.id}:${pr.id}` }]
  );
  await sendMessage(env, chatId, `♻️ تمدید «${escapeHtml(ext.username)}» — یکی از پلن‌ها رو انتخاب کن:`, { reply_markup: { inline_keyboard: rows } });
}
async function extProceed(env, chatId, ext, panel, found) {
  await showExtPlans(env, chatId, ext);
}

// ---------- پرسش‌های خرید حجم دلخواه ----------
async function askCustomGb(env, chatId, userId, product, extId = null) {
  const c = customOf(product);
  await setUserState(env, userId, { action: "custom_gb", product_id: product.id, ext_id: extId, ts: Date.now() });
  const rows = chunk(
    pickPresets(c.min_gb, c.max_gb, NICE_GB).map((g) => ({ text: `${trimNum(g)} گیگ`, callback_data: extId ? `xg:${extId}:${product.id}:${trimNum(g)}` : `cgb:${product.id}:${trimNum(g)}` })),
    3
  );
  await sendMessage(
    env,
    chatId,
    `🧮 <b>${escapeHtml(product.name)}</b>\n${escapeHtml(product.description || "")}\n\n📊 حجم مورد نظرت رو بفرست (بین ${trimNum(c.min_gb)} تا ${trimNum(c.max_gb)} گیگ) یا یکی از گزینه‌ها رو بزن:\n💵 قیمت هر گیگ: ${fmtMoney(c.price_per_gb)}`,
    { reply_markup: { inline_keyboard: rows } }
  );
}
async function askCustomDays(env, chatId, userId, product, gb, extId = null) {
  const c = customOf(product);
  await setUserState(env, userId, { action: "custom_days", product_id: product.id, ext_id: extId, gb, ts: Date.now() });
  const rows = chunk(
    pickPresets(c.min_days, c.max_days, NICE_DAYS).map((d) => ({ text: `${d} روز`, callback_data: extId ? `xd:${extId}:${product.id}:${trimNum(gb)}:${d}` : `cdy:${product.id}:${trimNum(gb)}:${d}` })),
    3
  );
  await sendMessage(
    env,
    chatId,
    `✅ حجم: ${trimNum(gb)} گیگ\n\n⏳ مدت رو بفرست (بین ${c.min_days} تا ${c.max_days} روز) یا یکی از گزینه‌ها رو بزن:${c.price_per_day ? `\n💵 قیمت هر روز: ${fmtMoney(c.price_per_day)}` : ""}`,
    { reply_markup: { inline_keyboard: rows } }
  );
}
async function showCustomSummary(env, chatId, userId, product, gb, days, extId = null) {
  const c = customOf(product);
  const price = customPrice(c, gb, days);
  await clearUserState(env, userId);
  const extRow = extId ? await env.DB.prepare("SELECT username FROM ext_services WHERE id=? AND user_id=?").bind(extId, userId).first() : null;
  if (extId && !extRow) {
    await sendMessage(env, chatId, "این اشتراک معتبر نیست؛ دوباره از «استعلام/تمدید اشتراک قبلی» شروع کن.");
    return;
  }
  const wCb = extId ? `xv:${extId}:${product.id}:${trimNum(gb)}:${days}` : `cpw:${product.id}:${trimNum(gb)}:${days}`;
  const cCb = extId ? `xk:${extId}:${product.id}:${trimNum(gb)}:${days}` : `cpc:${product.id}:${trimNum(gb)}:${days}`;
  const head = extId ? `♻️ تمدید «${escapeHtml(extRow.username)}»\n` : "";
  const tail = extId ? "\n\nهمه‌چیز ریست میشه: مصرف صفر و مدت از امروز حساب میشه (روزهای باقی‌مانده‌ی قبلی اضافه نمیشن).\nروش پرداخت رو انتخاب کن:" : "\n\nروش پرداخت رو انتخاب کن:";
  const calc = `${trimNum(gb)} × ${fmtMoney(c.price_per_gb)}${c.price_per_day ? ` + ${days} × ${fmtMoney(c.price_per_day)}` : ""}`;
  await sendMessage(
    env,
    chatId,
    `${head}🧮 <b>${escapeHtml(product.name)}</b>\n📊 حجم: ${trimNum(gb)} گیگ\n⏳ مدت: ${days} روز\n\n💵 قیمت نهایی: <b>${fmtMoney(price)}</b>\n(${calc})${tail}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 پرداخت از کیف پول", callback_data: wCb }],
          [{ text: "💳 پرداخت کارت‌به‌کارت", callback_data: cCb }],
        ],
      },
    }
  );
}

// ---------- ورودی‌های چندمرحله‌ای کاربر عادی ----------
async function handleUserStateInput(env, chatId, userId, text, st) {
  if (text === "/cancel" || text === "❌ لغو") {
    await clearUserState(env, userId);
    await sendMessage(env, chatId, "لغو شد.");
    return;
  }
  if (st.action === "awaiting_topup_amount") {
    const amount = parseMoney(text);
    if (!amount || amount < 1000) {
      await sendMessage(env, chatId, "لطفا یه مبلغ معتبر (به تومان) بفرست. برای لغو: /cancel");
      return;
    }
    await clearUserState(env, userId);
    const now = Date.now();
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, created_at) VALUES (?,NULL,'topup',?,'awaiting_receipt',?)"
    ).bind(userId, amount, now).run();
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, amount);
    return;
  }
  if (st.action === "ext_name") {
    if (Date.now() - (st.ts || 0) > 15 * 60 * 1000) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "زمان این درخواست تموم شده. دوباره از منو شروع کن.");
      return;
    }
    const name = text.trim();
    if (!name || name.length > 64 || /\s/.test(name)) {
      await sendMessage(env, chatId, "اسم اشتراک باید بدون فاصله و حداکثر ۶۴ کاراکتر باشه. دوباره بفرست یا /cancel بزن.");
      return;
    }
    if (!(await extRateOk(env, userId))) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "تعداد تلاش‌ها زیاد بود؛ ۱۰ دقیقه دیگه دوباره امتحان کن.");
      return;
    }
    const { hits, errors } = await extSearch(env, name);
    if (!hits.length) {
      if (errors.length) {
        await clearUserState(env, userId);
        await sendMessage(env, chatId, "الان ارتباط با پنل برقرار نشد؛ کمی بعد دوباره امتحان کن.");
        await notifyAdmins(env, `⚠️ خطا در استعلام اشتراک (کاربر ${userId}):\n${errors.join("\n")}`);
      } else {
        await setUserState(env, userId, { action: "ext_name", ts: Date.now() });
        await sendMessage(env, chatId, "اشتراکی با این نام پیدا نشد. اسم رو دقیق (با همون حروف بزرگ/کوچک) بفرست یا /cancel بزن.");
      }
      return;
    }
    await clearUserState(env, userId);
    await stateSet(env, `ext_lookup:${userId}`, JSON.stringify({ ts: Date.now(), items: hits.map((h) => ({ panel_id: h.panel.id, username: h.found.username })) }));
    if (hits.length === 1) {
      await showExtDetails(env, chatId, 0, hits[0].panel, hits[0].found);
    } else {
      const rows = hits.map((h, i) => [{ text: `${h.found.username} — ${h.panel.name}`, callback_data: `xo:${i}` }]);
      await sendMessage(env, chatId, "این اسم روی چند پنل پیدا شد؛ کدوم مال توئه؟", { reply_markup: { inline_keyboard: rows } });
    }
    return;
  }
  if (st.action === "ext_proof") {
    if (Date.now() - (st.ts || 0) > 15 * 60 * 1000) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "زمان این درخواست تموم شده. دوباره از منو شروع کن.");
      return;
    }
    if (!(await extRateOk(env, userId))) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "تعداد تلاش‌ها زیاد بود؛ ۱۰ دقیقه دیگه دوباره امتحان کن.");
      return;
    }
    const r = await resolveExt(env, userId, st.idx);
    if (r.error) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, r.error);
      return;
    }
    if (!ownsSubscription(r.found, text)) {
      const tries = (st.tries || 0) + 1;
      if (tries >= 3) {
        await clearUserState(env, userId);
        await sendMessage(env, chatId, "۳ بار لینک اشتباه بود. از لینکی که توی برنامه‌ات وارد کردی کپی کن و دوباره از اول شروع کن.");
        return;
      }
      await setUserState(env, userId, { ...st, tries, ts: Date.now() });
      await sendMessage(env, chatId, `❌ این لینک با اشتراک «${escapeHtml(r.found.username)}» نمیخونه. لینک رو دقیق بفرست (یا /cancel).`);
      return;
    }
    await clearUserState(env, userId);
    const ext = await bindExt(env, userId, r.panel.id, r.found.username, true);
    await sendMessage(env, chatId, "✅ مالکیت اشتراک تایید شد.");
    await extProceed(env, chatId, ext, r.panel, r.found);
    return;
  }
  if (st.action === "custom_gb" || st.action === "custom_days") {
    if (Date.now() - (st.ts || 0) > 15 * 60 * 1000) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "زمان این انتخاب تموم شده. دوباره از «خرید اشتراک» شروع کن.");
      return;
    }
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(st.product_id).first();
    const c = customOf(product);
    if (!product || !c || !product.panel_id) {
      await clearUserState(env, userId);
      await sendMessage(env, chatId, "این محصول دیگه موجود نیست.");
      return;
    }
    if (st.action === "custom_gb") {
      const gb = parseNum(text);
      if (!(gb >= c.min_gb && gb <= c.max_gb)) {
        await sendMessage(env, chatId, `یه عدد بین ${trimNum(c.min_gb)} تا ${trimNum(c.max_gb)} (گیگ) بفرست. برای لغو: /cancel`);
        return;
      }
      await askCustomDays(env, chatId, userId, product, Math.round(gb * 100) / 100, st.ext_id || null);
      return;
    }
    const days = parseNum(text);
    if (!Number.isInteger(days) || days < c.min_days || days > c.max_days) {
      await sendMessage(env, chatId, `یه عدد صحیح بین ${c.min_days} تا ${c.max_days} (روز) بفرست. برای لغو: /cancel`);
      return;
    }
    await showCustomSummary(env, chatId, userId, product, st.gb, days, st.ext_id || null);
    return;
  }
}

// ---------- ورودی پنل‌ها ----------
const PANEL_ADD_HELP = {
  marzban:
    "🔌 افزودن Marzban — در یک پیام، فیلدها رو با | جدا کن (برای فیلد خالی - بذار):\n\n" +
    "نام | آدرس پنل | یوزرنیم | پسورد | آدرس ساب (اختیاری) | پروتکل‌ها (اختیاری) | flow (اختیاری)\n\n" +
    "مثال:\nمارزبان اصلی | https://panel.example.com | admin | pass123 | https://sub.example.com | vless | xtls-rprx-vision\n\n" +
    "• آدرس باید دامنه با SSL معتبر باشه (نه IP).\n• اگه پروتکل ندی، vless در نظر گرفته میشه.\n\nبرای لغو: /cancel",
  pasarguard:
    "🔌 افزودن PasarGuard — در یک پیام، فیلدها رو با | جدا کن (برای فیلد خالی - بذار):\n\n" +
    "نام | آدرس پنل | یوزرنیم | پسورد | آدرس ساب (اختیاری) | آیدی گروه‌ها (اختیاری) | flow (اختیاری)\n\n" +
    "مثال:\nپاسارگاد | https://pg.example.com | admin | pass123 | - | 1,2\n\n" +
    "• اگه گروه ندی، کاربر جدید در همه گروه‌ها ساخته میشه.\n• آدرس باید دامنه با SSL معتبر باشه (نه IP).\n\nبرای لغو: /cancel",
  sanaei:
    "🔌 افزودن 3x-ui (سنایی) — در یک پیام، فیلدها رو با | جدا کن (برای فیلد خالی - بذار):\n\n" +
    "نام | آدرس کامل پنل (با مسیر مخفی) | یوزرنیم | پسورد | آیدی اینباند | آدرس ساب | توکن API (اختیاری) | flow (اختیاری)\n\n" +
    "مثال:\nسنایی | https://xui.example.com/secretpath | admin | pass123 | 1 | https://sub.example.com:2096/sub\n\n" +
    "• «آدرس ساب» همون آدرسیه که توی تنظیمات پنل (Subscription) هست؛ لینک مشتری = آدرس ساب + / + subId.\n" +
    "• اگه از توکن API استفاده می‌کنی (نسخه‌های جدید)، یوزرنیم و پسورد رو - بذار.\n• آدرس باید دامنه با SSL معتبر باشه (نه IP).\n\nبرای لغو: /cancel",
};

function parsePanelInput(type, text) {
  const raw = text.split("|").map((x) => x.trim());
  const v = (i) => (!raw[i] || raw[i] === "-" ? "" : raw[i]);
  const name = v(0);
  const base_url = v(1).replace(/\/+$/, "");
  const username = v(2);
  const password = v(3);
  if (!name) return { error: "نام پنل الزامیه." };
  if (!/^https?:\/\//i.test(base_url)) return { error: "آدرس پنل باید با http:// یا https:// شروع بشه." };
  if (isIpHost(base_url)) {
    return { error: "آدرس پنل IP خامه. Cloudflare Workers اجازه اتصال مستقیم به IP نمیده (خطای 1003)؛ باید یه دامنه (با SSL) برای پنل بدی. می‌تونی از Cloudflare Tunnel یا Nginx/Caddy روی 443 استفاده کنی." };
  }
  const extra = {};
  let api_token = "";
  const protoOk = ["vless", "vmess", "trojan", "shadowsocks"];
  if (type === "marzban") {
    if (v(4)) extra.sub_base = v(4).replace(/\/+$/, "");
    if (v(5)) {
      extra.protocols = v(5).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (extra.protocols.some((x) => !protoOk.includes(x))) return { error: "پروتکل نامعتبره (فقط vless, vmess, trojan, shadowsocks)." };
    }
    if (v(6)) extra.flow = v(6);
  } else if (type === "pasarguard") {
    if (v(4)) extra.sub_base = v(4).replace(/\/+$/, "");
    if (v(5)) {
      extra.group_ids = v(5).split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0);
      if (!extra.group_ids.length) return { error: "آیدی گروه‌ها نامعتبره (مثل 1,2)." };
    }
    if (v(6)) extra.flow = v(6);
  } else {
    const inbound = parseInt(v(4), 10);
    if (!inbound) return { error: "آیدی اینباند (عدد) الزامیه." };
    extra.inbound_id = inbound;
    if (!/^https?:\/\//i.test(v(5))) return { error: "آدرس ساب (با http/https) الزامیه." };
    extra.sub_base = v(5).replace(/\/+$/, "");
    api_token = v(6);
    if (v(7)) extra.flow = v(7);
  }
  if (!api_token && (!username || !password)) return { error: "یوزرنیم و پسورد الزامیه (یا توکن API برای سنایی)." };
  return { name, base_url, username, password, api_token, extra };
}

// ---------- ورودی‌های چندمرحله‌ای پنل ادمین ----------
async function handleAdminStateInput(env, chatId, adminId, text, st, message) {
  if (text === "/cancel" || text === "❌ لغو") {
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "لغو شد.");
    return;
  }

  if (st.action === "add_product") {
    const parts = text.split("|").map((p) => p.trim());
    if (parts.length < 3) {
      await sendMessage(env, chatId, "فرمت درست نیست. اینطوری بفرست:\nنام محصول | قیمت (تومان) | مدت (روز) | توضیحات (اختیاری)");
      return;
    }
    const [name, priceStr, daysStr, ...descParts] = parts;
    const price = parseMoney(priceStr) || 0;
    const days = parseMoney(daysStr) || 30;
    const description = descParts.join(" | ") || "";
    await env.DB.prepare(
      "INSERT INTO products (name, price, duration_days, description, is_trial, enabled) VALUES (?,?,?,?,0,1)"
    ).bind(name, price, days, description).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `محصول «${name}» اضافه شد.`, adminMainMenu());
    return;
  }

  if (st.action === "add_category" || st.action === "rename_category") {
    const name = text.trim().slice(0, 40);
    if (!name) {
      await sendMessage(env, chatId, "اسم نمی‌تونه خالی باشه. دوباره بفرست یا /cancel بزن.");
      return;
    }
    try {
      await ensureCatSchema(env);
      if (st.action === "add_category") {
        await env.DB.prepare("INSERT INTO categories (name, enabled, sort_order, created_at) VALUES (?,1,0,?)").bind(name, Date.now()).run();
        await sendMessage(env, chatId, `دسته‌بندی «${escapeHtml(name)}» اضافه شد ✅\nحالا از «🛒 مدیریت محصولات ← 🗂 دسته‌بندی‌ها» محصولات یا یه پنل کامل رو بهش وصل کن.`, adminMainMenu());
      } else {
        await env.DB.prepare("UPDATE categories SET name=? WHERE id=?").bind(name, st.data).run();
        await sendMessage(env, chatId, `اسم دسته‌بندی به «${escapeHtml(name)}» تغییر کرد ✅`, adminMainMenu());
      }
      await clearAdminState(env, adminId);
    } catch (e) {
      await sendMessage(env, chatId, `⚠️ ذخیره نشد:\n<code>${escapeHtml(String(e?.message || e)).slice(0, 500)}</code>`);
    }
    return;
  }

  if (st.action === "add_config") {
    const productId = st.data;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      await sendMessage(env, chatId, "هیچ کانفیگی پیدا نشد. هر کانفیگ رو در یک خط بفرست.");
      return;
    }
    const stmt = env.DB.prepare("INSERT INTO configs (product_id, config_text, is_used) VALUES (?,?,0)");
    for (const l of lines) await stmt.bind(productId, l).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `${lines.length} کانفیگ اضافه شد.`, adminMainMenu());
    return;
  }

  if (st.action === "edit_product_price") {
    const price = parseMoney(text);
    if (!price) {
      await sendMessage(env, chatId, "لطفا فقط عدد قیمت جدید (تومان) رو بفرست.");
      return;
    }
    await env.DB.prepare("UPDATE products SET price=? WHERE id=?").bind(price, st.data).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "قیمت بروزرسانی شد.", adminMainMenu());
    return;
  }

  if (st.action === "add_custom_product") {
    const f = text.split("|").map((x) => x.trim());
    if (f.length < 6 || !f[0]) {
      await sendMessage(env, chatId, `❌ فیلدها کم‌ان.\n\n${CUSTOM_HELP}`);
      return;
    }
    const r = parseCustomFields(f.slice(1, 7));
    if (r.error) {
      await sendMessage(env, chatId, `❌ ${r.error}\n\n${CUSTOM_HELP}`);
      return;
    }
    const description = f.slice(7).join(" | ");
    const price = customPrice(r.c, r.c.min_gb, r.c.min_days);
    await env.DB.prepare(
      "INSERT INTO products (name, price, duration_days, description, is_trial, enabled, data_limit_gb, custom) VALUES (?,?,?,?,0,1,?,?)"
    ).bind(f[0], price, r.c.min_days, description, r.c.min_gb, JSON.stringify(r.c)).run();
    await clearAdminState(env, adminId);
    await sendMessage(
      env,
      chatId,
      `✅ محصول حجم دلخواه «${escapeHtml(f[0])}» ساخته شد.\nقیمت شروع: ${fmtMoney(price)}\n\n⚠️ مهم: از «🛒 مدیریت محصولات ← لیست محصولات ← این محصول ← 🔌 اتصال به پنل» به یه پنل وصلش کن؛ تا وصل نشه برای مشتری نمایش داده نمیشه.`,
      adminMainMenu()
    );
    return;
  }

  if (st.action === "set_custom") {
    const r = parseCustomFields(text.split("|").map((x) => x.trim()).slice(0, 6));
    if (r.error) {
      await sendMessage(env, chatId, `❌ ${r.error}\nدوباره بفرست یا /cancel بزن.`);
      return;
    }
    const price = customPrice(r.c, r.c.min_gb, r.c.min_days);
    await env.DB.prepare("UPDATE products SET custom=?, price=?, duration_days=?, data_limit_gb=? WHERE id=?")
      .bind(JSON.stringify(r.c), price, r.c.min_days, r.c.min_gb, st.data).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `✅ ذخیره شد. قیمت شروع: ${fmtMoney(price)}`, adminMainMenu());
    return;
  }

  if (st.action === "edit_product_gb") {
    const gb = parseNum(text);
    if (isNaN(gb)) {
      await sendMessage(env, chatId, "فقط عدد بفرست (0 = نامحدود).");
      return;
    }
    await env.DB.prepare("UPDATE products SET data_limit_gb=? WHERE id=?").bind(gb, st.data).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, gb > 0 ? `حجم روی ${gb} گیگ تنظیم شد.` : "حجم روی نامحدود تنظیم شد.", adminMainMenu());
    return;
  }

  if (st.action === "add_panel") {
    const parsed = parsePanelInput(st.data, text);
    // پیام حاوی رمز پنل رو از چت پاک می‌کنیم
    if (message && message.message_id) {
      try { await tgCall(env, "deleteMessage", { chat_id: chatId, message_id: message.message_id }); } catch {}
    }
    if (parsed.error) {
      await sendMessage(env, chatId, `❌ ${parsed.error}\n\nدوباره بفرست یا /cancel بزن.\n\n${PANEL_ADD_HELP[st.data]}`);
      return;
    }
    const ins = await env.DB.prepare(
      "INSERT INTO panels (name, type, base_url, username, password, api_token, extra, enabled) VALUES (?,?,?,?,?,?,?,1)"
    ).bind(parsed.name, st.data, parsed.base_url, parsed.username, parsed.password, parsed.api_token, JSON.stringify(parsed.extra)).run();
    await clearAdminState(env, adminId);
    const pn = await getPanel(env, ins.meta.last_row_id);
    let report;
    try {
      report = "✅ " + (await panelTest(pn));
    } catch (e) {
      report = "❌ " + e.message;
    }
    const port = customPort(parsed.base_url);
    const portWarn = port
      ? `\n\n⚠️ آدرس پورت ${port} داره. Cloudflare Workers ممکنه پورت‌های غیراستاندارد رو نادیده بگیره؛ اگه تست ناموفق بود پنل رو روی دامنه با پورت 443 (مثلا با Nginx/Caddy یا Cloudflare Tunnel) در دسترس بذار.`
      : "";
    await sendMessage(
      env,
      chatId,
      `🔌 پنل «${escapeHtml(parsed.name)}» (${PANEL_TYPES[st.data]}) ذخیره شد.\n\nنتیجه تست اتصال:\n${escapeHtml(report)}${portWarn}\n\n🔐 پیام حاوی رمز از چت پاک شد.\nبرای استفاده: «🛒 مدیریت محصولات» ← محصول ← «🔌 اتصال به پنل».`,
      adminMainMenu()
    );
    return;
  }

  if (st.action === "set_rules_text") {
    const cfg = await loadUiCfg(env);
    if (text.toLowerCase() === "default") {
      delete cfg.rules_text;
      await saveUiCfg(env, cfg);
      await clearAdminState(env, adminId);
      await sendMessage(env, chatId, "متن قوانین به پیش‌فرض برگشت.", adminMainMenu());
      return;
    }
    if (text.length < 5 || text.length > 3500) {
      await sendMessage(env, chatId, "متن باید بین ۵ تا ۳۵۰۰ کاراکتر باشه.");
      return;
    }
    // اعتبارسنجی فرمت HTML: اگه تلگرام نپذیره، ذخیره نمیشه (تا کاربرها گیر نکنن)
    const probe = await sendMessage(env, chatId, text);
    if (!probe.ok) {
      await sendMessage(env, chatId, `❌ متن نامعتبره (${probe.description || "خطای فرمت"}). تگ‌های HTML رو چک کن یا بدون تگ بفرست.`);
      return;
    }
    cfg.rules_text = text;
    await saveUiCfg(env, cfg);
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "✅ متن قوانین ذخیره شد (بالا همونیه که کاربرها می‌بینن).", adminMainMenu());
    return;
  }

  if (st.action === "set_rules_btn") {
    const cfg = await loadUiCfg(env);
    if (text.toLowerCase() === "default") {
      delete cfg.rules_btn;
    } else {
      if (text.length < 2 || text.length > 40) {
        await sendMessage(env, chatId, "متن دکمه باید بین ۲ تا ۴۰ کاراکتر باشه.");
        return;
      }
      cfg.rules_btn = text;
    }
    await saveUiCfg(env, cfg);
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "✅ ذخیره شد. پیش‌نمایش:", adminMainMenu());
    await sendRules(env, chatId, cfg, { preview: true });
    return;
  }

  if (st.action === "ui_label") {
    const label = text.trim();
    if (!label || label.length > 30 || label.startsWith("/")) {
      await sendMessage(env, chatId, "متن باید بین ۱ تا ۳۰ کاراکتر باشه و با / شروع نشه.");
      return;
    }
    const cfg = await loadUiCfg(env);
    for (const it of MENU_ITEMS) {
      if (it.key === st.data) continue;
      const c = cfg.menu[it.key];
      if (label === it.label || label === c?.label || (c?.aliases || []).includes(label)) {
        await sendMessage(env, chatId, "این متن برای یه دکمه‌ی دیگه استفاده شده. یه متن متفاوت بفرست.");
        return;
      }
    }
    const cur = cfg.menu[st.data] || {};
    const aliases = [...new Set([...(cur.aliases || []), cur.label].filter(Boolean))].filter((a) => a !== label);
    cfg.menu[st.data] = { ...cur, label, aliases };
    await saveUiCfg(env, cfg);
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "✅ متن دکمه تغییر کرد. منوی جدید (برای خودت):", mainMenuKeyboard(true));
    return;
  }

  if (st.action === "set_card") {
    const parts = text.split("|").map((p) => p.trim());
    await setSetting(env, "card_number", parts[0] || "");
    await setSetting(env, "card_holder", parts[1] || "");
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "شماره کارت بروزرسانی شد.", adminMainMenu());
    return;
  }

  if (st.action === "set_refpercent") {
    const p = parseNum(text);
    if (isNaN(p)) {
      await sendMessage(env, chatId, "فقط عدد درصد رو بفرست، مثلا: 10");
      return;
    }
    await setSetting(env, "referral_percent", String(p));
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `درصد کمیسیون روی ${p}% تنظیم شد.`, adminMainMenu());
    return;
  }

  if (st.action === "set_wheel") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const prizes = [];
    for (const l of lines) {
      const parts = l.split("|").map((p) => p.trim());
      if (parts.length < 3) continue;
      prizes.push({ label: parts[0], amount: parseInt(parts[1].replace(/[^\d]/g, ""), 10) || 0, weight: parseFloat(parts[2]) || 1 });
    }
    if (!prizes.length) {
      await sendMessage(env, chatId, "فرمت درست نیست. هر خط: برچسب | مبلغ | وزن\nمثال:\n🎉 ۵۰ هزار | 50000 | 5\n😢 پوچ | 0 | 50");
      return;
    }
    await setSetting(env, "wheel_prizes", JSON.stringify(prizes));
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `${prizes.length} جایزه برای گردونه تنظیم شد.`, adminMainMenu());
    return;
  }

  if (st.action === "set_support_text") {
    await setSetting(env, "support_text", text);
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "متن پشتیبانی بروزرسانی شد.", adminMainMenu());
    return;
  }
  if (st.action === "set_tutorial_text") {
    await setSetting(env, "tutorial_text", text);
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "متن آموزش بروزرسانی شد.", adminMainMenu());
    return;
  }

  if (st.action === "find_user") {
    if (!/^\d+$/.test(text)) {
      await sendMessage(env, chatId, "لطفا فقط آیدی عددی کاربر رو بفرست.");
      return;
    }
    const target = await getUser(env, text);
    if (!target) {
      await sendMessage(env, chatId, "کاربری با این آیدی پیدا نشد.");
      return;
    }
    await clearAdminState(env, adminId);
    const uname = target.username ? `@${target.username}` : target.first_name || "-";
    await sendMessage(
      env,
      chatId,
      `👤 ${uname}\nآیدی: ${target.id}\nکیف پول: ${fmtMoney(target.wallet_balance)}\nزیرمجموعه: ${target.referral_count}\nوضعیت: ${target.is_banned ? "مسدود 🚫" : "فعال ✅"}`,
      {
        reply_markup: {
          inline_keyboard: [
            [target.is_banned
              ? { text: "✅ آن‌بن", callback_data: `adm:unban:${target.id}` }
              : { text: "🚫 بن", callback_data: `adm:ban:${target.id}` }],
            [{ text: "💰 تغییر موجودی کیف پول", callback_data: `adm:walletadj:${target.id}` }],
            [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
          ],
        },
      }
    );
    return;
  }

  if (st.action === "wallet_adjust") {
    const amount = parseInt(normDigits(text).replace(/[^\-\d]/g, ""), 10);
    if (isNaN(amount)) {
      await sendMessage(env, chatId, "یه عدد بفرست (برای کم‌کردن، منفی بفرست، مثلا -20000).");
      return;
    }
    await env.DB.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?").bind(amount, st.data).run();
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, `موجودی کیف پول کاربر ${st.data} به مقدار ${amount} تغییر کرد.`, adminMainMenu());
    return;
  }

  if (st.action === "broadcast") {
    await clearAdminState(env, adminId);
    const { results } = await env.DB.prepare("SELECT id FROM users WHERE registered=1").all();
    let success = 0, fail = 0;
    for (const u of results) {
      try {
        const r = await sendMessage(env, u.id, text, mainMenuKeyboard(isAdmin(env, u.id)));
        if (r.ok) success++; else fail++;
      } catch { fail++; }
    }
    await sendMessage(env, chatId, `📢 ارسال شد.\n✅ موفق: ${success}\n❌ ناموفق: ${fail}`, adminMainMenu());
    return;
  }
}

// ---------- پرداخت از کیف پول (کسر اتمیک + برگشت پول در صورت خطا) ----------
async function payFromWallet(env, cq, userId, { type, productId, amount, renewOf, gb = null, days = null, extId = null }) {
  const debit = await env.DB.prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=? AND wallet_balance >= ?")
    .bind(amount, userId, amount).run();
  if (!(debit.meta && debit.meta.changes > 0)) {
    await answerCallback(env, cq.id, "موجودی کیف پول کافی نیست.", true);
    return;
  }
  const refund = () => env.DB.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?").bind(amount, userId).run();
  let order;
  try {
    const ins = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, renew_of, gb, days, ext_id, created_at) VALUES (?,?,?,?,'pending',?,?,?,?,?)"
    ).bind(userId, productId, type, amount, renewOf, gb, days, extId, Date.now()).run();
    order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(ins.meta.last_row_id).first();
  } catch (e) {
    await refund();
    throw e;
  }
  const result = await fulfillOrder(env, order);
  if (!result.ok) {
    await refund();
    await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(order.id).run();
    if (result.reason === "out_of_stock") {
      await answerCallback(env, cq.id, "موجودی کانفیگ تموم شده، مبلغ به کیف پولت برگشت.", true);
    } else {
      await answerCallback(env, cq.id, "خطا در ساخت/تمدید سرویس. مبلغ به کیف پولت برگشت؛ به ادمین اطلاع داده شد.", true);
      await notifyAdmins(env, `⚠️ خرید با کیف پول برای کاربر ${userId} ناموفق بود (مبلغ برگشت داده شد):\n${result.detail || result.reason}`);
    }
    return;
  }
  await answerCallback(env, cq.id, type === "renew" ? "✅ تمدید شد!" : "✅ خرید موفق بود!");
}

// ---------- هندل callback ----------
async function handleCallback(env, cq) {
  const userId = cq.from.id;
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data;

  if (data === "noop") {
    await answerCallback(env, cq.id, "");
    return;
  }

  if (!isAdmin(env, userId)) {
    const du = await getUser(env, userId);
    if (du && du.is_banned) {
      await answerCallback(env, cq.id, "🚫 دسترسی شما به ربات مسدود شده است.", true);
      return;
    }
  }

  if (data === "rules_ok") {
    await stateSet(env, `rules_ok:${userId}`, String(Date.now()));
    await answerCallback(env, cq.id, "✅ قوانین پذیرفته شد");
    await tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    await continueStart(env, cq.from, chatId);
    return;
  }
  if (!isAdmin(env, userId)) {
    const cfgR = await loadUiCfg(env);
    if (await needsRules(env, cfgR, userId)) {
      await answerCallback(env, cq.id, "ابتدا باید قوانین رو بپذیری.", true);
      await sendRules(env, chatId, cfgR);
      return;
    }
  }

  // ---------- دکمه‌های خاموش (برای callback های قدیمی هم) ----------
  {
    const offKey = /^(buy|buycat|buycats|paywallet|paycard|cgb|cdy|cpw|cpc)(:|$)/.test(data) ? "buy"
      : /^(xo|xr|xp|xq|xw|xc|xz|xg|xd|xv|xk):/.test(data) ? "lookup"
      : /^qr:/.test(data) ? "services"
      : /^(renew|renewwallet|renewcard):/.test(data) ? "renew"
      : /^topup(custom)?(:|$)/.test(data) ? "wallet"
      : data === "tutorial" ? "tutorial" : null;
    if (offKey) {
      const cfgO = await loadUiCfg(env);
      if (cfgO.menu[offKey]?.hidden) {
        await answerCallback(env, cq.id, "⛔ این بخش فعلاً غیرفعاله.", true);
        return;
      }
    }
  }

  if (data === "check_membership") {
    const { ok, missing } = await checkMembership(env, userId);
    if (!ok) {
      await answerCallback(env, cq.id, "هنوز عضو همه کانال‌ها نشدی!", true);
      await editMessageText(env, chatId, messageId, "هنوز عضو کانال(های) زیر نیستی:", membershipKeyboard(missing));
      return;
    }
    await answerCallback(env, cq.id, "عضویت تایید شد ✅");
    const dbUser = await getUser(env, userId);
    if (dbUser && dbUser.registered) {
      await editMessageText(env, chatId, messageId, "عضویت تایید شد ✅");
      await sendMessage(env, chatId, "از منوی زیر استفاده کن:", mainMenuKeyboard(isAdmin(env, userId)));
      return;
    }
    const pendingRef = await stateGet(env, `pending_ref:${userId}`);
    await stateDelete(env, `pending_ref:${userId}`);
    await editMessageText(env, chatId, messageId, "عضویت تایید شد ✅");
    await completeRegistration(env, cq.from, pendingRef || null);
    return;
  }

  // ---------- خرید / تمدید ----------
  if (data === "tutorial") {
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, await getSetting(env, "tutorial_text", "آموزش هنوز توسط ادمین تنظیم نشده."));
    return;
  }

  if (data === "buycats" || data.startsWith("buycat:")) {
    const view = await buildBuyView(env, data === "buycats" ? null : parseInt(data.split(":")[1], 10) || 0);
    await answerCallback(env, cq.id, "");
    await editMessageText(env, chatId, messageId, view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
    return;
  }

  if (data.startsWith("buy:")) {
    const productId = data.split(":")[1];
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();
    if (!product) {
      await answerCallback(env, cq.id, "این محصول دیگه موجود نیست.", true);
      return;
    }
    if (product.custom) {
      if (!product.panel_id) {
        await answerCallback(env, cq.id, "این محصول فعلا قابل خرید نیست.", true);
        return;
      }
      await answerCallback(env, cq.id, "");
      await askCustomGb(env, chatId, userId, product);
      return;
    }
    if (!product.panel_id) {
      const stock = await configStock(env, productId);
      if (stock.avail < 1) {
        await answerCallback(env, cq.id, "موجودی این محصول تموم شده.", true);
        return;
      }
    }
    await answerCallback(env, cq.id, "");
    const gbLine = product.panel_id ? `\n📊 حجم: ${product.data_limit_gb > 0 ? product.data_limit_gb + " گیگ" : "نامحدود"}` : "";
    await sendMessage(
      env,
      chatId,
      `📦 <b>${escapeHtml(product.name)}</b>\n💵 قیمت: ${fmtMoney(product.price)}\n⏳ مدت: ${product.duration_days} روز${gbLine}\n${escapeHtml(product.description || "")}\n\nروش پرداخت رو انتخاب کن:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 پرداخت از کیف پول", callback_data: `paywallet:${productId}` }],
            [{ text: "💳 پرداخت کارت‌به‌کارت", callback_data: `paycard:${productId}` }],
          ],
        },
      }
    );
    return;
  }

  if (data.startsWith("paywallet:")) {
    const productId = data.split(":")[1];
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();
    if (!product) {
      await answerCallback(env, cq.id, "این محصول دیگه موجود نیست.", true);
      return;
    }
    if (product.custom) {
      await answerCallback(env, cq.id, "این محصول عوض شده؛ دوباره از «خرید اشتراک» شروع کن.", true);
      return;
    }
    await payFromWallet(env, cq, userId, { type: "purchase", productId: product.id, amount: product.price, renewOf: null });
    return;
  }

  if (data.startsWith("paycard:")) {
    const productId = data.split(":")[1];
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(productId).first();
    if (!product) {
      await answerCallback(env, cq.id, "این محصول دیگه موجود نیست.", true);
      return;
    }
    if (product.custom) {
      await answerCallback(env, cq.id, "این محصول عوض شده؛ دوباره از «خرید اشتراک» شروع کن.", true);
      return;
    }
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, created_at) VALUES (?,?,'purchase',?,'awaiting_receipt',?)"
    ).bind(userId, productId, product.price, Date.now()).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, product.price);
    return;
  }

  // ---------- QR کد سرویس‌های من ----------
  if (/^qr:(o|e):\d+$/.test(data)) {
    const [, kind, id] = data.split(":");
    const cfgQ = await loadUiCfg(env);
    if (cfgQ.qr_enabled === false) {
      await answerCallback(env, cq.id, "ارسال QR خاموشه.", true);
      return;
    }
    if (kind === "o") {
      const o = await env.DB.prepare(
        "SELECT o.config_text, p.name as pname FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.user_id=? AND o.type='purchase' AND o.status='approved'"
      ).bind(id, userId).first();
      if (!o || !o.config_text) {
        await answerCallback(env, cq.id, "این سرویس پیدا نشد.", true);
        return;
      }
      await answerCallback(env, cq.id, "");
      const r = await sendQrPhoto(env, chatId, o.config_text, `📲 QR کد «${escapeHtml(o.pname || "-")}»`);
      if (!r || !r.ok) await sendMessage(env, chatId, "ساخت QR ممکن نشد؛ لینک رو دستی کپی کن.");
      return;
    }
    const ext = await loadExtForUser(env, cfgQ, userId, id);
    const panel = ext ? await getPanel(env, ext.panel_id) : null;
    if (!ext || !panel) {
      await answerCallback(env, cq.id, "این اشتراک پیدا نشد.", true);
      return;
    }
    await answerCallback(env, cq.id, "");
    let found = null;
    try {
      found = await panelFindUser(panel, ext.username);
    } catch {
      // پایین پیام خطا میدیم
    }
    if (!found || !found.subUrl) {
      await sendMessage(env, chatId, "دریافت لینک از پنل ممکن نشد؛ کمی بعد دوباره امتحان کن.");
      return;
    }
    const r = await sendQrPhoto(env, chatId, found.subUrl, `📲 QR کد «${escapeHtml(found.username)}»`);
    if (!r || !r.ok) await sendMessage(env, chatId, "ساخت QR ممکن نشد؛ لینک رو دستی کپی کن.");
    return;
  }

  // ---------- اشتراک‌های خارج از ربات ----------
  if (/^(xo|xr):\d+$/.test(data)) {
    const [kind, idxS] = data.split(":");
    const idx = parseInt(idxS, 10);
    const cfgX = await loadUiCfg(env);
    const r = await resolveExt(env, userId, idx);
    if (r.error) {
      await answerCallback(env, cq.id, r.error.slice(0, 190), true);
      return;
    }
    if (kind === "xo") {
      await answerCallback(env, cq.id, "");
      await showExtDetails(env, chatId, idx, r.panel, r.found);
      return;
    }
    const acc = await extAccess(env, cfgX, userId, r.panel, r.found);
    if (acc.noLink) {
      await answerCallback(env, cq.id, "این اشتراک لینک ساب نداره و تایید مالکیت ممکن نیست؛ با پشتیبانی تماس بگیر.", true);
      return;
    }
    if (acc.needProof) {
      await setUserState(env, userId, { action: "ext_proof", idx, purpose: "r", tries: 0, ts: Date.now() });
      await answerCallback(env, cq.id, "");
      await sendMessage(
        env,
        chatId,
        "🔐 برای امنیت، لینک اشتراک فعلیت رو (همونی که توی برنامه وارد کردی) همینجا بفرست تا مطمئن بشیم صاحب این اشتراکی.\n\nبرای لغو: /cancel"
      );
      return;
    }
    await answerCallback(env, cq.id, "");
    await extProceed(env, chatId, acc.ext, r.panel, r.found);
    return;
  }
  if (/^(xq|xw|xc):\d+:\d+$/.test(data)) {
    const [kind, extIdS, pidS] = data.split(":");
    const cfgX = await loadUiCfg(env);
    const ext = await loadExtForUser(env, cfgX, userId, extIdS);
    const product = ext
      ? await env.DB.prepare("SELECT * FROM products WHERE id=? AND panel_id=? AND enabled=1 AND is_trial=0 AND custom IS NULL").bind(pidS, ext.panel_id).first()
      : null;
    if (!ext || !product) {
      await answerCallback(env, cq.id, "این گزینه معتبر نیست؛ دوباره از اول شروع کن.", true);
      return;
    }
    if (kind === "xq") {
      await answerCallback(env, cq.id, "");
      await sendMessage(
        env,
        chatId,
        `♻️ تمدید «${escapeHtml(ext.username)}»\n📦 ${escapeHtml(product.name)}\n💵 مبلغ: ${fmtMoney(product.price)}\n⏳ ${product.duration_days} روز | 📊 ${product.data_limit_gb > 0 ? trimNum(product.data_limit_gb) + " گیگ" : "نامحدود"}\n\nهمه‌چیز ریست میشه: مصرف صفر و مدت از امروز حساب میشه (روزهای باقی‌مانده‌ی قبلی اضافه نمیشن).\nروش پرداخت رو انتخاب کن:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 پرداخت از کیف پول", callback_data: `xw:${ext.id}:${product.id}` }],
              [{ text: "💳 پرداخت کارت‌به‌کارت", callback_data: `xc:${ext.id}:${product.id}` }],
            ],
          },
        }
      );
      return;
    }
    const gb = product.data_limit_gb || 0;
    const days = product.duration_days || 0;
    if (kind === "xw") {
      await payFromWallet(env, cq, userId, { type: "renew", productId: product.id, amount: product.price, renewOf: null, gb, days, extId: ext.id });
      return;
    }
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, gb, days, ext_id, created_at) VALUES (?,?,'renew',?,'awaiting_receipt',?,?,?,?)"
    ).bind(userId, product.id, product.price, gb, days, ext.id, Date.now()).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, product.price);
    return;
  }

  // ---------- تمدید اشتراک قبلی با حجم دلخواه ----------
  if (/^(xz|xg|xd|xv|xk):\d+:\d+/.test(data)) {
    const [kind, extIdS, pidS, gbS, daysS] = data.split(":");
    const cfgX = await loadUiCfg(env);
    const ext = await loadExtForUser(env, cfgX, userId, extIdS);
    const product = ext
      ? await env.DB.prepare("SELECT * FROM products WHERE id=? AND panel_id=? AND enabled=1 AND is_trial=0 AND custom IS NOT NULL").bind(pidS, ext.panel_id).first()
      : null;
    const c = customOf(product);
    if (!ext || !product || !c) {
      await answerCallback(env, cq.id, "این گزینه معتبر نیست؛ دوباره از اول شروع کن.", true);
      return;
    }
    if (kind === "xz") {
      await answerCallback(env, cq.id, "");
      await askCustomGb(env, chatId, userId, product, ext.id);
      return;
    }
    const gb = parseNum(gbS);
    if (kind === "xg") {
      if (!(gb >= c.min_gb && gb <= c.max_gb)) {
        await answerCallback(env, cq.id, "مقدار نامعتبره؛ دوباره شروع کن.", true);
        return;
      }
      await answerCallback(env, cq.id, "");
      await askCustomDays(env, chatId, userId, product, gb, ext.id);
      return;
    }
    const days = parseInt(daysS, 10);
    if (!customValid(c, gb, days)) {
      await answerCallback(env, cq.id, "مقدار نامعتبره یا تنظیمات محصول عوض شده؛ دوباره شروع کن.", true);
      return;
    }
    if (kind === "xd") {
      await answerCallback(env, cq.id, "");
      await showCustomSummary(env, chatId, userId, product, gb, days, ext.id);
      return;
    }
    const price = customPrice(c, gb, days); // قیمت همیشه در لحظه‌ی پرداخت دوباره حساب میشه
    if (kind === "xv") {
      await payFromWallet(env, cq, userId, { type: "renew", productId: product.id, amount: price, renewOf: null, gb, days, extId: ext.id });
      return;
    }
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, gb, days, ext_id, created_at) VALUES (?,?,'renew',?,'awaiting_receipt',?,?,?,?)"
    ).bind(userId, product.id, price, gb, days, ext.id, Date.now()).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, price);
    return;
  }

  // ---------- محصول حجم دلخواه ----------
  if (/^(cgb|cdy|cpw|cpc):/.test(data)) {
    const [kind, pid, gbS, daysS] = data.split(":");
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND enabled=1 AND is_trial=0").bind(pid).first();
    const c = customOf(product);
    if (!product || !c || !product.panel_id) {
      await answerCallback(env, cq.id, "این محصول دیگه موجود نیست.", true);
      return;
    }
    const gb = parseNum(gbS);
    if (kind === "cgb") {
      if (!(gb >= c.min_gb && gb <= c.max_gb)) {
        await answerCallback(env, cq.id, "مقدار نامعتبره؛ دوباره از خرید شروع کن.", true);
        return;
      }
      await answerCallback(env, cq.id, "");
      await askCustomDays(env, chatId, userId, product, gb);
      return;
    }
    const days = parseInt(daysS, 10);
    if (!customValid(c, gb, days)) {
      await answerCallback(env, cq.id, "مقدار نامعتبره یا تنظیمات محصول عوض شده؛ دوباره از خرید شروع کن.", true);
      return;
    }
    if (kind === "cdy") {
      await answerCallback(env, cq.id, "");
      await showCustomSummary(env, chatId, userId, product, gb, days);
      return;
    }
    const price = customPrice(c, gb, days); // قیمت همیشه در لحظه‌ی پرداخت دوباره حساب میشه
    if (kind === "cpw") {
      await payFromWallet(env, cq, userId, { type: "purchase", productId: product.id, amount: price, renewOf: null, gb, days });
      return;
    }
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, gb, days, created_at) VALUES (?,?,'purchase',?,'awaiting_receipt',?,?,?)"
    ).bind(userId, product.id, price, gb, days, Date.now()).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, price);
    return;
  }

  // ---------- تمدید واقعی سرویس پنلی ----------
  if (data.startsWith("renew:") || data.startsWith("renewwallet:") || data.startsWith("renewcard:")) {
    const [kind, orderId] = data.split(":");
    const base = await env.DB.prepare(
      `SELECT o.id, o.product_id, ${RENEW_COLS} FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=? AND ${RENEW_WHERE}`
    ).bind(orderId, userId).first();
    if (!base) {
      await answerCallback(env, cq.id, "این سرویس قابل تمدید نیست.", true);
      return;
    }
    const plan = renewPlan(base);
    if (kind === "renew") {
      await answerCallback(env, cq.id, "");
      await sendMessage(
        env,
        chatId,
        `♻️ تمدید «${escapeHtml(base.pname)}»\n💵 مبلغ: ${fmtMoney(plan.price)}\n⏳ ${plan.days} روز | 📊 ${plan.gb > 0 ? trimNum(plan.gb) + " گیگ" : "نامحدود"}\n\nهمه‌چیز ریست میشه: مصرف صفر و مدت از امروز حساب میشه (روزهای باقی‌مانده‌ی قبلی اضافه نمیشن).\nروش پرداخت رو انتخاب کن:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 پرداخت از کیف پول", callback_data: `renewwallet:${base.id}` }],
              [{ text: "💳 پرداخت کارت‌به‌کارت", callback_data: `renewcard:${base.id}` }],
            ],
          },
        }
      );
      return;
    }
    if (kind === "renewwallet") {
      await payFromWallet(env, cq, userId, { type: "renew", productId: base.product_id, amount: plan.price, renewOf: base.id, gb: plan.gb, days: plan.days });
      return;
    }
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, renew_of, gb, days, created_at) VALUES (?,?,'renew',?,'awaiting_receipt',?,?,?,?)"
    ).bind(userId, base.product_id, plan.price, base.id, plan.gb, plan.days, Date.now()).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, plan.price);
    return;
  }

  // ---------- شارژ کیف پول ----------
  if (data.startsWith("topup:")) {
    const amount = parseInt(data.split(":")[1], 10);
    const now = Date.now();
    const res = await env.DB.prepare(
      "INSERT INTO orders (user_id, product_id, type, amount, status, created_at) VALUES (?,NULL,'topup',?,'awaiting_receipt',?)"
    ).bind(userId, amount, now).run();
    await answerCallback(env, cq.id, "");
    await startCardPayment(env, chatId, userId, res.meta.last_row_id, amount);
    return;
  }
  if (data === "topupcustom") {
    await setUserState(env, userId, { action: "awaiting_topup_amount" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "مبلغ دلخواه رو به تومان بفرست (فقط عدد). برای لغو: /cancel");
    return;
  }

  // ---------- پنل ادمین ----------
  if (data.startsWith("adm:")) {
    if (!isAdmin(env, userId)) return;
    await handleAdminCallback(env, cq, chatId, messageId, userId, data);
    return;
  }
}

// ---------- نماهای شخصی‌سازی ----------
function uiItemView(cfg, key) {
  const c = cfg.menu[key] || {};
  const style = menuStyle(cfg, key);
  const text =
    `🎛 دکمه: <b>${escapeHtml(menuLabel(cfg, key))}</b>\n` +
    `رنگ: ${COLOR_EMOJI[style]} ${COLOR_NAME[style]}\n` +
    `وضعیت: ${c.hidden ? "خاموش 🔴 (از منو برداشته شده و کار نمی‌کنه)" : "روشن 🟢"}`;
  const sw = (st) => ({ text: `${COLOR_EMOJI[st]} ${COLOR_NAME[st]}`, callback_data: `adm:uic:${key}:${st}`, style: st });
  const rows = [
    [{ text: "✏️ تغییر متن دکمه", callback_data: `adm:uil:${key}` }],
    [sw("primary"), sw("success")],
    [sw("danger"), sw("none")],
  ];
  if (key !== "admin") rows.push([{ text: c.hidden ? "🟢 روشن کن" : "🔴 خاموش کن", callback_data: `adm:uih:${key}` }]);
  rows.push([{ text: "↩️ بازگشت به پیش‌فرض", callback_data: `adm:uir:${key}` }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "adm:ui_menu" }]);
  return { text, markup: { reply_markup: { inline_keyboard: rows } } };
}
function uiRolesView(cfg) {
  const roleName = { primary: "دکمه‌های عادی", success: "تایید / پرداخت", danger: "رد / حذف / بن" };
  const cur = (r) => cfg.roles[r] || r;
  const text =
    "🎨 رنگ دکمه‌های شیشه‌ای (دکمه‌های زیر پیام‌ها)\n\n" +
    Object.keys(roleName).map((r) => `• ${roleName[r]}: ${COLOR_EMOJI[cur(r)]} ${COLOR_NAME[cur(r)]}`).join("\n");
  const rows = [];
  for (const r of Object.keys(roleName)) {
    rows.push([{ text: `— ${roleName[r]} —`, callback_data: "noop", style: "none" }]);
    rows.push(VALID_STYLES.map((st) => ({ text: COLOR_EMOJI[st], callback_data: `adm:uirs:${r}:${st}`, style: st })));
  }
  rows.push([{ text: "↩️ بازگشت به پیش‌فرض", callback_data: "adm:uirs:reset:x" }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "adm:ui" }]);
  return { text, markup: { reply_markup: { inline_keyboard: rows } } };
}

// ---------- callback های پنل ادمین ----------
async function handleAdminCallback(env, cq, chatId, messageId, adminId, data) {
  const parts = data.split(":");
  const action = parts[1];

  if (action === "main") {
    await editMessageText(env, chatId, messageId, "پنل مدیریت:", adminMainMenu());
    return;
  }

  // ---- گروه گزارش ----
  if (action === "log" || action === "logt" || action === "logtest" || action === "logdisc") {
    let cfg = await getLogCfg(env);
    if (action === "logt") {
      const key = parts[2];
      if (!LOG_TOPICS[key]) return;
      cfg.off = cfg.off.includes(key) ? cfg.off.filter((k) => k !== key) : [...cfg.off, key];
      await saveLogCfg(env, cfg);
      await answerCallback(env, cq.id, "ذخیره شد ✅");
    } else if (action === "logtest") {
      if (!cfg.chat_id) {
        await answerCallback(env, cq.id, "هنوز گروهی وصل نشده.", true);
        return;
      }
      for (const key of Object.keys(LOG_TOPICS)) await logEvent(env, key, `🧪 پیام تست — ${LOG_TOPICS[key].label}`);
      await answerCallback(env, cq.id, "پیام تست ارسال شد.");
    } else if (action === "logdisc") {
      cfg = { chat_id: null, topics: {}, off: cfg.off };
      await saveLogCfg(env, cfg);
      await answerCallback(env, cq.id, "قطع شد.");
    }
    const rows = Object.entries(LOG_TOPICS).map(([key, d]) => [{ text: `${cfg.off.includes(key) ? "🔴" : "🟢"} ${d.label}`, callback_data: `adm:logt:${key}` }]);
    if (cfg.chat_id) {
      rows.push([{ text: "🧪 ارسال پیام تست", callback_data: "adm:logtest" }]);
      rows.push([{ text: "🔌 قطع اتصال گروه", callback_data: "adm:logdisc" }]);
    }
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:main" }]);
    await editMessageText(
      env,
      chatId,
      messageId,
      "📣 <b>گروه گزارش</b>\n" +
        (cfg.chat_id ? `وضعیت: متصل 🟢 (<code>${cfg.chat_id}</code>)` : "وضعیت: وصل نیست 🔴") +
        "\n\n<b>راه‌اندازی:</b>\n۱) یه گروه بساز و توی تنظیماتش <b>Topics</b> رو روشن کن\n۲) ربات رو توی گروه اضافه و <b>ادمین</b> کن (دسترسی Manage Topics)\n۳) داخل گروه دستور /setlog رو بفرست (فقط ادمین‌های ربات)\n\nتاپیک‌ها خودکار ساخته میشن. هر گزارش رو با دکمه‌های زیر روشن/خاموش کن:",
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  // ---- دسته‌بندی‌ها ----
  if (/^(cats?|catview|cattoggle|catren|catdel|catdel_ok|catpanels|catpanelset|pcat|pcatset|cat_add)$/.test(action)) await ensureCatSchema(env);
  if (action === "cats") {
    const cats = await listCategories(env, { onlyEnabled: false });
    const rows = cats.map((c) => [{ text: `${c.enabled ? "🟢" : "🔴"} ${c.name}`, callback_data: `adm:catview:${c.id}` }]);
    rows.push([{ text: "➕ افزودن دسته‌بندی", callback_data: "adm:cat_add" }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:products" }]);
    await editMessageText(
      env,
      chatId,
      messageId,
      "🗂 <b>دسته‌بندی‌ها</b>\nمثلا «🚇 تانل‌دار» و «⚡️ بدون تانل». مشتری موقع خرید اول دسته رو انتخاب می‌کنه و بعد پلن‌های همون دسته رو می‌بینه. محصولاتِ بدون دسته زیر «📦 سایر» میان.",
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }
  if (action === "cat_add") {
    await setAdminState(env, adminId, { action: "add_category" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "اسم دسته‌بندی رو بفرست (مثلا: 🚇 تانل‌دار).\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "catview") {
    const id = parts[2];
    const cat = await env.DB.prepare("SELECT * FROM categories WHERE id=?").bind(id).first();
    if (!cat) {
      await answerCallback(env, cq.id, "پیدا نشد.", true);
      return;
    }
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM products WHERE category_id=?").bind(id).first())?.c || 0;
    await editMessageText(env, chatId, messageId, `🗂 <b>${escapeHtml(cat.name)}</b>\nتعداد محصولات: ${cnt}\nوضعیت: ${cat.enabled ? "فعال 🟢" : "غیرفعال 🔴 (برای مشتری نمایش داده نمیشه)"}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔌 افزودن همه‌ی محصولات یک پنل", callback_data: `adm:catpanels:${id}` }],
          [{ text: "✏️ تغییر نام", callback_data: `adm:catren:${id}` }],
          [{ text: cat.enabled ? "🔴 غیرفعال کردن" : "🟢 فعال کردن", callback_data: `adm:cattoggle:${id}` }],
          [{ text: "🗑 حذف دسته‌بندی", callback_data: `adm:catdel:${id}` }],
          [{ text: "🔙 بازگشت", callback_data: "adm:cats" }],
        ],
      },
    });
    return;
  }
  if (action === "cattoggle") {
    const id = parts[2];
    await env.DB.prepare("UPDATE categories SET enabled = 1 - enabled WHERE id=?").bind(id).run();
    await answerCallback(env, cq.id, "بروزرسانی شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:catview:${id}`);
    return;
  }
  if (action === "catren") {
    await setAdminState(env, adminId, { action: "rename_category", data: parts[2] });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "اسم جدید دسته‌بندی رو بفرست.\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "catdel") {
    const id = parts[2];
    await editMessageText(env, chatId, messageId, "مطمئنی می‌خوای این دسته‌بندی حذف بشه؟ محصولاتش حذف نمیشن و «بدون دسته‌بندی» میشن.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ بله، حذف کن", callback_data: `adm:catdel_ok:${id}` }],
          [{ text: "🔙 انصراف", callback_data: `adm:catview:${id}` }],
        ],
      },
    });
    return;
  }
  if (action === "catdel_ok") {
    const id = parts[2];
    await env.DB.prepare("UPDATE products SET category_id=NULL WHERE category_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id).run();
    await answerCallback(env, cq.id, "حذف شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, "adm:cats");
    return;
  }
  if (action === "catpanels") {
    const id = parts[2];
    const { results } = await env.DB.prepare("SELECT id, name, type FROM panels ORDER BY id").all();
    if (!results.length) {
      await answerCallback(env, cq.id, "هنوز پنلی اضافه نکردی.", true);
      return;
    }
    const rows = results.map((pn) => [{ text: `${pn.name} (${PANEL_TYPES[pn.type] || pn.type})`, callback_data: `adm:catpanelset:${id}:${pn.id}` }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: `adm:catview:${id}` }]);
    await editMessageText(env, chatId, messageId, "همه‌ی محصولات متصل به کدوم پنل بره توی این دسته‌بندی؟", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (action === "catpanelset") {
    const [, , id, panelId] = parts;
    const r = await env.DB.prepare("UPDATE products SET category_id=? WHERE panel_id=?").bind(id, panelId).run();
    await answerCallback(env, cq.id, `${r.meta?.changes || 0} محصول منتقل شد ✅`, true);
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:catview:${id}`);
    return;
  }
  if (action === "pcat") {
    const id = parts[2];
    const cats = await listCategories(env, { onlyEnabled: false });
    if (!cats.length) {
      await answerCallback(env, cq.id, "اول از «🗂 دسته‌بندی‌ها» یه دسته بساز.", true);
      return;
    }
    const rows = cats.map((c) => [{ text: c.name, callback_data: `adm:pcatset:${id}:${c.id}` }]);
    rows.push([{ text: "❌ بدون دسته‌بندی", callback_data: `adm:pcatset:${id}:0` }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: `adm:pview:${id}` }]);
    await editMessageText(env, chatId, messageId, "این محصول توی کدوم دسته‌بندی باشه؟", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (action === "pcatset") {
    const [, , id, catId] = parts;
    await env.DB.prepare("UPDATE products SET category_id=? WHERE id=?").bind(catId === "0" ? null : catId, id).run();
    await answerCallback(env, cq.id, "ذخیره شد ✅");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pview:${id}`);
    return;
  }

  // ---- محصولات ----
  if (action === "products") {
    await editMessageText(env, chatId, messageId, "مدیریت محصولات:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ افزودن محصول", callback_data: "adm:product_add" }],
          [{ text: "🧮 افزودن محصول حجم دلخواه", callback_data: "adm:cproduct_add" }],
          [{ text: "📋 لیست محصولات", callback_data: "adm:product_list" }],
          [{ text: "🗂 دسته‌بندی‌ها", callback_data: "adm:cats" }],
          [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
        ],
      },
    });
    return;
  }
  if (action === "product_add") {
    await setAdminState(env, adminId, { action: "add_product" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "فرمت زیر رو بفرست:\nنام محصول | قیمت (تومان) | مدت (روز) | توضیحات (اختیاری)\n\nمثال:\nیک ماهه نامحدود | 150000 | 30 | حجم نامحدود، تک‌کاربره\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "product_list") {
    const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY id DESC").all();
    if (!results.length) {
      await answerCallback(env, cq.id, "محصولی ثبت نشده.", true);
      return;
    }
    const rows = results.map((p) => [
      { text: `${p.enabled ? "🟢" : "🔴"} ${p.is_trial ? "🆓 " : ""}${p.custom ? "🧮 " : ""}${p.name} — ${p.custom ? "از " : ""}${fmtMoney(p.price)}`, callback_data: `adm:pview:${p.id}` },
    ]);
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:products" }]);
    await editMessageText(env, chatId, messageId, "محصولات (برای مدیریت هرکدوم لمس کن):", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (action === "pview") {
    const id = parts[2];
    const p = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first();
    if (!p) {
      await answerCallback(env, cq.id, "پیدا نشد.", true);
      return;
    }
    const stock = await configStock(env, id);
    const linkedPanel = p.panel_id ? await env.DB.prepare("SELECT name, type FROM panels WHERE id=?").bind(p.panel_id).first() : null;
    const panelName = linkedPanel ? `${linkedPanel.name} (${PANEL_TYPES[linkedPanel.type] || linkedPanel.type})` : "حذف‌شده ⚠️";
    const c = customOf(p);
    let catName = null;
    if (p.category_id) await ensureCatSchema(env);
    if (p.category_id) catName = (await env.DB.prepare("SELECT name FROM categories WHERE id=?").bind(p.category_id).first().catch(() => null))?.name || null;
    const catLine = `\n🗂 دسته‌بندی: ${catName ? escapeHtml(catName) : "بدون دسته‌بندی"}`;
    if (c) {
      const body =
        `🧮 <b>${escapeHtml(p.name)}</b> (حجم دلخواه)\n${escapeHtml(p.description || "")}\n` +
        `📊 حجم: ${trimNum(c.min_gb)} تا ${trimNum(c.max_gb)} گیگ\n⏳ مدت: ${c.min_days} تا ${c.max_days} روز\n` +
        `💵 هر گیگ: ${fmtMoney(c.price_per_gb)}${c.price_per_day ? ` | هر روز: ${fmtMoney(c.price_per_day)}` : ""}\n` +
        `🔌 پنل: ${p.panel_id ? escapeHtml(panelName) : "⚠️ وصل نیست (تا وصل نشه برای مشتری نمایش داده نمیشه)"}\n` +
        `وضعیت: ${p.enabled ? "فعال 🟢" : "غیرفعال 🔴"}` + catLine;
      await editMessageText(env, chatId, messageId, body, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📐 ویرایش بازه و قیمت‌ها", callback_data: `adm:cedit:${id}` }],
            [{ text: "🔌 اتصال به پنل", callback_data: `adm:plinkmenu:${id}` }],
            [{ text: "🗂 دسته‌بندی", callback_data: `adm:pcat:${id}` }],
            [{ text: p.enabled ? "🔴 غیرفعال کردن" : "🟢 فعال کردن", callback_data: `adm:ptoggle:${id}` }],
            [{ text: "↩️ تبدیل به محصول عادی", callback_data: `adm:cunset:${id}` }],
            [{ text: "🗑 حذف محصول", callback_data: `adm:pdel:${id}` }],
            [{ text: "🔙 بازگشت", callback_data: "adm:product_list" }],
          ],
        },
      });
      return;
    }
    const panelLine = p.panel_id
      ? `\n🔌 پنل: ${escapeHtml(panelName)}\n📊 حجم: ${p.data_limit_gb > 0 ? p.data_limit_gb + " گیگ" : "نامحدود"} (ساخت خودکار سرویس)`
      : "\n🔌 پنل: ندارد (کانفیگ دستی)";
    const stockLine = p.panel_id ? "" : `\n\nموجود: ${stock.avail} | استفاده‌شده: ${stock.used}`;
    const manualRows = p.panel_id
      ? []
      : [
          [{ text: "➕ افزودن کانفیگ", callback_data: `adm:padd:${id}` }],
          [{ text: "📄 مشاهده/حذف کانفیگ‌ها", callback_data: `adm:pconfigs:${id}:0` }],
        ];
    await editMessageText(
      env,
      chatId,
      messageId,
      `📦 <b>${escapeHtml(p.name)}</b>\n💵 ${fmtMoney(p.price)} — ${p.duration_days} روز\n${escapeHtml(p.description || "")}${panelLine}${stockLine}${catLine}\nوضعیت: ${p.enabled ? "فعال 🟢" : "غیرفعال 🔴"}${p.is_trial ? "\n🆓 محصول تست رایگان" : ""}`,
      {
        reply_markup: {
          inline_keyboard: [
            ...manualRows,
            [{ text: "🔌 اتصال به پنل", callback_data: `adm:plinkmenu:${id}` }],
            [{ text: "🗂 دسته‌بندی", callback_data: `adm:pcat:${id}` }],
            [{ text: "📊 تنظیم حجم (گیگ)", callback_data: `adm:pgb:${id}` }],
            [{ text: "✏️ تغییر قیمت", callback_data: `adm:pedit:${id}` }],
            [{ text: p.enabled ? "🔴 غیرفعال کردن" : "🟢 فعال کردن", callback_data: `adm:ptoggle:${id}` }],
            [{ text: p.is_trial ? "❌ حذف حالت تست رایگان" : "🆓 تنظیم بعنوان تست رایگان", callback_data: `adm:ptrial:${id}` }],
            [{ text: "🗑 حذف محصول", callback_data: `adm:pdel:${id}` }],
            [{ text: "🔙 بازگشت", callback_data: "adm:product_list" }],
          ],
        },
      }
    );
    return;
  }
  if (action === "cproduct_add") {
    await setAdminState(env, adminId, { action: "add_custom_product" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, CUSTOM_HELP);
    return;
  }
  if (action === "cedit") {
    await setAdminState(env, adminId, { action: "set_custom", data: parts[2] });
    await answerCallback(env, cq.id, "");
    await sendMessage(
      env,
      chatId,
      "بازه و قیمت‌های جدید رو بفرست:\nحداقل گیگ | حداکثر گیگ | حداقل روز | حداکثر روز | قیمت هر گیگ | قیمت هر روز (اختیاری)\n\nمثال:\n5 | 200 | 30 | 365 | 2000 | 0\n\nبرای لغو: /cancel"
    );
    return;
  }
  if (action === "cunset") {
    const id = parts[2];
    await env.DB.prepare("UPDATE products SET custom=NULL, data_limit_gb=COALESCE(data_limit_gb,0) WHERE id=?").bind(id).run();
    await answerCallback(env, cq.id, "به محصول عادی تبدیل شد (قیمت/حجم رو تنظیم کن).");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pview:${id}`);
    return;
  }
  if (action === "pconfigs") {
    const id = parts[2];
    const page = parseInt(parts[3] || "0", 10);
    const pageSize = 10;
    const { results } = await env.DB.prepare(
      "SELECT id, config_text FROM configs WHERE product_id=? AND is_used=0 ORDER BY id ASC LIMIT ? OFFSET ?"
    ).bind(id, pageSize, page * pageSize).all();
    const totalRow = await env.DB.prepare("SELECT COUNT(*) as c FROM configs WHERE product_id=? AND is_used=0").bind(id).first();
    const total = totalRow?.c || 0;

    if (!results.length) {
      await answerCallback(env, cq.id, "کانفیگ استفاده‌نشده‌ای موجود نیست.", true);
      return;
    }
    const rows = results.map((c) => {
      const short = c.config_text.length > 28 ? c.config_text.slice(0, 28) + "…" : c.config_text;
      return [{ text: `❌ ${short}`, callback_data: `adm:cfgdel:${c.id}:${id}:${page}` }];
    });
    const navRow = [];
    if (page > 0) navRow.push({ text: "◀️ قبلی", callback_data: `adm:pconfigs:${id}:${page - 1}` });
    if ((page + 1) * pageSize < total) navRow.push({ text: "بعدی ▶️", callback_data: `adm:pconfigs:${id}:${page + 1}` });
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: "🔙 بازگشت", callback_data: `adm:pview:${id}` }]);

    await answerCallback(env, cq.id, "");
    await editMessageText(
      env,
      chatId,
      messageId,
      `📄 کانفیگ‌های استفاده‌نشده (${total} عدد) — روی هرکدوم بزنی حذف میشه:`,
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }
  if (action === "cfgdel") {
    const configId = parts[2];
    const productId = parts[3];
    const page = parts[4] || "0";
    const res = await env.DB.prepare("DELETE FROM configs WHERE id=? AND is_used=0").bind(configId).run();
    if (res.meta && res.meta.changes > 0) {
      await answerCallback(env, cq.id, "کانفیگ حذف شد.");
    } else {
      await answerCallback(env, cq.id, "این کانفیگ قبلا استفاده شده یا حذف شده.", true);
    }
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pconfigs:${productId}:${page}`);
    return;
  }


  if (action === "padd") {
    const id = parts[2];
    await setAdminState(env, adminId, { action: "add_config", data: id });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "کانفیگ‌ها رو بفرست (هرکدوم در یک خط).\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "pedit") {
    const id = parts[2];
    await setAdminState(env, adminId, { action: "edit_product_price", data: id });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "قیمت جدید رو به تومان بفرست (فقط عدد).\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "ptoggle") {
    const id = parts[2];
    const p = await env.DB.prepare("SELECT enabled FROM products WHERE id=?").bind(id).first();
    await env.DB.prepare("UPDATE products SET enabled=? WHERE id=?").bind(p.enabled ? 0 : 1, id).run();
    await answerCallback(env, cq.id, "بروزرسانی شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pview:${id}`);
    return;
  }
  if (action === "ptrial") {
    const id = parts[2];
    const p = await env.DB.prepare("SELECT is_trial, custom FROM products WHERE id=?").bind(id).first();
    if (p && p.custom) {
      await answerCallback(env, cq.id, "محصول حجم دلخواه نمی‌تونه تست رایگان باشه.", true);
      return;
    }
    await env.DB.prepare("UPDATE products SET is_trial=? WHERE id=?").bind(p.is_trial ? 0 : 1, id).run();
    await answerCallback(env, cq.id, "بروزرسانی شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pview:${id}`);
    return;
  }
  if (action === "pdel") {
    const id = parts[2];
    await editMessageText(env, chatId, messageId, "مطمئنی می‌خوای این محصول و کانفیگ‌هاش حذف بشه؟", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ بله، حذف کن", callback_data: `adm:pdel_confirm:${id}` }],
          [{ text: "❌ انصراف", callback_data: `adm:pview:${id}` }],
        ],
      },
    });
    await answerCallback(env, cq.id, "");
    return;
  }
  if (action === "pdel_confirm") {
    const id = parts[2];
    await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM configs WHERE product_id=?").bind(id).run();
    await answerCallback(env, cq.id, "حذف شد.");
    await editMessageText(env, chatId, messageId, "محصول حذف شد.", adminMainMenu());
    return;
  }

  // ---- سفارش‌ها ----
  if (action === "orders") {
    const { results } = await env.DB.prepare("SELECT * FROM orders WHERE status='pending' ORDER BY created_at ASC LIMIT 20").all();
    if (!results.length) {
      await answerCallback(env, cq.id, "سفارش در انتظاری نیست.", true);
      return;
    }
    const rows = results.map((o) => [{ text: `#${o.id} — ${fmtMoney(o.amount)} (${o.type === "purchase" ? "خرید" : o.type === "renew" ? "تمدید" : "شارژ"})`, callback_data: `adm:ordview:${o.id}` }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:main" }]);
    await editMessageText(env, chatId, messageId, "سفارش‌های در انتظار تایید:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (action === "ordview") {
    const id = parts[2];
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    if (!order) {
      await answerCallback(env, cq.id, "پیدا نشد.", true);
      return;
    }
    await answerCallback(env, cq.id, "");
    if (order.receipt_file_id) {
      await sendPhoto(env, chatId, order.receipt_file_id, `سفارش #${order.id} — ${fmtMoney(order.amount)}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ تایید", callback_data: `adm:ord_ok:${order.id}` },
            { text: "❌ رد", callback_data: `adm:ord_no:${order.id}` },
          ]],
        },
      });
    } else {
      await sendMessage(env, chatId, `سفارش #${order.id} — ${fmtMoney(order.amount)} — بدون رسید ثبت‌شده`);
    }
    return;
  }
  if (action === "ord_ok") {
    const id = parts[2];
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    if (!order || order.status !== "pending") {
      await answerCallback(env, cq.id, "این سفارش قبلا رسیدگی شده.", true);
      return;
    }
    const result = await fulfillOrder(env, order);
    if (!result.ok) {
      await answerCallback(env, cq.id, reasonText(result).slice(0, 190), true);
      return;
    }
    await answerCallback(env, cq.id, "✅ تایید شد.");
    return;
  }
  if (action === "ord_no") {
    const id = parts[2];
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    const rj = await env.DB.prepare("UPDATE orders SET status='rejected', decided_at=? WHERE id=? AND status='pending'")
      .bind(Date.now(), id).run();
    if (!order || !(rj.meta && rj.meta.changes > 0)) {
      await answerCallback(env, cq.id, "این سفارش قبلا رسیدگی شده.", true);
      return;
    }
    await sendMessage(env, order.user_id, `❌ رسید سفارش #${order.id} تایید نشد. برای پیگیری با پشتیبانی تماس بگیر.`);
    await logEvent(env, "receipt", `❌ <b>رسید رد شد</b> (سفارش #${order.id})\n👤 ${await logUserTag(env, order.user_id)}\n💵 ${fmtMoney(order.amount)}`);
    await answerCallback(env, cq.id, "رد شد.");
    return;
  }

  // ---- پنل‌ها ----
  if (action === "panels") {
    await editMessageText(env, chatId, messageId, "🔌 مدیریت پنل‌ها:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ افزودن پنل", callback_data: "adm:panel_add" }],
          [{ text: "📋 لیست پنل‌ها", callback_data: "adm:panel_list" }],
          [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
        ],
      },
    });
    return;
  }
  if (action === "panel_add") {
    await editMessageText(env, chatId, messageId, "نوع پنل رو انتخاب کن:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Marzban", callback_data: "adm:panel_type:marzban" }],
          [{ text: "PasarGuard", callback_data: "adm:panel_type:pasarguard" }],
          [{ text: "3x-ui (سنایی)", callback_data: "adm:panel_type:sanaei" }],
          [{ text: "🔙 بازگشت", callback_data: "adm:panels" }],
        ],
      },
    });
    return;
  }
  if (action === "panel_type") {
    const type = parts[2];
    if (!PANEL_TYPES[type]) return;
    await setAdminState(env, adminId, { action: "add_panel", data: type });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, PANEL_ADD_HELP[type]);
    return;
  }
  if (action === "panel_list") {
    const { results } = await env.DB.prepare("SELECT id, name, type, enabled FROM panels ORDER BY id DESC").all();
    if (!results.length) {
      await answerCallback(env, cq.id, "پنلی ثبت نشده.", true);
      return;
    }
    const rows = results.map((pn) => [{ text: `${pn.enabled ? "🟢" : "🔴"} ${pn.name} — ${PANEL_TYPES[pn.type] || pn.type}`, callback_data: `adm:pnview:${pn.id}` }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:panels" }]);
    await editMessageText(env, chatId, messageId, "پنل‌ها:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (action === "pnview") {
    const pn = await getPanel(env, parts[2]);
    if (!pn) {
      await answerCallback(env, cq.id, "پیدا نشد.", true);
      return;
    }
    const ex = pn.extra || {};
    const info = [
      `🔌 <b>${escapeHtml(pn.name)}</b> — ${PANEL_TYPES[pn.type] || pn.type}`,
      `آدرس: ${escapeHtml(pn.base_url)}`,
      pn.username ? `یوزرنیم: ${escapeHtml(pn.username)}` : "",
      pn.api_token ? "احراز هویت: توکن API" : "",
      ex.inbound_id ? `اینباند: #${ex.inbound_id}` : "",
      ex.sub_base ? `آدرس ساب: ${escapeHtml(ex.sub_base)}` : "",
      ex.group_ids ? `گروه‌ها: ${ex.group_ids.join(",")}` : "",
      ex.protocols ? `پروتکل‌ها: ${ex.protocols.join(",")}` : "",
      ex.flow ? `flow: ${escapeHtml(ex.flow)}` : "",
    ].filter(Boolean).join("\n");
    await editMessageText(env, chatId, messageId, info, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔌 تست اتصال", callback_data: `adm:pntest:${pn.id}` }],
          [{ text: "🗑 حذف پنل", callback_data: `adm:pndel:${pn.id}` }],
          [{ text: "🔙 بازگشت", callback_data: "adm:panel_list" }],
        ],
      },
    });
    return;
  }
  if (action === "pntest") {
    const pn = await getPanel(env, parts[2]);
    if (!pn) {
      await answerCallback(env, cq.id, "پیدا نشد.", true);
      return;
    }
    await answerCallback(env, cq.id, "در حال تست اتصال…");
    let report;
    try {
      report = "✅ " + (await panelTest(pn));
    } catch (e) {
      report = "❌ " + e.message;
    }
    await sendMessage(env, chatId, `نتیجه تست «${escapeHtml(pn.name)}»:\n${escapeHtml(report)}`);
    return;
  }
  if (action === "pndel") {
    const id = parts[2];
    await editMessageText(env, chatId, messageId, "مطمئنی می‌خوای این پنل حذف بشه؟ محصولات متصل به‌ش به «کانفیگ دستی» برمی‌گردن و سرویس‌های قبلی کاربران دیگه نمی‌تونن مصرف/تمدید بگیرن.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ بله، حذف کن", callback_data: `adm:pndel_confirm:${id}` }],
          [{ text: "❌ انصراف", callback_data: `adm:pnview:${id}` }],
        ],
      },
    });
    await answerCallback(env, cq.id, "");
    return;
  }
  if (action === "pndel_confirm") {
    const id = parts[2];
    await env.DB.prepare("UPDATE products SET panel_id=NULL WHERE panel_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM panels WHERE id=?").bind(id).run();
    await answerCallback(env, cq.id, "حذف شد.");
    await editMessageText(env, chatId, messageId, "پنل حذف شد.", adminMainMenu());
    return;
  }

  // ---- اتصال محصول به پنل و تنظیم حجم ----
  if (action === "plinkmenu") {
    const pid = parts[2];
    const { results } = await env.DB.prepare("SELECT id, name, type FROM panels WHERE enabled=1 ORDER BY id").all();
    const rows = results.map((pn) => [{ text: `${pn.name} — ${PANEL_TYPES[pn.type] || pn.type}`, callback_data: `adm:plink:${pid}:${pn.id}` }]);
    rows.push([{ text: "🚫 بدون پنل (کانفیگ دستی)", callback_data: `adm:plink:${pid}:0` }]);
    rows.push([{ text: "🔙 بازگشت", callback_data: `adm:pview:${pid}` }]);
    await editMessageText(env, chatId, messageId, results.length ? "این محصول به کدوم پنل وصل بشه؟" : "هنوز پنلی ثبت نکردی. اول از «🔌 مدیریت پنل‌ها» یه پنل اضافه کن.", {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }
  if (action === "plink") {
    const pid = parts[2];
    const panelId = parseInt(parts[3], 10) || null;
    await env.DB.prepare("UPDATE products SET panel_id=? WHERE id=?").bind(panelId, pid).run();
    await answerCallback(env, cq.id, panelId ? "متصل شد." : "اتصال حذف شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, `adm:pview:${pid}`);
    return;
  }
  if (action === "pgb") {
    await setAdminState(env, adminId, { action: "edit_product_gb", data: parts[2] });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "حجم این محصول رو به گیگابایت بفرست (0 = نامحدود، مثلا 30 یا 0.5).\n\nبرای لغو: /cancel");
    return;
  }

  // ---- تنظیمات اشتراک قبلی و QR ----
  if (action === "sub" || action === "subt") {
    const cfg = await loadUiCfg(env);
    if (action === "subt") {
      const which = parts[2];
      if (which === "verify") cfg.ext_verify = cfg.ext_verify === false;
      else if (which === "qr") cfg.qr_enabled = cfg.qr_enabled === false;
      else return;
      await saveUiCfg(env, cfg);
      await answerCallback(env, cq.id, "ذخیره شد ✅");
    }
    const verifyOn = cfg.ext_verify !== false;
    const qrOn = cfg.qr_enabled !== false;
    await editMessageText(
      env,
      chatId,
      messageId,
      "🔎 <b>اشتراک‌های خارج از ربات</b>\nمشتری با دکمه‌ی «استعلام/تمدید اشتراک قبلی» اسم اشتراکش رو میزنه و مصرف/انقضا رو می‌بینه؛ تمدید فقط با پلن‌هایی که به همون پنل وصل کردی انجام میشه.\n\n" +
        `🔐 تایید مالکیت: ${verifyOn ? "روشن 🟢" : "خاموش 🔴"}\n` +
        (verifyOn
          ? "مشتری برای تمدید باید لینک اشتراک فعلیش رو بفرسته (پیشنهادی؛ جلوی لو رفتن لینک با حدس اسم رو می‌گیره).\n"
          : "⚠️ هر کسی که اسم یه اشتراک رو بدونه (یا حدس بزنه) می‌تونه اون رو تمدید کنه!\n") +
        `\n📲 ارسال QR همراه لینک: ${qrOn ? "روشن 🟢" : "خاموش 🔴"}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: verifyOn ? "🔴 خاموش کردن تایید مالکیت" : "🟢 روشن کردن تایید مالکیت", callback_data: "adm:subt:verify" }],
            [{ text: qrOn ? "🔴 خاموش کردن QR" : "🟢 روشن کردن QR", callback_data: "adm:subt:qr" }],
            [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
          ],
        },
      }
    );
    return;
  }

  // ---- قوانین ----
  if (action === "rules") {
    const cfg = await loadUiCfg(env);
    const on = cfg.rules_enabled !== false;
    await editMessageText(
      env, chatId, messageId,
      `📜 تایید قوانین: ${on ? "فعال 🟢" : "غیرفعال 🔴"}\n\nدر حالت فعال، هر کاربر قبل از استفاده از ربات باید یک‌بار قوانین رو بپذیره (دکمه سبز).`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "👁 پیش‌نمایش", callback_data: "adm:rules_preview" }],
            [{ text: "✏️ ویرایش متن قوانین", callback_data: "adm:rules_edit" }],
            [{ text: "✏️ ویرایش متن دکمه تایید", callback_data: "adm:rules_btn" }],
            [{ text: on ? "🔴 غیرفعال کردن" : "🟢 فعال کردن", callback_data: "adm:rules_toggle" }],
            [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
          ],
        },
      }
    );
    return;
  }
  if (action === "rules_preview") {
    await answerCallback(env, cq.id, "");
    await sendRules(env, chatId, await loadUiCfg(env), { preview: true });
    return;
  }
  if (action === "rules_edit") {
    await setAdminState(env, adminId, { action: "set_rules_text" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن جدید قوانین رو بفرست (فرمت HTML مثل <b>پررنگ</b> مجازه).\nبرای برگشت به متن پیش‌فرض بنویس: default\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "rules_btn") {
    await setAdminState(env, adminId, { action: "set_rules_btn" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن دکمه تایید قوانین رو بفرست (حداکثر ۴۰ کاراکتر، مثلا: ✅ قبول دارم).\nبرای برگشت به پیش‌فرض بنویس: default\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "rules_toggle") {
    const cfg = await loadUiCfg(env);
    cfg.rules_enabled = cfg.rules_enabled === false;
    await saveUiCfg(env, cfg);
    await answerCallback(env, cq.id, cfg.rules_enabled ? "فعال شد." : "غیرفعال شد.");
    await handleAdminCallback(env, cq, chatId, messageId, adminId, "adm:rules");
    return;
  }

  // ---- شخصی‌سازی دکمه‌ها ----
  if (action === "ui") {
    await editMessageText(env, chatId, messageId, "🎨 شخصی‌سازی دکمه‌ها:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 دکمه‌های منوی اصلی (متن/رنگ/روشن-خاموش)", callback_data: "adm:ui_menu" }],
          [{ text: "🎨 رنگ دکمه‌های شیشه‌ای", callback_data: "adm:ui_roles" }],
          [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
        ],
      },
    });
    return;
  }
  if (action === "ui_menu") {
    const cfg = await loadUiCfg(env);
    const rows = MENU_ITEMS.map((it) => [
      {
        text: `${COLOR_EMOJI[menuStyle(cfg, it.key)]} ${cfg.menu[it.key]?.hidden ? "🔴 " : ""}${menuLabel(cfg, it.key)}`,
        callback_data: `adm:uim:${it.key}`,
        style: "none",
      },
    ]);
    rows.push([{ text: "🔙 بازگشت", callback_data: "adm:ui" }]);
    await editMessageText(env, chatId, messageId, "دکمه‌های منوی اصلی — برای ویرایش هرکدوم لمس کن (🔴 = خاموش).\n(تغییر متن/رنگ برای هر کاربر از /start بعدی یا ارسال پیام همگانی روی کیبوردش اعمال میشه؛ خاموش‌کردن فوریه.)", {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }
  if (action === "uim") {
    const key = parts[2];
    if (!MENU_BY_KEY[key]) return;
    const v = uiItemView(await loadUiCfg(env), key);
    await editMessageText(env, chatId, messageId, v.text, v.markup);
    return;
  }
  if (action === "uil") {
    const key = parts[2];
    if (!MENU_BY_KEY[key]) return;
    await setAdminState(env, adminId, { action: "ui_label", data: key });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن جدید دکمه رو بفرست (حداکثر ۳۰ کاراکتر؛ ایموجی هم می‌تونی بذاری).\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "uic" || action === "uih" || action === "uir") {
    const key = parts[2];
    if (!MENU_BY_KEY[key]) return;
    const cfg = await loadUiCfg(env);
    const cur = cfg.menu[key] || {};
    if (action === "uic") {
      const st = parts[3];
      if (!VALID_STYLES.includes(st)) return;
      cfg.menu[key] = { ...cur, style: st };
    } else if (action === "uih") {
      if (key === "admin") {
        await answerCallback(env, cq.id, "دکمه پنل مدیریت قابل خاموش شدن نیست.", true);
        return;
      }
      cfg.menu[key] = { ...cur, hidden: !cur.hidden };
    } else {
      // بازگشت به پیش‌فرض (متن‌های قبلی به‌عنوان نام مستعار می‌مونن تا کیبوردهای قدیمی کار کنن)
      const aliases = [...new Set([...(cur.aliases || []), cur.label].filter(Boolean))];
      if (aliases.length) cfg.menu[key] = { aliases };
      else delete cfg.menu[key];
    }
    await saveUiCfg(env, cfg);
    await answerCallback(env, cq.id, "ذخیره شد ✅");
    const v = uiItemView(cfg, key);
    await editMessageText(env, chatId, messageId, v.text, v.markup);
    return;
  }
  if (action === "ui_roles") {
    const v = uiRolesView(await loadUiCfg(env));
    await editMessageText(env, chatId, messageId, v.text, v.markup);
    return;
  }
  if (action === "uirs") {
    const role = parts[2];
    const st = parts[3];
    const cfg = await loadUiCfg(env);
    if (role === "reset") {
      cfg.roles = {};
    } else {
      if (!["primary", "success", "danger"].includes(role) || !VALID_STYLES.includes(st)) return;
      cfg.roles[role] = st;
    }
    await saveUiCfg(env, cfg);
    await answerCallback(env, cq.id, "ذخیره شد ✅");
    const v = uiRolesView(cfg);
    await editMessageText(env, chatId, messageId, v.text, v.markup);
    return;
  }

  // ---- تنظیمات متفرقه ----
  if (action === "cardset") {
    await setAdminState(env, adminId, { action: "set_card" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "فرمت: شماره کارت | نام صاحب حساب\nمثال: 6037-9975-1234-5678 | علی محمدی\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "refset") {
    await setAdminState(env, adminId, { action: "set_refpercent" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "درصد کمیسیون رو بفرست (فقط عدد)، مثلا: 10\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "wheelset") {
    await setAdminState(env, adminId, { action: "set_wheel" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "هر خط: برچسب | مبلغ | وزن\nمثال:\n🎉 ۵۰ هزار | 50000 | 5\n✨ ۲۰ هزار | 20000 | 15\n😢 پوچ | 0 | 50\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "texts") {
    await editMessageText(env, chatId, messageId, "کدوم متن رو می‌خوای تنظیم کنی؟", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "☎️ متن پشتیبانی", callback_data: "adm:texts_support" }],
          [{ text: "📚 متن آموزش", callback_data: "adm:texts_tutorial" }],
          [{ text: "🔙 بازگشت", callback_data: "adm:main" }],
        ],
      },
    });
    return;
  }
  if (action === "texts_support") {
    await setAdminState(env, adminId, { action: "set_support_text" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن پشتیبانی رو بفرست (می‌تونی لینک/آیدی هم بذاری).\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "texts_tutorial") {
    await setAdminState(env, adminId, { action: "set_tutorial_text" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن آموزش رو بفرست.\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "channels") {
    await answerCallback(env, cq.id, "");
    await sendMessage(
      env,
      chatId,
      "برای مدیریت کانال‌های عضویت اجباری از این دستورات استفاده کن:\n/addchannel @channelusername\n/delchannel @channelusername\n/channels"
    );
    return;
  }

  // ---- کاربران ----
  if (action === "users") {
    await setAdminState(env, adminId, { action: "find_user" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "آیدی عددی کاربر رو بفرست.\n\nبرای لغو: /cancel");
    return;
  }
  if (action === "ban" || action === "unban") {
    const targetId = parts[2];
    await env.DB.prepare("UPDATE users SET is_banned=? WHERE id=?").bind(action === "ban" ? 1 : 0, targetId).run();
    await answerCallback(env, cq.id, action === "ban" ? "مسدود شد." : "آزاد شد.");
    await sendMessage(env, chatId, `کاربر ${targetId} ${action === "ban" ? "مسدود 🚫" : "فعال ✅"} شد.`, adminMainMenu());
    return;
  }
  if (action === "walletadj") {
    const targetId = parts[2];
    await setAdminState(env, adminId, { action: "wallet_adjust", data: targetId });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "مبلغ تغییر رو بفرست (برای افزایش مثبت، برای کاهش منفی)، مثلا: 50000 یا -20000\n\nبرای لغو: /cancel");
    return;
  }

  // ---- آمار و پیام همگانی ----
  if (action === "stats") {
    const totalUsers = (await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE registered=1").first())?.c || 0;
    const totalRevenue = (await env.DB.prepare("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='approved' AND type='purchase'").first())?.s || 0;
    const totalTopup = (await env.DB.prepare("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='approved' AND type='topup'").first())?.s || 0;
    const pendingCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending'").first())?.c || 0;
    const totalWallet = (await env.DB.prepare("SELECT COALESCE(SUM(wallet_balance),0) as s FROM users").first())?.s || 0;
    const banned = (await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE is_banned=1").first())?.c || 0;
    const productsCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM products").first())?.c || 0;
    const panelsCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM panels").first())?.c || 0;
    await answerCallback(env, cq.id, "");
    await sendMessage(
      env,
      chatId,
      `📊 <b>آمار ربات</b>\n\nکاربران: ${totalUsers}\nمحصولات: ${productsCount}\nپنل‌ها: ${panelsCount}\nسفارش‌های در انتظار: ${pendingCount}\nمجموع فروش (تایید‌شده): ${fmtMoney(totalRevenue)}\nمجموع شارژ کیف پول: ${fmtMoney(totalTopup)}\nموجودی کل کیف‌پول‌ها: ${fmtMoney(totalWallet)}\nکاربران مسدود: ${banned}`
    );
    return;
  }
  if (action === "broadcast") {
    await setAdminState(env, adminId, { action: "broadcast" });
    await answerCallback(env, cq.id, "");
    await sendMessage(env, chatId, "متن پیام همگانی رو بفرست.\n\nبرای لغو: /cancel");
    return;
  }
}

// ---------- خروج از کانال/گروه اجباری ----------
async function handleChatMemberUpdate(env, cm) {
  const chat = cm.chat;
  const oldStatus = cm.old_chat_member?.status;
  const newStatus = cm.new_chat_member?.status;
  const user = cm.new_chat_member?.user;
  if (!user) return;

  const leftStatuses = ["left", "kicked"];
  const wasMember = !leftStatuses.includes(oldStatus);
  const isNowLeft = leftStatuses.includes(newStatus);
  if (!wasMember || !isNowLeft) return;

  const channels = await getChannels(env);
  const chanRefByUsername = chat.username ? `@${chat.username}` : null;
  const isMandatory = channels.some((c) => c.ref === chanRefByUsername || String(c.ref) === String(chat.id));
  if (!isMandatory) return;

  await env.DB.prepare("INSERT INTO exit_logs (user_id, channel_ref, left_at) VALUES (?,?,?)")
    .bind(user.id, chanRefByUsername || String(chat.id), Date.now()).run();

  const admins = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const uname = user.username ? `@${user.username}` : user.first_name || String(user.id);
  const chanLabel = chanRefByUsername || chat.title || String(chat.id);
  const text = [
    "⚠️ خروج از کانال/گروه اجباری",
    `کاربر: ${uname} (آیدی: ${user.id})`,
    `کانال/گروه: ${chanLabel}`,
  ].join("\n");
  for (const adminId of admins) await sendMessage(env, adminId, text);
  await logEvent(env, "users", `🚪 <b>خروج از کانال/گروه اجباری</b>\n${await logUserTag(env, user.id)}\n📣 ${escapeHtml(chanLabel)}`);
}

// ---------- Worker entry ----------
// توابع داخلی که پنل وب ازشون استفاده می‌کنه (بدون وابستگی چرخشی)
export const internals = {
  sendMessage, tgCall, rawCall, tgUpload, escapeHtml, fmtMoney, isAdmin, reasonText,
  getSetting, setSetting, loadUiCfg, saveUiCfg, getLogCfg, saveLogCfg, logEvent, getUser,
  fulfillOrder, ensureCatSchema, getPanel, defaultWheelPrizes, getWheelPrizes,
  MENU_ITEMS, LOG_TOPICS, DEFAULT_RULES_TEXT, DEFAULT_RULES_BTN, VALID_STYLES, mainMenuKeyboard,
  logUserTag, PANEL_TYPES, panelTest, isIpHost, hydratePanel, clearPanelCache,
};

async function handleWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  await processUpdate(env, update);
  return new Response("ok");
}

// یک آپدیت تلگرام رو پردازش می‌کنه (روی Railway هم مستقیم صدا زده میشه)
export async function processUpdate(env, update) {
  try {
    if (update.message) {
      await handleMessage(env, update.message);
    } else if (update.callback_query) {
      await handleCallback(env, update.callback_query);
    } else if (update.chat_member) {
      await handleChatMemberUpdate(env, update.chat_member);
    }
  } catch (err) {
    console.error("handler error", err);
    const from = update.message?.from || update.callback_query?.from;
    if (from && isAdmin(env, from.id)) {
      const cid = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (cid) await sendMessage(env, cid, `⚠️ خطا:\n<code>${escapeHtml(String(err?.message || err)).slice(0, 500)}</code>`).catch(() => {});
    }
    await logEvent(
      env,
      "errors",
      `🔥 <b>خطای ربات</b>${from ? `\n👤 <code>${from.id}</code>` : ""}${update.callback_query?.data ? `\n🔘 <code>${escapeHtml(update.callback_query.data)}</code>` : ""}\n<code>${escapeHtml(String(err?.message || err)).slice(0, 600)}</code>`
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    setOrigin(env, url.origin);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method === "POST" && env.WEBHOOK_SECRET && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      // روی Railway آپدیت‌ها از صف بهینه‌ساز رد میشن (env.WEBHOOK_HOOK)
      if (typeof env.WEBHOOK_HOOK === "function") return env.WEBHOOK_HOOK(request, (u) => processUpdate(env, u));
      return handleWebhook(request, env);
    }

    if (url.pathname === "/" ) return Response.redirect(`${url.origin}/panel`, 302);
    if (url.pathname === "/panel" || url.pathname.startsWith("/panel/") || url.pathname.startsWith("/api/")) {
      return handleWeb(request, env, ctx, internals);
    }

    return new Response("not found", { status: 404 });
  },

  // Cron Trigger: بکاپ خودکار روی تلگرام (اگه از پنل روشن شده باشه) + پاکسازی
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, internals));
  },
};
