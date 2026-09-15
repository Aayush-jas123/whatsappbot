/**
 * Order Intelligence Service
 * 
 * Consolidates complete order data from all available sources:
 *  1. Shopify Admin API (live order, line items, SKU, variant, financial & fulfillment status, discounts)
 *  2. Shoppers Hub (store_shoppers table: confirmation status, delivery type, customer edit messages, items_json)
 *  3. Shipping Module (shipments table: carrier, courier, AWB, label, pickup)
 *  4. Bot Orders cache (orders table: AWB, status, delivery date)
 *  5. Live Carrier Tracking (Delhivery, Shiprocket, Ekart via carrier adapters)
 *  6. Returns & Exchanges (returns & exchanges tables: status, pickup date, refund)
 *  7. Support Tickets (support_tickets table: related tickets)
 * 
 * Analyzes differences between original order and edits (e.g., size changes, address changes).
 * Returns a normalized, verified order object with zero hallucinations.
 */

const axios = require('axios');
const { dbAdapter } = require('../database/db');
const { extractItemSize } = require('../utils/orderItems');

// Extract color from item or variant string
function extractItemColor(item) {
    if (!item) return null;
    const explicit = item.color || item.variant_color || item.product_color;
    if (explicit) return String(explicit).trim();

    const variant = String(item.variant_title || item.variant || '').trim();
    if (!variant || ['default title', 'default', 'title'].includes(variant.toLowerCase())) return null;

    const labelled = variant.match(/colou?r\s*[:\-]\s*([^/|,]+)/i);
    if (labelled) return labelled[1].trim();

    const parts = variant.split(/\s*[/|]\s*/);
    if (parts.length > 1) {
        const SIZE_TOKEN = /\b(XXXS|XXS|XS|S|M|L|XL|2XL|XXL|3XL|XXXL|4XL|5XL|FREE SIZE|ONE SIZE)\b/i;
        for (const p of parts) {
            const cleanP = p.trim();
            if (!SIZE_TOKEN.test(cleanP) && isNaN(Number(cleanP))) {
                return cleanP;
            }
        }
    }
    return null;
}

