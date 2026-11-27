/**
 * Read-only pre-flight on the new cancel→void rule against REAL data.
 *
 * Answers, for a sample of the oldest unhandled Shopify cancellations:
 *   • how many invoices are unpaid (plain void) vs paid (receipt must come off)
 *   • how many paid ones are actually removable (single-invoice receipt) vs
 *     blocked as shared receipts / unreadable receipts
 *   • how many are already credit-reversed and therefore protected
 *   • how many had already shipped, i.e. the cases the old rule kept
 * Nothing is written: every call runs with dryRun. The DB assertion ignores
 * total zoho_sync_log rows on purpose — the live app inserts sync rows every
 * minute, so only the cancellation-specific counters are evidence.
 *
 *   node tmp/probe-cancel-void-blast-radius.js [sampleSize] [oldest|newest|shipped]
 *
 * 'shipped' ignores the hub entirely and walks Shopify's own cancelled orders,
 * keeping only those that had already been fulfilled — the cases the previous
 * rule refused to void, so they have no store_shoppers cancel flag to lean on.
 */
require('dotenv').config();
const axios = require('axios');
const zohoCancelService = require('../src/services/zohoCancelService');
const { dbAdapter, pool } = require('../src/database/db');

const SAMPLE = parseInt(process.argv[2] || '25', 10);
const NEWEST = process.argv[3] === 'newest';

const counters = () => dbAdapter.query(
    `SELECT (SELECT COUNT(*) FROM zoho_sync_log WHERE status = 'cancelled')::int AS cancelled_rows,
            (SELECT COUNT(*) FROM zoho_sync_log WHERE error_message LIKE '%pre-flight probe%')::int AS probe_rows,
            (SELECT COUNT(*) FROM store_shoppers WHERE shopify_cancelled_at IS NOT NULL)::int AS flagged`
);

/**
 * Assert the probe touched nothing. cancelled_rows is deliberately NOT part of
 * the comparison: the deployed sweep is live and marks cancellations constantly,
 * so only rows carrying THIS probe's message, and the hub flag counts, are
 * evidence of what this process did.
 */
async function finish(before) {
    const after = await counters();
    console.log('after :', JSON.stringify(after[0]));
    console.log(`note   : cancelled_rows moved ${before[0].cancelled_rows} → ${after[0].cancelled_rows} - that is the live sweep on Render, not this probe`);
    const clean = after[0].probe_rows === 0 && before[0].flagged === after[0].flagged;
    console.log(clean ? '\n✅ probe wrote nothing to the DB' : '\n❌ probe changed the DB — investigate');
    await pool.end();
    process.exit(clean ? 0 : 1);
}

/** Read-only look at what the deployed sweep has actually reversed. */
async function showLiveActivity(before) {
    const rows = await dbAdapter.query(
        `SELECT shopify_order_id, error_message, updated_at
         FROM zoho_sync_log WHERE status = 'cancelled'
         ORDER BY updated_at DESC LIMIT 12`
    );
    const totals = await dbAdapter.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE updated_at >= CURRENT_DATE)::int AS today,
                COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '1 hour')::int AS last_hour
         FROM zoho_sync_log WHERE status = 'cancelled'`
    );
    console.log('cancelled invoices recorded by the live sweep:', JSON.stringify(totals[0]));
    for (const r of rows) console.log(`  #${r.shopify_order_id}  ${r.error_message}  (${r.updated_at})`);
    return finish(before);
}

/**
 * Did the ledger actually change? A 'cancelled' sync row is also written when
 * the order had no invoice, so re-read each recently-marked order from Zoho in
 * dry-run mode: alreadyVoid means the void really landed, anything else means
 * the sweep marked an order it did not reverse.
 */
async function verifyVoidsInZoho(before) {
    const rows = await dbAdapter.query(
        `SELECT DISTINCT shopify_order_id FROM zoho_sync_log
         WHERE status = 'cancelled' AND updated_at >= NOW() - INTERVAL '3 hours'
         ORDER BY shopify_order_id DESC LIMIT ?`,
        [SAMPLE]
    );
    console.log(`re-reading ${rows.length} orders the live sweep marked cancelled (read-only)\n`);

    const tally = { checked: 0, voidInLedger: 0, NOTvoided: 0, alreadyCredited: 0, noInvoiceEver: 0, errors: 0 };
    const problems = [];
    for (const { shopify_order_id: orderId } of rows) {
        const r = await zohoCancelService.voidInvoiceForCancelledOrder(orderId, {
            reason: 'ledger verification', dryRun: true
        });
        tally.checked++;
        if (r.alreadyVoid) tally.voidInLedger++;
        else if (r.noInvoice) tally.noInvoiceEver++;
        else if (r.skippedCredited) tally.alreadyCredited++;
        else if (r.error) tally.errors++;
        else { tally.NOTvoided++; problems.push(`${orderId}: marked cancelled in the DB but the invoice is still live (${JSON.stringify(r)})`); }
    }
    console.log('\n── does Zoho agree with the sync log? ──');
    console.table(tally);
    if (problems.length) console.log(problems.join('\n'));
    else console.log('✅ every order the sweep marked cancelled is void (or was never invoiced / credit-reversed) in Zoho');
    return finish(before);
}

/**
 * Shopify-direct walk for the shipped-then-cancelled branch (read-only).
 */
