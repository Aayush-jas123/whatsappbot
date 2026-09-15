/**
 * igBotEngine.js
 * ─────────────────────────────────────────────────────────────
 * Smart Instagram support bot for OFFCOMFRT.
 *
 * Responsibilities:
 *   - Classify customer intent via igSmartEngine (confidence scoring)
 *   - Manage conversation context (entities, order ID, creator info)
 *   - Handle stateful flows: tracking, return/exchange, support, creator
 *   - Detect intent switches mid-flow and re-route gracefully
 *   - Detect anger/sensitive issues and escalate smartly
 *   - Answer FAQs using the same knowledge base as WhatsApp
 *   - Escalate to human agents (create support ticket)
 *
 * SAFETY:
 *   - Does NOT call any WhatsApp service functions
 *   - Uses instagramService for all outbound messages
 *   - Reuses FAQ data from the existing system (read-only)
 *   - Creates support tickets in the shared table (channel = 'instagram')
 * ─────────────────────────────────────────────────────────────
 */

const instagramService = require('../services/instagramService');
const smartEngine = require('../services/igSmartEngine');
const { dbAdapter } = require('../database/db');

const STATES = smartEngine.STATES;
const CONFIDENCE = smartEngine.CONFIDENCE;

// Intents that open the creator/collaboration flow
const CREATOR_INTENTS = [
    'creator_collaboration', 'ugc', 'gifting', 'affiliate', 'wholesale', 'business_enquiry'
];

// Intents that are product problems (need order ID + human review)
const PRODUCT_ISSUE_INTENTS = ['delivery_issue', 'damaged_product', 'wrong_product'];

// ─── FAQ Answers (Instagram-formatted) ────────────────────────
// Same content as WhatsApp FAQ but without WhatsApp-specific
// markdown (*bold*). Instagram doesn't support markdown in DMs.

const IG_FAQ = {
    return: `OFFCOMFRT — RETURN POLICY

We accept return requests within 2 days of delivery.

How to initiate:
  Visit our returns page on the website.

Process:
  - Submit return request
  - Team reviews within 24-48 hours
  - Pickup at your doorstep
  - Store credit within 5-7 business days

Conditions:
  - Items unused, tags attached
  - Original packaging required`,

    exchange: `OFFCOMFRT — SIZE EXCHANGE

Free size exchanges within 2 days of delivery.

Visit our Exchange page on the website.

Process:
  - Select order and new size
  - We pick up the old item
  - New size shipped after quality check

Subject to stock availability.`,

    refund: `OFFCOMFRT — REFUNDS

Refunds are issued as store credit within 5-7 business days after pickup.

Share your Order ID and I'll check the refund status for you.`,

    shipping: `OFFCOMFRT — SHIPPING & DELIVERY

Metro cities: 2-3 business days
Other cities: 4-6 business days
Remote areas: 6-8 business days

Free shipping on orders above Rs.999
Rs.99 for orders below Rs.999

Send your Order ID for real-time tracking.`,

    payment: `OFFCOMFRT — PAYMENT METHODS

Credit/Debit Cards
UPI (GPay, PhonePe, Paytm)
Net Banking
Digital Wallets
Cash on Delivery (COD)

COD available up to Rs.5,000
Rs.50 COD handling charge`,

    product_info: `OFFCOMFRT — PRODUCT INFO

100% Premium Cotton
Pre-shrunk fabric
Colourfast dyes
OEKO-TEX certified

Care: Machine wash cold, tumble dry low`,

    cancellation: `OFFCOMFRT — CANCELLATION

Before Shipping: Free cancellation
After Shipping: Cannot cancel (return after delivery instead)

Send your Order ID and type "cancel" to proceed.`
};

// ─── Bot Engine Class ─────────────────────────────────────────

