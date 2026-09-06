/**
 * Test: Shiprocket "order_id already taken" recovery flow.
 *
 * Patches axios.post/get globally during each test to simulate Shiprocket
 * API responses, then verifies every recovery path.
 *
 * Run: node tmp/test_sr_duplicate_recovery.js
 */

const assert = require('assert');
const axios = require('axios');
const adapter = require('../src/services/carriers/shiprocketAdapter');

const CHANNEL_ID = '10272426';
const ORDER_ID = '48970';

// ── Helpers ──────────────────────────────────────────────────────────────
function makeCtx(overrides = {}) {
    return {
        orderId: ORDER_ID,
        consignee: {
            name: 'Ravi Kumar123',
            address: '123 Main St',
            city: 'Mumbai',
            state: 'Maharashtra',
            pincode: '400001',
            country: 'India',
            email: 'ravi@test.com',
            phone: '9876543210',
            ...overrides.consignee
        },
        items: overrides.items || [{ name: 'T-Shirt', size: 'L', quantity: 1, price: 499, sku: 'TS-L' }],
        payment: { mode: 'COD', declaredValue: 499 },
        package: { lengthCm: 30, breadthCm: 40, heightCm: 2, weightGrams: 500 },
        courierId: 'auto',
        ...overrides
    };
}

function alreadyTakenError() {
    const err = new Error('Request failed with status code 422');
    err.response = {
        status: 422,
        data: {
            message: 'Oops! Invalid Data.',
            errors: { order_id: ['The order id has already been taken.'] },
            status_code: 422
        }
    };
    return err;
}

function invalidPincodeError() {
    const err = new Error('Request failed');
    err.response = {
        status: 422,
        data: {
            message: 'Oops! Invalid Data.',
            errors: { billing_pincode: ['The pincode is invalid.'] }
        }
    };
    return err;
}

// Save originals
const origAxiosPost = axios.post;
const origAxiosGet = axios.get;
const origFindSynced = adapter.findSyncedOrder;
const origAssignAwb = adapter.assignAwbAndAwait;
const origResolveChannel = adapter.resolveChannelId;
const origAuthHeaders = adapter.authHeaders;

function setupTest() {
    adapter._channelId = CHANNEL_ID;
    adapter._channels = [{ id: Number(CHANNEL_ID), name: 'Shopify', base_channel_code: 'SH' }];
    adapter.authHeaders = async () => ({ Authorization: 'Bearer mock' });
    adapter.baseURL = 'https://apiv2.shiprocket.in/v1/external';
    adapter.resolveChannelId = async () => CHANNEL_ID;
}

function teardownTest() {
    axios.post = origAxiosPost;
    axios.get = origAxiosGet;
    adapter.findSyncedOrder = origFindSynced;
    adapter.assignAwbAndAwait = origAssignAwb;
    adapter.resolveChannelId = origResolveChannel;
    adapter.authHeaders = origAuthHeaders;
}

let callLog = [];

