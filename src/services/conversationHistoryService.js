/**
 * Conversation History Service
 * Consolidates customer support interactions across WhatsApp messages, support tickets,
 * return/exchange records, and shopper messages.
 *
 * Implements Requirement 3:
 * - Multi-identifier customer resolution (phone, order ID, ticket number, email, name)
 * - Relevant conversation retrieval & session clustering (filtering out template noise)
 * - Answers to the 5 mandatory officer questions:
 *   1. "What did the customer tell us previously?"
 *   2. "When did they last contact us?"
 *   3. "What resolution was given?"
 *   4. "Did we promise anything?"
 *   5. "Is this a repeat issue?"
 * - Standard summarization format:
 *   Previous issue: ...
 *   Previous action: ...
 *   Current status: ...
 *   Outstanding commitment: ... (STRICTLY "None" if not present in conversation)
 *   Relevant dates: ...
 */

const { dbAdapter } = require('../database/db');

// Format date into human readable "17 Jan 2026, 04:30 PM IST"
function formatDateTime(isoString) {
    if (!isoString) return 'Not available';
    try {
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return 'Not available';
        const day = d.getDate();
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[d.getMonth()];
        const year = d.getFullYear();
        
        // Format time in IST (UTC+5:30)
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(d.getTime() + istOffset);
        let hours = istDate.getUTCHours();
        const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const formattedHours = String(hours).padStart(2, '0');

        return `${day} ${month} ${year}, ${formattedHours}:${minutes} ${ampm} IST`;
    } catch {
        return 'Not available';
    }
}

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

// Clean and format phone number into standard 10-digit, E.164, and database search variants
function parsePhoneIdentifier(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 10) return null;
    const clean10 = digits.slice(-10);
    return {
        cleanPhone: clean10,
        formattedPhone: `+91${clean10}`,
        variations: [clean10, `+91${clean10}`, `91${clean10}`, `+${clean10}`]
    };
}

// Extract order number from text like "#51209" or "51209"
function parseOrderIdentifier(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    const match = trimmed.match(/^#?(\d{4,6})$/);
    return match ? match[1] : null;
}

// Extract ticket number like "TKT-260908-5122"
function parseTicketIdentifier(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    const match = trimmed.match(/^(TKT-[\w-]+)$/i);
    return match ? match[1].toUpperCase() : null;
}

// Helper: title case name
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
    return fallback ? fallback.trim().toLowerCase() : null;
}

/**
 * Resolve customer identity and phone variations from any identifier.
 */