class IGBotEngine {
    /**
     * Process an incoming Instagram message for a user.
     *
     * @param {string} igUserId - Instagram PSID
     * @param {string} message  - Message text
     * @param {object} options  - { messageId, timestamp, isQuickReply, isPostback, referral, isAttachment }
     */
    async processMessage(igUserId, message, options = {}) {
        try {
            const cleanMessage = (message || '').trim();
            if (!cleanMessage && !options.isAttachment) return;

            // Get current bot state + conversation context
            const botState = await instagramService.getBotState(igUserId);
            const currentState = botState?.state || STATES.IDLE;
            let context = botState?.context || {};

            console.log(`[IG BOT] User ${igUserId} | State: ${currentState} | Msg: "${cleanMessage.substring(0, 50)}"`);

            // Referral entry (ad/link) — greet the user
            if (options.referral) {
                return await this._handleGreeting(igUserId);
            }

            // ── 1. Classify via smart engine (context-aware) ──────
            const result = smartEngine.classify(cleanMessage, context);

            // ── 2. Update conversation memory ─────────────────────
            context = smartEngine.updateContext(context, {
                intent: result.intent,
                entities: result.entities,
                summaryEntry: cleanMessage.substring(0, 120)
            });

            // ── 3. WAITING_FOR_CUSTOMER: team owes this customer a reply ──
            if (currentState === STATES.WAITING_FOR_CUSTOMER) {
                const handled = await this._handleWaitingForCustomer(igUserId, cleanMessage, context, result);
                if (handled) return;
                // Clear new request — resume normal flow below
            }

            // ── 4. Stateful flows (collecting order ID, creator info, etc.) ──
            const stateHandled = await this._handleStateful(igUserId, cleanMessage, currentState, context, result);
            if (stateHandled) return;

            // ── 5. Intent routing ─────────────────────────────────
            await this._routeIntent(igUserId, cleanMessage, result, context);

        } catch (error) {
            console.error('[IG BOT] processMessage error:', error);
            // Don't let bot errors crash the webhook
            try {
                await instagramService.sendMessage(
                    igUserId,
                    'We encountered an issue processing your message. Please try again or type "support" to reach our team.'
                );
            } catch (e) { /* ignore */ }
        }
    }

    // ─── Waiting For Customer ───────────────────────────────────

