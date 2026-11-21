const axios = require('axios');
const zohoService = require('./zohoService');
const { buildCodPaymentPayload } = require('./zohoTransform');
const { dbAdapter } = require('../database/db');

// ============================================================
// ZOHO COD PAYMENT RECONCILER
// Auto-marks invoices as paid when COD is collected by carrier.
// ============================================================

// ── Backlog sweep knobs (Render env wins). One candidate costs 1 Shopify
// call + 2–3 Zoho calls, sized to sit alongside live order sync inside the
// org-wide 10,000 calls/day without eating it.────────────────────────────
const SWEEP_LIMIT = parseInt(process.env.ZOHO_COD_SWEEP_LIMIT || '30', 10);
const SWEEP_DAILY_BUDGET = parseInt(process.env.ZOHO_COD_SWEEP_DAILY_BUDGET || '150', 10);
const SWEEP_WINDOW_DAYS = parseInt(process.env.ZOHO_COD_SWEEP_WINDOW_DAYS || '120', 10);
const SWEEP_ENABLED = process.env.ZOHO_COD_SWEEP_ENABLED !== 'false';

/**
 * Everything in this flow is keyed by the Shopify DISPLAY order number with
 * no leading '#' — that is what the invoice reference_number and
 * zoho_sync_log.shopify_order_id are written as. The hub tables are not that
 * disciplined (shipments/store_shoppers store "#45272"), and the value is
 * whatever the caller happened to have. Passing it through unprefixed used to
 * look up an invoice for "#45272", find nothing, and fail the order as
 * permanently unreconcilable — so normalise once, at the top.
 */
function normOrderId(orderId) {
    return String(orderId === null || orderId === undefined ? '' : orderId).trim().replace(/^#/, '').trim();
}

/** Zoho reports rate limits in a 400/429 body rather than a clean status. */
function isRateLimited(err) {
    return /429|maximum call rate|rate limit|too many requests/i.test(err?.message || '');
}

/** A void/deleted document cannot be paid — it is never "the order's invoice". */
function isLiveInvoice(inv) {
    return !!inv && inv.status !== 'void' && inv.status !== 'deleted';
}

/**
 * Narrow an invoice list down to the documents that really belong to one
 * order. The list endpoint's reference_number filter is not guaranteed to be
 * honoured (the same silent-ignore is already documented for invoice_number
 * on /customerpayments), and the old code paid "the first row with a balance"
 * out of whatever came back — so a widened response settled somebody else's
 * invoice and left this order unpaid. Never pay on an unverified match.
 */
function invoicesForOrder(invoices, orderId) {
    const orderNum = normOrderId(orderId);
    const rows = Array.isArray(invoices) ? invoices : [];
    if (!orderNum) return [];
    const refOf = inv => normOrderId(inv.reference_number);

    const exact = rows.filter(inv => refOf(inv) === orderNum);
    if (exact.length > 0) return exact;

    // Fall back to a whole-number match so a reference written with a label
    // ("Shopify Order #45272") still resolves — but never a derived document,
    // which carries the order number inside an EXCH-/RET-/RTO- prefix.
    const derived = /^(EXCH|RET|RETP|RTO)[-_]/i;
    const safe = orderNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(^|[^0-9])${safe}([^0-9]|$)`);
    return rows.filter(inv => !derived.test(refOf(inv)) && token.test(refOf(inv)));
}

/**
 * Once COD is collected the Shopify order should show PAID as well —
// no manual marking. Best-effort: failures only log, never break the
// reconciliation (the sweep cron retries stuck orders).
 */
async function markShopifyPaid(orderId) {
    try {
        const shopifyService = require('./shopifyService');
        const result = await shopifyService.markOrderPaidByOrderNumber(orderId);
        if (!result.success && !result.skipped) {
            console.warn(`⚠️ Zoho COD: could not mark Shopify order #${orderId} paid: ${result.error}`);
        }
    } catch (err) {
        console.warn(`⚠️ Zoho COD: Shopify paid-marking failed for #${orderId}: ${err.message}`);
    }
}