async function resolveCustomer(identifier) {
    if (!identifier) return null;
    const raw = String(identifier).trim();

    let cleanPhone = null;
    let nameCandidates = [];
    let emailCandidates = [];
    let orderIds = [];
    let ticketNumbers = [];

    // 1. Check if identifier is a Ticket Number (e.g. TKT-260908-5122)
    const ticketNum = parseTicketIdentifier(raw);
    if (ticketNum) {
        ticketNumbers.push(ticketNum);
        const ticketRows = await dbAdapter.query(
            'SELECT customer_phone, customer_name FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNum]
        );
        if (ticketRows && ticketRows.length > 0) {
            const parsed = parsePhoneIdentifier(ticketRows[0].customer_phone);
            if (parsed) cleanPhone = parsed.cleanPhone;
            if (ticketRows[0].customer_name) nameCandidates.push(ticketRows[0].customer_name);
        }
    }

    // 2. Check if identifier is an Order ID (e.g. #51209 or 51209)
    if (!cleanPhone) {
        const orderId = parseOrderIdentifier(raw);
        if (orderId) {
            orderIds.push(orderId);
            // Look up store_shoppers
            const shopperRows = await dbAdapter.query(
                'SELECT phone, name, email, order_id FROM store_shoppers WHERE order_id = ? OR order_id = ? LIMIT 1',
                [orderId, `#${orderId}`]
            );
            if (shopperRows && shopperRows.length > 0) {
                const parsed = parsePhoneIdentifier(shopperRows[0].phone);
                if (parsed) cleanPhone = parsed.cleanPhone;
                if (shopperRows[0].name) nameCandidates.push(shopperRows[0].name);
                if (shopperRows[0].email) emailCandidates.push(shopperRows[0].email);
            }

            // Fallback: look up orders table
            if (!cleanPhone) {
                const orderRows = await dbAdapter.query(
                    'SELECT customer_phone, customer_name, customer_email FROM orders WHERE order_id = ? OR order_id = ? LIMIT 1',
                    [orderId, `#${orderId}`]
                );
                if (orderRows && orderRows.length > 0) {
                    const parsed = parsePhoneIdentifier(orderRows[0].customer_phone);
                    if (parsed) cleanPhone = parsed.cleanPhone;
                    if (orderRows[0].customer_name) nameCandidates.push(orderRows[0].customer_name);
                    if (orderRows[0].customer_email) emailCandidates.push(orderRows[0].customer_email);
                }
            }
        }
    }

    // 3. Check if identifier is a Phone number
    if (!cleanPhone) {
        const parsed = parsePhoneIdentifier(raw);
        if (parsed) {
            cleanPhone = parsed.cleanPhone;
        }
    }

    // 4. Check if identifier is an Email
    if (!cleanPhone && raw.includes('@')) {
        emailCandidates.push(raw.toLowerCase());
        const shopperRows = await dbAdapter.query(
            'SELECT phone, name FROM store_shoppers WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
            [raw]
        );
        if (shopperRows && shopperRows.length > 0) {
            const parsed = parsePhoneIdentifier(shopperRows[0].phone);
            if (parsed) cleanPhone = parsed.cleanPhone;
            if (shopperRows[0].name) nameCandidates.push(shopperRows[0].name);
        }
    }

    // 5. Check if identifier is a Customer Name
    if (!cleanPhone && raw.length >= 3 && !/^\d+$/.test(raw)) {
        const shopperRows = await dbAdapter.query(
            'SELECT phone, name, email FROM store_shoppers WHERE LOWER(name) LIKE LOWER(?) ORDER BY created_at DESC LIMIT 1',
            [`%${raw}%`]
        );
        if (shopperRows && shopperRows.length > 0) {
            const parsed = parsePhoneIdentifier(shopperRows[0].phone);
            if (parsed) cleanPhone = parsed.cleanPhone;
            if (shopperRows[0].name) nameCandidates.push(shopperRows[0].name);
            if (shopperRows[0].email) emailCandidates.push(shopperRows[0].email);
        }
    }

    if (!cleanPhone) return null;

    const phoneData = parsePhoneIdentifier(cleanPhone);
    const phoneVars = phoneData.variations;

    // Fetch verified name and email from customers / store_shoppers
    const [custRows, shopperProfileRows] = await Promise.all([
        dbAdapter.query(
            `SELECT name, email FROM customers WHERE phone IN (${phoneVars.map(() => '?').join(',')}) LIMIT 1`,
            phoneVars
        ).catch(() => []),
        dbAdapter.query(
            `SELECT name, email, order_id FROM store_shoppers WHERE phone IN (${phoneVars.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 5`,
            phoneVars
        ).catch(() => [])
    ]);

    if (custRows?.[0]?.name) nameCandidates.push(custRows[0].name);
    if (custRows?.[0]?.email) emailCandidates.push(custRows[0].email);

    for (const sh of (shopperProfileRows || [])) {
        if (sh.name) nameCandidates.push(sh.name);
        if (sh.email) emailCandidates.push(sh.email);
        if (sh.order_id && !orderIds.includes(sh.order_id)) orderIds.push(sh.order_id);
    }

    // Pick best name & email using quality scoring
    const bestName = selectBestCustomerName(nameCandidates);
    const bestEmail = selectBestCustomerEmail(emailCandidates);

    return {
        cleanPhone,
        formattedPhone: `+91${cleanPhone}`,
        variations: phoneVars,
        name: bestName,
        email: bestEmail,
        orderIds,
        ticketNumbers
    };
}

/**
 * Fetch raw message records, support tickets, and related return/exchange history.
 */
