'use strict';
// Unit tests for the Shopify ⇄ Stock Room sync module.
// Runs fully offline: fake Shopify client + fake DB adapter, no network, no pool.
// Run: node --test test/testShopifyInventorySync.js

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/services/shopifyInventorySync');
const shoppersInventory = require('../src/services/shoppersInventoryService');

/* ───────────────────────── fixtures ───────────────────────── */

function catalog() {
    return [
        {
            id: 1, title: 'SWEATSHIRT-001 ( BLACK )', handle: 'sweatshirt-001-black', product_type: 'SWEATSHIRT',
            variants: [
                { id: 11, title: 'M', sku: 'SW-001-BLK-M', inventory_item_id: 911, inventory: 12 },
                { id: 12, title: 'L', sku: 'SW-001-BLK-L', inventory_item_id: 912, inventory: 0 },
                { id: 13, title: 'XL', sku: 'SW-001-BLK-XL', inventory_item_id: 913, inventory: 5 },
            ],
        },
        {
            id: 2, title: 'TEE-002', handle: 'tee-002', product_type: 'T-SHIRT',
            variants: [{ id: 21, title: '', sku: '', inventory_item_id: 921, inventory: 30 }], // Default Title
        },
    ];
}

function hubRows() {
    return [
        { sku_key: 'sweatshirt-001-black-m', product_name: 'Sweatshirt Black', size: 'M', category: 'SWEAT', quantity: 20 },
        { sku_key: 'sweatshirt-001-black-l', product_name: 'Sweatshirt Black', size: 'L', category: 'SWEAT', quantity: 0 },
        { sku_key: 'sw-001-blk-xl', product_name: 'Sweatshirt Black XL', size: 'XL', category: 'SWEAT', quantity: 9 }, // matches only via variant SKU
        { sku_key: 'tee-002', product_name: 'TEE 002', size: 'FREE', category: 'T-SHIRT', quantity: 30 },
        { sku_key: 'discontinued-piece', product_name: 'OLD ITEM', size: 'M', category: null, quantity: 3 },
    ];
}

const findRow = (plan, skuKey) => plan.rows.find(r => r.sku_key === skuKey);

function fakeDb(existingRows = []) {
    const executed = [];
    return {
        executed,
        async query(sql, params = []) {
            executed.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
            if (/^SELECT sku_key, quantity FROM manual_inventory/.test(executed[executed.length - 1].sql)) return existingRows;
            if (/INSERT INTO shopify_inventory_sync_runs/.test(executed[executed.length - 1].sql)) return [{ id: 7 }];
            return [];
        },
    };
}

function immediateClient(overrides = {}) {
    const client = {
        adjusts: [],
        async getInventoryLevels(iids) {
            const byId = new Map(); const totals = new Map();
            for (const id of iids) { byId.set(id, [{ locationId: 1, available: 4 }, { locationId: 2, available: 10 }]); totals.set(id, 14); }
            return { byId, totals };
        },
        async getLocations() { return [{ id: 1, name: 'Primary' }, { id: 2, name: 'Backup' }]; },
        async adjustInventoryLevel(t) { client.adjusts.push(t); return { success: true, availableAfterChange: 0, error: null }; },
        ...overrides,
    };
    return client;
}

const until = async (cond, ms = 2000) => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('until() timed out');
        await new Promise(r => setTimeout(r, 5));
    }
};

/* ───────────────────────── key conventions ───────────────────────── */

test('sku key builder matches the legacy sync-from-shopify convention', () => {
    assert.equal(sync.variantSkuKey('Sweatshirt-001-Black', 'M'), 'sweatshirt-001-black-m');
    assert.equal(sync.variantSkuKey('tee-002', 'Default Title'), 'tee-002');
    assert.equal(sync.variantSkuKey('henley 001', 'Deep Navy S'), 'henley-001-deep-navy-s');
    assert.equal(sync.normKey('  SW-001 BLK-M '), 'sw-001-blk-m');
});

test('category inferred from product_type like the old importer', () => {
    assert.equal(sync.inferCategory('Sweatshirts'), 'SWEAT');
    assert.equal(sync.inferCategory('T-Shirt'), 'T-SHIRT');
    assert.equal(sync.inferCategory('Lower'), 'LOWER');
    assert.equal(sync.inferCategory('Bundle Set'), 'BUNDLE');
    assert.equal(sync.inferCategory(''), null);
});

/* ───────────────────────── pull plan ───────────────────────── */

test('pull plan classifies adds, updates, fills, equals and hub-only rows', () => {
    const plan = sync.buildPullPlan(catalog(), hubRows(), { mode: 'match' });
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').action, 'update');
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').delta, -8); // 12 shopify − 20 hub
    assert.equal(findRow(plan, 'sweatshirt-001-black-l').action, 'equal'); // hub 0, shopify 0 → equal
    assert.equal(findRow(plan, 'tee-002').action, 'equal');
    const disc = plan.hubOnly.find(r => r.sku_key === 'discontinued-piece');
    assert.equal(disc.action, 'hub_only'); // hub-only rows live in plan.hubOnly, not plan.rows
    assert.ok(disc);
    // XL matched via variant SKU, still keyed to the hub row, no duplicate add
    const xl = findRow(plan, 'sw-001-blk-xl');
    assert.equal(xl.action, 'update');
    assert.equal(xl.matched_via, 'sku');
    assert.equal(xl.delta, -4); // shopify 5 − hub 9
    assert.ok(!plan.rows.some(r => r.sku_key === 'sweatshirt-001-black-xl' && r.action === 'add'),
        'via-SKU match must not also emit an add row for the same variant');
});

test('hub quantity 0 + shopify 0 is equal, not fill', () => {
    const plan = sync.buildPullPlan(catalog(), hubRows(), { mode: 'match' });
    assert.equal(findRow(plan, 'sweatshirt-001-black-l').action, 'equal');
});

test('pull plan add rows carry shopify stock as the incoming quantity', () => {
    const plan = sync.buildPullPlan(catalog(), [], { mode: 'match' });
    const added = plan.rows.filter(r => r.action === 'add');
    assert.equal(added.length, 4); // every variant is new
    assert.equal(findRow(plan, 'tee-002').shopify_qty, 30);
    assert.equal(findRow(plan, 'tee-002').hub_qty, null);
    assert.equal(plan.stats.add, 4);
    assert.equal(plan.stats.units_shopify, 47);
});

test('fill_zero mode only makes zero-stock hub rows actionable', () => {
    const plan = sync.buildPullPlan(catalog(), hubRows(), { mode: 'fill_zero' });
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').action, 'out_of_scope'); // hub 20 ≠ 0
    assert.equal(findRow(plan, 'sw-001-blk-xl').action, 'out_of_scope');
    assert.equal(findRow(plan, 'tee-002').action, 'equal');
});

