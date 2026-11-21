#!/usr/bin/env node
/**
 * End-to-end (offline) proof of the COD reconciliation fixes.
 *
 * Nothing here talks to Zoho, Shopify or Postgres. An in-memory
 * zoho_cod_payments + shipments table stands in for the DB, /customerpayments
 * and /invoices stand in for Books, and the REAL zohoCodService source runs —
 * so every assertion below is about the code that ships.
 *
 * The cases are the ones that produced "COD just shows unpaid in many orders":
 *   1. an order id arriving as "#45272" (hub tables write it that way) — the
 *      invoice lookup used to run unprefixed, find nothing and fail forever
 *   2. a search that answers with somebody else's invoice — must never pay it
 *   3. a void duplicate sitting next to the live invoice
 *   4. repeat attempts — used to INSERT a fresh unpaid row every time
 *   5. a Zoho rate limit — used to be filed as a permanent 'failed'
 *   6. the amount column — used to stay NULL, so the log read ₹0
 *   7. the backlog sweep finding a delivered COD order the live hook missed
 *   8. Shopify's prefix-ish name search returning 45271 for a 4527 lookup
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const { dbAdapter } = require(path.join(ROOT, 'src', 'database', 'db'));
const zohoService = require(path.join(ROOT, 'src', 'services', 'zohoService'));
const shopifyService = require(path.join(ROOT, 'src', 'services', 'shopifyService'));
const zohoCodService = require(path.join(ROOT, 'src', 'services', 'zohoCodService'));

// ============================================================
// In-memory tables
// ============================================================
let codRows = [];
let shipmentRows = [];
let invoicesById = {};
let paymentsRecorded = [];
let shopifyOrdersByName = {};
let cancelledSyncLog = new Set();   // orders with a 'cancelled' zoho_sync_log row
let nextRowId = 1;

const bare = id => String(id || '').replace(/^#/, '').trim();

function resetWorld() {
    codRows = [];
    shipmentRows = [];
    invoicesById = {};
    paymentsRecorded = [];
    shopifyOrdersByName = {};
    cancelledSyncLog = new Set();
    nextRowId = 1;
}

function row(orderId, status, extra = {}) {
    return {
        id: nextRowId++,
        shopify_order_id: orderId,
        payment_status: status,
        amount: null,
        carrier: 'delhivery',
        awb: 'AWB-1',
        zoho_invoice_id: null,
        zoho_payment_id: null,
        error_message: null,
        attempts: 1,
        created_at: new Date(Date.now() - 60 * 60 * 1000),
        last_attempt_at: new Date(Date.now() - 60 * 60 * 1000),
        reconciled_at: null,
        ...extra
    };
}

/** Strips the '#' the way every production query now does. */
function orderFilter(sql) {
    return sql.includes("REGEXP_REPLACE(shopify_order_id, '^#', '') = ?");
}

