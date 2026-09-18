/**
 * Widget API routes — customer-facing support widget endpoints.
 *
 * POST /api/widget/chat        — AI-powered conversation
 * POST /api/widget/context     — Record non-AI exchanges into the AI session
 * POST /api/widget/track-order — Multi-carrier order tracking
 * POST /api/widget/ticket      — Create support ticket (escalation)
 * GET  /api/widget/session     — Initialize session, return brand config
 */

const express = require('express');
const router = express.Router();
const { runCustomerAgent, createWidgetTicket, noteSessionContext, appendSessionExchange } = require('../services/ai/customerAgent');
const { getAdapter, getConfiguredCarriers } = require('../services/carriers');

function normalizeExternalRequest(request) {
    return {
        request_id: request.request_id || request.requestId || request.id || null,
        order_number: request.order_number || request.orderNumber || request.order_id || null,
        type: request.type || 'return',
        status: request.status || 'Pending',
        reason: request.reason || null,
        items: Array.isArray(request.items) ? request.items : [],
        created_at: request.created_at || request.createdAt || null
    };
}

async function findExternalReturnRequests(query) {
    const baseUrl = process.env.RETURNS_SERVER_URL;
    if (!baseUrl) return [];

    const axios = require('axios');
    const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/ai-data`, {
        params: { resource: 'requests', query, limit: 20 },
        headers: { 'x-internal-token': process.env.WHATSAPP_INTERNAL_TOKEN || '' },
        timeout: 15000
    });

    return Array.isArray(response.data?.requests)
        ? response.data.requests.map(normalizeExternalRequest)
        : [];
}

// ---------- Rate limiter for widget endpoints ----------

const widgetLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again in a minute.' }
});

router.use(widgetLimiter);

// ---------- GET /api/widget/session ----------
// Returns brand config and WhatsApp number for the widget to use

router.get('/session', (req, res) => {
    try {
        const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
        res.json({
            brandName: 'OFFCOMFRT',
            tagline: 'How can we help you today?',
            whatsappNumber: businessNumber,
            carriers: getConfiguredCarriers().map(c => ({ key: c.key, name: c.name }))
        });
    } catch (error) {
        console.error('[widget] session error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- POST /api/widget/chat ----------
// AI-powered conversation for the customer widget

router.post('/chat', async (req, res) => {
    try {
        const { sessionId, message, visitorId } = req.body;

        if (!sessionId || !message) {
            return res.status(400).json({ error: 'sessionId and message are required' });
        }

        if (String(message).length > 1000) {
            return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
        }

        const result = await runCustomerAgent({ sessionId, message, visitorId });

        res.json({
            reply: result.reply,
            suggestedAction: result.suggestedAction,
            cardType: result.cardType || null,
            cardData: result.cardData || null
        });
    } catch (error) {
        console.error('[widget] chat error:', error.message);

        // Graceful fallback — never show raw errors to customers
        if (error.code === 'AI_RATE_LIMIT') {
            return res.status(429).json({
                reply: 'I am a bit busy right now. Please try again in a moment, or reach out on WhatsApp for immediate help.',
                suggestedAction: null
            });
        }

        res.status(500).json({
            reply: 'Sorry, something went wrong. Please try again or contact us on WhatsApp.',
            suggestedAction: null
        });
    }
});

// ---------- POST /api/widget/context ----------
// Silently records an exchange handled outside the AI chat (e.g. the direct
// tracking card) into the AI session, so follow-up AI turns keep context.

router.post('/context', async (req, res) => {
    try {
        const { sessionId, userMessage, botMessage, entities } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        await appendSessionExchange({ sessionId, userMessage, botMessage, entities });
        res.json({ ok: true });
    } catch (error) {
        console.error('[widget] context error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- POST /api/widget/track-order ----------
// Multi-carrier order tracking (Delhivery -> Ekart -> Shiprocket)

router.post('/track-order', async (req, res) => {
    try {
        const { orderId, awb, phone, sessionId } = req.body;

        if (!orderId && !awb && !phone) {
            return res.status(400).json({ error: 'Provide an order ID or phone number' });
        }

        let cleanAwb = awb ? String(awb).trim() : null;
        let cleanOrderId = null;

        if (orderId) {
            const raw = String(orderId).trim();
            // AWB: 10-16 digit numbers
            const awbMatch = raw.match(/\b(\d{10,16})\b/);
            if (awbMatch && !cleanAwb) {
                cleanAwb = awbMatch[1];
            }
            // Order ID: #53388, ORD-53388, 53388 order status, or standalone 4-6 digits
            const orderMatch = raw.match(/#(\d{4,6})/i)
                || raw.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
                || raw.match(/\b(\d{4,6})\b/)
                || raw.match(/(\d{4,6})/);
            if (orderMatch) {
                cleanOrderId = orderMatch[1];
            } else {
                cleanOrderId = raw.replace(/^#/, '').replace(/\s/g, '');
            }
        }
        
        // If no orderId was provided, resolve the latest order from the phone number
        if (!cleanOrderId && !cleanAwb && phone) {
            const digits = String(phone).replace(/\D/g, '');
            if (digits.length >= 10) {
                const phonePattern = `%${digits.slice(-10)}%`;
                try {
                    const { dbAdapter } = require('../database/db');
                    const shopperRows = await dbAdapter.query(
                        'SELECT order_id FROM store_shoppers WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 1',
                        [phonePattern]
                    );
                    if (shopperRows && shopperRows.length > 0) {
                        cleanOrderId = String(shopperRows[0].order_id || '').replace(/^#/, '').trim();
                    } else {
                        const orderRows = await dbAdapter.query(
                            'SELECT order_id FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 1',
                            [phonePattern]
                        );
                        if (orderRows && orderRows.length > 0) {
                            cleanOrderId = String(orderRows[0].order_id || '').replace(/^#/, '').trim();
                        }
                    }
                } catch (e) { /* best-effort lookup */ }
            }
        }

        // Remember the order ID in the AI session
        if (sessionId && cleanOrderId) {
            if (/^\d{3,6}$/.test(cleanOrderId)) {
                await noteSessionContext({ sessionId, entities: { orderId: cleanOrderId } });
            }
        }

        let trackingResult = null;
        let carrierUsed = null;
        let resolvedAwb = cleanAwb || null;

        // Case 1: AWB provided — try all carriers in sequence
        if (cleanAwb) {
            const carriers = getConfiguredCarriers().map(c => c.key);
            // Prefer Delhivery -> Ekart -> Shiprocket order
            const preferredOrder = ['delhivery', 'ekart', 'shiprocket'];
            const orderedCarriers = preferredOrder.filter(c => carriers.includes(c));
            // Add any remaining carriers not in preferred list
            carriers.forEach(c => { if (!orderedCarriers.includes(c)) orderedCarriers.push(c); });

            for (const carrierKey of orderedCarriers) {
                try {
                    const adapter = getAdapter(carrierKey);
                    if (!adapter || !adapter.isConfigured()) continue;
                    const result = await adapter.track(cleanAwb);
                    if (result && result.success !== false && result.data) {
                        trackingResult = result.data;
                        carrierUsed = carrierKey;
                        break;
                    }
                } catch (e) {
                    // Try next carrier
                    continue;
                }
            }
        }

        // Case 2: Order ID provided — resolve AWB internally (customer never needs one)
        if (!trackingResult && cleanOrderId) {
            const orderName = cleanOrderId;

            // 2a. Shoppers Hub shipment data — shipments/orders tables carry the booked AWB
            try {
                const { dbAdapter } = require('../database/db');
                let shipmentAwb = null;
                let shipmentCarrier = null;

                const shipRows = await dbAdapter.query(
                    `SELECT carrier, awb FROM shipments
                     WHERE order_id = ? AND awb IS NOT NULL
                     ORDER BY CASE WHEN status NOT IN ('cancelled', 'failed') THEN 0 ELSE 1 END, id DESC
                     LIMIT 1`,
                    [orderName]
                );
                if (shipRows && shipRows.length > 0) {
                    shipmentAwb = shipRows[0].awb;
                    shipmentCarrier = shipRows[0].carrier;
                }

                if (!shipmentAwb) {
                    const orderRows = await dbAdapter.query(
                        'SELECT awb, courier_name FROM orders WHERE order_id = ? LIMIT 1',
                        [orderName]
                    );
                    shipmentAwb = orderRows?.[0]?.awb || null;
                }

                if (shipmentAwb) {
                    resolvedAwb = shipmentAwb;
                    const carriers = getConfiguredCarriers().map(c => c.key);
                    const orderedCarriers = shipmentCarrier && carriers.includes(shipmentCarrier)
                        ? [shipmentCarrier, ...carriers.filter(c => c !== shipmentCarrier)]
                        : carriers;

                    for (const carrierKey of orderedCarriers) {
                        try {
                            const adapter = getAdapter(carrierKey);
                            if (!adapter || !adapter.isConfigured()) continue;
                            const result = await adapter.track(shipmentAwb);
                            if (result && result.success !== false && result.data) {
                                trackingResult = result.data;
                                carrierUsed = carrierKey;
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    // AWB exists but no live tracking yet — still report the order
                    if (!trackingResult) {
                        trackingResult = {
                            awb: shipmentAwb,
                            orderId: orderName,
                            note: 'Your order has been shipped. Live tracking updates will appear here shortly.'
                        };
                        carrierUsed = shipmentCarrier || 'shopify';
                    }
                } else {
                    // No AWB yet — check if the order exists in Shoppers Hub and report its stage
                    const shopperRows = await dbAdapter.query(
                        'SELECT status, payment_method, cancel_reason, shopify_cancelled_at, created_at FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
                        [orderName]
                    );
                    if (shopperRows && shopperRows.length > 0) {
                        const row = shopperRows[0];
                        const shopperStatus = (row.status || '').toLowerCase();
                        const isCancelled = shopperStatus === 'cancelled' || !!row.cancel_reason || !!row.shopify_cancelled_at;
                        const isPrepaid = /prepaid/i.test(row.payment_method || '');
                        
                        let displayStatus = 'Confirmed';
                        let note = 'Your order will be shipped within 24 to 48 hours.';
                        let stage = 'confirmed';

                        if (isCancelled) {
                            stage = 'cancelled';
                            displayStatus = 'Cancelled';
                            note = isPrepaid
                                ? 'Your order has been cancelled. Your refund has been initiated and will reflect in your original payment method within 5 to 7 business days.'
                                : 'Your order has been cancelled. Since this was a Cash on Delivery (COD) order, no amount was charged.';
                        } else if (shopperStatus === 'delivered') {
                            stage = 'delivered';
                            displayStatus = 'Delivered';
                            note = 'Your order has been delivered. Size exchanges and returns are accepted within 2 days of delivery.';
                        } else if (shopperStatus === 'confirmed') {
                            stage = 'confirmed';
                            displayStatus = 'Confirmed';
                            note = 'Your order will be shipped within 24 to 48 hours.';
                        } else {
                            stage = 'pending_confirmation';
                            displayStatus = 'Awaiting Confirmation';
                            note = 'Please confirm your order via the WhatsApp confirmation message sent to your registered mobile number.';
                        }

                        trackingResult = {
                            orderId: orderName,
                            stage: stage,
                            fulfillmentStatus: displayStatus,
                            note: note
                        };
                        carrierUsed = 'offcomfrt';
                    } else {
                        // Check orders table
                        const orderRows = await dbAdapter.query(
                            'SELECT status, payment_method, created_at FROM orders WHERE order_id = ? LIMIT 1',
                            [orderName]
                        );
                        if (orderRows && orderRows.length > 0) {
                            const oRow = orderRows[0];
                            const oStatus = (oRow.status || '').toLowerCase();
                            let stage = 'confirmed';
                            let displayStatus = oRow.status || 'Confirmed';
                            let note = 'Your order will be shipped within 24 to 48 hours.';
                            if (oStatus === 'delivered') {
                                stage = 'delivered';
                                displayStatus = 'Delivered';
                                note = 'Your order has been delivered. Size exchanges and returns are accepted within 2 days of delivery.';
                            } else if (oStatus === 'cancelled') {
                                stage = 'cancelled';
                                displayStatus = 'Cancelled';
                                note = 'This order has been cancelled.';
                            }
                            trackingResult = {
                                orderId: orderName,
                                stage: stage,
                                fulfillmentStatus: displayStatus,
                                note: note
                            };
                            carrierUsed = 'offcomfrt';
                        }
                    }
                }
            } catch (hubErr) {
                console.warn('[widget] Shoppers Hub lookup failed:', hubErr.message);
            }

            // 2b. Fallback: Shopify fulfillment lookup
            if (!trackingResult) {
            try {
                const axios = require('axios');
                const shop = process.env.SHOPIFY_STORE;
                const token = process.env.SHOPIFY_ACCESS_TOKEN;

                if (shop && token) {
                    const orderName = String(orderId).replace(/^#/, '');
                    const url = `https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderName)}&status=any`;
                    const response = await axios.get(url, {
                        headers: { 'X-Shopify-Access-Token': token },
                        timeout: 10000
                    });

                    const order = response.data?.orders?.[0];
                    if (order) {
                        // Try to get fulfillment tracking info
                        const fulfillment = order.fulfillments?.[0];
                        const trackingInfo = fulfillment?.tracking_info?.[0] || fulfillment?.tracking_info;
                        const orderAwb = trackingInfo?.number || trackingInfo?.tracking_number;

                        if (orderAwb) {
                            resolvedAwb = orderAwb;
                            // Now track this AWB across carriers
                            const carriers = getConfiguredCarriers().map(c => c.key);
                            const preferredOrder = ['delhivery', 'ekart', 'shiprocket'];
                            const orderedCarriers = preferredOrder.filter(c => carriers.includes(c));

                            for (const carrierKey of orderedCarriers) {
                                try {
                                    const adapter = getAdapter(carrierKey);
                                    if (!adapter || !adapter.isConfigured()) continue;
                                    const result = await adapter.track(orderAwb);
                                    if (result && result.success !== false && result.data) {
                                        trackingResult = result.data;
                                        carrierUsed = carrierKey;
                                        break;
                                    }
                                } catch (e) {
                                    continue;
                                }
                            }

                            // If no carrier had tracking, return order info at least
                            if (!trackingResult) {
                                trackingResult = {
                                    awb: orderAwb,
                                    orderId: order.name,
                                    fulfillmentStatus: order.fulfillment_status,
                                    financialStatus: order.financial_status,
                                    createdAt: order.created_at,
                                    note: 'Your order will be shipped within 24 to 48 hours.'
                                };
                                carrierUsed = 'offcomfrt';
                            }
                        } else {
                            // No AWB yet — return order status
                            const isUnfulfilled = !order.fulfillment_status || order.fulfillment_status === 'unfulfilled';
                            let note;
                            let stage = 'confirmed';
                            if (!isUnfulfilled) {
                                note = 'Your order will be shipped within 24 to 48 hours.';
                            } else {
                                // Re-check Shoppers Hub for accurate pending vs confirmed messaging
                                let hubNote = null;
                                try {
                                    const { dbAdapter } = require('../database/db');
                                    const hubRows = await dbAdapter.query(
                                        'SELECT status FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
                                        [order.name]
                                    );
                                    if (hubRows && hubRows.length > 0) {
                                        const hs = (hubRows[0].status || '').toLowerCase();
                                        if (hs === 'confirmed') {
                                            hubNote = 'Your order will be shipped within 24 to 48 hours.';
                                            stage = 'confirmed';
                                        } else {
                                            hubNote = 'Please confirm your order via the template message sent to you.';
                                            stage = 'pending_confirmation';
                                        }
                                    }
                                } catch (e) { /* best-effort */ }
                                note = hubNote || 'Please confirm your order via the template message sent to you.';
                            }
                            trackingResult = {
                                orderId: order.name,
                                stage: stage,
                                fulfillmentStatus: order.fulfillment_status || 'Confirmed',
                                financialStatus: order.financial_status,
                                createdAt: order.created_at,
                                note: note
                            };
                            carrierUsed = 'offcomfrt';
                        }
                    }
                }
            } catch (shopifyErr) {
                console.warn('[widget] Shopify lookup failed:', shopifyErr.message);
            }
            }
        }

        if (!trackingResult) {
            const cleanDisplayId = (cleanOrderId || orderId || '').replace(/^#/, '').trim();
            return res.status(404).json({
                error: 'Order Not Found',
                message: cleanDisplayId
                    ? `We could not find order #${cleanDisplayId} in our system.\n\nPlease check your confirmation SMS or email for your 4-6 digit order number, or search using your 10-digit registered mobile number.`
                    : 'We could not find tracking details for that request. Please verify your order number or registered mobile number and try again.',
                notFound: true,
                orderId: cleanDisplayId || null
            });
        }

        // Format the response for the widget UI.
        const trackData = trackingResult.shipment_track?.[0] || trackingResult;

        const rawTimeline = trackingResult.timeline
            || trackData.timeline
            || trackData.track_status
            || trackingResult.shipment_track_activities
            || trackData.shipment_track_activities
            || null;

        const timeline = Array.isArray(rawTimeline)
            ? rawTimeline.filter(Boolean).map(t => ({
                date: t.date || t.ScanDateTime || null,
                location: t.location || t.ScannedLocation || '',
                activity: t.activity || t.description || t.Instructions || t.status || '',
                status: t.status || ''
            }))
            : null;

        // Most recent scan (by date) gives us the current location
        let latestScan = null;
        if (timeline && timeline.length) {
            latestScan = timeline.reduce((a, b) => {
                const da = Date.parse(a?.date || '') || 0;
                const db = Date.parse(b?.date || '') || 0;
                return db > da ? b : a;
            });
        }

        const rawStatus = trackData.currentStatus || trackData.current_status || trackData.fulfillmentStatus || 'Unknown';
        let stage = trackData.stage || 'in_transit';
        if (/delivered/i.test(rawStatus)) {
            stage = 'delivered';
        } else if (/cancelled/i.test(rawStatus)) {
            stage = 'cancelled';
        } else if (/rto|undelivered|failed/i.test(rawStatus)) {
            stage = 'rto';
        } else if (/out.?for.?delivery/i.test(rawStatus)) {
            stage = 'out_for_delivery';
        } else if (/confirm/i.test(rawStatus)) {
            stage = 'confirmed';
        } else if (/pending|unfulfilled|awaiting/i.test(rawStatus)) {
            stage = 'pending_confirmation';
        }

        let carrierDisplayName = 'OFFCOMFRT Fulfillment';
        if (carrierUsed && carrierUsed !== 'shopify' && carrierUsed !== 'offcomfrt') {
            const found = getConfiguredCarriers().find(c => c.key === carrierUsed);
            carrierDisplayName = found ? found.name : (carrierUsed.charAt(0).toUpperCase() + carrierUsed.slice(1));
        }

        res.json({
            carrier: carrierUsed,
            carrierName: carrierDisplayName,
            awb: trackData.awb_code || trackData.awb || resolvedAwb || null,
            orderId: orderId ? String(orderId).replace(/^#/, '').trim() : null,
            status: rawStatus,
            stage: stage,
            location: trackData.current_location || latestScan?.location || null,
            shippedDate: trackData.shipped_date || null,
            expectedDelivery: trackData.expectedDelivery || trackData.edd || trackData.etd || null,
            deliveredDate: trackData.delivered_date || null,
            trackingUrl: trackData.tracking_url || null,
            note: trackData.note || null,
            timeline: timeline
        });

    } catch (error) {
        console.error('[widget] track-order error:', error.message);
        res.status(500).json({ error: 'Failed to fetch tracking information. Please try again.' });
    }
});

