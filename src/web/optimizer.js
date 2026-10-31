/**
 * بهینه‌ساز درخواست‌ها (مشترک بین Cloudflare و Railway)
 * ----------------------------------------------------
 * ۱) همه‌ی تنظیمات ربات (جدول settings) با «یک» کوئری خونده میشه و در حافظه کش میشه
 *    (به‌جای یک کوئری برای هر getSetting) ← کمتر شدن تماس‌های D1 در هر درخواست.
 * ۲) اگه KV به Worker وصل باشه، یه نسخه‌ی مشترک (snapshot) از تنظیمات توی KV هم نگه داشته میشه
 *    تا isolate های مختلف بدون رفتن سراغ D1 تنظیمات رو بگیرن. KV فقط موقع «تغییر تنظیمات» نوشته میشه
 *    (سقف نوشتن KV روی پلن رایگان ۱۰۰۰ بار در روزه).
 * ۳) شمارنده‌های سبک برای نمایش در پنل (hit/miss).
 *
 * KV اختیاریه؛ اگه نباشه همه‌چی فقط با کش حافظه کار می‌کنه.
 */

const MEM_TTL = 15_000; // ms
const KV_KEY = "settings:snap";
const KV_TTL = 3600; // s — خودترمیمی: اگه کسی مستقیم دیتابیس رو دستکاری کرد، حداکثر یک ساعت بعد درست میشه

export const stats = { memHit: 0, kvHit: 0, dbLoad: 0, kvWrite: 0, kvErr: 0, invalidations: 0 };

let snap = null; // { map, exp }
let inflight = null;

async function fromDb(env) {
  stats.dbLoad++;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const map = {};
  for (const r of results || []) map[r.key] = r.value;
  return map;
}

async function kvPut(env, map) {
  if (!env.KV) return;
  try {
    await env.KV.put(KV_KEY, JSON.stringify(map), { expirationTtl: KV_TTL });
    stats.kvWrite++;
  } catch {
    stats.kvErr++;
  }
}

export async function loadSettings(env) {
  const now = Date.now();
  if (snap && snap.exp > now) {
    stats.memHit++;
    return snap.map;
  }
  if (inflight) return inflight; // چند درخواست همزمان = یک بار بارگذاری
  inflight = (async () => {
    let map = null;
    if (env.KV) {
      try {
        const j = await env.KV.get(KV_KEY, "json");
        if (j && typeof j === "object") {
          map = j;
          stats.kvHit++;
        }
      } catch {
        stats.kvErr++;
      }
    }
    if (!map) {
      map = await fromDb(env);
      await kvPut(env, map);
    }
    snap = { map, exp: Date.now() + MEM_TTL };
    return map;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export async function getSettingCached(env, key, fallback = "") {
  const map = await loadSettings(env);
  return Object.prototype.hasOwnProperty.call(map, key) && map[key] !== null ? map[key] : fallback;
}

export async function setSettingCached(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(key, value).run();
  // کش رو همین‌جا به‌روز می‌کنیم (بدون کوئری اضافه)
  const map = { ...(snap?.map || (await fromDb(env))) };
  map[key] = value;
  snap = { map, exp: Date.now() + MEM_TTL };
  await kvPut(env, map);
}

/** بعد از ریستور/تغییر مستقیم دیتابیس صدا زده میشه */
export async function invalidateSettings(env) {
  stats.invalidations++;
  snap = null;
  if (env.KV) {
    try {
      await env.KV.delete(KV_KEY);
    } catch {
      stats.kvErr++;
    }
  }
}

/** کش عمومی کوچک (حافظه ← KV) برای چیزهای سنگین مثل آمار Cloudflare */
const memCache = new Map();
export async function cacheJson(env, key, ttlSec, loader) {
  const now = Date.now();
  const m = memCache.get(key);
  if (m && m.exp > now) return m.v;
  if (env.KV) {
    try {
      const j = await env.KV.get(`c:${key}`, "json");
      if (j) {
        memCache.set(key, { v: j, exp: now + Math.min(ttlSec, 60) * 1000 });
        return j;
      }
    } catch {
      stats.kvErr++;
    }
  }
  const v = await loader();
  memCache.set(key, { v, exp: now + ttlSec * 1000 });
  if (env.KV) {
    try {
      await env.KV.put(`c:${key}`, JSON.stringify(v), { expirationTtl: Math.max(60, ttlSec) });
      stats.kvWrite++;
    } catch {
      stats.kvErr++;
    }
  }
  return v;
}
export function dropCache(key) {
  memCache.delete(key);
}
