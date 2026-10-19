import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLatestLedgerSequence,
  getLedger,
  getLedgerTransactions,
  getLedgerOperations,
  getAccount,
  getTrades,
  PAGE_LIMIT,
  initializeHorizonClient,
  HorizonValidationError,
} from './horizon';
// @ts-expect-error - JSON file imports are enabled at runtime for this test fixture.
import fixtures from './__fixtures__/horizon.json' assert { type: 'json' };

// Initialize the horizon client with default config for tests
initializeHorizonClient({
  minIntervalMs: 100,
  maxIntervalMs: 10000,
  tipWeightFactor: 2,
});

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let call = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    const res = responses[call++] ?? responses[responses.length - 1];
    return {
      ok: res.ok,
      status: res.status ?? 200,
      headers: {
        get: () => null,
      },
      json: async () => res.body,
    };
  }) as unknown as typeof fetch;
}

test('getLatestLedgerSequence parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.ledgerPage }]);
  const seq = await getLatestLedgerSequence('https://horizon.example.com');
  assert.equal(seq, 52481234);
});

test('getLatestLedgerSequence returns 0 when there are no records', async () => {
  mockFetchSequence([{ ok: true, body: { _embedded: { records: [] } } }]);
  const seq = await getLatestLedgerSequence('https://horizon.example.com');
  assert.equal(seq, 0);
});

test('getLedger parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.ledger }]);
  const ledger = await getLedger('https://horizon.example.com', 52481234);
  assert.equal(ledger.sequence, 52481234);
  assert.equal(ledger.base_fee_in_stroops, 100);
  assert.equal(ledger.successful_transaction_count, 25);
});

test('getLedger throws on a non-OK response', async () => {
  mockFetchSequence([{ ok: false, status: 404, body: {} }]);
  await assert.rejects(() => getLedger('https://horizon.example.com', 999));
});

test('getLedgerTransactions parses recorded Horizon response shape with pagination', async () => {
  const fullPage = Array.from({ length: PAGE_LIMIT }, (_, i) => ({
    ...fixtures.transaction,
    hash: `tx-${i}`,
  }));
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: fullPage }, _links: { next: { href: 'page2' } } } },
    { ok: true, body: { _embedded: { records: [fixtures.transaction] }, _links: {} } },
  ]);
  const txs = await getLedgerTransactions('https://horizon.example.com', 100);
  assert.equal(txs.length, PAGE_LIMIT + 1);
  assert.equal(txs.at(-1)?.hash, fixtures.transaction.hash);
  assert.equal(txs[0].memo, 'hello world');
});

test('getLedgerTransactions stops after a single short page with no next link', async () => {
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: [fixtures.transaction] }, _links: {} } },
  ]);
  const txs = await getLedgerTransactions('https://horizon.example.com', 100);
  assert.equal(txs.length, 1);
});

test('requests are paced, so a burst cannot trip Horizon\'s rate limit', async () => {
  const times: number[] = [];
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    times.push(Date.now());
    return { ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) };
  }) as unknown as typeof fetch;

  await getLatestLedgerSequence('https://horizon.example.com');
  await getLatestLedgerSequence('https://horizon.example.com');
  await getLatestLedgerSequence('https://horizon.example.com');

  assert.equal(times.length, 3);
  assert.ok(
    times[1] - times[0] >= 80,
    `expected requests to be at least 80ms apart, got ${times[1] - times[0]}ms`
  );
  assert.ok(
    times[2] - times[1] >= 80,
    `expected requests to be at least 80ms apart, got ${times[2] - times[1]}ms`
  );
});

test('getAccount returns null when Horizon reports an unknown account', async () => {
  mockFetchSequence([{ ok: false, status: 404, body: {} }]);
  assert.equal(await getAccount('https://horizon.example.com', 'G-missing'), null);
});

test('getAccount throws on transient HTTP failures so queued refreshes can retry', async () => {
  mockFetchSequence([{ ok: false, status: 429, body: {} }]);
  await assert.rejects(
    () => getAccount('https://horizon.example.com', 'G-rate-limited'),
    /status 429/
  );
});

test('getLedgerOperations parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.operationPage }]);
  const ops = await getLedgerOperations('https://horizon.example.com', 52481234);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, '223456789504897');
  assert.equal(ops[0].type, 'payment');
  assert.equal(ops[0].source_account, fixtures.operation.source_account);
});

test('getLedgerOperations follows pagination when a page is full', async () => {
  const fullPage = Array.from({ length: PAGE_LIMIT }, (_, i) => ({
    ...fixtures.operation,
    id: `op-${i}`,
  }));
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: fullPage }, _links: { next: { href: 'page2' } } } },
    { ok: true, body: { _embedded: { records: [fixtures.operation] }, _links: {} } },
  ]);
  const ops = await getLedgerOperations('https://horizon.example.com', 52481234);
  assert.equal(ops.length, PAGE_LIMIT + 1);
  assert.equal(ops[0].id, 'op-0');
  assert.equal(ops.at(-1)?.id, fixtures.operation.id);
});