async function probeShippedCancellations(before) {
    const base = String(process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE)
        .replace('.myshopify.com', '').replace(/^https?:\/\//, '');
    const params = new URLSearchParams({
        status: 'canceled', limit: '250',
        created_at_min: new Date(Date.now() - 45 * 86400000).toISOString(),
    });
    let url = `https://${base}.myshopify.com/admin/api/2024-01/orders.json?${params}`;

    const shipped = [];
    for (let page = 1; url && page <= 8 && shipped.length < SAMPLE; page++) {
        const res = await axios.get(url, {
            headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }, timeout: 20000,
        });
        for (const o of (res.data?.orders || [])) {
            if (zohoCancelService.wasDispatched(o)) shipped.push(String(o.order_number));
            if (shipped.length >= SAMPLE) break;
        }
        const link = res.headers?.link || '';
        url = link.split(',').find(l => /rel="next"/)?.match(/<([^>]+)>/)?.[1] || null;
    }
    console.log(`probing ${shipped.length} Shopify-cancelled orders that the carrier had already shipped (read-only)\n`);

    const tally = { orders: 0, alreadyVoid: 0, plainVoid: 0, paidVoidable: 0, paidBlocked: 0, creditedProtected: 0, noInvoice: 0, receiptWouldBeRemoved: 0, errors: 0 };
    const detail = [];
    for (const orderId of shipped) {
        const r = await zohoCancelService.voidInvoiceForCancelledOrder(orderId, {
            reason: 'pre-flight probe (shipped)', dispatched: true, dryRun: true,
        });
        tally.orders++;
        tally.alreadyVoid += r.alreadyVoid;
        tally.receiptWouldBeRemoved += r.paymentsRemoved;
        if (r.noInvoice) tally.noInvoice++;
        if (r.skippedCredited) { tally.creditedProtected++; detail.push(`${orderId}: already credited ₹ — protected, NOT voided`); }
        else if (r.skippedPaid) { tally.paidBlocked++; detail.push(`${orderId}: receipt not removable — held for a human`); }
        else if (r.voided > 0 && r.paymentsRemoved > 0) { tally.paidVoidable++; detail.push(`${orderId}: WOULD void + remove ${r.paymentsRemoved} receipt(s)`); }
        else if (r.voided > 0) tally.plainVoid++;
        if (r.error) { tally.errors++; detail.push(`${orderId}: ${r.error}`); }
    }
    console.log('\n── shipped-then-cancelled: what the new rule does ──');
    console.table(tally);
    if (detail.length) console.log(detail.join('\n'));
    return finish(before);
}

(async () => {
    const before = await counters();
    console.log('before:', JSON.stringify(before[0]));

    if (process.argv[3] === 'shipped') return probeShippedCancellations(before);
    if (process.argv[3] === 'live') return showLiveActivity(before);
    if (process.argv[3] === 'verify') return verifyVoidsInZoho(before);

    // Same candidate shape the sweep uses: hub-flagged cancellations whose sync
    // log is still live, oldest order number first.
    const candidates = await dbAdapter.query(
        `SELECT DISTINCT REGEXP_REPLACE(s.order_id, '^#', '') AS order_id
         FROM store_shoppers s
         JOIN zoho_sync_log z ON z.shopify_order_id = REGEXP_REPLACE(s.order_id, '^#', '')
         WHERE s.shopify_cancelled_at IS NOT NULL
           AND z.status IN ('synced', 'pending', 'retry')
           AND REGEXP_REPLACE(s.order_id, '^#', '') ~ '^[0-9]+$'
         ORDER BY order_id ${NEWEST ? 'DESC' : 'ASC'}
         LIMIT ?`,
        [SAMPLE]
    );
    console.log(`probing ${candidates.length} ${NEWEST ? 'newest' : 'oldest'} unhandled cancellations (read-only)\n`);

    const tally = {
        orders: 0, notCancelledInShopify: 0, shipped: 0, noInvoice: 0, alreadyVoid: 0,
        plainVoid: 0, paidVoidable: 0, paidBlocked: 0, creditedProtected: 0,
        receiptWouldBeRemoved: 0, errors: 0,
    };
    const paidOrders = [];
    const blockedOrders = [];

    for (const { order_id: orderId } of candidates) {
        const order = await zohoCancelService.fetchShopifyOrderByNumber(orderId);
        if (!order || !order.cancelled_at) { tally.notCancelledInShopify++; continue; }
        tally.orders++;
        const dispatched = zohoCancelService.wasDispatched(order);
        if (dispatched) tally.shipped++;

        const r = await zohoCancelService.voidInvoiceForCancelledOrder(orderId, {
            reason: 'pre-flight probe', dispatched, dryRun: true
        });
        tally.receiptWouldBeRemoved += r.paymentsRemoved;
        tally.alreadyVoid += r.alreadyVoid;
        if (r.noInvoice) tally.noInvoice++;
        if (r.skippedCredited) tally.creditedProtected++;
        if (r.error) tally.errors++;
        if (r.voided > 0 && r.paymentsRemoved === 0) tally.plainVoid++;
        else if (r.voided > 0) { tally.paidVoidable++; paidOrders.push(`${orderId} (${r.paymentsRemoved} receipt(s), shipped=${dispatched})`); }
        if (r.skippedPaid) { tally.paidBlocked++; blockedOrders.push(`${orderId} [${r.error || 'receipt not removable'}]`); }
    }

    console.log('\n── what the sweep would do to this sample ──');
    console.table(tally);
    if (paidOrders.length) console.log('receipt removals queued:', paidOrders.join(', '));
    if (blockedOrders.length) console.log('held for a human:', blockedOrders.join(', '));

    return finish(before);
})().catch(async e => {
    console.error('FATAL:', e);
    await pool.end().catch(() => {});
    process.exit(1);
});