// Clean order ID: extract both bare number and hashed format
function normalizeOrderId(rawOrderId) {
    if (!rawOrderId) return { bare: '', formatted: '' };
    const str = String(rawOrderId).trim();
    // Strip URL prefixes if full order status URL was pasted
    const match = str.match(/#?(\d{4,8})/);
    const bare = match ? match[1] : str.replace(/^#/, '').trim();
    const formatted = `#${bare}`;
    return { bare, formatted };
}

// Safely parse JSON
function safeJsonParse(data, fallback = null) {
    if (!data) return fallback;
    if (typeof data === 'object') return data;
    try {
        return JSON.parse(data);
    } catch {
        return fallback;
    }
}

/**
 * Fetch live order from Shopify Admin API
 */
async function fetchShopifyOrder(bareId, formattedId) {
    const shop = process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP_URL;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!shop || !token) {
        return { configured: false, order: null, error: 'Shopify credentials not configured in environment' };
    }

    const cleanShop = shop.replace(/^https?:\/\//, '').replace('.myshopify.com', '');
    const baseUrl = `https://${cleanShop}.myshopify.com/admin/api/2024-01`;
    const fields = 'id,name,order_number,created_at,cancelled_at,cancel_reason,financial_status,fulfillment_status,total_price,subtotal_price,total_discounts,total_tax,currency,discount_applications,discount_codes,payment_gateway_names,customer,shipping_address,billing_address,line_items,fulfillments,note,tags';

    try {
        // Query by order name (e.g. name=42000 or name=%2342000)
        let response = await axios.get(`${baseUrl}/orders.json`, {
            params: { name: bareId, status: 'any', fields },
            headers: { 'X-Shopify-Access-Token': token },
            timeout: 10000
        });

        let orders = response.data?.orders || [];
        if (!orders.length && bareId !== formattedId) {
            response = await axios.get(`${baseUrl}/orders.json`, {
                params: { name: formattedId, status: 'any', fields },
                headers: { 'X-Shopify-Access-Token': token },
                timeout: 10000
            });
            orders = response.data?.orders || [];
        }

        // If not found by name and bareId is long numeric ID, try direct ID lookup
        if (!orders.length && bareId.length >= 8 && /^\d+$/.test(bareId)) {
            try {
                const singleRes = await axios.get(`${baseUrl}/orders/${bareId}.json`, {
                    params: { fields },
                    headers: { 'X-Shopify-Access-Token': token },
                    timeout: 10000
                });
                if (singleRes.data?.order) {
                    orders = [singleRes.data.order];
                }
            } catch (e) {
                // ignore 404
            }
        }

        if (orders.length > 0) {
            return { configured: true, order: orders[0], error: null };
        }
        return { configured: true, order: null, error: null };
    } catch (err) {
        console.warn(`[OrderIntelligence] Shopify fetch failed for ${formattedId}:`, err.message);
        return { configured: true, order: null, error: err.message };
    }
}

/**
 * Fetch Shoppers Hub record from store_shoppers table
 */
async function fetchShopperRecord(bareId, formattedId) {
    try {
        const rows = await dbAdapter.query(
            `SELECT * FROM store_shoppers 
             WHERE order_id = ? OR order_id = ? OR order_id LIKE ? 
             ORDER BY id DESC LIMIT 1`,
            [bareId, formattedId, `%${bareId}`]
        );
        return rows?.[0] || null;
    } catch (err) {
        console.warn('[OrderIntelligence] store_shoppers query error:', err.message);
        return null;
    }
}

/**
 * Fetch confirmation send log from shopper_confirmations
 */
async function fetchConfirmationLog(bareId, formattedId) {
    try {
        const rows = await dbAdapter.query(
            `SELECT sent_at FROM shopper_confirmations 
             WHERE order_id = ? OR order_id = ? 
             ORDER BY id DESC LIMIT 1`,
            [bareId, formattedId]
        );
        return rows?.[0]?.sent_at || null;
    } catch {
        return null;
    }
}

/**
 * Fetch shipment record from shipments table
 */
async function fetchShipmentRecord(bareId, formattedId) {
    try {
        const rows = await dbAdapter.query(
            `SELECT * FROM shipments 
             WHERE order_id = ? OR order_id = ? 
             ORDER BY CASE WHEN status NOT IN ('cancelled', 'failed') THEN 0 ELSE 1 END, id DESC 
             LIMIT 1`,
            [bareId, formattedId]
        );
        return rows?.[0] || null;
    } catch {
        return null;
    }
}

/**
 * Fetch cached order record from orders table
 */
async function fetchOrdersTableRecord(bareId, formattedId) {
    try {
        const rows = await dbAdapter.query(
            `SELECT * FROM orders 
             WHERE order_id = ? OR order_id = ? 
             ORDER BY id DESC LIMIT 1`,
            [bareId, formattedId]
        );
        return rows?.[0] || null;
    } catch {
        return null;
    }
}

/**
 * Fetch returns and exchanges for this order
 */
async function fetchReturnsAndExchanges(bareId, formattedId, customerPhone) {
    const results = { returns: [], exchanges: [] };
    const orderClauses = ['order_id = ?', 'order_id = ?', 'order_id LIKE ?'];
    const params = [bareId, formattedId, `%${bareId}`];

    if (customerPhone) {
        const digits = String(customerPhone).replace(/\D/g, '').slice(-10);
        if (digits.length === 10) {
            orderClauses.push('customer_phone LIKE ?');
            params.push(`%${digits}`);
        }
    }

    const where = orderClauses.join(' OR ');

    try {
        results.returns = await dbAdapter.query(
            `SELECT return_id, order_id, reason, status, pickup_scheduled_date, refund_amount, refund_status, created_at, updated_at 
             FROM returns WHERE ${where} ORDER BY id DESC LIMIT 3`,
            params
        );
    } catch {}

    try {
        results.exchanges = await dbAdapter.query(
            `SELECT exchange_id, order_id, old_items, new_items, reason, status, price_difference, payment_status, pickup_scheduled_date, created_at, updated_at 
             FROM exchanges WHERE ${where} ORDER BY id DESC LIMIT 3`,
            params
        );
    } catch {}

    return results;
}

/**
 * Fetch support tickets for this order or customer
 */
async function fetchSupportTickets(bareId, formattedId, customerPhone) {
    try {
        const clauses = ['message ILIKE ?', 'message ILIKE ?'];
        const params = [`%${bareId}%`, `%${formattedId}%`];

        if (customerPhone) {
            const digits = String(customerPhone).replace(/\D/g, '').slice(-10);
            if (digits.length === 10) {
                clauses.push('customer_phone LIKE ?');
                params.push(`%${digits}`);
            }
        }

        return await dbAdapter.query(
            `SELECT id, ticket_number, customer_name, customer_phone, message, status, created_at 
             FROM support_tickets 
             WHERE ${clauses.join(' OR ')} 
             ORDER BY id DESC LIMIT 3`,
            params
        );
    } catch {
        return [];
    }
}

/**
 * Fetch live carrier tracking for an AWB
 */
async function fetchCarrierTracking(awb, preferredCarrier = null) {
    if (!awb) return null;
    try {
        const { getAdapter, getConfiguredCarriers } = require('./carriers');
        const carriersToTry = preferredCarrier ? [preferredCarrier] : [];
        for (const c of getConfiguredCarriers()) {
            if (!carriersToTry.includes(c.key)) carriersToTry.push(c.key);
        }

        for (const key of carriersToTry) {
            try {
                const adapter = getAdapter(key);
                if (!adapter || !adapter.isConfigured()) continue;
                const result = await adapter.track(awb);
                if (result && result.success !== false) {
                    return {
                        carrier: key,
                        data: result.data || result
                    };
                }
            } catch {}
        }
    } catch {}
    return null;
}

/**
 * Analyze edits between original order and Shoppers Hub / customer messages
 */
function analyzeEdits({ shopifyOrder, shopperRecord, supportTickets }) {
    let hasEdits = false;
    let originalSize = null;
    let changedSize = null;
    let originalItems = [];
    let currentItems = [];
    let customerRequests = [];
    let editSummaries = [];

    // 1. Original items from Shopify
    if (shopifyOrder && Array.isArray(shopifyOrder.line_items) && shopifyOrder.line_items.length > 0) {
        originalItems = shopifyOrder.line_items.map(li => ({
            title: li.title || li.name,
            sku: li.sku || null,
            variant: li.variant_title || null,
            size: extractItemSize(li),
            color: extractItemColor(li),
            quantity: li.quantity,
            price: parseFloat(li.price) || 0
        }));
        if (originalItems[0]?.size) {
            originalSize = originalItems[0].size;
        }
    }

    // 2. Hub items from store_shoppers (items_json)
    const hubItemsJson = safeJsonParse(shopperRecord?.items_json);
    if (Array.isArray(hubItemsJson) && hubItemsJson.length > 0) {
        currentItems = hubItemsJson.map(item => ({
            title: item.title || item.name || item.product_name,
            sku: item.sku || null,
            variant: item.variant_title || item.variant || null,
            size: extractItemSize(item),
            color: extractItemColor(item),
            quantity: item.quantity || 1,
            price: parseFloat(item.price || item.unit_price) || 0
        }));
        if (currentItems[0]?.size) {
            changedSize = currentItems[0].size;
        }
    } else if (originalItems.length > 0) {
        currentItems = originalItems;
    }

    // Compare original size vs changed size
    if (originalSize && changedSize && originalSize.toUpperCase() !== changedSize.toUpperCase()) {
        hasEdits = true;
        editSummaries.push(`Size changed from ${originalSize} to ${changedSize}`);
    }

    // 3. Customer message from store_shoppers (e.g. captured during "Edit Details" WhatsApp flow)
    const custMsg = shopperRecord?.customer_message?.trim();
    if (custMsg) {
        customerRequests.push(custMsg);
        hasEdits = true;

        // Try extracting size request from customer message (e.g. "change size to L", "size XL please")
        const sizeMatch = custMsg.match(/(?:change\s*size\s*(?:to)?|size)\s*[:\-]?\s*(XXXS|XXS|XS|S|M|L|XL|2XL|XXL|3XL|XXXL|4XL|5XL)/i);
        if (sizeMatch && sizeMatch[1]) {
            const requestedSize = sizeMatch[1].toUpperCase();
            if (!changedSize || changedSize.toUpperCase() !== requestedSize) {
                if (!originalSize && changedSize) originalSize = changedSize;
                changedSize = requestedSize;
            }
            editSummaries.push(`Customer requested size change to ${requestedSize} via WhatsApp message`);
        } else {
            editSummaries.push(`Customer requested edit: "${custMsg.length > 100 ? custMsg.substring(0, 100) + '…' : custMsg}"`);
        }
    }

    // Check status in store_shoppers
    if (shopperRecord?.status === 'edit_requested') {
        hasEdits = true;
        if (!editSummaries.length) {
            editSummaries.push('Order status is marked "edit_requested" in Shoppers Hub');
        }
    }

    // 4. Address edits (compare Shopify shipping address vs Shoppers Hub address)
    if (shopifyOrder?.shipping_address && shopperRecord?.address) {
        const shopifyAddr = `${shopifyOrder.shipping_address.address1 || ''} ${shopifyOrder.shipping_address.city || ''} ${shopifyOrder.shipping_address.zip || ''}`.trim().toLowerCase();
        const hubAddr = `${shopperRecord.address || ''} ${shopperRecord.city || ''} ${shopperRecord.zip || ''}`.trim().toLowerCase();
        if (shopifyAddr && hubAddr && shopifyAddr !== hubAddr) {
            hasEdits = true;
            editSummaries.push(`Shipping address updated in Shoppers Hub (New: ${shopperRecord.address}, ${shopperRecord.city} ${shopperRecord.zip})`);
        }
    }

    return {
        hasEdits,
        originalSize: originalSize || null,
        changedSize: changedSize || null,
        originalItems,
        currentItems: currentItems.length > 0 ? currentItems : originalItems,
        customerRequests,
        editSummary: editSummaries.length > 0 ? editSummaries.join('; ') : 'None'
    };
}

/**
 * Main Order Intelligence Investigator
 * 
 * @param {string} orderId - Order ID or number (e.g. "12345" or "#12345")
 * @returns {Promise<object>} Consolidated order intelligence object
 */
async function investigateOrder(orderId) {
    const { bare, formatted } = normalizeOrderId(orderId);
    if (!bare) {
        return {
            found: false,
            error: 'Order ID is required (e.g. "#12345" or "12345")'
        };
    }

    // 1. Concurrently fetch data from all internal and external sources
    const [
        shopifyRes,
        shopperRecord,
        confirmationSentAt,
        shipmentRecord,
        ordersTableRecord
    ] = await Promise.all([
        fetchShopifyOrder(bare, formatted),
        fetchShopperRecord(bare, formatted),
        fetchConfirmationLog(bare, formatted),
        fetchShipmentRecord(bare, formatted),
        fetchOrdersTableRecord(bare, formatted)
    ]);

    const shopifyOrder = shopifyRes.order;

    // If nothing found across Shopify, Shoppers Hub, Shipments, or Orders table
    if (!shopifyOrder && !shopperRecord && !shipmentRecord && !ordersTableRecord) {
        return {
            found: false,
            orderId: formatted,
            error: `Order ${formatted} not found in any system (Shopify, Shoppers Hub, Shipments, or Orders database).`,
            sourcesChecked: {
                shopify: shopifyRes.configured ? 'Not found' : 'Not configured',
                shoppersHub: 'Not found',
                shipments: 'Not found',
                ordersCache: 'Not found'
            }
        };
    }

    // Customer phone identification for secondary lookups
    const customerPhone = 
        shopperRecord?.phone ||
        shopifyOrder?.customer?.phone ||
        shopifyOrder?.shipping_address?.phone ||
        ordersTableRecord?.customer_phone ||
        null;

    // 2. Fetch secondary data: returns, exchanges, support tickets, and live carrier tracking
    const [returnsAndExchanges, supportTickets] = await Promise.all([
        fetchReturnsAndExchanges(bare, formatted, customerPhone),
        fetchSupportTickets(bare, formatted, customerPhone)
    ]);

    // Determine AWB and carrier
    const awb = shipmentRecord?.awb || ordersTableRecord?.awb || shopifyOrder?.fulfillments?.[0]?.tracking_number || null;
    const carrierName = shipmentRecord?.carrier || shipmentRecord?.courier_name || ordersTableRecord?.courier_name || shopifyOrder?.fulfillments?.[0]?.tracking_company || null;

    let carrierTracking = null;
    if (awb) {
        carrierTracking = await fetchCarrierTracking(awb, shipmentRecord?.carrier);
    }

    // 3. Analyze edits and discrepancies
    const edits = analyzeEdits({ shopifyOrder, shopperRecord, supportTickets });

    // 4. Normalize Customer Information
    const customer = {
        name: shopperRecord?.name || (shopifyOrder?.customer ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim() : null) || 'Customer',
        phone: customerPhone,
        email: shopperRecord?.email || shopifyOrder?.customer?.email || shopifyOrder?.email || null,
        shippingAddress: {
            address1: shopperRecord?.address || shopifyOrder?.shipping_address?.address1 || null,
            city: shopperRecord?.city || shopifyOrder?.shipping_address?.city || null,
            province: shopperRecord?.province || shopifyOrder?.shipping_address?.province || null,
            zip: shopperRecord?.zip || shopifyOrder?.shipping_address?.zip || null,
            country: shopperRecord?.country || shopifyOrder?.shipping_address?.country || 'India'
        }
    };

    // 5. Normalize Payment Information
    const rawPaymentMethod = shopperRecord?.payment_method || ordersTableRecord?.payment_method || shopifyOrder?.payment_gateway_names?.[0] || null;
    let paymentMethod = 'Not available';
    if (rawPaymentMethod) {
        const lower = String(rawPaymentMethod).toLowerCase();
        if (lower.includes('cod') || lower.includes('cash')) paymentMethod = 'COD';
        else if (lower.includes('prepaid') || lower.includes('razorpay') || lower.includes('gokwik') || lower.includes('upi') || lower.includes('card')) paymentMethod = 'Prepaid';
        else paymentMethod = rawPaymentMethod;
    }

    const totalAmount = parseFloat(shopperRecord?.order_total || ordersTableRecord?.total || shopifyOrder?.total_price || 0);
    const discountsApplied = [];
    if (shopifyOrder?.discount_codes && Array.isArray(shopifyOrder.discount_codes)) {
        for (const dc of shopifyOrder.discount_codes) {
            discountsApplied.push({ code: dc.code, amount: parseFloat(dc.amount) || 0 });
        }
    }
    const totalDiscountAmount = parseFloat(shopifyOrder?.total_discounts || 0);

    const payment = {
        method: paymentMethod,
        financialStatus: shopifyOrder?.financial_status || (paymentMethod === 'Prepaid' ? 'paid' : 'pending'),
        gateway: shopifyOrder?.payment_gateway_names?.join(', ') || rawPaymentMethod || null,
        total: totalAmount,
        currency: shopifyOrder?.currency || 'INR',
        discount: {
            totalDiscount: totalDiscountAmount,
            codes: discountsApplied.length > 0 ? discountsApplied : null
        },
        source: shopifyOrder ? 'Shopify' : (shopperRecord ? 'Shoppers Hub' : 'Orders DB')
    };

    // 6. Normalize Products & Line Items
    let products = [];
    if (edits.currentItems && edits.currentItems.length > 0) {
        products = edits.currentItems;
    } else if (shopifyOrder?.line_items && shopifyOrder.line_items.length > 0) {
        products = shopifyOrder.line_items.map(li => ({
            title: li.title || li.name,
            sku: li.sku || 'N/A',
            variant: li.variant_title || 'Standard',
            size: extractItemSize(li) || 'Not specified',
            color: extractItemColor(li) || 'Not specified',
            quantity: li.quantity,
            price: parseFloat(li.price) || 0
        }));
    } else if (ordersTableRecord?.product_name) {
        products = [{
            title: ordersTableRecord.product_name,
            sku: 'N/A',
            variant: 'Standard',
            size: 'Not specified',
            color: 'Not specified',
            quantity: 1,
            price: totalAmount
        }];
    }

    // 7. Confirmation Status
    const confirmation = {
        status: shopperRecord?.status || 'Not confirmed via Shoppers Hub',
        confirmedBy: shopperRecord?.confirmed_by || (shopperRecord?.status === 'confirmed' ? 'customer' : null),
        sentAt: confirmationSentAt || null,
        deliveryType: shopperRecord?.delivery_type || 'Standard',
        source: shopperRecord ? 'Shoppers Hub' : 'N/A'
    };

    // 8. Shipment & Courier Status
    const isDelivered = Boolean(
        ordersTableRecord?.delivered_at ||
        ordersTableRecord?.status?.toLowerCase().includes('delivered') ||
        shipmentRecord?.status?.toLowerCase().includes('delivered') ||
        carrierTracking?.data?.status?.toLowerCase().includes('delivered')
    );

    const hasShipped = Boolean(
        awb ||
        shipmentRecord ||
        shopifyOrder?.fulfillment_status === 'fulfilled' ||
        (ordersTableRecord?.status && ['shipped', 'in_transit', 'out_for_delivery', 'delivered'].includes(ordersTableRecord.status.toLowerCase()))
    );

    let deliveryStatus = 'Not shipped yet';
    if (isDelivered) {
        deliveryStatus = 'Delivered';
    } else if (carrierTracking?.data?.status) {
        deliveryStatus = carrierTracking.data.status;
    } else if (shipmentRecord?.status) {
        deliveryStatus = shipmentRecord.status;
    } else if (ordersTableRecord?.status) {
        deliveryStatus = ordersTableRecord.status;
    } else if (hasShipped) {
        deliveryStatus = 'Shipped / In Transit';
    }

    const shipment = {
        hasShipped,
        carrier: carrierName || (hasShipped ? 'Pending Assignment' : null),
        courierName: shipmentRecord?.courier_name || ordersTableRecord?.courier_name || carrierName || null,
        awb: awb || null,
        status: shipmentRecord?.status || ordersTableRecord?.status || (hasShipped ? 'shipped' : 'unshipped'),
        deliveryStatus,
        expectedDelivery: ordersTableRecord?.expected_delivery || null,
        deliveredAt: ordersTableRecord?.delivered_at || null,
        trackingUrl: shipmentRecord?.tracking_url || ordersTableRecord?.tracking_url || (awb ? `https://track.delhivery.com/p/${awb}` : null),
        latestCarrierScan: carrierTracking?.data?.scans?.[0] || carrierTracking?.data?.latestEvent || null,
        source: shipmentRecord ? 'Shoppers Hub Shipments' : (ordersTableRecord ? 'Orders DB' : (shopifyOrder ? 'Shopify' : 'N/A'))
    };

    // 9. Cancellation Status
    const isCancelled = Boolean(
        shopperRecord?.status === 'cancelled' ||
        shopperRecord?.shopify_cancelled_at ||
        shopifyOrder?.cancelled_at ||
        ordersTableRecord?.status === 'cancelled' ||
        shipmentRecord?.status === 'cancelled'
    );

    const cancellation = {
        isCancelled,
        cancelledAt: shopperRecord?.shopify_cancelled_at || shopifyOrder?.cancelled_at || null,
        reason: shopperRecord?.cancel_reason || shopifyOrder?.cancel_reason || null,
        refundAmount: shopperRecord?.shopify_refund_amount || null,
        source: isCancelled ? (shopperRecord?.cancel_reason ? 'Shoppers Hub' : 'Shopify') : 'N/A'
    };

    // 10. Returns & Exchanges Status
    const activeReturn = returnsAndExchanges.returns?.[0] || null;
    const activeExchange = returnsAndExchanges.exchanges?.[0] || null;
    const hasReturn = Boolean(activeReturn || activeExchange);

    let returnEligibility = null;
    if (isDelivered) {
        const deliveredDate = new Date(ordersTableRecord?.delivered_at || ordersTableRecord?.updated_at || Date.now());
        const daysSince = (Date.now() - deliveredDate.getTime()) / (1000 * 60 * 60 * 24);
        returnEligibility = {
            eligible: daysSince <= 2,
            daysSinceDelivery: Math.round(daysSince * 10) / 10,
            reason: daysSince <= 2 ? 'Within 2-day policy window' : 'Return window expired (> 2 days since delivery)'
        };
    }

    const returnsInfo = {
        hasReturnOrExchange: hasReturn,
        type: activeExchange ? 'Exchange' : (activeReturn ? 'Return' : null),
        status: activeExchange?.status || activeReturn?.status || null,
        pickupScheduledDate: activeExchange?.pickup_scheduled_date || activeReturn?.pickup_scheduled_date || null,
        refundAmount: activeReturn?.refund_amount || null,
        refundStatus: activeReturn?.refund_status || null,
        reason: activeExchange?.reason || activeReturn?.reason || null,
        eligibility: returnEligibility,
        source: hasReturn ? 'Returns Portal' : 'N/A'
    };

    // 11. Current Issue Detection
    let currentIssue = 'None';
    if (cancellation.isCancelled) {
        currentIssue = `Order Cancelled${cancellation.reason ? ` (${cancellation.reason})` : ''}`;
    } else if (hasReturn) {
        currentIssue = `${returnsInfo.type} request active: ${returnsInfo.status} (Reason: ${returnsInfo.reason || 'N/A'})`;
    } else if (shopperRecord?.rto_risk === 'high' || shopperRecord?.rto_risk === true) {
        currentIssue = 'High RTO Risk flagged in Shoppers Hub';
    } else if (edits.hasEdits && !hasShipped) {
        currentIssue = `Order edits pending dispatch: ${edits.editSummary}`;
    } else if (shopperRecord?.status === 'edit_requested') {
        currentIssue = `Customer requested edit before dispatch: ${edits.customerRequests[0] || 'Check customer message'}`;
    } else if (shipment.status === 'failed' || shipment.deliveryStatus?.toLowerCase().includes('undelivered') || shipment.deliveryStatus?.toLowerCase().includes('rto')) {
        currentIssue = `Delivery exception: ${shipment.deliveryStatus}`;
    }

    // 12. Overall Status
    let overallStatus = 'Processing';
    if (cancellation.isCancelled) overallStatus = 'Cancelled';
    else if (isDelivered) overallStatus = 'Delivered';
    else if (hasShipped) overallStatus = `Shipped (${shipment.deliveryStatus})`;
    else if (shopperRecord?.status === 'confirmed') overallStatus = 'Confirmed (Awaiting Dispatch)';
    else if (shopperRecord?.status === 'edit_requested') overallStatus = 'Edit Requested (Pending Review)';
    else if (shopperRecord?.status) overallStatus = shopperRecord.status;

    return {
        found: true,
        orderId: formatted,
        orderNumber: bare,
        orderDate: shopifyOrder?.created_at || shopperRecord?.created_at || ordersTableRecord?.order_date || null,
        currentStatus: overallStatus,
        currentIssue,
        customer,
        payment,
        products,
        originalOrderDetails: edits.originalItems.length > 0 
            ? edits.originalItems.map(i => `${i.title} (Size: ${i.size || 'N/A'}, Qty: ${i.quantity}, ₹${i.price})`).join(', ')
            : 'Matches current order',
        edits: {
            hasEdits: edits.hasEdits,
            originalSize: edits.originalSize,
            changedSize: edits.changedSize,
            customerRequests: edits.customerRequests,
            summary: edits.editSummary
        },
        confirmation,
        shipment,
        cancellation,
        returns: returnsInfo,
        supportTickets: supportTickets.map(t => ({
            ticketNumber: t.ticket_number,
            message: t.message,
            status: t.status,
            createdAt: t.created_at
        })),
        sourcesChecked: {
            shopify: shopifyOrder ? 'Found (live order details)' : (shopifyRes.error ? `Error: ${shopifyRes.error}` : 'Not found / fallback to DB'),
            shoppersHub: shopperRecord ? 'Found (confirmation, customer messages, edits)' : 'Not found',
            shipments: shipmentRecord ? 'Found (courier booking & AWB)' : 'Not found',
            ordersCache: ordersTableRecord ? 'Found' : 'Not found',
            returnsSystem: hasReturn ? 'Found (active return/exchange)' : 'No return records',
            liveCarrierTracking: carrierTracking ? `Found (${carrierTracking.carrier})` : 'Not available'
        }
    };
}

module.exports = {
    investigateOrder,
    normalizeOrderId,
    extractItemSize,
    extractItemColor
};
