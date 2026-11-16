import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { bareHostname, isBlockedAddress, screenUrl } from "./ssrf.ts";

/** ENR-02: why a linked page was not captured. Gaps stay explicit; they are never silently dropped. */
export type GapReason =
  | "blocked_target"
  | "invalid_url"
  | "dns_failure"
  | "network_error"
  | "timeout"
  | "too_large"
  | "unsupported_content_type"
  | "restricted"
  | "not_found"
  | "http_error"
  | "redirect_limit"
  | "empty_content"
  | "x_post_not_saved";

export interface FetchGap {
  ok: false;
  reason: GapReason;
  detail: string;
  /** URLs visited before the failure, original first. */
  chain: string[];
  httpStatus: number | null;
}

export interface FetchedPage {
  ok: true;
  originalUrl: string;
  finalUrl: string;
  chain: string[];
  httpStatus: number;
  contentType: string;
  body: Buffer;
}

export type FetchResult = FetchedPage | FetchGap;

export interface FetchLimits {
  /** PROPOSED defaults: 5 MiB, 15 s overall, 5 redirects. */
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedContentTypes: readonly string[];
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
  allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
};

export interface GuardedFetchOptions extends Partial<FetchLimits> {
  /** Resolve a hostname once per hop. Defaults to the system resolver (all addresses). */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Test seam only: exempts specific addresses (for example a loopback test server) from the block list.
   * Production callers must leave this unset.
   */
  allowAddress?: (ip: string) => boolean;
  userAgent?: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RESTRICTED_STATUS = new Set([401, 402, 403, 451]);

class Gap extends Error {
  constructor(
    readonly reason: GapReason,
    detail: string,
    readonly httpStatus: number | null = null,
  ) {
    super(detail);
  }
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

/** Resolve a hop once and return the single validated address to connect to. */
async function resolveValidated(url: URL, opts: GuardedFetchOptions): Promise<string> {
  const host = bareHostname(url);
  const blocked = (ip: string) => isBlockedAddress(ip) && !(opts.allowAddress?.(ip) ?? false);
  if (isIP(host) !== 0) {
    if (blocked(host)) throw new Gap("blocked_target", `address ${host} is not allowed`);
    return host;
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw new Gap("dns_failure", `could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new Gap("dns_failure", `no addresses for ${host}`);
  // Every answer must be public: a mixed answer set is a rebinding signal.
  for (const ip of addresses) {
    if (blocked(ip)) throw new Gap("blocked_target", `${host} resolves to blocked address ${ip}`);
  }
  return addresses[0] as string;
}

interface Hop {
  res: IncomingMessage;
  abort: () => void;
}

function requestHop(
  url: URL,
  ip: string,
  opts: GuardedFetchOptions,
  signal: AbortSignal,
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const family = isIP(ip);
    const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = doRequest(
      {
        protocol: url.protocol,
        host: bareHostname(url),
        port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "accept-encoding": "identity",
          "user-agent": opts.userAgent ?? "CiteSpark/0 (+local linked-source fetcher)",
        },
        // Pin the connection to the address validated above; the socket never re-resolves the name.
        lookup: (_host, options, cb) => {
          const callback = cb as (...a: unknown[]) => void;
          if ((options as { all?: boolean }).all) callback(null, [{ address: ip, family }]);
          else callback(null, ip, family);
        },
        signal,
      },
      (res) => resolve({ res, abort: () => req.destroy() }),
    );
    req.on("error", reject);
    req.end();
  });
}

async function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new Gap("too_large", `content-length ${declared} exceeds ${maxBytes}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      throw new Gap("too_large", `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mimeOf(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Fetch one page with SSRF guards (ENR-03). DNS is resolved once per hop, every answer must be public,
 * the connection is pinned to the validated address, and each redirect hop is re-screened. Never throws;
 * failures become explicit gaps (ENR-02).
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<FetchResult> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...stripUndefined(options) };
  const chain: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  let current = rawUrl;
  try {
    for (let hop = 0; ; hop++) {
      const screened = screenUrl(current);
      if (!screened.ok) {
        throw new Gap(
          screened.reason === "invalid" ? "invalid_url" : "blocked_target",
          `url rejected: ${screened.reason}`,
        );
      }
      chain.push(screened.url.href);
      const ip = await resolveValidated(screened.url, options);
      const { res } = await requestHop(screened.url, ip, options, controller.signal);
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUS.has(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location) throw new Gap("http_error", "redirect without Location", status);
        if (hop >= limits.maxRedirects) {
          throw new Gap("redirect_limit", `more than ${limits.maxRedirects} redirects`, status);
        }
        try {
          current = new URL(location, screened.url).href;
        } catch {
          throw new Gap("invalid_url", "unparseable redirect target", status);
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        if (RESTRICTED_STATUS.has(status)) {
          throw new Gap("restricted", `HTTP ${status}`, status);
        }
        if (status === 404 || status === 410) throw new Gap("not_found", `HTTP ${status}`, status);
        throw new Gap("http_error", `HTTP ${status}`, status);
      }
      const contentType = mimeOf(res.headers["content-type"]);
      if (!limits.allowedContentTypes.includes(contentType)) {
        res.destroy();
        throw new Gap(
          "unsupported_content_type",
          `content-type ${contentType || "missing"} is not allowed`,
          status,
        );
      }
      const body = await readBody(res, limits.maxBytes);
      return {
        ok: true,
        originalUrl: rawUrl,
        finalUrl: screened.url.href,
        chain,
        httpStatus: status,
        contentType,
        body,
      };
    }
  } catch (e) {
    if (e instanceof Gap) {
      return { ok: false, reason: e.reason, detail: e.message, chain, httpStatus: e.httpStatus };
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: "timeout",
        detail: `exceeded ${limits.timeoutMs} ms`,
        chain,
        httpStatus: null,
      };
    }
    return {
      ok: false,
      reason: "network_error",
      detail: (e as { code?: string }).code ?? "connection failed",
      chain,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