async function fetchInteractionData(customer) {
    const vars = customer.variations;
    const placeholders = vars.map(() => '?').join(',');

    const [messages, tickets, returns, exchanges, shoppers] = await Promise.all([
        // 1. WhatsApp messages (incoming and outgoing)
        dbAdapter.query(
            `SELECT id, customer_phone, message_type, message_content, status, created_at
             FROM messages
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC
             LIMIT 300`,
            vars
        ).catch(err => {
            console.warn('[CONV_HISTORY] messages query error:', err.message);
            return [];
        }),

        // 2. Support tickets
        dbAdapter.query(
            `SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, sentiment, ai_scenario, created_at, updated_at
             FROM support_tickets
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC
             LIMIT 50`,
            vars
        ).catch(err => {
            console.warn('[CONV_HISTORY] support_tickets query error:', err.message);
            return [];
        }),

        // 3. Returns
        dbAdapter.query(
            `SELECT return_id, order_id, reason, status, items, refund_amount, refund_status, pickup_scheduled_date, created_at, updated_at
             FROM returns
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC
             LIMIT 20`,
            vars
        ).catch(err => {
            console.warn('[CONV_HISTORY] returns query error:', err.message);
            return [];
        }),

        // 4. Exchanges
        dbAdapter.query(
            `SELECT exchange_id, order_id, reason, status, old_items, new_items, pickup_scheduled_date, created_at, updated_at
             FROM exchanges
             WHERE customer_phone IN (${placeholders})
             ORDER BY created_at ASC
             LIMIT 20`,
            vars
        ).catch(err => {
            console.warn('[CONV_HISTORY] exchanges query error:', err.message);
            return [];
        }),

        // 5. Shoppers notes / messages
        dbAdapter.query(
            `SELECT id, order_id, customer_message, status, created_at, updated_at
             FROM store_shoppers
             WHERE phone IN (${placeholders}) AND customer_message IS NOT NULL AND customer_message != ''
             ORDER BY created_at ASC
             LIMIT 10`,
            vars
        ).catch(err => {
            console.warn('[CONV_HISTORY] store_shoppers query error:', err.message);
            return [];
        })
    ]);

    return {
        messages: messages || [],
        tickets: tickets || [],
        returns: returns || [],
        exchanges: exchanges || [],
        shoppers: shoppers || []
    };
}

/**
 * Filter out pure automated broadcasts / marketing templates where customer never replied.
 * Retains all incoming customer messages, agent manual replies, bot answers to questions, and confirmations.
 */
function filterRelevantMessages(rawMessages) {
    if (!rawMessages || rawMessages.length === 0) return [];

    const relevant = [];
    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i];
        const content = String(msg.message_content || '').trim();
        const type = msg.message_type || '';

        // Inbound messages are always 100% relevant
        if (type === 'incoming') {
            relevant.push({
                ...msg,
                role: 'customer',
                cleanContent: content
            });
            continue;
        }

        // Direct agent manual replies or support responses
        if (type === 'manual_reply' || type === 'agent_reply' || type === 'outgoing') {
            // Ignore generic automated broadcast blasts if content looks like a marketing promo
            if (/offer|sale|discount\s*\d+%|use\s*code/i.test(content) && !/order|track|size|ticket|support|help/i.test(content)) {
                // If adjacent to a customer message within 2 hours, keep it, otherwise skip
                const hasNearbyCustomerMsg = rawMessages.some((m, idx) => 
                    m.message_type === 'incoming' && Math.abs(new Date(m.created_at) - new Date(msg.created_at)) < 2 * 3600 * 1000
                );
                if (!hasNearbyCustomerMsg) continue;
            }

            relevant.push({
                ...msg,
                role: 'agent',
                cleanContent: content
            });
            continue;
        }

        // System templates (e.g. order confirmation, delivery update)
        if (type === 'template') {
            // Keep order status templates (e.g., shipped, delivered, edit confirmation)
            if (/confirmed|shipped|dispatched|delivered|out\s*for\s*delivery|edit\s*details|cancelled/i.test(content)) {
                relevant.push({
                    ...msg,
                    role: 'system',
                    cleanContent: content
                });
            }
        }
    }

    return relevant;
}

/**
 * Cluster messages and tickets into conversational interaction sessions.
 * Consecutive interactions within 24-36 hours belong to the same session.
 */
