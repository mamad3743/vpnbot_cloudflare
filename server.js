// اجرای ربات روی Railway (یا هر سرور Node): همون کد Worker + دیتابیس SQLite + بکاپ شبانه
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import worker from "./src/index.js";
import { openDatabase, createD1 } from "./src/d1-sqlite.js";
import { restoreSql, toSqlText } from "./src/restore.js";
import { makeKV } from "./src/kv-sqlite.js";
import { installFetchOptimizer, enqueueUpdate, ostats } from "./src/node-optimizer.js";
import { invalidateSettings } from "./src/web/optimizer.js";
import { resolveEnv, isInstalled, invalidateInstallCfg } from "./src/web/install.js";
import { Readable } from "node:stream";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const startedAt = Date.now();
installFetchOptimizer(); // صف نرخ تلگرام + تلاش مجدد روی 429 + ادغام GET های هم‌زمان + تایم‌اوت

// ---------- تنظیمات ----------
// BOT_TOKEN / ADMIN_IDS اختیاری‌ان: اگه نباشن، سرور در «حالت نصب» بالا میاد و ویزارد /install ازشون می‌پرسه
let BOT_TOKEN = process.env.BOT_TOKEN;
let ADMIN_IDS = process.env.ADMIN_IDS;
// آدرس وبهوک تصادفی ولی ثابت (اگه WEBHOOK_SECRET ندی، از روی توکن ساخته میشه)
let WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || (BOT_TOKEN ? crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 32) : "");
const PORT = parseInt(process.env.PORT || "3000", 10);
let publicBase = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
// webhook | polling | standby (فقط سرور HTTP؛ وبهوک ست نمیشه و آپدیت نمی‌گیره — برای مرحله‌ی انتقال دیتابیس)
let MODE = (process.env.BOT_MODE || (publicBase ? "webhook" : "polling")).toLowerCase();
const MODE_FORCED = !!process.env.BOT_MODE;
const BACKUP_TZ = process.env.BACKUP_TZ || "Asia/Tehran";
const BACKUP_HOUR = parseInt(process.env.BACKUP_HOUR ?? "0", 10);
const ALLOWED = ["message", "callback_query", "chat_member"];

// ---------- دیتابیس ----------
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH = process.env.DB_PATH || (volume ? path.join(volume, "bot.db") : path.join(here, "data", "bot.db"));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (process.env.RAILWAY_ENVIRONMENT && !volume && !process.env.DB_PATH) {
  log("⚠️ روی Railway هیچ Volume ای وصل نیست! با هر دیپلوی دیتابیس پاک میشه. یک Volume به مسیر /data وصل کن.");
}
const sqlite = openDatabase(DB_PATH);
const SCHEMA_SQL = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
sqlite.exec(SCHEMA_SQL); // همه‌ی دستورها IF NOT EXISTS هستن
log(`🗄 دیتابیس: ${DB_PATH}`);