test('new_only mode scopes changes to adds and neutralizes diffs', () => {
    const plan = sync.buildPullPlan(catalog(), hubRows(), { mode: 'new_only' });
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').action, 'out_of_scope');
    assert.equal(plan.rows.filter(r => r.action === 'add').length, 0); // nothing new in this fixture
    assert.equal(plan.stats.out_of_scope, 2); // m and xl differ; l/tee are equal
});

/* ───────────────────────── pull apply ───────────────────────── */

test('pull apply batches SQL: 1 select + chunked inserts + 1 unnest update + ledger', async () => {
    const plan = sync.buildPullPlan(catalog(), hubRows(), { mode: 'match' });
    const selected = plan.rows.filter(r => ['add', 'fill', 'update'].includes(r.action));
    const existing = [{ sku_key: 'sweatshirt-001-black-m', quantity: 20 }, { sku_key: 'sw-001-blk-xl', quantity: 9 }];
    const db = fakeDb(existing);
    const res = await sync.applyPullPlan(db, selected, { performedBy: 'tester' });

    const sqls = db.executed.map(e => e.sql);
    assert.equal(sqls.filter(s => s.startsWith('SELECT sku_key, quantity FROM manual_inventory WHERE sku_key = ANY')).length, 1,
        'existence re-check must be a single ANY($1) query, not per SKU');
    assert.equal(sqls.filter(s => s.startsWith('UPDATE manual_inventory m SET quantity = s.qty')).length, 1,
        'all quantity updates in one UNNEST statement');
    const updateStmt = db.executed.find(e => e.sql.startsWith('UPDATE manual_inventory m SET quantity = s.qty'));
    assert.deepEqual(updateStmt.params[0], ['sweatshirt-001-black-m', 'sw-001-blk-xl']);
    assert.deepEqual(updateStmt.params[1], [12, 5]);
    assert.ok(sqls.some(s => s.includes("INSERT INTO inventory_adjustments") && s.includes("'shopify_pull'")));
    // this fixture's actionable rows are all matched hub keys (m, xl) → updates only;
    // the add branch is exercised by the per-row-failure test below
    assert.equal(res.updated, 2);
    assert.equal(res.added, 0);
    assert.equal(res.failures.length, 0);
});

test('pull apply records per-row failures and keeps the ledger clean', async () => {
    const rows = [
        { sku_key: 'a', product_name: 'A', size: 'M', shopify_qty: 5, action: 'add', delta: 5 },
        { sku_key: 'b', product_name: 'B', size: 'M', shopify_qty: 7, action: 'update', delta: 2 },
    ];
    const db = fakeDb([{ sku_key: 'b', quantity: 5 }]);
    db.query = async (sql, params = []) => {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        if (flat.startsWith('SELECT sku_key, quantity')) return [{ sku_key: 'b', quantity: 5 }];
        if (flat.startsWith('UPDATE manual_inventory')) throw new Error('boom');
        return [];
    };
    const res = await sync.applyPullPlan(db, rows);
    assert.equal(res.updated, 0);
    assert.equal(res.added, 1);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].sku_key, 'b');
    assert.equal(res.unitsDelta, 5); // only the successful add counts
});

test('pull apply with empty selection is a no-op', async () => {
    const db = fakeDb();
    const res = await sync.applyPullPlan(db, []);
    assert.deepEqual(res, { added: 0, updated: 0, skipped: 0, unitsDelta: 0, failures: [] });
    assert.equal(db.executed.length, 0);
});

/* ───────────────────────── push plan ───────────────────────── */

test('push plan computes hub−shopify deltas and flags unmatched rows', () => {
    const totals = new Map([[911, 12], [912, 3], [913, 5], [921, 30]]);
    const plan = sync.buildPushPlan(catalog(), hubRows(), totals);
    const m = findRow(plan, 'sweatshirt-001-black-m');
    assert.equal(m.action, 'increase'); // hub 20 − shopify 12
    assert.equal(m.delta, 8);
    assert.equal(m.inventory_item_id, 911);
    const l = findRow(plan, 'sweatshirt-001-black-l');
    assert.equal(l.action, 'decrease'); // hub 0 − shopify 3
    assert.equal(l.delta, -3);
    assert.equal(findRow(plan, 'tee-002').action, 'equal');
    assert.equal(findRow(plan, 'sw-001-blk-xl').matched_via, 'sku');
    assert.equal(findRow(plan, 'discontinued-piece').action, 'no_match');
    assert.equal(plan.stats.increase, 2); // m +8 and xl +4
    // m +8, xl hub9−shopify5 +4, l −3, tee 0 → net +9
    assert.equal(plan.stats.net_delta, 9);
});

test('push plan falls back to catalog inventory when levels read returned nothing', () => {
    const plan = sync.buildPushPlan(catalog(), hubRows(), new Map());
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').shopify_qty, 12);
});

/* ───────────────────────── push job runner ───────────────────────── */

test('push job writes per-SKU deltas through the client and persists run rows', async () => {
    const client = immediateClient();
    const db = fakeDb();
    const tasks = [
        { sku_key: 'sweatshirt-001-black-m', product_name: 'S', size: 'M', inventory_item_id: 911, delta: 8 },
        { sku_key: 'sweatshirt-001-black-l', product_name: 'S', size: 'L', inventory_item_id: 912, delta: -3 },
        { sku_key: 'zero-delta', product_name: 'Z', size: 'M', inventory_item_id: 999, delta: 0 },
        { sku_key: 'no-iid', product_name: 'N', size: 'M', inventory_item_id: null, delta: 5 },
    ];
    const job = await sync.runPushJob({ client, db, tasks, reference: 'test', performedBy: 'tester' });
    await until(() => job.finishedAt);
    assert.equal(job.status, 'done');
    assert.equal(job.total, 2, 'zero-delta and no-iid tasks are filtered out up front');
    assert.equal(job.succeeded, 2);
    assert.equal(job.unitsDelta, 5);
    // item 912 has no levels in the fake → decreases are never silently dropped
    assert.equal(client.adjusts.length, 2);
    // level with most available (location 2) is the adjust target
    assert.equal(client.adjusts[0].locationId, 2);
    assert.equal(client.adjusts[0].availableDelta, 8);
    assert.ok(db.executed.some(e => e.sql.startsWith('INSERT INTO shopify_inventory_sync_runs')));
    assert.ok(db.executed.some(e => e.sql.startsWith('UPDATE shopify_inventory_sync_runs')));
});

