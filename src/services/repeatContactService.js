/**
 * Repeat Contact Detection Service
 * Detects when the same customer repeatedly contacts support about the same order or problem.
 *
 * Implements Requirement 5:
 * - STEP 1: Inspect existing support ticket/conversation data
 * - STEP 2: Correlate: customer + order + issue category + time
 * - STEP 3: Detect repeated contacts
 * - STEP 4: Show:
 *     - number of previous contacts
 *     - previous dates
 *     - previous actions
 *     - current unresolved issue
 * - STEP 5: Allow Copilot to tell the officer: "Repeat contact detected."
 * - STEP 6: Do NOT automatically escalate unless the company's configured escalation rule says so
 * - STEP 7: Tests for first contact, repeated contact, unrelated contact, and multiple orders
 */

const { dbAdapter } = require('../database/db');
const { resolveCustomer, formatDateTime } = require('./conversationHistoryService');
const { classifyIssueText } = require('./customerBehaviorService');

/**
 * Standardize and clean order IDs (e.g. "#51209" -> "51209").
 */
function normalizeOrderId(val) {
    if (!val) return null;
    const s = String(val).trim();
    const digits = s.replace(/\D/g, '');
    return digits || s;
}

/**
 * Extract Order ID from text if present (e.g. "my order #51209 hasn't arrived").
 */
function extractOrderIdFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/#?(\d{4,6})\b/);
    return match ? match[1] : null;
}

/**
 * Pure function: Evaluate whether escalation should occur based on company rules.
 * STRICT Step 6: Do not automatically escalate unless the company's configured escalation rule says so.
 *
 * Configured rules:
 * 1. system_settings threshold: 'escalate_repeat_contacts_threshold' (e.g. 3 contacts)
 * 2. Customer sentiment is explicitly 'frustrated'
 * 3. Customer explicitly requests supervisor / escalation ('scenario' === 'escalation')
 * Otherwise: shouldEscalate is FALSE.
 */
function evaluateEscalationRule({ repeatCount, sentiment, scenario, thresholdConfig }) {
    const threshold = parseInt(thresholdConfig, 10) || 3;
    const isFrustrated = String(sentiment || '').toLowerCase() === 'frustrated';
    const isEscalationScenario = String(scenario || '').toLowerCase() === 'escalation';

    // Rule 1: Exceeded configured repeat contact threshold
    if (repeatCount >= threshold) {
        return {
            shouldEscalate: true,
            escalationStatus: 'Escalation recommended per company policy',
            policyReason: `Repeat contact count (${repeatCount}) has reached or exceeded company threshold (${threshold}). Supervisor review recommended.`
        };
    }

    // Rule 2: Explicit customer frustration / supervisor request
    if (isFrustrated || isEscalationScenario) {
        return {
            shouldEscalate: true,
            escalationStatus: 'Escalation recommended per company policy',
            policyReason: isFrustrated
                ? 'Customer sentiment is frustrated — policy permits escalation to supervisor.'
                : 'Customer explicitly requested supervisor/manager escalation.'
        };
    }

    // Default: Under threshold — resolve over chat per SOP without auto-escalating
    return {
        shouldEscalate: false,
        escalationStatus: 'Not triggered (Under policy threshold / Per SOP resolve over chat first)',
        policyReason: `Repeat contact count (${repeatCount}) is under escalation threshold (${threshold}). Company SOP mandates resolving over chat before escalating.`
    };
}

/**
 * Pure function: 4-Dimensional Correlation Engine (customer + order + issue category + time).
 *
 * @param {Object} params
 * @param {Object} params.currentContact - { orderId, issueCategory, issueText, timestamp }
 * @param {Array}  params.historicalSessions - Array of session objects
 * @param {Object} params.config - { thresholdConfig }
 * @returns {Object} Correlation & repeat detection results
 */