test('getLedgerOperations stops after a single short page', async () => {
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: [fixtures.operation] }, _links: {} } },
  ]);
  const ops = await getLedgerOperations('https://horizon.example.com', 52481234);
  assert.equal(ops.length, 1);
});

test('getTrades parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.tradesPage }]);
  const trades = await getTrades('https://horizon.example.com');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].id, '1234567890123456789');
  assert.equal(trades[0].base_amount, '100.0000000');
  assert.equal(trades[0].counter_asset_code, 'USDC');
});

test('getTrades returns an empty array when no trades match the filter', async () => {
  mockFetchSequence([{ ok: true, body: { _embedded: { records: [] }, _links: {} } }]);
  const trades = await getTrades('https://horizon.example.com', {
    baseAssetType: 'native',
    limit: 10,
  });
  assert.deepEqual(trades, []);
});

test('getLedger rejects a malformed ledger missing a required field and retains the raw response', async () => {
  const malformedLedger = {
    sequence: 52481234,
    // closed_at is missing
    successful_transaction_count: 25,
    failed_transaction_count: 3,
    operation_count: 142,
    base_fee_in_stroops: 100,
    base_reserve_in_stroops: 5000000,
  };
  mockFetchSequence([{ ok: true, body: malformedLedger }]);

  await assert.rejects(
    () => getLedger('https://horizon.example.com', 52481234),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, 'closed_at');
      assert.match(err.message, /closed_at/);
      assert.deepEqual(err.rawResponse, malformedLedger);
      return true;
    }
  );
});

test('getLedger rejects a ledger when a numeric field has the wrong runtime type', async () => {
  const malformedLedger = {
    ...fixtures.ledger,
    operation_count: '142', // should be a number, not a string
  };
  mockFetchSequence([{ ok: true, body: malformedLedger }]);

  await assert.rejects(
    () => getLedger('https://horizon.example.com', 52481234),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, 'operation_count');
      assert.match(err.message, /operation_count/);
      assert.deepEqual(err.rawResponse, malformedLedger);
      return true;
    }
  );
});

test('getLedgerTransactions rejects a page with a malformed transaction record and names the offending field', async () => {
  const malformedPage = {
    _embedded: {
      records: [
        {
          ...fixtures.transaction,
          source_account: undefined,
        },
      ],
    },
    _links: {},
  };
  mockFetchSequence([{ ok: true, body: malformedPage }]);

  await assert.rejects(
    () => getLedgerTransactions('https://horizon.example.com', 52481234),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, '_embedded.records[0].source_account');
      assert.match(err.message, /_embedded\.records\[0\]\.source_account/);
      assert.deepEqual(err.rawResponse, malformedPage);
      return true;
    }
  );
});

test('getLedgerOperations rejects a page missing _embedded.records and retains the raw response', async () => {
  const malformedEnvelope = { _embedded: {} };
  mockFetchSequence([{ ok: true, body: malformedEnvelope }]);

  await assert.rejects(
    () => getLedgerOperations('https://horizon.example.com', 52481234),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, '_embedded.records');
      assert.match(err.message, /_embedded\.records/);
      assert.deepEqual(err.rawResponse, malformedEnvelope);
      return true;
    }
  );
});

test('getAccount rejects a malformed account snapshot with invalid balances or thresholds', async () => {
  const malformedAccount = {
    ...fixtures.account,
    balances: [{ balance: '100.0000000' }], // missing asset_type
  };
  mockFetchSequence([{ ok: true, body: malformedAccount }]);

  await assert.rejects(
    () => getAccount('https://horizon.example.com', 'GBBD47UZQ2RRULJ3UISD3HX2E7E5B57ONDST4NYUAOK5RYSOFSHMARTY'),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, 'balances[0].asset_type');
      assert.match(err.message, /balances\[0\]\.asset_type/);
      assert.deepEqual(err.rawResponse, malformedAccount);
      return true;
    }
  );
});

test('getTrades rejects a trade record with a missing counter_amount field', async () => {
  const malformedTradesPage = {
    _embedded: {
      records: [
        {
          ...fixtures.trade,
          counter_amount: null,
        },
      ],
    },
    _links: {},
  };
  mockFetchSequence([{ ok: true, body: malformedTradesPage }]);

  await assert.rejects(
    () => getTrades('https://horizon.example.com'),
    (err: unknown) => {
      assert.ok(err instanceof HorizonValidationError);
      assert.equal(err.field, '_embedded.records[0].counter_amount');
      assert.match(err.message, /_embedded\.records\[0\]\.counter_amount/);
      assert.deepEqual(err.rawResponse, malformedTradesPage);
      return true;
    }
  );
});
