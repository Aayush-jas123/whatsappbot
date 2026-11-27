'use strict';
// Shared open-request feed (returns server → customerContextService).
//
// Proves the four things the shared cache exists for:
//   1. the global feed is fetched once per TTL, not once per customer;
//   2. what is cached is the projection — never the raw item JSON;
//   3. the order-number index resolves both spellings ("#55197" and "55197");
//   4. the expensive per-order ai-data fallback only runs when the capped feed
//      genuinely could not have contained the record.
//
// Runs fully offline: axios.get and dbAdapter.query are stubbed, so no HTTP
// request leaves the process and no DB connection is opened.
// Run: node --test test/testReturnsFeedCache.js

const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const { dbAdapter } = require('../src/database/db');
const { caches } = require('../src/utils/cache');
const CustomerContext = require('../src/services/customerContextService');

/* ───────────────────────── stubs ───────────────────────── */

let pipelineCalls = 0;
let aiDataCalls = 0;
let feedRows = [];
let feedFails = false;
let shopperResult = [];

const originalGet = axios.get;
axios.get = async (url) => {
    if (String(url).includes('/api/internal/inventory-open-requests')) {
        pipelineCalls++;
        if (feedFails) throw new Error('simulated returns-server outage');
        return { data: { success: true, requests: feedRows } };
    }
    if (String(url).includes('/api/internal/ai-data')) {
        aiDataCalls++;
        return { data: { requests: [] } };
    }
    throw new Error('unexpected outbound call: ' + url);
};

const originalQuery = dbAdapter.query;
dbAdapter.query = async (sql) => {
    const text = String(sql);
    if (text.includes('FROM store_shoppers')) return shopperResult;
    if (text.includes('FROM returns')) return [];
    if (text.includes('FROM exchanges')) return [];
    return [];
};

function shopperRows(orderIds) {
    return orderIds.map(id => ({
        order_id: id,
        name: 'Krish Agarwal', phone: '+919999900001', email: 'krish@example.com',
        shopper_status: 'delivered', order_status: 'delivered',
        items_json: JSON.stringify([{ name: 'HENLEY - 001', quantity: 1 }]),
        order_total: 1799, payment_method: 'Prepaid', delivery_type: 'Standard',
        created_at: '2026-11-19T10:00:00.000Z',
        address: '52 Balaram Dey Street', city: 'Kolkata', province: 'West Bengal', zip: '700001',
        awb: null, courier_name: null, tracking_url: null, delivered_at: null
    }));
}

function resetFeed() {
    caches.returnsFeed.clear();
    caches.shoppers.clear();
    pipelineCalls = 0;
    aiDataCalls = 0;
    feedRows = [];
    feedFails = false;
    shopperResult = shopperRows(['55197']);
}

const savedReturnsUrl = process.env.RETURNS_SERVER_URL;
process.env.RETURNS_SERVER_URL = 'https://returns.test';

/* ───────────────────────── tests ───────────────────────── */

test('the feed is fetched once per TTL, not once per customer', async () => {
    resetFeed();
    feedRows = [{
        request_id: 'RNX-1', order_number: '#55197', type: 'return',
        status: 'approved', created_at: '2026-11-19T10:00:00.000Z',
        items: [{ name: 'HENLEY - 001', size: 'XS', quantity: 1 }]
    }];

    await CustomerContext.build('919999900001');
    shopperResult = shopperRows(['74596']);
    await CustomerContext.build('918888800002');
    shopperResult = shopperRows(['70822']);
    await CustomerContext.build('917777700003');

    assert.equal(pipelineCalls, 1, 'three customers must share one upstream fetch');
});