function correlateContacts({ currentContact, historicalSessions = [], config = {} }) {
    const targetOrderId = normalizeOrderId(currentContact.orderId);
    const targetCategory = currentContact.issueCategory || classifyIssueText(currentContact.issueText) || 'General Inquiry';
    const currentTime = currentContact.timestamp ? new Date(currentContact.timestamp).getTime() : Date.now();

    const matchingPreviousContacts = [];
    const unrelatedOrderContacts = [];
    const unrelatedCategoryContacts = [];

    for (const sess of historicalSessions) {
        const sessTime = sess.timestamp ? new Date(sess.timestamp).getTime() : 0;
        
        // Time check: Only prior sessions count as previous contacts
        // If timestamps are identical or in the future, it's the current session
        if (sessTime >= currentTime && historicalSessions.length > 1) {
            continue;
        }

        const sessOrderId = normalizeOrderId(sess.orderId);
        const sessCategory = sess.issueCategory || classifyIssueText(sess.issueText || sess.customerStatements?.join(' ')) || 'General Inquiry';

        // Order Dimension Check
        const isOrderMatch = !targetOrderId || !sessOrderId || (targetOrderId === sessOrderId);

        if (!isOrderMatch) {
            unrelatedOrderContacts.push({
                ...sess,
                reason: `Different order (#${sessOrderId} vs #${targetOrderId})`
            });
            continue;
        }

        // Category Dimension Check
        const isCategoryMatch = targetCategory === 'General Inquiry' 
            ? sessCategory === 'General Inquiry' 
            : sessCategory === targetCategory;

        if (!isCategoryMatch) {
            unrelatedCategoryContacts.push({
                ...sess,
                reason: `Different issue category ("${sessCategory}" vs "${targetCategory}")`
            });
            continue;
        }

        // Both Order and Category match → Repeating contact!
        matchingPreviousContacts.push({
            id: sess.id,
            dateFormatted: sess.dateFormatted || formatDateTime(sess.timestamp),
            timestamp: sess.timestamp,
            orderId: sessOrderId || targetOrderId || 'Account-level',
            issueCategory: sessCategory,
            summary: sess.summary || sess.customerStatements?.[0] || 'Customer support inquiry',
            actionTaken: sess.actionTaken || sess.agentStatements?.[0] || 'Support assistance provided',
            status: sess.status || 'open',
            ticketNumber: sess.ticketNumber || null
        });
    }

    // Sort matching previous contacts chronologically (oldest to newest)
    matchingPreviousContacts.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const isRepeatContact = matchingPreviousContacts.length > 0;
    const previousContactsCount = matchingPreviousContacts.length;
    const previousDates = matchingPreviousContacts.map(c => c.dateFormatted);
    const previousActions = matchingPreviousContacts.map(c => `${c.dateFormatted}: ${c.actionTaken}`);

    // Escalation evaluation (Step 6)
    const escalation = evaluateEscalationRule({
        repeatCount: previousContactsCount,
        sentiment: currentContact.sentiment,
        scenario: currentContact.scenario,
        thresholdConfig: config.thresholdConfig
    });

    const currentUnresolved = {
        orderId: targetOrderId ? `#${targetOrderId}` : 'Not order-specific',
        category: targetCategory,
        description: currentContact.issueText || `Customer inquiry regarding ${targetCategory}${targetOrderId ? ` for Order #${targetOrderId}` : ''}`,
        status: isRepeatContact ? 'Unresolved / Repeat inquiry active' : 'Initial contact / Active'
    };

    return {
        isRepeatContact,
        alert: isRepeatContact ? 'Repeat contact detected.' : 'First contact (No repeat contact detected).',
        previousContactsCount,
        previousDates,
        previousActions,
        currentUnresolvedIssue: currentUnresolved,
        matchingPreviousContacts,
        unrelatedOrderContactsCount: unrelatedOrderContacts.length,
        unrelatedCategoryContactsCount: unrelatedCategoryContacts.length,
        escalation,
        neutralSummary: buildRepeatContactSummary({
            isRepeatContact,
            previousContactsCount,
            previousDates,
            previousActions,
            currentUnresolved,
            escalation,
            unrelatedOrderContactsCount: unrelatedOrderContacts.length,
            unrelatedCategoryContactsCount: unrelatedCategoryContacts.length
        })
    };
}

/**
 * Format structured officer output.
 */