/**
 * One log row per order, reused across attempts.
 *
 * Every attempt used to INSERT a fresh row, so an order that failed three
 * times kept three 'pending'/'failed' rows on the COD log — the dashboard
 * read that pile as "unpaid COD" and the Pending stat counted orders that had
 * been reconciled days earlier. Reopen the newest unresolved row instead.
 */
async function claimLogRow(orderId, { amount, carrier, awb }) {
    const open = await dbAdapter.query(
        `SELECT id FROM zoho_cod_payments
         WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ? AND payment_status <> 'reconciled'
         ORDER BY created_at DESC LIMIT 1`,
        [orderId]
    );
    if (open.length > 0) {
        const id = open[0].id;
        await dbAdapter.run(
            `UPDATE zoho_cod_payments
             SET payment_status = 'pending', carrier = ?, awb = ?,
                 amount = COALESCE(?, amount), attempts = COALESCE(attempts, 0) + 1,
                 last_attempt_at = NOW(), error_message = NULL
             WHERE id = ?`,
            [carrier || 'unknown', awb || '', amount || null, id]
        ).catch(() => dbAdapter.run(
            // attempts/error_message absent on a table created before this
            // migration — keep the reconciliation itself working
            `UPDATE zoho_cod_payments SET payment_status = 'pending', carrier = ?, awb = ? WHERE id = ?`,
            [carrier || 'unknown', awb || '', id]
        ));
        return id;
    }
    const inserted = await dbAdapter.run(
        `INSERT INTO zoho_cod_payments (shopify_order_id, amount, carrier, awb, payment_status, attempts, last_attempt_at)
         VALUES (?, ?, ?, ?, 'pending', 1, NOW())`,
        [orderId, amount || null, carrier || 'unknown', awb || '']
    ).catch(() => dbAdapter.run(
        `INSERT INTO zoho_cod_payments (shopify_order_id, amount, carrier, awb, payment_status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [orderId, amount || null, carrier || 'unknown', awb || '']
    ));
    return inserted.lastInsertRowid;
}

/**
 * Close the row out, then retire any older unresolved rows for the same
 * order so the log cannot show one order twice — reconciled and unpaid.
 */
async function finishReconciled(orderId, logId, { invoiceId, paymentId = null, amount = null }) {
    await dbAdapter.run(
        `UPDATE zoho_cod_payments
         SET payment_status = 'reconciled', zoho_invoice_id = ?,
             zoho_payment_id = COALESCE(?, zoho_payment_id),
             amount = COALESCE(?, amount), reconciled_at = NOW(), error_message = NULL
         WHERE id = ?`,
        [invoiceId, paymentId, amount > 0 ? amount : null, logId]
    ).catch(() => dbAdapter.run(
        `UPDATE zoho_cod_payments
         SET payment_status = 'reconciled', zoho_invoice_id = ?, zoho_payment_id = ?, reconciled_at = NOW()
         WHERE id = ?`,
        [invoiceId, paymentId, logId]
    ));
    await dbAdapter.run(
        `UPDATE zoho_cod_payments SET payment_status = 'superseded', error_message = ?
         WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ?
           AND payment_status NOT IN ('reconciled', 'superseded') AND id <> ?`,
        [`Superseded by reconciled row #${logId}`, orderId, logId]
    ).catch(() => {});
}

/**
 * Retires every open COD row for an order that no longer needs collecting
 * (cancelled, or invoiced only as a void document). 'superseded' is the state
 * the stuck-row sweeper ignores, so the order stops being retried forever.
 */
async function supersedeCodRows(orderId, reason) {
    await dbAdapter.run(
        `UPDATE zoho_cod_payments SET payment_status = 'superseded', error_message = ?
         WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ?
           AND payment_status NOT IN ('reconciled', 'superseded')`,
        [reason, orderId]
    ).catch(() => {});
}

/**
 * Handle a COD delivery confirmation from a carrier webhook.
 * Called when Delhivery/Shiprocket confirms delivery + COD collection.
 */
async function handleCodDelivery(rawOrderId, { amount, carrier, awb, deliveryDate, force = false } = {}) {
    const orderId = normOrderId(rawOrderId);
    if (!orderId) {
        return { success: false, error: 'No order identifier' };
    }

    // Check if already reconciled (idempotency)
    const existing = await dbAdapter.query(
        `SELECT id FROM zoho_cod_payments
         WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ? AND payment_status = ?`,
        [orderId, 'reconciled']
    );
    if (existing.length > 0) {
        console.log(`✅ Zoho COD: order #${orderId} already reconciled`);
        return { success: true, alreadyReconciled: true };
    }

    // A cancelled order is no longer collectible: the cancellation path voids
    // its invoice and removes whatever receipt it carried. Reconciling against
    // it would re-open a sale that does not exist, and Books refuses payments
    // on a void document — which the sweeper would then retry forever.
    const cancelled = await dbAdapter.query(
        `SELECT 1 FROM zoho_sync_log WHERE shopify_order_id = ? AND status = 'cancelled' LIMIT 1`,
        [orderId]
    );
    if (cancelled.length > 0) {
        await supersedeCodRows(orderId, 'Order cancelled in Shopify — invoice voided, nothing to collect');
        console.log(`🚫 Zoho COD: order #${orderId} is cancelled — invoice voided, skipping reconciliation`);
        return { success: true, skipped: 'order_cancelled' };
    }

    // Concurrency guard: a recent attempt means another process is already
    // reconciling this order (cron + webhook overlap). Measured on the
    // attempt stamp, not the row's creation date, because a retried order
    // reuses its original row.
    if (!force) {
        let inFlight = [];
        try {
            inFlight = await dbAdapter.query(
                `SELECT id FROM zoho_cod_payments
                 WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ?
                   AND payment_status = 'pending'
                   AND COALESCE(last_attempt_at, created_at) > NOW() - INTERVAL '10 minutes'`,
                [orderId]
            );
        } catch (guardErr) {
            // last_attempt_at missing on a table created before this column —
            // fall back to the row creation time rather than block everything
            inFlight = await dbAdapter.query(
                `SELECT id FROM zoho_cod_payments
                 WHERE REGEXP_REPLACE(shopify_order_id, '^#', '') = ?
                   AND payment_status = 'pending'
                   AND created_at > NOW() - INTERVAL '10 minutes'`,
                [orderId]
            ).catch(() => []);
        }
        if (inFlight.length > 0) {
            console.log(`⏳ Zoho COD: order #${orderId} reconciliation already in progress, skipping`);
            return { success: true, inProgress: true };
        }
    }

    // Log the COD attempt (reusing the order's open row when there is one)
    const logId = await claimLogRow(orderId, { amount, carrier, awb });

    try {
        // Step 1: Find the Zoho invoice for this order (auto-syncs the
        // order from Shopify first if the original sync never ran)
        const invoices = await ensureInvoiceExists(orderId);

        if (invoices.length === 0) {
            throw new Error(`No Zoho invoice found for order #${orderId}. Sync the order first.`);
        }

        // When the same order has multiple Zoho invoices (middleware +
        // native Shopify integration), prefer the one that still carries
        // a balance — the native duplicate is usually already paid. A void
        // document is never a payment target: paying one "succeeds" while the
        // order's live invoice stays unpaid, and after a cancellation there is
        // no live invoice at all.
        const live = invoices.filter(isLiveInvoice);
        if (live.length === 0) {
            await supersedeCodRows(orderId, 'Only void invoice(s) exist for this order — nothing to collect');
            console.log(`🚫 Zoho COD: order #${orderId} has only void invoice(s) — nothing to reconcile`);
            return { success: true, skipped: 'invoice_voided' };
        }
        const zohoInvoice = live.find(inv => parseFloat(inv.balance) > 0) || live[0];
        const invoiceId = zohoInvoice.invoice_id;
        // 'balance' is the remaining amount due on the invoice (the list
        // API returns it). 'total' is the grand total, which can be
        // larger than the balance when partial payments or credit notes
        // have been applied — paying the total in that case makes Zoho
        // reject with "amount more than balance due". Fall back to total
        // only if balance is absent.
        const balance = parseFloat(zohoInvoice.balance);
        const invoiceAmount = parseFloat(
            !isNaN(balance) && balance > 0
                ? balance
                : (zohoInvoice.total || zohoInvoice.amount || amount || 0)
        );
        if (invoiceAmount <= 0) {
            console.log(`ℹ️ Zoho COD: invoice ${invoiceId} balance is 0 — nothing to reconcile`);
            await finishReconciled(orderId, logId, { invoiceId, amount: null });
            await markShopifyPaid(orderId);
            return { success: true, alreadyPaid: true, zeroBalance: true };
        }

        // Step 2: Check if payment already recorded in Zoho
        const existingPayments = await zohoService.getPayments(invoiceId, zohoInvoice.invoice_number);
        if (existingPayments.length > 0) {
            console.log(`ℹ️ Zoho COD: invoice ${invoiceId} already has payments, skipping`);
            await finishReconciled(orderId, logId, {
                invoiceId, paymentId: existingPayments[0].payment_id, amount: invoiceAmount
            });
            await markShopifyPaid(orderId);
            return { success: true, alreadyPaid: true };
        }

        // Step 3: Record payment in Zoho (customer_id required by Books)
        const paymentPayload = buildCodPaymentPayload(invoiceId, invoiceAmount, deliveryDate, zohoInvoice.customer_id);
        const payment = await zohoService.recordPayment(paymentPayload);

        // Step 4: Update COD log — with the amount actually applied, so the
        // log/dashboard stop reporting ₹0 for a reconciled order.
        await finishReconciled(orderId, logId, {
            invoiceId, paymentId: payment?.payment_id || null, amount: invoiceAmount
        });

        // Step 5: COD collected from the customer → Shopify order Paid too.
        // Best-effort: never blocks or fails the Zoho reconciliation.
        await markShopifyPaid(orderId);

        console.log(`✅ Zoho COD: order #${orderId} → payment ${payment?.payment_id || 'recorded'} (₹${invoiceAmount})`);
        return {
            success: true,
            logId,
            invoiceId,
            paymentId: payment?.payment_id,
            amount: invoiceAmount
        };

    } catch (err) {
        // A rate limit is a pause, not a verdict — leave the row 'pending' so
        // the next sweep tick picks it back up instead of shipping it into
        // the 'failed' list nobody ever retries.
        const limited = isRateLimited(err);
        await dbAdapter.run(
            `UPDATE zoho_cod_payments SET payment_status = ?, error_message = ? WHERE id = ?`,
            [limited ? 'pending' : 'failed', err.message, logId]
        ).catch(() => dbAdapter.run(
            `UPDATE zoho_cod_payments SET payment_status = ? WHERE id = ?`,
            [limited ? 'pending' : 'failed', logId]
        ));

        console.error(`❌ Zoho COD reconciliation failed for order #${orderId}: ${err.message}`);
        return { success: false, error: err.message, logId, rateLimited: limited };
    }
}

/**
 * Find the Zoho invoice for an order; if it doesn't exist (original
 * webhook sync failed or was skipped), pull the order from Shopify,
 * run the full sync, and retry once. Results are verified against the
 * order number — see invoicesForOrder.
 */
async function ensureInvoiceExists(rawOrderId) {
    const orderId = normOrderId(rawOrderId);
    if (!orderId) return [];

    let matched = invoicesForOrder(
        await zohoService.searchInvoice({ reference_number: orderId }), orderId
    );
    if (matched.length > 0) return matched;

    const shopifyOrder = await fetchShopifyOrderByNumber(orderId);
    if (!shopifyOrder) return matched;

    console.log(`🔄 Zoho COD: no invoice for order #${orderId} — syncing from Shopify first`);
    try {
        // Lazy require to avoid a circular dependency with the sync service
        const zohoSyncService = require('./zohoSyncService');
        const syncResult = await zohoSyncService.syncOrderToZoho(shopifyOrder);
        if (syncResult.success) {
            matched = invoicesForOrder(
                await zohoService.searchInvoice({ reference_number: orderId }), orderId
            );
        }
    } catch (syncErr) {
        console.warn(`⚠️ Zoho COD: on-demand sync failed for order #${orderId}: ${syncErr.message}`);
    }
    return matched;
}

/**
 * Fetch a single order from Shopify by its display number (#45272).
 * Returns null when Shopify is unconfigured or the order doesn't exist.
 */
async function fetchShopifyOrderByNumber(orderId) {
    const shop = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP_URL;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token) return null;

    const name = normOrderId(orderId);
    const base = String(shop).replace('.myshopify.com', '').replace(/^https?:\/\//, '');
    try {
        const res = await axios.get(`https://${base}.myshopify.com/admin/api/2024-01/orders.json`, {
            params: { name, status: 'any', limit: 5 },
            headers: { 'X-Shopify-Access-Token': token },
            timeout: 15000
        });
        // Shopify's name search matches on the leading digits, so a lookup for
        // 4527 can come back with 45271 — take the exact order only, or a COD
        // payment gets recorded against somebody else's invoice.
        return (res.data?.orders || []).find(o => String(o.order_number) === name) || null;
    } catch (err) {
        console.warn(`⚠️ Zoho COD: Shopify order lookup failed for #${orderId}: ${err.message}`);
        return null;
    }
}

/**
 * Manually reconcile a pending COD payment.
 */
async function manualReconcile(codPaymentId) {
    const rows = await dbAdapter.query(
        'SELECT * FROM zoho_cod_payments WHERE id = ? AND payment_status != ?',
        [codPaymentId, 'reconciled']
    );

    if (rows.length === 0) {
        return { success: false, error: 'COD payment not found or already reconciled' };
    }

    const row = rows[0];
    return handleCodDelivery(row.shopify_order_id, {
        amount: parseFloat(row.amount || 0),
        carrier: row.carrier,
        awb: row.awb,
        force: true
    });
}

// ============================================================
// BACKLOG SWEEP
// The carrier webhook and the shipment-status hook both fire ONCE, at the
// delivery transition. Anything missed there — a Zoho rate limit, an invoice
// that had not synced yet, a parcel delivered before the hook existed, a
// process restarted mid-flight — kept its invoice unpaid forever, because
// nothing else ever looked at it again. This is the backstop.
// ============================================================

/**
 * Live Shopify order → is this a cash-on-delivery order?
 * Gateway names are the authority; an order with a real online gateway is
 * prepaid no matter what the hub row says. The financial_status fallback only
 * applies when no gateway was recorded at all.
 */
function isCodShopifyOrder(order) {
    if (!order) return false;
    const gw = `${(order.payment_gateway_names || []).join(' ')} ${order.gateway || ''}`.toLowerCase().trim();
    if (gw.includes('cod') || gw.includes('cash')) return true;
    if (gw) return false;
    return ['pending', 'partially_paid'].includes(String(order.financial_status || '').toLowerCase());
}

/** Delivered shipments with no reconciled COD row, oldest delivery first. */
async function findUnreconciledDelivered(limit) {
    return dbAdapter.query(
        `SELECT t.order_id, MAX(t.carrier) AS carrier, MAX(t.awb) AS awb,
                MAX(t.delivered_at) AS delivered_at, MAX(t.cod_amount) AS cod_amount
         FROM (
             SELECT REGEXP_REPLACE(s.order_id, '^#', '') AS order_id,
                    s.carrier, s.awb,
                    COALESCE(s.delivered_at, s.updated_at) AS delivered_at,
                    s.cod_amount
             FROM shipments s
             WHERE s.status = 'delivered'
               AND COALESCE(s.delivered_at, s.updated_at) >= NOW() - ${SWEEP_WINDOW_DAYS} * INTERVAL '1 day'
               AND REGEXP_REPLACE(s.order_id, '^#', '') ~ '^[0-9]+$'
               -- 'Prepaid' is settled by the sync itself; blank/unknown modes
               -- stay candidates and get settled by the Shopify check below.
               AND UPPER(COALESCE(s.payment_mode, '')) <> 'PREPAID'
         ) t
         WHERE NOT EXISTS (
             SELECT 1 FROM zoho_cod_payments c
             WHERE REGEXP_REPLACE(c.shopify_order_id, '^#', '') = t.order_id
               AND c.payment_status = 'reconciled'
         )
         GROUP BY t.order_id
         ORDER BY MIN(t.delivered_at)
         LIMIT ?`,
        [limit]
    );
}

/** Orders that already have a COD row but never reached 'reconciled'. */
async function findStuckCodRows(limit) {
    return dbAdapter.query(
        `SELECT REGEXP_REPLACE(shopify_order_id, '^#', '') AS order_id,
                MAX(carrier) AS carrier, MAX(awb) AS awb, MAX(amount) AS cod_amount
         FROM zoho_cod_payments
         WHERE payment_status IN ('pending', 'failed')
           AND COALESCE(last_attempt_at, created_at) < NOW() - INTERVAL '10 minutes'
           AND REGEXP_REPLACE(shopify_order_id, '^#', '') ~ '^[0-9]+$'
         GROUP BY 1
         ORDER BY MIN(COALESCE(last_attempt_at, created_at))
         LIMIT ?`,
        [limit]
    ).catch(() => dbAdapter.query(
        `SELECT REGEXP_REPLACE(shopify_order_id, '^#', '') AS order_id,
                MAX(carrier) AS carrier, MAX(awb) AS awb, MAX(amount) AS cod_amount
         FROM zoho_cod_payments
         WHERE payment_status IN ('pending', 'failed')
           AND REGEXP_REPLACE(shopify_order_id, '^#', '') ~ '^[0-9]+$'
         GROUP BY 1
         ORDER BY MIN(created_at)
         LIMIT ?`,
        [limit]
    ));
}

/** Both feeds, de-duplicated by order number, capped at `limit`. */
async function collectSweepCandidates(limit) {
    const byOrder = new Map();
    // Stuck rows first: they are known COD orders that already failed once,
    // whereas the shipment feed still needs its COD test.
    for (const row of await findStuckCodRows(limit)) {
        byOrder.set(row.order_id, row);
    }
    for (const row of await findUnreconciledDelivered(limit)) {
        if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, row);
    }
    return [...byOrder.values()].slice(0, limit);
}