// ---------------------------------------------------------- the DB fake
dbAdapter.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');

    if (/FROM shipments/.test(s)) {
        if (/COUNT\(DISTINCT/.test(s)) {
            return [{ n: shipmentRows.filter(sh => sh.status === 'delivered').length }];
        }
        return shipmentRows.map(sh => ({
            order_id: bare(sh.order_id), carrier: sh.carrier, awb: sh.awb,
            delivered_at: sh.delivered_at, cod_amount: sh.cod_amount
        }));
    }

    // The cancellation path writes status='cancelled' to zoho_sync_log, keyed
    // by the BARE order number (see zohoCancelService's join).
    if (/FROM zoho_sync_log/.test(s)) {
        return cancelledSyncLog.has(bare(params[0])) ? [{ '?column?': 1 }] : [];
    }

    if (/FROM zoho_cod_payments/.test(s)) {
        if (/COUNT\(\*\)::int AS n/.test(s)) {
            return [{ n: codRows.filter(r => r.payment_status === 'reconciled').length }];
        }
        if (/COUNT\(\*\)::int as count/.test(s)) {
            const status = params[0];
            return [{ count: codRows.filter(r => r.payment_status === status).length }];
        }
        if (/SELECT \* FROM zoho_cod_payments/.test(s)) {
            return codRows.filter(r => String(r.id) === String(params[0]) && r.payment_status !== 'reconciled');
        }
        if (orderFilter(s)) {
            const orderId = bare(params[0]);
            const status = params[1];
            if (/payment_status <> 'reconciled'/.test(s)) {
                return codRows
                    .filter(r => bare(r.shopify_order_id) === orderId && r.payment_status !== 'reconciled')
                    .sort((a, b) => b.created_at - a.created_at)
                    .map(r => ({ id: r.id }));
            }
            if (/payment_status = 'pending'/.test(s)) {
                const tenMinutes = 10 * 60 * 1000;
                return codRows
                    .filter(r => bare(r.shopify_order_id) === orderId && r.payment_status === 'pending')
                    .filter(r => !/INTERVAL '10 minutes'/.test(s)
                        || Date.now() - new Date(r.last_attempt_at || r.created_at).getTime() < tenMinutes)
                    .map(r => ({ id: r.id }));
            }
            return codRows
                .filter(r => bare(r.shopify_order_id) === orderId && r.payment_status === status)
                .map(r => ({ id: r.id }));
        }
        if (/payment_status IN \('pending', 'failed'\)/.test(s)) {
            return codRows
                .filter(r => ['pending', 'failed'].includes(r.payment_status))
                .map(r => ({ order_id: bare(r.shopify_order_id), carrier: r.carrier, awb: r.awb, cod_amount: r.amount }));
        }
    }
    return [];
};

dbAdapter.run = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');

    if (/INSERT INTO zoho_cod_payments/.test(s)) {
        const [orderId, amount, carrier, awb] = params;
        const created = row(orderId, 'pending', { amount, carrier, awb, last_attempt_at: new Date(), created_at: new Date() });
        codRows.push(created);
        return { changes: 1, lastInsertRowid: created.id };
    }
    if (/UPDATE zoho_cod_payments/.test(s)) {
        if (/payment_status = 'superseded'/.test(s)) {
            // finishReconciled: [reason, orderId, keepId]
            // supersedeCodRows: [reason, orderId] — retires every open row
            const [reason, orderId, keepId] = params;
            codRows.forEach(r => {
                const sameOrder = bare(r.shopify_order_id) === bare(orderId);
                const isKeep = keepId !== undefined && String(r.id) === String(keepId);
                if (sameOrder && !isKeep && r.payment_status !== 'reconciled') {
                    r.payment_status = 'superseded';
                    r.error_message = reason;
                }
            });
            return { changes: 1 };
        }
        if (/SET payment_status = 'pending'/.test(s)) {
            const id = params[params.length - 1];
            const r = codRows.find(x => String(x.id) === String(id));
            if (r) {
                r.payment_status = 'pending';
                r.attempts = (r.attempts || 0) + 1;
                r.error_message = null;
                r.last_attempt_at = new Date();
            }
            return { changes: 1 };
        }
        if (/SET payment_status = 'reconciled'/.test(s)) {
            const id = params[params.length - 1];
            const r = codRows.find(x => String(x.id) === String(id));
            if (r) {
                r.payment_status = 'reconciled';
                r.zoho_invoice_id = params[0];
                if (params[1]) r.zoho_payment_id = params[1];
                if (params[2]) r.amount = params[2];
                r.reconciled_at = new Date();
            }
            return { changes: 1 };
        }
        // failure write: [status, message, id]
        const [status, message, id] = params;
        const r = codRows.find(x => String(x.id) === String(id));
        if (r) { r.payment_status = status; r.error_message = message; }
        return { changes: 1 };
    }
    return { changes: 0, lastInsertRowid: null };
};