test('the index resolves both order-number spellings and projects items', async () => {
    resetFeed();
    feedRows = [{
        request_id: 'RNX-9', order_number: '#55197', type: 'exchange',
        status: 'pickup_booked', reason: 'Size exchange', created_at: '2026-11-20T10:00:00.000Z',
        items: [
            { name: 'HENLEY - 001 ( ACID WASH )', size: 'XS', quantity: 1 },
            { name: 'POLO - 001', size: 'L', quantity: 2 },
            { name: 'THIRD ITEM THAT IS NOT SHOWN', quantity: 1 }
        ]
    }];

    const ctx = await CustomerContext.build('919999900001');

    assert.equal(ctx.returnsConnected, true);
    assert.deepEqual(ctx.returns, []);
    assert.equal(ctx.exchanges.length, 1);

    const row = ctx.exchanges[0];
    assert.equal(row.request_id, 'RNX-9');
    assert.equal(row.id, 'RNX-9');
    assert.equal(row.type, 'exchange');
    assert.equal(row.status, 'pickup_booked');
    // Re-stamped with the customer's own spelling so local and portal rows key alike
    assert.equal(row.order_number, '55197');
    assert.equal(row.items.length, 2, 'item lines are capped at two');
    assert.equal(row.items[0].n, 'HENLEY - 001 ( ACID WASH )');
    assert.equal(row.items[0].v, 'XS');
    assert.equal(row.items[0].q, 1);
    assert.equal(row.items[1].q, 2);
});

test('the cached feed holds the projection, never the raw item JSON', async () => {
    resetFeed();
    feedRows = [{
        request_id: 'RNX-2', order_number: '55197', type: 'return',
        status: 'pending', created_at: '2026-11-18T10:00:00.000Z',
        items: [{ name: 'A', quantity: 1 }, { name: 'B', quantity: 1 }, { name: 'C', quantity: 1 }]
    }];

    await CustomerContext.build('919999900001');
    const cached = caches.returnsFeed.get('open:90');

    assert.ok(cached, 'the feed must be cached under the window key');
    assert.equal(cached.count, 1);
    assert.equal(cached.truncated, false);
    assert.equal(cached.index.get('55197')[0].items.length, 2);
    // Nothing that looks like the upstream row survives the projection
    const stored = JSON.stringify(cached.index.get('55197')[0]);
    assert.ok(!stored.includes('"C"'), 'uncached item lines must not be retained');
    assert.ok(!stored.includes('"quantity"'), 'raw upstream field names must not be retained');
});

test('the per-order ai-data fallback is skipped while the feed is complete', async () => {
    resetFeed();
    feedRows = [{
        request_id: 'RNX-3', order_number: '#55197', type: 'return',
        status: 'approved', created_at: '2026-11-19T10:00:00.000Z', items: []
    }];

    await CustomerContext.build('919999900001');

    assert.equal(aiDataCalls, 0, 'a complete feed needs no extra roundtrips');
});

test('the per-order ai-data fallback still runs when the feed hit its cap', async () => {
    resetFeed();
    // The endpoint reads .range(0, 999), so exactly 1000 rows means truncation
    feedRows = Array.from({ length: 1000 }, (_, i) => ({
        request_id: 'RNX-' + i, order_number: '#' + (900000 + i), type: 'return',
        status: 'pending', created_at: '2026-11-01T10:00:00.000Z', items: []
    }));

    await CustomerContext.build('919999900001');

    assert.equal(aiDataCalls, 1, 'one lookup per order in the capped case');
});

test('a failed feed fetch degrades to returnsConnected false, not a throw', async () => {
    resetFeed();
    feedFails = true;

    const ctx = await CustomerContext.build('919999900001');

    assert.equal(ctx.returnsConnected, false);
    assert.deepEqual(ctx.returns, []);
    assert.deepEqual(ctx.exchanges, []);
    assert.equal(aiDataCalls, 1, 'an unindexed feed still gets the targeted lookup');
});

test('an unconfigured returns server costs no outbound call at all', async () => {
    resetFeed();
    delete process.env.RETURNS_SERVER_URL;

    const ctx = await CustomerContext.build('919999900001');

    assert.equal(ctx.returnsConnected, false);
    assert.deepEqual(ctx.returns, []);
    assert.equal(pipelineCalls, 0);
    assert.equal(aiDataCalls, 0);

    process.env.RETURNS_SERVER_URL = savedReturnsUrl || 'https://returns.test';
});

/* ───────────────────────── teardown ───────────────────────── */

process.on('exit', () => {
    axios.get = originalGet;
    dbAdapter.query = originalQuery;
    if (savedReturnsUrl === undefined) delete process.env.RETURNS_SERVER_URL;
    else process.env.RETURNS_SERVER_URL = savedReturnsUrl;
    caches.returnsFeed.clear();
});