function clusterInteractionSessions(messages, tickets, returns, exchanges, shoppers) {
    // Collect all timeline events
    const timeline = [];

    for (const m of messages) {
        timeline.push({
            type: 'message',
            role: m.role,
            content: m.cleanContent,
            rawType: m.message_type,
            timestamp: new Date(m.created_at),
            raw: m
        });
    }

    for (const t of tickets) {
        // Strip out AI suggested reply boilerplate if present
        const cleanMsg = (t.message || '').replace(/💡\s*\[AI SUGGESTED REPLY[\s\S]*?\][\s\S]*$/gi, '').trim();
        timeline.push({
            type: 'ticket',
            role: 'ticket',
            ticketNumber: t.ticket_number,
            status: t.status,
            content: cleanMsg,
            sentiment: t.sentiment,
            aiScenario: t.ai_scenario,
            timestamp: new Date(t.created_at),
            updatedAt: t.updated_at ? new Date(t.updated_at) : null,
            raw: t
        });
    }

    for (const sh of shoppers) {
        timeline.push({
            type: 'shopper_note',
            role: 'customer',
            orderId: sh.order_id,
            content: `Customer note on order #${sh.order_id}: "${sh.customer_message}"`,
            timestamp: new Date(sh.created_at),
            raw: sh
        });
    }

    // Sort chronologically
    timeline.sort((a, b) => a.timestamp - b.timestamp);

    if (timeline.length === 0) return [];

    const sessions = [];
    const SESSION_GAP_MS = 24 * 60 * 60 * 1000; // 24 hours gap starts a new session

    let currentSession = null;

    for (const event of timeline) {
        if (!currentSession) {
            currentSession = {
                id: `SESSION-${sessions.length + 1}`,
                startTime: event.timestamp,
                endTime: event.timestamp,
                events: [event],
                customerStatements: [],
                agentStatements: [],
                tickets: []
            };
        } else {
            const timeDiff = event.timestamp - currentSession.endTime;
            if (timeDiff > SESSION_GAP_MS) {
                // Finalize previous session
                sessions.push(currentSession);
                currentSession = {
                    id: `SESSION-${sessions.length + 1}`,
                    startTime: event.timestamp,
                    endTime: event.timestamp,
                    events: [event],
                    customerStatements: [],
                    agentStatements: [],
                    tickets: []
                };
            } else {
                currentSession.events.push(event);
                currentSession.endTime = event.timestamp;
            }
        }

        if (event.role === 'customer') {
            currentSession.customerStatements.push(event.content);
        } else if (event.role === 'agent') {
            currentSession.agentStatements.push(event.content);
        } else if (event.type === 'ticket') {
            currentSession.tickets.push(event);
            if (event.content) currentSession.customerStatements.push(event.content);
        }
    }

    if (currentSession && currentSession.events.length > 0) {
        sessions.push(currentSession);
    }

    // Process each session to extract issue, actions, resolution, status, and commitments
    return sessions.map((sess, idx) => {
        let status = 'resolved';

        // Check tickets in this session
        if (sess.tickets.length > 0) {
            const hasOpen = sess.tickets.some(t => t.status === 'open');
            status = hasOpen ? 'open' : 'resolved';
        } else if (idx === sessions.length - 1) {
            // Check if latest session ended with an unanswered customer message
            const lastEvent = sess.events[sess.events.length - 1];
            if (lastEvent.role === 'customer') {
                status = 'open';
            }
        }

        // Categorize customer inquiries
        const combinedCustText = sess.customerStatements.join(' ').toLowerCase();
        let topic = 'General Support Inquiry';

        if (/track|where\s*is|dispatch|delivery|status|shipment|courier|delayed|when\s*will/i.test(combinedCustText)) {
            topic = 'Delivery & Shipment Tracking';
        } else if (/size|fit|exchange|change\s*size|wrong\s*size|smaller|larger/i.test(combinedCustText)) {
            topic = 'Size & Exchange Request';
        } else if (/return|refund|money\s*back|cancel/i.test(combinedCustText)) {
            topic = 'Return & Refund Request';
        } else if (/edit|address|change\s*address|phone|modify/i.test(combinedCustText)) {
            topic = 'Order & Address Modification';
        } else if (/quality|damage|defective|torn|fabric|color/i.test(combinedCustText)) {
            topic = 'Product Quality & Defect Report';
        }

        const issueSummary = sess.customerStatements.length > 0
            ? sess.customerStatements.slice(0, 3).join('; ')
            : 'General support interaction';

        const actionSummary = sess.agentStatements.length > 0
            ? sess.agentStatements.slice(0, 3).join('; ')
            : (sess.tickets.length > 0 ? `Support ticket logged (${sess.tickets.map(t => t.ticketNumber).join(', ')})` : 'System automated update provided');

        return {
            id: sess.id,
            topic,
            startDate: formatDateTime(sess.startTime),
            endDate: formatDateTime(sess.endTime),
            startTimestamp: sess.startTime.toISOString(),
            endTimestamp: sess.endTime.toISOString(),
            status,
            customerInquiries: sess.customerStatements,
            agentResponses: sess.agentStatements,
            tickets: sess.tickets.map(t => ({ ticketNumber: t.ticketNumber, status: t.status })),
            issueSummary,
            actionSummary
        };
    });
}

