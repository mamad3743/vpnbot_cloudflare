/**
 * آمار مصرف Cloudflare (Workers / KV / D1) از GraphQL Analytics API
 * نیازمند: CF_API_TOKEN (Account Analytics: Read)، CF_ACCOUNT_ID
 * اختیاری: CF_SCRIPT_NAME (پیش‌فرض: نام Worker)، D1_DATABASE_ID، KV_NAMESPACE_ID
 * هر بخش جدا کوئری میشه تا خطای یکی بقیه رو خراب نکنه.
 */
const GQL = "https://api.cloudflare.com/client/v4/graphql";

async function gql(env, query, variables) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.errors?.[0]?.message || `HTTP ${r.status}`);
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data?.viewer?.accounts?.[0] || {};
}
async function rest(env, path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j?.errors?.[0]?.message || `HTTP ${r.status}`);
  return j.result;
}
const iso = (d) => d.toISOString();
const day = (d) => d.toISOString().slice(0, 10);

export function cfConfigured(env) {
  return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

// سقف‌های پلن رایگان (برای نمایش درصد مصرف)
export const FREE_LIMITS = {
  workerRequestsDay: 100_000,
  kvReadsDay: 100_000,
  kvWritesDay: 1_000,
  kvDeletesDay: 1_000,
  kvListsDay: 1_000,
  d1RowsReadDay: 5_000_000,
  d1RowsWrittenDay: 100_000,
  d1StorageBytes: 5 * 1024 ** 3,
  kvStorageBytes: 1024 ** 3,
};

export async function cfUsage(env) {
  const out = { limits: FREE_LIMITS, errors: {} };
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // آمار کلادفلر بر اساس UTC
  const week = new Date(dayStart.getTime() - 6 * 86400000);
  const acc = env.CF_ACCOUNT_ID;
  const script = env.CF_SCRIPT_NAME || "config-sales-bot";

  const jobs = [];

  // ---- Worker ----
  jobs.push(
    (async () => {
      const q = `query($a:string!,$s:string!,$from:Time!,$to:Time!,$wk:Time!){viewer{accounts(filter:{accountTag:$a}){
        today:workersInvocationsAdaptive(limit:100,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to}){sum{requests errors subrequests} quantiles{cpuTimeP50 cpuTimeP99}}
        week:workersInvocationsAdaptive(limit:100,filter:{scriptName:$s,datetime_geq:$wk,datetime_leq:$to}){sum{requests errors subrequests}}
      }}}`;
      const d = await gql(env, q, { a: acc, s: script, from: iso(dayStart), to: iso(now), wk: iso(week) });
      const sum = (arr, k) => (arr || []).reduce((n, r) => n + (r.sum?.[k] || 0), 0);
      out.worker = {
        script,
        today: { requests: sum(d.today, "requests"), errors: sum(d.today, "errors"), subrequests: sum(d.today, "subrequests") },
        week: { requests: sum(d.week, "requests"), errors: sum(d.week, "errors") },
        cpuP50: d.today?.[0]?.quantiles?.cpuTimeP50 ?? null,
        cpuP99: d.today?.[0]?.quantiles?.cpuTimeP99 ?? null,
      };
    })().catch((e) => (out.errors.worker = String(e.message || e)))
  );

  // ---- KV ----
  if (env.KV_NAMESPACE_ID) {
    jobs.push(
      (async () => {
        const q = `query($a:string!,$n:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
          ops:kvOperationsAdaptiveGroups(limit:1000,filter:{namespaceId:$n,date_geq:$s,date_leq:$e}){sum{requests} dimensions{date actionType}}
          storage:kvStorageAdaptiveGroups(limit:10,filter:{namespaceId:$n,date_geq:$s,date_leq:$e},orderBy:[date_DESC]){max{byteCount keyCount} dimensions{date}}
        }}}`;
        const d = await gql(env, q, { a: acc, n: env.KV_NAMESPACE_ID, s: day(week), e: day(now) });
        const today = day(now);
        const t = { read: 0, write: 0, delete: 0, list: 0 };
        const series = {};
        for (const r of d.ops || []) {
          const k = r.dimensions.actionType;
          const dt = r.dimensions.date;
          series[dt] = (series[dt] || 0) + (r.sum?.requests || 0);
          if (dt === today && k in t) t[k] += r.sum?.requests || 0;
        }
        const st = d.storage?.[0];
        out.kv = { today: t, series, bytes: st?.max?.byteCount ?? null, keys: st?.max?.keyCount ?? null };
      })().catch((e) => (out.errors.kv = String(e.message || e)))
    );
  }

  // ---- D1 ----
  if (env.D1_DATABASE_ID) {
    jobs.push(
      (async () => {
        const q = `query($a:string!,$d:string!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
          ops:d1AnalyticsAdaptiveGroups(limit:100,filter:{databaseId:$d,date_geq:$s,date_leq:$e}){sum{readQueries writeQueries rowsRead rowsWritten} dimensions{date}}
          storage:d1StorageAdaptiveGroups(limit:5,filter:{databaseId:$d,date_geq:$s,date_leq:$e},orderBy:[date_DESC]){max{databaseSizeBytes} dimensions{date}}
        }}}`;
        const d = await gql(env, q, { a: acc, d: env.D1_DATABASE_ID, s: day(week), e: day(now) });
        const today = day(now);
        const t = { readQueries: 0, writeQueries: 0, rowsRead: 0, rowsWritten: 0 };
        const series = {};
        for (const r of d.ops || []) {
          const dt = r.dimensions.date;
          series[dt] = (series[dt] || 0) + (r.sum?.rowsRead || 0);
          if (dt === today) for (const k of Object.keys(t)) t[k] += r.sum?.[k] || 0;
        }
        out.d1 = { today: t, series, bytes: d.storage?.[0]?.max?.databaseSizeBytes ?? null };
      })().catch((e) => (out.errors.d1 = String(e.message || e)))
    );
  }

  await Promise.all(jobs);
  out.at = Date.now();
  return out;
}
