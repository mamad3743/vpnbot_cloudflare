/**
 * اتصال به پنل‌های VPN: Marzban / PasarGuard / 3x-ui (سنایی)
 * endpoint ها از کد کتابخانه‌های رسمی هر پنل استخراج شده.
 *
 * هر تابع عمومی در صورت خطا PanelError با پیام فارسی می‌اندازه.
 */

const GB = 1024 ** 3;

export const PANEL_TYPES = {
  marzban: "Marzban",
  pasarguard: "PasarGuard",
  sanaei: "3x-ui (سنایی)",
};

export class PanelError extends Error {}

const tokenCache = new Map(); // key -> { value, exp }

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");

export function isIpHost(url) {
  try {
    const h = new URL(url).hostname;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h.includes(":");
  } catch {
    return false;
  }
}
export function customPort(url) {
  try {
    const u = new URL(url);
    return u.port && !["80", "443"].includes(u.port) ? u.port : "";
  } catch {
    return "";
  }
}

export function hydratePanel(row) {
  if (!row) return null;
  let extra = {};
  try {
    extra = row.extra ? JSON.parse(row.extra) : {};
  } catch {
    extra = {};
  }
  return { ...row, extra };
}

export function randomId(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

// ---------- ابزار شبکه ----------
function explainNetworkError(e) {
  const m = String(e?.message || e);
  if (/abort/i.test(m)) return "پنل جواب نداد (timeout). آدرس/پورت یا فایروال سرور رو چک کن.";
  if (/1003|direct ip/i.test(m)) return "آدرس IP خام قابل قبول نیست؛ باید دامنه بدی.";
  if (/certificate|ssl|tls|handshake/i.test(m)) return "گواهی SSL پنل معتبر نیست (باید SSL واقعی روی دامنه داشته باشه، نه self-signed).";
  return `خطای اتصال: ${m}`;
}

function explainHttpFailure(r) {
  if (/1003/.test(r.text || "")) return "Cloudflare اجازه اتصال مستقیم به IP نمیده؛ دامنه بده.";
  if (/^5(2\d|3\d)$/.test(String(r.status))) return `سرور پنل در دسترس نیست (کد ${r.status}). پورت/دامنه/Tunnel رو چک کن.`;
  if (r.status === 401 || r.status === 403) return "نام کاربری/رمز اشتباهه یا دسترسی رد شد.";
  if (r.status === 404) return "مسیر پیدا نشد (آدرس یا مسیر مخفی پنل یا نسخه پنل رو چک کن).";
  const detail = r.json?.detail || r.json?.msg || r.json?.message;
  if (detail) return typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 160);
  return `کد ${r.status}: ${(r.text || "").slice(0, 100)}`;
}

async function http(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
    return { status: res.status, ok: res.ok, text, json, setCookies };
  } catch (e) {
    throw new PanelError(explainNetworkError(e));
  } finally {
    clearTimeout(timer);
  }
}

function normExpire(v) {
  if (!v) return 0;
  if (typeof v === "number") return v > 1e11 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : Math.floor(t / 1000);
}

function normalizeSubUrl(panel, u) {
  if (!u) return "";
  const subBase = panel.extra?.sub_base ? trimSlash(panel.extra.sub_base) : "";
  let path = u;
  if (/^https?:\/\//i.test(u)) {
    if (!subBase) return u;
    try {
      const p = new URL(u);
      path = p.pathname + p.search;
    } catch {
      return u;
    }
  }
  const base = subBase || trimSlash(panel.base_url);
  return base + (path.startsWith("/") ? path : "/" + path);
}

// ======================= Marzban / PasarGuard =======================
async function mzToken(panel, force = false) {
  const key = `mz:${trimSlash(panel.base_url)}:${panel.username}`;
  const c = tokenCache.get(key);
  if (!force && c && c.exp > Date.now()) return c.value;
  const body = new URLSearchParams({ grant_type: "password", username: panel.username, password: panel.password });
  const r = await http(`${trimSlash(panel.base_url)}/api/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!r.ok || !r.json?.access_token) throw new PanelError(`ورود به پنل ناموفق: ${explainHttpFailure(r)}`);
  tokenCache.set(key, { value: r.json.access_token, exp: Date.now() + 20 * 60 * 1000 });
  return r.json.access_token;
}

async function mzReq(panel, method, path, jsonBody) {
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await mzToken(panel, attempt > 0);
    r = await http(`${trimSlash(panel.base_url)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    });
    if (r.status !== 401) return r;
  }
  return r;
}