// ---------- POST /api/widget/lookup-order ----------
// Look up customer details (name, phone, email) from order number

router.post('/lookup-order', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'Order ID is required' });
        }

        const { dbAdapter } = require('../database/db');
        const cleanOrderId = String(orderId).replace(/^#/, '').trim();

        // Look up customer details from store_shoppers table
        const shopperRows = await dbAdapter.query(
            `SELECT name, phone, email FROM store_shoppers
             WHERE order_id = ?
             ORDER BY created_at DESC LIMIT 1`,
            [cleanOrderId]
        );

        if (shopperRows && shopperRows.length > 0) {
            const row = shopperRows[0];
            // Only return first name for friendly greeting (e.g. "Thanks, Ketan.")
            // Never expose phone number or email over public unauthenticated endpoint
            const firstName = (row.name || '').trim().split(/\s+/)[0] || null;

            res.json({
                success: true,
                name: firstName,
                phone: null,
                email: null
            });
        } else {
            res.json({
                success: false,
                name: null,
                phone: null,
                email: null
            });
        }
    } catch (error) {
        console.error('[widget] lookup-order error:', error.message);
        res.status(500).json({ error: 'Failed to lookup order details' });
    }
});

// ---------- POST /api/widget/search-by-phone ----------
// Search orders for a given customer phone number (strictly sanitized, no PII returned)
router.post('/search-by-phone', async (req, res) => {
    try {
        const { phone } = req.body;
        const digits = String(phone || '').replace(/\D/g, '');
        if (digits.length < 10) {
            return res.status(400).json({ error: 'Please provide a valid 10-digit mobile number' });
        }
        const last10 = digits.slice(-10);
        const phonePattern = `%${last10}%`;

        const { dbAdapter } = require('../database/db');
        const orders = [];
        const seen = new Set();

        // 1. Query store_shoppers (primary table for customer orders)
        try {
            const shopperRows = await dbAdapter.query(
                `SELECT order_id, status, items_json, order_total, created_at
                 FROM store_shoppers
                 WHERE phone LIKE ?
                 ORDER BY created_at DESC LIMIT 5`,
                [phonePattern]
            );
            if (shopperRows && shopperRows.length > 0) {
                shopperRows.forEach(r => {
                    const cleanId = String(r.order_id || '').replace(/^#/, '').trim();
                    if (cleanId && !seen.has(cleanId)) {
                        seen.add(cleanId);
                        let itemName = null;
                        if (r.items_json) {
                            try {
                                const parsed = typeof r.items_json === 'string' ? JSON.parse(r.items_json) : r.items_json;
                                if (Array.isArray(parsed) && parsed.length > 0) {
                                    itemName = parsed[0].name || parsed[0].title || null;
                                    if (parsed.length > 1) {
                                        itemName += ` +${parsed.length - 1} more`;
                                    }
                                }
                            } catch (e) { /* ignore parse error */ }
                        }
                        orders.push({
                            orderId: cleanId,
                            status: r.status || 'Confirmed',
                            item: itemName,
                            total: r.order_total || null,
                            createdAt: r.created_at || null
                        });
                    }
                });
            }
        } catch (err) {
            console.warn('[widget] search-by-phone shoppers query error:', err.message);
        }

        // 2. Query orders table (fulfillment / tracking table)
        try {
            const orderRows = await dbAdapter.query(
                `SELECT order_id, status, product_name, total, created_at
                 FROM orders
                 WHERE customer_phone LIKE ?
                 ORDER BY created_at DESC LIMIT 5`,
                [phonePattern]
            );
            if (orderRows && orderRows.length > 0) {
                orderRows.forEach(r => {
                    const cleanId = String(r.order_id || '').replace(/^#/, '').trim();
                    if (cleanId && !seen.has(cleanId)) {
                        seen.add(cleanId);
                        orders.push({
                            orderId: cleanId,
                            status: r.status || 'Processing',
                            item: r.product_name || null,
                            total: r.total || null,
                            createdAt: r.created_at || null
                        });
                    }
                });
            }
        } catch (err) {
            console.warn('[widget] search-by-phone orders query error:', err.message);
        }

        // Return strictly sanitized order list (no names, no phone, no addresses)
        res.json({
            success: true,
            count: orders.length,
            orders
        });
    } catch (error) {
        console.error('[widget] search-by-phone error:', error.message);
        res.status(500).json({ error: 'Failed to search orders by phone' });
    }
});

// ---------- POST /api/widget/check-return-eligibility ----------
// Validates whether an order is eligible for Return / Exchange within the 2-day delivery window per SOP
router.post('/check-return-eligibility', async (req, res) => {
    try {
        const { orderId, phone } = req.body;
        if (!orderId && !phone) {
            return res.status(400).json({ error: 'Order ID or phone number is required' });
        }

        const { dbAdapter } = require('../database/db');
        let cleanOrderId = orderId ? String(orderId).replace(/^#/, '').trim() : null;

        // If phone provided without orderId, lookup latest order
        if (!cleanOrderId && phone) {
            const digits = String(phone).replace(/\D/g, '');
            if (digits.length >= 10) {
                const phonePattern = `%${digits.slice(-10)}%`;
                try {
                    const shopperRows = await dbAdapter.query(
                        'SELECT order_id FROM store_shoppers WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 1',
                        [phonePattern]
                    );
                    if (shopperRows && shopperRows.length > 0) {
                        cleanOrderId = String(shopperRows[0].order_id || '').replace(/^#/, '').trim();
                    } else {
                        const orderRows = await dbAdapter.query(
                            'SELECT order_id FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 1',
                            [phonePattern]
                        );
                        if (orderRows && orderRows.length > 0) {
                            cleanOrderId = String(orderRows[0].order_id || '').replace(/^#/, '').trim();
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }

        if (!cleanOrderId) {
            return res.status(404).json({ success: false, notFound: true, message: 'Order not found' });
        }

        // 1. Check orders table
        let orderRow = null;
        try {
            const rows = await dbAdapter.query(
                `SELECT order_id, status, created_at, updated_at, delivered_at
                 FROM orders WHERE order_id = ? OR order_id = ? LIMIT 1`,
                [cleanOrderId, '#' + cleanOrderId]
            );
            if (rows && rows.length > 0) orderRow = rows[0];
        } catch (e) {
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, status, created_at, updated_at
                     FROM orders WHERE order_id = ? OR order_id = ? LIMIT 1`,
                    [cleanOrderId, '#' + cleanOrderId]
                );
                if (rows && rows.length > 0) orderRow = rows[0];
            } catch (e2) {}
        }

        // 2. Fallback check store_shoppers table
        let shopperRow = null;
        if (!orderRow) {
            try {
                const sRows = await dbAdapter.query(
                    `SELECT order_id, status, created_at, updated_at
                     FROM store_shoppers WHERE order_id = ? OR order_id = ? LIMIT 1`,
                    [cleanOrderId, '#' + cleanOrderId]
                );
                if (sRows && sRows.length > 0) shopperRow = sRows[0];
            } catch (e) {}
        }

        // 3. Check shipments table for latest tracking & delivery timestamp
        let shipmentRow = null;
        try {
            const shipRows = await dbAdapter.query(
                `SELECT carrier, awb, status, delivered_at, updated_at, created_at
                 FROM shipments WHERE order_id = ? OR order_id = ?
                 ORDER BY id DESC LIMIT 1`,
                [cleanOrderId, '#' + cleanOrderId]
            );
            if (shipRows && shipRows.length > 0) shipmentRow = shipRows[0];
        } catch (e) {}

        if (!orderRow && !shopperRow && !shipmentRow) {
            return res.json({
                success: false,
                notFound: true,
                orderId: cleanOrderId,
                message: 'No order found with number #' + cleanOrderId
            });
        }

        const rawStatus = (shipmentRow && shipmentRow.status) || (orderRow && orderRow.status) || (shopperRow && shopperRow.status) || 'confirmed';
        const normStatus = rawStatus.toLowerCase();

        // Determine if order is delivered
        const isDelivered = normStatus.includes('deliver') || normStatus === 'dlv';

        if (!isDelivered) {
            let stageLabel = 'Processing';
            if (normStatus.includes('transit') || normStatus.includes('shipped') || normStatus.includes('dispatched')) {
                stageLabel = 'In Transit';
            } else if (normStatus.includes('out_for_delivery') || normStatus.includes('out for delivery')) {
                stageLabel = 'Out for Delivery';
            } else if (normStatus.includes('confirm')) {
                stageLabel = 'Confirmed (Awaiting Dispatch)';
            } else if (normStatus.includes('cancel')) {
                stageLabel = 'Cancelled';
            } else if (normStatus.includes('rto')) {
                stageLabel = 'Returned to Origin (RTO)';
            }

            return res.json({
                success: true,
                eligible: false,
                orderId: cleanOrderId,
                stage: 'not_delivered',
                status: rawStatus,
                statusLabel: stageLabel,
                message: 'Order #' + cleanOrderId + ' has not been delivered yet. Return and exchange requests can only be initiated after delivery.'
            });
        }

        // Delivered order — determine exact delivery timestamp
        const deliveredDate = (shipmentRow && shipmentRow.delivered_at)
            ? new Date(shipmentRow.delivered_at)
            : ((orderRow && orderRow.delivered_at)
                ? new Date(orderRow.delivered_at)
                : new Date((shipmentRow && (shipmentRow.updated_at || shipmentRow.created_at)) || (orderRow && (orderRow.updated_at || orderRow.created_at)) || (shopperRow && (shopperRow.updated_at || shopperRow.created_at))));

        const diffMs = Date.now() - deliveredDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = Math.round((diffHours / 24) * 10) / 10;
        const windowHours = 48; // 2 days per SOP
        const isEligible = diffHours <= windowHours;
        const hoursRemaining = Math.max(0, Math.round(windowHours - diffHours));

        res.json({
            success: true,
            eligible: isEligible,
            orderId: cleanOrderId,
            stage: isEligible ? 'eligible' : 'expired',
            deliveredAt: deliveredDate.toISOString(),
            daysSinceDelivery: diffDays,
            hoursRemaining: isEligible ? hoursRemaining : 0,
            portalUrl: 'https://www.offcomfrt.in/pages/return?order=' + encodeURIComponent(cleanOrderId),
            exchangeUrl: 'https://www.offcomfrt.in/pages/exchange?order=' + encodeURIComponent(cleanOrderId),
            reason: isEligible
                ? 'Within 2-day return window (' + hoursRemaining + ' hours remaining)'
                : 'Return window expired (delivered ' + diffDays + ' days ago, SOP limit is 2 days)'
        });
    } catch (error) {
        console.error('[widget] check-return-eligibility error:', error.message);
        res.status(500).json({ error: 'Failed to check return eligibility' });
    }
});

// ---------- POST /api/widget/edit-request ----------
// Structured handler for Pre-Dispatch Order Modification (Size, Address, Cancellation)
router.post('/edit-request', async (req, res) => {
    try {
        const { orderId, type, details, newSize, updatedAddress, pincode, name, phone, email, source, sessionId, visitorId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'Order ID is required' });
        }

        const { dbAdapter } = require('../database/db');
        const cleanOrderId = String(orderId).replace(/^#/, '').trim();

        // Check if order has already been booked with an AWB / dispatched
        let shipmentRow = null;
        try {
            const shipRows = await dbAdapter.query(
                `SELECT carrier, awb, status FROM shipments
                 WHERE (order_id = ? OR order_id = ?) AND status NOT IN ('cancelled', 'failed') AND awb IS NOT NULL
                 ORDER BY id DESC LIMIT 1`,
                [cleanOrderId, '#' + cleanOrderId]
            );
            if (shipRows && shipRows.length > 0) shipmentRow = shipRows[0];
        } catch (e) {}

        let orderRow = null;
        try {
            const ordRows = await dbAdapter.query(
                `SELECT status, customer_name, customer_phone FROM orders
                 WHERE order_id = ? OR order_id = ? LIMIT 1`,
                [cleanOrderId, '#' + cleanOrderId]
            );
            if (ordRows && ordRows.length > 0) orderRow = ordRows[0];
        } catch (e) {}

        const currentStatus = (shipmentRow && shipmentRow.status) || (orderRow && orderRow.status) || '';
        const isDispatched = !!(shipmentRow && shipmentRow.awb) || /shipped|in[-_ ]?transit|out[-_ ]?for[-_ ]?delivery|delivered|dispatched/i.test(currentStatus);

        if (isDispatched) {
            return res.json({
                success: false,
                dispatched: true,
                orderId: cleanOrderId,
                carrier: shipmentRow ? shipmentRow.carrier : null,
                awb: shipmentRow ? shipmentRow.awb : null,
                message: 'Order #' + cleanOrderId + ' has already been dispatched and cannot be modified in transit per SOP rules.'
            });
        }

        // Build descriptive tag and message
        const normType = String(type || 'EDIT').toUpperCase();
        let tag = '[PRE-DISPATCH EDIT]';
        if (normType.includes('SIZE')) tag = '[PRE-DISPATCH SIZE CHANGE]';
        else if (normType.includes('ADDRESS')) tag = '[PRE-DISPATCH ADDRESS CHANGE]';
        else if (normType.includes('CANCEL')) tag = '[PRE-DISPATCH CANCEL]';

        let editSummary = details || '';
        if (newSize) editSummary = 'Requested New Size: ' + newSize + (details ? ' (' + details + ')' : '');
        if (updatedAddress) editSummary = 'Updated Delivery Address: ' + updatedAddress + (pincode ? ' [PIN: ' + pincode + ']' : '');

        const ticketMessage = tag + ' Order #' + cleanOrderId + ': ' + editSummary;

        const customerName = name || (orderRow && orderRow.customer_name) || 'Customer';
        const customerPhone = phone || (orderRow && orderRow.customer_phone) || '';

        const result = await createWidgetTicket({
            name: customerName,
            phone: customerPhone,
            email: email || '',
            message: ticketMessage,
            orderId: cleanOrderId,
            source: source || 'website',
            sessionId,
            visitorId
        });

        // Best effort: update notes or mark store_shoppers record if exists
        try {
            await dbAdapter.query(
                `UPDATE store_shoppers SET notes = COALESCE(notes || ' | ', '') || ? WHERE order_id = ? OR order_id = ?`,
                [ticketMessage, cleanOrderId, '#' + cleanOrderId]
            );
        } catch (e) {}

        res.json({
            success: true,
            dispatched: false,
            ticketNumber: result.ticketNumber,
            whatsappLink: result.whatsappLink,
            orderId: cleanOrderId,
            type: normType,
            message: 'Your ' + normType + ' request has been recorded. Our fulfillment team will apply this change before shipping.'
        });
    } catch (error) {
        console.error('[widget] edit-request error:', error.message);
        res.status(500).json({ error: 'Failed to process edit request' });
    }
});

// ---------- POST /api/widget/ticket ----------
// Create a support ticket from the widget (escalation)

router.post('/ticket', async (req, res) => {
    try {
        const { name, phone, email, message, orderId, source, sessionId, visitorId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const result = await createWidgetTicket({ name, phone, email, message, orderId, source, sessionId, visitorId });

        res.json({
            success: true,
            ticketNumber: result.ticketNumber,
            whatsappLink: result.whatsappLink
        });
    } catch (error) {
        console.error('[widget] ticket error:', error.message);
        res.status(500).json({ error: 'Failed to create support ticket. Please try again.' });
    }
});

// Helper: Enrich return/exchange requests with rich SOP status explanations and next steps
function enrichRequestStatus(r) {
    const rawStatus = (r.status || 'pending').toLowerCase();
    let stage = 'pending_approval';
    let statusLabel = 'Under Review';
    let statusClass = 'oftb-return-pending';
    let explanation = 'Your request is currently being reviewed by our quality team (processed within 24 to 48 hours).';
    let nextStep = 'Please keep the item unwashed, unused, and with original brand tags attached.';

    if (rawStatus.includes('pickup_schedul') || rawStatus.includes('scheduled')) {
        stage = 'pickup_scheduled';
        statusLabel = 'Pickup Scheduled';
        statusClass = 'oftb-return-scheduled';
        const dateStr = r.pickup_scheduled_date ? new Date(r.pickup_scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
        explanation = 'Reverse pickup has been scheduled' + (dateStr ? ' for ' + dateStr : '') + '.';
        nextStep = 'Please hand over the securely packed parcel with brand tags intact to the pickup executive.';
    } else if (rawStatus.includes('approv')) {
        stage = 'approved';
        statusLabel = 'Approved';
        statusClass = 'oftb-return-approved';
        explanation = 'Your request has been approved! A courier pickup executive will be assigned within 2 to 3 business days.';
        nextStep = 'Pack the garment with all brand tags intact. The agent will verify tags during pickup.';
    } else if (rawStatus.includes('in_transit') || rawStatus.includes('picked') || rawStatus.includes('shipped')) {
        stage = 'in_transit';
        statusLabel = 'In Transit to Warehouse';
        statusClass = 'oftb-return-transit';
        explanation = 'The courier has collected your package. It is currently in transit to our fulfillment center for quality inspection.';
        nextStep = 'Quality check takes 24 to 48 hours after parcel arrival at our warehouse.';
    } else if (rawStatus.includes('complete') || rawStatus.includes('refund')) {
        stage = 'completed';
        statusLabel = r.type === 'exchange' ? 'Exchange Dispatched' : 'Refund Completed';
        statusClass = 'oftb-return-completed';
        explanation = r.type === 'exchange'
            ? 'Your exchange order has been confirmed and dispatched!'
            : ('Return processed! ' + (r.refund_amount ? 'Refund amount of ₹' + r.refund_amount + ' credited. ' : '') + 'Store credit code has been issued and sent to your registered contact.');
        nextStep = 'Thank you for shopping with OFFCOMFRT.';
    } else if (rawStatus.includes('reject') || rawStatus.includes('denied') || rawStatus.includes('cancel')) {
        stage = 'rejected';
        statusLabel = 'Request Rejected';
        statusClass = 'oftb-return-rejected';
        explanation = r.rejection_reason || 'This request could not be approved per policy (e.g. reported beyond the 2-day delivery window or missing mandatory proof).';
        nextStep = 'If you believe this was an error, please contact our support team for a manual case review.';
    }

    return {
        ...r,
        stage,
        status_label: statusLabel,
        status_class: statusClass,
        explanation,
        next_step: nextStep
    };
}

// ---------- POST /api/widget/track-request ----------
// Track return/exchange requests from external returns server + local tables

router.post('/track-request', async (req, res) => {
    try {
        const { orderId, requestId } = req.body;
        if (!orderId && !requestId) {
            return res.status(400).json({ error: 'Order ID or Request ID is required' });
        }

        const { dbAdapter } = require('../database/db');

        // --- Request ID lookup (REQ-XXXX) ---
        if (requestId) {
            const reqId = String(requestId).trim().toUpperCase();
            const bareId = reqId.replace(/^REQ-/, '');

            // Check local returns table
            const returnRows = await dbAdapter.query(
                `SELECT return_id, order_id, reason, status, pickup_scheduled_date, refund_amount, created_at
                 FROM returns WHERE return_id = ? OR return_id = ? ORDER BY created_at DESC LIMIT 5`,
                [reqId, bareId]
            );
            // Check local exchanges table
            const exchangeRows = await dbAdapter.query(
                `SELECT exchange_id, order_id, reason, status, pickup_scheduled_date, created_at
                 FROM exchanges WHERE exchange_id = ? OR exchange_id = ? ORDER BY created_at DESC LIMIT 5`,
                [reqId, bareId]
            );

            const localReturns = returnRows.map(r => ({
                request_id: r.return_id,
                order_number: r.order_id,
                type: 'return',
                status: r.status,
                reason: r.reason,
                pickup_scheduled_date: r.pickup_scheduled_date,
                refund_amount: r.refund_amount,
                items: [],
                created_at: r.created_at
            }));
            const localExchanges = exchangeRows.map(r => ({
                request_id: r.exchange_id,
                order_number: r.order_id,
                type: 'exchange',
                status: r.status,
                reason: r.reason,
                pickup_scheduled_date: r.pickup_scheduled_date,
                items: [],
                created_at: r.created_at
            }));

            // Search the returns system directly. The inventory-open-requests feed is
            // intentionally limited and can omit active exchanges or older requests.
            let externalRequests = [];
            try {
                externalRequests = (await findExternalReturnRequests(reqId)).filter(r => {
                    const externalId = String(r.request_id || '').toUpperCase();
                    return externalId === reqId || externalId === bareId;
                });
            } catch (err) {
                console.warn('[widget] returns server request search failed:', err.message);
            }

            const allRequests = [
                ...externalRequests.map(r => ({
                    request_id: r.request_id,
                    order_number: r.order_number,
                    type: r.type,
                    status: r.status,
                    reason: r.reason || null,
                    items: Array.isArray(r.items) ? r.items : [],
                    created_at: r.created_at
                })),
                ...localReturns,
                ...localExchanges
            ];

            // Deduplicate by request_id
            const seen = new Set();
            const deduped = allRequests.filter(r => {
                const key = String(r.request_id).toUpperCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            const enriched = deduped.map(enrichRequestStatus);

            return res.json({
                requestId: reqId,
                requests: enriched,
                count: enriched.length
            });
        }

        // --- Order ID lookup ---
        const rawOrder = orderId ? String(orderId).trim() : '';
        const orderMatch = rawOrder.match(/#(\d{4,6})/i)
            || rawOrder.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
            || rawOrder.match(/\b(\d{4,6})\b/)
            || rawOrder.match(/(\d{4,6})/);
        const cleanOrderId = orderMatch ? orderMatch[1] : rawOrder.replace(/^#/, '').trim();

        // Search by order number rather than using the limited inventory feed.
        // This includes active, completed, and historical portal requests.
        let requests = [];
        try {
            requests = (await findExternalReturnRequests(cleanOrderId)).filter(r =>
                String(r.order_number || '').replace(/^#/, '').trim() === cleanOrderId
            );
        } catch (err) {
            console.warn('[widget] returns server request search failed:', err.message);
        }

        // Check local tables — match with and without # prefix
        const returnRows = await dbAdapter.query(
            `SELECT return_id, order_id, reason, status, pickup_scheduled_date, refund_amount, created_at
             FROM returns WHERE (order_id = ? OR order_id = ? OR order_id LIKE ?) ORDER BY created_at DESC LIMIT 5`,
            [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`]
        );
        const exchangeRows = await dbAdapter.query(
            `SELECT exchange_id, order_id, reason, status, pickup_scheduled_date, created_at
             FROM exchanges WHERE (order_id = ? OR order_id = ? OR order_id LIKE ?) ORDER BY created_at DESC LIMIT 5`,
            [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`]
        );

        const localReturns = returnRows.map(r => ({
            request_id: r.return_id,
            order_number: r.order_id,
            type: 'return',
            status: r.status,
            reason: r.reason,
            pickup_scheduled_date: r.pickup_scheduled_date,
            refund_amount: r.refund_amount,
            items: [],
            created_at: r.created_at
        }));
        const localExchanges = exchangeRows.map(r => ({
            request_id: r.exchange_id,
            order_number: r.order_id,
            type: 'exchange',
            status: r.status,
            reason: r.reason,
            pickup_scheduled_date: r.pickup_scheduled_date,
            items: [],
            created_at: r.created_at
        }));

        const allRequests = [
            ...requests.map(r => ({
                request_id: r.request_id,
                order_number: r.order_number,
                type: r.type,
                status: r.status,
                reason: r.reason || null,
                items: Array.isArray(r.items) ? r.items : [],
                created_at: r.created_at
            })),
            ...localReturns,
            ...localExchanges
        ];

        // Deduplicate by request_id
        const seen = new Set();
        const deduped = allRequests.filter(r => {
            const key = String(r.request_id || '').toUpperCase() + '|' + (r.order_number || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const enriched = deduped.map(enrichRequestStatus);

        res.json({
            orderId: cleanOrderId,
            requests: enriched,
            count: enriched.length
        });
    } catch (error) {
        console.error('[widget] track-request error:', error.message);
        res.status(500).json({ error: 'Failed to fetch request data' });
    }
});

// ---------- GET /api/widget/poll ----------
// Widget polls this to check for admin override messages since a given message ID.
// Returns any new messages (admin or otherwise) the widget hasn't seen yet.

router.get('/poll', async (req, res) => {
    try {
        const { sessionId, afterId } = req.query;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required' });
        }

        const { dbAdapter } = require('../database/db');
        let query = 'SELECT id, sender, content, created_at FROM widget_chats WHERE session_id = $1';
        const params = [sessionId];

        if (afterId) {
            query += ' AND id > $2';
            params.push(parseInt(afterId) || 0);
        }
        query += ' ORDER BY created_at ASC LIMIT 20';

        const messages = await dbAdapter.query(query, params);

        // Also check if admin is active on this session
        const sessRows = await dbAdapter.query(
            'SELECT admin_active FROM widget_chat_sessions WHERE session_id = $1',
            [sessionId]
        );
        const adminActive = sessRows?.[0]?.admin_active || false;

        res.json({ messages: messages || [], adminActive });
    } catch (error) {
        console.error('[widget] poll error:', error.message);
        res.status(500).json({ error: 'Poll failed' });
    }
});

module.exports = router;