test('push job records per-SKU failures without stopping the run', async () => {
    const client = immediateClient({
        async adjustInventoryLevel(t) {
            client.adjusts.push(t);
            if (t.inventoryItemId === 912) return { success: false, error: 'No location tracks this item' };
            return { success: true, availableAfterChange: 20 };
        },
    });
    const tasks = [
        { sku_key: 'a', product_name: 'A', size: 'M', inventory_item_id: 911, delta: 8 },
        { sku_key: 'b', product_name: 'B', size: 'L', inventory_item_id: 912, delta: -3 },
        { sku_key: 'c', product_name: 'C', size: 'XL', inventory_item_id: 913, delta: 1 },
    ];
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => job.finishedAt);
    assert.equal(job.succeeded, 2);
    assert.equal(job.failed, 1);
    assert.equal(job.results.find(r => r.sku_key === 'b').ok, false);
    assert.equal(client.adjusts.length, 3, 'a failing SKU must not abort the queue');
});

test('cancelling a push job stops it after the in-flight SKU', async () => {
    let releaseGate;
    const client = immediateClient({
        async getInventoryLevels() { return { byId: new Map(), totals: new Map() }; },
        async adjustInventoryLevel(t) {
            client.adjusts.push(t);
            if (t.inventoryItemId === 2) return new Promise(res => { releaseGate = () => res({ success: true, availableAfterChange: 0 }); });
            return { success: true, availableAfterChange: 0 };
        },
    });
    const tasks = [1, 2, 3, 4].map(i => ({ sku_key: `s${i}`, product_name: `S${i}`, size: 'M', inventory_item_id: i, delta: i }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => client.adjusts.length >= 2);
    assert.ok(sync.getActivePushJob(), 'active-job guard reports the running job');
    sync.cancelJob(job.id);
    releaseGate();
    await until(() => job.finishedAt);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.done, 2);
    assert.equal(client.adjusts.length, 2, 'task 3/4 must not be sent after cancel');
    assert.equal(sync.getActivePushJob(), null, 'finished job releases the guard');
});

test('fresh items with no levels fall back to the default location', async () => {
    const client = immediateClient({
        async getInventoryLevels() { return { byId: new Map(), totals: new Map() }; },
    });
    const job = await sync.runPushJob({ client, db: fakeDb(),
        tasks: [{ sku_key: 'a', product_name: 'A', size: 'M', inventory_item_id: 911, delta: 4 }] });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts[0].locationId, 1, 'first location is the default');
});

test('absolute push job maps hub rows to inventory items and reports unmatched', async () => {
    const client = immediateClient();
    const { job, unmatched } = await sync.startAbsolutePushJob({
        client, db: fakeDb(), catalog: catalog(), hubRows: hubRows(),
        selectedSkuKeys: ['sweatshirt-001-black-m', 'discontinued-piece'],
    });
    assert.deepEqual(unmatched, ['discontinued-piece']);
    assert.equal(job.total, 1);
    await until(() => job.finishedAt);
    assert.equal(client.adjusts[0].inventoryItemId, 911);
    // absolute push re-reads levels: hub 20 − fresh total 14 = +6
    assert.equal(client.adjusts[0].availableDelta, 6);
});

test('delta push job (bulk in/out mirror) resolves keys through the catalog index', async () => {
    const client = immediateClient();
    const { job, unmatched } = await sync.startDeltaPushJob({
        client, db: fakeDb(), catalog: catalog(),
        deltas: [
            { sku_key: 'tee-002', product_name: 'TEE', size: 'FREE', delta: 10 },
            { sku_key: 'sw-001-blk-xl', product_name: 'S', size: 'XL', delta: -2 }, // via SKU index
            { sku_key: 'ghost', product_name: 'G', size: 'M', delta: 1 },
        ],
    });
    assert.deepEqual(unmatched, ['ghost']);
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 2);
    assert.ok(client.adjusts.some(a => a.inventoryItemId === 913 && a.availableDelta === -2));
});

test('bulk mirror entry carrying a target lands Shopify on the target, not current + delta', async () => {
    const client = immediateClient(); // live totals read as 14 per item
    const { job } = await sync.startDeltaPushJob({
        client, db: fakeDb(), catalog: catalog(),
        deltas: [
            { sku_key: 'tee-002', product_name: 'TEE', size: 'FREE', delta: 10, target: 30 }, // Projected
            { sku_key: 'sw-001-blk-xl', product_name: 'S', size: 'XL', delta: -2 },           // old delta-only wire
        ],
    });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 2);
    // target wins over the hub-side delta: 30 − live 14 = +16, not 14 + 10
    assert.ok(client.adjusts.some(a => a.inventoryItemId === 921 && a.availableDelta === 16));
    // delta-only entries keep the relative behaviour
    assert.ok(client.adjusts.some(a => a.inventoryItemId === 913 && a.availableDelta === -2));
});

test('targeted bulk-out clamped at home still clears Shopify stock it still holds', async () => {
    // Local went 0 → 0 (delta 0) but Shopify holds 14; the Projected target of
    // 0 must take it down anyway.
    const client = immediateClient();
    const { job } = await sync.startDeltaPushJob({
        client, db: fakeDb(), catalog: catalog(),
        deltas: [{ sku_key: 'tee-002', product_name: 'TEE', size: 'FREE', delta: 0, target: 0 }],
    });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 1);
    assert.equal(client.adjusts[0].availableDelta, -14);
});

/* ─────────────── batched GraphQL absolute push ─────────────── */

function batchClient(overrides = {}) {
    const client = immediateClient(overrides);
    client.batches = [];
    client.setInventoryQuantities = async ({ quantities }) => {
        client.batches.push(quantities);
        return { ok: true, error: null };
    };
    return client;
}

test('absolute push batches 100 SKUs per GraphQL request when the client supports it', async () => {
    const client = batchClient(); // every item reads as loc1=4 + loc2=10, total 14
    const tasks = Array.from({ length: 101 }, (_, i) => ({
        sku_key: `k${i}`, product_name: 'P', size: 'M', inventory_item_id: 900 + i, delta: 6, target: 20,
    }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks, mode: 'absolute' });
    await until(() => job.finishedAt);
    assert.equal(client.batches.length, 2, '101 SKUs travel in two chunks');
    assert.equal(client.batches[0].length, 100);
    // set at the busiest location so the item TOTAL lands on the target:
    // available 10 + (20 − 14) = 16 — not 20, which would strand loc1's 4
    assert.deepEqual(client.batches[1][0], { inventoryItemId: 1000, locationId: 2, quantity: 16 });
    assert.equal(job.succeeded, 101);
    assert.equal(client.adjusts.length, 0, 'no per-SKU REST writes when batching works');
});

