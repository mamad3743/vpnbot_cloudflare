/**
 * بهینه‌ساز درخواست‌های خروجی روی Railway
 * ----------------------------------------
 * ۱) تلگرام: صف با سقف نرخ (جهانی ~۲۵ در ثانیه + فاصله‌ی کوتاه برای هر چت) و تلاش مجدد خودکار روی 429 (retry_after)
 *    ← پیام همگانی برای هزاران کاربر بدون خطای Flood کار می‌کنه.
 * ۲) درخواست‌های GET یکسان و هم‌زمان (مثل استعلام مصرف از پنل‌ها) فقط «یک بار» ارسال میشن (coalescing).
 * ۳) تایم‌اوت پیش‌فرض ۲۵ ثانیه روی همه‌ی درخواست‌های خروجی.
 * ۴) آپدیت‌های ورودی تلگرام: حذف تکراری‌ها (update_id) + صف ترتیبی برای هر کاربر (جلوگیری از race روی state) + سقف هم‌زمانی.
 */
export const ostats = {
  tgSent: 0, tg429: 0, tgQueued: 0, coalesced: 0, outbound: 0, timeouts: 0,
  updates: 0, dupes: 0, queueMax: 0,
};

const realFetch = globalThis.fetch.bind(globalThis);
const GLOBAL_PER_SEC = 25;
const CHAT_GAP_MS = 350;

let tokens = GLOBAL_PER_SEC;
let lastRefill = Date.now();
const waiters = [];
const chatNext = new Map();

function refill() {
  const now = Date.now();
  tokens = Math.min(GLOBAL_PER_SEC, tokens + ((now - lastRefill) / 1000) * GLOBAL_PER_SEC);
  lastRefill = now;
}
async function acquire(chatKey) {
  // فاصله‌ی هر چت
  if (chatKey) {
    const now = Date.now();
    const at = Math.max(now, chatNext.get(chatKey) || 0);
    chatNext.set(chatKey, at + CHAT_GAP_MS);
    if (chatNext.size > 5000) for (const [k, v] of chatNext) if (v < now) chatNext.delete(k);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    ostats.tgQueued++;
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / GLOBAL_PER_SEC) * 1000) + 5));
  }
}

const SEND_RE = /\/bot[^/]+\/(send\w+|edit\w+|copyMessage|forwardMessage|createForumTopic)$/;
async function chatKeyOf(init) {
  try {
    const b = init?.body;
    if (typeof b === "string") return String(JSON.parse(b).chat_id ?? "");
    if (b instanceof FormData) return String(b.get("chat_id") ?? "");
  } catch {}
  return "";
}

const inflight = new Map();

async function optimizedFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url);
  const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
  const withTimeout = (i) => (i.signal ? i : { ...i, signal: AbortSignal.timeout(25000) });
  ostats.outbound++;

  if (u.hostname === "api.telegram.org") {
    const isSend = SEND_RE.test(u.pathname);
    const key = isSend ? await chatKeyOf(init) : "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (isSend) await acquire(key);
      let res;
      try {
        res = await realFetch(url, withTimeout(init));
      } catch (e) {
        if (e?.name === "TimeoutError") ostats.timeouts++;
        throw e;
      }
      if (isSend) ostats.tgSent++;
      if (res.status === 429 && attempt < 3) {
        ostats.tg429++;
        const j = await res.clone().json().catch(() => ({}));
        const wait = Math.min(30, Number(j?.parameters?.retry_after) || 2);
        await new Promise((r) => setTimeout(r, wait * 1000 + 100));
        continue;
      }
      return res;
    }
  }

  if (method === "GET" && !init.signal) {
    const k = `${url}|${JSON.stringify(init.headers || {})}`;
    const hit = inflight.get(k);
    if (hit) {
      ostats.coalesced++;
      return (await hit).clone();
    }
    const p = realFetch(url, withTimeout(init));
    inflight.set(k, p);
    try {
      return (await p).clone();
    } finally {
      inflight.delete(k);
    }
  }
  try {
    return await realFetch(url, withTimeout(init));
  } catch (e) {
    if (e?.name === "TimeoutError") ostats.timeouts++;
    throw e;
  }
}

export function installFetchOptimizer() {
  globalThis.fetch = optimizedFetch;
}

// ---------- صف آپدیت‌های ورودی ----------
const seen = new Map(); // update_id -> ts
const chains = new Map(); // key -> Promise
let running = 0;
const MAX_CONCURRENT = 24;
const pending = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((res) => pending.push(res));
}
function releaseSlot() {
  const next = pending.shift();
  if (next) next();
  else running--;
}

export function enqueueUpdate(update, process) {
  ostats.updates++;
  const id = update.update_id;
  const now = Date.now();
  if (id !== undefined) {
    if (seen.has(id)) {
      ostats.dupes++;
      return;
    }
    seen.set(id, now);
    if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 600000) seen.delete(k);
  }
  const from = update.message?.from?.id || update.callback_query?.from?.id || update.chat_member?.from?.id;
  const key = from ? `u${from}` : `x${id}`;
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    await acquireSlot();
    try {
      await process(update);
    } catch (e) {
      console.error("update failed", e);
    } finally {
      releaseSlot();
    }
  });
  chains.set(key, next);
  ostats.queueMax = Math.max(ostats.queueMax, chains.size);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}
