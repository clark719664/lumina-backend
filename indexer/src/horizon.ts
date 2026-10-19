/**
 * Stellar Horizon API client for the indexer.
 *
 * Thin wrapper around `@lumina/shared`'s `createHorizonClient` wired up to the
 * indexer's Prometheus metrics (`horizonRequests`, `horizonRequestDuration`),
 * adaptive rate-limiting metrics, and structured subsystem logger.
 *
 * Every function takes the network's `horizonUrl` explicitly so multi-network
 * indexing loops (`resolveNetworks`) can poll independent Horizon endpoints in
 * the same process while sharing the per-IP outbound request throttle.
 */
import {
  createHorizonClient,
  type HorizonAccount,
  type HorizonLedger,
  type HorizonOperation,
  type HorizonTrade,
  type HorizonTradesFilter,
  type HorizonTransaction,
  type RequestPurpose,
} from '@lumina/shared';
import {
  horizonRequestDuration,
  horizonRequests,
  horizonThrottleInterval,
  horizonQueuedRequests,
  horizonWaitTime,
} from './metrics';
import { subsystem } from './logger';

export {
  PAGE_LIMIT,
  HorizonValidationError,
  validateHorizonAccount,
  validateHorizonLatestLedger,
  validateHorizonLedger,
  validateHorizonOperation,
  validateHorizonPage,
  validateHorizonTrade,
  validateHorizonTransaction,
  type HorizonAccount,
  type HorizonBalance,
  type HorizonLatestLedger,
  type HorizonLedger,
  type HorizonOperation,
  type HorizonPage,
  type HorizonTrade,
  type HorizonTradePrice,
  type HorizonTradesFilter,
  type HorizonTransaction,
} from '@lumina/shared';

const log = subsystem('horizon');

let client = createHorizonClient({
  name: 'horizon',
  minIntervalMs: parseInt(process.env['HORIZON_MIN_REQUEST_INTERVAL_MS'] ?? '100', 10),
  maxIntervalMs: parseInt(process.env['HORIZON_MAX_REQUEST_INTERVAL_MS'] ?? '10000', 10),
  authToken: process.env['HORIZON_AUTH_TOKEN'],
  tipWeightFactor: parseFloat(process.env['HORIZON_TIP_WEIGHT_FACTOR'] ?? '2'),
  metrics: {
    requestsTotal: horizonRequests,
    requestDuration: horizonRequestDuration,
    currentInterval: horizonThrottleInterval,
    queuedRequests: horizonQueuedRequests,
    waitTime: horizonWaitTime,
  },
  logger: log,
});

/**
 * Re-initialize the Horizon client with updated adaptive rate-limiting options.
 */
export function initializeHorizonClient(options: {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  authToken?: string;
  tipWeightFactor?: number;
}) {
  client = createHorizonClient({
    name: 'horizon',
    minIntervalMs: options.minIntervalMs ?? 100,
    maxIntervalMs: options.maxIntervalMs ?? 10000,
    authToken: options.authToken,
    tipWeightFactor: options.tipWeightFactor ?? 2,
    metrics: {
      requestsTotal: horizonRequests,
      requestDuration: horizonRequestDuration,
      currentInterval: horizonThrottleInterval,
      queuedRequests: horizonQueuedRequests,
      waitTime: horizonWaitTime,
    },
    logger: log,
  });
}

/**
 * Fetch the sequence number of the most recently closed ledger on `horizonUrl`.
 * Returns `0` if Horizon returns an empty record list.
 */
export function getLatestLedgerSequence(
  horizonUrl: string,
  purpose: RequestPurpose = 'tip'
): Promise<number> {
  return client.getLatestLedgerSequence(horizonUrl, purpose);
}

/**
 * Fetch metadata for a single ledger by sequence number.
 */
export function getLedger(
  horizonUrl: string,
  sequence: number,
  purpose: RequestPurpose = 'default'
): Promise<HorizonLedger> {
  return client.getLedger(sequence, horizonUrl, purpose);
}

/**
 * Fetch all transactions in a ledger, following Horizon cursor pagination
 * (`_links.next.href`) when a page reaches `PAGE_LIMIT`.
 */
export function getLedgerTransactions(
  horizonUrl: string,
  sequence: number,
  purpose: RequestPurpose = 'default'
): Promise<HorizonTransaction[]> {
  return client.getLedgerTransactions(sequence, horizonUrl, purpose);
}

/**
 * Fetch all operations in a ledger, following Horizon cursor pagination
 * (`_links.next.href`) when a page reaches `PAGE_LIMIT`.
 */
export function getLedgerOperations(
  horizonUrl: string,
  sequence: number,
  purpose: RequestPurpose = 'default'
): Promise<HorizonOperation[]> {
  return client.getLedgerOperations(sequence, horizonUrl, purpose);
}

/**
 * Fetch an account's current state from Horizon.
 * Returns `null` when Horizon responds with `404` (unfunded / merged account)
 * and throws on transient failures after retries so queued refreshes can retry.
 */
export function getAccount(
  horizonUrl: string,
  address: string,
  purpose: RequestPurpose = 'default'
): Promise<HorizonAccount | null> {
  return client.getAccount(address, horizonUrl, purpose);
}

/**
 * Fetch a page of trade executions from Horizon `/trades` (or `/accounts/:id/trades`).
 */
export function getTrades(
  horizonUrl: string,
  params?: HorizonTradesFilter,
  purpose: RequestPurpose = 'default'
): Promise<HorizonTrade[]> {
  return client.getTrades(params, horizonUrl, purpose);
}
