/**
 * Shared Stellar Horizon API client.
 *
 * Used by both the indexer and the GraphQL server's fallback paths. All
 * outbound requests are serialized through `createThrottle` so neither service
 * can burst past Horizon's per-IP rate limit, and every response is validated
 * against a runtime schema at the Horizon boundary before entering the indexer
 * or GraphQL pipelines.
 */
import { createThrottle, type RequestPurpose, type ThrottleMetrics } from './throttle';

export const PAGE_LIMIT = 200;

export interface HorizonLedger {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
  base_fee_in_stroops: number;
  base_reserve_in_stroops: number;
}

export interface HorizonTransaction {
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  fee_charged: string;
  operation_count: number;
  successful: boolean;
  memo_type: string;
  memo?: string;
}

export interface HorizonOperation {
  id: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  source_account: string;
  [key: string]: unknown;
}

export interface HorizonBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
}

export interface HorizonAccount {
  /** Horizon returns `account_id`; some legacy mocks also supply `id`. */
  id?: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  num_sponsored: number;
  num_sponsoring: number;
  balances: HorizonBalance[];
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    auth_clawback_enabled: boolean;
  };
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
}

export interface HorizonLatestLedger {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
}

/**
 * Price rational returned by Horizon for a trade execution.
 * `n` is numerator, `d` is denominator (price = n / d in counter per base unit).
 */
export interface HorizonTradePrice {
  n: string | number;
  d: string | number;
}

/**
 * Horizon `/trades` record shape.
 */
export interface HorizonTrade {
  id: string;
  paging_token: string;
  ledger_close_time: string;
  offer_id?: string;
  trade_type?: string;
  liquidity_pool_fee_bp?: number;
  base_liquidity_pool_id?: string;
  base_offer_id?: string;
  base_account: string;
  base_amount: string;
  base_asset_type: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_liquidity_pool_id?: string;
  counter_offer_id?: string;
  counter_account?: string;
  counter_amount: string;
  counter_asset_type: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  base_is_seller?: boolean;
  price?: HorizonTradePrice;
}

/**
 * Query parameters for fetching trades from Horizon `/trades`.
 */
export interface HorizonTradesFilter {
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  baseAssetType?: string;
  baseAssetCode?: string;
  baseAssetIssuer?: string;
  counterAssetType?: string;
  counterAssetCode?: string;
  counterAssetIssuer?: string;
  offerId?: string;
  accountId?: string;
}

export interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links?: { next?: { href: string } };
}