test('a rejected chunk falls back to per-SKU REST writes rather than failing the SKUs', async () => {
    const client = batchClient();
    client.setInventoryQuantities = async () => ({ ok: false, error: 'quantities.0.locationId: Location not found' });
    const job = await sync.runPushJob({ client, db: fakeDb(),
        tasks: [{ sku_key: 'k1', product_name: 'P', size: 'M', inventory_item_id: 911, delta: 6, target: 20 }],
        mode: 'absolute' });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 1, 'the SKU was still written, one at a time');
    assert.equal(client.adjusts[0].availableDelta, 6); // 20 − live 14, recomputed
    assert.equal(job.succeeded, 1);
    assert.equal(job.status, 'done');
});

test('a scope rejection on a batch aborts the job without spamming per-SKU writes', async () => {
    const client = batchClient();
    client.setInventoryQuantities = async ({ quantities }) => {
        client.batches.push(quantities); // the override replaces the recorder
        return {
            ok: false, permissionError: true,
            error: 'This action requires merchant approval for write_inventory scope',
        };
    };
    const tasks = [0, 1].map(i => ({ sku_key: `k${i}`, product_name: 'P', size: 'M', inventory_item_id: 911 + i, delta: 6, target: 20 }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks, mode: 'absolute' });
    await until(() => job.finishedAt);
    assert.equal(client.batches.length, 1, 'one batch attempt, then stop');
    assert.equal(client.adjusts.length, 0, 'the REST fallback would fail identically — never tried');
    assert.equal(job.failed, 2);
    assert.match(job.error, /write_inventory/);
});

test('delta-only tasks keep the per-SKU path even when the client can batch', async () => {
    const client = batchClient();
    const job = await sync.runPushJob({ client, db: fakeDb(),
        tasks: [{ sku_key: 'k1', product_name: 'P', size: 'M', inventory_item_id: 911, delta: 3 }],
        mode: 'delta' });
    await until(() => job.finishedAt);
    assert.equal(client.batches.length, 0, 'no absolute target means no set-quantities batch');
    assert.equal(client.adjusts.length, 1);
});

test('job snapshots bound the result tail and expose progress counters', async () => {
    const client = immediateClient();
    const tasks = Array.from({ length: 250 }, (_, i) => ({ sku_key: `k${i}`, product_name: 'P', size: 'M', inventory_item_id: 900 + i, delta: 1 }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => job.finishedAt);
    const snap = sync.jobSnapshot(job);
    assert.equal(snap.total, 250);
    assert.equal(snap.succeeded, 250);
    assert.ok(snap.results.length <= 200, 'snapshot results are capped at 200');
});

/* ─────────────── production failures that looked like success ─────────────── */

test('absolute push refuses to write when live levels cannot be read', async () => {
    // Assuming 0 stock would have added the whole hub quantity on top of the
    // real Shopify stock — the job must fail loudly instead.
    const client = immediateClient({
        async getInventoryLevels() { throw new Error('Shopify request failed'); },
    });
    const { job } = await sync.startAbsolutePushJob({
        client, db: fakeDb(), catalog: catalog(), hubRows: hubRows(),
        selectedSkuKeys: ['sweatshirt-001-black-m'],
    });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 0, 'no write may be attempted without live totals');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /could not be read/);
    assert.match(job.error, /nothing was written/);
});

test('push stops at the first missing-scope rejection instead of retrying every SKU', async () => {
    const scopeMsg = 'This action requires merchant approval for write_inventory scope.';
    const client = immediateClient({
        async adjustInventoryLevel(t) {
            client.adjusts.push(t);
            return { success: false, error: scopeMsg, permissionError: true };
        },
    });
    const tasks = [1, 2, 3, 4, 5].map(i => ({ sku_key: `s${i}`, product_name: 'P', size: 'M', inventory_item_id: i, delta: i }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 1, 'a scope error is identical for every SKU — one probe is enough');
    assert.equal(job.status, 'failed');
    assert.equal(job.error, scopeMsg);
    assert.equal(sync.jobSnapshot(job).abortedRemaining, 4);
});

test('push works without read_locations by taking the location from the levels read', async () => {
    const client = immediateClient({
        async getLocations() { throw new Error('This action requires merchant approval for read_locations scope.'); },
    });
    const tasks = [{ sku_key: 'sweatshirt-001-black-m', product_name: 'S', size: 'M', inventory_item_id: 911, delta: 8 }];
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => job.finishedAt);
    assert.equal(job.succeeded, 1, 'the max-available location from inventory_levels is enough');
    assert.equal(client.adjusts[0].locationId, 2);
});

test('delta push still reports skipped-as-equal through the snapshot', async () => {
    // The zero-write completion must be distinguishable from a real success.
    const client = immediateClient();
    const tasks = [{ sku_key: 'a', product_name: 'A', size: 'M', inventory_item_id: 911, target: 14 }]; // already 14 on Shopify
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks, mode: 'absolute' });
    await until(() => job.finishedAt);
    const snap = sync.jobSnapshot(job);
    assert.equal(snap.succeeded, 0);
    assert.equal(snap.failed, 0);
    assert.equal(snap.skipped, 1);
    assert.equal(client.adjusts.length, 0);
});

/* ─────────────── push preflight: Shopify access scopes ─────────────── */

// The live OFFCOMFRT app has read_inventory but NOT write_inventory, so every
// push SKU came back "requires merchant approval for write_inventory scope".
// The check has to fail open: a broken probe must never block a working push.
test('readiness: unknown scopes stay permissive', () => {
    for (const scopes of [null, undefined, [], 'nonsense']) {
        const r = sync.evaluatePushReadiness(scopes);
        assert.equal(r.known, false);
        assert.equal(r.pushEnabled, true, 'an unknown probe may not refuse writes');
        assert.deepEqual(r.missingScopes, []);
    }
});

test('readiness: missing write_inventory names the scope and the fix steps', () => {
    const r = sync.evaluatePushReadiness(['read_inventory', 'read_products', 'write_products', 'read_orders']);
    assert.equal(r.known, true);
    assert.equal(r.pushEnabled, false);
    assert.deepEqual(r.missingScopes, ['write_inventory']);
    assert.match(r.message, /write_inventory/);
    assert.ok(r.fixSteps.some(s => /Develop apps/i.test(s)), 'operator gets the Shopify admin path');
    assert.ok(r.fixSteps.some(s => /Reinstall/i.test(s)), 'scope edits only apply after a reinstall');
    assert.ok(r.grantedScopes.includes('read_inventory'), 'pull side is still allowed, and the payload says so');
});