    /**
     * Customer replied while a flow was handed off to the team
     * (e.g., creator enquiry under review).
     *
     *   - Low-signal follow-ups: append to ticket + quiet ack, stay waiting
     *   - Clear new requests (high confidence / intent switch): resume flow
     *
     * @returns {boolean} true if handled (stay waiting), false to resume flow
     */
    async _handleWaitingForCustomer(igUserId, message, context, result) {
        const isClearNewRequest =
            result.isIntentSwitch ||
            (result.confidence >= CONFIDENCE.HIGH &&
             result.intent !== 'greeting' &&
             result.intent !== 'positive_message');

        if (isClearNewRequest) {
            await instagramService.setBotState(igUserId, STATES.IDLE, context);
            return false; // resume normal routing
        }

        // Follow-up while waiting — log to the linked ticket if any
        if (context.ticketId) {
            try {
                await dbAdapter.query(
                    `UPDATE support_tickets
                     SET message = message || '\n\n---\n' || ?,
                         is_read = false,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [message, context.ticketId]
                );
            } catch (e) { /* best-effort */ }
        }

        await instagramService.sendMessage(
            igUserId,
            'Got it — our team has this conversation and will update you right here shortly.'
        );
        return true; // handled — stay waiting
    }

    // ─── Stateful Flow Handling ─────────────────────────────────

    /**
     * Handle stateful conversation flows. Returns true if handled.
     */
    async _handleStateful(igUserId, message, state, context, result) {
        switch (state) {

            // ── Awaiting order ID for tracking ──
            case STATES.COLLECTING_ORDER_ID:
                if (result.intent === 'provide_order_id') {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    const id = result.entities.orderId || result.entities.awb || result.entities.bareNumber;
                    await this._handleOrderTracking(igUserId, id || message);
                    return true;
                }
                if (result.isIntentSwitch) {
                    await this._acknowledgeSwitch(igUserId);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                await this._askForOrderId(igUserId, 'tracking');
                return true;

            // ── Awaiting order ID for return/exchange ──
            case STATES.AWAITING_RETURN_ORDER_ID:
                if (result.intent === 'provide_order_id') {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    const id = result.entities.orderId || result.entities.bareNumber;
                    await this._handleReturnExchange(igUserId, id || message, context);
                    return true;
                }
                if (result.isIntentSwitch) {
                    await this._acknowledgeSwitch(igUserId);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                await instagramService.sendMessage(
                    igUserId,
                    'Please share the Order ID for your return/exchange (e.g., ORD-2024-001).'
                );
                return true;

            // ── Awaiting issue description for support ticket ──
            case STATES.AWAITING_SUPPORT_DESCRIPTION:
                if (result.isIntentSwitch) {
                    await this._acknowledgeSwitch(igUserId);
                    await this._routeIntent(igUserId, message, result, context);
                    return true;
                }
                if (message.length >= 3) {
                    await instagramService.setBotState(igUserId, STATES.IDLE, context);
                    await this._createSupportTicket(igUserId, message, context);
                    return true;
                }
                await instagramService.sendMessage(
                    igUserId,
                    'Please describe your issue in a few words so our team can help you.'
                );
                return true;

            // ── Collecting creator collaboration details ──
            case STATES.COLLECTING_CREATOR_PROFILE:
                // classify() special-cases this state → provide_creator_info.
                // Anything the user sends is treated as their details.
                await this._completeCreatorFlow(igUserId, context, message, result);
                return true;

            default:
                return false;
        }
    }

    /**
     * Brief acknowledgment when the user switches topics mid-flow.
     */
    async _acknowledgeSwitch(igUserId) {
        await instagramService.sendMessage(igUserId, "No problem — let's take care of that instead.");
    }

    // ─── Intent Routing ─────────────────────────────────────────

    async _routeIntent(igUserId, message, result, context) {
        const { intent } = result;

        switch (intent) {
            case 'greeting':
                return await this._handleGreeting(igUserId);

            case 'order_tracking':
                // If they already included an order ID, track right away
                if (result.entities.orderId || result.entities.awb) {
                    return await this._handleOrderTracking(
                        igUserId,
                        result.entities.orderId || result.entities.awb
                    );
                }
                return await this._askForOrderId(igUserId, 'tracking');

            case 'provide_order_id':
                return await this._handleOrderTracking(
                    igUserId,
                    result.entities.orderId || result.entities.awb || result.entities.bareNumber || message
                );

            case 'return':
                return await this._handleReturn(igUserId);

            case 'exchange':
                return await this._handleExchange(igUserId);

            case 'refund':
                return await this._sendFAQ(igUserId, 'refund');

            case 'shipping':
                return await this._sendFAQ(igUserId, 'shipping');

            case 'payment':
                return await this._sendFAQ(igUserId, 'payment');

            case 'cancellation':
                return await this._sendFAQ(igUserId, 'cancellation');

            case 'product_question':
            case 'size_question':
                return await this._sendFAQ(igUserId, 'product_info');

            case 'delivery_issue':
            case 'damaged_product':
            case 'wrong_product':
                return await this._handleProductIssue(igUserId, intent, context);

            case 'human_support':
                return await this._handleHumanSupport(igUserId);

            case 'complaint':
            case 'sensitive_issue':
                return await this._handleSmartEscalation(igUserId, result, context, message);

            case 'faq':
                return await this._handleUnknown(igUserId, message, context);

            default:
                if (CREATOR_INTENTS.includes(intent)) {
                    return await this._startCreatorFlow(igUserId, intent, context);
                }
                if (intent === 'spam') return; // silently ignore spam
                if (intent === 'positive_message') {
                    return await instagramService.sendMessage(
                        igUserId,
                        "Thank you so much! It means a lot. If you ever need anything, we're right here."
                    );
                }
                return await this._handleUnknown(igUserId, message, context);
        }
    }

    // ─── Greeting Handler ───────────────────────────────────────

    async _handleGreeting(igUserId) {
        // Fetch customer profile for personalization
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const name = customer?.[0]?.name || customer?.[0]?.ig_username || '';
        const greeting = name ? `Hi ${name}!` : 'Hi there!';

        await instagramService.sendQuickReplies(
            igUserId,
            `${greeting} Welcome to OffComfrt!

I can help you with:

• Track your order
• Returns & Exchanges
• FAQs
• Contact support

What would you like help with?`,
            [
                { title: 'Track Order', payload: 'track_order' },
                { title: 'Return', payload: 'return' },
                { title: 'Exchange', payload: 'exchange' },
                { title: 'Support', payload: 'support' }
            ]
        );

        await instagramService.setBotState(igUserId, STATES.IDLE);
    }

    // ─── Order Tracking ─────────────────────────────────────────

    async _askForOrderId(igUserId, flow) {
        await instagramService.sendMessage(
            igUserId,
            `Track Your Order

Please send your Order ID (e.g., ORD-2024-001) or AWB number.

You can also find it in your order confirmation email.`
        );
        await instagramService.setBotState(igUserId, STATES.COLLECTING_ORDER_ID);
    }

    async _handleOrderTracking(igUserId, orderId) {
        // Reset state
        await instagramService.setBotState(igUserId, STATES.IDLE);

        // Look up the order in the database
        const orders = await dbAdapter.query(
            `SELECT * FROM orders
             WHERE order_id ILIKE ? OR awb ILIKE ?
             ORDER BY created_at DESC LIMIT 1`,
            [`%${orderId}%`, `%${orderId}%`]
        );

        if (!orders || orders.length === 0) {
            await instagramService.sendMessage(
                igUserId,
                `Order not found.

Please check the Order ID and try again.

You can also type "support" to talk to our team.`
            );
            return;
        }

        const order = orders[0];
        const statusLabel = this._getStatusText(order.status);

        const trackingMsg = `ORDER STATUS

Order: ${order.order_id}
  Status: ${order.status || 'Processing'}${statusLabel ? ` (${statusLabel})` : ''}
${order.awb ? `  AWB: ${order.awb}` : ''}
${order.courier_name ? `  Courier: ${order.courier_name}` : ''}
${order.expected_delivery ? `  Expected: ${new Date(order.expected_delivery).toLocaleDateString('en-IN')}` : ''}
${order.tracking_url ? `  Track: ${order.tracking_url}` : ''}

Need help? Type "support" to contact us.`;

        await instagramService.sendMessage(igUserId, trackingMsg);
    }

    // ─── Return / Exchange ──────────────────────────────────────

    async _handleReturn(igUserId) {
        await instagramService.sendMessage(
            igUserId,
            IG_FAQ.return + '\n\nTo start a return, please send your Order ID.'
        );
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'return' });
    }

    async _handleExchange(igUserId) {
        await instagramService.sendMessage(
            igUserId,
            IG_FAQ.exchange + '\n\nTo start an exchange, please send your Order ID.'
        );
        await instagramService.setBotState(igUserId, STATES.AWAITING_RETURN_ORDER_ID, { flow: 'exchange' });
    }

    async _handleReturnExchange(igUserId, orderId, context) {
        const flow = context?.flow || 'return';
        await instagramService.setBotState(igUserId, STATES.IDLE);

        // Look up the order
        const orders = await dbAdapter.query(
            `SELECT * FROM orders WHERE order_id ILIKE ? ORDER BY created_at DESC LIMIT 1`,
            [`%${orderId}%`]
        );

        if (!orders || orders.length === 0) {
            await instagramService.sendMessage(
                igUserId,
                'Order not found. Please check the Order ID and try again.'
            );
            return;
        }

        const order = orders[0];

        // Check if within 2-day return window
        const orderDate = new Date(order.created_at);
        const daysSinceOrder = (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceOrder > 2) {
            await instagramService.sendMessage(
                igUserId,
                `Sorry, the return/exchange window (2 days from delivery) has expired for this order.\n\nType "support" if you need further assistance.`
            );
            return;
        }

        // Create a support ticket for the return/exchange
        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [
                ticketNumber,
                igUserId,
                customerName,
                `${flow.toUpperCase()} request for order ${order.order_id}`,
                igUserId,
                customer?.[0]?.ig_username || null
            ]
        );

        // Mark conversation as escalated
        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        if (ticketRows?.[0]?.id) {
            await instagramService.escalateToHuman(igUserId, ticketRows[0].id);
        }

        const flowLabel = flow === 'exchange' ? 'Exchange' : 'Return';
        await instagramService.sendMessage(
            igUserId,
            `${flowLabel} Request Created

Order: ${order.order_id}
Ticket: ${ticketNumber}

Our team will review and respond within 24 hours.

You can continue chatting here for updates.`
        );
    }

    // ─── Product Issues (delivery / damaged / wrong item) ───────

    /**
     * Product issue reported: apologize, collect order ID + description,
     * then the next message creates a priority support ticket.
     */
    async _handleProductIssue(igUserId, intent, context) {
        const issueLabel = {
            delivery_issue: 'delivery issue',
            damaged_product: 'damaged product',
            wrong_product: 'wrong item'
        }[intent] || 'issue';

        await instagramService.sendMessage(
            igUserId,
            `We're really sorry about the ${issueLabel}.

Please share your Order ID and a short description (a photo helps too) — I'll create a priority ticket for our team right away.`
        );

        // Remember the issue type so the ticket is labeled correctly
        context = smartEngine.updateContext(context, { lastQuestion: `${issueLabel} description` });
        context = { ...context, issueType: intent };
        await instagramService.setBotState(igUserId, STATES.AWAITING_SUPPORT_DESCRIPTION, context);
    }

    // ─── FAQ ────────────────────────────────────────────────────

    async _sendFAQ(igUserId, topic) {
        const answer = IG_FAQ[topic];
        if (answer) {
            await instagramService.sendMessage(igUserId, answer);
        } else {
            await instagramService.sendMessage(
                igUserId,
                'I don\'t have that information right now. Type "support" to talk to our team.'
            );
        }
    }

    // ─── Human Support / Escalation ─────────────────────────────

    async _handleHumanSupport(igUserId) {
        // Check if there's already an open ticket
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.sendMessage(
                igUserId,
                `You already have an open ticket: ${existingTicket[0].ticket_number}

Please describe your issue and our team will respond.

You can message us right here.`
            );
            await instagramService.escalateToHuman(igUserId, existingTicket[0].id);
            await instagramService.setBotState(igUserId, STATES.IDLE);
            return;
        }

        // Ask user to describe their issue
        await instagramService.sendMessage(
            igUserId,
            `Contact Support

Please describe your issue below and we'll create a support ticket.

Our team will respond within 24 hours.`
        );
        await instagramService.setBotState(igUserId, STATES.AWAITING_SUPPORT_DESCRIPTION);
    }

    async _createSupportTicket(igUserId, description, context = {}) {
        await instagramService.setBotState(igUserId, STATES.IDLE);

        if (!description || description.length < 3) {
            await instagramService.sendMessage(
                igUserId,
                'Please describe your issue in a few words so our team can help you.'
            );
            return;
        }

        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';

        // Label the ticket with the issue type (product issues route here)
        const issuePrefix = context.issueType
            ? `[${String(context.issueType).replace(/_/g, ' ')}] `
            : '';

        // Smart escalation summary gives agents instant context
        const smartSummary = smartEngine.buildEscalationSummary(context);
        const fullMessage = smartSummary
            ? `${issuePrefix}${description}\n\n--- Conversation context ---\n${smartSummary}`
            : `${issuePrefix}${description}`;

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [
                ticketNumber,
                igUserId,
                customerName,
                fullMessage,
                igUserId,
                customer?.[0]?.ig_username || null
            ]
        );

        // Get ticket ID and escalate
        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        if (ticketRows?.[0]?.id) {
            await instagramService.escalateToHuman(igUserId, ticketRows[0].id);
        }

        await instagramService.sendMessage(
            igUserId,
            `OFFCOMFRT — SUPPORT

Thank you, ${customerName}.

Your ticket has been created.

Ticket Number: ${ticketNumber}

Our team will respond within 24 hours.

You can continue messaging us here for updates.`
        );

        console.log(`[IG BOT] Created support ticket ${ticketNumber} for IG user ${igUserId}`);
    }