// ---------------------------------------------------------- the Books fake
zohoService.searchInvoice = async (filters = {}) => {
    const ref = bare(filters.reference_number);
    if (UNFILTERED_SEARCH) return Object.values(invoicesById).slice();  // simulates the ignored filter
    return Object.values(invoicesById).filter(inv => bare(inv.reference_number) === ref);
};
zohoService.getPayments = async (invoiceId) => paymentsRecorded.filter(p => p.invoice_id === invoiceId);
zohoService.recordPayment = async (payload) => {
    const inv = Object.values(invoicesById).find(i => i.invoice_id === payload.invoices[0].invoice_id);
    if (!inv) throw new Error('400: invoice not found');
    if (inv.status === 'void') throw new Error('400: cannot pay a void invoice');
    const amount = parseFloat(payload.amount);
    if (amount > parseFloat(inv.balance) + 0.01) throw new Error('400: amount more than balance due');
    const payment = { payment_id: `PAY-${paymentsRecorded.length + 1}`, invoice_id: inv.invoice_id, amount, payment_mode: payload.payment_mode };
    paymentsRecorded.push(payment);
    inv.balance = 0;
    inv.status = 'paid';
    return payment;
};

let UNFILTERED_SEARCH = false;

// ---------------------------------------------------------- the Shopify fake
axios.get = async (url, config = {}) => {
    const name = bare(config.params && config.params.name);
    const matches = Object.values(shopifyOrdersByName).filter(o => String(o.order_number).startsWith(name));
    return { data: { orders: matches }, headers: {} };
};
shopifyService.markOrderPaidByOrderNumber = async () => ({ success: true, action: 'sale' });

