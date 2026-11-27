const axios = require('axios');
const { dbAdapter } = require('../database/db');
const { cachedQuery } = require('../utils/cache');
const { getBreaker } = require('../utils/circuitBreaker');
const { extractItemSize } = require('../utils/orderItems');

// ============================================================
// customerContextService — the Shoppers Hub "customer context"
// aggregation (orders from store_shoppers + tracking from orders,
// local and portal returns/exchanges, RTO summary) extracted from
// the admin chat-sidebar endpoint so the support desk and the
// storefront Help & Tickets read exactly the same data the team
// already works out of.
//
// build(phone) results ride the 'shoppers' cache namespace (90s
// TTL), which shopper/order writes already invalidate.
// ============================================================

// Fetch open return/exchange requests from the external returns server —
// Shopify portal submissions live there, not in the local returns/exchanges
// tables. Graceful: returns { connected: false } when unconfigured or down.
async function fetchReturnsServerPipeline(windowDays) {
    const baseUrl = process.env.RETURNS_SERVER_URL;
    const token = process.env.WHATSAPP_INTERNAL_TOKEN;
    if (!baseUrl) return { connected: false, reason: 'RETURNS_SERVER_URL not configured', requests: [] };
    try {
        const res = await getBreaker('internal', 'READ', 'returnsPipeline', request => request()).fire(() =>
            axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/inventory-open-requests`, {
                params: { window: windowDays },
                headers: { 'x-internal-token': token || '' },
                timeout: 15000
            })
        );
        if (!res.data?.success) return { connected: false, reason: res.data?.error || 'unexpected response', requests: [] };
        return { connected: true, requests: Array.isArray(res.data.requests) ? res.data.requests : [] };
    } catch (err) {
        console.warn(`⚠️ Returns server pipeline fetch failed: ${err.message}`);
        return { connected: false, reason: err.message, requests: [] };
    }
}

// ── Open-request feed (shared, projected) ────────────────────────────────
// The returns server answers with a newest-first slice capped at 1000 rows
// and every row carries its own item JSON. That feed is global, not
// per-phone, so refetching it inside every cold customer-context rebuild
// was the most expensive part of the build — and kept the raw blobs alive in
// each per-phone cache entry.
//
// openRequestsIndex() fetches once per TTL and keeps only the fields the
// desk and the storefront render, indexed by order number, so matching a
// customer is a Map.get instead of a 1000-row scan.
// ─────────────────────────────────────────────────────────────────────────
const FEED_ROW_CAP = 1000;          // the endpoint's .range(0, 999)
const FEED_WINDOW_DAYS = 90;
const FEED_ITEM_LINES = 2;          // per request; the card shows two lines

// Every spelling the feed and the hub use for the same order ("#55197").
function orderKeys(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const bare = raw.replace(/^#/, '');
    return [...new Set([raw, bare, bare.replace(/\D/g, '')].filter(Boolean))];
}

// [{ n, v, q }] — the same compact item shape the desk order rows use.
// Accepts an array, a JSON string or a single object; unknown shapes read
// as no items rather than throwing.
function projectItems(items) {
    let list = items;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (_) { list = null; }
    }
    if (!Array.isArray(list)) list = list ? [list] : [];
    return list.slice(0, FEED_ITEM_LINES).map(i => {
        const item = i || {};
        const name = String(item.name || item.title || item.product || item.product_title || '').trim();
        return {
            n: (name || 'Item').slice(0, 90),
            // extractItemSize already walks the variant fallback chain and
            // returns null for Shopify's "Default Title", so nothing is shown
            // for products with no real options.
            v: extractItemSize(item) || '',
            q: Number(item.quantity != null ? item.quantity : item.qty) || 1
        };
    });
}

// One request, projected. Reads both the snake_case pipeline rows and the
// camelCase ai-data rows; keeps request_id alongside id because existing
// consumers (support desk payload, AI reply engine) key on it.
function projectRequest(r) {
    const requestId = r.request_id || r.requestId || null;
    return {
        id: requestId,
        request_id: requestId,
        order_number: r.order_number != null ? r.order_number : (r.orderNumber != null ? r.orderNumber : null),
        type: r.type === 'exchange' ? 'exchange' : 'return',
        status: r.status || null,
        reason: r.reason || r.customerReason || null,
        created_at: r.created_at || r.createdAt || null,
        items: projectItems(r.items)
    };
}

function emptyFeed() {
    return { connected: false, reason: 'unavailable', count: 0, truncated: true, index: new Map() };
}

async function openRequestsIndex(windowDays = FEED_WINDOW_DAYS) {
    return await cachedQuery('returnsFeed', `open:${windowDays}`, async () => {
        const res = await fetchReturnsServerPipeline(windowDays);
        const rows = Array.isArray(res.requests) ? res.requests : [];
        const index = new Map();
        for (const row of rows) {
            // One projected object shared by every key spelling of the order.
            const entry = projectRequest(row);
            for (const key of orderKeys(entry.order_number)) {
                const bucket = index.get(key);
                if (bucket) bucket.push(entry);
                else index.set(key, [entry]);
            }
        }
        return {
            connected: res.connected,
            reason: res.reason || null,
            count: rows.length,
            // At the cap the feed is only a newest-first slice, so a customer's
            // own request may be missing from it — build() then falls back to
            // the targeted per-order lookup.
            truncated: rows.length >= FEED_ROW_CAP,
            index
        };
    });
}

async function build(rawPhone) {
    const phone = String(rawPhone || '').replace(/\D/g, '');
    if (phone.length < 10) throw new Error('phone required');

    // 1) All orders from store_shoppers (authoritative order source)
    //    Enriched with AWB/tracking from orders table.
    // Runs concurrently with the returns/exchanges scans below — the three
    // are independent, and one cold rebuild of this context sits on the
    // storefront Help tab's critical path.
    // The phone match is isolated in a MATERIALIZED CTE on the digits-only
    // functional index (idx_ss_phone_digits): with ORDER BY in the same
    // block the planner prefers a full created_at walk and regexp-filters
    // all ~52k rows (2-6s); this shape runs in single-digit ms.
    const [ordersRows, localReturns, localExchanges] = await Promise.all([
        dbAdapter.query(`
        WITH matched AS MATERIALIZED (
            SELECT id FROM store_shoppers s
            WHERE REGEXP_REPLACE(COALESCE(s.phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        )
        SELECT
            s.order_id, s.name, s.phone, s.email, s.status AS shopper_status,
            s.items_json, s.order_total, s.payment_method, s.delivery_type,
            s.created_at, s.address, s.city, s.province, s.zip,
            o.awb, o.tracking_url, o.courier_name,
            o.status AS order_status, o.delivered_at
        FROM store_shoppers s
        JOIN matched m ON m.id = s.id
        LEFT JOIN orders o ON o.order_id = s.order_id
        ORDER BY s.created_at DESC
        LIMIT 50
    `, [phone, `91${phone}`, phone.replace(/^91/, '')]).catch(() => null),

    // 2) Local returns
    dbAdapter.query(`
        SELECT return_id, order_id, items, reason, status, refund_amount, refund_status, created_at, updated_at
        FROM returns
        WHERE REGEXP_REPLACE(COALESCE(customer_phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        ORDER BY created_at DESC LIMIT 30
    `, [phone, `91${phone}`, phone.replace(/^91/, '')]),

    // 3) Local exchanges
    dbAdapter.query(`
        SELECT exchange_id, order_id, old_items, new_items, reason, status, price_difference, payment_status, created_at, updated_at
        FROM exchanges
        WHERE REGEXP_REPLACE(COALESCE(customer_phone,''),'[^0-9]','','g') IN ($1, $2, $3)
        ORDER BY created_at DESC LIMIT 30
    `, [phone, `91${phone}`, phone.replace(/^91/, '')])
    ]);
    if (!ordersRows) throw new Error('customer context order scan failed');

    // 4) External returns server pipeline (Shopify portal submissions).
    //    Shared feed keyed by order number, so this is a handful of Map
    //    lookups per customer instead of a 1000-row scan per cold build.
    let feed;
    try {
        feed = await openRequestsIndex();
    } catch (rsErr) {
        console.warn('[customer-context] Returns server unavailable, skipping portal data:', rsErr.message);
        feed = emptyFeed();
    }

    // Match on the bare order id — the returns server stores Shopify format
    // ("#55197") while store_shoppers stores "55197", and orderKeys() indexes
    // every spelling so either side finds the other.
    const normOrderId = v => String(v || '').replace(/^#/, '');
    const customerOrderIds = new Set(ordersRows.map(r => normOrderId(r.order_id)));
    const portalReturns = [];
    const portalExchanges = [];
    const seenRsIds = new Set();
    const collectPortal = (orderId, bucket) => {
        for (const row of bucket) {
            // The same projected object is shared by several keys; take it once.
            if (row.id && seenRsIds.has(row.id)) continue;
            if (row.id) seenRsIds.add(row.id);
            // Re-stamp with this customer's own spelling of the id so local and
            // portal rows key identically downstream.
            (row.type === 'exchange' ? portalExchanges : portalReturns).push({ ...row, order_number: orderId });
        }
    };
    for (const id of customerOrderIds) {
        for (const key of orderKeys(id)) {
            const bucket = feed.index.get(key);
            if (bucket) { collectPortal(id, bucket); break; }
        }
    }

    // 4b) Targeted per-order lookup via the returns server's ai-data search.
    // Worth the roundtrips only when the shared feed could not have contained
    // this customer's request: it is a newest-first slice capped at 1000 rows,
    // so past the cap a record can be truncated out entirely, and a failed
    // feed fetch indexed nothing at all. Otherwise the index above is complete.
    if ((feed.truncated || !feed.connected) && process.env.RETURNS_SERVER_URL) {
        const lookupOrderIds = ordersRows.slice(0, 8).map(r => normOrderId(r.order_id)).filter(Boolean);
        if (lookupOrderIds.length) {
            try {
                const rsBase = process.env.RETURNS_SERVER_URL.replace(/\/$/, '');
                const rsToken = process.env.WHATSAPP_INTERNAL_TOKEN || '';
                const lookups = await Promise.all(lookupOrderIds.map(id =>
                    getBreaker('internal', 'READ', 'returnsOrderLookup', request => request()).fire(() =>
                        axios.get(`${rsBase}/api/internal/ai-data`, {
                            params: { resource: 'requests', query: id, limit: 10 },
                            headers: { 'x-internal-token': rsToken },
                            timeout: 8000
                        })
                    ).catch(() => null)
                ));
                for (const lk of lookups) {
                    const reqs = Array.isArray(lk?.data?.requests) ? lk.data.requests : [];
                    for (const r of reqs) {
                        // ai-data returns camelCase; projectRequest reads both
                        const requestId = r.requestId || r.request_id;
                        if (!requestId || seenRsIds.has(requestId)) continue;
                        // The returns server's ai-data search uses substring/ILIKE
                        // matching, so it can surface requests belonging to OTHER
                        // customers whose order numbers share digits with ours.
                        // Only keep requests whose order_number actually belongs
                        // to this customer — otherwise the sidebar falsely shows
                        // R&E for customers who have none.
                        const rn = normOrderId(r.orderNumber || r.order_number);
                        if (!rn || !customerOrderIds.has(rn)) continue;
                        seenRsIds.add(requestId);
                        const entry = projectRequest(r);
                        (entry.type === 'exchange' ? portalExchanges : portalReturns).push(entry);
                    }
                }
            } catch (lkErr) {
                console.warn('[customer-context] Targeted RNX lookup failed:', lkErr.message);
            }
        }
    }

    // 5) Compute RTO summary from orders
    const rtoOrders = ordersRows.filter(r =>
        r.shopper_status === 'rto' || r.order_status === 'rto'
    );

    // 6) Extract customer-level info from first order row
    const firstRow = ordersRows[0] || {};
    const customer = {
        name: firstRow.name || null,
        phone,
        email: firstRow.email || null,
        city: firstRow.city || null,
        province: firstRow.province || null,
        totalOrders: ordersRows.length
    };

    return {
        phone,
        customer,
        orders: ordersRows.map(r => ({
            order_id: r.order_id,
            status: r.shopper_status || r.order_status || 'unknown',
            shopper_status: r.shopper_status,
            order_status: r.order_status,
            phone: r.phone,
            items_json: r.items_json,
            order_total: r.order_total,
            payment_method: r.payment_method,
            delivery_type: r.delivery_type,
            created_at: r.created_at,
            awb: r.awb,
            courier_name: r.courier_name,
            tracking_url: r.tracking_url,
            delivered_at: r.delivered_at,
            city: r.city,
            address: r.address
        })),
        rto: rtoOrders.map(r => ({
            order_id: r.order_id,
            awb: r.awb,
            courier_name: r.courier_name,
            status: r.shopper_status || r.order_status,
            created_at: r.created_at,
            delivered_at: r.delivered_at
        })),
        returns: [
            ...localReturns.map(r => ({ ...r, items: projectItems(r.items), source: 'local' })),
            ...portalReturns
        ],
        exchanges: [
            // old_items is what the customer is sending back — the same line the
            // portal card shows — so it projects into `items` for both sources.
            ...localExchanges.map(r => ({ ...r, items: projectItems(r.old_items), source: 'local' })),
            ...portalExchanges
        ],
        returnsConnected: feed.connected
    };
}

// Cached wrapper. 'shoppers' is the namespace shopper/order writes already
// clear, so a confirmation or status edit here takes effect immediately;
// getOrLoad also collapses concurrent builds for the same phone into one.
async function buildCached(rawPhone) {
    const phone = String(rawPhone || '').replace(/\D/g, '');
    return await cachedQuery('shoppers', `ctx:${phone}`, () => build(phone));
}

module.exports = { build, buildCached, fetchReturnsServerPipeline, openRequestsIndex, projectRequest, projectItems, orderKeys };