function buildRepeatContactSummary({
    isRepeatContact,
    previousContactsCount,
    previousDates,
    previousActions,
    currentUnresolved,
    escalation,
    unrelatedOrderContactsCount = 0,
    unrelatedCategoryContactsCount = 0
}) {
    const lines = [];

    if (isRepeatContact) {
        lines.push('⚠️ Status: Repeat contact detected.');
        lines.push(`Order: ${currentUnresolved.orderId}`);
        lines.push(`Issue Category: ${currentUnresolved.category}`);
        lines.push(`Previous Contacts: ${previousContactsCount} previous contact(s) regarding this same issue/order.`);
        lines.push(`Previous Dates: ${previousDates.join(', ')}`);
        
        lines.push('Previous Actions Taken:');
        if (previousActions.length > 0) {
            for (const act of previousActions) {
                lines.push(`  - ${act}`);
            }
        } else {
            lines.push('  - No recorded prior actions in database');
        }

        lines.push(`Current Unresolved Issue: ${currentUnresolved.description} [${currentUnresolved.status}]`);
        lines.push(`Escalation Policy Check: ${escalation.escalationStatus}`);
        lines.push(`  -> ${escalation.policyReason}`);

        if (unrelatedOrderContactsCount > 0 || unrelatedCategoryContactsCount > 0) {
            lines.push(`Note on Other Contacts: ${unrelatedOrderContactsCount} contact(s) for different orders, ${unrelatedCategoryContactsCount} for different topics (not grouped as repeat for this issue).`);
        }
    } else {
        lines.push('ℹ️ Status: First contact (No repeat contact detected).');
        lines.push(`Order: ${currentUnresolved.orderId}`);
        lines.push(`Issue Category: ${currentUnresolved.category}`);
        lines.push('Previous Contacts: 0 previous contacts for this order/issue.');
        lines.push(`Current Issue: ${currentUnresolved.description}`);
        lines.push(`Escalation Policy Check: ${escalation.escalationStatus}`);
        
        if (unrelatedOrderContactsCount > 0 || unrelatedCategoryContactsCount > 0) {
            lines.push(`Note on Prior History: Customer has prior contacts (${unrelatedOrderContactsCount} on different orders, ${unrelatedCategoryContactsCount} on different topics), but none for this specific order and problem.`);
        }
    }

    return lines.join('\n');
}

/**
 * Fetch company configured escalation threshold from system_settings.
 */
async function getEscalationThreshold() {
    try {
        const rows = await dbAdapter.query(
            `SELECT value FROM system_settings WHERE key = 'escalate_repeat_contacts_threshold' LIMIT 1`
        );
        if (rows && rows[0]?.value) {
            const val = parseInt(rows[0].value, 10);
            if (!isNaN(val) && val > 0) return val;
        }
    } catch {
        // ignore DB read error, fall back to default
    }
    return 3; // default policy: 3 repeat contacts
}

/**
 * Main Service API: Detect Repeat Contact for a customer identifier.
 *
 * @param {string|Object} identifierOrParams - Customer phone/order ID/ticket or object
 * @param {Object} [options]
 * @param {string} [options.orderId] - Specific order ID to investigate
 * @param {string} [options.currentIssue] - Message or description of the current issue
 * @param {string} [options.issueCategory] - Pre-classified issue category
 * @returns {Promise<Object>} Detailed repeat contact analysis
 */