test('readiness: write_inventory is matched case-insensitively', () => {
    const r = sync.evaluatePushReadiness(['READ_INVENTORY', 'Write_Inventory']);
    assert.equal(r.pushEnabled, true);
    assert.equal(r.message, null);
    assert.deepEqual(r.fixSteps, []);
});

test('getPushReadiness tolerates clients with no scope probe at all', async () => {
    const r = await sync.getPushReadiness(immediateClient()); // fake client lacks getAppScopes
    assert.equal(r.known, false);
    assert.equal(r.pushEnabled, true);

    const blocked = await sync.getPushReadiness({ async getAppScopes() { return ['read_inventory']; } });
    assert.equal(blocked.pushEnabled, false);

    const broken = await sync.getPushReadiness({ async getAppScopes() { throw new Error('Shopify request failed'); } });
    assert.equal(broken.pushEnabled, true, 'a throwing probe must read as unknown, not as denied');
});

/* ────────── live-API contract for the write (found in production) ────────── */

// inventory_levels/adjust.json takes `available_adjustment`. Sending `available`
// (the set.json param) is rejected for every SKU with "available_adjustment:
// Required parameter missing or invalid", which looks like a broken sync.
test('adjustInventoryLevel posts available_adjustment, not available', async () => {
    const axios = require('axios');
    const shopifyService = require('../src/services/shopifyService');
    const saved = { store: process.env.SHOPIFY_STORE, token: process.env.SHOPIFY_ACCESS_TOKEN };
    process.env.SHOPIFY_STORE = 'probe.myshopify.com';
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_probe_token';
    const origPost = axios.post;
    const sent = [];
    axios.post = async (url, body) => {
        sent.push({ url, body });
        // real 2024-01 shape: the level is echoed with its resulting quantity
        return { data: { inventory_level: { inventory_item_id: body.inventory_item_id, location_id: body.location_id, available: 71 } } };
    };
    try {
        const res = await shopifyService.adjustInventoryLevel({ inventoryItemId: 5, locationId: 7, availableDelta: 3 });
        assert.equal(sent.length, 1);
        assert.match(sent[0].url, /inventory_levels\/adjust\.json$/);
        assert.equal(sent[0].body.available_adjustment, 3);
        assert.ok(!('available' in sent[0].body), 'available belongs to set.json and must never be sent here');
        assert.equal(res.success, true);
        assert.equal(res.availableAfterChange, 71, 'the echoed level is what the UI reports back');
        assert.equal(res.appliedAdjustment, 3);
    } finally {
        axios.post = origPost;
        if (saved.store) process.env.SHOPIFY_STORE = saved.store; else delete process.env.SHOPIFY_STORE;
        if (saved.token) process.env.SHOPIFY_ACCESS_TOKEN = saved.token; else delete process.env.SHOPIFY_ACCESS_TOKEN;
    }
});

// Shopify answers some failures with HTTP 200 + an errors body. Counting those
// as writes is how a run of zero-applied SKUs got reported as a success.
test('a 200 carrying an errors body is not counted as a completed write', async () => {
    const axios = require('axios');
    const shopifyService = require('../src/services/shopifyService');
    const saved = { store: process.env.SHOPIFY_STORE, token: process.env.SHOPIFY_ACCESS_TOKEN };
    process.env.SHOPIFY_STORE = 'probe.myshopify.com';
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_probe_token';
    const origPost = axios.post;
    axios.post = async () => ({ data: { errors: 'inventory_item_id is not a valid InventoryItem' } });
    try {
        const res = await shopifyService.adjustInventoryLevel({ inventoryItemId: 5, locationId: 7, availableDelta: 3 });
        assert.equal(res.success, false);
        assert.match(res.error, /not a valid InventoryItem/);
    } finally {
        axios.post = origPost;
        if (saved.store) process.env.SHOPIFY_STORE = saved.store; else delete process.env.SHOPIFY_STORE;
        if (saved.token) process.env.SHOPIFY_ACCESS_TOKEN = saved.token; else delete process.env.SHOPIFY_ACCESS_TOKEN;
    }
});

test('push stops after the same non-scope rejection repeats 3× rather than all SKUs', async () => {
    const msg = 'available_adjustment: Required parameter missing or invalid';
    const client = immediateClient({
        async adjustInventoryLevel(t) { client.adjusts.push(t); return { success: false, error: msg }; },
    });
    const tasks = Array.from({ length: 20 }, (_, i) => ({ sku_key: `s${i}`, product_name: 'P', size: 'M', inventory_item_id: 900 + i, delta: 1 }));
    const job = await sync.runPushJob({ client, db: fakeDb(), tasks });
    await until(() => job.finishedAt);
    assert.equal(client.adjusts.length, 3, 'a systemic rejection is proven in three attempts, not two hundred');
    assert.equal(job.status, 'failed');
    assert.equal(sync.jobSnapshot(job).abortedRemaining, 17);
    assert.match(job.error, /repeated on 3 SKU\(s\) in a row/);
    assert.match(job.error, /Nothing further was written/i);
});

/* ─────────── what a push would do to the storefront ─────────── */

// A push aligns Shopify to the hub, so a hub row sitting at 0 clears a SKU that
// has real stock. That has to be visible as a number before the button is
// pressed: 107 live SKUs were zeroed once when only the net figure was shown.
test('planAbsolutePush totals units added, removed and SKUs cleared before writing', async () => {
    const client = immediateClient(); // every item at 14
    const { matched, unmatched, impact } = await sync.planAbsolutePush({
        client, catalog: catalog(), hubRows: hubRows(),
    });
    // M 20 (+6), L 0 (−14), XL 9 (−5), TEE 30 (+16); discontinued-piece has no variant
    assert.equal(matched.length, 4);
    assert.deepEqual(unmatched, ['discontinued-piece']);
    assert.equal(impact.skus_up, 2);
    assert.equal(impact.units_added, 22);
    assert.equal(impact.skus_down, 2);
    assert.equal(impact.units_removed, 19, 'units that would leave the live store');
    assert.equal(impact.will_clear, 1, 'only the SKU the hub holds at 0 gets cleared');
    assert.equal(impact.levels_read, true);
});

test('impact falls back to the catalog cache and says the levels were not read', async () => {
    const client = immediateClient({
        async getInventoryLevels() { throw new Error('Shopify request failed'); },
    });
    const { impact } = await sync.planAbsolutePush({ client, catalog: catalog(), hubRows: hubRows() });
    assert.equal(impact.levels_read, false);
    // cached inventory: M 12 (+8), L 0 (0), XL 5 (+4), TEE 30 (0)
    assert.equal(impact.unchanged, 2);
    assert.equal(impact.units_added, 12);
});

