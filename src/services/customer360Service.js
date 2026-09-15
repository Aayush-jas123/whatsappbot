/**
 * Customer 360 Service
 * 
 * Provides a comprehensive, factual customer-level view that aggregates:
 *  - Identity (name, phone, email, addresses, preferred language, registration date)
 *  - Order history metrics (total orders, delivered, cancelled, returned, exchanged)
 *  - Cumulative spend (lifetime order value in INR)
 *  - Refund history (amounts, dates, reasons, statuses)
 *  - Current open orders (in transit, pending dispatch, with courier and tracking)
 *  - Latest order placed
 *  - Open support issues (unresolved tickets, active return/exchange requests)
 *  - Factual, objective summary with zero subjective or negative bias
 * 
 * Identifier resolution supports:
 *  - Phone number (e.g. "9876543210", "+919876543210")
 *  - Order ID (e.g. "#12345", "12345") -> looks up customer who placed the order
 *  - Email address (e.g. "customer@example.com")
 *  - Customer name (e.g. "Rahul Sharma")
 */

const axios = require('axios');
const { dbAdapter } = require('../database/db');
const { extractItemSize } = require('../utils/orderItems');

// Safe JSON parser
function safeJsonParse(data, fallback = null) {
    if (!data) return fallback;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch { return fallback; }
}

// Clean and normalize phone numbers for consistent matching
function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith('0')) return digits.substring(1);
    if (digits.length >= 12 && digits.startsWith('91')) return digits.slice(-10);
    if (digits.length > 10) return digits.slice(-10);
    return digits;
}

// Format date into human readable string (e.g. "17 Jan 2026")
function formatReadableDate(rawDate) {
    if (!rawDate) return 'Not available';
    try {
        const d = new Date(rawDate);
        if (isNaN(d.getTime())) return 'Not available';
        const day = d.getDate();
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[d.getMonth()];
        const year = d.getFullYear();
        return `${day} ${month} ${year}`;
    } catch {
        return 'Not available';
    }
}

