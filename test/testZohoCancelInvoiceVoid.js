// Offline logic test for zohoCancelService's invoice-void rule.
// Stubs every Zoho + DB call — no network, no live accounting.
// Run: node test/testZohoCancelInvoiceVoid.js

const zoho = require('../src/services/zohoService');
const axios = require('axios');
const { dbAdapter } = require('../src/database/db');

// Discovery bails out without store credentials; nothing here hits the network
// because axios is stubbed per case.
process.env.SHOPIFY_SHOP_URL = process.env.SHOPIFY_SHOP_URL || 'https://stub.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'stub-token';

let calls = [];
let comments = [];
let syncMarks = [];

function stubZoho({
    list = [], detail = {}, payments = {},
    searchErr = null, getErr = null, paymentsErr = null,
    deleteErr = null, voidErr = null
} = {}) {
    zoho.searchInvoice = async () => {
        calls.push('search');
        if (searchErr) throw searchErr;
        return list;
    };
    zoho.getInvoice = async (id) => {
        calls.push(`get:${id}`);
        if (getErr) throw getErr;
        return detail[id] || { invoice_id: id, status: 'sent', credits_applied: 0 };
    };
    zoho.getPayments = async (id) => {
        calls.push(`payments:${id}`);
        if (paymentsErr) throw paymentsErr;
        return payments[id] || [];
    };
    zoho.deletePayment = async (paymentId) => {
        calls.push(`deletePayment:${paymentId}`);
        if (deleteErr) throw deleteErr;
        return { status: 'deleted' };
    };
    zoho.voidInvoice = async (id) => {
        calls.push(`void:${id}`);
        if (voidErr) throw voidErr;
        return { status: 'void' };
    };
    zoho.addInvoiceComment = async (id, text) => {
        calls.push(`comment:${id}`);
        comments.push({ id, text });
        return {};
    };
}

// markSyncLogCancelled: UPDATE reports one row touched so no guard INSERT runs
dbAdapter.run = async (sql, params) => {
    if (/UPDATE zoho_sync_log/.test(sql)) syncMarks.push(params[1]);
    return { changes: 1 };
};
dbAdapter.query = async () => [];

function reset() {
    calls = [];
    comments = [];
    syncMarks = [];
}

let failures = 0;
function check(name, cond) {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failures++;
}

function before(a, b) {
    const ia = calls.indexOf(a), ib = calls.indexOf(b);
    return ia !== -1 && ib !== -1 && ia < ib;
}

const inv = (id, ref, status = 'overdue') => ({
    invoice_id: id, invoice_number: `OFF/${id}`, reference_number: ref, status, total: '1499.00'
});

// Discovery builds cursor URLs off this base, so the stub can recognise them.
const base = 'https://stub.myshopify.com/admin/api/2024-01/';

