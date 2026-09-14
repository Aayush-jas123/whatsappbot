/**
 * igBotEngine.js
 * ─────────────────────────────────────────────────────────────
 * Instagram support bot for OFFCOMFRT.
 *
 * Responsibilities:
 *   - Detect customer intent from message text
 *   - Answer FAQs using the same knowledge base as WhatsApp
 *   - Handle order tracking flow
 *   - Handle return/exchange flow
 *   - Escalate to human agents (create support ticket)
 *   - Maintain conversation state per user
 *
 * SAFETY:
 *   - Does NOT call any WhatsApp service functions
 *   - Uses instagramService for all outbound messages
 *   - Reuses FAQ data from the existing system
 *   - Creates support tickets in the shared table (channel = 'instagram')
 * ─────────────────────────────────────────────────────────────
 */

const instagramService = require('../services/instagramService');
const { dbAdapter } = require('../database/db');

// ─── Intent Definitions ───────────────────────────────────────
// Each intent has keywords and a handler function.

const INTENTS = {
    greeting: {
        keywords: ['hi', 'hello', 'hey', 'good morning', 'good evening', 'good afternoon', 'sup', 'yo', 'hii', 'hiii', 'hola'],
        description: 'User is greeting us'
    },
    order_tracking: {
        keywords: ['track', 'tracking', 'where is my order', 'order status', 'order tracking', 'track order', 'track my order', 'awb', 'shipment status', 'delivery status'],
        description: 'User wants to track an order'
    },
    order_id: {
        keywords: ['ord-', 'order-', '#ord'],
        description: 'User sent an order ID'
    },
    return: {
        keywords: ['return', 'refund', 'money back', 'return policy', 'want to return', 'initiate return'],
        description: 'User wants to return a product'
    },
    exchange: {
        keywords: ['exchange', 'size change', 'wrong size', 'different size', 'swap', 'size exchange'],
        description: 'User wants to exchange a product'
    },
    shipping: {
        keywords: ['shipping', 'delivery', 'how long', 'when will i get', 'delivery time', 'shipping time', 'dispatch'],
        description: 'User asking about shipping'
    },
    payment: {
        keywords: ['payment', 'pay', 'cod', 'cash on delivery', 'payment methods', 'upi', 'how to pay'],
        description: 'User asking about payment'
    },
    cancellation: {
        keywords: ['cancel', 'cancellation', 'cancel order', 'dont want', 'don\'t want'],
        description: 'User wants to cancel'
    },
    product_info: {
        keywords: ['size chart', 'size guide', 'material', 'fabric', 'quality', 'color', 'colour', 'available size'],
        description: 'User asking about product details'
    },
    human_support: {
        keywords: ['support', 'agent', 'human', 'talk to someone', 'contact', 'customer care', 'help me', 'complaint', 'issue'],
        description: 'User wants human support'
    }
};

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
            const cleanMessage = (message || '').trim().toLowerCase();

            if (!cleanMessage && !options.isAttachment) return;

            // Get current bot state
            const botState = await instagramService.getBotState(igUserId);
            const currentState = botState?.state || 'idle';

            console.log(`[IG BOT] User ${igUserId} | State: ${currentState} | Msg: "${cleanMessage.substring(0, 50)}"`);

            // ── State machine: handle stateful flows ────────

            // Awaiting order ID for tracking
            if (currentState === 'awaiting_order_id') {
                return await this._handleOrderTracking(igUserId, cleanMessage);
            }

            // Awaiting return/exchange order ID
            if (currentState === 'awaiting_return_order_id') {
                return await this._handleReturnExchange(igUserId, cleanMessage, botState?.context);
            }

            // Awaiting support description
            if (currentState === 'awaiting_support_description') {
                return await this._createSupportTicket(igUserId, cleanMessage);
            }

            // ── Intent detection ────────────────────────────

            const intent = this._detectIntent(cleanMessage);

            // ── Route to handler ────────────────────────────

            switch (intent) {
                case 'greeting':
                    return await this._handleGreeting(igUserId);

                case 'order_tracking':
                    return await this._askForOrderId(igUserId, 'tracking');

                case 'return':
                    return await this._handleReturn(igUserId);

                case 'exchange':
                    return await this._handleExchange(igUserId);

                case 'shipping':
                    return await this._sendFAQ(igUserId, 'shipping');

                case 'payment':
                    return await this._sendFAQ(igUserId, 'payment');

                case 'cancellation':
                    return await this._sendFAQ(igUserId, 'cancellation');

                case 'product_info':
                    return await this._sendFAQ(igUserId, 'product_info');

                case 'human_support':
                    return await this._handleHumanSupport(igUserId);

                case 'order_id':
                    // User sent an order ID directly
                    return await this._handleOrderTracking(igUserId, cleanMessage);

                default:
                    return await this._handleUnknown(igUserId, cleanMessage);
            }

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

    // ─── Intent Detection ───────────────────────────────────────

    /**
     * Detect the user's intent from their message text.
     * Returns the intent key or 'unknown'.
     */
    _detectIntent(message) {
        if (!message) return 'unknown';

        // Check for order ID pattern first (e.g., ORD-XXXX, #ORD-XXXX)
        if (/^(ord[-#]|order[-#]|#ord)/i.test(message)) {
            return 'order_id';
        }

        // Score each intent by number of keyword matches
        let bestIntent = 'unknown';
        let bestScore = 0;

        for (const [intentName, intentDef] of Object.entries(INTENTS)) {
            let score = 0;
            for (const keyword of intentDef.keywords) {
                if (message.includes(keyword.toLowerCase())) {
                    score += keyword.length; // Longer keyword matches = higher confidence
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestIntent = intentName;
            }
        }

        return bestIntent;
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

        await instagramService.setBotState(igUserId, 'idle');
    }

    // ─── Order Tracking ─────────────────────────────────────────

    async _askForOrderId(igUserId, flow) {
        await instagramService.sendMessage(
            igUserId,
            `Track Your Order

Please send your Order ID (e.g., ORD-2024-001) or AWB number.

You can also find it in your order confirmation email.`
        );
        await instagramService.setBotState(igUserId, 'awaiting_order_id');
    }

    async _handleOrderTracking(igUserId, orderId) {
        // Reset state
        await instagramService.setBotState(igUserId, 'idle');

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
        await instagramService.setBotState(igUserId, 'awaiting_return_order_id', { flow: 'return' });
    }

    async _handleExchange(igUserId) {
        await instagramService.sendMessage(
            igUserId,
            IG_FAQ.exchange + '\n\nTo start an exchange, please send your Order ID.'
        );
        await instagramService.setBotState(igUserId, 'awaiting_return_order_id', { flow: 'exchange' });
    }

    async _handleReturnExchange(igUserId, orderId, context) {
        const flow = context?.flow || 'return';
        await instagramService.setBotState(igUserId, 'idle');

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
            await instagramService.setBotState(igUserId, 'idle');
            return;
        }

        // Ask user to describe their issue
        await instagramService.sendMessage(
            igUserId,
            `Contact Support

Please describe your issue below and we'll create a support ticket.

Our team will respond within 24 hours.`
        );
        await instagramService.setBotState(igUserId, 'awaiting_support_description');
    }

    async _createSupportTicket(igUserId, description) {
        await instagramService.setBotState(igUserId, 'idle');

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

        await dbAdapter.query(
            `INSERT INTO support_tickets (ticket_number, customer_phone, customer_name, message, status, channel, ig_user_id, ig_username, is_read)
             VALUES (?, ?, ?, ?, 'open', 'instagram', ?, ?, false)`,
            [
                ticketNumber,
                igUserId,
                customerName,
                description,
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

    // ─── Unknown / Fallback ─────────────────────────────────────

    async _handleUnknown(igUserId, message) {
        // Try to match against the existing FAQ database first
        const faqMatch = await this._tryFAQMatch(message, igUserId);
        if (faqMatch) return;

        // No match — offer help menu
        await instagramService.sendQuickReplies(
            igUserId,
            'I\'m not sure I understood that. Here\'s what I can help with:',
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
     * Reuses the same FAQ knowledge base as WhatsApp.
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
        } catch (e) {
            // FAQ handler not available
        }
        return false;
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