// ── Tests ────────────────────────────────────────────────────────────────
async function runTests() {
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        callLog = [];
        setupTest();
        console.log(`\n━━━ ${name} ━━━`);
        try {
            await fn();
            console.log(`  ✅ PASSED`);
            passed++;
        } catch (e) {
            console.log(`  ❌ FAILED: ${e.message}`);
            failed++;
        } finally {
            teardownTest();
        }
    }

    // ── Test 1: Recovery via findSyncedOrder ─────────────────────────────
    await test('Recovery: findSyncedOrder finds existing order → AWB assigned', async () => {
        const existingOrder = {
            id: 999001, channel_order_id: `#${ORDER_ID}`, channel_id: Number(CHANNEL_ID),
            awb_code: null, shipment_id: 55001, billing_pincode: '400001',
            shipments: [{ shipment_id: 55001, weight: 0.5 }]
        };

        let findCount = 0;
        adapter.findSyncedOrder = async () => {
            findCount++;
            callLog.push(`findSyncedOrder(#${findCount})`);
            return findCount === 1 ? null : existingOrder; // Miss first, hit second
        };
        adapter.assignAwbAndAwait = async () => {
            callLog.push('assignAwbAndAwait');
            return { awb: 'AWB_RECOVERED_1', courierName: 'Delhivery', raw: {} };
        };

        axios.post = async (url) => {
            if (url.includes('/orders/create')) { callLog.push('POST /orders/create → 422'); throw alreadyTakenError(); }
        };
        axios.get = async () => ({ data: { data: [] } });

        const result = await adapter.createShipment(makeCtx());
        assert(result.success, `Expected success: ${result.error}`);
        assert.strictEqual(result.data.awb, 'AWB_RECOVERED_1');
        assert.strictEqual(result.data.reusedSyncedOrder, true);
        assert(findCount >= 2, `Expected ≥2 findSyncedOrder calls, got ${findCount}`);
    });

    // ── Test 2: Recovery via phone search ────────────────────────────────
    await test('Recovery: phone search finds order with different channel_order_id', async () => {
        const existingOrder = {
            id: 999002, channel_order_id: `S-${ORDER_ID}`, channel_id: Number(CHANNEL_ID),
            awb_code: null, shipment_id: 55002,
            shipments: [{ shipment_id: 55002, weight: 0.5 }]
        };

        adapter.findSyncedOrder = async () => { callLog.push('findSyncedOrder → null'); return null; };
        adapter.assignAwbAndAwait = async () => { callLog.push('assignAwbAndAwait'); return { awb: 'AWB_PHONE', courierName: 'Delhivery', raw: {} }; };

        axios.post = async (url) => {
            if (url.includes('/orders/create')) { callLog.push('POST → 422'); throw alreadyTakenError(); }
        };
        axios.get = async (url, config) => {
            const search = config?.params?.search || '';
            if (search === ORDER_ID || search === `#${ORDER_ID}`) {
                callLog.push(`search("${search}") → empty`);
                return { data: { data: [] } };
            }
            if (/\d{10,}/.test(search)) {
                callLog.push(`search("${search}") → found via phone`);
                return { data: { data: [existingOrder] } };
            }
            return { data: { data: [] } };
        };

        const result = await adapter.createShipment(makeCtx());
        assert(result.success, `Expected success: ${result.error}`);
        assert.strictEqual(result.data.awb, 'AWB_PHONE');
    });

    // ── Test 3: Recovery via recent-orders scan ──────────────────────────
    await test('Recovery: recent-orders scan finds orphan by name+amount', async () => {
        const orphan = {
            id: 999003, channel_order_id: 'ORD-48970-X', channel_id: Number(CHANNEL_ID),
            awb_code: null, billing_customer_name: 'Ravi', total: 499,
            shipment_id: 55003, shipments: [{ shipment_id: 55003, weight: 0.5 }]
        };

        adapter.findSyncedOrder = async () => null;
        adapter.assignAwbAndAwait = async () => { callLog.push('assignAwbAndAwait'); return { awb: 'AWB_RECENT', courierName: 'Xpressbees', raw: {} }; };

        axios.post = async (url) => {
            if (url.includes('/orders/create')) throw alreadyTakenError();
        };
        axios.get = async (url, config) => {
            const search = config?.params?.search;
            if (search) return { data: { data: [] } }; // All searches empty
            callLog.push('listOrders → found orphan');
            return { data: { data: [orphan] } }; // Recent orders has it
        };

        const result = await adapter.createShipment(makeCtx());
        assert(result.success, `Expected success: ${result.error}`);
        assert.strictEqual(result.data.awb, 'AWB_RECENT');
    });

    // ── Test 4: All recovery fails → proper error ────────────────────────
    await test('All recovery fails → fail with error', async () => {
        adapter.findSyncedOrder = async () => null;

        axios.post = async (url) => {
            if (url.includes('/orders/create')) throw alreadyTakenError();
        };
        axios.get = async () => ({ data: { data: [] } });

        const result = await adapter.createShipment(makeCtx());
        assert(!result.success, 'Expected failure');
        assert(result.error.includes('rejected'), `Error should mention rejection: ${result.error}`);
    });

    // ── Test 5: Non-duplicate 422 → no recovery ─────────────────────────
    await test('Non-duplicate 422 → no recovery attempted', async () => {
        let recoverySearchCount = 0;
        adapter.findSyncedOrder = async () => { recoverySearchCount++; return null; };

        axios.post = async (url) => {
            if (url.includes('/orders/create')) throw invalidPincodeError();
        };
        axios.get = async () => ({ data: { data: [] } });

        const result = await adapter.createShipment(makeCtx());
        assert(!result.success, 'Expected failure');
        // findSyncedOrder called once (initial Route 1), NOT again for recovery
        assert.strictEqual(recoverySearchCount, 1, `findSyncedOrder should be called exactly once (initial), got ${recoverySearchCount}`);
    });

    // ── Test 6: Name sanitization ────────────────────────────────────────
    await test('Name sanitization: strips digits/special chars', async () => {
        let captured = null;
        adapter.findSyncedOrder = async () => null; // Route 2
        adapter.assignAwbAndAwait = async () => ({ awb: 'AWB_NAME', courierName: 'T', raw: {} });

        axios.post = async (url, data) => {
            if (url.includes('/orders/create')) { captured = data; return { data: { shipment_id: 1, order_id: 2 } }; }
        };
        axios.get = async () => ({ data: { data: [] } });

        const result = await adapter.createShipment(makeCtx({
            consignee: {
                name: 'Ravi123 Kumar@456', phone: '9876543210', address: '123 St',
                city: 'Mumbai', state: 'MH', pincode: '400001', country: 'India', email: 'a@b.com'
            }
        }));
        assert(result.success, `Expected success: ${JSON.stringify(result)}`);
        assert.strictEqual(captured.billing_customer_name, 'Ravi', `First name: "${captured.billing_customer_name}"`);
        assert.strictEqual(captured.billing_last_name, 'Kumar', `Last name: "${captured.billing_last_name}"`);
    });

    // ── Test 7: Existing order already has AWB → return directly ─────────
    await test('Recovered order already has AWB → skip AWB assignment', async () => {
        const existing = {
            id: 999007, channel_order_id: `#${ORDER_ID}`, channel_id: Number(CHANNEL_ID),
            awb_code: 'EXISTING_AWB', courier_name: 'BlueDart', shipment_id: 55007,
            shipments: [{ shipment_id: 55007, weight: 0.5 }]
        };

        let findCount = 0;
        adapter.findSyncedOrder = async () => { findCount++; return findCount === 1 ? null : existing; };
        let awbCalled = false;
        adapter.assignAwbAndAwait = async () => { awbCalled = true; return { awb: null }; };

        axios.post = async (url) => {
            if (url.includes('/orders/create')) throw alreadyTakenError();
        };
        axios.get = async () => ({ data: { data: [] } });

        const result = await adapter.createShipment(makeCtx());
        assert(result.success, `Expected success: ${result.error}`);
        assert.strictEqual(result.data.awb, 'EXISTING_AWB');
        assert.strictEqual(result.data.courierName, 'BlueDart');
        assert(!awbCalled, 'AWB assignment should NOT be called');
    });

    // ── Summary ──────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('═'.repeat(50));
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Test runner error:', e); process.exit(1); });
