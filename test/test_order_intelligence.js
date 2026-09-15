/**
 * Test Suite for Requirement 1: Complete Order Intelligence
 * 
 * Verifies:
 *  1. Complete order lookup across multiple data sources (Shopify, Shoppers Hub, Shipments, Carriers, Returns)
 *  2. Order edit detection (original size vs changed size, customer request from WhatsApp)
 *  3. Missing / partial data handling (e.g. unshipped, no AWB, no edits)
 *  4. Invalid order ID handling (clean non-crashing found: false response)
 *  5. Shopify API failure handling (graceful fallback to DB records)
 *  6. End-to-end Copilot execution answering all 8 required officer questions
 */

const path = require('path');

// Mock require cache helper
function mockModule(modulePath, exportsObj) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── In-Memory DB Mock ─────────────────────────────────────────────
let mockDbRows = {
    store_shoppers: [],
    shopper_confirmations: [],
    shipments: [],
    orders: [],
    returns: [],
    exchanges: [],
    support_tickets: []
};

function resetDb() {
    mockDbRows = {
        store_shoppers: [],
        shopper_confirmations: [],
        shipments: [],
        orders: [],
        returns: [],
        exchanges: [],
        support_tickets: []
    };
}

const mockDbAdapter = {
    async query(sql, params = []) {
        if (/FROM\s+store_shoppers/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            const match = mockDbRows.store_shoppers.filter(r => 
                String(r.order_id).replace(/^#/, '') === idParam || 
                String(r.order_id) === String(params[0]) || 
                String(r.order_id) === String(params[1])
            );
            return match;
        }
        if (/FROM\s+shopper_confirmations/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            return mockDbRows.shopper_confirmations.filter(r => String(r.order_id).replace(/^#/, '') === idParam);
        }
        if (/FROM\s+shipments/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            return mockDbRows.shipments.filter(r => String(r.order_id).replace(/^#/, '') === idParam);
        }
        if (/FROM\s+orders/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            return mockDbRows.orders.filter(r => String(r.order_id).replace(/^#/, '') === idParam);
        }
        if (/FROM\s+returns/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            return mockDbRows.returns.filter(r => String(r.order_id).replace(/^#/, '') === idParam);
        }
        if (/FROM\s+exchanges/i.test(sql)) {
            const idParam = String(params[0] || '').replace(/^#/, '');
            return mockDbRows.exchanges.filter(r => String(r.order_id).replace(/^#/, '') === idParam);
        }
        if (/FROM\s+support_tickets/i.test(sql)) {
            return mockDbRows.support_tickets;
        }
        return [];
    },
    async run() { return { changes: 0 }; },
    async insert(table, data) {
        if (mockDbRows[table]) mockDbRows[table].push(data);
        return { id: 1 };
    },
    async update() { return { changes: 1 }; },
    async delete() { return { changes: 1 }; }
};

mockModule('../src/database/db', { dbAdapter: mockDbAdapter, initializeDatabase: async () => {} });

// Mock carriers registry
mockModule('../src/services/carriers', {
    getConfiguredCarriers: () => [
        { key: 'delhivery', name: 'Delhivery' },
        { key: 'shiprocket', name: 'Shiprocket' }
    ],
    getAdapter: (key) => ({
        key,
        isConfigured: () => true,
        track: async (awb) => {
            if (awb === 'AWB_INVALID') return { success: false, error: 'Waybill not found' };
            return {
                success: true,
                data: {
                    status: 'In Transit',
                    latestEvent: 'Out for delivery at Hub Mumbai',
                    scans: ['Out for delivery at Hub Mumbai', 'Arrived at Mumbai Gateway']
                }
            };
        }
    })
});

// Mock axios to intercept Shopify API calls
const axios = require('axios');
let shopifyMockOrders = {};
let shopifyShouldFail = false;

const originalAxiosGet = axios.get;
axios.get = async function(url, config) {
    if (url.includes('myshopify.com/admin/api')) {
        if (shopifyShouldFail) {
            const err = new Error('Shopify API 503 Service Unavailable');
            err.response = { status: 503 };
            throw err;
        }
        const nameParam = config?.params?.name;
        if (nameParam) {
            const clean = String(nameParam).replace(/^#/, '');
            const found = shopifyMockOrders[clean];
            if (found) {
                return { data: { orders: [found] } };
            }
        }
        return { data: { orders: [] } };
    }
    return originalAxiosGet.apply(this, arguments);
};

// Test harness
let passed = 0;
let failed = 0;
function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}`);
    }
}

(async () => {
    console.log('--- Testing Requirement 1: Complete Order Intelligence ---');

    process.env.SHOPIFY_STORE = 'test-store.myshopify.com';
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_12345';

    const { investigateOrder, extractItemSize, extractItemColor } = require('../src/services/orderIntelligenceService');

    // ────────────────────────────────────────────────────────────────
    // Test 1: Complete Order Lookup across all sources
    // ────────────────────────────────────────────────────────────────
    console.log('\n1. Complete Order Lookup (Shopify + Shoppers Hub + Shipments + Carrier)');
    resetDb();
    shopifyMockOrders['12345'] = {
        id: 9988776655,
        name: '#12345',
        order_number: 12345,
        created_at: '2026-08-01T10:00:00Z',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        total_price: '1999.00',
        currency: 'INR',
        discount_codes: [{ code: 'OFFCOM100', amount: '100.00' }],
        payment_gateway_names: ['razorpay'],
        customer: {
            first_name: 'Rahul',
            last_name: 'Sharma',
            email: 'rahul@example.com',
            phone: '+919876543210'
        },
        shipping_address: {
            address1: 'Flat 402, Sunshine Heights',
            city: 'Mumbai',
            province: 'Maharashtra',
            zip: '400001',
            country: 'India'
        },
        line_items: [{
            title: 'Heavyweight Boxy Tee - Black',
            sku: 'HW-BOX-BLK-M',
            variant_title: 'Black / M',
            quantity: 1,
            price: '1999.00'
        }],
        fulfillments: [{
            tracking_number: 'DEL12345678',
            tracking_company: 'Delhivery'
        }]
    };

    mockDbRows.store_shoppers.push({
        id: 101,
        order_id: '12345',
        phone: '919876543210',
        name: 'Rahul Sharma',
        payment_method: 'Prepaid',
        status: 'confirmed',
        confirmed_by: 'customer',
        delivery_type: 'Standard',
        order_total: 1999.00
    });

    mockDbRows.shipments.push({
        id: 501,
        order_id: '12345',
        carrier: 'delhivery',
        courier_name: 'Delhivery Express',
        awb: 'DEL12345678',
        status: 'in_transit',
        tracking_url: 'https://track.delhivery.com/p/DEL12345678'
    });

    const res1 = await investigateOrder('12345');
    assert(res1.found === true, 'Order was found');
    assert(res1.orderId === '#12345', 'Order ID normalized to #12345');
    assert(res1.customer.name === 'Rahul Sharma', 'Customer name extracted correctly');
    assert(res1.customer.phone.includes('9876543210'), 'Customer phone extracted correctly');
    assert(res1.payment.method === 'Prepaid', 'Payment method is Prepaid');
    assert(res1.payment.financialStatus === 'paid', 'Financial status is paid');
    assert(res1.payment.total === 1999, 'Total amount matches');
    assert(res1.payment.discount.codes?.[0]?.code === 'OFFCOM100', 'Discount code preserved');
    assert(res1.products[0].sku === 'HW-BOX-BLK-M', 'Product SKU extracted');
    assert(res1.products[0].size === 'M', 'Product size extracted');
    assert(res1.products[0].color === 'Black', 'Product color extracted');
    assert(res1.shipment.hasShipped === true, 'Order is marked shipped');
    assert(res1.shipment.carrier === 'delhivery', 'Carrier is Delhivery');
    assert(res1.shipment.awb === 'DEL12345678', 'AWB is DEL12345678');
    assert(res1.shipment.deliveryStatus === 'In Transit', 'Live carrier tracking integrated');
    assert(res1.confirmation.status === 'confirmed', 'Shoppers Hub confirmation status extracted');

    // ────────────────────────────────────────────────────────────────
    // Test 2: Order Edit Detection (Original size vs Changed size)
    // ────────────────────────────────────────────────────────────────
    console.log('\n2. Order Edit Detection (Original Size M -> Changed Size L via WhatsApp)');
    resetDb();
    shopifyMockOrders['54321'] = {
        id: 77665544,
        name: '#54321',
        order_number: 54321,
        created_at: '2026-08-02T12:00:00Z',
        financial_status: 'pending',
        fulfillment_status: null,
        total_price: '1499.00',
        payment_gateway_names: ['cash_on_delivery'],
        customer: { first_name: 'Amit', last_name: 'Verma', phone: '+919988776655' },
        line_items: [{
            title: 'Classic Relaxed Tee - White',
            sku: 'CLS-WHT-M',
            variant_title: 'White / M',
            quantity: 1,
            price: '1499.00'
        }]
    };

    mockDbRows.store_shoppers.push({
        id: 102,
        order_id: '54321',
        phone: '919988776655',
        name: 'Amit Verma',
        payment_method: 'COD',
        status: 'edit_requested',
        customer_message: 'Please change size to L instead of M',
        items_json: JSON.stringify([{
            product_name: 'Classic Relaxed Tee - White',
            sku: 'CLS-WHT-L',
            variant_title: 'White / L',
            size: 'L',
            color: 'White',
            quantity: 1,
            price: 1499.00
        }])
    });

    const res2 = await investigateOrder('#54321');
    assert(res2.found === true, 'Order #54321 found');
    assert(res2.edits.hasEdits === true, 'Edit detected');
    assert(res2.edits.originalSize === 'M', 'Original size detected as M');
    assert(res2.edits.changedSize === 'L', 'Changed size detected as L');
    assert(res2.edits.customerRequests.length > 0, 'Customer message captured');
    assert(res2.products[0].size === 'L', 'Current product size reflects the change (L)');
    assert(res2.currentIssue.includes('edit'), 'Current issue highlights pending edit before dispatch');
    assert(res2.payment.method === 'COD', 'Payment method identified as COD');
    assert(res2.shipment.hasShipped === false, 'Correctly identified as unshipped');

    // ────────────────────────────────────────────────────────────────
    // Test 3: Missing / Partial Data (No AWB, No Returns, Missing optional fields)
    // ────────────────────────────────────────────────────────────────
    console.log('\n3. Missing / Partial Data Handling');
    resetDb();
    mockDbRows.store_shoppers.push({
        id: 103,
        order_id: '99999',
        phone: '919123456789',
        name: 'Sneha Patel',
        payment_method: 'COD',
        status: 'pending',
        order_total: 999.00
    });

    const res3 = await investigateOrder('99999');
    assert(res3.found === true, 'Found in Shoppers Hub even if absent in Shopify');
    assert(res3.customer.name === 'Sneha Patel', 'Customer name present');
    assert(res3.shipment.hasShipped === false, 'Not marked as shipped');
    assert(res3.shipment.awb === null, 'AWB is null (not fabricated)');
    assert(res3.shipment.carrier === null, 'Carrier is null (not fabricated)');
    assert(res3.returns.hasReturnOrExchange === false, 'Returns accurately false');
    assert(res3.edits.hasEdits === false, 'No edits accurately false');

    // ────────────────────────────────────────────────────────────────
    // Test 4: Invalid Order ID Handling
    // ────────────────────────────────────────────────────────────────
    console.log('\n4. Invalid Order ID Handling');
    resetDb();
    const res4 = await investigateOrder('00000');
    assert(res4.found === false, 'Correctly returned found: false');
    assert(res4.error.includes('not found in any system'), 'Returns clear descriptive error message without throwing');

    const resEmpty = await investigateOrder('');
    assert(resEmpty.found === false, 'Empty order ID handled cleanly');

    // ────────────────────────────────────────────────────────────────
    // Test 5: Shopify API Failure Handling (Fallback to DB)
    // ────────────────────────────────────────────────────────────────
    console.log('\n5. Shopify API Failure Handling (Fallback to database)');
    resetDb();
    shopifyShouldFail = true;

    mockDbRows.store_shoppers.push({
        id: 105,
        order_id: '88888',
        phone: '919811223344',
        name: 'Vikram Malhotra',
        payment_method: 'COD',
        status: 'confirmed',
        order_total: 2499.00
    });
    mockDbRows.orders.push({
        order_id: '88888',
        customer_phone: '919811223344',
        status: 'shipped',
        awb: 'DEL88888',
        courier_name: 'Delhivery',
        product_name: 'Oversized Hoodie'
    });

    let res5;
    try {
        res5 = await investigateOrder('88888');
        assert(res5.found === true, 'Succeeded using DB fallback despite Shopify outage');
        assert(res5.customer.name === 'Vikram Malhotra', 'Extracted name from DB');
        assert(res5.shipment.awb === 'DEL88888', 'Extracted AWB from DB');
        assert(res5.sourcesChecked.shopify.includes('Error'), 'Logged Shopify error transparently');
    } catch (err) {
        assert(false, `Should not throw on Shopify API error: ${err.message}`);
    } finally {
        shopifyShouldFail = false;
    }

    // ────────────────────────────────────────────────────────────────
    // Test 6: Answering all 8 Customer Care Officer Questions
    // ────────────────────────────────────────────────────────────────
    console.log('\n6. Officer Questions Answering Capability');
    // Using res2 (Order #54321 with size edit)
    assert(res2.orderId === '#54321', 'Q1: Give me complete details of order #54321 -> returns complete order intelligence');
    assert(res2.currentStatus.length > 0, 'Q2: What happened to this order? -> Status available');
    assert(res2.edits.hasEdits === true, 'Q3: Was the order edited? -> Yes, confirmed');
    assert(res2.edits.originalSize === 'M', 'Q4: What size was originally ordered? -> M');
    assert(res2.edits.changedSize === 'L', 'Q5: What size was changed to? -> L');
    assert(res2.shipment.hasShipped === false, 'Q6: Has it shipped? -> No');
    assert(res2.shipment.carrier === null || res2.shipment.carrier === 'Pending Assignment', 'Q7: Which courier is handling it? -> Accurate courier info (None/Pending)');
    assert(res2.payment.method === 'COD', 'Q8: What payment method was used? -> COD');

    // ────────────────────────────────────────────────────────────────
    // Test Summary
    // ────────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('💥 Test suite crashed:', err);
    process.exit(1);
});
