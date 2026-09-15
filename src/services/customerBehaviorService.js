/**
 * Customer Behavior and History Patterns Service
 * Analyzes factual patterns in customer order, return, cancellation, RTO, and support history.
 *
 * Implements Requirement 4:
 * - Calculate factual metrics:
 *   - number of orders
 *   - returns
 *   - exchanges
 *   - cancellations
 *   - RTOs (Return To Origin)
 *   - support contacts
 *   - repeated issue categories
 * - Answer mandatory officer questions:
 *   1. "Has this customer had the same issue before?"
 *   2. "How many size-related complaints did they have?"
 *   3. "How many returns did this customer make?"
 * - Present patterns strictly neutrally without unsupported judgments or defamatory labels
 *   (NEVER use "fraudulent customer", "serial returner", "high risk", etc.)
 */

const { dbAdapter } = require('../database/db');
const { resolveCustomer, formatDateTime } = require('./conversationHistoryService');

function formatDateOnly(isoString) {
    if (!isoString) return 'Not available';
    try {
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return 'Not available';
        const day = d.getDate();
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${day} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    } catch {
        return 'Not available';
    }
}

/**
 * Fetch all raw history rows across orders, shoppers, shipments, returns, exchanges, tickets, and messages.
 */
async function fetchCustomerHistory(customer) {
    const vars = customer.variations;
    const placeholders = vars.map(() => '?').join(',');

    const [shopperRows, orderRows, shipmentRows, returnRows, exchangeRows, ticketRows, messageRows] = await Promise.all([
        // 1. Store shoppers
        dbAdapter.query(
            `SELECT id, order_id, phone, name, email, status, items_json, customer_message, created_at, updated_at
             FROM store_shoppers
             WHERE phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 2. Orders table
        dbAdapter.query(
            `SELECT id, order_id, customer_phone, status, total_price, cancel_reason, cancelled_at, created_at
             FROM orders
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 3. Shipments table (check for RTO and delivery statuses)
        dbAdapter.query(
            `SELECT id, order_id, customer_phone, status, courier_name, awb, created_at, updated_at
             FROM shipments
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 4. Returns table
        dbAdapter.query(
            `SELECT id, return_id, order_id, customer_phone, items, reason, status, refund_amount, refund_status, created_at
             FROM returns
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 5. Exchanges table
        dbAdapter.query(
            `SELECT id, exchange_id, order_id, customer_phone, old_items, new_items, reason, status, created_at
             FROM exchanges
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 6. Support tickets
        dbAdapter.query(
            `SELECT id, ticket_number, customer_phone, customer_name, message, status, sentiment, ai_scenario, created_at
             FROM support_tickets
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC`,
            vars
        ).catch(() => []),

        // 7. Messages
        dbAdapter.query(
            `SELECT id, customer_phone, message_type, message_content, created_at
             FROM messages
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at DESC
             LIMIT 100`,
            vars
        ).catch(() => [])
    ]);

    return {
        shoppers: shopperRows || [],
        orders: orderRows || [],
        shipments: shipmentRows || [],
        returns: returnRows || [],
        exchanges: exchangeRows || [],
        tickets: ticketRows || [],
        messages: messageRows || []
    };
}

/**
 * Classify customer interaction text or notes into objective issue categories.
 */
function classifyIssueText(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.toLowerCase();

    // 1. Order Modification / Cancellation (evaluated before Delivery to catch 'change delivery address')
    if (/\b(?:cancel(?:led|lation)?|mistake|by\s*mistake|address|edit\s*details|modify\s*order|shop_cancel|shop_edit)\b/i.test(clean)) {
        return 'Order Modification / Cancellation';
    }

    // 2. Return & Refund (evaluated before generic delivery to catch 'when will return pickup happen')
    if (/\b(?:refund|money\s*back|return\s*pickup|return\s*request|pickup\s*delay|refund\s*delay|refund\s*status)\b/i.test(clean)) {
        return 'Return & Refund';
    }

    // 3. Size & Fit
    if (/\b(?:size|fit|tight|loose|small|smaller|big|bigger|large|larger|measurement|sizing|size\s*chart|wrong\s*size|exchange\s*size)\b/i.test(clean)) {
        return 'Size & Fit';
    }

    // 4. Damaged / Defective
    if (/\b(?:defect|defective|damaged?|broken|torn|stitching|quality|flaw|stain|dirty|wrong\s*item|incorrect\s*item)\b/i.test(clean)) {
        return 'Damaged / Defective Product';
    }

    // 5. Delivery & Tracking
    if (/\b(?:track|tracking|where\s*is|dispatch|delayed?|not\s*delivered|courier|awb|transit|deliver(?:ed|y|ing)?|reach|when\s*will\s*(?:it|order|product|item|package))\b/i.test(clean)) {
        return 'Delivery & Tracking';
    }

    // 6. Payment & Checkout
    if (/\b(?:payment|failed|deducted|double\s*charge|cod|prepaid|razorpay|transaction)\b/i.test(clean)) {
        return 'Payment & Checkout';
    }

    return 'General Inquiry';
}

/**
 * Aggregate factual metrics and categorize all historical issues.
 */
function analyzeCustomerPatterns(customer, history) {
    const { shoppers, orders, shipments, returns, exchanges, tickets, messages } = history;

    // 1. Distinct Order Calculation
    const uniqueOrders = new Map();

    for (const sh of shoppers) {
        if (sh.order_id) {
            const bare = sh.order_id.replace(/\D/g, '');
            if (!uniqueOrders.has(bare)) {
                uniqueOrders.set(bare, {
                    orderId: sh.order_id,
                    status: (sh.status || '').toLowerCase(),
                    message: sh.customer_message,
                    date: sh.created_at
                });
            }
        }
    }

    for (const o of orders) {
        if (o.order_id) {
            const bare = o.order_id.replace(/\D/g, '');
            const existing = uniqueOrders.get(bare);
            if (existing) {
                if (o.status) existing.status = o.status.toLowerCase();
                if (o.cancel_reason) existing.cancelReason = o.cancel_reason;
            } else {
                uniqueOrders.set(bare, {
                    orderId: o.order_id,
                    status: (o.status || '').toLowerCase(),
                    cancelReason: o.cancel_reason,
                    date: o.created_at
                });
            }
        }
    }

    const totalOrdersCount = uniqueOrders.size;

    // 2. Cancellations Count
    const cancelledOrders = [];
    for (const [bare, o] of uniqueOrders.entries()) {
        if (['cancelled', 'canceled'].includes(o.status) || (o.cancelReason && o.cancelReason.trim())) {
            cancelledOrders.push({
                orderId: o.orderId,
                reason: o.cancelReason || 'Customer requested cancellation',
                date: formatDateOnly(o.date)
            });
        }
    }

    // 3. Delivered Count
    let deliveredCount = 0;
    for (const [bare, o] of uniqueOrders.entries()) {
        if (['delivered', 'completed', 'fulfilled'].includes(o.status)) {
            deliveredCount++;
        }
    }
    // Also check shipment status for delivery
    for (const sh of shipments) {
        if (sh.status === 'delivered') {
            const bare = (sh.order_id || '').replace(/\D/g, '');
            const ord = uniqueOrders.get(bare);
            if (ord && !['delivered', 'completed', 'fulfilled'].includes(ord.status)) {
                deliveredCount++;
                ord.status = 'delivered';
            }
        }
    }

    // 4. Returns Count & Reasons
    const returnedOrdersList = [];
    for (const r of returns) {
        returnedOrdersList.push({
            returnId: r.return_id,
            orderId: r.order_id,
            reason: r.reason || 'Not specified',
            status: r.status,
            refundAmount: r.refund_amount ? `₹${r.refund_amount}` : null,
            date: formatDateOnly(r.created_at)
        });
    }

    // 5. Exchanges Count & Reasons
    const exchangedOrdersList = [];
    for (const ex of exchanges) {
        exchangedOrdersList.push({
            exchangeId: ex.exchange_id,
            orderId: ex.order_id,
            reason: ex.reason || 'Size/Fit exchange',
            status: ex.status,
            oldItems: ex.old_items,
            newItems: ex.new_items,
            date: formatDateOnly(ex.created_at)
        });
    }

    // 6. RTOs (Return To Origin) Count
    const rtoShipmentsList = [];
    for (const s of shipments) {
        const st = (s.status || '').toLowerCase();
        if (st.includes('rto') || st === 'returned_to_origin') {
            rtoShipmentsList.push({
                orderId: s.order_id,
                awb: s.awb,
                courier: s.courier_name,
                status: s.status,
                date: formatDateOnly(s.created_at)
            });
        }
    }
    for (const [bare, o] of uniqueOrders.entries()) {
        if (o.status && o.status.includes('rto')) {
            if (!rtoShipmentsList.some(r => r.orderId === o.orderId)) {
                rtoShipmentsList.push({
                    orderId: o.orderId,
                    status: o.status,
                    date: formatDateOnly(o.date)
                });
            }
        }
    }

    // 7. Support Contacts Count & History Breakdown
    // Count distinct support tickets
    const supportTicketsCount = tickets.length;
    // Count customer incoming message clusters
    const incomingMessages = messages.filter(m => m.message_type === 'incoming');
    const totalSupportContacts = Math.max(supportTicketsCount, (tickets.length + (incomingMessages.length > 0 ? 1 : 0)));

    // 8. Issue Categorization across Tickets, Return Reasons, Exchange Reasons, and Shopper Messages
    const categoryOccurrences = {
        'Size & Fit': [],
        'Delivery & Tracking': [],
        'Damaged / Defective Product': [],
        'Return & Refund': [],
        'Order Modification / Cancellation': [],
        'Payment & Checkout': [],
        'General Inquiry': []
    };

    // A. Check Support Tickets
    for (const t of tickets) {
        const cleanMsg = (t.message || '').replace(/💡\s*\[AI SUGGESTED REPLY[\s\S]*?\][\s\S]*$/gi, '').trim();
        const cat = classifyIssueText(cleanMsg) || 'General Inquiry';
        categoryOccurrences[cat].push({
            source: `Support Ticket (${t.ticket_number})`,
            date: formatDateOnly(t.created_at),
            detail: cleanMsg.substring(0, 140)
        });
    }

    // B. Check Return Reasons
    for (const r of returns) {
        const cat = classifyIssueText(r.reason) || 'Return & Refund';
        categoryOccurrences[cat].push({
            source: `Return Request (${r.return_id}) - Order #${r.order_id}`,
            date: formatDateOnly(r.created_at),
            detail: `Return reason: "${r.reason}"`
        });
    }

    // C. Check Exchange Reasons
    for (const ex of exchanges) {
        const cat = classifyIssueText(ex.reason) || 'Size & Fit';
        categoryOccurrences[cat].push({
            source: `Exchange Request (${ex.exchange_id}) - Order #${ex.order_id}`,
            date: formatDateOnly(ex.created_at),
            detail: `Exchange reason: "${ex.reason}"`
        });
    }

    // D. Check Shopper Customer Messages (e.g. edit notes, cancellation notes)
    for (const sh of shoppers) {
        if (sh.customer_message) {
            const cat = classifyIssueText(sh.customer_message) || 'Order Modification / Cancellation';
            categoryOccurrences[cat].push({
                source: `Shopper Note - Order #${sh.order_id}`,
                date: formatDateOnly(sh.created_at),
                detail: sh.customer_message
            });
        }
    }

    // E. Check Inbound Messages
    for (const m of incomingMessages) {
        const cat = classifyIssueText(m.message_content);
        if (cat && cat !== 'General Inquiry') {
            // Avoid duplicate logging if already covered by ticket
            const alreadyInTickets = tickets.some(t => (t.message || '').includes(m.message_content));
            if (!alreadyInTickets) {
                categoryOccurrences[cat].push({
                    source: 'WhatsApp Customer Message',
                    date: formatDateOnly(m.created_at),
                    detail: m.message_content
                });
            }
        }
    }

    // Summary counts per category
    const issueCategoryBreakdown = {};
    const repeatedCategories = [];

    for (const [cat, list] of Object.entries(categoryOccurrences)) {
        if (list.length > 0) {
            issueCategoryBreakdown[cat] = list.length;
            if (list.length >= 2) {
                repeatedCategories.push({
                    category: cat,
                    count: list.length,
                    occurrences: list
                });
            }
        }
    }

    const sizeComplaintsCount = categoryOccurrences['Size & Fit'].length;
    const returnsCount = returnedOrdersList.length;
    const rtoCount = rtoShipmentsList.length;
    const exchangesCount = exchangedOrdersList.length;
    const cancellationsCount = cancelledOrders.length;

    return {
        metrics: {
            totalOrders: totalOrdersCount,
            deliveredOrders: deliveredCount,
            cancelledOrders: cancellationsCount,
            returnedOrders: returnsCount,
            exchangedOrders: exchangesCount,
            rtoOrders: rtoCount,
            supportContacts: totalSupportContacts
        },
        issueBreakdown: issueCategoryBreakdown,
        repeatedCategories,
        categoryOccurrences,
        details: {
            returns: returnedOrdersList,
            exchanges: exchangedOrdersList,
            cancellations: cancelledOrders,
            rtos: rtoShipmentsList
        }
    };
}

/**
 * Answer the 3 specific officer questions required by Step 3:
 * 1. "Has this customer had the same issue before?"
 * 2. "How many size-related complaints did they have?"
 * 3. "How many returns did this customer make?"
 */
function answerOfficerQuestions(patterns, queryIssue = null) {
    const { categoryOccurrences, repeatedCategories, metrics, details } = patterns;

    // 1. "Has this customer had the same issue before?"
    let sameIssueAnswer = '';
    if (queryIssue) {
        const targetCat = classifyIssueText(queryIssue) || 'General Inquiry';
        const priorOccurrences = categoryOccurrences[targetCat] || [];
        if (priorOccurrences.length > 1) {
            sameIssueAnswer = `Yes. The customer has had previous issues regarding "${targetCat}" (${priorOccurrences.length} total occurrences):\n` +
                priorOccurrences.map(o => `• [${o.date}] ${o.source}: ${o.detail}`).join('\n');
        } else if (priorOccurrences.length === 1) {
            sameIssueAnswer = `This issue ("${targetCat}") has occurred 1 time in the customer's history:\n` +
                priorOccurrences.map(o => `• [${o.date}] ${o.source}: ${o.detail}`).join('\n');
        } else {
            sameIssueAnswer = `No. The customer has not had prior recorded issues regarding "${targetCat}".`;
        }
    } else {
        if (repeatedCategories.length > 0) {
            sameIssueAnswer = `Yes. The customer has repeated issues in the following categories:\n` +
                repeatedCategories.map(rc => `• ${rc.category} (${rc.count} times): ${rc.occurrences.map(o => `[${o.date}] ${o.detail}`).join('; ')}`).join('\n');
        } else {
            sameIssueAnswer = 'No recurring or repeat issues were found. All recorded customer inquiries have been one-off or distinct.';
        }
    }

    // 2. "How many size-related complaints did they have?"
    const sizeList = categoryOccurrences['Size & Fit'] || [];
    let sizeComplaintsAnswer = '';
    if (sizeList.length === 0) {
        sizeComplaintsAnswer = 'The customer has made 0 size-related complaints or exchange requests.';
    } else {
        sizeComplaintsAnswer = `The customer has had ${sizeList.length} size-related complaint(s)/request(s):\n` +
            sizeList.map(s => `• [${s.date}] ${s.source}: ${s.detail}`).join('\n');
    }

    // 3. "How many returns did this customer make?"
    const returnList = details.returns || [];
    let returnsAnswer = '';
    if (returnList.length === 0) {
        returnsAnswer = 'The customer has made 0 returns.';
    } else {
        returnsAnswer = `The customer has made ${returnList.length} return(s):\n` +
            returnList.map(r => `• Order #${r.orderId} (${r.date}): Reason "${r.reason}", Status: ${r.status}${r.refundAmount ? `, Refund: ${r.refundAmount}` : ''}`).join('\n');
    }

    return {
        hasCustomerHadSameIssueBefore: sameIssueAnswer,
        howManySizeRelatedComplaints: sizeComplaintsAnswer,
        howManyReturnsMade: returnsAnswer
    };
}

/**
 * Build factual, neutral pattern summary (Step 4 compliance: strictly neutral, no negative labels).
 */
function buildNeutralPatternSummary(customer, patterns) {
    const m = patterns.metrics;
    const parts = [];

    parts.push(`${customer.name} has placed ${m.totalOrders} order(s) in total (${m.deliveredOrders} delivered, ${m.cancelledOrders} cancelled, ${m.returnedOrders} returned, ${m.exchangedOrders} exchanged, ${m.rtoOrders} RTOs).`);
    parts.push(`The customer has had ${m.supportContacts} recorded support contact(s).`);

    const categories = Object.entries(patterns.issueBreakdown).map(([cat, count]) => `${cat}: ${count}`);
    if (categories.length > 0) {
        parts.push(`Issue categories recorded: ${categories.join(', ')}.`);
    } else {
        parts.push('No support issues or complaints have been recorded for this customer.');
    }

    if (patterns.repeatedCategories.length > 0) {
        const recurringList = patterns.repeatedCategories.map(rc => `${rc.category} (${rc.count} times)`).join(', ');
        parts.push(`Recurring pattern observed in: ${recurringList}.`);
    } else {
        parts.push('No repeated issue patterns observed across their history.');
    }

    return parts.join(' ');
}

/**
 * Main entry point: Get factual customer behavior and history patterns.
 * @param {string} customerIdentifier - Phone, order ID, ticket number, email, or name
 * @param {object} [options] - Optional currentIssue string
 * @returns {Promise<object>}
 */
async function getCustomerBehaviorPatterns(customerIdentifier, options = {}) {
    if (!customerIdentifier) {
        return {
            found: false,
            error: 'Customer identifier (phone number, order ID #..., ticket number, or email) is required.'
        };
    }

    // 1. Resolve customer
    const customer = await resolveCustomer(customerIdentifier);
    if (!customer) {
        return {
            found: false,
            customerIdentifier,
            error: `Could not find any customer or order matching identifier "${customerIdentifier}".`
        };
    }

    // 2. Fetch raw history
    const history = await fetchCustomerHistory(customer);

    const hasAnyData = history.shoppers.length > 0 ||
        history.orders.length > 0 ||
        history.returns.length > 0 ||
        history.exchanges.length > 0 ||
        history.tickets.length > 0 ||
        history.messages.length > 0;

    if (!hasAnyData) {
        return {
            found: false,
            customerIdentifier,
            error: `No order or interaction records found for customer identifier "${customerIdentifier}".`
        };
    }

    // 3. Analyze patterns and calculate factual metrics
    const patterns = analyzeCustomerPatterns(customer, history);

    // 4. Generate direct answers to officer questions
    const answers = answerOfficerQuestions(patterns, options.currentIssue);

    // 5. Generate neutral factual summary (Zero defamatory labels per Step 4)
    const neutralSummary = buildNeutralPatternSummary(customer, patterns);

    return {
        found: true,
        customer: {
            name: customer.name,
            phone: customer.formattedPhone,
            cleanPhone: customer.cleanPhone,
            email: customer.email,
            associatedOrders: customer.orderIds
        },
        metrics: patterns.metrics,
        issueBreakdown: patterns.issueBreakdown,
        repeatedCategories: patterns.repeatedCategories,
        details: patterns.details,
        answersToOfficerQuestions: answers,
        neutralPatternSummary: neutralSummary
    };
}

module.exports = {
    getCustomerBehaviorPatterns,
    classifyIssueText,
    analyzeCustomerPatterns,
    answerOfficerQuestions,
    buildNeutralPatternSummary
};