/** Today's reconciliations — the sweep's budget meter. */
async function reconciledSinceMidnight() {
    const rows = await dbAdapter.query(
        `SELECT COUNT(*)::int AS n FROM zoho_cod_payments
         WHERE payment_status = 'reconciled' AND reconciled_at >= CURRENT_DATE`
    ).catch(() => [{ n: 0 }]);
    return rows[0]?.n || 0;
}

/** Delivered orders still missing a reconciliation — the dashboard backlog. */
async function countSweepBacklog() {
    const rows = await dbAdapter.query(
        `SELECT COUNT(DISTINCT REGEXP_REPLACE(s.order_id, '^#', ''))::int AS n
         FROM shipments s
         WHERE s.status = 'delivered'
           AND COALESCE(s.delivered_at, s.updated_at) >= NOW() - ${SWEEP_WINDOW_DAYS} * INTERVAL '1 day'
           AND UPPER(COALESCE(s.payment_mode, '')) <> 'PREPAID'
           AND NOT EXISTS (
               SELECT 1 FROM zoho_cod_payments c
               WHERE REGEXP_REPLACE(c.shopify_order_id, '^#', '') = REGEXP_REPLACE(s.order_id, '^#', '')
                 AND c.payment_status = 'reconciled'
           )`
    ).catch(() => [{ n: 0 }]);
    return rows[0]?.n || 0;
}

