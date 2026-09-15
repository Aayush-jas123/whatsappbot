/**
 * Test Suite for Requirement 2: Customer 360
 * 
 * Verifies:
 *  1. Complete Customer 360 lookup by phone number
 *  2. Customer 360 lookup by Order ID (#12345)
 *  3. Customer 360 lookup by email and customer name
 *  4. Accurate metric calculation (total orders, delivered, cancelled, returned, exchanged, total spend)
 *  5. Refund history aggregation (amounts, reasons, status)
 *  6. Open orders and open support issues tracking
 *  7. Answering all 5 required officer questions
 *  8. Factual neutrality check (zero negative bias or subjective labels)
 *  9. Error handling on unknown customer identifier
 */

const path = require('path');

// Mock require cache helper
function mockModule(modulePath, exportsObj) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── In-Memory DB Mock ─────────────────────────────────────────────
let mockDb = {
    customers: [],
    store_shoppers: [],
    orders: [],
    shipments: [],
    returns: [],
    exchanges: [],
    support_tickets: []
};

function resetDb() {
    mockDb = {
        customers: [],
        store_shoppers: [],
        orders: [],
        shipments: [],
        returns: [],
        exchanges: [],
        support_tickets: []
    };
}

const mockDbAdapter = {
    async query(sql, params = []) {
        if (/FROM\s+customers/i.test(sql)) {
            if (params.length === 0) return mockDb.customers;
            return mockDb.customers.filter(c => {
                for (const p of params) {
                    const cleanP = String(p).replace(/[%_]/g, '').toLowerCase();
                    if (c.phone && c.phone.includes(cleanP)) return true;
                    if (c.email && c.email.toLowerCase().includes(cleanP)) return true;
                    if (c.name && c.name.toLowerCase().includes(cleanP)) return true;
                }
                return false;
            });
        }
        if (/FROM\s+store_shoppers/i.test(sql)) {
            return mockDb.store_shoppers.filter(s => {
                for (const p of params) {
                    const cleanP = String(p).replace(/^#/, '').replace(/[%_]/g, '').toLowerCase();
                    if (s.order_id && String(s.order_id).replace(/^#/, '').toLowerCase() === cleanP) return true;
                    if (s.phone && s.phone.includes(cleanP)) return true;
                    if (s.email && s.email.toLowerCase().includes(cleanP)) return true;
                    if (s.name && s.name.toLowerCase().includes(cleanP)) return true;
                }
                return false;
            });
        }
        if (/FROM\s+orders/i.test(sql)) {
            return mockDb.orders.filter(o => {
                for (const p of params) {
                    const cleanP = String(p).replace(/^#/, '').replace(/[%_]/g, '').toLowerCase();
                    if (o.order_id && String(o.order_id).replace(/^#/, '').toLowerCase() === cleanP) return true;
                    if (o.customer_phone && o.customer_phone.includes(cleanP)) return true;
                }
                return false;
            });
        }
        if (/FROM\s+shipments/i.test(sql)) {
            return mockDb.shipments.filter(s => {
                for (const p of params) {
                    const cleanP = String(p).replace(/^#/, '').toLowerCase();
                    if (s.order_id && String(s.order_id).replace(/^#/, '').toLowerCase() === cleanP) return true;
                }
                return false;
            });
        }
        if (/FROM\s+returns/i.test(sql)) {
            return mockDb.returns.filter(r => {
                for (const p of params) {
                    const cleanP = String(p).replace(/^#/, '').replace(/[%_]/g, '').toLowerCase();
                    if (r.order_id && String(r.order_id).replace(/^#/, '').toLowerCase() === cleanP) return true;
                    if (r.customer_phone && r.customer_phone.includes(cleanP)) return true;
                }
                return false;
            });
        }
        if (/FROM\s+exchanges/i.test(sql)) {
            return mockDb.exchanges.filter(e => {
                for (const p of params) {
                    const cleanP = String(p).replace(/^#/, '').replace(/[%_]/g, '').toLowerCase();
                    if (e.order_id && String(e.order_id).replace(/^#/, '').toLowerCase() === cleanP) return true;
                    if (e.customer_phone && e.customer_phone.includes(cleanP)) return true;
                }
                return false;
            });
        }
        if (/FROM\s+support_tickets/i.test(sql)) {
            return mockDb.support_tickets.filter(t => {
                for (const p of params) {
                    const cleanP = String(p).replace(/[%_]/g, '').toLowerCase();
                    if (t.customer_phone && t.customer_phone.includes(cleanP)) return true;
                    if (t.message && t.message.toLowerCase().includes(cleanP)) return true;
                }
                return false;
            });
        }
        return [];
    },
    async run() { return { changes: 0 }; },
    async insert(table, data) {
        if (mockDb[table]) mockDb[table].push(data);
        return { id: 1 };
    },
    async update() { return { changes: 1 }; },
    async delete() { return { changes: 1 }; }
};

mockModule('../src/database/db', { dbAdapter: mockDbAdapter, initializeDatabase: async () => {} });

// Mock axios for Shopify customer API calls
const axios = require('axios');
const originalAxiosGet = axios.get;
axios.get = async function(url, config) {
    if (url.includes('myshopify.com/admin/api/2024-01/customers/search.json')) {
        return { data: { customers: [] } };
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
    console.log('--- Testing Requirement 2: Customer 360 ---');

    const { getCustomer360, resolveCustomerTarget, normalizePhone } = require('../src/services/customer360Service');

    // ────────────────────────────────────────────────────────────────
    // Test 1: Complete Customer 360 Lookup by Phone
    // ────────────────────────────────────────────────────────────────
    console.log('\n1. Customer 360 Lookup by Phone (Profile, Orders, Spend, Issues)');
    resetDb();

    mockDb.customers.push({
        phone: '919876543210',
        name: 'Aakash Verma',
        email: 'aakash@example.com',
        preferred_language: 'en',
        created_at: '2026-03-15T10:00:00Z'
    });

    // 4 orders: 2 delivered, 1 cancelled, 1 in transit
    mockDb.store_shoppers.push(
        {
            id: 1,
            order_id: '1001',
            phone: '919876543210',
            name: 'Aakash Verma',
            status: 'confirmed',
            order_total: 1499.00,
            address: '12 Green Park',
            city: 'Delhi',
            province: 'Delhi',
            zip: '110016',
            created_at: '2026-04-01T10:00:00Z'
        },
        {
            id: 2,
            order_id: '1002',
            phone: '919876543210',
            name: 'Aakash Verma',
            status: 'confirmed',
            order_total: 1999.00,
            address: '12 Green Park',
            city: 'Delhi',
            province: 'Delhi',
            zip: '110016',
            created_at: '2026-05-01T10:00:00Z'
        },
        {
            id: 3,
            order_id: '1003',
            phone: '919876543210',
            name: 'Aakash Verma',
            status: 'cancelled',
            order_total: 999.00,
            cancel_reason: 'Changed mind before dispatch',
            shopify_cancelled_at: '2026-06-02T10:00:00Z',
            shopify_refund_amount: 999.00,
            created_at: '2026-06-01T10:00:00Z'
        },
        {
            id: 4,
            order_id: '1004',
            phone: '919876543210',
            name: 'Aakash Verma',
            status: 'confirmed',
            order_total: 2499.00,
            items_json: JSON.stringify([{ title: 'Vintage Oversized Tee', size: 'XL', quantity: 1, price: 2499 }]),
            created_at: '2026-07-20T10:00:00Z'
        }
    );

    // Link orders 1001 and 1002 as delivered, 1004 as in transit
    mockDb.orders.push(
        {
            order_id: '1001',
            customer_phone: '919876543210',
            status: 'delivered',
            delivered_at: '2026-04-05T14:00:00Z',
            total: 1499.00
        },
        {
            order_id: '1002',
            customer_phone: '919876543210',
            status: 'delivered',
            delivered_at: '2026-05-06T12:00:00Z',
            total: 1999.00
        },
        {
            order_id: '1004',
            customer_phone: '919876543210',
            status: 'in_transit',
            awb: 'DEL1004',
            courier_name: 'Delhivery',
            total: 2499.00
        }
    );

    // 1 return on order 1002
    mockDb.returns.push({
        return_id: 'RET-1002',
        order_id: '1002',
        customer_phone: '919876543210',
        reason: 'Fabric mismatch',
        status: 'completed',
        refund_amount: 1999.00,
        refund_status: 'processed',
        created_at: '2026-05-08T10:00:00Z'
    });

    // 1 open support ticket
    mockDb.support_tickets.push({
        id: 99,
        ticket_number: 'TKT-260720-001',
        customer_phone: '919876543210',
        message: 'Where is my order #1004?',
        status: 'open',
        created_at: '2026-07-22T11:00:00Z'
    });

    const res1 = await getCustomer360('9876543210');
    assert(res1.found === true, 'Customer 360 found by phone');
    assert(res1.identity.name === 'Aakash Verma', 'Identity name matched');
    assert(res1.identity.email === 'aakash@example.com', 'Identity email matched');
    assert(res1.identity.phone.includes('9876543210'), 'Phone correctly formatted');

    // Metrics validation
    assert(res1.metrics.totalOrders === 4, 'Total orders: 4');
    assert(res1.metrics.deliveredOrders === 2, 'Delivered orders: 2');
    assert(res1.metrics.cancelledOrders === 1, 'Cancelled orders: 1');
    assert(res1.metrics.returnedOrders === 1, 'Returned orders: 1');
    assert(res1.metrics.exchangedOrders === 0, 'Exchanged orders: 0');
    // Spend: 1499 + 1999 + 2499 = 5997 (non-cancelled orders)
    assert(res1.metrics.totalSpend === 5997, `Total spend calculated accurately: ₹${res1.metrics.totalSpend}`);

    // Refunds validation
    assert(res1.refundHistory.recordsCount === 2, '2 refund records found (1 cancellation + 1 return)');
    assert(res1.refundHistory.totalRefunded === 2998, `Total refund amount: ₹${res1.refundHistory.totalRefunded}`);

    // Current orders validation
    assert(res1.currentOrders.openOrdersCount === 1, '1 open order currently active');
    assert(res1.currentOrders.openOrders[0].orderId === '#1004', 'Open order is #1004');
    assert(res1.currentOrders.latestOrder.orderId === '#1004', 'Latest order is #1004');
    assert(res1.currentOrders.latestOrder.items[0].includes('Vintage Oversized Tee'), 'Latest order items included');

    // Support issues validation
    assert(res1.supportIssues.hasOpenIssues === true, 'Flagged open support issues accurately');
    assert(res1.supportIssues.openTicketsCount === 1, '1 open ticket detected');
    assert(res1.supportIssues.tickets[0].ticketNumber === 'TKT-260720-001', 'Ticket number matched');

    // ────────────────────────────────────────────────────────────────
    // Test 2: Customer 360 Lookup by Order ID
    // ────────────────────────────────────────────────────────────────
    console.log('\n2. Customer 360 Lookup by Order ID (#1004 -> Aakash Verma)');
    const res2 = await getCustomer360('#1004');
    assert(res2.found === true, 'Resolved Customer 360 via order ID #1004');
    assert(res2.resolvedBy === 'orderId', 'Resolution pathway marked as orderId');
    assert(res2.identity.name === 'Aakash Verma', 'Resolved to correct customer');
    assert(res2.metrics.totalOrders === 4, 'Loaded full order history from order ID lookup');

    // ────────────────────────────────────────────────────────────────
    // Test 3: Customer 360 Lookup by Email and Name
    // ────────────────────────────────────────────────────────────────
    console.log('\n3. Customer 360 Lookup by Email and Name');
    const resEmail = await getCustomer360('aakash@example.com');
    assert(resEmail.found === true, 'Resolved via email aakash@example.com');
    assert(resEmail.identity.phone.includes('9876543210'), 'Retrieved phone from email lookup');

    const resName = await getCustomer360('Aakash Verma');
    assert(resName.found === true, 'Resolved via customer name');
    assert(resName.metrics.totalOrders === 4, 'Loaded metrics via name lookup');

    // ────────────────────────────────────────────────────────────────
    // Test 4: Answering all 5 Target Officer Questions
    // ────────────────────────────────────────────────────────────────
    console.log('\n4. Answering Target Officer Questions');
    // Q1: "Tell me everything important about this customer."
    assert(res1.factualSummary.length > 50, 'Q1: Summary contains comprehensive factual overview');
    // Q2: "How many orders has this customer placed?"
    assert(res1.metrics.totalOrders === 4, 'Q2: How many orders -> 4');
    // Q3: "How many returns?"
    assert(res1.metrics.returnedOrders === 1, 'Q3: How many returns -> 1');
    // Q4: "What is their latest order?"
    assert(res1.currentOrders.latestOrder.orderId === '#1004', 'Q4: Latest order -> #1004');
    // Q5: "What open issues do they have?"
    assert(res1.supportIssues.openTicketsCount === 1, 'Q5: Open issues -> 1 open ticket (#TKT-260720-001)');

    // ────────────────────────────────────────────────────────────────
    // Test 5: Factual Neutrality Check (Step 7)
    // ────────────────────────────────────────────────────────────────
    console.log('\n5. Factual Neutrality Check (No negative customer bias)');
    const summary = res1.factualSummary.toLowerCase();
    const bannedPhrases = [
        'difficult',
        'problematic',
        'frequent returner',
        'serial returner',
        'bad customer',
        'troublesome',
        'abusive',
        'high risk',
        'suspicious'
    ];
    let hasBiasedTerms = false;
    for (const b of bannedPhrases) {
        if (summary.includes(b)) {
            hasBiasedTerms = true;
            console.error(`  ❌ Summary contained banned subjective term: "${b}"`);
        }
    }
    assert(!hasBiasedTerms, 'Summary is strictly factual and free from negative subjective labels');

    // ────────────────────────────────────────────────────────────────
    // Test 6: Unknown Customer Identifier Handling
    // ────────────────────────────────────────────────────────────────
    console.log('\n6. Unknown Customer Identifier Handling');
    const resNotFound = await getCustomer360('0000000000');
    assert(resNotFound.found === false, 'Unknown identifier returned found: false');
    assert(resNotFound.error.includes('No customer records found') || resNotFound.error.includes('not found'), 'Returns clean error message');

    const resBlank = await getCustomer360('');
    assert(resBlank.found === false, 'Blank identifier handled cleanly');

    // ────────────────────────────────────────────────────────────────
    // Summary
    // ────────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('💥 Test suite crashed:', err);
    process.exit(1);
});