async function pgAllGroupIds(panel) {
  const r = await mzReq(panel, "GET", "/api/groups/simple?all=true");
  if (!r.ok) throw new PanelError(`دریافت گروه‌ها ناموفق: ${explainHttpFailure(r)}`);
  const ids = (r.json?.groups || []).map((g) => g.id);
  if (!ids.length) throw new PanelError("هیچ گروهی در پنل PasarGuard تعریف نشده (اول یه گروه با اینباند بساز).");
  return ids;
}

async function mzCreate(panel, { username, gb, days, note }) {
  const ex = panel.extra || {};
  const bytes = gb > 0 ? Math.round(gb * GB) : 0;
  const expire = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
  let payload;
  if (panel.type === "marzban") {
    const protos = ex.protocols && ex.protocols.length ? ex.protocols : ["vless"];
    const proxies = {};
    for (const p of protos) proxies[p] = p === "vless" && ex.flow ? { flow: ex.flow } : {};
    payload = {
      username,
      proxies,
      inbounds: ex.inbounds || {},
      expire,
      data_limit: bytes,
      data_limit_reset_strategy: "no_reset",
      status: "active",
      note: note || "",
    };
  } else {
    const groupIds = ex.group_ids && ex.group_ids.length ? ex.group_ids : await pgAllGroupIds(panel);
    payload = {
      username,
      expire,
      data_limit: bytes,
      data_limit_reset_strategy: "no_reset",
      status: "active",
      group_ids: groupIds,
      note: note || "",
    };
    if (ex.flow) payload.proxy_settings = { vless: { flow: ex.flow } };
  }
  const r = await mzReq(panel, "POST", "/api/user", payload);
  if (!r.ok || !r.json) throw new PanelError(`ساخت کاربر ناموفق: ${explainHttpFailure(r)}`);
  const subUrl = normalizeSubUrl(panel, r.json.subscription_url);
  if (!subUrl) throw new PanelError("پنل لینک اشتراک برنگردوند.");
  return { subUrl, panelUsername: username, extra: {} };
}

async function mzUsage(panel, { username }) {
  const r = await mzReq(panel, "GET", `/api/user/${encodeURIComponent(username)}`);
  if (r.status === 404) throw new PanelError("کاربر در پنل پیدا نشد (شاید حذف شده).");
  if (!r.ok || !r.json) throw new PanelError(`دریافت مصرف ناموفق: ${explainHttpFailure(r)}`);
  return {
    used: r.json.used_traffic || 0,
    total: r.json.data_limit || 0,
    expire: normExpire(r.json.expire),
    status: r.json.status || "",
  };
}

async function mzRenew(panel, { username, gb, days }) {
  const cur = await mzUsage(panel, { username });
  const now = Math.floor(Date.now() / 1000);
  const bytes = gb > 0 ? Math.round(gb * GB) : 0;
  const expire = days > 0 ? now + days * 86400 : 0; // ریست کامل: روزهای باقی‌مانده‌ی قبلی اضافه نمیشن
  const r = await mzReq(panel, "PUT", `/api/user/${encodeURIComponent(username)}`, {
    expire,
    data_limit: bytes,
    status: "active",
  });
  if (!r.ok) throw new PanelError(`تمدید ناموفق: ${explainHttpFailure(r)}`);
  const rr = await mzReq(panel, "POST", `/api/user/${encodeURIComponent(username)}/reset`);
  if (!rr.ok) throw new PanelError(`ریست حجم ناموفق: ${explainHttpFailure(rr)}`);
}