/**
 * One sweep pass: budget check → candidates → COD/refund test against Shopify
 * → reconcile. Stops at the first rate limit so live order sync keeps its
 * share of the Zoho daily cap; the next tick picks up where it stopped.
 *
 * `dryRun` performs every read (including the Shopify order check and the
 * invoice lookup) and no write, so the backlog can be reviewed first.
 */
async function sweepUnreconciledCod({ limit = SWEEP_LIMIT, dryRun = false } = {}) {
    if (!SWEEP_ENABLED) return { skipped: 'disabled' };
    // Auto-sync off means nobody wants documents written to Zoho right now
    if (process.env.ZOHO_AUTO_SYNC === 'false') return { skipped: 'auto-sync disabled' };

    const handled = await reconciledSinceMidnight();
    if (handled >= SWEEP_DAILY_BUDGET) {
        console.log(`⏸️ Zoho COD sweep: daily budget spent (${handled}/${SWEEP_DAILY_BUDGET} reconciled today) — next tick tomorrow`);
        return { skipped: 'daily_budget', handled };
    }
    const want = Math.min(limit, Math.max(0, SWEEP_DAILY_BUDGET - handled));
    const candidates = await collectSweepCandidates(want);

    const stats = {
        checked: 0, reconciled: 0, alreadyPaid: 0, notCod: 0, notPayable: 0,
        inProgress: 0, failed: 0, rateLimited: false, dryRun, wouldPay: [], errors: []
    };

    for (const candidate of candidates) {
        const orderId = normOrderId(candidate.order_id);
        stats.checked++;
        try {
            const order = await fetchShopifyOrderByNumber(orderId);
            if (order) {
                if (order.cancelled_at || ['refunded', 'voided'].includes(String(order.financial_status || '').toLowerCase())) {
                    // Cancelled/refunded money never arrives from the carrier;
                    // that is a credit note, not a payment.
                    stats.notPayable++;
                    continue;
                }
                if (!isCodShopifyOrder(order)) { stats.notCod++; continue; }
            } else {
                // Shopify unreachable — the hub's own multi-tier COD test is
                // the only signal left, and it is conservative enough here.
                const { isCodOrder } = require('./zohoShipmentHook');
                if (!(await isCodOrder(orderId))) { stats.notCod++; continue; }
            }

            if (dryRun) {
                const live = (await ensureInvoiceExists(orderId)).filter(isLiveInvoice);
                const inv = live.find(i => parseFloat(i.balance) > 0);
                if (inv) stats.wouldPay.push({ order_id: orderId, invoice: inv.invoice_number || inv.invoice_id, amount: parseFloat(inv.balance) });
                else stats.alreadyPaid++;
                continue;
            }

            const result = await handleCodDelivery(orderId, {
                amount: parseFloat(candidate.cod_amount || 0) || parseFloat(order?.total_price || 0) || 0,
                carrier: candidate.carrier || 'unknown',
                awb: candidate.awb || order?.fulfillments?.[0]?.tracking_numbers?.[0] || '',
                deliveryDate: candidate.delivered_at || order?.created_at || new Date().toISOString()
            });

            if (result.success) {
                if (result.alreadyPaid || result.alreadyReconciled) stats.alreadyPaid++;
                else stats.reconciled++;
            } else if (result.inProgress) {
                stats.inProgress++;
            } else {
                stats.failed++;
                stats.errors.push(`#${orderId}: ${result.error}`);
                if (result.rateLimited) {
                    console.warn(`⏳ Zoho COD sweep: rate limited at order #${orderId} after ${stats.reconciled} payment(s) — resuming next tick`);
                    stats.rateLimited = true;
                    break;
                }
            }
        } catch (err) {
            stats.failed++;
            stats.errors.push(`#${orderId}: ${err.message}`);
            console.error(`❌ Zoho COD sweep failed for order #${orderId}: ${err.message}`);
        }
    }

    console.log(`💰 Zoho COD sweep${dryRun ? ' [DRY RUN]' : ''}: ${stats.checked} checked, ${stats.reconciled} reconciled, ` +
        `${stats.alreadyPaid} already paid, ${stats.notCod} prepaid, ${stats.notPayable} cancelled/refunded, ` +
        `${stats.inProgress} in flight, ${stats.failed} errors`);
    if (dryRun && stats.wouldPay.length) {
        console.log(`   would pay: ${stats.wouldPay.slice(0, 20).map(w => `#${w.order_id} ₹${w.amount}`).join(', ')}` +
            (stats.wouldPay.length > 20 ? ` … (+${stats.wouldPay.length - 20} more)` : ''));
    }

    return stats;
}

