/**
 * Shopify cancellation → Zoho invoice void.
 *
 * WHY THIS EXISTS: Shopify was never subscribed to post orders/cancelled to
 * /webhooks/zoho/orders/cancelled (zoho_sync_log held ZERO 'cancelled' rows
 * across 24k+ syncs, and the deployed route only ever answered 401 to probes),
 * so no cancellation reached Zoho at all — the webhook handler was correct and
 * dead. This module keeps ONE implementation of the void rule and gives it two
 * live feeds:
 *   • processCancellation(order)     — the Shopify webhook, if it is ever wired
 *   • sweepCancelledInvoices()       — a cron that finds cancelled orders whose
 *                                      invoice is still live and voids them
 * The sweep is deliberately a *backlog sweeper*, not a "recent changes" watcher:
 * it walks the oldest unhandled cancellations first and stops when the daily
 * Zoho call budget is spent, so the ~2.3k historical invoices drain by
 * themselves over roughly a week without a separate bulk run.
 *
 * Safety rules — the authority is Shopify, never a local flag:
 *   • Nothing is voided on a DB flag alone — Shopify is asked first and must
 *     report cancelled_at. A stale/wrong flag can therefore never void a live
 *     invoice.
 *   • A cancelled order carries no live invoice, whether or not the parcel had
 *     already shipped by the carrier. Shopify cancellation is the accounting
 *     event; the older "shipped means keep the invoice" carve-out is gone (set
 *     ZOHO_CANCEL_VOID_DISPATCHED=false to restore it).
 *   • Zoho refuses to void a PAID invoice, so its recorded receipt is removed
 *     first (the refund itself always happens in Shopify) and the removal is
 *     written onto the invoice as a comment before the void, because a void can
 *     never be undone and the receipt would otherwise vanish without a trace.
 *   • An invoice that carries applied credit, or has any linked credit note, is
 *     LEFT ALONE — the sale was reversed by a credit note (the RTO path) and
 *     voiding on top of it would reverse the revenue twice. Those are counted
 *     and reported.
 *   • Every safety decision is made on a fresh getInvoice, never on a list row:
 *     the list payload carries neither credits_applied nor payments, so an
 *     absent field would read as "no money attached".
 *   • A 'cancelled' row in zoho_sync_log also blocks the create path from
 *     re-raising the invoice (see zohoSyncService.syncOrderToZoho guards).
 */

const axios = require('axios');
const zohoService = require('./zohoService');
const { dbAdapter } = require('../database/db');

// ── Budget knobs (Render env wins; defaults sized for the 10,000 calls/day
// Zoho org cap shared with live order sync + RTO credit notes) ──────────────
// One handled order costs 1 Shopify call + ~2 Zoho calls (search + void).
// 400 orders/day ≈ 800 Zoho calls/day, which leaves the cap alone for live
// traffic while draining a ~2,300 order backlog in about six days.
const SWEEP_LIMIT = parseInt(process.env.ZOHO_CANCEL_SWEEP_LIMIT || '40', 10);
const SWEEP_DAILY_BUDGET = parseInt(process.env.ZOHO_CANCEL_SWEEP_DAILY_BUDGET || '400', 10);
const DISCOVERY_HOURS = parseInt(process.env.ZOHO_CANCEL_DISCOVERY_HOURS || '26', 10);
const SWEEP_ENABLED = process.env.ZOHO_CANCEL_SWEEP_ENABLED !== 'false';
// Kill-switches for the two destructive branches, so accounting can stop
// either one from Render env without a redeploy.
const VOID_PAID = process.env.ZOHO_CANCEL_VOID_PAID !== 'false';
const VOID_DISPATCHED = process.env.ZOHO_CANCEL_VOID_DISPATCHED !== 'false';

const money = v => Number(v || 0).toFixed(2);

function isRateLimited(err) {
    return /429|maximum call rate|rate limit/i.test(err?.message || '');
}

/**
 * zohoRequest wraps failures as "Zoho API error (<status>): <message>", where
 * status is either an HTTP code or the word 'network'. Only a rejection from
 * Zoho itself is a verdict — it will fail identically on every retry, so those
 * orders go to a human instead of holding the queue. Anything else (DNS, time-
 * out, 5xx) just wants another tick.
 */