/**
 * Detect explicit commitments from agent/bot messages, ticket notes, and return pickups.
 * STRICT: Step 6 requires: "Do not invent commitments that are not present in conversation history."
 * If no explicit promise was made, returns empty array.
 */
function extractExplicitCommitments(messages, tickets, returns, exchanges) {
    const commitments = [];

    // 1. Scan agent/outgoing messages for explicit promises
    const promiseRegexes = [
        {
            type: 'dispatch',
            regex: /\b(?:will\s*(?:be\s*)?dispatch(?:ed)?|dispatching\s*(?:within|in|by|tomorrow)?|ship(?:ping|ped)?\s*(?:within|in|by|tomorrow)?|deliver(?:ed|y)?\s*(?:within|by|on|tomorrow))\b/i,
            label: 'Dispatch / Delivery Commitment'
        },
        {
            type: 'refund',
            regex: /\b(?:refund(?:\s+of\s+₹?\d+(?:\.\d{2})?)?\s*(?:will\s*be\s*)?(?:initiated|processed|credited|refunded))\b/i,
            label: 'Refund Processing Commitment'
        },
        {
            type: 'pickup',
            regex: /\b(?:pickup\s*(?:is\s*)?(?:scheduled|arranged|will\s*be\s*done)\s*(?:on|for|by|within))\b/i,
            label: 'Pickup Arrangement Commitment'
        },
        {
            type: 'callback',
            regex: /\b(?:(?:our\s*team|agent|we)\s*will\s*(?:call|contact|reach\s*out|update)\s*you\s*(?:within|in|by|shortly|tomorrow))\b/i,
            label: 'Callback / Support Follow-up'
        },
        {
            type: 'replacement',
            regex: /\b(?:replacement\s*(?:will\s*be\s*sent|is\s*being\s*sent|order\s*has\s*been\s*created))\b/i,
            label: 'Replacement Dispatch'
        }
    ];

    for (const m of messages) {
        if (m.role !== 'agent' && m.message_type !== 'outgoing' && m.message_type !== 'manual_reply') continue;
        const text = String(m.cleanContent || m.message_content || m.content || '').trim();

        for (const pr of promiseRegexes) {
            if (pr.regex.test(text)) {
                // Extract sentence containing the promise
                const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
                const matchSentence = sentences.find(s => pr.regex.test(s)) || text.substring(0, 150);
                
                commitments.push({
                    type: pr.type,
                    label: pr.label,
                    commitment: matchSentence,
                    source: 'Agent WhatsApp Message',
                    date: formatDateTime(m.created_at),
                    timestamp: m.created_at
                });
            }
        }
    }

    // 2. Scan active return & exchange records for scheduled pickups or pending refunds
    for (const r of returns) {
        if (r.pickup_scheduled_date && ['initiated', 'pickup_scheduled'].includes(r.status)) {
            commitments.push({
                type: 'pickup',
                label: 'Return Courier Pickup',
                commitment: `Return pickup scheduled on ${formatDateOnly(r.pickup_scheduled_date)} for Order #${r.order_id}`,
                source: `Return Request (${r.return_id})`,
                date: formatDateOnly(r.pickup_scheduled_date),
                timestamp: r.created_at
            });
        }
        if (r.refund_status === 'pending' && r.refund_amount && parseFloat(r.refund_amount) > 0) {
            commitments.push({
                type: 'refund',
                label: 'Pending Refund',
                commitment: `Refund of ₹${r.refund_amount} pending upon item return inspection`,
                source: `Return Request (${r.return_id})`,
                date: formatDateOnly(r.created_at),
                timestamp: r.created_at
            });
        }
    }

    for (const ex of exchanges) {
        if (ex.pickup_scheduled_date && ['initiated', 'pickup_scheduled'].includes(ex.status)) {
            commitments.push({
                type: 'pickup',
                label: 'Exchange Courier Pickup',
                commitment: `Exchange pickup scheduled on ${formatDateOnly(ex.pickup_scheduled_date)} for Order #${ex.order_id}`,
                source: `Exchange Request (${ex.exchange_id})`,
                date: formatDateOnly(ex.pickup_scheduled_date),
                timestamp: ex.created_at
            });
        }
    }

    return commitments;
}