test('a SKU already equal on Shopify is not counted as a push, so the total is honest', async () => {
    const client = immediateClient({
        async getInventoryLevels(iids) {
            const byId = new Map(); const totals = new Map();
            const equal = { 911: 20, 912: 0, 913: 9, 921: 30 };
            for (const id of iids) { totals.set(id, equal[id]); byId.set(id, [{ locationId: 1, available: equal[id] }]); }
            return { byId, totals };
        },
    });
    const { job, impact } = await sync.startAbsolutePushJob({
        client, db: fakeDb(), catalog: catalog(), hubRows: hubRows(),
    });
    await until(() => job.finishedAt);
    assert.equal(impact.unchanged, 4);
    assert.equal(job.total, 0, 'nothing to write means nothing is reported as a push');
    assert.equal(client.adjusts.length, 0);
});

test('push plan marks hub rows changed since the last push and totals the removals', () => {
    const totals = new Map([[911, 20], [912, 40], [913, 9], [921, 30]]);
    const rows = hubRows().map(h => ({
        ...h,
        updated_at: h.sku_key === 'sweatshirt-001-black-l' ? '2026-11-12T09:00:00Z' : '2026-11-01T09:00:00Z',
    }));
    const since = Date.parse('2026-11-10T00:00:00Z');
    const plan = sync.buildPushPlan(catalog(), rows, totals, { sinceMs: since });
    const cleared = findRow(plan, 'sweatshirt-001-black-l');
    assert.equal(cleared.recent, true, 'edited after the last push — this is the change the operator means to send');
    assert.equal(findRow(plan, 'sweatshirt-001-black-m').recent, false);
    assert.equal(plan.stats.units_removed, 40);
    assert.equal(plan.stats.units_added, 0);
    assert.equal(plan.stats.will_clear, 1);
    assert.equal(plan.stats.recent_diffs, 1, 'one row to preselect, not the whole diff');
    assert.equal(plan.stats.net_delta, -40);
});

/* ── customer-order stock deductions ───────────────────────── */

test('order lines deduct the exact manual SKU and aggregate duplicate lines', async () => {
    const rows = [
        { sku_key: 'waffle-001-b-s', product_name: 'WAFFLE - 001 ( B )', size: 'S' },
        { sku_key: 'waffle-001-b-xs', product_name: 'WAFFLE - 001 ( B )', size: 'XS' },
    ];
    const items = [
        { title: 'WAFFLE - 001 ( B )', variant_title: 'S', quantity: 2 },
        { title: 'WAFFLE  - 001(B)', variant_title: 'Size: S', quantity: 1 },
        { title: 'WAFFLE - 001 ( B )', variant_title: 'XS', quantity: 1 },
    ];
    const plan = await shoppersInventory.planOrderDeductions(items, rows);
    assert.deepEqual(plan.deductions, [
        { sku_key: 'waffle-001-b-s', product_name: 'WAFFLE - 001 ( B )', size: 'S', quantity: 3 },
        { sku_key: 'waffle-001-b-xs', product_name: 'WAFFLE - 001 ( B )', size: 'XS', quantity: 1 },
    ]);
    assert.deepEqual(plan.unmatched, []);
});

test('bundle sales expand into component stock before deduction', async () => {
    const rows = [{ sku_key: 'waffle-001-b-s', product_name: 'WAFFLE - 001 ( B )', size: 'S' }];
    const bundles = [{ bundle_sku: 'WAFFLE BUNDLE', component_sku: 'WAFFLE - 001 ( B )', component_qty: 2 }];
    const items = shoppersInventory.expandBundleItems([
        { title: 'WAFFLE BUNDLE', variant_title: 'S', quantity: 2 },
    ], bundles);
    const plan = await shoppersInventory.planOrderDeductions(items, rows);
    assert.equal(plan.deductions.length, 1);
    assert.equal(plan.deductions[0].quantity, 4);
    assert.deepEqual(plan.unmatched, []);
});

test('catalog variant id resolves a sheet key that differs from the Shopify handle key', async () => {
    const rows = [{ sku_key: 'sheet-waffle-s', product_name: 'Legacy Waffle', size: 'S' }];
    const products = [{
        id: 1, title: 'WAFFLE - 001 ( B )', handle: 'waffle-001-b',
        variants: [{ id: 11, title: 'S', sku: 'sheet-waffle-s', inventory_item_id: 911, inventory: 5 }],
    }];
    const plan = await shoppersInventory.planOrderDeductions([
        { title: 'Renamed Waffle', variant_id: 11, variant_title: 'S', quantity: 1 },
    ], rows, { catalog: products });
    assert.equal(plan.deductions[0].sku_key, 'sheet-waffle-s');
    assert.deepEqual(plan.unmatched, []);
});

