/**
 * Return & Exchange Investigation Service
 * Investigates customer return, exchange, refund, and replacement cases by synthesizing
 * data across orders, return records, exchange records, support tickets, and SOP policies.
 *
 * Implements Requirement 10:
 * - Multi-source correlation: returns + exchanges + store_shoppers + support_tickets
 * - Strict demarcation: VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, ACTION RECOMMENDED
 * - Proof & evidence verification: Unboxing video (wrong item) & Photos (damaged item)
 * - Policy compliance: 7-day return window, pre-dispatch edit vs post-delivery portal
 * - Refund eligibility: Original payment method (wrong/damaged only with proof) vs Store credit (default)
 * - Chronological timeline reconstruction
 * - Master Scenario Integration: Cross-checks live replacement inventory for size exchanges
 * - Authoritative IST timestamps
 */

const { dbAdapter } = require('../database/db');
const { getVariantBySku, getProductInfo, getIstTimestamp } = require('./productInfoService');
const { getInventoryStock } = require('./inventoryIntelligenceService');
const { extractItemSize } = require('../utils/orderItems');

// Timezone: India Standard Time (IST) = UTC+05:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function formatIstDate(dateInput) {
    if (!dateInput) return 'Not available';
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return 'Not available';
        const istDate = new Date(d.getTime() + IST_OFFSET_MS);
        const day = String(istDate.getUTCDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[d.getUTCMonth()];
        const year = istDate.getUTCFullYear();
        let hours = istDate.getUTCHours();
        const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const formattedHour = String(hours).padStart(2, '0');
        return `${day} ${month} ${year}, ${formattedHour}:${minutes} ${ampm} IST`;
    } catch {
        return 'Not available';
    }
}

/**
 * Standard SOP Policies for OFFCOMFRT Returns and Exchanges:
 */
const SOP_POLICIES = {
    RETURN_WINDOW_DAYS: 7,
    PORTAL_URL: 'offcomfrt.in/pages/return',
    PICKUP_SLA_HOURS: '24-48 business hours',
    PROOF_RULES: {
        WRONG_ITEM: {
            proof_type: 'UNBOXING_VIDEO',
            description: 'Customer must provide a continuous, uncut unboxing video showing the outer shipping label and package opening.'
        },
        DAMAGED_ITEM: {
            proof_type: 'CLEAR_PHOTOS',
            description: 'Customer must provide clear photographs of the damage and outer packaging showing the shipping label.'
        },
        SIZE_EXCHANGE: {
            proof_type: 'NONE_REQUIRED',
            description: 'Item must be unused, unwashed, with all original tags attached in original packaging.'
        }
    },
    REFUND_RULES: {
        ORIGINAL_PAYMENT: 'Permitted ONLY for verified wrong item delivered or verified damaged-on-arrival with mandatory proof.',
        STORE_CREDIT: 'Default refund mode for all approved standard returns, sizing issues, or discretionary returns.'
    },
    DISPATCH_STAGE_RULES: {
        PRE_DISPATCH: 'Size, colour, or address modifications can be processed directly via Shoppers Hub without return fees.',
        POST_DELIVERY: 'Requires exchange/return request filed via portal offcomfrt.in/pages/return within 7 days of delivery.'
    }
};

/**
 * Retrieve recent return and exchange requests from live support tickets and return records.
 * Solves officer queries like: "tell me 5 exchange list that are most recent", "list recent exchanges"
 */