// جستجوی کاربر موجود (ساخته‌شده خارج از ربات) با نام
async function mzFind(panel, username) {
  let r = await mzReq(panel, "GET", `/api/user/${encodeURIComponent(username)}`);
  const lower = username.toLowerCase();
  if (r.status === 404 && lower !== username) r = await mzReq(panel, "GET", `/api/user/${encodeURIComponent(lower)}`);
  if (r.status === 404) return null;
  if (!r.ok || !r.json) throw new PanelError(`جستجوی کاربر ناموفق: ${explainHttpFailure(r)}`);
  const j = r.json;
  return {
    username: j.username || username,
    used: j.used_traffic || 0,
    total: j.data_limit || 0,
    expire: normExpire(j.expire),
    status: j.status || "active",
    subUrl: normalizeSubUrl(panel, j.subscription_url),
    extra: {},
  };
}

async function mzTest(panel) {
  await mzToken(panel, true);
  const me = await mzReq(panel, "GET", "/api/admin");
  const adminName = me.json?.username || panel.username;
  if (panel.type === "pasarguard") {
    const ids = await pgAllGroupIds(panel);
    return `ورود موفق ✅ | ادمین: ${adminName} | گروه‌ها: ${ids.length} (id: ${ids.join(",")})`;
  }
  const inb = await mzReq(panel, "GET", "/api/inbounds");
  const protos = inb.json ? Object.keys(inb.json) : [];
  return `ورود موفق ✅ | ادمین: ${adminName} | پروتکل‌های فعال: ${protos.join(", ") || "-"}`;
}