/**
 * Get COD payment stats for the dashboard.
 */
async function getCodStats() {
    const today = new Date().toISOString().split('T')[0];

    const [pending, reconciledToday, failed, totalReconciled, totalAmount, backlog] = await Promise.all([
        dbAdapter.query(`SELECT COUNT(*)::int as count FROM zoho_cod_payments WHERE payment_status = ?`, ['pending']),
        dbAdapter.query(`SELECT COUNT(*)::int as count, COALESCE(SUM(amount), 0) as total FROM zoho_cod_payments WHERE payment_status = ? AND reconciled_at >= ?`, ['reconciled', today]),
        dbAdapter.query(`SELECT COUNT(*)::int as count FROM zoho_cod_payments WHERE payment_status = ?`, ['failed']),
        dbAdapter.query(`SELECT COUNT(*)::int as count FROM zoho_cod_payments WHERE payment_status = ?`, ['reconciled']),
        dbAdapter.query(`SELECT COALESCE(SUM(amount), 0) as total FROM zoho_cod_payments WHERE payment_status = ?`, ['reconciled']),
        countSweepBacklog()
    ]);

    return {
        pending: pending[0]?.count || 0,
        // Delivered orders the live hook never reconciled — what "unpaid COD"
        // actually means, and what the sweep drains.
        backlog: backlog || 0,
        reconciledToday: {
            count: reconciledToday[0]?.count || 0,
            amount: parseFloat(reconciledToday[0]?.total || 0)
        },
        failed: failed[0]?.count || 0,
        allTime: {
            reconciled: totalReconciled[0]?.count || 0,
            totalAmount: parseFloat(totalAmount[0]?.total || 0)
        }
    };
}