export interface HorizonLogger {
  info?(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

/**
 * Error thrown when a Horizon response payload is missing a required field or
 * has a field of the wrong runtime type. Retains the offending `field` path,
 * request `url`, and `rawResponse` body so callers and logs can diagnose the
 * exact payload that failed validation before it reaches database writes.
 */
export class HorizonValidationError extends Error {
  readonly field: string;
  readonly url: string;
  readonly rawResponse: unknown;

  constructor(field: string, reason: string, rawResponse: unknown, url = '') {
    const location = url ? ` from ${url}` : '';
    super(`Malformed Horizon response${location}: invalid or missing field "${field}" (${reason})`);
    this.name = 'HorizonValidationError';
    this.field = field;
    this.url = url;
    this.rawResponse = rawResponse;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(
  value: unknown,
  field: string,
  rawResponse: unknown,
  url: string
): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new HorizonValidationError(
      field,
      `expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
      rawResponse,
      url
    );
  }
  return value;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  prefix: string,
  rawResponse: unknown,
  url: string
): string {
  const path = prefix ? `${prefix}.${key}` : key;
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new HorizonValidationError(
      path,
      val === undefined
        ? 'required string is missing'
        : `expected non-empty string, got ${val === null ? 'null' : typeof val}`,
      rawResponse,
      url
    );
  }
  return val;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  prefix: string,
  rawResponse: unknown,
  url: string
): number {
  const path = prefix ? `${prefix}.${key}` : key;
  const val = obj[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new HorizonValidationError(
      path,
      val === undefined
        ? 'required number is missing'
        : `expected finite number, got ${val === null ? 'null' : typeof val}`,
      rawResponse,
      url
    );
  }
  return val;
}

function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  prefix: string,
  rawResponse: unknown,
  url: string
): boolean {
  const path = prefix ? `${prefix}.${key}` : key;
  const val = obj[key];
  if (typeof val !== 'boolean') {
    throw new HorizonValidationError(
      path,
      val === undefined
        ? 'required boolean is missing'
        : `expected boolean, got ${val === null ? 'null' : typeof val}`,
      rawResponse,
      url
    );
  }
  return val;
}

/**
 * Validates a Horizon ledger summary (`HorizonLatestLedger`).
 */
export function validateHorizonLatestLedger(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonLatestLedger {
  const obj = requireObject(raw, prefix || 'ledger', rootRaw, url);
  requireNumber(obj, 'sequence', prefix, rootRaw, url);
  requireString(obj, 'closed_at', prefix, rootRaw, url);
  requireNumber(obj, 'successful_transaction_count', prefix, rootRaw, url);
  requireNumber(obj, 'failed_transaction_count', prefix, rootRaw, url);
  requireNumber(obj, 'operation_count', prefix, rootRaw, url);
  return obj as unknown as HorizonLatestLedger;
}

/**
 * Validates a full Horizon ledger record (`HorizonLedger`).
 */
export function validateHorizonLedger(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonLedger {
  const obj = requireObject(raw, prefix || 'ledger', rootRaw, url);
  validateHorizonLatestLedger(obj, url, prefix, rootRaw);
  requireNumber(obj, 'base_fee_in_stroops', prefix, rootRaw, url);
  requireNumber(obj, 'base_reserve_in_stroops', prefix, rootRaw, url);
  return obj as unknown as HorizonLedger;
}

/**
 * Validates a Horizon transaction record (`HorizonTransaction`).
 */
export function validateHorizonTransaction(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonTransaction {
  const obj = requireObject(raw, prefix || 'transaction', rootRaw, url);
  requireString(obj, 'hash', prefix, rootRaw, url);
  requireNumber(obj, 'ledger', prefix, rootRaw, url);
  requireString(obj, 'created_at', prefix, rootRaw, url);
  requireString(obj, 'source_account', prefix, rootRaw, url);
  requireString(obj, 'fee_charged', prefix, rootRaw, url);
  requireNumber(obj, 'operation_count', prefix, rootRaw, url);
  requireBoolean(obj, 'successful', prefix, rootRaw, url);
  requireString(obj, 'memo_type', prefix, rootRaw, url);
  if (obj['memo'] !== undefined && obj['memo'] !== null && typeof obj['memo'] !== 'string') {
    const path = prefix ? `${prefix}.memo` : 'memo';
    throw new HorizonValidationError(path, `expected string, got ${typeof obj['memo']}`, rootRaw, url);
  }
  return obj as unknown as HorizonTransaction;
}

/**
 * Validates a Horizon operation record (`HorizonOperation`).
 */
export function validateHorizonOperation(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonOperation {
  const obj = requireObject(raw, prefix || 'operation', rootRaw, url);
  requireString(obj, 'id', prefix, rootRaw, url);
  requireString(obj, 'type', prefix, rootRaw, url);
  requireString(obj, 'transaction_hash', prefix, rootRaw, url);
  requireString(obj, 'created_at', prefix, rootRaw, url);
  requireString(obj, 'source_account', prefix, rootRaw, url);
  return obj as unknown as HorizonOperation;
}

/**
 * Validates a Horizon account record (`HorizonAccount`).
 */
export function validateHorizonAccount(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonAccount {
  const obj = requireObject(raw, prefix || 'account', rootRaw, url);

  // Horizon uses `account_id`, while some callers/mocks may provide `id`.
  const accountId = obj['account_id'] ?? obj['id'];
  const idPath = prefix ? `${prefix}.account_id` : 'account_id';
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new HorizonValidationError(
      idPath,
      accountId === undefined
        ? 'required string is missing'
        : `expected non-empty string, got ${accountId === null ? 'null' : typeof accountId}`,
      rootRaw,
      url
    );
  }
  requireString(obj, 'sequence', prefix, rootRaw, url);
  requireNumber(obj, 'subentry_count', prefix, rootRaw, url);
  requireNumber(obj, 'last_modified_ledger', prefix, rootRaw, url);
  requireNumber(obj, 'num_sponsored', prefix, rootRaw, url);
  requireNumber(obj, 'num_sponsoring', prefix, rootRaw, url);

  const balancesPath = prefix ? `${prefix}.balances` : 'balances';
  const balances = obj['balances'];
  if (!Array.isArray(balances)) {
    throw new HorizonValidationError(
      balancesPath,
      balances === undefined
        ? 'required array is missing'
        : `expected array, got ${balances === null ? 'null' : typeof balances}`,
      rootRaw,
      url
    );
  }
  for (let i = 0; i < balances.length; i++) {
    const itemPrefix = `${balancesPath}[${i}]`;
    const bal = requireObject(balances[i], itemPrefix, rootRaw, url);
    requireString(bal, 'balance', itemPrefix, rootRaw, url);
    requireString(bal, 'asset_type', itemPrefix, rootRaw, url);
  }

  const flagsPath = prefix ? `${prefix}.flags` : 'flags';
  const flags = requireObject(obj['flags'], flagsPath, rootRaw, url);
  requireBoolean(flags, 'auth_required', flagsPath, rootRaw, url);
  requireBoolean(flags, 'auth_revocable', flagsPath, rootRaw, url);
  requireBoolean(flags, 'auth_immutable', flagsPath, rootRaw, url);
  requireBoolean(flags, 'auth_clawback_enabled', flagsPath, rootRaw, url);

  const thresholdsPath = prefix ? `${prefix}.thresholds` : 'thresholds';
  const thresholds = requireObject(obj['thresholds'], thresholdsPath, rootRaw, url);
  requireNumber(thresholds, 'low_threshold', thresholdsPath, rootRaw, url);
  requireNumber(thresholds, 'med_threshold', thresholdsPath, rootRaw, url);
  requireNumber(thresholds, 'high_threshold', thresholdsPath, rootRaw, url);

  if (obj['account_id'] === undefined) {
    return { ...obj, account_id: accountId } as unknown as HorizonAccount;
  }
  return obj as unknown as HorizonAccount;
}

/**
 * Validates a Horizon trade record (`HorizonTrade`).
 */
export function validateHorizonTrade(
  raw: unknown,
  url = '',
  prefix = '',
  rootRaw: unknown = raw
): HorizonTrade {
  const obj = requireObject(raw, prefix || 'trade', rootRaw, url);
  requireString(obj, 'id', prefix, rootRaw, url);
  requireString(obj, 'paging_token', prefix, rootRaw, url);
  requireString(obj, 'ledger_close_time', prefix, rootRaw, url);
  requireString(obj, 'base_account', prefix, rootRaw, url);
  requireString(obj, 'base_amount', prefix, rootRaw, url);
  requireString(obj, 'base_asset_type', prefix, rootRaw, url);
  requireString(obj, 'counter_amount', prefix, rootRaw, url);
  requireString(obj, 'counter_asset_type', prefix, rootRaw, url);
  return obj as unknown as HorizonTrade;
}

/**
 * Validates a paginated Horizon `_embedded.records` envelope and each record within it.
 */
export function validateHorizonPage<T>(
  raw: unknown,
  validateRecord: (record: unknown, url: string, prefix: string, rootRaw: unknown) => T,
  url = ''
): HorizonPage<T> {
  const obj = requireObject(raw, 'response', raw, url);
  const embedded = requireObject(obj['_embedded'], '_embedded', raw, url);
  const records = embedded['records'];
  if (!Array.isArray(records)) {
    throw new HorizonValidationError(
      '_embedded.records',
      records === undefined
        ? 'required array is missing'
        : `expected array, got ${records === null ? 'null' : typeof records}`,
      raw,
      url
    );
  }

  const validatedRecords: T[] = [];
  for (let i = 0; i < records.length; i++) {
    validatedRecords.push(validateRecord(records[i], url, `_embedded.records[${i}]`, raw));
  }

  if (obj['_links'] !== undefined && obj['_links'] !== null) {
    const links = requireObject(obj['_links'], '_links', raw, url);
    if (links['next'] !== undefined && links['next'] !== null) {
      const next = requireObject(links['next'], '_links.next', raw, url);
      requireString(next, 'href', '_links.next', raw, url);
    }
  }

  return {
    ...(obj as Record<string, unknown>),
    _embedded: {
      ...embedded,
      records: validatedRecords,
    },
  } as HorizonPage<T>;
}

export interface HorizonClientOptions {
  /** Metric/error label for the throttle (default: `'horizon'`). */
  name?: string;
  /** Default Horizon base URL when a call does not pass one. */
  baseUrl?: string;
  /** Minimum spacing in ms between outbound requests (default: `100`). */
  minIntervalMs?: number;
  /** Maximum spacing in ms during adaptive rate-limit backoff (default: `10000`). */
  maxIntervalMs?: number;
  /** Optional bearer token for authenticated Horizon providers. */
  authToken?: string;
  /** Weight factor for backfill vs tip traffic (default: `2`). */
  tipWeightFactor?: number;
  /** Maximum retry attempts for retryable calls (default: `3`). */
  maxRetries?: number;
  /** Base backoff in ms for retryable calls (default: `300`). */
  baseBackoffMs?: number;
  /** Per-request timeout in ms for resilient calls when > 0 (default: `0`, disabled). */
  requestTimeoutMs?: number;
  /** Optional Prometheus metrics hooks. */
  metrics?: ThrottleMetrics;
  /** Optional structured logger for retry/timeout/validation warnings. */
  logger?: HorizonLogger;
  /** Optional fetch implementation override for testing. */
  fetchFn?: typeof fetch;
  /**
   * When true, `getAccount` returns `null` after exhausting retries on transient
   * HTTP/network errors instead of throwing (used by GraphQL fallback mode so
   * resolvers degrade gracefully, while the indexer throws so queued refreshes
   * are deferred and retried).
   */
  swallowAccountErrors?: boolean;
}

export interface HorizonClient {
  throttle(purpose?: RequestPurpose): Promise<void>;
  fetchJson<T>(url: string, init?: RequestInit, purpose?: RequestPurpose): Promise<T>;
  getLatestLedgerSequence(baseUrl?: string, purpose?: RequestPurpose): Promise<number>;
  getLedger(sequence: number, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonLedger>;
  getLedgerTransactions(sequence: number, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonTransaction[]>;
  getLedgerOperations(sequence: number, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonOperation[]>;
  getAccount(address: string, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonAccount | null>;
  getRecentTransactions(limit?: number, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonTransaction[]>;
  getAccountTransactions(
    address: string,
    limit?: number,
    baseUrl?: string,
    purpose?: RequestPurpose
  ): Promise<HorizonTransaction[]>;
  getLatestLedger(baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonLatestLedger | null>;
  getTrades(params?: HorizonTradesFilter, baseUrl?: string, purpose?: RequestPurpose): Promise<HorizonTrade[]>;
}

/**
 * Resolve a `next` link returned by Horizon against the configured base URL.
 *
 * Horizon constructs `_links.next.href` from its own `PUBLIC_HORIZON_URL` /
 * `Host` header, which behind a reverse proxy or port-forwarded container is
 * often an internal hostname (`http://horizon:8000/...`) or `localhost` that
 * the caller cannot reach. Keeping the path + query string from `next` while
 * anchoring the origin (and any base-path prefix) to `baseUrl` ensures every
 * follow-up page goes through the same endpoint that served page 1.
 */
function resolveNextUrl(baseUrl: string, nextHref: string): string {
  try {
    const base = new URL(baseUrl);
    const next = new URL(nextHref, base);
    next.protocol = base.protocol;
    next.host = base.host;
    return next.toString();
  } catch {
    return nextHref;
  }
}

export function createHorizonClient(options: HorizonClientOptions = {}): HorizonClient {
  const {
    name = 'horizon',
    baseUrl: defaultBaseUrl = 'https://horizon.stellar.org',
    minIntervalMs = 100,
    maxIntervalMs = 10000,
    authToken,
    tipWeightFactor = 2,
    maxRetries = 3,
    baseBackoffMs = 300,
    requestTimeoutMs = 0,
    metrics,
    logger,
    fetchFn,
    swallowAccountErrors = false,
  } = options;

  const { throttle, fetchJson } = createThrottle({
    name,
    minIntervalMs,
    maxIntervalMs,
    authToken,
    tipWeightFactor,
    metrics,
  });
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const doFetch: typeof fetch =
    fetchFn ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));

  function resolveBase(baseUrl?: string): string {
    return (baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
  }

  function validateWithDiagnostics<T>(url: string, raw: unknown, validate: () => T): T {
    try {
      return validate();
    } catch (err) {
      if (err instanceof HorizonValidationError) {
        logger?.warn(
          { url, field: err.field, rawResponse: err.rawResponse },
          err.message
        );
      }
      throw err;
    }
  }

  /**
   * Fetch all records across paginated Horizon responses.
   * Follows `_links.next.href` while pages are full (`records.length === PAGE_LIMIT`).
   */
  async function fetchAllPages<T>(
    baseUrl: string,
    initialUrl: string,
    validateRecord: (record: unknown, url: string, prefix: string, rootRaw: unknown) => T,
    purpose: RequestPurpose = 'default'
  ): Promise<T[]> {
    const all: T[] = [];
    let url: string | undefined = initialUrl;

    while (url) {
      const currentUrl: string = url;
      const raw: unknown = await fetchJson<unknown>(currentUrl, undefined, purpose);
      const page: HorizonPage<T> = validateWithDiagnostics(
        currentUrl,
        raw,
        (): HorizonPage<T> => validateHorizonPage(raw, validateRecord, currentUrl)
      );
      const records: T[] = page._embedded.records;
      all.push(...records);

      const nextHref: string | undefined = page._links?.next?.href;
      url = records.length === PAGE_LIMIT && nextHref ? resolveNextUrl(baseUrl, nextHref) : undefined;
    }

    return all;
  }

  /**
   * Resilient GET helper used for fallback / single-resource queries where
   * 404 is an expected "not found" result and 429 / transient failures retry
   * before either returning `null` or throwing.
   */
  async function fetchWithRetry(
    url: string,
    throwOnError = false,
    purpose: RequestPurpose = 'default'
  ): Promise<unknown | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await throttle(purpose);
      const stopTimer = metrics?.requestDuration?.startTimer();
      const controller = requestTimeoutMs > 0 ? new AbortController() : undefined;
      const timeout =
        requestTimeoutMs > 0 ? setTimeout(() => controller!.abort(), requestTimeoutMs) : undefined;
      let res: Response;
      try {
        res = await doFetch(url, controller ? { signal: controller.signal } : undefined);
      } catch (err) {
        if (timeout !== undefined) clearTimeout(timeout);
        metrics?.requestsTotal.inc({ status: 'error' });
        stopTimer?.();
        if (attempt < maxRetries) {
          await sleep(baseBackoffMs * attempt);
          continue;
        }
        logger?.warn({ url, attempts: maxRetries }, 'horizon request failed to connect');
        if (throwOnError) throw err;
        return null;
      }
      if (timeout !== undefined) clearTimeout(timeout);
      stopTimer?.();
      metrics?.requestsTotal.inc({ status: String(res.status) });

      if (res.status === 404) return null;

      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.('Retry-After'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : baseBackoffMs * attempt;
        if (attempt < maxRetries) {
          logger?.warn({ url, attempt, delay }, 'horizon rate limit, retrying after a pause');
          await sleep(delay);
          continue;
        }
        logger?.warn({ url, attempts: maxRetries }, 'horizon rate limit, giving up');
        if (throwOnError) {
          throw new Error(`${name} request failed with status 429: ${url}`);
        }
        return null;
      }

      if (!res.ok) {
        if (attempt < maxRetries && res.status >= 500) {
          await sleep(baseBackoffMs * attempt);
          continue;
        }
        logger?.warn({ url, status: res.status }, 'horizon returned non-ok status');
        if (throwOnError) {
          throw new Error(`${name} request failed with status ${res.status}: ${url}`);
        }
        return null;
      }

      return await res.json();
    }
    return null;
  }

  return {
    throttle,
    fetchJson,

    async getLatestLedgerSequence(baseUrl?: string, purpose: RequestPurpose = 'tip'): Promise<number> {
      const base = resolveBase(baseUrl);
      const url = `${base}/ledgers?order=desc&limit=1`;
      const raw = await fetchJson<unknown>(url, undefined, purpose);
      const page = validateWithDiagnostics(url, raw, () =>
        validateHorizonPage(raw, validateHorizonLatestLedger, url)
      );
      return page._embedded.records[0]?.sequence ?? 0;
    },

    async getLedger(sequence: number, baseUrl?: string, purpose: RequestPurpose = 'default'): Promise<HorizonLedger> {
      const base = resolveBase(baseUrl);
      const url = `${base}/ledgers/${sequence}`;
      const raw = await fetchJson<unknown>(url, undefined, purpose);
      return validateWithDiagnostics(url, raw, () => validateHorizonLedger(raw, url));
    },

    getLedgerTransactions(
      sequence: number,
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonTransaction[]> {
      const base = resolveBase(baseUrl);
      return fetchAllPages<HorizonTransaction>(
        base,
        `${base}/ledgers/${sequence}/transactions?order=asc&limit=${PAGE_LIMIT}`,
        validateHorizonTransaction,
        purpose
      );
    },

    getLedgerOperations(
      sequence: number,
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonOperation[]> {
      const base = resolveBase(baseUrl);
      return fetchAllPages<HorizonOperation>(
        base,
        `${base}/ledgers/${sequence}/operations?order=asc&limit=${PAGE_LIMIT}`,
        validateHorizonOperation,
        purpose
      );
    },

    async getAccount(
      address: string,
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonAccount | null> {
      const base = resolveBase(baseUrl);
      const url = `${base}/accounts/${address}`;
      const raw = await fetchWithRetry(url, !swallowAccountErrors, purpose);
      if (raw === null) return null;
      return validateWithDiagnostics(url, raw, () => validateHorizonAccount(raw, url));
    },

    async getRecentTransactions(
      limit = 20,
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonTransaction[]> {
      const base = resolveBase(baseUrl);
      const url = `${base}/transactions?limit=${limit}&order=desc`;
      const raw = await fetchWithRetry(url, false, purpose);
      if (raw === null) return [];
      const page = validateWithDiagnostics(url, raw, () =>
        validateHorizonPage(raw, validateHorizonTransaction, url)
      );
      return page._embedded.records;
    },

    async getAccountTransactions(
      address: string,
      limit = 10,
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonTransaction[]> {
      const base = resolveBase(baseUrl);
      const url = `${base}/accounts/${address}/transactions?limit=${limit}&order=desc`;
      const raw = await fetchWithRetry(url, false, purpose);
      if (raw === null) return [];
      const page = validateWithDiagnostics(url, raw, () =>
        validateHorizonPage(raw, validateHorizonTransaction, url)
      );
      return page._embedded.records;
    },

    async getLatestLedger(
      baseUrl?: string,
      purpose: RequestPurpose = 'tip'
    ): Promise<HorizonLatestLedger | null> {
      const base = resolveBase(baseUrl);
      const url = `${base}/ledgers?limit=1&order=desc`;
      const raw = await fetchWithRetry(url, false, purpose);
      if (raw === null) return null;
      const page = validateWithDiagnostics(url, raw, () =>
        validateHorizonPage(raw, validateHorizonLatestLedger, url)
      );
      return page._embedded.records[0] ?? null;
    },

    async getTrades(
      params: HorizonTradesFilter = {},
      baseUrl?: string,
      purpose: RequestPurpose = 'default'
    ): Promise<HorizonTrade[]> {
      const base = resolveBase(baseUrl);
      const query = new URLSearchParams();
      query.set('order', params.order ?? 'asc');
      query.set('limit', String(params.limit ?? PAGE_LIMIT));
      if (params.cursor) query.set('cursor', params.cursor);
      if (params.offerId) query.set('offer_id', params.offerId);
      if (params.baseAssetType) query.set('base_asset_type', params.baseAssetType);
      if (params.baseAssetCode) query.set('base_asset_code', params.baseAssetCode);
      if (params.baseAssetIssuer) query.set('base_asset_issuer', params.baseAssetIssuer);
      if (params.counterAssetType) query.set('counter_asset_type', params.counterAssetType);
      if (params.counterAssetCode) query.set('counter_asset_code', params.counterAssetCode);
      if (params.counterAssetIssuer) query.set('counter_asset_issuer', params.counterAssetIssuer);

      const path = params.accountId
        ? `${base}/accounts/${encodeURIComponent(params.accountId)}/trades`
        : `${base}/trades`;
      const url = `${path}?${query.toString()}`;
      const raw = await fetchJson<unknown>(url, undefined, purpose);
      const page = validateWithDiagnostics(url, raw, () =>
        validateHorizonPage(raw, validateHorizonTrade, url)
      );
      return page._embedded.records;
    },
  };
}