// Clean and title-case names properly (e.g. "sathvik ch" -> "Sathvik Ch")
function formatFullName(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const clean = raw.trim().replace(/\s+/g, ' ');
    if (!clean) return null;
    return clean.split(' ').map(w => {
        if (w.length <= 1) return w.toUpperCase();
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
}

// Score the completeness/quality of a candidate name
function scoreNameQuality(name) {
    if (!name || typeof name !== 'string') return -100;
    const trimmed = name.trim();
    if (!trimmed) return -100;
    if (/^(customer|unknown|user|guest|none|null|\.|\-)$/i.test(trimmed)) return -50;
    
    // Split into words, strip punctuation
    const words = trimmed.split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean);
    if (words.length === 0) return -50;

    let score = 10;
    // Multi-word full names (e.g. "Sathvik Ch") get massive preference over single tokens/initials
    if (words.length >= 2) score += 50;

    // Total alphabetical characters
    const lettersCount = trimmed.replace(/[^a-zA-Z]/g, '').length;
    score += Math.min(lettersCount * 3, 30);

    // Heavily penalize trailing punctuation, initials, and short abbreviations like "Ch ." or "A."
    if (/[.\-_]$/.test(trimmed)) score -= 30;
    if (lettersCount <= 3) score -= 30;

    return score;
}

// Select the most complete, verified customer name
function selectBestCustomerName(candidates) {
    let bestName = null;
    let highestScore = -999;

    for (const c of candidates) {
        if (!c) continue;
        const score = scoreNameQuality(c);
        if (score > highestScore) {
            highestScore = score;
            bestName = c;
        }
    }

    return formatFullName(bestName) || 'Customer';
}

// Select the most reliable customer email
function selectBestCustomerEmail(candidates) {
    for (const e of candidates) {
        if (e && typeof e === 'string' && e.includes('@') && !e.includes('example.com') && !e.includes('test.com')) {
            return e.trim().toLowerCase();
        }
    }
    const fallback = candidates.find(e => e && typeof e === 'string' && e.includes('@'));
    return fallback ? fallback.trim().toLowerCase() : 'Not available';
}

/**
 * Resolve customer identifier to phone, email, name, or order ID
 */
async function resolveCustomerTarget(identifier) {
    if (!identifier) return null;
    const raw = String(identifier).trim();
    if (!raw) return null;

    // 1. Check if identifier is an order ID (starts with # or 4-8 digits matching an order)
    const isOrderPattern = /^#\d{4,8}$/i.test(raw) || (/^\d{4,8}$/.test(raw) && !/^91\d{10}$/.test(raw) && !/^[6-9]\d{9}$/.test(raw));
    if (isOrderPattern) {
        const cleanOrder = raw.replace(/^#/, '');
        try {
            // Check store_shoppers first
            const shopperRows = await dbAdapter.query(
                'SELECT phone, email, name FROM store_shoppers WHERE order_id = ? OR order_id = ? LIMIT 1',
                [cleanOrder, `#${cleanOrder}`]
            );
            if (shopperRows?.[0]) {
                return {
                    resolvedBy: 'orderId',
                    orderId: `#${cleanOrder}`,
                    phone: normalizePhone(shopperRows[0].phone),
                    email: shopperRows[0].email || null,
                    name: shopperRows[0].name || null
                };
            }
            // Check orders table
            const orderRows = await dbAdapter.query(
                'SELECT customer_phone FROM orders WHERE order_id = ? OR order_id = ? LIMIT 1',
                [cleanOrder, `#${cleanOrder}`]
            );
            if (orderRows?.[0]?.customer_phone) {
                return {
                    resolvedBy: 'orderId',
                    orderId: `#${cleanOrder}`,
                    phone: normalizePhone(orderRows[0].customer_phone),
                    email: null,
                    name: null
                };
            }
        } catch (e) {}
    }

    // 2. Check if identifier is an email
    if (raw.includes('@')) {
        const email = raw.toLowerCase();
        try {
            const cust = await dbAdapter.query('SELECT phone, name, email FROM customers WHERE email ILIKE ? LIMIT 1', [email]);
            if (cust?.[0]) {
                return {
                    resolvedBy: 'email',
                    phone: normalizePhone(cust[0].phone),
                    email: cust[0].email,
                    name: cust[0].name
                };
            }
            const shopper = await dbAdapter.query('SELECT phone, name, email FROM store_shoppers WHERE email ILIKE ? LIMIT 1', [email]);
            if (shopper?.[0]) {
                return {
                    resolvedBy: 'email',
                    phone: normalizePhone(shopper[0].phone),
                    email: shopper[0].email,
                    name: shopper[0].name
                };
            }
        } catch (e) {}
        return { resolvedBy: 'email', email, phone: null, name: null };
    }

    // 3. Check if identifier is a phone number
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) {
        const phone10 = digits.slice(-10);
        return { resolvedBy: 'phone', phone: phone10, email: null, name: null };
    }

    // 4. Otherwise treat as customer name query
    try {
        const cust = await dbAdapter.query('SELECT phone, name, email FROM customers WHERE name ILIKE ? LIMIT 1', [`%${raw}%`]);
        if (cust?.[0]) {
            return {
                resolvedBy: 'name',
                phone: normalizePhone(cust[0].phone),
                email: cust[0].email,
                name: cust[0].name
            };
        }
        const shopper = await dbAdapter.query('SELECT phone, name, email FROM store_shoppers WHERE name ILIKE ? LIMIT 1', [`%${raw}%`]);
        if (shopper?.[0]) {
            return {
                resolvedBy: 'name',
                phone: normalizePhone(shopper[0].phone),
                email: shopper[0].email,
                name: shopper[0].name
            };
        }
    } catch (e) {}

    return { resolvedBy: 'name', name: raw, phone: null, email: null };
}

/**
 * Fetch customer profile from customers table
 */
async function fetchCustomerProfile(phone, email, name) {
    if (!phone && !email && !name) return null;
    try {
        const clauses = [];
        const params = [];
        if (phone) {
            clauses.push('phone LIKE ?');
            params.push(`%${phone}`);
        }
        if (email) {
            clauses.push('email ILIKE ?');
            params.push(email);
        }
        if (name && clauses.length === 0) {
            clauses.push('name ILIKE ?');
            params.push(`%${name}%`);
        }
        if (!clauses.length) return null;

        const rows = await dbAdapter.query(
            `SELECT phone, name, email, preferred_language, created_at, updated_at 
             FROM customers WHERE ${clauses.join(' OR ')} LIMIT 1`,
            params
        );
        return rows?.[0] || null;
    } catch {
        return null;
    }
}

/**
 * Fetch all orders for this customer from store_shoppers and orders tables
 */
async function fetchCustomerOrders(phone, email) {
    const ordersMap = new Map();

    // 1. Fetch from store_shoppers
    try {
        const shopperClauses = [];
        const shopperParams = [];
        if (phone) {
            shopperClauses.push('phone LIKE ?');
            shopperParams.push(`%${phone}`);
        }
        if (email) {
            shopperClauses.push('email ILIKE ?');
            shopperParams.push(email);
        }
        if (shopperClauses.length > 0) {
            const shopperRows = await dbAdapter.query(
                `SELECT id, order_id, phone, name, email, address, city, province, zip, country,
                        payment_method, order_total, delivery_type, status, items_json, customer_message,
                        cancel_reason, shopify_cancelled_at, shopify_refund_amount, created_at, updated_at
                 FROM store_shoppers WHERE ${shopperClauses.join(' OR ')} ORDER BY created_at DESC`,
                shopperParams
            );
            for (const r of shopperRows) {
                const key = String(r.order_id).replace(/^#/, '');
                ordersMap.set(key, {
                    orderId: `#${key}`,
                    source: 'store_shoppers',
                    name: r.name,
                    phone: r.phone,
                    email: r.email,
                    address: {
                        address1: r.address || null,
                        city: r.city || null,
                        province: r.province || null,
                        zip: r.zip || null,
                        country: r.country || 'India'
                    },
                    status: r.status || 'pending',
                    total: parseFloat(r.order_total) || 0,
                    paymentMethod: r.payment_method || 'Not specified',
                    itemsJson: safeJsonParse(r.items_json),
                    cancelReason: r.cancel_reason || null,
                    cancelledAt: r.shopify_cancelled_at || null,
                    refundAmount: parseFloat(r.shopify_refund_amount) || 0,
                    createdAt: r.created_at || null,
                    updatedAt: r.updated_at || null
                });
            }
        }
    } catch (e) {
        console.warn('[Customer360] store_shoppers fetch error:', e.message);
    }

    // 2. Fetch from orders table (merge and augment)
    try {
        if (phone) {
            const orderRows = await dbAdapter.query(
                `SELECT order_id, customer_phone, status, awb, courier_name, product_name,
                        order_date, expected_delivery, delivered_at, total, payment_method, tracking_url, created_at
                 FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC`,
                [`%${phone}`]
            );
            for (const o of orderRows) {
                const key = String(o.order_id).replace(/^#/, '');
                const existing = ordersMap.get(key) || {
                    orderId: `#${key}`,
                    source: 'orders',
                    name: null,
                    phone: o.customer_phone,
                    email: null,
                    address: null,
                    itemsJson: o.product_name ? [{ title: o.product_name }] : null,
                    cancelReason: null,
                    cancelledAt: null,
                    refundAmount: 0,
                    createdAt: o.order_date || o.created_at || null
                };

                existing.status = o.status || existing.status;
                existing.total = parseFloat(o.total) || existing.total || 0;
                existing.paymentMethod = o.payment_method || existing.paymentMethod;
                existing.awb = o.awb || existing.awb || null;
                existing.courierName = o.courier_name || existing.courierName || null;
                existing.deliveredAt = o.delivered_at || existing.deliveredAt || null;
                existing.expectedDelivery = o.expected_delivery || existing.expectedDelivery || null;
                existing.trackingUrl = o.tracking_url || existing.trackingUrl || null;
                ordersMap.set(key, existing);
            }
        }
    } catch (e) {
        console.warn('[Customer360] orders table fetch error:', e.message);
    }

    // 3. Enrich with shipments table (AWB, carrier, status)
    const orderIds = Array.from(ordersMap.keys());
    if (orderIds.length > 0) {
        try {
            const placeholders = orderIds.map(() => '?').join(',');
            const shipmentRows = await dbAdapter.query(
                `SELECT order_id, carrier, courier_name, awb, status, tracking_url 
                 FROM shipments WHERE order_id IN (${placeholders}) OR order_id IN (${placeholders})`,
                [...orderIds, ...orderIds.map(id => `#${id}`)]
            );
            for (const s of shipmentRows) {
                const key = String(s.order_id).replace(/^#/, '');
                const order = ordersMap.get(key);
                if (order) {
                    order.carrier = s.carrier || order.carrier || null;
                    order.courierName = s.courier_name || order.courierName || null;
                    order.awb = s.awb || order.awb || null;
                    order.shipmentStatus = s.status || null;
                    order.trackingUrl = s.tracking_url || order.trackingUrl || null;
                }
            }
        } catch (e) {}
    }

    return Array.from(ordersMap.values()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/**
 * Fetch all returns and exchanges for this customer
 */
async function fetchCustomerReturnsAndExchanges(phone, orderIds) {
    const results = { returns: [], exchanges: [] };
    const clauses = [];
    const params = [];

    if (phone) {
        clauses.push('customer_phone LIKE ?');
        params.push(`%${phone}`);
    }

    if (orderIds && orderIds.length > 0) {
        for (const oId of orderIds) {
            const clean = oId.replace(/^#/, '');
            clauses.push('order_id = ?');
            params.push(clean);
            clauses.push('order_id = ?');
            params.push(`#${clean}`);
        }
    }

    if (!clauses.length) return results;
    const where = `(${clauses.join(' OR ')})`;

    try {
        results.returns = await dbAdapter.query(
            `SELECT return_id, order_id, customer_phone, reason, status, refund_amount, refund_status, pickup_scheduled_date, created_at 
             FROM returns WHERE ${where} ORDER BY created_at DESC`,
            params
        );
    } catch {}

    try {
        results.exchanges = await dbAdapter.query(
            `SELECT exchange_id, order_id, customer_phone, old_items, new_items, reason, status, price_difference, payment_status, pickup_scheduled_date, created_at 
             FROM exchanges WHERE ${where} ORDER BY created_at DESC`,
            params
        );
    } catch {}

    return results;
}

/**
 * Fetch support tickets for this customer
 */
async function fetchCustomerSupportTickets(phone, email) {
    try {
        const clauses = [];
        const params = [];
        if (phone) {
            clauses.push('customer_phone LIKE ?');
            params.push(`%${phone}`);
        }
        if (email) {
            clauses.push('message ILIKE ?');
            params.push(`%${email}%`);
        }
        if (!clauses.length) return [];

        return await dbAdapter.query(
            `SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, created_at 
             FROM support_tickets WHERE ${clauses.join(' OR ')} ORDER BY created_at DESC LIMIT 10`,
            params
        );
    } catch {
        return [];
    }
}

/**
 * Fetch live customer data from Shopify Admin API (optional enrichment)
 */
async function fetchShopifyCustomer(phone, email) {
    const shop = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP_URL;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token || (!phone && !email)) return null;

    const cleanShop = shop.replace(/^https?:\/\//, '').replace('.myshopify.com', '');
    const url = `https://${cleanShop}.myshopify.com/admin/api/2024-01/customers/search.json`;
    const query = phone ? `phone:${phone}` : `email:${email}`;

    try {
        const res = await axios.get(url, {
            params: { query },
            headers: { 'X-Shopify-Access-Token': token },
            timeout: 8000
        });
        const customers = res.data?.customers || [];
        return customers[0] || null;
    } catch {
        return null;
    }
}

/**
 * Compute metrics, refund history, open issues, and neutral factual summary
 */
function aggregateCustomerMetrics({ profile, orders, returnsAndExchanges, supportTickets, shopifyCustomer, customerDisplayName }) {
    // 1. Order Status Counts
    let totalOrders = orders.length;
    let deliveredOrders = 0;
    let cancelledOrders = 0;
    let returnedOrders = 0;
    let exchangedOrders = 0;
    let lifetimeSpend = 0;

    const openOrders = [];
    const refundRecords = [];

    // Distinct set of returned order IDs
    const returnedOrderIds = new Set(
        (returnsAndExchanges.returns || []).map(r => String(r.order_id).replace(/^#/, ''))
    );
    const exchangedOrderIds = new Set(
        (returnsAndExchanges.exchanges || []).map(e => String(e.order_id).replace(/^#/, ''))
    );

    for (const ord of orders) {
        const cleanId = ord.orderId.replace(/^#/, '');
        const st = String(ord.status || '').toLowerCase();

        const isDelivered = Boolean(
            ord.deliveredAt ||
            st.includes('delivered') ||
            String(ord.shipmentStatus || '').toLowerCase().includes('delivered')
        );

        const isCancelled = Boolean(
            st.includes('cancel') ||
            ord.cancelReason ||
            ord.cancelledAt
        );

        const isReturned = returnedOrderIds.has(cleanId) || st.includes('return');
        const isExchanged = exchangedOrderIds.has(cleanId) || st.includes('exchange');

        if (isDelivered) deliveredOrders++;
        if (isCancelled) cancelledOrders++;
        if (isReturned) returnedOrders++;
        if (isExchanged) exchangedOrders++;

        // Add to spend if not cancelled
        if (!isCancelled && ord.total > 0) {
            lifetimeSpend += ord.total;
        }

        // Check if open order
        if (!isDelivered && !isCancelled && !isReturned) {
            openOrders.push({
                orderId: ord.orderId,
                date: ord.createdAt,
                status: ord.status,
                carrier: ord.carrier || ord.courierName || 'Pending Assignment',
                awb: ord.awb || null,
                total: ord.total,
                paymentMethod: ord.paymentMethod,
                trackingUrl: ord.trackingUrl || null
            });
        }

        // Check cancellation refund
        if (ord.refundAmount > 0) {
            refundRecords.push({
                orderId: ord.orderId,
                type: 'Cancellation Refund',
                amount: ord.refundAmount,
                status: 'Processed',
                date: ord.cancelledAt || ord.updatedAt,
                reason: ord.cancelReason || 'Order Cancelled'
            });
        }
    }

    // 2. Returns and Exchanges Refunds
    for (const r of (returnsAndExchanges.returns || [])) {
        if (r.refund_amount > 0 || r.refund_status) {
            refundRecords.push({
                orderId: `#${String(r.order_id).replace(/^#/, '')}`,
                type: 'Return Refund',
                amount: parseFloat(r.refund_amount) || 0,
                status: r.refund_status || 'Pending',
                date: r.created_at,
                reason: r.reason || 'Return Request'
            });
        }
    }

    // If Shopify has official lifetime spend, use it if higher
    if (shopifyCustomer?.total_spent) {
        const sp = parseFloat(shopifyCustomer.total_spent);
        if (sp > lifetimeSpend) lifetimeSpend = sp;
    }
    if (shopifyCustomer?.orders_count && shopifyCustomer.orders_count > totalOrders) {
        totalOrders = shopifyCustomer.orders_count;
    }

    const totalRefunded = refundRecords.reduce((sum, r) => sum + (r.amount || 0), 0);

    // 3. Latest Order
    const latest = orders[0] || null;
    let latestOrderSummary = null;
    if (latest) {
        let itemNames = [];
        if (Array.isArray(latest.itemsJson)) {
            itemNames = latest.itemsJson.map(i => {
                const title = i.title || i.name || i.product_name || 'Product';
                const size = extractItemSize(i);
                return `${title}${size ? ` (Size: ${size})` : ''} x${i.quantity || 1}`;
            });
        }
        latestOrderSummary = {
            orderId: latest.orderId,
            date: latest.createdAt,
            status: latest.status,
            total: latest.total,
            paymentMethod: latest.paymentMethod,
            items: itemNames.length > 0 ? itemNames : ['Details in order record']
        };
    }

    // 4. Open Support Issues
    const openTickets = (supportTickets || []).filter(t => t.status === 'open');
    const activeReturns = (returnsAndExchanges.returns || []).filter(r => !['completed', 'rejected', 'cancelled'].includes(String(r.status).toLowerCase()));
    const activeExchanges = (returnsAndExchanges.exchanges || []).filter(e => !['completed', 'rejected', 'cancelled'].includes(String(e.status).toLowerCase()));

    const hasOpenIssues = openTickets.length > 0 || activeReturns.length > 0 || activeExchanges.length > 0;

    // 5. Addresses collection
    const addressList = [];
    for (const ord of orders) {
        if (ord.address?.address1 && !addressList.some(a => a.address1 === ord.address.address1)) {
            addressList.push(ord.address);
        }
    }
    if (shopifyCustomer?.default_address) {
        const sAddr = {
            address1: shopifyCustomer.default_address.address1,
            city: shopifyCustomer.default_address.city,
            province: shopifyCustomer.default_address.province,
            zip: shopifyCustomer.default_address.zip,
            country: shopifyCustomer.default_address.country || 'India'
        };
        if (!addressList.some(a => a.address1 === sAddr.address1)) {
            addressList.push(sAddr);
        }
    }

    // 6. Objective, factual summary (NEVER use negative or speculative labels)
    const summaryParts = [];
    const custName = customerDisplayName || 'Customer';
    summaryParts.push(`${custName} has placed ${totalOrders} order(s) total with a cumulative spend of ₹${Math.round(lifetimeSpend)}.`);
    summaryParts.push(`Order breakdown: ${deliveredOrders} delivered, ${cancelledOrders} cancelled, ${returnedOrders} returned, ${exchangedOrders} exchanged.`);
    if (totalRefunded > 0) {
        summaryParts.push(`Total refunds issued: ₹${Math.round(totalRefunded)} across ${refundRecords.length} transaction(s).`);
    }
    if (openOrders.length > 0) {
        summaryParts.push(`Currently has ${openOrders.length} active open order(s): ${openOrders.map(o => `${o.orderId} (${o.status})`).join(', ')}.`);
    } else {
        summaryParts.push('No active open orders.');
    }
    if (hasOpenIssues) {
        const issues = [];
        if (openTickets.length > 0) issues.push(`${openTickets.length} open support ticket(s)`);
        if (activeReturns.length > 0) issues.push(`${activeReturns.length} active return request(s)`);
        if (activeExchanges.length > 0) issues.push(`${activeExchanges.length} active exchange request(s)`);
        summaryParts.push(`Active support issues: ${issues.join(', ')}.`);
    } else {
        summaryParts.push('No open support issues.');
    }

    return {
        metrics: {
            totalOrders,
            deliveredOrders,
            cancelledOrders,
            returnedOrders,
            exchangedOrders,
            totalSpend: Math.round(lifetimeSpend * 100) / 100,
            currency: 'INR'
        },
        refundHistory: {
            totalRefunded: Math.round(totalRefunded * 100) / 100,
            recordsCount: refundRecords.length,
            records: refundRecords
        },
        currentOrders: {
            openOrdersCount: openOrders.length,
            openOrders,
            latestOrder: latestOrderSummary
        },
        supportIssues: {
            hasOpenIssues,
            openTicketsCount: openTickets.length,
            tickets: openTickets.map(t => ({
                ticketNumber: t.ticket_number,
                message: t.message,
                status: t.status,
                createdAt: t.created_at
            })),
            activeReturnsCount: activeReturns.length,
            activeReturns: activeReturns.map(r => ({
                returnId: r.return_id,
                orderId: `#${String(r.order_id).replace(/^#/, '')}`,
                status: r.status,
                reason: r.reason,
                pickupDate: r.pickup_scheduled_date
            })),
            activeExchangesCount: activeExchanges.length,
            activeExchanges: activeExchanges.map(e => ({
                exchangeId: e.exchange_id,
                orderId: `#${String(e.order_id).replace(/^#/, '')}`,
                status: e.status,
                reason: e.reason,
                pickupDate: e.pickup_scheduled_date
            }))
        },
        addresses: addressList,
        factualSummary: summaryParts.join(' ')
    };
}

/**
 * Main Customer 360 Entry Point
 * 
 * @param {string} customerIdentifier - Phone, order ID (#12345), email, or customer name
 * @param {object} context - User context (e.g. { actor: 'admin' })
 * @returns {Promise<object>} Consolidated factual Customer360 object
 */
async function getCustomer360(customerIdentifier, context = {}) {
    if (!customerIdentifier || !String(customerIdentifier).trim()) {
        return {
            found: false,
            error: 'Customer identifier is required (phone number, order ID like #12345, email, or name)'
        };
    }

    // 1. Resolve identifier
    const target = await resolveCustomerTarget(customerIdentifier);
    if (!target) {
        return {
            found: false,
            identifier: customerIdentifier,
            error: `Customer not found matching "${customerIdentifier}"`
        };
    }

    const { phone, email, name, orderId, resolvedBy } = target;

    // 2. Fetch customer profile, orders, returns, support tickets in parallel
    const [
        profile,
        orders,
        supportTickets,
        shopifyCustomer
    ] = await Promise.all([
        fetchCustomerProfile(phone, email, name),
        fetchCustomerOrders(phone, email),
        fetchCustomerSupportTickets(phone, email),
        fetchShopifyCustomer(phone, email)
    ]);

    // Check if we found any data at all
    if (!profile && orders.length === 0 && supportTickets.length === 0 && !shopifyCustomer) {
        return {
            found: false,
            identifier: customerIdentifier,
            resolvedTarget: { phone, email, name, orderId, resolvedBy },
            error: `No customer records found matching "${customerIdentifier}" in database or Shopify.`
        };
    }

    // 3. Fetch returns and exchanges for the customer's orders
    const orderIds = orders.map(o => o.orderId);
    const returnsAndExchanges = await fetchCustomerReturnsAndExchanges(phone, orderIds);

    // 4. Construct normalized identity with intelligent name & email selection
    const candidateNames = [
        target?.name,
        orders[0]?.name,
        ...orders.map(o => o.name),
        shopifyCustomer ? `${shopifyCustomer.first_name || ''} ${shopifyCustomer.last_name || ''}`.trim() : null,
        profile?.name,
        name
    ];
    const displayName = selectBestCustomerName(candidateNames);

    const candidateEmails = [
        target?.email,
        orders[0]?.email,
        ...orders.map(o => o.email),
        shopifyCustomer?.email,
        profile?.email,
        email
    ];
    const displayEmail = selectBestCustomerEmail(candidateEmails);

    // 5. Compute metrics and factual summary
    const aggregation = aggregateCustomerMetrics({
        profile,
        orders,
        returnsAndExchanges,
        supportTickets,
        shopifyCustomer,
        customerDisplayName: displayName
    });

    const displayPhone = phone ? (phone.startsWith('91') && phone.length === 12 ? `+${phone}` : `+91 ${phone.slice(-10)}`) : (orders[0]?.phone || 'Not available');
    const rawSince = profile?.created_at || orders[orders.length - 1]?.createdAt || shopifyCustomer?.created_at || null;
    const displaySince = formatReadableDate(rawSince);

    // If profile in customers table had an inferior/initial name, auto-update with the verified full name
    if (phone && displayName && displayName !== 'Customer' && (!profile?.name || scoreNameQuality(profile.name) < 20)) {
        dbAdapter.update('customers', { name: displayName, email: displayEmail !== 'Not available' ? displayEmail : undefined }, { phone }).catch(() => {});
    }

    return {
        found: true,
        resolvedBy,
        searchedIdentifier: customerIdentifier,
        linkedOrderId: orderId || null,
        identity: {
            name: displayName,
            phone: displayPhone,
            email: displayEmail,
            preferredLanguage: profile?.preferred_language || 'en',
            customerSince: displaySince,
            addresses: aggregation.addresses
        },
        metrics: aggregation.metrics,
        refundHistory: aggregation.refundHistory,
        currentOrders: aggregation.currentOrders,
        supportIssues: aggregation.supportIssues,
        factualSummary: aggregation.factualSummary
    };
}

module.exports = {
    getCustomer360,
    resolveCustomerTarget,
    normalizePhone
};