    // ─── Smart Escalation (anger / sensitive) ───────────────────

    /**
     * Complaint, anger or sensitive (legal) issue detected —
     * escalate immediately with the full conversation summary.
     */
    async _handleSmartEscalation(igUserId, result, context, message) {
        // Duplicate prevention: reuse an open ticket if one exists
        const existingTicket = await dbAdapter.query(
            `SELECT * FROM support_tickets
             WHERE ig_user_id = ? AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
            [igUserId]
        );

        if (existingTicket && existingTicket.length > 0) {
            await instagramService.escalateToHuman(igUserId, existingTicket[0].id);
            await instagramService.sendMessage(
                igUserId,
                `We hear you, and we're truly sorry.

Your open ticket ${existingTicket[0].ticket_number} has been marked as priority — a senior team member will respond here shortly.`
            );
            return;
        }

        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';

        const smartSummary = smartEngine.buildEscalationSummary(context);
        const ticketMessage = [
            `[PRIORITY — ${result.intent}${result.sentiment !== 'neutral' ? ` | sentiment: ${result.sentiment}` : ''}]`,
            `Customer: "${(message || '').substring(0, 500)}"`,
            '',
            smartSummary ? `--- Conversation context ---\n${smartSummary}` : null
        ].filter(Boolean).join('\n');

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [ticketNumber, igUserId, customerName, ticketMessage, igUserId, customer?.[0]?.ig_username || null]
        );

        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        if (ticketRows?.[0]?.id) {
            await instagramService.escalateToHuman(igUserId, ticketRows[0].id);
        }

        await instagramService.sendMessage(
            igUserId,
            `We hear you, and we're truly sorry about this experience.

I've flagged this as a priority — ticket ${ticketNumber}.

A senior team member will respond right here shortly.`
        );

        console.log(`[IG BOT] Smart escalation ${ticketNumber} for ${igUserId} (${result.intent}, sentiment: ${result.sentiment})`);
    }

    // ─── Creator / Business Flow ────────────────────────────────

    /**
     * Start the creator/collaboration flow — a separate mini
     * state machine that collects profile + collab details.
     */
    async _startCreatorFlow(igUserId, intent, context) {
        context = smartEngine.updateContext(context, {
            creatorInfo: { type: this._creatorTypeFor(intent) }
        });

        await instagramService.sendQuickReplies(
            igUserId,
            `Awesome — we'd love to work with you!

To get you to the right person, tell us a bit about yourself:
• Your Instagram handle
• Follower count
• The kind of collab you have in mind (paid collab / barter / UGC / affiliate)`,
            [
                { title: 'Paid Collab', payload: 'creator_paid' },
                { title: 'Barter / Gifting', payload: 'creator_barter' },
                { title: 'UGC', payload: 'creator_ugc' },
                { title: 'Affiliate', payload: 'creator_affiliate' }
            ]
        );

        await instagramService.setBotState(igUserId, STATES.COLLECTING_CREATOR_PROFILE, context);
    }

    /**
     * Complete the creator flow: capture details + create a
     * business-enquiry ticket, then hand off to the team.
     */
    async _completeCreatorFlow(igUserId, context, rawMessage, result = {}) {
        // Capture structured creator info from their message
        context = smartEngine.updateContext(context, {
            creatorInfo: result.entities?.creatorInfo || {}
        });
        if (rawMessage) {
            context.creatorInfo = {
                ...(context.creatorInfo || {}),
                rawNote: String(rawMessage).substring(0, 500)
            };
        }

        // Create a business-enquiry ticket with the collected details
        const ticketNumber = await this._generateTicketNumber();
        const customer = await dbAdapter.query(
            'SELECT name, ig_username FROM customers WHERE ig_psid = ? LIMIT 1',
            [igUserId]
        );
        const customerName = customer?.[0]?.name || customer?.[0]?.ig_username || 'Instagram Customer';
        const ci = context.creatorInfo || {};

        const ticketMessage = [
            `[Creator/Business enquiry — ${ci.type || 'general'}]`,
            `Customer: ${customerName}`,
            ci.profile ? `Profile: ${ci.profile}` : null,
            ci.followerMention ? `Followers: ${ci.followerMention}` : null,
            ci.rawNote ? `Message: "${ci.rawNote}"` : null
        ].filter(Boolean).join('\n');

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [ticketNumber, igUserId, customerName, ticketMessage, igUserId, customer?.[0]?.ig_username || null]
        );

        const ticketRows = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [ticketNumber]
        );
        const ticketId = ticketRows?.[0]?.id || null;

        // Hand off to the team — wait for the customer across sessions
        context = smartEngine.updateContext(context, {
            state: STATES.WAITING_FOR_CUSTOMER,
            summaryEntry: `Creator enquiry ticket ${ticketNumber}`
        });
        context.ticketId = ticketId;
        context.waitingSince = new Date().toISOString();
        await instagramService.setBotState(igUserId, STATES.WAITING_FOR_CUSTOMER, context);

        await instagramService.sendMessage(
            igUserId,
            `Thank you! Your details are with our partnerships team.

Ticket: ${ticketNumber}

They'll review and reply right here within 24-48 hours.`
        );

        console.log(`[IG BOT] Creator enquiry ${ticketNumber} for ${igUserId} (${ci.type || 'general'})`);
    }