// ======================= 3x-ui (سنایی) =======================
function cookieHeader(setCookies, existing = {}) {
  const jar = { ...existing };
  for (const sc of setCookies || []) {
    const pair = String(sc).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}
const jarToString = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function xuiAuthHeaders(panel, force = false) {
  if (panel.api_token) {
    return { headers: { Authorization: `Bearer ${panel.api_token}`, Accept: "application/json" }, fresh: true };
  }
  const base = trimSlash(panel.base_url);
  const key = `xui:${base}:${panel.username}`;
  const c = tokenCache.get(key);
  if (!force && c && c.exp > Date.now()) return { headers: c.value, fresh: false };

  let jar = {};
  let csrf = null;
  // نسخه‌های جدید 3x-ui قبل از لاگین توکن CSRF می‌خوان؛ نسخه‌های قدیمی این مسیر رو ندارن
  try {
    const cr = await http(`${base}/csrf-token`, { headers: { Accept: "application/json" } });
    if (cr.ok && cr.json?.success && typeof cr.json.obj === "string" && cr.json.obj) {
      csrf = cr.json.obj;
      jar = cookieHeader(cr.setCookies, jar);
    }
  } catch (e) {
    if (/دامنه|IP|SSL|timeout|جواب نداد/.test(e.message)) throw e;
  }

  const form = new URLSearchParams({ username: panel.username, password: panel.password });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (Object.keys(jar).length) headers.Cookie = jarToString(jar);
  const r = await http(`${base}/login`, { method: "POST", headers, body: form.toString() });
  if (!r.json?.success) {
    throw new PanelError(`ورود به پنل ناموفق: ${r.json?.msg || explainHttpFailure(r)}`);
  }
  jar = cookieHeader(r.setCookies, jar);
  if (!Object.keys(jar).length) throw new PanelError("ورود انجام شد ولی کوکی سشن دریافت نشد.");
  const value = { Cookie: jarToString(jar), Accept: "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) };
  tokenCache.set(key, { value, exp: Date.now() + 20 * 60 * 1000 });
  return { headers: value, fresh: true };
}

async function xuiReq(panel, method, path, { form, json } = {}) {
  const base = trimSlash(panel.base_url);
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { headers: auth, fresh } = await xuiAuthHeaders(panel, attempt > 0);
    const headers = { ...auth };
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    r = await http(`${base}${path}`, { method, headers, body });
    // 3x-ui برای سشن نامعتبر 404 برمی‌گردونه. فقط اگه سشن کش‌شده بود دوباره لاگین می‌کنیم
    // (اگه همین الان لاگین کردیم، 404 یعنی مسیر وجود نداره، نه سشن منقضی)
    const looksLikeNoSession = [401, 403, 404].includes(r.status) && r.json?.success === undefined;
    if (!looksLikeNoSession || fresh) return r;
  }
  return r;
}

// بعضی نسخه‌ها فقط API کلاسیک دارن و بعضی فقط API جدید؛ نسخه‌ی کارکرده رو به‌خاطر می‌سپاریم
const xuiModeCache = new Map();
async function xuiDual(panel, legacyFn, modernFn) {
  const key = trimSlash(panel.base_url);
  const order = xuiModeCache.get(key) === "modern" ? ["modern", "legacy"] : ["legacy", "modern"];
  const fails = {};
  for (const which of order) {
    const r = await (which === "legacy" ? legacyFn() : modernFn());
    if (r.json?.success) {
      xuiModeCache.set(key, which);
      return { ok: true, r };
    }
    fails[which] = r;
  }
  return { ok: false, fails };
}

async function xuiInboundProtocol(panel) {
  const id = panel.extra?.inbound_id;
  const r = await xuiReq(panel, "GET", `/panel/api/inbounds/get/${id}`);
  if (r.json?.success && r.json.obj) return r.json.obj;
  return null;
}

function buildXuiClient(panel, { username, gb, days, note, protocol, uuid, subId, password }) {
  const ex = panel.extra || {};
  const client = {
    email: username,
    limitIp: ex.limit_ip || 0,
    totalGB: gb > 0 ? Math.round(gb * GB) : 0,
    expiryTime: days > 0 ? Date.now() + days * 86400000 : 0,
    enable: true,
    tgId: "",
    subId,
    comment: note || "",
    reset: 0,
  };
  if (protocol === "trojan") {
    client.password = password;
  } else {
    client.id = uuid;
    client.flow = protocol === "vless" ? ex.flow || "" : "";
  }
  return client;
}

async function xuiCreate(panel, { username, gb, days, note }) {
  const ex = panel.extra || {};
  if (!ex.inbound_id) throw new PanelError("آیدی اینباند برای این پنل تنظیم نشده.");
  if (!ex.sub_base) throw new PanelError("آدرس ساب (sub) برای این پنل تنظیم نشده.");
  const inbound = await xuiInboundProtocol(panel);
  const protocol = (inbound?.protocol || ex.protocol || "vless").toLowerCase();
  if (!["vless", "vmess", "trojan"].includes(protocol)) {
    throw new PanelError(`پروتکل اینباند (${protocol}) پشتیبانی نمیشه؛ فقط vless/vmess/trojan.`);
  }
  const uuid = crypto.randomUUID();
  const subId = randomId(16);
  const password = randomId(16);
  const client = buildXuiClient(panel, { username, gb, days, note, protocol, uuid, subId, password });
  const cid = protocol === "trojan" ? password : uuid;

  const res = await xuiDual(
    panel,
    () => xuiReq(panel, "POST", "/panel/api/inbounds/addClient", {
      form: { id: String(ex.inbound_id), settings: JSON.stringify({ clients: [client] }) },
    }),
    () => xuiReq(panel, "POST", "/panel/api/clients/add", { json: { client, inboundIds: [Number(ex.inbound_id)] } })
  );
  if (!res.ok) {
    const f = res.fails;
    throw new PanelError(`ساخت کلاینت ناموفق: ${f.legacy?.json?.msg || f.modern?.json?.msg || explainHttpFailure(f.modern || f.legacy)}`);
  }
  const subUrl = `${trimSlash(ex.sub_base)}/${subId}`;
  return { subUrl, panelUsername: username, extra: { cid, subId, protocol } };
}

async function xuiUsage(panel, { username }) {
  const e = encodeURIComponent(username);
  const res = await xuiDual(
    panel,
    () => xuiReq(panel, "GET", `/panel/api/inbounds/getClientTraffics/${e}`),
    () => xuiReq(panel, "GET", `/panel/api/clients/get/${e}`)
  );
  const o = res.ok ? res.r.json.obj : null;
  if (!o) throw new PanelError("کلاینت در پنل پیدا نشد (شاید حذف شده).");
  const t = o.traffic || o;
  return {
    used: (t.up || 0) + (t.down || 0),
    total: t.total || o.totalGB || 0,
    expire: o.expiryTime > 0 ? Math.floor(o.expiryTime / 1000) : 0,
    status: o.enable === false ? "disabled" : "active",
  };
}

async function xuiRenew(panel, { username, extra, gb, days }) {
  const ex = panel.extra || {};
  const cur = await xuiUsage(panel, { username });
  const now = Math.floor(Date.now() / 1000);
  const newExpireMs = days > 0 ? (now + days * 86400) * 1000 : 0; // ریست کامل: از امروز
  const protocol = extra?.protocol || "vless";
  const client = buildXuiClient(panel, {
    username, gb, days, protocol,
    uuid: extra?.cid, subId: extra?.subId, password: extra?.cid, note: "",
  });
  client.expiryTime = newExpireMs;

  const e = encodeURIComponent(username);
  const upd = await xuiDual(
    panel,
    () => xuiReq(panel, "POST", `/panel/api/inbounds/updateClient/${encodeURIComponent(extra?.cid || "")}`, {
      form: { id: String(ex.inbound_id), settings: JSON.stringify({ clients: [client] }) },
    }),
    () => xuiReq(panel, "POST", `/panel/api/clients/update/${e}`, { json: client })
  );
  if (!upd.ok) {
    const f = upd.fails;
    throw new PanelError(`تمدید ناموفق: ${f.legacy?.json?.msg || f.modern?.json?.msg || explainHttpFailure(f.modern || f.legacy)}`);
  }
  const rst = await xuiDual(
    panel,
    () => xuiReq(panel, "POST", `/panel/api/inbounds/${ex.inbound_id}/resetClientTraffic/${e}`),
    () => xuiReq(panel, "POST", `/panel/api/clients/resetTraffic/${e}`)
  );
  if (!rst.ok) {
    const f = rst.fails;
    throw new PanelError(`ریست حجم ناموفق: ${f.legacy?.json?.msg || f.modern?.json?.msg || "نامشخص"}`);
  }
}

function xuiStatus(client, used, total, expire) {
  if (client.enable === false) return "disabled";
  if (expire > 0 && expire < Date.now() / 1000) return "expired";
  if (total > 0 && used >= total) return "limited";
  return "active";
}

// جستجوی کلاینت موجود با ایمیل (نام) — اول اینباند تنظیم‌شده، بعد همه‌ی اینباندها
async function xuiFind(panel, username) {
  const ex = panel.extra || {};
  const lower = username.toLowerCase();
  const scan = (inb) => {
    let clients;
    try {
      clients = JSON.parse(inb.settings || "{}").clients || [];
    } catch {
      return null;
    }
    const c = clients.find((x) => x.email === username) || clients.find((x) => String(x.email || "").toLowerCase() === lower);
    return c ? { inbound: inb, client: c } : null;
  };
  let hit = null;
  if (ex.inbound_id) {
    const inb = await xuiInboundProtocol(panel);
    if (inb) hit = scan(inb);
  }
  if (!hit) {
    const r = await xuiReq(panel, "GET", "/panel/api/inbounds/list");
    if (r.json?.success && Array.isArray(r.json.obj)) {
      for (const inb of r.json.obj) {
        hit = scan(inb);
        if (hit) break;
      }
    } else if (r.status === 401 || r.status === 403 || (r.status === 404 && r.json?.success === undefined)) {
      throw new PanelError(`جستجو ناموفق: ${explainHttpFailure(r)}`);
    }
  }
  if (!hit) return null;
  const { inbound, client } = hit;
  let used = 0;
  let total = client.totalGB || 0;
  let expire = client.expiryTime > 0 ? Math.floor(client.expiryTime / 1000) : 0;
  try {
    const u = await xuiUsage(panel, { username: client.email });
    used = u.used;
    total = u.total || total;
    expire = u.expire || expire;
  } catch {
    // اگه آمار مصرف نیومد، با اطلاعات داخل خود کلاینت ادامه میدیم
  }
  const protocol = String(inbound.protocol || "vless").toLowerCase();
  const cid = protocol === "trojan" ? client.password : protocol === "shadowsocks" ? client.email : client.id;
  const subUrl = client.subId && ex.sub_base ? `${trimSlash(ex.sub_base)}/${client.subId}` : "";
  return {
    username: client.email,
    used,
    total,
    expire,
    status: xuiStatus(client, used, total, expire),
    subUrl,
    extra: { cid, subId: client.subId || "", protocol, inboundId: inbound.id, client },
  };
}

// تمدید کلاینت موجود: بقیه‌ی فیلدهای اون (flow، limitIp، ...) دست‌نخورده می‌مونن
async function xuiRenewExisting(panel, found, { gb, days }) {
  const { client, inboundId, cid } = found.extra;
  const now = Math.floor(Date.now() / 1000);
  const next = {
    ...client,
    totalGB: gb > 0 ? Math.round(gb * GB) : 0,
    expiryTime: days > 0 ? (now + days * 86400) * 1000 : 0, // ریست کامل: از امروز
    enable: true,
  };
  const e = encodeURIComponent(found.username);
  const upd = await xuiDual(
    panel,
    () => xuiReq(panel, "POST", `/panel/api/inbounds/updateClient/${encodeURIComponent(cid || "")}`, {
      form: { id: String(inboundId), settings: JSON.stringify({ clients: [next] }) },
    }),
    () => xuiReq(panel, "POST", `/panel/api/clients/update/${e}`, { json: next })
  );
  if (!upd.ok) {
    const f = upd.fails;
    throw new PanelError(`تمدید ناموفق: ${f.legacy?.json?.msg || f.modern?.json?.msg || explainHttpFailure(f.modern || f.legacy)}`);
  }
  const rst = await xuiDual(
    panel,
    () => xuiReq(panel, "POST", `/panel/api/inbounds/${inboundId}/resetClientTraffic/${e}`),
    () => xuiReq(panel, "POST", `/panel/api/clients/resetTraffic/${e}`)
  );
  if (!rst.ok) {
    const f = rst.fails;
    throw new PanelError(`ریست حجم ناموفق: ${f.legacy?.json?.msg || f.modern?.json?.msg || "نامشخص"}`);
  }
}

async function xuiTest(panel) {
  const ex = panel.extra || {};
  await xuiAuthHeaders(panel, true);
  const parts = ["ورود موفق ✅"];
  if (ex.inbound_id) {
    const inb = await xuiInboundProtocol(panel);
    if (!inb) throw new PanelError(`ورود موفق بود ولی اینباند #${ex.inbound_id} پیدا نشد.`);
    parts.push(`اینباند #${ex.inbound_id}: ${inb.protocol}${inb.remark ? ` (${inb.remark})` : ""} پورت ${inb.port}`);
  }
  if (!ex.sub_base) parts.push("⚠️ آدرس ساب تنظیم نشده");
  return parts.join(" | ");
}

// ======================= رابط عمومی =======================
const pick = (panel) => (panel.type === "sanaei" ? "xui" : "mz");

export async function panelCreateUser(panel, args) {
  return pick(panel) === "xui" ? xuiCreate(panel, args) : mzCreate(panel, args);
}
export async function panelUsage(panel, args) {
  return pick(panel) === "xui" ? xuiUsage(panel, args) : mzUsage(panel, args);
}
export async function panelRenew(panel, args) {
  return pick(panel) === "xui" ? xuiRenew(panel, args) : mzRenew(panel, args);
}
// جستجوی اشتراک ساخته‌شده خارج از ربات؛ null = پیدا نشد
export async function panelFindUser(panel, username) {
  return pick(panel) === "xui" ? xuiFind(panel, username) : mzFind(panel, username);
}
// تمدید اشتراک پیداشده (found خروجی panelFindUser)
export async function panelRenewExisting(panel, found, { gb, days }) {
  return pick(panel) === "xui"
    ? xuiRenewExisting(panel, found, { gb, days })
    : mzRenew(panel, { username: found.username, gb, days });
}
// اثبات مالکیت: کاربر باید لینک اشتراک واقعی رو بفرسته (توکن لینک مثل رمز عبوره)
export function subTokenOf(url) {
  const segs = String(url || "").split(/[?#]/)[0].split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1] : "";
}
export function ownsSubscription(found, pasted) {
  const tok = subTokenOf(found?.subUrl);
  return tok.length >= 8 && String(pasted || "").includes(tok);
}

export async function panelTest(panel) {
  return pick(panel) === "xui" ? xuiTest(panel) : mzTest(panel);
}
export function clearPanelCache() {
  tokenCache.clear();
  xuiModeCache.clear();
}