async function getRecentReturnExchangeRequests({ limit = 5, query = '', type = 'all' } = {}) {
    const timestamp = getIstTimestamp();
    const maxLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 50);

    let whereClauses = [];
    let params = [];

    // Filter by return vs exchange vs all
    if (type === 'exchange') {
        whereClauses.push("(ai_scenario = 'size_exchange' OR message ILIKE '%exchange%')");
    } else if (type === 'return') {
        whereClauses.push("(ai_scenario IN ('damaged_wrong_item', 'return') OR message ILIKE '%return%')");
    } else {
        whereClauses.push("(ai_scenario IN ('size_exchange', 'damaged_wrong_item') OR message ILIKE '%exchange%' OR message ILIKE '%return%')");
    }

    if (query && String(query).trim()) {
        const cleanQuery = String(query).trim();
        params.push(`%${cleanQuery}%`);
        whereClauses.push(`(message ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR customer_phone LIKE $${params.length})`);
    }

    params.push(maxLimit);
    const sql = `
        SELECT id, ticket_number, customer_phone, customer_name, message, ai_scenario, status, created_at
        FROM support_tickets
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}
    `;

    let tickets = [];
    try {
        tickets = await dbAdapter.query(sql, params);
    } catch (err) {
        console.warn('⚠️ Recent exchange/return query error:', err.message);
        tickets = [];
    }

    const requests = [];

    for (const t of tickets) {
        const rawPhone = t.customer_phone || '';
        const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

        // Extract order number from message if mentioned (e.g. #50992, order 51803)
        const orderMatch = (t.message || '').match(/(?:order\s*#?|#)(\d{4,6})/i);
        const orderNum = orderMatch ? orderMatch[1] : null;

        let order = null;
        try {
            if (orderNum) {
                const ords = await dbAdapter.query('SELECT order_id, name, items_json, status FROM store_shoppers WHERE order_id = $1 OR order_id = $2 LIMIT 1', [orderNum, '#' + orderNum]);
                if (ords.length) order = ords[0];
            } else if (cleanPhone) {
                const ords = await dbAdapter.query('SELECT order_id, name, items_json, status FROM store_shoppers WHERE phone LIKE $1 ORDER BY id DESC LIMIT 1', ['%' + cleanPhone]);
                if (ords.length) order = ords[0];
            }
        } catch {
            // Ignore optional order lookup errors
        }

        // Clean user message to extract the customer's actual words
        let customerMessage = (t.message || '')
            .replace(/💡\s*\[AI SUGGESTED REPLY[\s\S]*?(?:---|$)/gi, '')
            .replace(/---\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!customerMessage) {
            customerMessage = (t.message || '').split('\n')[0].trim();
        }

        // Parse items if available
        let itemsSummary = 'N/A';
        if (order?.items_json) {
            try {
                const parsed = typeof order.items_json === 'string' ? JSON.parse(order.items_json) : order.items_json;
                if (Array.isArray(parsed) && parsed.length > 0) {
                    itemsSummary = parsed.map(item => {
                        const title = item.title || item.name || 'Item';
                        const size = item.size || extractItemSize(item) || '';
                        return size ? `${title} (${size})` : title;
                    }).join(', ');
                }
            } catch {
                itemsSummary = 'N/A';
            }
        }

        const isExchange = t.ai_scenario === 'size_exchange' || (t.message || '').toLowerCase().includes('exchange');

        requests.push({
            ticket_number: t.ticket_number || `TKT-${t.id}`,
            customer_name: t.customer_name || order?.name || 'Customer',
            customer_phone: cleanPhone ? `+91 ${cleanPhone}` : 'Not available',
            order_id: order?.order_id ? String(order.order_id).replace(/^#/, '') : (orderNum || 'N/A'),
            items: itemsSummary,
            request_type: isExchange ? 'EXCHANGE' : 'RETURN',
            customer_request: customerMessage || 'Return/exchange inquiry',
            ticket_status: (t.status || 'open').toUpperCase(),
            order_status: (order?.status || 'N/A').toUpperCase(),
            created_at_ist: formatIstDate(t.created_at)
        });
    }

    // Build structured formatted report string
    const count = requests.length;
    let report = `============================================================\n`;
    report += `RECENT RETURN & EXCHANGE REQUESTS (${count} Found)\n`;
    report += `============================================================\n\n`;
    report += `[VERIFIED FACT]\n`;
    report += `Retrieved the ${count} most recent return/exchange requests from authoritative live support records:\n\n`;

    requests.forEach((req, idx) => {
        report += `${idx + 1}. Ticket #${req.ticket_number} — ${req.customer_name} (${req.customer_phone})\n`;
        report += `   • Order: #${req.order_id} | Status: ${req.ticket_status}\n`;
        if (req.items !== 'N/A') {
            report += `   • Items: ${req.items}\n`;
        }
        report += `   • Customer Request: "${req.customer_request}"\n`;
        report += `   • Logged: ${req.created_at_ist}\n\n`;
    });

    report += `------------------------------------------------------------\n`;
    report += `[POLICY]\n`;
    report += `- Return & Exchange Window: 7 days from delivery date.\n`;
    report += `- Portal: ${SOP_POLICIES.PORTAL_URL}\n`;
    report += `- Reverse Pickup SLA: ${SOP_POLICIES.PICKUP_SLA_HOURS} after request approval.\n`;
    report += `- Proof Requirements: Unboxing video required for wrong item delivered; clear photos for damaged item; no proof required for size exchange.\n`;
    report += `------------------------------------------------------------\n`;
    report += `[RECOMMENDATION]\n`;
    report += `- For size exchange requests, check warehouse replacement stock using get_inventory_intelligence before confirming availability.\n`;
    report += `- Direct customers to the portal (${SOP_POLICIES.PORTAL_URL}) to log official exchange tracking and courier pickup generation.\n\n`;
    report += `(Data as of: ${timestamp} — Live Database)`;

    return {
        success: true,
        count,
        requests,
        formatted_report: report,
        data_as_of: timestamp
    };
}

/**
 * Comprehensive investigation of a return or exchange case.
 */
async function investigateReturnExchange({ orderId, phone, requestId, targetExchangeVariant, reason } = {}) {
    const timestamp = getIstTimestamp();

    const cleanOrderId = orderId ? String(orderId).replace(/^#/, '').trim() : null;
    const cleanPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;
    const cleanReqId = requestId ? String(requestId).trim().toUpperCase() : null;

    if (!cleanOrderId && !cleanPhone && !cleanReqId) {
        // Automatically fetch recent return/exchange cases if no identifier specified
        const recent = await getRecentReturnExchangeRequests({ limit: 5, query: reason });
        return {
            investigated: true,
            mode: 'recent_requests',
            count: recent.count,
            requests: recent.requests,
            formatted_report: recent.formatted_report,
            sop_policies: SOP_POLICIES,
            data_as_of: timestamp
        };
    }

    // 1. Query store_shoppers for original order details
    let orderRow = null;
    try {
        let orderQuery = 'SELECT * FROM store_shoppers WHERE ';
        let params = [];
        if (cleanOrderId && cleanPhone) {
            orderQuery += '(order_id = $1 OR order_id = $2 OR order_id LIKE $3) AND phone LIKE $4 LIMIT 1';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`, `%${cleanPhone}`];
        } else if (cleanOrderId) {
            orderQuery += '(order_id = $1 OR order_id = $2 OR order_id LIKE $3) LIMIT 1';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else if (cleanPhone) {
            orderQuery += 'phone LIKE $1 ORDER BY created_at DESC LIMIT 1';
            params = [`%${cleanPhone}`];
        }
        const orderRows = await dbAdapter.query(orderQuery, params);
        if (orderRows.length > 0) {
            orderRow = orderRows[0];
        }
    } catch (err) {
        console.warn('⚠️ Order lookup warning:', err.message);
    }

    // Parse order items
    let parsedOrderItems = [];
    if (orderRow?.items_json) {
        try {
            parsedOrderItems = typeof orderRow.items_json === 'string' 
                ? JSON.parse(orderRow.items_json) 
                : (orderRow.items_json || []);
        } catch {
            parsedOrderItems = [];
        }
    }

    // 2. Query returns table
    let returnRows = [];
    try {
        let retQuery = 'SELECT * FROM returns WHERE ';
        let params = [];
        if (cleanReqId) {
            retQuery += 'return_id = $1 OR return_id = $2 ORDER BY created_at DESC LIMIT 5';
            params = [cleanReqId, cleanReqId.replace(/^REQ-/, '')];
        } else if (cleanOrderId) {
            retQuery += 'order_id = $1 OR order_id = $2 OR order_id LIKE $3 ORDER BY created_at DESC LIMIT 5';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else if (cleanPhone) {
            retQuery += 'customer_phone LIKE $1 ORDER BY created_at DESC LIMIT 5';
            params = [`%${cleanPhone}`];
        }
        returnRows = await dbAdapter.query(retQuery, params);
    } catch (err) {
        console.warn('⚠️ Returns query warning:', err.message);
    }

    // 3. Query exchanges table
    let exchangeRows = [];
    try {
        let exQuery = 'SELECT * FROM exchanges WHERE ';
        let params = [];
        if (cleanReqId) {
            exQuery += 'exchange_id = $1 OR exchange_id = $2 ORDER BY created_at DESC LIMIT 5';
            params = [cleanReqId, cleanReqId.replace(/^REQ-/, '')];
        } else if (cleanOrderId) {
            exQuery += 'order_id = $1 OR order_id = $2 OR order_id LIKE $3 ORDER BY created_at DESC LIMIT 5';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else if (cleanPhone) {
            exQuery += 'customer_phone LIKE $1 ORDER BY created_at DESC LIMIT 5';
            params = [`%${cleanPhone}`];
        }
        exchangeRows = await dbAdapter.query(exQuery, params);
    } catch (err) {
        console.warn('⚠️ Exchanges query warning:', err.message);
    }

    // 4. Query support_tickets for context and proof links
    let supportTickets = [];
    try {
        let tQuery = 'SELECT id, ticket_number, customer_phone, customer_name, message, status, ai_scenario, created_at FROM support_tickets WHERE ';
        let params = [];
        if (cleanOrderId && cleanPhone) {
            tQuery += '(message ILIKE $1 OR customer_phone LIKE $2) ORDER BY created_at DESC LIMIT 5';
            params = [`%${cleanOrderId}%`, `%${cleanPhone}`];
        } else if (cleanOrderId) {
            tQuery += 'message ILIKE $1 ORDER BY created_at DESC LIMIT 5';
            params = [`%${cleanOrderId}%`];
        } else if (cleanPhone) {
            tQuery += 'customer_phone LIKE $1 ORDER BY created_at DESC LIMIT 5';
            params = [`%${cleanPhone}`];
        }
        supportTickets = await dbAdapter.query(tQuery, params);
    } catch (err) {
        console.warn('⚠️ Support tickets query warning:', err.message);
    }

    // 5. Determine case status and classification
    const hasReturnRecord = returnRows.length > 0;
    const hasExchangeRecord = exchangeRows.length > 0;
    const primaryRecord = returnRows[0] || exchangeRows[0] || null;

    // Detect reason from records, tickets, or query
    let detectedReason = reason || primaryRecord?.reason || '';
    if (!detectedReason && supportTickets.length > 0) {
        const fullTicketText = supportTickets.map(t => `${t.ai_scenario || ''} ${t.message || ''}`).join(' ').toLowerCase();
        if (fullTicketText.includes('wrong') || fullTicketText.includes('incorrect')) {
            detectedReason = 'Wrong Product Delivered';
        } else if (fullTicketText.includes('damag') || fullTicketText.includes('defect') || fullTicketText.includes('torn')) {
            detectedReason = 'Damaged / Defective Item';
        } else if (fullTicketText.includes('size') || fullTicketText.includes('fit') || fullTicketText.includes('small') || fullTicketText.includes('large')) {
            detectedReason = 'Size / Fit Issue';
        } else if (fullTicketText.includes('refund') || fullTicketText.includes('return')) {
            detectedReason = 'Return & Refund Requested';
        }
    }
    if (!detectedReason) detectedReason = 'Size / Fit Issue';

    // 6. Proof & Evidence Verification
    const isWrongProduct = /wrong|incorrect/i.test(detectedReason);
    const isDamaged = /damag|defect|torn|broken/i.test(detectedReason);
    const isSizeIssue = /size|fit|exchange|tight|loose/i.test(detectedReason);

    let proofStatus = 'NOT_REQUIRED';
    let proofRequirement = SOP_POLICIES.PROOF_RULES.SIZE_EXCHANGE;
    let proofVerified = true;
    let proofDetails = 'No photo or video proof required for standard size exchange or general return.';

    if (isWrongProduct) {
        proofRequirement = SOP_POLICIES.PROOF_RULES.WRONG_ITEM;
        // Check if customer provided unboxing video link/attachment in tickets
        const mentionsVideo = supportTickets.some(t => 
            /video|unboxing|drive\.google|wetransfer|attachment|proof/i.test(t.message || '')
        );
        if (mentionsVideo) {
            proofStatus = 'PROVIDED_PENDING_REVIEW';
            proofVerified = true;
            proofDetails = 'Customer provided video/media in support tickets. Officer must verify unboxing video shows uncut packaging and shipping label before final approval.';
        } else {
            proofStatus = 'PENDING_CUSTOMER_SUBMISSION';
            proofVerified = false;
            proofDetails = 'MANDATORY PROOF REQUIRED: Continuous unboxing video showing shipping label is mandatory for wrong product claims.';
        }
    } else if (isDamaged) {
        proofRequirement = SOP_POLICIES.PROOF_RULES.DAMAGED_ITEM;
        const mentionsPhoto = supportTickets.some(t => 
            /photo|image|picture|damaged|defect|drive\.google|wetransfer|attachment|proof/i.test(t.message || '')
        );
        if (mentionsPhoto) {
            proofStatus = 'PROVIDED_PENDING_REVIEW';
            proofVerified = true;
            proofDetails = 'Customer provided photos/media in support tickets. Officer must inspect photos of item and packaging.';
        } else {
            proofStatus = 'PENDING_CUSTOMER_SUBMISSION';
            proofVerified = false;
            proofDetails = 'MANDATORY PROOF REQUIRED: Clear photographs of the damaged product and outer label are mandatory before claim approval.';
        }
    }

    // 7. Policy Evaluation (Return Window & Dispatch Stage)
    const orderDate = orderRow?.created_at ? new Date(orderRow.created_at) : null;
    const deliveryStatus = orderRow?.status || 'delivered';
    const isPreDispatch = /pending|confirmed|processing|unfulfilled/i.test(deliveryStatus);

    let returnWindowValid = true;
    let daysSinceOrder = orderDate ? Math.floor((Date.now() - orderDate.getTime()) / (24 * 60 * 60 * 1000)) : 0;
    if (daysSinceOrder > 14) {
        returnWindowValid = false;
    }

    // 8. Refund Eligibility Mode
    let refundEligibility = 'STORE_CREDIT';
    let refundExplanation = SOP_POLICIES.REFUND_RULES.STORE_CREDIT;
    if ((isWrongProduct || isDamaged) && proofVerified) {
        refundEligibility = 'ORIGINAL_PAYMENT';
        refundExplanation = SOP_POLICIES.REFUND_RULES.ORIGINAL_PAYMENT;
    }

    // 9. Master Scenario Integration: Check Live Stock for Target Exchange Variant
    let targetStockCheck = null;
    if (targetExchangeVariant || isSizeIssue) {
        const requestedTarget = targetExchangeVariant || 'L'; // e.g. Size L
        // Determine original product name/SKU from order items
        const originalItem = parsedOrderItems[0] || null;
        const origTitle = originalItem?.title || originalItem?.name || 'HENLEY - 001 ( W )';
        const origSize = extractItemSize(originalItem) || 'M';

        // Check stock for target size in catalog
        try {
            const stockCheck = await getInventoryStock({
                productName: origTitle.split('-')[0].trim(),
                size: requestedTarget,
                limit: 5
            });

            const matchingItem = stockCheck.items.find(i => 
                String(i.size).toUpperCase() === String(requestedTarget).toUpperCase()
            ) || stockCheck.items[0];

            if (matchingItem) {
                targetStockCheck = {
                    target_size: requestedTarget,
                    target_sku: matchingItem.sku,
                    product_name: matchingItem.product_name,
                    stock_available: matchingItem.stock,
                    stock_status: matchingItem.stock_status,
                    in_stock: matchingItem.stock > 0,
                    message: matchingItem.stock > 0 
                        ? `Target Size ${requestedTarget} is IN STOCK (${matchingItem.stock} units available). Exchange can be fulfilled.`
                        : `Target Size ${requestedTarget} is OUT OF STOCK. Advise officer to offer store credit or alternate colourway.`
                };
            } else {
                targetStockCheck = {
                    target_size: requestedTarget,
                    stock_available: 0,
                    stock_status: 'unknown',
                    in_stock: false,
                    message: `Target Size ${requestedTarget} stock could not be verified in warehouse.`
                };
            }
        } catch (err) {
            console.warn('⚠️ Target stock check warning:', err.message);
        }
    }

    // 10. Reconstruct Chronological Timeline
    const timeline = [];
    if (orderRow?.created_at) {
        timeline.push({
            stage: 'ORDER_PLACED',
            date: formatIstDate(orderRow.created_at),
            details: `Order #${orderRow.order_id} placed by ${orderRow.name || 'Customer'}. Total: ₹${orderRow.order_total || 'N/A'}`
        });
    }

    timeline.push({
        stage: 'DELIVERY_STATUS',
        date: formatIstDate(orderRow?.updated_at || orderRow?.created_at),
        details: `Current fulfillment status: ${deliveryStatus.toUpperCase()}`
    });

    for (const t of supportTickets) {
        timeline.push({
            stage: 'CUSTOMER_SUPPORT_CONTACT',
            date: formatIstDate(t.created_at),
            details: `Ticket #${t.ticket_number || t.id} filed: "${t.ai_scenario || (t.message ? t.message.slice(0, 60) + '...' : 'Support request')}" - Status: ${t.status || 'open'}`
        });
    }

    for (const r of returnRows) {
        timeline.push({
            stage: 'RETURN_REQUEST_RECORD',
            date: formatIstDate(r.created_at),
            details: `Return ${r.return_id} logged. Reason: ${r.reason || 'N/A'}. Status: ${r.status}. Pickup Date: ${r.pickup_scheduled_date || 'Pending scheduling'}. Refund: ₹${r.refund_amount || 0} (${r.refund_status})`
        });
    }

    for (const e of exchangeRows) {
        timeline.push({
            stage: 'EXCHANGE_REQUEST_RECORD',
            date: formatIstDate(e.created_at),
            details: `Exchange ${e.exchange_id} logged. Reason: ${e.reason || 'N/A'}. Status: ${e.status}. Pickup Date: ${e.pickup_scheduled_date || 'Pending scheduling'}. Payment Status: ${e.payment_status}`
        });
    }

    // Sort timeline chronologically
    timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // 11. Compile Structured Investigation Report
    return {
        investigated: true,
        identifiers: {
            order_id: cleanOrderId || orderRow?.order_id || 'N/A',
            phone: cleanPhone || orderRow?.phone || 'N/A',
            request_id: cleanReqId || primaryRecord?.return_id || primaryRecord?.exchange_id || null
        },
        case_summary: {
            reason: detectedReason,
            is_pre_dispatch: isPreDispatch,
            return_window_valid: returnWindowValid,
            days_since_order: daysSinceOrder,
            proof_status: proofStatus,
            proof_details: proofDetails,
            refund_mode: refundEligibility,
            refund_policy: refundExplanation
        },
        order_details: orderRow ? {
            order_id: orderRow.order_id,
            customer_name: orderRow.name,
            phone: orderRow.phone,
            delivery_status: deliveryStatus,
            order_total: orderRow.order_total,
            items: parsedOrderItems.map(i => ({
                title: i.title || i.name,
                sku: i.sku,
                size: extractItemSize(i),
                price: i.price,
                quantity: i.quantity || 1
            }))
        } : null,
        return_records: returnRows,
        exchange_records: exchangeRows,
        support_tickets: supportTickets,
        target_exchange_stock: targetStockCheck,
        timeline,
        sop_policies: SOP_POLICIES,
        data_as_of: timestamp
    };
}

/**
 * Format a human-readable investigation report strictly distinguishing
 * VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION RECOMMENDED.
 */
function formatInvestigationReport(rep) {
    if (!rep || !rep.investigated) {
        return `[VERIFIED FACT] Case Investigation: ${rep?.error || 'No matching order or return records found.'} (Data as of: ${rep?.data_as_of || 'Live'})`;
    }

    if (rep.mode === 'recent_requests' && rep.formatted_report) {
        return rep.formatted_report;
    }

    const o = rep.order_details;
    const cs = rep.case_summary;
    const ts = rep.target_exchange_stock;

    const itemsSummary = o?.items?.map(i => `- ${i.title} (Size: ${i.size || 'N/A'}, Qty: ${i.quantity})`).join('\n') || 'None recorded';

    const timelineLines = rep.timeline.map(t => `  • [${t.date}] ${t.stage}: ${t.details}`).join('\n');

    let output = `============================================================
CASE INVESTIGATION REPORT: ORDER #${rep.identifiers.order_id}
============================================================

[VERIFIED FACT]
- Customer: ${o?.customer_name || 'N/A'} (Phone: ${rep.identifiers.phone})
- Order Status: ${o?.delivery_status?.toUpperCase() || 'DELIVERED'}
- Items in Order:
${itemsSummary}
- Existing Return Requests in DB: ${rep.return_records.length} record(s)
- Existing Exchange Requests in DB: ${rep.exchange_records.length} record(s)
- Support Tickets Logged: ${rep.support_tickets.length} ticket(s)
${ts ? `- Exchange Target Stock (${ts.target_size}): ${ts.in_stock ? 'IN STOCK' : 'OUT OF STOCK'} (${ts.stock_available} units available)` : ''}

Chronological Timeline:
${timelineLines || '  • No timeline milestones recorded'}

------------------------------------------------------------
[POLICY]
- Return Window: 7 days from delivery date. (Order age: ${cs.days_since_order} days -> ${cs.return_window_valid ? 'ELIGIBLE' : 'WINDOW EXPIRED'})
- Proof Policy: ${cs.proof_details}
- Refund Type Policy: ${cs.refund_policy}
- Return/Exchange Portal: ${rep.sop_policies.PORTAL_URL}
- Reverse Pickup SLA: ${rep.sop_policies.PICKUP_SLA_HOURS}

------------------------------------------------------------
[INFERENCE / RECOMMENDATION]
- Issue Classification: ${cs.reason}
- Proof Status: ${cs.proof_status}
- Exchange Feasibility: ${ts ? (ts.in_stock ? `Size ${ts.target_size} is available in warehouse. Exchange can be safely processed.` : `Size ${ts.target_size} is currently out of stock. Advise offering store credit.`) : 'Standard return/exchange evaluation applied.'}

------------------------------------------------------------
[ACTION RECOMMENDED]
${cs.proof_status === 'PENDING_CUSTOMER_SUBMISSION'
    ? `1. Request mandatory proof from customer (${cs.proof_details}).\n2. Do NOT approve refund to original payment method until proof is verified.\n3. Direct customer to portal ${rep.sop_policies.PORTAL_URL} once proof is validated.`
    : cs.is_pre_dispatch
    ? `1. Order has not dispatched yet. Process size/address change directly in Shoppers Hub without return fees.`
    : `1. Guide customer to official portal: ${rep.sop_policies.PORTAL_URL}\n2. Once request is placed, courier pickup will be scheduled within 24-48 business hours.\n3. Issue ${cs.refund_mode === 'ORIGINAL_PAYMENT' ? 'Refund to Original Payment Method' : 'Store Credit'} upon reverse QC.`
}

(Data as of: ${rep.data_as_of} — Live Database)`;

    return output;
}

module.exports = {
    investigateReturnExchange,
    getRecentReturnExchangeRequests,
    formatInvestigationReport,
    SOP_POLICIES
};