/**
 * Detect repeat issues across interaction sessions.
 */
function analyzeRepeatIssues(sessions) {
    if (!sessions || sessions.length <= 1) {
        return {
            isRepeat: false,
            count: sessions ? sessions.length : 0,
            category: null,
            details: 'Customer has only contacted us once (or has no prior interaction history).'
        };
    }

    // Group sessions by topic
    const topicCounts = {};
    for (const s of sessions) {
        topicCounts[s.topic] = (topicCounts[s.topic] || 0) + 1;
    }

    // Find if any topic occurred more than once
    let repeatTopic = null;
    let maxCount = 1;
    for (const [top, count] of Object.entries(topicCounts)) {
        if (count > maxCount && top !== 'General Support Inquiry') {
            maxCount = count;
            repeatTopic = top;
        }
    }

    if (repeatTopic && maxCount >= 2) {
        return {
            isRepeat: true,
            count: maxCount,
            category: repeatTopic,
            details: `Yes, this is a repeat issue: the customer has contacted support ${maxCount} times regarding "${repeatTopic}".`
        };
    }

    return {
        isRepeat: false,
        count: sessions.length,
        category: null,
        details: `Customer has contacted us ${sessions.length} times, but for different topics (${Object.keys(topicCounts).join(', ')}). No recurring unresolved issue.`
    };
}