function inventoryLedgerClient(initialQuantity) {
    const state = { quantity: initialQuantity, updates: 0, claims: new Set() };
    return {
        state,
        async query(sql, params = []) {
            if (sql.includes('FROM manual_inventory') && sql.includes('FOR UPDATE')) {
                return { rows: [{ sku_key: params[0], product_name: 'WAFFLE - 001 ( B )', size: 'S', quantity: state.quantity }] };
            }
            if (sql.includes('FROM inventory_adjustments')) {
                if (sql.includes('SELECT sku_key, quantity_change')) return { rows: state.sales || [] };
                if (sql.includes('COALESCE(SUM(quantity_change)')) return { rows: [] };
                const type = sql.includes("'sale_restock'") ? 'sale_restock' : 'sale';
                const key = `${type}:${params[0]}:${params[1]}`;
                return { rows: state.claims.has(key) ? [{ id: 1 }] : [] };
            }
            if (sql.includes('INSERT INTO inventory_adjustments')) {
                const type = sql.includes("'sale_restock'") ? 'sale_restock' : 'sale';
                const key = `${type}:${params[6]}:${params[0]}`;
                if (state.claims.has(key)) return { rows: [] };
                state.claims.add(key);
                return { rows: [{ id: state.claims.size }] };
            }
            if (sql.includes('UPDATE manual_inventory SET quantity')) {
                state.quantity = params[0];
                state.updates++;
                return { rows: [] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

test('duplicate order webhooks cannot deduct the same SKU twice', async () => {
    const client = inventoryLedgerClient(10);
    const deductions = [{ sku_key: 'waffle-001-b-s', product_name: 'WAFFLE - 001 ( B )', size: 'S', quantity: 2 }];
    const first = await shoppersInventory.applySaleDeductions(client, '123', deductions);
    const retry = await shoppersInventory.applySaleDeductions(client, '123', deductions);
    assert.equal(first.applied[0].quantity_change, -2);
    assert.equal(first.applied[0].quantity_after, 8);
    assert.equal(retry.applied.length, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(client.state.quantity, 8);
    assert.equal(client.state.updates, 1);
});

test('cancellation restores only the quantity actually deducted and is idempotent', async () => {
    const client = inventoryLedgerClient(8);
    const sales = [{ sku_key: 'waffle-001-b-s', quantity_change: -2 }];
    client.state.sales = sales;
    const first = await shoppersInventory.applyCancellationRestock(client, '123', sales);
    const retry = await shoppersInventory.applyCancellationRestock(client, '123', sales);
    assert.equal(first.applied[0].quantity_change, 2);
    assert.equal(first.applied[0].quantity_after, 10);
    assert.equal(retry.applied.length, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(client.state.quantity, 10);
    assert.equal(client.state.updates, 1);
});

test('order ingestion deducts once across repeated deliveries', async () => {
    const rows = [{ sku_key: 'waffle-001-b-s', product_name: 'WAFFLE - 001 ( B )', size: 'S' }];
    const ledger = inventoryLedgerClient(10);
    const client = {
        async query(sql, params = []) {
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
            if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
            return ledger.query(sql, params);
        },
        release() {},
    };
    const db = {
        async query(sql) {
            if (sql.includes('FROM manual_inventory')) return rows;
            return [];
        },
    };
    const deps = { db, pool: { connect: async () => client }, loadCatalog: async () => [] };
    const order = { order_number: 123, line_items: [{ title: 'WAFFLE - 001 ( B )', variant_title: 'S', quantity: 2 }] };
    const first = await shoppersInventory.deductOrderStock(order, deps);
    const retry = await shoppersInventory.deductOrderStock(order, deps);
    assert.equal(first.deducted, 2);
    assert.equal(retry.deducted, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(ledger.state.quantity, 8);
    assert.equal(ledger.state.updates, 1);
});

test('Shopify and GoKwik order ids normalize to one deduction reference', () => {
    assert.equal(shoppersInventory.orderKeyOf({ order_number: 123, name: '#123' }), '123');
    assert.equal(shoppersInventory.orderKeyOf({ name: '#123' }), '123');
    assert.equal(shoppersInventory.orderKeyOf({ id: 456 }), '456');
});

/* ── RTO, returns, and exchanges ───────────────────────────── */

const reverseSku = 'waffle-001-b-s';
const reverseSkuM = 'waffle-001-b-m';
const reverseRows = [
    { sku_key: reverseSku, product_name: 'WAFFLE - 001 ( B )', size: 'S' },
    { sku_key: reverseSkuM, product_name: 'WAFFLE - 001 ( B )', size: 'M' },
];
const reverseItem = size => ({ title: 'WAFFLE - 001 ( B )', variant_title: size, quantity: 1 });

function reverseInventoryLedgerClient(initialQuantities, initialAdjustments = []) {
    const quantities = new Map(Object.entries(initialQuantities));
    const adjustments = initialAdjustments.map(row => ({ ...row }));
    const state = { quantities, adjustments, updates: 0 };
    const restockTypes = new Set(['sale_restock', 'rto_restock', 'return_restock', 'exchange_restock']);
    const belongsToOrder = (row, orderKey) => row.reference === orderKey
        || ['return:', 'refund:', 'exchange:'].some(prefix =>
            String(row.reference || '').startsWith(`${prefix}${orderKey}:`));

    return {
        state,
        async query(sql, params = []) {
            if (sql.includes('FROM manual_inventory') && sql.includes('FOR UPDATE')) {
                if (!quantities.has(params[0])) return { rows: [] };
                return {
                    rows: [{
                        sku_key: params[0],
                        product_name: 'WAFFLE - 001 ( B )',
                        size: params[0] === reverseSku ? 'S' : 'M',
                        quantity: quantities.get(params[0]),
                    }],
                };
            }
            if (sql.includes('SELECT 1 FROM inventory_adjustments')) {
                const type = sql.match(/adjustment_type = '([^']+)'/)?.[1];
                const exists = adjustments.some(row =>
                    row.reference === params[0] && row.sku_key === params[1] && row.adjustment_type === type);
                return { rows: exists ? [{ id: 1 }] : [] };
            }
            if (sql.includes('SELECT sku_key, quantity_change FROM inventory_adjustments')) {
                const saleOnly = sql.includes("adjustment_type = 'sale'");
                return {
                    rows: adjustments
                        .filter(row => belongsToOrder(row, params[0])
                            && Number(row.quantity_change) < 0
                            && (!saleOnly || row.adjustment_type === 'sale'))
                        .sort((a, b) => a.sku_key.localeCompare(b.sku_key)),
                };
            }
            if (sql.includes('SELECT sku_key, COALESCE(SUM(quantity_change)')) {
                const totals = new Map();
                for (const row of adjustments) {
                    if (!belongsToOrder(row, params[0]) || !restockTypes.has(row.adjustment_type)) continue;
                    totals.set(row.sku_key, (totals.get(row.sku_key) || 0) + Number(row.quantity_change));
                }
                return { rows: [...totals].map(([sku_key, restored]) => ({ sku_key, restored })) };
            }
            if (sql.includes('INSERT INTO inventory_adjustments')) {
                const type = ['sale', 'sale_restock', 'rto_restock', 'return_restock', 'exchange_restock', 'exchange_sale']
                    .find(candidate => sql.includes(`'${candidate}'`));
                const reference = params[6];
                const skuKey = params[0];
                if (adjustments.some(row =>
                    row.reference === reference && row.sku_key === skuKey && row.adjustment_type === type)) {
                    return { rows: [] };
                }
                adjustments.push({
                    sku_key: skuKey,
                    adjustment_type: type,
                    quantity_change: Number(params[3]),
                    reference,
                });
                return { rows: [{ id: adjustments.length }] };
            }
            if (sql.includes('UPDATE manual_inventory SET quantity')) {
                quantities.set(params[2], params[0]);
                state.updates++;
                return { rows: [] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
}

function reverseInventoryDeps(ledger) {
    const client = {
        async query(sql, params = []) {
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
            if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
            return ledger.query(sql, params);
        },
        release() {},
    };
    return {
        db: {
            async query(sql) {
                if (sql.includes('FROM manual_inventory')) return reverseRows;
                if (sql.includes('FROM zoho_bundle_map')) return [];
                if (sql.includes('FROM inventory_name_aliases')) return [];
                throw new Error(`Unexpected context SQL: ${sql}`);
            },
        },
        pool: { connect: async () => client },
        loadCatalog: async () => [],
    };
}

test('RTO delivery restores the actual sale once and cannot overlap cancellation', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 8 }, [
        { reference: '123', sku_key: reverseSku, adjustment_type: 'sale', quantity_change: -2 },
    ]);
    const deps = reverseInventoryDeps(ledger);

    const first = await shoppersInventory.restockRTOOrder({ order_number: '#123' }, deps);
    const retry = await shoppersInventory.restockRTOOrder({ order_number: '123' }, deps);
    const cancellation = await shoppersInventory.restockCancelledOrder({ order_number: '123' }, deps);

    assert.equal(first.restored, 2);
    assert.equal(retry.restored, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(cancellation.restored, 0);
    assert.equal(cancellation.exhausted, 1);
    assert.equal(ledger.state.quantities.get(reverseSku), 10);
    assert.equal(ledger.state.updates, 1);
    assert.equal(ledger.state.adjustments.filter(row => row.adjustment_type === 'rto_restock').length, 1);
});

test('partial returns are capped by the quantity actually deducted', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 7 }, [
        { reference: '123', sku_key: reverseSku, adjustment_type: 'sale', quantity_change: -3 },
    ]);
    const deps = reverseInventoryDeps(ledger);
    const twoUnits = [{ ...reverseItem('S'), quantity: 2 }];

    const first = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: twoUnits, eventId: 'return:REQ-1', deps,
    });
    const second = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: twoUnits, eventId: 'return:REQ-2', deps,
    });
    const retry = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: twoUnits, eventId: 'return:REQ-1', deps,
    });
    const exhausted = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: [reverseItem('S')], eventId: 'return:REQ-3', deps,
    });

    assert.equal(first.restored, 2);
    assert.equal(second.restored, 1, 'the second return can restore only the remaining sold unit');
    assert.equal(retry.restored, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(exhausted.restored, 0);
    assert.equal(exhausted.exhausted, 1);
    assert.equal(ledger.state.quantities.get(reverseSku), 10);
    assert.equal(ledger.state.updates, 2);
});