function isTransientFailure(err) {
    const match = /Zoho API error \(([^)]+)\)/.exec(err?.message || '');
    if (!match) return true;
    return !/^\d{3}$/.test(match[1]) || /^5\d\d$/.test(match[1]);
}

/** Books blocks a void when even an unapplied credit note is linked. */
function isCreditNoteVoidBlock(err) {
    return /cannot void as one or more credit notes are created/i.test(err?.message || '');
}

/**
 * Orders are keyed by display number everywhere in this flow (the invoice
 * reference_number is the Shopify order_number), so look them up by name —
 * getOrderById() treats a bare number as Shopify's internal id and would
 * fetch the wrong order.
 */
async function fetchShopifyOrderByNumber(orderNumber) {
    const shop = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token || !orderNumber) return null;

    const base = String(shop).replace('.myshopify.com', '').replace(/^https?:\/\//, '');
    try {
        const res = await axios.get(
            `https://${base}.myshopify.com/admin/api/2024-01/orders.json`,
            {
                params: { name: String(orderNumber).replace(/^#/, ''), status: 'any', limit: 5 },
                headers: { 'X-Shopify-Access-Token': token },
                timeout: 15000
            }
        );
        // Shopify's name search is prefix-ish, so take the exact match only
        const wanted = String(orderNumber).replace(/^#/, '');
        return (res.data?.orders || []).find(o => String(o.order_number) === wanted) || null;
    } catch (err) {
        console.warn(`⚠️ Zoho cancel sweep: Shopify lookup failed for order #${orderNumber}: ${err.message}`);
        return null;
    }
}

/** Anything fulfilled and not itself cancelled means the parcel shipped. */
function wasDispatched(order) {
    return (order?.fulfillments || []).some(f => f.status !== 'cancelled' && f.status !== 'failure');
}

/**
 * One Zoho payment can be settled across several invoices. Deleting it would
 * wipe the receipt for the other orders too — the exact ledger damage a
 * duplicate-cleanup sweep once did here — so only single-invoice receipts are
 * ever considered removable.
 */
function isSharedPayment(payment) {
    const linked = Array.isArray(payment.invoices) ? payment.invoices
        : Array.isArray(payment.apply_ids) ? payment.apply_ids
        : String(payment.invoice_numbers || '').split(',').map(s => s.trim()).filter(Boolean);
    return linked.length > 1;
}

/**
 * Flip zoho_sync_log for this order, inserting the guard row when the order
 * has no row yet — the create webhook reads 'cancelled' and skips invoice
 * creation. No ON CONFLICT here: the table has no unique constraint on
 * shopify_order_id (see src/database/add_zoho_sync.sql).
 */
async function markSyncLogCancelled(orderId, message) {
    try {
        const updated = await dbAdapter.run(
            `UPDATE zoho_sync_log SET status = ?, error_message = ?, updated_at = NOW()
             WHERE shopify_order_id = ? AND status IN ('synced', 'pending', 'retry')`,
            ['cancelled', message, orderId]
        );
        const rowsAffected = updated?.changes || updated?.rowCount || 0;
        if (rowsAffected === 0) {
            const existing = await dbAdapter.query(
                'SELECT id FROM zoho_sync_log WHERE shopify_order_id = ? LIMIT 1', [orderId]
            );
            if (existing.length === 0) {
                await dbAdapter.run(
                    `INSERT INTO zoho_sync_log (shopify_order_id, status, error_message, created_at, updated_at)
                     VALUES (?, 'cancelled', ?, NOW(), NOW())`,
                    [orderId, `${message} — invoice creation blocked`]
                );
                console.log(`📝 Zoho cancel: order #${orderId} — inserted cancel guard row (no prior sync existed)`);
            }
        }
        return rowsAffected;
    } catch (e) {
        console.warn(`⚠️ Zoho cancel: could not mark sync log cancelled for #${orderId}: ${e.message}`);
        return 0;
    }
}

/**
 * Void every live invoice whose reference_number is EXACTLY this order number.
 * Takes the money-side state into account: a paid invoice has its recorded
 * payment removed (documented on the invoice) before the void, and an invoice
 * that already carries applied credit is left for a human so revenue is not
 * reversed twice.
 *
 * Returns { voided, skippedPaid, skippedCredited, paymentsRemoved, alreadyVoid,
 * invoices } — never throws for API failures, so a sweep can keep walking;
 * only rate limits matter to the caller and those arrive as the `rateLimited`
 * flag.
 */
async function voidInvoiceForCancelledOrder(orderId, { reason, dispatched = false, dryRun = false } = {}) {
    const out = {
        orderId, voided: 0, skippedPaid: 0, skippedCredited: 0, paymentsRemoved: 0,
        alreadyVoid: 0, rateLimited: false, error: null
    };

    if (dispatched && !VOID_DISPATCHED) {
        // Opt-out branch: shipped orders keep their invoice and a later return
        // is handled as a credit note.
        return { ...out, kept: 'dispatched' };
    }

    let found = [];
    try {
        found = await zohoService.searchInvoice({ reference_number: orderId });
    } catch (err) {
        if (isRateLimited(err)) { out.rateLimited = true; return out; }
        out.error = err.message;
        return out;
    }

    // Zoho's reference filter matches loosely, and a void cannot be undone —
    // an invoice whose reference merely CONTAINS this number is not ours.
    const wanted = String(orderId).trim();
    const invoices = found.filter(inv => String(inv.reference_number || '').trim() === wanted);

    if (found.length && !invoices.length) {
        console.warn(`🚫 Zoho cancel: order #${orderId} — ${found.length} invoice(s) matched the search but none carry this exact reference; nothing touched`);
        return { ...out, noInvoice: true };
    }
    if (!invoices.length) {
        // Was silent once; "invoice not found" must not be guessed at from logs
        console.log(`ℹ️ Zoho cancel: order #${orderId} — no invoices found in Zoho (may not have been synced yet)`);
        return { ...out, noInvoice: true };
    }

    for (const listed of invoices) {
        // credits_applied and payments are detail-only fields, so the safety
        // call below has to be made on a fresh read of the document itself.
        let inv = listed;
        try {
            inv = await zohoService.getInvoice(listed.invoice_id) || listed;
        } catch (err) {
            if (isRateLimited(err)) { out.rateLimited = true; return out; }
            console.warn(`⚠️ Zoho cancel: could not read invoice ${listed.invoice_id} (order #${orderId}): ${err.message} — left alone`);
            out.error = err.message;
            continue;
        }

        const status = String(inv.status || '');
        if (status === 'void' || status === 'deleted') { out.alreadyVoid++; continue; }

        if (parseFloat(inv.credits_applied) > 0) {
            out.skippedCredited++;
            console.warn(`⚠️ Zoho cancel: invoice ${inv.invoice_id} for order #${orderId} already has ₹${money(inv.credits_applied)} credited — not voiding, that would reverse the sale twice`);
            continue;
        }

        if ((status === 'paid' || status === 'partially_paid') && !VOID_PAID) {
            out.skippedPaid++;
            console.warn(`⚠️ Zoho cancel: invoice ${inv.invoice_id} for order #${orderId} is ${status} and ZOHO_CANCEL_VOID_PAID is off — needs a refund + credit note`);
            continue;
        }

        if (status === 'paid' || status === 'partially_paid') {
            // Books refuses "void a paid invoice", so the receipt has to come off
            // first. What authorises removing it is Shopify's cancelled_at, which
            // every caller verifies before getting here — the customer's money is
            // refunded there, so this only unwinds the mirrored entry.
            let payments = [];
            try {
                payments = await zohoService.getPayments(inv.invoice_id, inv.invoice_number);
            } catch (err) {
                if (isRateLimited(err)) { out.rateLimited = true; return out; }
                console.warn(`⚠️ Zoho cancel: payment lookup failed for invoice ${inv.invoice_id} (order #${orderId}): ${err.message} — invoice left live`);
                out.error = err.message;
                continue;
            }
            if (!payments.length) {
                // Paid with no readable receipt: voiding would be a guess about
                // money this service cannot see, so it stays for manual review.
                out.skippedPaid++;
                console.warn(`⚠️ Zoho cancel: invoice ${inv.invoice_id} for order #${orderId} is ${status} but no payment record could be read — not voiding`);
                continue;
            }

            const receiptLines = payments.map(p =>
                `${p.number || p.payment_id} ₹${money(p.amount)} on ${p.date || p.payment_date || 'n/a'}`).join('; ');

            if (!dryRun) {
                // The comment is the only thing that survives the void, so it is
                // written first — best effort, never a reason to skip the void.
                try {
                    await zohoService.addInvoiceComment(inv.invoice_id,
                        `Order #${orderId} cancelled in Shopify — invoice voided. Removed payment record(s): ${receiptLines}. Refund handled in Shopify. (${reason || 'cancelled'})`);
                } catch (commentErr) {
                    console.warn(`⚠️ Zoho cancel: audit comment failed on invoice ${inv.invoice_id}: ${commentErr.message}`);
                }
            }

            let blocked = false;
            for (const p of payments) {
                if (isSharedPayment(p)) {
                    // Deleting it would take money off invoices that belong to
                    // other orders, so this one waits for a human. Counted as a
                    // paid skip so the sweep stops re-testing it every tick.
                    console.warn(`⚠️ Zoho cancel: payment ${p.number || p.payment_id} on invoice ${inv.invoice_id} also settles other invoice(s) — cannot remove it, invoice left live`);
                    out.skippedPaid++;
                    blocked = true;
                    break;
                }
                if (!p.payment_id) {
                    console.warn(`⚠️ Zoho cancel: payment on invoice ${inv.invoice_id} has no payment_id — cannot remove it, leaving the invoice live`);
                    out.skippedPaid++;
                    blocked = true;
                    break;
                }
                if (dryRun) { out.paymentsRemoved++; continue; }
                try {
                    await zohoService.deletePayment(p.payment_id);
                    out.paymentsRemoved++;
                    console.log(`🗑️ Zoho cancel: removed payment ${p.number || p.payment_id} (₹${money(p.amount)}) from invoice ${inv.invoice_id} — order #${orderId} cancelled in Shopify`);
                } catch (err) {
                    if (isRateLimited(err)) { out.rateLimited = true; return out; }
                    console.warn(`⚠️ Zoho cancel: could not remove payment ${p.payment_id} on invoice ${inv.invoice_id}: ${err.message} — invoice left live`);
                    out.error = err.message;
                    // A Zoho rejection is final (paid-skip → manual review); an
                    // infra failure leaves the order in the queue to be retried.
                    if (!isTransientFailure(err)) out.skippedPaid++;
                    blocked = true;
                    break;
                }
            }
            // A receipt still attached means the void would fail anyway, and a
            // half-removed payment trail is worse than no change at all.
            if (blocked) continue;
        }

        if (dryRun) { out.voided++; continue; }
        try {
            // Void (never delete) — keeps the audit trail
            await zohoService.voidInvoice(inv.invoice_id);
            out.voided++;
        } catch (err) {
            if (isRateLimited(err)) { out.rateLimited = true; return out; }
            if (isCreditNoteVoidBlock(err)) {
                // credits_applied only reports money already consumed. Zoho also
                // refuses a void when a linked note is still open, so this is a
                // terminal accounting-review case, not a transient void failure.
                out.skippedCredited++;
                console.warn(`⚠️ Zoho cancel: invoice ${inv.invoice_id} for order #${orderId} has linked credit note(s) — not voiding; manual accounting review required`);
                continue;
            }
            console.warn(`⚠️ Zoho cancel: void failed for invoice ${inv.invoice_id} (order #${orderId}): ${err.message}`);
            out.error = err.message;
        }
    }

    if ((out.voided > 0 || out.paymentsRemoved > 0) && !dryRun) {
        console.log(`✅ Zoho cancel: order #${orderId} — ${out.voided} invoice(s) voided, ${out.paymentsRemoved} payment(s) removed${dispatched ? ' (order had already shipped)' : ''} (${reason || 'cancelled in Shopify'})`);
    }
    return out;
}

/**
 * The webhook body already carries the whole order, so this path needs no
 * Shopify round trip.
 *
 * Unlike the sweep, this marks the sync log for EVERY cancellation — including
 * when no invoice exists yet. That is the whole point of the guard row: the
 * cancel frequently arrives before create, and without it the still-pending
 * create webhook would raise an invoice for an order that no longer exists.
 */
async function processCancellation(order) {
    const orderId = order.order_number?.toString() || order.id?.toString();
    if (!orderId) return { skipped: 'no_order_id' };

    const dispatched = wasDispatched(order);
    if (dispatched) {
        console.log(`🚚 Zoho cancel: order #${orderId} was already shipped — Shopify says cancelled, so the invoice is voided anyway${VOID_DISPATCHED ? '' : ' (blocked by ZOHO_CANCEL_VOID_DISPATCHED)'}`);
    }

    const result = await voidInvoiceForCancelledOrder(orderId, {
        reason: 'Shopify orders/cancelled webhook',
        dispatched
    });

    if (result.kept) return { ...result, kept: 'dispatched' };

    await markSyncLogCancelled(orderId, 'Order cancelled in Shopify — invoice voided');
    return result;
}

/**
 * Drops the hub cancellation flag for an order Shopify says is live. Only
 * ever called after a direct Shopify read denies the cancellation, so it
 * corrects a wrong flag rather than erasing a real one.
 */
async function clearHubCancelFlag(orderNumber) {
    const bare = String(orderNumber).replace(/^#/, '');
    try {
        await dbAdapter.run(
            `UPDATE store_shoppers SET shopify_cancelled_at = NULL, updated_at = NOW()
             WHERE REGEXP_REPLACE(COALESCE(order_id, ''), '^#', '') = ? AND shopify_cancelled_at IS NOT NULL`,
            [bare]
        );
    } catch (err) {
        console.warn(`⚠️ Zoho cancel sweep: could not clear the hub flag for #${bare}: ${err.message}`);
    }
}

/** Orders the hub knows are cancelled but whose sync log is not marked cancelled. */
async function findCancelCandidates(limit) {
    return dbAdapter.query(
        `SELECT DISTINCT REGEXP_REPLACE(s.order_id, '^#', '') AS order_id
         FROM store_shoppers s
         JOIN zoho_sync_log z ON z.shopify_order_id = REGEXP_REPLACE(s.order_id, '^#', '')
         WHERE s.shopify_cancelled_at IS NOT NULL
           AND z.status IN ('synced', 'pending', 'retry')
           AND REGEXP_REPLACE(s.order_id, '^#', '') ~ '^[0-9]+$'
         ORDER BY order_id
         LIMIT ?`,
        [limit]
    );
}

/**
 * Orders whose reversal is already finished (voided, or handed to a human).
 * Used to keep Shopify-discovered cancellations out of the queue after they
 * have been handled — the hub join does that filtering on its own, this list
 * has no such join. Only the recent window matters: discovery never reports
 * anything older than its own hours window.
 */
async function findMarkedCancelled({ days = 3 } = {}) {
    try {
        const rows = await dbAdapter.query(
            `SELECT DISTINCT shopify_order_id FROM zoho_sync_log
             WHERE status = 'cancelled' AND updated_at >= NOW() - make_interval(days => ?::int)`,
            [days]
        );
        return new Set((rows || []).map(r => String(r.shopify_order_id)));
    } catch (err) {
        console.warn(`⚠️ Zoho cancel sweep: could not read recently handled cancellations: ${err.message}`);
        return new Set();
    }
}

/** How many cancellations have already been handled today (the budget meter). */
async function handledToday() {
    const rows = await dbAdapter.query(
        `SELECT COUNT(*)::int AS n FROM zoho_sync_log
         WHERE status = 'cancelled' AND updated_at >= CURRENT_DATE`
    );
    return rows[0]?.n || 0;
}

/**
 * Shopify → store_shoppers cancel flag for orders cancelled outside the hub
 * (Shopify admin, other apps). Keeps the sweep's candidate list honest without
 * relying on a webhook that is not subscribed.
 *
 * Returns the cancelled order numbers as well: flagging hub rows is only half
 * the job, since an order with no hub row would otherwise never be reversed.
 */
async function discoverShopifyCancellations({ hours = DISCOVERY_HOURS } = {}) {
    const shop = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token) return { flagged: 0, error: 'Shopify credentials not configured' };

    const base = String(shop).replace('.myshopify.com', '').replace(/^https?:\/\//, '');
    const updatedMin = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const names = [];

    try {
        const params = new URLSearchParams({
            status: 'canceled', limit: '250', updated_at_min: updatedMin, order: 'updated_at asc'
        });
        // The page_info cursor Shopify hands back already carries every
        // parameter, so it must be requested verbatim — re-appending the query
        // string gets a 400 and used to discard the whole discovery pass.
        let url = `https://${base}.myshopify.com/admin/api/2024-01/orders.json?${params}`;
        for (let page = 1; url && page <= 6; page++) {
            const res = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': token }, timeout: 20000
            });
            for (const o of (res.data?.orders || [])) {
                if (o.order_number) names.push(String(o.order_number));
            }
            const link = res.headers?.link || '';
            const next = link.split(',').find(l => /rel="next"/.test(l))?.match(/<([^>]+)>/)?.[1];
            url = next || null;
        }
    } catch (err) {
        // Keep the pages that did come back. Throwing the pass away instead
        // would quietly retire the Shopify-direct feed — the sweep has no other
        // way to see a cancellation that has no store_shoppers row — and every
        // candidate is re-verified against Shopify before anything is voided.
        console.warn(`⚠️ Zoho cancel discovery: Shopify cancelled-order fetch failed after ${names.length} order(s): ${err.message}`);
        return { flagged: 0, seen: new Set(names).size, names: [...new Set(names)], error: err.message };
    }

    if (!names.length) return { flagged: 0, seen: 0, names: [] };
    const uniqueNames = [...new Set(names)];
    try {
        const { changes } = await dbAdapter.run(
            `UPDATE store_shoppers SET shopify_cancelled_at = NOW(), updated_at = NOW()
             WHERE order_id IN (${uniqueNames.map(() => '?').join(',')}) AND shopify_cancelled_at IS NULL`,
            uniqueNames
        );
        return { flagged: changes || 0, seen: uniqueNames.length, names: uniqueNames };
    } catch (err) {
        console.warn(`⚠️ Zoho cancel discovery: could not flag cancelled hub rows: ${err.message}`);
        return { flagged: 0, seen: uniqueNames.length, names: uniqueNames, error: err.message };
    }
}

/**
 * One sweep pass: budget check → candidates → verify with Shopify → void.
 * Stops at the first rate limit so the live sync traffic keeps its share of
 * the Zoho daily cap; the next cron tick picks up where it stopped.
 */
async function sweepCancelledInvoices({ limit = SWEEP_LIMIT, dryRun = false } = {}) {
    if (!SWEEP_ENABLED) return { skipped: 'disabled' };

    const handled = await handledToday();
    if (handled >= SWEEP_DAILY_BUDGET) {
        console.log(`⏸️ Zoho cancel sweep: daily budget spent (${handled}/${SWEEP_DAILY_BUDGET} handled today) — next tick tomorrow`);
        return { skipped: 'daily_budget', handled };
    }
    const budget = Math.max(0, SWEEP_DAILY_BUDGET - handled);
    const want = Math.min(limit, budget);

    // Cancellations made outside the hub are invisible until this runs.
    // Discovery writes the hub flag, so a dry run skips it and works only
    // against what the DB already knows.
    const discovery = dryRun
        ? { flagged: 0, seen: 0, names: [], skipped: 'dry run' }
        : await discoverShopifyCancellations();

    const hubCandidates = await findCancelCandidates(want);
    const queued = new Set(hubCandidates.map(c => c.order_id));

    // The hub join only sees orders that have a store_shoppers row. A direct
    // website order gets its Zoho invoice from the create webhook and can be
    // cancelled in the Shopify admin without ever touching the hub, so those
    // numbers come straight from discovery — otherwise their invoices would
    // stay live forever with nothing reporting the miss.
    const alreadyReversed = await findMarkedCancelled();
    const fromShopify = (discovery.names || [])
        .filter(n => /^[0-9]+$/.test(n) && !queued.has(n) && !alreadyReversed.has(n))
        .slice(0, Math.max(0, want - hubCandidates.length))
        .map(order_id => ({ order_id }));

    const candidates = [...hubCandidates, ...fromShopify];
    const stats = {
        checked: 0, voided: 0, kept: 0, skippedPaid: 0, skippedCredited: 0,
        paymentsRemoved: 0, notCancelledInShopify: 0,
        noInvoice: 0, alreadyVoid: 0, errors: 0, rateLimited: false,
        fromHub: hubCandidates.length, fromShopify: fromShopify.length, dryRun
    };

    for (const { order_id: orderId } of candidates) {
        stats.checked++;
        try {
            const order = await fetchShopifyOrderByNumber(orderId);
            if (!order || !order.cancelled_at) {
                // Never void on the DB flag alone — the flag may be stale, or
                // set for a shopper who is not this order. Clearing it also
                // unsticks the queue: candidates are oldest-first, so an order
                // Shopify denies would otherwise occupy the head forever and
                // starve every newer cancellation behind it. Discovery
                // re-flags it from Shopify if it really is cancelled.
                stats.notCancelledInShopify++;
                console.warn(`🚫 Zoho cancel sweep: order #${orderId} flagged cancelled but Shopify says otherwise — invoice left alone, hub flag cleared`);
                if (!dryRun) await clearHubCancelFlag(orderId);
                continue;
            }
            const result = await voidInvoiceForCancelledOrder(orderId, {
                reason: `cancel sweep${dryRun ? ' (dry run)' : ''}`,
                dispatched: wasDispatched(order),
                dryRun
            });

            if (result.rateLimited) {
                console.warn(`⏳ Zoho cancel sweep: rate limited at order #${orderId} after ${stats.voided} void(s) — resuming next tick`);
                stats.rateLimited = true;
                break;
            }
            stats.voided += result.voided;
            stats.skippedPaid += result.skippedPaid;
            stats.skippedCredited += result.skippedCredited;
            stats.paymentsRemoved += result.paymentsRemoved;
            stats.alreadyVoid += result.alreadyVoid;
            if (result.kept) stats.kept++;
            if (result.noInvoice) stats.noInvoice++;
            if (result.error) stats.errors++;

            // A dry run must write nothing at all — the invoice is left live,
            // so the sync log cannot be flipped either. Skipped-by-design
            // outcomes (paid switch off, credit already applied, no readable
            // receipt) are terminal too: they need a human, and re-testing
            // them every tick would hold the oldest-first queue still.
            if (!dryRun && (
                result.voided > 0 || result.alreadyVoid > 0 || result.noInvoice
                || result.skippedCredited > 0 || result.skippedPaid > 0
            )) {
                await markSyncLogCancelled(orderId,
                    result.skippedCredited > 0 || result.skippedPaid > 0
                        ? 'Order cancelled in Shopify — invoice left for manual accounting review (cancel sweep)'
                        : 'Order cancelled in Shopify — invoice voided (cancel sweep)');
            }
        } catch (err) {
            stats.errors++;
            console.error(`❌ Zoho cancel sweep failed for order #${orderId}: ${err.message}`);
        }
    }

    console.log(`🧾 Zoho cancel sweep${dryRun ? ' [DRY RUN]' : ''}: ${stats.checked} checked (${stats.fromHub} via hub, ${stats.fromShopify} direct from Shopify), ${stats.voided} voided, `
        + `${stats.paymentsRemoved} payment(s) removed, ${stats.kept} kept (dispatched), `
        + `${stats.skippedPaid} paid (manual review), ${stats.skippedCredited} already credited (manual review), `
        + `${stats.noInvoice} without invoice, ${stats.alreadyVoid} already void, `
        + `${stats.notCancelledInShopify} not cancelled in Shopify, ${stats.errors} errors`
        + (discovery.seen ? ` | discovery: ${discovery.flagged} newly flagged of ${discovery.seen} recently cancelled` : ''));

    return stats;
}

module.exports = {
    processCancellation,
    voidInvoiceForCancelledOrder,
    sweepCancelledInvoices,
    clearHubCancelFlag,
    discoverShopifyCancellations,
    findMarkedCancelled,
    fetchShopifyOrderByNumber,
    markSyncLogCancelled,
    wasDispatched,
    isSharedPayment,
    isRateLimited,
    isTransientFailure,
    VOID_PAID,
    VOID_DISPATCHED,
    SWEEP_LIMIT,
    SWEEP_DAILY_BUDGET
};
