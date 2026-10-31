/**
 * ورودی Railway: همون Worker (src/index.js) رو روی Node اجرا می‌کنه.
 * Env لازم: BOT_TOKEN, ADMIN_IDS, WEBHOOK_SECRET  (+ PANEL_PASSWORD برای ورود به پنل)
 * ذخیره‌سازی: SQLite روی Volume (مسیر DATA_DIR، پیش‌فرض /data)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { openDatabase, makeD1, makeKV, applySchema } from "./db.js";
import { installFetchOptimizer, enqueueUpdate, ostats } from "./optimizer.js";
import worker, { internals } from "../src/index.js";
import { runScheduled } from "../src/web/api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(here, "..", "data"));
const PORT = Number(process.env.PORT || 3000);
const started = Date.now();

installFetchOptimizer();

const db = openDatabase(path.join(DATA_DIR, "bot.sqlite"));
applySchema(db, path.join(here, "..", "schema.sql"));
const kv = makeKV(db);

const publicUrl =
  (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/+$/, "");

const reqCount = { total: 0, panel: 0, webhook: 0 };

const env = {
  ...process.env,
  RUNTIME: "node",
  PUBLIC_URL: publicUrl,
  DB: makeD1(db),
  KV: kv,
  // آپدیت‌های تلگرام فورا 200 می‌گیرن و داخل صف بهینه‌ساز پردازش میشن
  WEBHOOK_HOOK: async (request, processFn) => {
    reqCount.webhook++;
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    enqueueUpdate(update, processFn);
    return new Response("ok");
  },
  RUNTIME_STATS: async () => {
    const mem = process.memoryUsage();
    let disk = null;
    try {
      const s = fs.statfsSync(DATA_DIR);
      disk = { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch {}
    let dbBytes = 0;
    try {
      for (const f of ["bot.sqlite", "bot.sqlite-wal"]) dbBytes += fs.statSync(path.join(DATA_DIR, f)).size;
    } catch {}
    return {
      uptime: Math.floor((Date.now() - started) / 1000),
      node: process.version,
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
      load: os.loadavg()[0], cpus: os.cpus().length,
      dbBytes, disk, dataDir: DATA_DIR,
      persistent: DATA_DIR === "/data" || !!process.env.DATA_DIR,
      kv: { ...kv.stats, keys: kv.count() },
      requests: { ...reqCount },
      optimizer: { ...ostats },
      railway: {
        project: process.env.RAILWAY_PROJECT_NAME || null,
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
        service: process.env.RAILWAY_SERVICE_NAME || null,
        region: process.env.RAILWAY_REPLICA_REGION || null,
        domain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
      },
    };
  },
};

const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error("waitUntil", e)) };

const server = http.createServer(async (req, res) => {
  try {
    reqCount.total++;
    const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0];
    const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).toString().split(",")[0];
    const url = `${proto}://${host}${req.url}`;
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const chunks = [];
    if (hasBody) {
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 60 * 1024 * 1024) {
          res.writeHead(413).end("too large");
          return;
        }
        chunks.push(c);
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const request = new Request(url, { method: req.method, headers, body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined });
    if (req.url.startsWith("/panel") || req.url.startsWith("/api/")) reqCount.panel++;
    const response = await worker.fetch(request, env, ctx);
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
    console.error("server error", e);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ ربات روی پورت ${PORT} بالا اومد — دیتابیس: ${DATA_DIR}`);
  if (!process.env.BOT_TOKEN) console.warn("⚠️ BOT_TOKEN ست نشده");
  if (!fs.existsSync("/data") && !process.env.DATA_DIR) console.warn("⚠️ Volume وصل نیست؛ با هر دیپلوی دیتابیس پاک میشه. یک Volume روی /data بساز.");
  // ست‌کردن خودکار وبهوک (برای خاموش کردن: AUTO_WEBHOOK=0)
  if (process.env.AUTO_WEBHOOK !== "0" && publicUrl.startsWith("https://") && process.env.BOT_TOKEN && process.env.WEBHOOK_SECRET) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${publicUrl}/webhook/${process.env.WEBHOOK_SECRET}`, allowed_updates: ["message", "callback_query", "chat_member"] }),
      });
      const j = await r.json();
      console.log(j.ok ? "🔗 وبهوک تنظیم شد" : `⚠️ setWebhook: ${j.description}`);
    } catch (e) {
      console.warn("setWebhook failed", e.message);
    }
  }
});

// کارهای زمان‌بندی‌شده: بکاپ خودکار + پاکسازی KV (هر ساعت)
setInterval(() => {
  try { kv.purge(); } catch {}
  runScheduled(env, internals).catch((e) => console.error("scheduled", e));
}, 3600_000).unref();

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
const stop = () => {
  server.close(() => {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