(async () => {
    const svc = require('../src/services/zohoCancelService');

    // 1. Plain unpaid invoice → voided, and no money touched
    reset();
    stubZoho({ list: [inv('INV1', '42999')], detail: { INV1: { invoice_id: 'INV1', status: 'overdue', credits_applied: 0 } } });
    let r = await svc.voidInvoiceForCancelledOrder('42999', { reason: 'test' });
    check('unpaid: voided once', r.voided === 1 && calls.includes('void:INV1'));
    check('unpaid: no payment deleted', !calls.some(c => c.startsWith('deletePayment')));

    // 2. Every decision comes from the detail read, not the list row:
    //    list says overdue, the document is actually paid.
    reset();
    stubZoho({
        list: [inv('INV2', '43000', 'overdue')],
        detail: { INV2: { invoice_id: 'INV2', status: 'paid', credits_applied: 0 } },
        payments: { INV2: [{ payment_id: 'P2', number: 'PAY-2', amount: '1499.00', date: '2026-11-01' }] }
    });
    r = await svc.voidInvoiceForCancelledOrder('43000', { reason: 'test' });
    check('paid: read detail before deciding', calls.includes('get:INV2') && calls.includes('payments:INV2'));
    check('paid: receipt removed then voided', r.voided === 1 && r.paymentsRemoved === 1
        && before('deletePayment:P2', 'void:INV2'));
    check('paid: audit comment written before the void',
        comments.length === 1 && before('comment:INV2', 'void:INV2')
        && /PAY-2/.test(comments[0].text) && /1499\.00/.test(comments[0].text));

    // 3. Search is a loose filter — a neighbour whose reference only CONTAINS
    //    the number must never be voided (voiding is irreversible).
    reset();
    stubZoho({ list: [inv('INV3', '143001'), inv('INV3b', '43001-extra')] });
    r = await svc.voidInvoiceForCancelledOrder('43001', { reason: 'test' });
    check('loose match: nothing voided', r.voided === 0 && !calls.some(c => c.startsWith('void:')));
    check('loose match: reported as no invoice', r.noInvoice === true);

    // 4. Paid with no readable receipt → refuse to void; money is not guessed at
    reset();
    stubZoho({
        list: [inv('INV4', '43002')],
        detail: { INV4: { invoice_id: 'INV4', status: 'paid', credits_applied: 0 } },
        payments: { INV4: [] }
    });
    r = await svc.voidInvoiceForCancelledOrder('43002', { reason: 'test' });
    check('paid without receipt: skipped, not voided', r.skippedPaid === 1 && r.voided === 0);

    // 5. Payment removal fails → the invoice stays live (no half-done ledger),
    //    and only a verdict from Zoho retires the order from the queue.
    reset();
    stubZoho({
        list: [inv('INV5', '43003')],
        detail: { INV5: { invoice_id: 'INV5', status: 'paid', credits_applied: 0 } },
        payments: { INV5: [{ payment_id: 'P5', amount: '1499.00' }] },
        deleteErr: new Error('Zoho API error (400): Cannot delete payment')
    });
    r = await svc.voidInvoiceForCancelledOrder('43003', { reason: 'test' });
    check('payment rejected by Zoho: not voided', r.voided === 0 && !calls.includes('void:INV5'));
    check('payment rejected by Zoho: error surfaced', /Cannot delete payment/.test(r.error || ''));
    check('payment rejected by Zoho: terminal, leaves the queue', r.skippedPaid === 1);

    reset();
    stubZoho({
        list: [inv('INV5b', '43019')],
        detail: { INV5b: { invoice_id: 'INV5b', status: 'paid', credits_applied: 0 } },
        payments: { INV5b: [{ payment_id: 'P5b', amount: '1499.00' }] },
        deleteErr: new Error('Zoho API error (network): getaddrinfo ENOTFOUND accounts.zoho.in')
    });
    r = await svc.voidInvoiceForCancelledOrder('43019', { reason: 'test' });
    check('infra failure: not voided and stays queued for a retry',
        r.voided === 0 && r.skippedPaid === 0 && r.error !== null);
    check('infra failure classified correctly',
        svc.isTransientFailure(new Error('Zoho API error (network): ENOTFOUND')) === true
        && svc.isTransientFailure(new Error('Zoho API error (400): nope')) === false);

    // 6. Credit already applied (the RTO path) → never void on top of it
    reset();
    stubZoho({
        list: [inv('INV6', '43004')],
        detail: { INV6: { invoice_id: 'INV6', status: 'open', credits_applied: '1499.00' } }
    });
    r = await svc.voidInvoiceForCancelledOrder('43004', { reason: 'test' });
    check('already credited: left alone for review', r.skippedCredited === 1 && r.voided === 0);

    // 7. Rate limit stops the walk without swallowing the order
    reset();
    stubZoho({ searchErr: new Error('Zoho API 429: maximum call rate limit reached') });
    r = await svc.voidInvoiceForCancelledOrder('43005', { reason: 'test' });
    check('rate limited: flagged, nothing voided', r.rateLimited === true && r.voided === 0);

    // 8. Dry run writes nothing at all, including payment removals
    reset();
    stubZoho({
        list: [inv('INV8', '43006')],
        detail: { INV8: { invoice_id: 'INV8', status: 'paid', credits_applied: 0 } },
        payments: { INV8: [{ payment_id: 'P8', amount: '900.00' }] }
    });
    r = await svc.voidInvoiceForCancelledOrder('43006', { dryRun: true, reason: 'test' });
    check('dry run: no void, no delete, no comment',
        !calls.includes('void:INV8') && !calls.includes('deletePayment:P8') && comments.length === 0);
    check('dry run: counted as would-void', r.voided === 1 && r.paymentsRemoved === 1);

    // 9. A dispatched (shipped) order is voided too — Shopify cancelled is the
    //    authority, which is the whole point of the rule change.
    reset();
    stubZoho({ list: [inv('INV9', '43007')], detail: { INV9: { invoice_id: 'INV9', status: 'overdue', credits_applied: 0 } } });
    const shippedOrder = {
        order_number: 43007, cancelled_at: '2026-11-20T00:00:00Z',
        fulfillments: [{ id: 1, status: 'fulfilled' }]
    };
    r = await svc.processCancellation(shippedOrder);
    check('shipped + cancelled: invoice voided anyway', r.voided === 1);
    check('shipped + cancelled: sync log marked', syncMarks.length === 1 && /cancelled in Shopify/.test(syncMarks[0]));

    // 10. No invoice yet (cancel arrived before create) → still get the guard row
    reset();
    stubZoho({ list: [] });
    r = await svc.processCancellation({ order_number: 43008, cancelled_at: '2026-11-20T00:00:00Z' });
    check('no invoice yet: guard row written', r.noInvoice === true && syncMarks.length === 1);

    // 11. Kill switch: paid invoices go back to manual review when told to
    reset();
    delete require.cache[require.resolve('../src/services/zohoCancelService')];
    process.env.ZOHO_CANCEL_VOID_PAID = 'false';
    const svcPaidOff = require('../src/services/zohoCancelService');
    stubZoho({
        list: [inv('INV11', '43009')],
        detail: { INV11: { invoice_id: 'INV11', status: 'paid', credits_applied: 0 } },
        payments: { INV11: [{ payment_id: 'P11', amount: '1499.00' }] }
    });
    r = await svcPaidOff.voidInvoiceForCancelledOrder('43009', { reason: 'test' });
    check('VOID_PAID=false: paid invoice skipped', r.skippedPaid === 1 && r.voided === 0 && svcPaidOff.VOID_PAID === false);
    delete process.env.ZOHO_CANCEL_VOID_PAID;

    // 12. Kill switch: dispatched orders keep their invoice (old behaviour)
    reset();
    delete require.cache[require.resolve('../src/services/zohoCancelService')];
    process.env.ZOHO_CANCEL_VOID_DISPATCHED = 'false';
    const svcDispOff = require('../src/services/zohoCancelService');
    stubZoho({ list: [inv('INV12', '43010')] });
    r = await svcDispOff.processCancellation({
        order_number: 43010, cancelled_at: '2026-11-20T00:00:00Z',
        fulfillments: [{ id: 1, status: 'fulfilled' }]
    });
    check('VOID_DISPATCHED=false: shipped order kept', r.kept === 'dispatched' && r.voided === 0);
    check('VOID_DISPATCHED=false: sync log not flipped', syncMarks.length === 0);
    delete process.env.ZOHO_CANCEL_VOID_DISPATCHED;

    // 13. Sweep: a Shopify-cancelled order with NO hub row must still be voided
    //     (that class was invisible to the store_shoppers join before).
    const registry = {
        '43011': [inv('INV13', '43011')],   // cancelled, no hub row
        '43012': [inv('INV14', '43012')],   // cancelled, already handled
        '43013': [inv('INV15', '43013')]    // hub-flagged but Shopify says live
    };
    reset();
    stubZoho({ detail: {
        INV13: { invoice_id: 'INV13', status: 'overdue', credits_applied: 0 },
        INV14: { invoice_id: 'INV14', status: 'void', credits_applied: 0 },
        INV15: { invoice_id: 'INV15', status: 'overdue', credits_applied: 0 },
        INV16: { invoice_id: 'INV16', status: 'overdue', credits_applied: 0 }
    } });

    let clearedFlags = [];
    // Stubs the whole outside world the sweep touches: hub rows, the Shopify
    // cancelled-order poll, the per-order verification read, and Zoho.
    function stubSweep({ hub = [], discovered = [], marked = [], shopify = () => null }) {
        zoho.searchInvoice = async (filters = {}) => {
            calls.push(`search:${filters.reference_number}`);
            return registry[String(filters.reference_number)] || [];
        };
        dbAdapter.run = async (sql, params) => {
            if (/UPDATE zoho_sync_log/.test(sql)) syncMarks.push(params[1]);
            if (/SET shopify_cancelled_at = NULL/.test(sql)) clearedFlags.push(params[0]);
            return { changes: 1 };
        };
        dbAdapter.query = async (sql) => {
            if (/COUNT\(\*\)::int AS n FROM zoho_sync_log/.test(sql)) return [{ n: 0 }];
            if (/FROM store_shoppers s/.test(sql)) return hub.map(order_id => ({ order_id }));
            if (/make_interval/.test(sql)) return marked.map(shopify_order_id => ({ shopify_order_id }));
            return [];
        };
        axios.get = async (url, cfg = {}) => {
            if (/status=canceled/.test(url)) {
                return { headers: {}, data: { orders: discovered.map(n => ({ order_number: Number(n) })) } };
            }
            const wanted = String((cfg.params || {}).name || '').replace(/^#/, '');
            const order = shopify(wanted);
            return { data: { orders: order ? [order] : [] } };
        };
    }

    // Hub flags 43013 as cancelled while Shopify says it is live; Shopify itself
    // reports 43011 (never seen by the hub) and 43012 (already reversed).
    stubSweep({
        hub: ['43013'],
        discovered: ['43011', '43012'],
        marked: ['43012'],
        shopify: n => n === '43013' ? null : ({
            order_number: Number(n), cancelled_at: '2026-11-20T00:00:00Z',
            fulfillments: []                       // never shipped: REST returns an empty array
        })
    });

    const sweep = await svc.sweepCancelledInvoices({ limit: 10 });
    check('sweep: no-hub-row cancellation voided', calls.includes('void:INV13') && sweep.voided === 1);
    check('sweep: counted as discovered directly', sweep.fromShopify === 1 && sweep.fromHub === 1);
    check('sweep: already-handled order not re-run', !calls.some(c => c === 'search:43012'));
    check('sweep: wrong hub flag cleared, invoice untouched',
        clearedFlags.includes('43013') && !calls.includes('void:INV15') && sweep.notCancelledInShopify === 1);
    check('sweep: reversed order marked in sync log', syncMarks.length === 1 && /invoice voided/.test(syncMarks[0]));

    // 14. Sweep: a shipped order cancelled in Shopify is voided, not kept
    reset();
    registry['43020'] = [inv('INV16', '43020')];
    stubSweep({
        hub: ['43020'],          // the hub knows it is cancelled
        discovered: [],          // nothing new from the Shopify poll this tick
        marked: [],
        shopify: n => ({ order_number: Number(n), cancelled_at: '2026-11-20T00:00:00Z',
            fulfillments: [{ id: 9, status: 'fulfilled' }] })   // it shipped
    });
    const sweep2 = await svc.sweepCancelledInvoices({ limit: 10 });
    check('sweep: dispatched order voided too', calls.includes('void:INV16') && sweep2.voided === 1 && sweep2.kept === 0);

    // 15. A receipt that also settles other invoices is never removed — that
    //     would erase money belonging to orders nobody cancelled.
    reset();
    stubZoho({
        list: [inv('INV17', '43021')],
        detail: { INV17: { invoice_id: 'INV17', status: 'paid', credits_applied: 0 } },
        payments: { INV17: [{ payment_id: 'P17', amount: '3000.00', invoice_numbers: ['OFF/INV17', 'OFF/OTHER'] }] }
    });
    r = await svc.voidInvoiceForCancelledOrder('43021', { reason: 'test' });
    check('shared receipt: not deleted, invoice kept live',
        !calls.includes('deletePayment:P17') && r.voided === 0 && r.paymentsRemoved === 0);
    check('shared receipt: paid skip, so it is not retried forever', r.skippedPaid === 1);
    check('shared receipt: helper sees the linkage', svc.isSharedPayment({ invoices: [{}, {}] }) === true
        && svc.isSharedPayment({ invoices: [{}] }) === false
        && svc.isSharedPayment({ invoice_numbers: 'OFF/1' }) === false);

    // 16. Discovery pagination. Shopify's page_info cursor already carries the
    //     whole query string, so it must be requested verbatim — re-appending
    //     the parameters gets a 400, and a 400 used to throw the entire pass
    //    (including the page that had succeeded) away, which silently killed
    //     the only feed that sees cancellations with no hub row.
    reset();
    const urls = [];
    const cursor = 'https://stub.myshopify.com/admin/api/2024-01/orders.json?status=canceled&page_info=abc123';
    const pages = [
        { headers: { link: `<${cursor}>; rel="next"` }, data: { orders: [{ order_number: 43030 }] } },
        { headers: {}, data: { orders: [{ order_number: 43031 }, { order_number: 43030 }] } },
    ];
    axios.get = async url => {
        urls.push(url);
        return pages[urls.length - 1];
    };
    let d = await svc.discoverShopifyCancellations({ hours: 26 });
    check('discovery: first page built from the query', /status=canceled/.test(urls[0]) && /updated_at_min=/.test(urls[0]));
    check('discovery: cursor page requested verbatim, query not re-appended',
        urls[1] === cursor && !/updated_at_min/.test(urls[1]));
    check('discovery: pages deduped and reported', d.names.join() === '43030,43031' && d.seen === 2);

    reset();
    urls.length = 0;
    axios.get = async url => {
        urls.push(url);
        if (urls.length === 1) return { headers: { link: `<${cursor}>; rel="next"` }, data: { orders: [{ order_number: 43032 }] } };
        throw new Error('Shopify API error (400): page_info cannot be used with other parameters');
    };
    d = await svc.discoverShopifyCancellations({ hours: 26 });
    check('discovery: a later-page failure keeps the orders already found',
        !!d.error && d.names.join() === '43032' && d.seen === 1);

    // ...and the sweep must still be able to use that partial list
    reset();
    registry['43033'] = [inv('INV18', '43033')];
    stubZoho({ detail: { INV18: { invoice_id: 'INV18', status: 'overdue', credits_applied: 0 } } });
    stubSweep({ hub: [], marked: [] });
    axios.get = async url => {
        if (/page_info=broken/.test(url)) throw new Error('Shopify API error (400): bad cursor');
        if (/status=canceled/.test(url)) return { headers: { link: `<${base}orders.json?page_info=broken>; rel="next"` }, data: { orders: [{ order_number: 43033 }] } };
        return { data: { orders: [{ order_number: 43033, cancelled_at: '2026-11-20T00:00:00Z', fulfillments: [] }] } };
    };
    const sweep3 = await svc.sweepCancelledInvoices({ limit: 10 });
    check('sweep: partial discovery still reverses the order it found',
        calls.includes('void:INV18') && sweep3.voided === 1 && sweep3.fromShopify === 1);

    console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n🎉 all checks passed');
    process.exit(failures ? 1 : 0);
})();