    _creatorTypeFor(intent) {
        return {
            creator_collaboration: 'paid_collab',
            ugc: 'ugc',
            gifting: 'barter',
            affiliate: 'affiliate',
            wholesale: 'wholesale',
            business_enquiry: 'business'
        }[intent] || 'general';
    }

    // ─── Unknown / Fallback ─────────────────────────────────────

    async _handleUnknown(igUserId, message, context = {}) {
        // Try to match against the existing FAQ database first
        const faqMatch = await this._tryFAQMatch(message, igUserId);
        if (faqMatch) return;

        // Targeted clarification from the smart engine
        // (never a bare "I don't understand")
        const clarification = smartEngine.getClarificationQuestion(context);

        await instagramService.sendQuickReplies(
            igUserId,
            clarification,
            [
                { title: 'Track Order', payload: 'track_order' },
                { title: 'Return', payload: 'return' },
                { title: 'Exchange', payload: 'exchange' },
                { title: 'Shipping', payload: 'shipping' },
                { title: 'Payment', payload: 'payment' },
                { title: 'Support', payload: 'support' }
            ]
        );
    }

    /**
     * Try to match the message against the existing FAQ handler.
     * Reuses the same FAQ knowledge base as WhatsApp (read-only).
     */
    async _tryFAQMatch(message, igUserId) {
        try {
            const faqHandler = require('./faqHandler');
            const match = await faqHandler.matchFAQ(message);
            if (match) {
                // Convert WhatsApp-formatted answer to Instagram-friendly
                let igAnswer = match.answer || match.content || '';
                // Remove WhatsApp markdown asterisks
                igAnswer = igAnswer.replace(/\*/g, '');
                await instagramService.sendMessage(igUserId, igAnswer);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // ─── Helpers ────────────────────────────────────────────────

    async _generateTicketNumber() {
        const now = new Date();
        const yy = String(now.getFullYear()).slice(-2);
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const random = Math.floor(Math.random() * 9000 + 1000);
        const candidate = `IG-${yy}${mm}${dd}-${random}`;

        const existing = await dbAdapter.query(
            'SELECT id FROM support_tickets WHERE ticket_number = ? LIMIT 1',
            [candidate]
        );
        if (!existing || existing.length === 0) return candidate;

        // Retry with different random
        return `IG-${yy}${mm}${dd}-${Math.floor(Math.random() * 9000 + 1000)}`;
    }

    _getStatusText(status) {
        const statusMap = {
            'pending': 'Pending',
            'confirmed': 'Confirmed',
            'shipped': 'Shipped',
            'in_transit': 'In Transit',
            'delivered': 'Delivered',
            'cancelled': 'Cancelled',
            'returned': 'Returned'
        };
        return statusMap[status?.toLowerCase()] || '';
    }
}

module.exports = new IGBotEngine();