/**
 * Main function to retrieve and summarize previous support interactions.
 * @param {string} customerIdentifier - Phone number, Order ID, Ticket Number, Email, or Name
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function getCustomerConversationHistory(customerIdentifier, options = {}) {
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

    // 2. Fetch raw interaction data
    const rawData = await fetchInteractionData(customer);

    const hasAnyRecord = (rawData.messages && rawData.messages.length > 0) ||
        (rawData.tickets && rawData.tickets.length > 0) ||
        (rawData.returns && rawData.returns.length > 0) ||
        (rawData.exchanges && rawData.exchanges.length > 0) ||
        (rawData.shoppers && rawData.shoppers.length > 0) ||
        (customer.orderIds && customer.orderIds.length > 0) ||
        (customer.name && customer.name !== 'Customer');

    if (!hasAnyRecord) {
        return {
            found: false,
            customerIdentifier,
            error: `Could not find any customer, order, or conversation records matching identifier "${customerIdentifier}".`
        };
    }

    // 3. Filter relevant messages (strip out unresponded marketing broadcast noise)
    const relevantMessages = filterRelevantMessages(rawData.messages);

    // 4. Group into interaction sessions
    const sessions = clusterInteractionSessions(
        relevantMessages,
        rawData.tickets,
        rawData.returns,
        rawData.exchanges,
        rawData.shoppers
    );

    // 5. Extract explicit commitments
    const explicitCommitments = extractExplicitCommitments(
        relevantMessages,
        rawData.tickets,
        rawData.returns,
        rawData.exchanges
    );

    // 6. Analyze repeat issues
    const repeatAnalysis = analyzeRepeatIssues(sessions);

    // 7. Find last contact date
    let lastContactDate = 'Not available';
    let lastInboundDate = null;
    if (rawData.messages.length > 0) {
        const incoming = rawData.messages.filter(m => m.message_type === 'incoming');
        if (incoming.length > 0) {
            const lastIncoming = incoming[incoming.length - 1];
            lastInboundDate = lastIncoming.created_at;
            lastContactDate = formatDateTime(lastInboundDate);
        } else {
            const lastMsg = rawData.messages[rawData.messages.length - 1];
            lastContactDate = formatDateTime(lastMsg.created_at);
        }
    } else if (rawData.tickets.length > 0) {
        const lastTkt = rawData.tickets[rawData.tickets.length - 1];
        lastContactDate = formatDateTime(lastTkt.created_at);
    }

    // 8. Build structured AI Summarization Format (Step 5)
    let previousIssue = 'None reported';
    let previousAction = 'None taken';
    let currentStatus = 'Resolved / No open issues';
    let outstandingCommitment = 'None';
    let relevantDates = `Last contact: ${lastContactDate}`;

    if (sessions.length > 0) {
        const latestSession = sessions[sessions.length - 1];
        previousIssue = latestSession.issueSummary || latestSession.topic;
        previousAction = latestSession.actionSummary || 'Assisted by support';
        
        // Overall current status
        const hasOpenTickets = rawData.tickets.some(t => t.status === 'open');
        const hasOpenReturns = rawData.returns.some(r => ['initiated', 'pickup_scheduled'].includes(r.status));
        const hasOpenExchanges = rawData.exchanges.some(e => ['initiated', 'pickup_scheduled'].includes(e.status));

        if (hasOpenTickets || hasOpenReturns || hasOpenExchanges || latestSession.status === 'open') {
            const parts = [];
            if (hasOpenTickets) parts.push('Open support ticket pending resolution');
            if (hasOpenReturns) parts.push('Active return request pending pickup/refund');
            if (hasOpenExchanges) parts.push('Active exchange request pending pickup/dispatch');
            if (!parts.length) parts.push('Open inquiry awaiting reply');
            currentStatus = parts.join('; ');
        } else {
            currentStatus = 'Resolved (All tickets and requests closed)';
        }

        // Outstanding commitment strictly per Step 6
        if (explicitCommitments.length > 0) {
            outstandingCommitment = explicitCommitments.map(c => `${c.label}: "${c.commitment}" (${c.date})`).join('; ');
        } else {
            outstandingCommitment = 'None';
        }

        // Relevant dates
        const dateParts = [`Last contact: ${lastContactDate}`];
        if (latestSession.startDate !== 'Not available' && latestSession.startDate !== lastContactDate) {
            dateParts.push(`Session start: ${latestSession.startDate}`);
        }
        if (explicitCommitments.length > 0 && explicitCommitments[0].date !== 'Not available') {
            dateParts.push(`Commitment date: ${explicitCommitments[0].date}`);
        }
        relevantDates = dateParts.join(' | ');
    }

    // Direct answers for the 5 officer questions (Step 4)
    const answersToOfficerQuestions = {
        whatCustomerToldUs: sessions.length > 0
            ? sessions.map(s => `[${s.startDate} - ${s.topic}]: ${s.issueSummary}`).join('\n')
            : 'No previous customer statements found in history.',
        whenDidTheyLastContactUs: lastContactDate !== 'Not available'
            ? `The customer last contacted us on ${lastContactDate}.`
            : 'No prior contact record found.',
        whatResolutionWasGiven: sessions.length > 0
            ? sessions.map(s => `[${s.topic} - Status: ${s.status}]: ${s.actionSummary}`).join('\n')
            : 'No resolution recorded as there are no previous support interactions.',
        didWePromiseAnything: explicitCommitments.length > 0
            ? explicitCommitments.map(c => `Yes, ${c.source} on ${c.date}: "${c.commitment}"`).join('\n')
            : 'None. No commitments or promises were made to this customer in conversation history.',
        isThisARepeatIssue: repeatAnalysis.details
    };

    return {
        found: true,
        customer: {
            name: customer.name,
            phone: customer.formattedPhone,
            cleanPhone: customer.cleanPhone,
            email: customer.email,
            associatedOrders: customer.orderIds
        },
        metrics: {
            totalMessagesExchanged: rawData.messages.length,
            totalSupportTickets: rawData.tickets.length,
            totalInteractionSessions: sessions.length,
            isRepeatIssue: repeatAnalysis.isRepeat,
            repeatIssueCount: repeatAnalysis.count,
            lastContactAt: lastContactDate
        },
        structuredSummary: {
            previousIssue,
            previousAction,
            currentStatus,
            outstandingCommitment,
            relevantDates
        },
        answersToOfficerQuestions,
        sessions,
        commitments: explicitCommitments,
        repeatAnalysis,
        tickets: rawData.tickets.map(t => ({
            ticketNumber: t.ticket_number,
            status: t.status,
            customerMessage: t.message,
            createdAt: formatDateTime(t.created_at)
        }))
    };
}

module.exports = {
    getCustomerConversationHistory,
    resolveCustomer,
    filterRelevantMessages,
    clusterInteractionSessions,
    extractExplicitCommitments,
    analyzeRepeatIssues,
    formatDateTime
};