// ============================================================
// Assertions
// ============================================================
let passed = 0, failedChecks = 0;
function check(label, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✅ ${label}`); }
    else { failedChecks++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function invoice(id, ref, { balance = 0, total = 1299, status = 'sent' } = {}) {
    invoicesById[id] = {
        invoice_id: id, invoice_number: `OFF/26-27/${id}`, reference_number: ref,
        customer_id: 'CUST-1', status, total, balance
    };
    return invoicesById[id];
}

function codShopifyOrder(number, { gateway = ['COD'], financial = 'pending', cancelled = null, total = '1299.00' } = {}) {
    shopifyOrdersByName[number] = {
        id: `9${number}`, order_number: number, payment_gateway_names: gateway,
        financial_status: financial, cancelled_at: cancelled, total_price: total,
        fulfillments: [{ tracking_numbers: ['AWB-1'] }]
    };
    return shopifyOrdersByName[number];
}

// ============================================================
async function main() {
    // ---------------------------------------------------------- 1. the '#' prefix
    console.log('\n1. order id arriving as "#45272" (hub tables write it that way)');
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    let res = await zohoCodService.handleCodDelivery('#45272', { carrier: 'delhivery', awb: 'AWB-1' });
    check('reconciles instead of failing', res.success === true, JSON.stringify(res));
    check('payment recorded on the order\'s own invoice', paymentsRecorded.length === 1 && paymentsRecorded[0].invoice_id === 'INV-1');
    check('log row keyed without the #', codRows.length === 1 && codRows[0].shopify_order_id === '45272', JSON.stringify(codRows[0]));

    // ---------------------------------------------------------- 2. unfiltered search
    console.log('\n2. a search that answers with somebody else\'s invoice');
    resetWorld();
    UNFILTERED_SEARCH = true;
    invoice('INV-OTHER', '51111', { balance: 899 });
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('nothing is paid on a foreign invoice', paymentsRecorded.length === 0);
    check('the order is flagged, not silently "reconciled"', res.success === false && codRows[0].payment_status === 'failed', JSON.stringify(res));
    check('the reason is kept on the row', /No Zoho invoice found/.test(codRows[0].error_message || ''), codRows[0].error_message);
    UNFILTERED_SEARCH = false;

    // ---------------------------------------------------------- 3. void duplicate
    console.log('\n3. void duplicate sitting next to the live invoice');
    resetWorld();
    invoice('INV-VOID', '45272', { balance: 1299, status: 'void' });
    invoice('INV-LIVE', '45272', { balance: 1299, status: 'sent' });
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('the live document gets the payment', res.success === true && paymentsRecorded[0].invoice_id === 'INV-LIVE', JSON.stringify(paymentsRecorded));

    // ---------------------------------------------------------- 4. duplicate rows
    console.log('\n4. repeat attempts on one order');
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery', force: true });
    check('one row total, not one per attempt', codRows.length === 1, `rows=${codRows.length}`);
    check('the second run sees it as already reconciled', (await zohoCodService.handleCodDelivery('45272', {})).alreadyReconciled === true);
    check('no second payment stacked on the invoice', paymentsRecorded.length === 1);

    // and a failing order does not pile up rows either
    resetWorld();
    res = await zohoCodService.handleCodDelivery('99001', { carrier: 'delhivery' });   // no invoice, no Shopify order
    res = await zohoCodService.handleCodDelivery('99001', { carrier: 'delhivery' });
    check('two failures, still one unpaid row', codRows.length === 1, `rows=${codRows.length}`);
    check('the row counts its attempts', codRows[0].attempts === 2, `attempts=${codRows[0].attempts}`);

    // stale rows retire when the order finally reconciles
    resetWorld();
    codRows.push(row('45272', 'failed'), row('#45272', 'pending'));
    invoice('INV-1', '45272', { balance: 1299 });
    await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('the reconciled row is the only open one left', codRows.filter(r => ['pending', 'failed'].includes(r.payment_status)).length === 0, JSON.stringify(codRows.map(r => r.payment_status)));

    // the retry-reuse must not break the cron/webhook overlap guard
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    codRows.push(row('45272', 'pending', { last_attempt_at: new Date(), created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000) }));
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('an attempt in the last 10 minutes is not doubled up', res.inProgress === true && paymentsRecorded.length === 0, JSON.stringify(res));

    // ---------------------------------------------------------- 5. rate limit
    console.log('\n5. a Zoho rate limit is a pause, not a verdict');
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    const realRecord = zohoService.recordPayment;
    zohoService.recordPayment = async () => { throw new Error('Zoho API error (400): Access Denied - too many requests'); };
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    zohoService.recordPayment = realRecord;
    check('row stays pending so the sweep retries it', codRows[0].payment_status === 'pending', codRows[0].payment_status);
    check('the caller is told it was rate limited', res.rateLimited === true, JSON.stringify(res));

    // ---------------------------------------------------------- 6. amount
    console.log('\n6. the log row records what was actually applied');
    resetWorld();
    invoice('INV-1', '45272', { balance: 1199.5, total: 1299 });
    await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });   // no amount passed at all
    check('amount is the invoice balance, not ₹0', parseFloat(codRows[0].amount) === 1199.5, `amount=${codRows[0].amount}`);
    check('payment applied equals the balance', paymentsRecorded[0].amount === 1199.5);

    // ---------------------------------------------------------- 7. the sweep
    console.log('\n7. backlog sweep — a delivered COD order the live hook missed');
    resetWorld();
    shipmentRows = [{ order_id: '#64600', status: 'delivered', carrier: 'delhivery', awb: 'AWB-9', delivered_at: new Date(), cod_amount: 1499 }];
    invoice('INV-64600', '64600', { balance: 1499 });
    codShopifyOrder('64600');
    let stats = await zohoCodService.sweepUnreconciledCod({ dryRun: true });
    check('dry run finds it and writes nothing', stats.wouldPay.length === 1 && paymentsRecorded.length === 0 && codRows.length === 0, JSON.stringify(stats));
    stats = await zohoCodService.sweepUnreconciledCod();
    check('sweep reconciles it', stats.reconciled === 1 && paymentsRecorded[0].invoice_id === 'INV-64600', JSON.stringify(stats));
    check('row carries the order number and amount', codRows.length === 1 && codRows[0].shopify_order_id === '64600' && parseFloat(codRows[0].amount) === 1499);

    resetWorld();
    shipmentRows = [{ order_id: '64601', status: 'delivered', carrier: 'delhivery', awb: 'AWB-8', delivered_at: new Date(), cod_amount: 0 }];
    invoice('INV-64601', '64601', { balance: 999 });
    codShopifyOrder('64601', { gateway: ['razorpay'], financial: 'paid' });
    stats = await zohoCodService.sweepUnreconciledCod();
    check('a prepaid order is left alone', stats.notCod === 1 && paymentsRecorded.length === 0, JSON.stringify(stats));

    resetWorld();
    shipmentRows = [{ order_id: '64602', status: 'delivered', carrier: 'delhivery', awb: 'AWB-7', delivered_at: new Date(), cod_amount: 1999 }];
    invoice('INV-64602', '64602', { balance: 1999 });
    codShopifyOrder('64602', { cancelled: '2026-10-01T00:00:00+05:30' });
    stats = await zohoCodService.sweepUnreconciledCod();
    check('a cancelled order is never paid', stats.notPayable === 1 && paymentsRecorded.length === 0, JSON.stringify(stats));

    // ---------------------------------------------------------- 9. nothing to collect
    console.log('\n9. orders that will never pay — retired, not retried forever');
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    cancelledSyncLog.add('45272');
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('a cancelled order is skipped', res.skipped === 'order_cancelled', JSON.stringify(res));
    check('nothing is paid on a cancelled order', paymentsRecorded.length === 0);

    // an order already sitting on the sweep's list must leave it
    resetWorld();
    invoice('INV-1', '45272', { balance: 1299 });
    codRows.push(row('45272', 'failed'));
    cancelledSyncLog.add('45272');
    await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('its stale row is superseded, not pending/failed', codRows[0].payment_status === 'superseded', codRows[0].payment_status);
    check('the reason is on the row', /cancelled/i.test(codRows[0].error_message || ''), codRows[0].error_message);

    resetWorld();
    invoice('INV-VOID', '45272', { balance: 1299, status: 'void' });
    res = await zohoCodService.handleCodDelivery('45272', { carrier: 'delhivery' });
    check('void-only documents are skipped', res.skipped === 'invoice_voided', JSON.stringify(res));
    check('no payment is attempted on the void invoice', paymentsRecorded.length === 0);

    // ---------------------------------------------------------- 10. prefix search
    console.log('\n10. Shopify name search returning 45271 for a 4527 lookup');
    resetWorld();
    codShopifyOrder('45271');
    const fetched = await zohoCodService.ensureInvoiceExists('4527');
    check('the near-miss order is not adopted', fetched.length === 0, JSON.stringify(fetched));

    // ---------------------------------------------------------- helper units
    console.log('\n11. helper units');
    check('normOrderId strips # and spaces', zohoCodService.normOrderId(' #45272 ') === '45272');
    check('EXCH-INV-45272 is not order 45272\'s invoice',
        zohoCodService.invoicesForOrder([{ reference_number: 'EXCH-INV-45272' }], '45272').length === 0);
    check('a labelled reference still resolves',
        zohoCodService.invoicesForOrder([{ reference_number: 'Shopify Order #45272' }], '45272').length === 1);
    check('4527 does not match 45271',
        zohoCodService.invoicesForOrder([{ reference_number: '45271' }], '4527').length === 0);
    check('gateway COD wins', zohoCodService.isCodShopifyOrder({ payment_gateway_names: ['COD'], financial_status: 'paid' }) === true);
    check('an online gateway is never COD', zohoCodService.isCodShopifyOrder({ payment_gateway_names: ['razorpay'], financial_status: 'pending' }) === false);
    check('no gateway at all falls back to financial_status', zohoCodService.isCodShopifyOrder({ payment_gateway_names: [], financial_status: 'pending' }) === true);

    // ---------------------------------------------------------- summary
    console.log(`\n================ ${passed} passed, ${failedChecks} failed ================`);
    process.exit(failedChecks ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