/**
 * Get COD payment log with pagination.
 */
async function getCodLog({ page = 1, limit = 50, status, search } = {}) {
    let where = [];
    let params = [];
    let paramIdx = 1;

    if (status) {
        where.push(`payment_status = $${paramIdx++}`);
        params.push(status);
    }
    if (search) {
        where.push(`(shopify_order_id ILIKE $${paramIdx} OR awb ILIKE $${paramIdx} OR carrier ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
        dbAdapter.query(
            `SELECT * FROM zoho_cod_payments ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        ),
        dbAdapter.query(`SELECT COUNT(*) as total FROM zoho_cod_payments ${whereClause}`, params)
    ]);

    return {
        data: rows,
        total: countResult[0]?.total || 0,
        page,
        limit,
        totalPages: Math.ceil((countResult[0]?.total || 0) / limit)
    };
}

module.exports = {
    handleCodDelivery,
    manualReconcile,
    getCodStats,
    getCodLog,
    ensureInvoiceExists,
    sweepUnreconciledCod,
    // exported for tests and the sweep's own reporting
    normOrderId,
    invoicesForOrder,
    isCodShopifyOrder,
    countSweepBacklog,
    SWEEP_LIMIT,
    SWEEP_DAILY_BUDGET,
    SWEEP_WINDOW_DAYS
};