test('Shopify refunds skip no_restock lines and restock only the refunded quantity', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 8 }, [
        { reference: '123', sku_key: reverseSku, adjustment_type: 'sale', quantity_change: -2 },
    ]);
    const deps = reverseInventoryDeps(ledger);
    const lineItem = { title: 'WAFFLE - 001 ( B )', variant_title: 'S', quantity: 1 };
    const refund = {
        id: 555,
        refund_line_items: [
            { line_item: lineItem, quantity: 1, restock_type: 'no_restock' },
            { line_item: lineItem, quantity: 1, restock_type: 'return' },
        ],
    };

    const first = await shoppersInventory.restockShopifyRefund({ order_number: '#123' }, refund, deps);
    const retry = await shoppersInventory.restockShopifyRefund({ order_number: '123' }, refund, deps);
    const skipped = await shoppersInventory.restockShopifyRefund({ order_number: '123' }, {
        id: 556, refund_line_items: [{ line_item: lineItem, quantity: 1, restock_type: 'no_restock' }],
    }, deps);

    assert.equal(first.restored, 1);
    assert.equal(first.reference, 'refund:123:555');
    assert.equal(retry.restored, 0);
    assert.equal(retry.duplicates, 1);
    assert.equal(skipped.skipped, 'no_restockable_items');
    assert.equal(ledger.state.quantities.get(reverseSku), 9);
    assert.equal(ledger.state.updates, 1);
});

test('advance exchange deducts on dispatch and restocks the original on receipt', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 9, [reverseSkuM]: 5 }, [
        { reference: '123', sku_key: reverseSku, adjustment_type: 'sale', quantity_change: -1 },
    ]);
    const deps = reverseInventoryDeps(ledger);

    const dispatched = await shoppersInventory.deductExchangeReplacement({
        order: { order_number: '123' }, items: [reverseItem('M')], eventId: 'REQ-EX-1', deps,
    });
    const dispatchRetry = await shoppersInventory.deductExchangeReplacement({
        order: { order_number: '123' }, items: [reverseItem('M')], eventId: 'REQ-EX-1', deps,
    });
    const received = await shoppersInventory.restockExchangeItems({
        order: { order_number: '123' }, items: [reverseItem('S')], eventId: 'REQ-EX-1', deps,
    });
    const receiptRetry = await shoppersInventory.restockExchangeItems({
        order: { order_number: '123' }, items: [reverseItem('S')], eventId: 'REQ-EX-1', deps,
    });
    const replacementReturned = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: [reverseItem('M')], eventId: 'return:REQ-EX-2', deps,
    });

    assert.equal(dispatched.deducted, 1);
    assert.equal(dispatchRetry.deducted, 0);
    assert.equal(dispatchRetry.duplicates, 1);
    assert.equal(received.restored, 1);
    assert.equal(receiptRetry.restored, 0);
    assert.equal(receiptRetry.duplicates, 1);
    assert.equal(replacementReturned.restored, 1, 'an exchanged replacement can later be returned against its own deduction');
    assert.equal(ledger.state.quantities.get(reverseSku), 10);
    assert.equal(ledger.state.quantities.get(reverseSkuM), 5);
    assert.equal(ledger.state.updates, 3);
    assert.equal(ledger.state.adjustments.filter(row => row.adjustment_type === 'exchange_sale').length, 1);
    assert.equal(ledger.state.adjustments.filter(row => row.adjustment_type === 'exchange_restock').length, 1);
});

test('whole-order cancellation restores the original sale without touching an exchange replacement', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 9, [reverseSkuM]: 4 }, [
        { reference: '123', sku_key: reverseSku, adjustment_type: 'sale', quantity_change: -1 },
        { reference: 'exchange:123:REQ-EX-1', sku_key: reverseSkuM, adjustment_type: 'exchange_sale', quantity_change: -1 },
    ]);
    const deps = reverseInventoryDeps(ledger);

    const result = await shoppersInventory.restockCancelledOrder({ order_number: '123' }, deps);

    assert.equal(result.restored, 1);
    assert.equal(ledger.state.quantities.get(reverseSku), 10);
    assert.equal(ledger.state.quantities.get(reverseSkuM), 4);
    assert.equal(ledger.state.updates, 1);
});

test('a return cannot restock an order with no matching deduction ledger', async () => {
    const ledger = reverseInventoryLedgerClient({ [reverseSku]: 10 });
    const deps = reverseInventoryDeps(ledger);

    const result = await shoppersInventory.restockReturnedItems({
        order: { order_number: '123' }, items: [reverseItem('S')], eventId: 'return:REQ-1', deps,
    });

    assert.equal(result.restored, 0);
    assert.equal(result.exhausted, 1);
    assert.equal(ledger.state.quantities.get(reverseSku), 10);
    assert.equal(ledger.state.updates, 0);
});