async function detectRepeatContact(identifierOrParams, options = {}) {
    let identifier;
    let orderId = options.orderId;
    let currentIssue = options.currentIssue;
    let issueCategory = options.issueCategory;

    if (typeof identifierOrParams === 'object' && identifierOrParams !== null) {
        identifier = identifierOrParams.customerIdentifier || identifierOrParams.identifier || identifierOrParams.phone || identifierOrParams.orderId;
        orderId = orderId || identifierOrParams.orderId;
        currentIssue = currentIssue || identifierOrParams.currentIssue || identifierOrParams.message;
        issueCategory = issueCategory || identifierOrParams.issueCategory;
    } else {
        identifier = identifierOrParams;
    }

    if (!identifier && !orderId) {
        return {
            found: false,
            error: 'A customer identifier (phone, order ID, ticket number, email) or order ID is required.'
        };
    }

    // If identifier looks like an order ID, set orderId
    if (!orderId && (identifier.startsWith('#') || /^\d{4,6}$/.test(identifier))) {
        orderId = identifier;
    }

    // Try extracting order ID from issue text if not specified
    if (!orderId && currentIssue) {
        orderId = extractOrderIdFromText(currentIssue);
    }

    // 1. Resolve Customer Identity
    const customer = await resolveCustomer(identifier || orderId);
    if (!customer) {
        return {
            found: false,
            error: `No order or interaction records found for "${identifier || orderId}".`
        };
    }

    const vars = customer.variations;
    const placeholders = vars.map(() => '?').join(',');

    // 2. Fetch all historical interaction rows across tickets, messages, returns, exchanges, shoppers
    const [ticketRows, messageRows, returnRows, exchangeRows, shopperRows] = await Promise.all([
        dbAdapter.query(
            `SELECT id, ticket_number, customer_phone, customer_name, message, status, sentiment, ai_scenario, created_at, updated_at
             FROM support_tickets
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC`,
            vars
        ).catch(() => []),
        dbAdapter.query(
            `SELECT id, customer_phone, message_type, message_content, created_at
             FROM messages
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC`,
            vars
        ).catch(() => []),
        dbAdapter.query(
            `SELECT id, return_id, order_id, customer_phone, items, reason, status, refund_amount, refund_status, created_at
             FROM returns
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC`,
            vars
        ).catch(() => []),
        dbAdapter.query(
            `SELECT id, exchange_id, order_id, customer_phone, old_items, new_items, reason, status, created_at
             FROM exchanges
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC`,
            vars
        ).catch(() => []),
        dbAdapter.query(
            `SELECT id, order_id, phone, name, status, items_json, customer_message, created_at
             FROM store_shoppers
             WHERE phone IN (${placeholders})
             ORDER BY created_at ASC`,
            vars
        ).catch(() => [])
    ]);

    const hasAnyData = ticketRows.length > 0 ||
        messageRows.length > 0 ||
        returnRows.length > 0 ||
        exchangeRows.length > 0 ||
        shopperRows.length > 0;

    if (!hasAnyData) {
        return {
            found: false,
            customerIdentifier: identifier || orderId,
            error: `No order or interaction records found for identifier "${identifier || orderId}".`
        };
    }

    // 3. Cluster messages and events into distinct interaction sessions
    // Messages within 24h belong to the same session
    const sessions = [];
    const allEvents = [];

    // Add tickets as distinct events
    for (const t of ticketRows) {
        allEvents.push({
            type: 'ticket',
            id: `ticket-${t.id}`,
            ticketNumber: t.ticket_number,
            timestamp: new Date(t.created_at),
            text: t.message || '',
            status: t.status,
            orderId: extractOrderIdFromText(t.message),
            sentiment: t.sentiment,
            scenario: t.ai_scenario,
            actionTaken: `Support ticket ${t.ticket_number} logged (${t.status})`
        });
    }

    // Add returns as distinct events
    for (const r of returnRows) {
        allEvents.push({
            type: 'return',
            id: `return-${r.id}`,
            timestamp: new Date(r.created_at),
            text: `Return request for order #${r.order_id}: ${r.reason || 'Customer requested return'}`,
            status: r.status,
            orderId: r.order_id,
            actionTaken: `Return request ${r.return_id} recorded (Status: ${r.status}, Refund: ${r.refund_status || 'pending'})`
        });
    }

    // Add exchanges as distinct events
    for (const ex of exchangeRows) {
        allEvents.push({
            type: 'exchange',
            id: `exchange-${ex.id}`,
            timestamp: new Date(ex.created_at),
            text: `Exchange request for order #${ex.order_id}: ${ex.reason || 'Customer requested size exchange'}`,
            status: ex.status,
            orderId: ex.order_id,
            actionTaken: `Exchange request ${ex.exchange_id} recorded (Status: ${ex.status})`
        });
    }

    // Filter relevant messages (exclude outbound unresponded marketing templates)
    for (const m of messageRows) {
        const text = m.message_content || '';
        if (m.message_type === 'incoming' || m.message_type === 'inbound' || !m.message_type) {
            allEvents.push({
                type: 'message',
                id: `msg-${m.id}`,
                timestamp: new Date(m.created_at),
                text,
                status: 'inquiry',
                orderId: extractOrderIdFromText(text),
                actionTaken: 'Customer inbound message received'
            });
        }
    }

    // Add shopper special messages / cancel requests
    for (const sh of shopperRows) {
        if (sh.customer_message) {
            allEvents.push({
                type: 'shopper_note',
                id: `shopper-${sh.id}`,
                timestamp: new Date(sh.created_at),
                text: sh.customer_message,
                status: sh.status,
                orderId: sh.order_id,
                actionTaken: `Customer order note recorded at checkout for #${sh.order_id}`
            });
        }
    }

    // Sort all events chronologically
    allEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Cluster into sessions separated by >= 24 hours
    const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
    let currentSession = null;

    for (const ev of allEvents) {
        if (!currentSession) {
            currentSession = {
                id: ev.id,
                startTime: ev.timestamp,
                endTime: ev.timestamp,
                events: [ev],
                orderId: ev.orderId,
                texts: [ev.text],
                actions: [ev.actionTaken],
                ticketNumber: ev.ticketNumber || null,
                status: ev.status
            };
        } else if (ev.timestamp.getTime() - currentSession.endTime.getTime() < CLUSTER_WINDOW_MS) {
            // Same session
            currentSession.endTime = ev.timestamp;
            currentSession.events.push(ev);
            if (ev.orderId && !currentSession.orderId) currentSession.orderId = ev.orderId;
            if (ev.ticketNumber && !currentSession.ticketNumber) currentSession.ticketNumber = ev.ticketNumber;
            currentSession.texts.push(ev.text);
            currentSession.actions.push(ev.actionTaken);
            currentSession.status = ev.status;
        } else {
            // New session
            sessions.push(currentSession);
            currentSession = {
                id: ev.id,
                startTime: ev.timestamp,
                endTime: ev.timestamp,
                events: [ev],
                orderId: ev.orderId,
                texts: [ev.text],
                actions: [ev.actionTaken],
                ticketNumber: ev.ticketNumber || null,
                status: ev.status
            };
        }
    }
    if (currentSession) {
        sessions.push(currentSession);
    }

    // Build normalized session objects
    const normalizedSessions = sessions.map(sess => {
        const combinedText = sess.texts.filter(Boolean).join(' ');
        const cat = classifyIssueText(combinedText);
        return {
            id: sess.id,
            timestamp: sess.startTime.toISOString(),
            dateFormatted: formatDateTime(sess.startTime),
            orderId: sess.orderId,
            issueCategory: cat,
            issueText: combinedText.substring(0, 300),
            summary: combinedText.substring(0, 160) || 'Support contact session',
            actionTaken: sess.actions.slice(0, 2).join('; ') || 'Assistance provided',
            status: sess.status,
            ticketNumber: sess.ticketNumber
        };
    });

    // 4. Fetch escalation threshold config
    const thresholdConfig = await getEscalationThreshold();

    // 5. Determine Current Issue Category if not specified
    let targetCategory = issueCategory;
    if (!targetCategory && currentIssue) {
        targetCategory = classifyIssueText(currentIssue);
    }
    // If neither was provided, infer from latest session or default to General Inquiry
    if (!targetCategory) {
        targetCategory = normalizedSessions[normalizedSessions.length - 1]?.issueCategory || 'Delivery & Tracking';
    }

    // 6. Run 4D Correlation Engine
    const correlationResult = correlateContacts({
        currentContact: {
            orderId,
            issueCategory: targetCategory,
            issueText: currentIssue,
            timestamp: new Date().toISOString()
        },
        historicalSessions: normalizedSessions,
        config: { thresholdConfig }
    });

    return {
        found: true,
        customer: {
            name: customer.name,
            phone: customer.formattedPhone || customer.cleanPhone,
            cleanPhone: customer.cleanPhone,
            email: customer.email,
            id: customer.customerId
        },
        ...correlationResult
    };
}

module.exports = {
    detectRepeatContact,
    correlateContacts,
    evaluateEscalationRule,
    normalizeOrderId,
    extractOrderIdFromText,
    buildRepeatContactSummary
};