const kv = makeKV(sqlite); // KV سازگار با Cloudflare (کش تنظیمات و ...) روی همون دیتابیس
const reqCount = { total: 0, panel: 0, webhook: 0 };
const env = {
  ...process.env, // PANEL_PASSWORD, SESSION_SECRET, ...
  RUNTIME: "node",
  DB: createD1(sqlite),
  KV: kv,
  BOT_TOKEN,
  ADMIN_IDS,
  WEBHOOK_SECRET,
  NO_BUTTON_STYLE: process.env.NO_BUTTON_STYLE,
  BACKUP_TZ,
  PUBLIC_URL: publicBase || "",
  BOT_MODE: MODE,
  // پنل وب: بازیابی فایل SQL (همون منطق /restore/<secret>)
  RESTORE_SQL: async (bytes) => restoreSql(sqlite, toSqlText(Buffer.from(bytes)), SCHEMA_SQL),
  // پنل وب: آمار سرور
  RUNTIME_STATS: async () => {
    const mem = process.memoryUsage();
    let disk = null;
    try {
      const st = fs.statfsSync(path.dirname(DB_PATH));
      disk = { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
    } catch {}
    let dbBytes = 0;
    for (const f of [DB_PATH, `${DB_PATH}-wal`]) {
      try { dbBytes += fs.statSync(f).size; } catch {}
    }
    return {
      uptime: Math.floor((Date.now() - startedAt) / 1000), node: process.version,
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, load: os.loadavg()[0], cpus: os.cpus().length,
      dbBytes, disk, dataDir: path.dirname(DB_PATH), persistent: !!volume || !!process.env.DB_PATH,
      kv: { ...kv.stats, keys: kv.count() }, requests: { ...reqCount }, optimizer: { ...ostats },
      railway: {
        project: process.env.RAILWAY_PROJECT_NAME || null, environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
        service: process.env.RAILWAY_SERVICE_NAME || null, region: process.env.RAILWAY_REPLICA_REGION || null, domain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
      },
    };
  },
};

// ---------- حالت نصب: متغیرهای ذخیره‌شده توسط ویزارد رو می‌خونه و کد نصب رو آماده می‌کنه ----------
await resolveEnv(env);
BOT_TOKEN = env.BOT_TOKEN;
ADMIN_IDS = env.ADMIN_IDS;
WEBHOOK_SECRET = env.WEBHOOK_SECRET || WEBHOOK_SECRET;
env.WEBHOOK_SECRET = WEBHOOK_SECRET;
if (!isInstalled(env)) {
  if (!String(env.INSTALL_CODE || "").trim() || String(env.INSTALL_CODE).length < 6) {
    env.INSTALL_CODE = crypto.randomBytes(5).toString("hex"); // ۱۰ حرف
    env.INSTALL_CODE_AUTO = true;
  }
  log("════════════════════════════════════════");
  log("🛠  ربات هنوز نصب نشده. آدرس سرور + /install رو توی مرورگر باز کن.");
  log(`🔑 INSTALL CODE: ${env.INSTALL_CODE}`);
  log("════════════════════════════════════════");
}
// بعد از پایان ویزارد: سرویس‌ها (وبهوک/polling، بکاپ شبانه، پیام همگانی) رو راه می‌اندازه
env.onInstalled = async (cfg, origin) => {
  Object.assign(env, { BOT_TOKEN: cfg.BOT_TOKEN, ADMIN_IDS: cfg.ADMIN_IDS, WEBHOOK_SECRET: cfg.WEBHOOK_SECRET, PANEL_PASSWORD_HASH: cfg.PANEL_PASSWORD_HASH });
  env.__fromDb = ["BOT_TOKEN", "ADMIN_IDS", "WEBHOOK_SECRET", "PANEL_PASSWORD_HASH"];
  BOT_TOKEN = cfg.BOT_TOKEN;
  ADMIN_IDS = cfg.ADMIN_IDS;
  WEBHOOK_SECRET = cfg.WEBHOOK_SECRET;
  if (origin.startsWith("https://") && !publicBase) publicBase = origin;
  if (!MODE_FORCED) MODE = publicBase ? "webhook" : "polling";
  env.PUBLIC_URL = publicBase || "";
  env.BOT_MODE = MODE;
  invalidateInstallCfg();
  log(`✅ نصب از طریق ویزارد کامل شد (حالت: ${MODE})`);
  startServices();
};

// ---------- هندل آپدیت‌ها (همون مسیر وبهوک Worker) ----------
async function handleUpdate(update) {
  const req = new Request(`http://internal/webhook/${env.WEBHOOK_SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
  return worker.fetch(req, env);
}

// ---------- سرور HTTP (وبهوک + /health) ----------
const server = http.createServer(async (req, res) => {
  try {
    reqCount.total++;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const pathname = req.url.split("?")[0];
    // بازیابی دیتابیس: POST /restore/<WEBHOOK_SECRET> با بدنه‌ی فایل SQL (یا .gz)
    if (req.method === "POST" && WEBHOOK_SECRET && pathname === `/restore/${WEBHOOK_SECRET}`) {
      try {
        const result = restoreSql(sqlite, toSqlText(Buffer.concat(chunks)), SCHEMA_SQL);
        await invalidateSettings(env); // کش تنظیمات بعد از بازیابی باطل میشه
        log("♻️ بازیابی دیتابیس انجام شد", JSON.stringify(result));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, restored_rows: result }, null, 2));
      } catch (e) {
        console.error("restore error", e);
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
      return;
    }
    // آپدیت تلگرام: فوراً 200 + پردازش داخل صف (حذف تکراری‌ها، ترتیب هر کاربر، سقف هم‌زمانی)
    if (req.method === "POST" && isInstalled(env) && pathname === `/webhook/${WEBHOOK_SECRET}`) {
      reqCount.webhook++;
      try {
        enqueueUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8")), handleUpdate);
        res.writeHead(200).end("ok");
      } catch {
        res.writeHead(400).end("bad request");
      }
      return;
    }
    if (pathname.startsWith("/panel") || pathname.startsWith("/api/")) reqCount.panel++;
    // آدرس واقعی پشت پروکسی Railway (https و دامنه‌ی عمومی)
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0];
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env, { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error("waitUntil", e)) });
    const out = {};
    response.headers.forEach((v, k) => {
      if (k !== "set-cookie") out[k] = v;
    });
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === "HEAD") res.end();
    else Readable.fromWeb(response.body).pipe(res);
  } catch (e) {
    console.error("http error", e);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  }
});
server.listen(PORT, "0.0.0.0", () => log(`🌐 سرور روی پورت ${PORT} بالا اومد (حالت: ${MODE})`));

const tg = async (method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return r.json();
};

// ---------- وبهوک یا Long Polling ----------
async function startWebhook() {
  const url = `${publicBase}/webhook/${env.WEBHOOK_SECRET}`;
  const r = await tg("setWebhook", { url, allowed_updates: ALLOWED });
  log(r.ok ? "✅ وبهوک ست شد" : `❌ ست‌کردن وبهوک ناموفق: ${r.description}`);
}
async function startPolling() {
  await tg("deleteWebhook", { drop_pending_updates: false });
  log("🔄 Long polling شروع شد");
  let offset = 0;
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ALLOWED });
      if (!r.ok) throw new Error(r.description);
      for (const u of r.result || []) {
        offset = Math.max(offset, u.update_id + 1);
        enqueueUpdate(u, handleUpdate); // ترتیب هر کاربر حفظ میشه و آپدیت‌ها هم‌زمان پردازش میشن
      }
    } catch (e) {
      console.error("polling error", e.message);
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}
// (شروع وبهوک/polling داخل startServices() پایین فایل انجام میشه)

// ---------- بکاپ شبانه (هر شب ساعت BACKUP_HOUR به وقت BACKUP_TZ؛ پیش‌فرض ۰۰:۰۰ تهران) ----------
function nowInTz() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BACKUP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}
let backupBusy = false;
let attempts = { date: "", n: 0 };
async function backupTick() {
  if (backupBusy) return;
  const n = nowInTz();
  if (n.hour !== BACKUP_HOUR || n.minute >= 15) return; // پنجره‌ی ۱۵ دقیقه‌ای؛ اگه ربات دقیقاً نیمه‌شب ری‌استارت شد هم از دست نمیره
  if (attempts.date !== n.date) attempts = { date: n.date, n: 0 };
  if (attempts.n >= 3) return;
  const last = await env.DB.prepare("SELECT value FROM state WHERE key=?").bind("backup_last").first("value");
  if (last === n.date) return;
  backupBusy = true;
  attempts.n++;
  try {
    const r = await worker.scheduled({ cron: "node-timer" }, env);
    if (r && r.ok) {
      await env.DB.prepare(
        "INSERT INTO state (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
      ).bind("backup_last", n.date, Date.now()).run();
      log("💾 بکاپ شبانه ارسال شد");
    } else {
      log("❌ بکاپ شبانه ناموفق:", r && r.error);
    }
  } catch (e) {
    console.error("backup tick error", e);
  } finally {
    backupBusy = false;
  }
}
// ---------- پیام همگانی: کار پس‌زمینه بدون سقف (حدود ۲۵ پیام در ثانیه)؛ بعد از ری‌استارت ادامه پیدا می‌کنه ----------
let bcBusy = false;
async function broadcastLoop() {
  if (bcBusy) return;
  bcBusy = true;
  try {
    for (;;) {
      const r = await worker.scheduled({ cron: "broadcast" }, env);
      if (!r || r.idle || r.done) break;
    }
  } catch (e) {
    console.error("broadcast error", e);
  } finally {
    bcBusy = false;
  }
}
env.kickBroadcast = () => {
  broadcastLoop();
};

// ---------- راه‌اندازی سرویس‌های ربات (فقط بعد از نصب؛ یک‌بار) ----------
let servicesStarted = false;
function startServices() {
  if (servicesStarted || !isInstalled(env)) return;
  servicesStarted = true;
  if (MODE === "webhook") {
    if (!publicBase) {
      console.error("❌ حالت webhook نیاز به PUBLIC_URL یا دامنه‌ی عمومی Railway داره.");
      process.exit(1);
    }
    startWebhook().catch((e) => console.error(e));
  } else if (MODE === "standby") {
    log("⏸ حالت standby: وبهوک ست نشد و آپدیتی دریافت نمیشه. بعد از بازیابی دیتابیس، BOT_MODE رو حذف کن یا webhook بذار.");
  } else {
    startPolling().catch((e) => console.error(e));
  }
  if (MODE !== "standby") {
    broadcastLoop(); // اگه کاری نصفه مونده بود ادامه میده
    setInterval(() => backupTick().catch(() => {}), 30 * 1000);
    log(`⏰ بکاپ شبانه: هر شب ساعت ${String(BACKUP_HOUR).padStart(2, "0")}:00 (${BACKUP_TZ})`);
  }
}
startServices();

// ---------- نگهداری ساعتی: پاکسازی KV منقضی‌شده و توکن‌های ورود پنل ----------
setInterval(() => {
  try { kv.purge(); } catch {}
  worker.scheduled({ cron: "web-clean" }, env).catch(() => {});
}, 3600 * 1000).unref();

// ---------- خاموش‌شدن تمیز ----------
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} — بستن دیتابیس و خروج`);
    server.close();
    try {
      sqlite.close();
    } catch {}
    process.exit(0);
  });
}
