/**
 * Network helper with:
 * 1. Fast in-memory TTL cache (`revalidate` seconds, default 60s) + in-flight
 *    request deduplication so page loads, refreshes, and API routes share one
 *    fetch without hammering disk cache or external APIs,
 * 2. Direct DNS-over-HTTPS (Cloudflare 1.1.1.1 + Google 8.8.8.8) routing for
 *    ISP-blocked CEX domains (binance.com, bybit.com, okx.com, gateio.ws) so
 *    we don't waste time waiting on ISP sinkhole timeouts/resets,
 * 3. Stale-while-revalidate fallback (up to 30m) if a venue momentarily times out.
 */

import dns from "node:dns";
import https from "node:https";
import zlib from "node:zlib";

const dohCache = new Map<string, string>();
const dohInFlight = new Map<string, Promise<string | null>>();
const responseCache = new Map<string, { data: unknown; ts: number }>();
const inFlightRequests = new Map<string, Promise<unknown>>();

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
});

/** Max age (ms) for serving a cached response when live attempts fail. */
const STALE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Domains hijacked by Indonesian ISPs (Internet Positif) -> skip native fetch & go straight to DoH locally. */
const DOH_FIRST_DOMAINS = [
  "binance.com",
  "bybit.com",
  "bytick.com",
  "bybitglobal.com",
  "okx.com",
  "gateio.ws",
];

function needsDohFirst(urlStr: string): boolean {
  if (process.env.VERCEL) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return DOH_FIRST_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

interface DohResponse {
  Answer?: Array<{ type?: number; data?: string }>;
}

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  revalidate?: number;
  timeoutMs?: number;
  retries?: number;
}

/** Clear the fresh in-memory cache so the next scan fetches live rates. */
export function invalidateFetchCache(): void {
  // Expire timestamps rather than deleting so stale fallback still has data if a venue is down.
  const expiredTs = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of responseCache.entries()) {
    responseCache.set(k, { data: v.data, ts: Math.min(v.ts, expiredTs) });
  }
}

function queryDohEndpoint(
  dohHost: string,
  path: string,
  servername: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: dohHost,
        servername,
        path,
        agent: httpsAgent,
        headers: {
          Host: servername,
          Accept: "application/dns-json",
          "User-Agent": "funding-charge-v2/1.0",
        },
        timeout: 4000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw) as DohResponse;
            const ip = parsed.Answer?.find((a) => a.type === 1 && a.data)?.data;
            if (ip) {
              resolve(ip);
              return;
            }
          } catch {
            // Fall through to null.
          }
          resolve(null);
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function resolveViaDoh(hostname: string): Promise<string | null> {
  const cached = dohCache.get(hostname);
  if (cached) return Promise.resolve(cached);

  const existing = dohInFlight.get(hostname);
  if (existing) return existing;

  const q = encodeURIComponent(hostname);
  const promise = (async () => {
    const cf = queryDohEndpoint(
      "1.1.1.1",
      `/dns-query?name=${q}&type=A`,
      "cloudflare-dns.com",
    );
    const gg = queryDohEndpoint(
      "8.8.8.8",
      `/resolve?name=${q}&type=A`,
      "dns.google",
    );
    const first = await Promise.all([cf, gg]);
    const ip = first[0] ?? first[1];
    if (ip) {
      dohCache.set(hostname, ip);
    }
    dohInFlight.delete(hostname);
    return ip;
  })();

  dohInFlight.set(hostname, promise);
  return promise;
}

function httpsRequestJsonWithDoh<T>(
  urlStr: string,
  opts: {
    method: "GET" | "POST";
    bodyStr?: string;
    headers?: Record<string, string>;
    timeoutMs: number;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders: Record<string, string> = {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      ...(opts.headers ?? {}),
    };
    if (opts.bodyStr !== undefined) {
      reqHeaders["Content-Type"] = reqHeaders["Content-Type"] ?? "application/json";
      reqHeaders["Content-Length"] = String(Buffer.byteLength(opts.bodyStr));
    }

    const req = https.request(
      {
        method: opts.method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: reqHeaders,
        agent: httpsAgent,
        timeout: opts.timeoutMs,
        lookup: (hostname, options, cb) => {
          const lookupOpts = typeof options === "object" && options !== null ? options : {};
          const wantAll = Boolean((lookupOpts as dns.LookupOptions).all);
          resolveViaDoh(hostname).then((ip) => {
            if (ip) {
              if (wantAll) {
                cb(null, [{ address: ip, family: 4 }]);
              } else {
                cb(null, ip, 4);
              }
              return;
            }
            dns.lookup(hostname, { ...lookupOpts, family: 4 }, cb as never);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${u.hostname} HTTP ${status}`));
            return;
          }
          try {
            let buf = Buffer.concat(chunks);
            const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
            if (enc === "gzip") buf = zlib.gunzipSync(buf);
            else if (enc === "deflate") buf = zlib.inflateSync(buf);
            else if (enc === "br") buf = zlib.brotliDecompressSync(buf);
            resolve(JSON.parse(buf.toString("utf8")) as T);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Request to ${u.hostname} timed out`));
    });
    if (opts.bodyStr !== undefined) {
      req.write(opts.bodyStr);
    }
    req.end();
  });
}

async function attemptFetch<T>(
  url: string,
  method: "GET" | "POST",
  bodyStr: string | undefined,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<T> {
  if (needsDohFirst(url)) {
    return httpsRequestJsonWithDoh<T>(url, {
      method,
      bodyStr,
      headers,
      timeoutMs,
    });
  }

  try {
    const reqHeaders: Record<string, string> = {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json",
      ...(headers ?? {}),
    };
    if (bodyStr !== undefined) {
      reqHeaders["Content-Type"] = reqHeaders["Content-Type"] ?? "application/json";
    }
    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: bodyStr,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return httpsRequestJsonWithDoh<T>(url, {
      method,
      bodyStr,
      headers,
      timeoutMs,
    });
  }
}

/**
 * Fetch JSON with fast in-memory TTL cache, in-flight deduplication, DoH-routed
 * IPv4 fallback, and last-known-good stale cache fallback if all attempts fail.
 */
export async function fetchJson<T>(
  url: string,
  revalidateOrOpts: number | FetchJsonOptions = 60,
  timeoutMsArg = 8000,
): Promise<T> {
  const opts: FetchJsonOptions =
    typeof revalidateOrOpts === "number"
      ? { revalidate: revalidateOrOpts, timeoutMs: timeoutMsArg }
      : revalidateOrOpts;

  const method = opts.method ?? "GET";
  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const revalidateMs = (opts.revalidate ?? 60) * 1000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 1;

  const cacheKey = `${method}:${url}:${bodyStr ?? ""}`;

  // 1. Serve immediately from in-memory cache if still within TTL
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < revalidateMs) {
    return cached.data as T;
  }

  // 2. Deduplicate concurrent identical requests
  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    return inFlight as Promise<T>;
  }

  const run = (async (): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const data = await attemptFetch<T>(
          url,
          method,
          bodyStr,
          opts.headers,
          timeoutMs,
        );
        responseCache.set(cacheKey, { data, ts: Date.now() });
        return data;
      } catch (e) {
        lastErr = e;
      }
    }

    const stale = responseCache.get(cacheKey);
    if (stale && Date.now() - stale.ts <= STALE_FALLBACK_MAX_AGE_MS) {
      return stale.data as T;
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })().finally(() => {
    inFlightRequests.delete(cacheKey);
  });

  inFlightRequests.set(cacheKey, run);
  return run;
}
