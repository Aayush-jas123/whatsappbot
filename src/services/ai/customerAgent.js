/**
 * Customer-facing AI agent for the OFFCOMFRT support widget.
 *
 * Separate from the admin copilot (agent.js) — this agent helps shoppers
 * track orders, answers FAQs, and escalates to a support ticket when needed.
 *
 * Uses the same aiClient.js pipeline (Groq/Gemini) but with a customer-friendly
 * system prompt and a restricted tool set (read-only + ticket creation).
 *
 * Enhanced with:
 * - Multi-turn context tracking (orderId, awb, entities persist across turns)
 * - Entity extraction from messages (order IDs, AWBs, pin codes)
 * - Expanded tool set (search_orders_by_phone, faq_lookup, check_return_eligibility)
 * - Multi-language awareness (detects and responds in customer's language)
 */

const { chatCompletion, isConfigured, estimateTokens, computeCostUsd } = require('./aiClient');
const { getTool } = require('./tools');
const { dbAdapter } = require('../../database/db');
const { detectLanguage } = require('./autoSupportAgent');
const { getPortalIdForNewTicket } = require('../../utils/portalAssignment');

// ---------- Session store (in-memory, 30-min TTL) ----------

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;  // 15 min (was 30 — sessions are short-lived widget chats)
const MAX_HISTORY_TURNS = 10;
// Hard cap on concurrent sessions: TTL alone doesn't protect against
// scanner/bot traffic minting a fresh sessionId on every hit — without a
// cap the Map grows unbounded between cleanup ticks.
const MAX_SESSIONS = 200;  // lowered from 500 — widget sessions are short

function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return { history: [], context: {}, _fromDb: false };
    if (Date.now() - entry.lastAccess > SESSION_TTL_MS) {
        sessions.delete(sessionId);
        return { history: [], context: {}, _fromDb: false };
    }
    entry.lastAccess = Date.now();
    return { history: entry.history || [], context: entry.context || {} };
}

/**
 * Async version: if the in-memory session is missing or expired, try to
 * restore context (and recent history) from the database so the bot
 * remembers customer details like order IDs across page reloads.
 */
async function getSessionAsync(sessionId) {
    const sync = getSession(sessionId);
    if (sync.history.length > 0 || Object.keys(sync.context).length > 0) {
        return sync; // in-memory hit — use it
    }
    // In-memory miss — try to restore from DB
    try {
        const sessionRows = await dbAdapter.query(
            'SELECT context FROM widget_chat_sessions WHERE session_id = $1',
            [sessionId]
        );
        if (!sessionRows || !sessionRows.length) return { history: [], context: {} };

        const context = sessionRows[0].context || {};

        // Restore the last few conversation turns so the AI has continuity
        const recentMessages = await dbAdapter.query(
            `SELECT sender, content FROM widget_chats
             WHERE session_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [sessionId, MAX_HISTORY_TURNS * 2]
        );
        const history = (recentMessages || []).reverse().map(m => ({
            role: m.sender === 'customer' ? 'user' : 'assistant',
            content: String(m.content || '').slice(0, 500)
        }));

        // Populate in-memory cache so subsequent turns are fast
        saveSession(sessionId, history, context);
        return { history, context };
    } catch (err) {
        console.warn('[widget] session restore error:', err.message);
        return { history: [], context: {} };
    }
}

function saveSession(sessionId, history, context) {
    while (history.length > MAX_HISTORY_TURNS * 2) {
        history.shift();
    }
    sessions.set(sessionId, { history, context: context || {}, lastAccess: Date.now() });
    // Evict oldest (Map preserves insertion order; re-saved sessions move
    // to the tail on delete+set above via getSession/saveSession flow)
    while (sessions.size > MAX_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
    }
}

// Periodic cleanup of expired sessions (every 5 min — was 10, too slow for bot traffic)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
        if (now - entry.lastAccess > SESSION_TTL_MS) sessions.delete(key);
    }
    // Also enforce hard cap: evict oldest sessions if over limit
    while (sessions.size > MAX_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
    }
}, 5 * 60 * 1000).unref();

// ---------- SOP Scenario Detection ----------

function detectSopScenario(text) {
    if (!text) return null;
    const str = String(text).toLowerCase();

    // 1. Delayed / POD (delivered but not received)
    if (/delivered.*(not\s*(received|delivered|got|arrive)|haven'?t\s*received|missing|where|not\s*here|didn'?t\s*(get|receive)|nothing\s*arrived)|(not\s*(received|delivered)|haven'?t\s*received|didn'?t\s*receive).*delivered|fake\s*delivery|marked\s*delivered|pod\b|proof\s*of\s*delivery|delivery\s*(boy|partner|guy).*marked.*delivered/i.test(str)) {
        return 'delayed_pod';
    }

    // 2. Damaged / Wrong item
    if (/damaged|broken|torn|defective|faulty|stain|hole\s*in|wrong\s*(item|product|size|order|piece|dress|shirt)|received\s*wrong|different\s*(item|product)|unboxing\s*video|proof\s*of\s*damage|missing\s*(item|product|piece)/i.test(str)) {
        return 'damaged_wrong_item';
    }

    // 3. COD confusion (paid online, courier asking cash)
    if (/already\s*paid.*(cash|cod|asking|money|pay)|paid\s*online.*(cod|cash|money)|double\s*charge|asking.*(cash|money).*paid|(prepaid|paid).*(asking|demanding).*(cash|money|payment|cod)|(delivery\s*(boy|guy|man|person|partner)|courier).*(asking|demanding|wants?).*(money|cash|payment)|why.*(cod|cash).*(paid|prepaid)/i.test(str)) {
        return 'cod_confusion';
    }

    // 4. Size change / exchange
    if (/exchange|size\s*(change|swap|replace|too\s*(big|small|tight|loose))|different\s*size|smaller\s*size|larger\s*size/i.test(str)) {
        return 'size_exchange';
    }

    // 5. Address change
    if (/change.*address|update.*address|wrong\s*address|new\s*address|deliver.*to.*address|pincode\s*change/i.test(str)) {
        return 'address_change';
    }

    // 6. Cancellation
    if (/cancel\s*(order|my\s*order|this\s*order)?|don'?t\s*want.*order|stop\s*delivery/i.test(str)) {
        return 'cancellation';
    }

    // 7. Refund policy / money back
    if (/refund|money\s*back|return\s*money|bank\s*account|store\s*credit/i.test(str)) {
        return 'refund_policy';
    }

    // 8. Escalation / Frustration / Manager
    if (/call\s*me|phone\s*call|speak\s*to\s*(manager|supervisor|human|agent)|cheat|fraud|scam|terrible|worst|ridiculous|useless|legal|police|consumer\s*court/i.test(str)) {
        return 'escalation';
    }

    // 9. Tracking
    if (/track|status|where.*(is|my)|dispatch|shipped|courier|awb|delivery\s*date|when.*deliver/i.test(str)) {
        return 'tracking';
    }

    return null;
}

// ---------- Customer Sentiment & Frustration Detection (Change 13) ----------

function detectCustomerSentiment(text) {
    if (!text) return { isFrustrated: false, isUrgent: false, needsImmediateEscalation: false, triggers: [] };
    const str = String(text).toLowerCase();
    const triggers = [];

    // Severe anger, scam accusations, or legal threats
    const severeAngerPattern = /\b(cheat|cheated|cheating|fraud|scam|scammer|thief|chor|loot|bakwas|ganda|third\s*class|pathetic|disgusting|horrible|terrible|worst|worst\s*experience|useless|waste\s*of\s*money|nonsense|ridiculous|harassment|legal\s*(action|notice)?|police|consumer\s*(court|forum)|sue\s*you|complaint\s*against|fake\s*brand|fake\s*site)\b/i;
    const severeMatch = str.match(severeAngerPattern);
    if (severeMatch) {
        triggers.push(severeMatch[0]);
    }

    // Delay & delivery frustration
    const delayFrustrationPattern = /\b(still\s*not\s*delivered|taking\s*so\s*long|why\s*(so\s*)?late|why\s*delay|so\s*much\s*delay|waiting\s*for\s*(days|weeks)|kitna\s*time\s*lagega|kab\s*aayega|kab\s*milega|ab\s*tak\s*nahi\s*aaya|no\s*update|no\s*response|nobody\s*replying|ignoring\s*me|frustrated|irritated|disappointed|fed\s*up)\b/i;
    const delayMatch = str.match(delayFrustrationPattern);
    if (delayMatch) {
        triggers.push(delayMatch[0]);
    }

    // Urgent human or phone escalation demand
    const escalationPattern = /\b(speak\s*to\s*(a\s*)?(human|manager|supervisor|person|agent|team)|human\s*support|real\s*person|connect\s*(me\s*)?to\s*(human|agent|manager)|call\s*me|phone\s*call|give\s*me\s*your\s*number|phone\s*number|contact\s*number|urgent|immediately|jaldi|right\s*now)\b/i;
    const escMatch = str.match(escalationPattern);
    if (escMatch) {
        triggers.push(escMatch[0]);
    }

    const isFrustrated = triggers.length > 0;
    const isUrgent = !!escMatch || /urgent|immediately|jaldi|right\s*now/i.test(str);
    const needsImmediateEscalation = !!severeMatch || (isFrustrated && isUrgent);

    return {
        isFrustrated,
        isUrgent,
        needsImmediateEscalation,
        triggers
    };
}

// ---------- Entity extraction ----------

function extractEntities(text) {
    const entities = {};
    const str = String(text || '').trim();

    // Return/exchange request IDs: REQ-1234 to REQ-123456 (issued by the returns portal)
    const reqMatch = str.match(/\b(REQ-\d{4,6})\b/i);
    if (reqMatch) entities.requestId = reqMatch[1].toUpperCase();

    // AWB: only extract if explicitly labeled (AWB:, tracking:, courier:) or 12+ digits alongside tracking keywords.
    // Bare 10-digit numbers are mobile numbers, NOT AWBs.
    const awbLabeledMatch = str.match(/\b(?:AWB|tracking|courier)[-_ :]*(\d{10,16})\b/i);
    if (awbLabeledMatch) {
        entities.awb = awbLabeledMatch[1];
    } else {
        const awbBareMatch = str.match(/\b(\d{12,16})\b/);
        const hasTrackingKeyword = /\b(track|tracking|courier|shipment|dispatch|delivered|shipping)\b/i.test(str);
        if (awbBareMatch && hasTrackingKeyword) entities.awb = awbBareMatch[1];
    }

    // Mobile Phone Number (10 digits starting with 6-9)
    const phoneMatch = str.match(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/);
    if (phoneMatch) entities.phone = phoneMatch[1];

    // Order IDs: #1234, ORD-1234, #53388orderstatus, or standalone 4-6 digit order numbers (e.g. "53388")
    const orderMatch = str.match(/#(\d{4,6})/i)
        || str.match(/\b(?:ORD|ORDER)[-_ #]?(\d{4,6})\b/i)
        || str.match(/\b(\d{4,6})\b/)
        || str.match(/(\d{4,6})/);
    if (orderMatch) entities.orderId = orderMatch[1];

    // Pin code: 6-digit number (only if not already matched as orderId)
    const pinMatch = str.match(/\b([1-9]\d{5})\b/);
    if (pinMatch && pinMatch[1] !== entities.orderId) entities.pincode = pinMatch[1];

    // Detect SOP Scenario
    const scenario = detectSopScenario(str);
    if (scenario) entities.lastScenario = scenario;

    return entities;
}

// ---------- System prompt ----------

function buildSystemPrompt(context, language, sentiment) {
    const langInstruction =
        language === 'hindi'
            ? 'Respond in Hindi (Devanagari script).'
            : language === 'hinglish'
                ? 'Respond in Hinglish (Latin script, Hindi-English mix).'
                : 'Respond in English.';

    let contextStr = '';
    if (context.orderId) contextStr += `\n- Customer's order ID (from earlier in conversation): #${context.orderId}`;
    if (context.requestId) contextStr += `\n- Return/exchange request ID (from earlier): ${context.requestId}`;
    if (context.phone) contextStr += `\n- Customer's registered mobile number: ${context.phone}`;
    if (context.customerName) contextStr += `\n- Customer's name: ${context.customerName}`;
    if (context.awb) contextStr += `\n- AWB tracking number (from earlier): ${context.awb}`;
    if (context.pincode) contextStr += `\n- Pincode mentioned: ${context.pincode}`;
    if (context.lastScenario) contextStr += `\n- Active Detected Scenario: ${context.lastScenario} (adhere strictly to Scenario ${context.lastScenario} SOP rules below)`;
    if (context.supportTopic) contextStr += `\n- Current Support Topic: ${context.supportTopic}`;
    if (sentiment && sentiment.isFrustrated) {
        contextStr += `\n- CUSTOMER SENTIMENT: High Frustration / Dissatisfaction detected (Triggers: ${sentiment.triggers.join(', ')}). You MUST begin your response by empathetically validating their frustration and apologizing for the inconvenience before giving any facts.`;
    }

    return `You are the OFFCOMFRT customer support assistant — a helpful, empathetic, and SOP-compliant AI that assists shoppers with orders, tracking, returns, exchanges, and inquiries.

${langInstruction}

YOUR CAPABILITIES:
- Track orders using just the order number (a 4-5 digit number, e.g. 42000 or #42000)
- Tracking is resolved automatically from Shoppers Hub data — the customer never needs an AWB
- Check delivery status across multi-carrier partners (Shiprocket, Delhivery One, Ekart)
- Check live return/exchange request status from the returns system
- Verify return/exchange eligibility (within 2 days of delivery)
- Search customer orders by registered 10-digit mobile number
- Resolve customer questions strictly following company Standard Operating Procedures (SOP)
- Create a support ticket when an issue requires senior human support intervention

OFFCOMFRT 9 STANDARD OPERATING PROCEDURE (SOP) SCENARIOS:

1. **tracking** (Where is my order? / Status / Dispatch timeline):
   - Carrier sequence: Shiprocket (primary) → Delhivery One → Ekart (prepaid only).
   - If order is pending confirmation in Shoppers Hub: "Please confirm your order via the template message sent to you."
   - If order is confirmed in Shoppers Hub: "Your order is confirmed and will be shipped within 24 to 48 hours."
   - Dispatched orders typically take 3 to 5 business days for delivery.
   - CRITICAL: NEVER say "it hasn't been shipped yet" or "tracking not available".

2. **delayed_pod** (Tracking says Delivered but customer has NOT received package / Missing):
   - If tracking status is "Delivered":
     1. Reassure the customer empathetically. Explain that couriers occasionally mark packages as delivered right before arrival or leave them at building security, reception, or with neighbours.
     2. Ask customer to check with household members, building security guard, reception desk, or neighbours.
     3. State that we have requested official Proof of Delivery (POD) from our courier partner and will provide an update within 24 hours.
   - If the customer confirms they already checked security/neighbours, or requests an inquiry, create a support ticket tagged [POD_INVESTIGATION] immediately with the order details and 24-hour update SLA.

3. **refund_policy** (Refund / Money back / Return to bank account):
   - Original payment method refunds (takes 5-7 business days) are issued ONLY for:
     (a) Item damaged on arrival,
     (b) Wrong product delivered,
     (c) Prepaid order cancelled before dispatch / at confirmation,
     (d) RTO return without customer receipt.
   - ALL other returns (e.g. size exchange, fit, style preference, change of mind) receive STORE CREDIT ONLY.
   - NEVER promise a cash or bank refund for size exchanges or change-of-mind returns.

// Edit Requests (Size / Address / Cancellation before dispatch)
4. **size_exchange** (Size change / Exchange request):
   - Pre-dispatch: Size changes can be made before shipping. Ask for order number, item name, and desired new size.
   - Post-delivery: Size exchanges are available within 2 days of delivery at offcomfrt.in/pages/return (or offcomfrt.in/pages/exchange).
   - Items must be unused, with original tags and packaging intact. Subject to stock availability.

5. **damaged_wrong_item** (Received damaged / defective / wrong product):
   - Proof is MANDATORY before replacement or refund:
     - Wrong product delivered: Unboxing video is MANDATORY showing the outer courier package and shipping label being opened to reveal the item.
     - Damaged / defective product: Clear photos of the damaged/defective area with original product tags attached are required.
   - Must be submitted within 2 days of delivery at offcomfrt.in/pages/return.
   - Once verified by our team, this qualifies for a full refund to original payment method or free replacement.
   - Offer to create an expedited support ticket tagged [DAMAGED_ITEM_CLAIM] or [WRONG_ITEM_CLAIM] if the customer needs immediate assistance.

6. **address_change** (Change / Update delivery address):
   - Pre-dispatch: Can be updated before shipping. Ask for complete updated delivery address with 6-digit pin code.
   - Post-dispatch: Active shipments in transit cannot be rerouted mid-way.
     - Prepaid: Wait for courier to return to origin (RTO) for re-dispatch, or cancel in-transit for a fresh order.
     - COD: Fresh order can be dispatched immediately to the updated address.

7. **cod_confusion** (Already paid online but courier asking for COD cash):
   - Root cause: An "Edit Details" or address modification converted the order to COD without re-applying the prepaid discount.
   - Resolution: Reassure the customer empathetically. Instruct them to accept the package and pay the delivery executive at the door so the shipment is not rejected or returned to origin (RTO); OFFCOMFRT will refund that exact paid amount back (collected cash) to their original payment method or bank account separately upon verification. Offer to create a support ticket tagged [COD_DOUBLE_PAYMENT_REFUND].

8. **cancellation** (Cancel order):
   - Pre-dispatch: Order can be cancelled before shipping.
     - Prepaid: Full refund processed to original payment method within 5-7 business days.
     - COD: Cancelled immediately with zero fee.
   - Post-dispatch / In transit: Shipments in transit cannot be intercepted mid-route.
     - Prepaid: Cancelled in transit; refund initiated upon return.
     - COD: Advise customer to simply refuse delivery when the courier arrives.

9. **escalation** (Frustrated customer / Want manager / Want phone callback):
   - Maintain a calm, empathetic, professional tone. Validate their feelings ("I completely understand your frustration...").
   - DO NOT offer or promise phone callbacks (we resolve all issues over chat and tickets).
   - Attempt to resolve over chat first. If the customer remains unsatisfied or requires manual team intervention, create a support ticket with full context.

EMPATHY & ACTIVE LISTENING PRINCIPLES (CUSTOMER FEELS HEARD):
1. **Validate feelings first**: When a customer is upset, complaining about delay, scam, bad experience, or demanding human escalation, ALWAYS acknowledge and validate their feelings BEFORE providing facts, tracking information, or policy rules.
   - Example (English): "I completely understand your frustration regarding the delay, and I sincerely apologize for the inconvenience this has caused you."
   - Example (Hinglish): "Main aapki pareshani bilkul samajh sakta hoon aur is delay ke liye dil se maafi chahta hoon."
   - Example (Hindi): "मैं आपकी परेशानी पूरी तरह समझ सकता हूँ और इस देरी के लिए आपसे क्षमा चाहता हूँ।"
2. **Never be defensive, robotic, or dismissive**: Never argue, blame the courier dismissively, or give cold, one-line policy denials.
3. **No phone callbacks**: Do NOT offer or promise phone callbacks under any circumstance (our support is strictly documented over chat, WhatsApp, and tickets). If they ask for a phone call or number, explain politely: "We provide support directly over WhatsApp and support tickets so our entire team can track and resolve your issue with complete documentation."
4. **Priority Escalation**: When legal threats, severe anger, or repeated complaints occur, apologize sincerely, de-escalate immediately, and offer our priority WhatsApp escalation or create an urgent support ticket.

${contextStr ? `CONVERSATION CONTEXT (from earlier messages):${contextStr}` : ''}

RULES:
- Be warm, concise, and helpful. Use short paragraphs (2-4 sentences max).
- PRIVACY & DATA PROTECTION (CRITICAL): NEVER share, confirm, or disclose personal customer information under any circumstances — including customer names, phone numbers, delivery/shipping addresses, or email addresses. If a customer or user asks for personal details, phone number, address, or name for an order, politely decline: "For privacy and security reasons, personal customer details like phone number and delivery address cannot be shared in chat." You may only share order status, ordered items, and shipping timeline.
- NEVER repeat information you already shared in this conversation.
- If the customer previously shared an order number, use it for follow-up questions without asking again.
- PERSISTENT CONTEXT RETENTION: If the customer's Order ID, phone number, or return request ID is already known in CONVERSATION CONTEXT above, NEVER ask them to provide their order number, phone number, or repeat their issue again. Immediately proceed using the known order ID or phone number with lookup tools or in your explanation.
- To track, you only need the order number (a 4-5 digit number, "#" prefix optional). ONLY call track_order_by_id or other lookup tools when the customer explicitly asks to track, check status, or find their order.
- A standalone 10-digit number is a MOBILE PHONE NUMBER. Never treat it as an order ID or AWB. If the customer shares their phone number, use search_orders_by_phone to look up their recent orders.
- NEVER ask the customer for an AWB / courier tracking number — the system resolves tracking internally from the order ID.
- When the customer asks about a return, exchange, refund, or pickup they already submitted, use check_return_exchange_status to fetch the LIVE status.
- If you cannot resolve the issue after 2-3 attempts, offer to create a support ticket.
- CRITICAL: When the customer has already explained their issue (even briefly, like "applied for return" or "order not delivered"), DO NOT ask for more details or explain the situation. Immediately create a support ticket using the information already provided.
- Amounts are in INR. Times are in IST (UTC+5:30).`;
}

// ---------- Customer tool set ----------

const CUSTOMER_TOOLS = [
    'shopify_search_orders',
    'track_order_by_id',
    'track_awb',
    'check_serviceability',
    'search_orders_by_phone',
    'faq_lookup',
    'check_return_eligibility',
    'check_return_exchange_status',
    'query_returns_system'
];

function getCustomerToolSchemas() {
    const { tools } = require('./tools');
    return tools
        .filter(t => CUSTOMER_TOOLS.includes(t.name))
        .map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
}

/**
 * Record an entity (e.g. order ID typed into the direct tracking flow)
 * into the AI session context so follow-up questions like "where is my
 * order" already know which order the customer means.
 */
async function noteSessionContext({ sessionId, entities }) {
    if (!sessionId || !entities) return;
    const session = await getSessionAsync(sessionId);
    const context = { ...session.context, ...entities };
    saveSession(sessionId, session.history, context);
    // Persist context to DB immediately
    persistContextToDb(sessionId, context).catch(err => console.warn('[widget] context persist error:', err.message));
}

/**
 * Append a synthetic exchange to the session history (used when the widget
 * handles something outside the AI chat, e.g. the direct tracking card) so
 * subsequent AI turns see it as prior conversation. No LLM call is made.
 */
async function appendSessionExchange({ sessionId, userMessage, botMessage, entities }) {
    if (!sessionId) return;
    const session = await getSessionAsync(sessionId);
    if (userMessage) session.history.push({ role: 'user', content: String(userMessage).slice(0, 500) });
    if (botMessage) session.history.push({ role: 'assistant', content: String(botMessage).slice(0, 500) });
    const context = entities ? { ...session.context, ...entities } : session.context;
    saveSession(sessionId, session.history, context);
    if (entities) persistContextToDb(sessionId, context).catch(err => console.warn('[widget] context persist error:', err.message));
}

// ---------- PII Data Sanitization ----------

/**
 * Recursively strip sensitive personal data (phone numbers, addresses, customer names, emails)
 * from tool results before passing them to the customer-facing LLM.
 */
function sanitizeCustomerToolResult(data) {
    if (!data || typeof data !== 'object') {
        if (typeof data === 'string') {
            return data
                .replace(/\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, '[REDACTED]')
                .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED]');
        }
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => sanitizeCustomerToolResult(item));
    }

    const PII_KEYS = /^(phone|customer_phone|consignee_phone|mobile|telephone|contact_number|customer_email|email|shipping_address|billing_address|address|address1|address2|street|consignee_address|customer_name|shopper_name|full_name)$/i;

    const cleaned = {};
    for (const [key, val] of Object.entries(data)) {
        if (PII_KEYS.test(key)) {
            continue;
        }
        if (key.toLowerCase() === 'customer') {
            continue;
        }
        if (key.toLowerCase() === 'name') {
            if (typeof val === 'string' && (/^#?\d{4,6}$/.test(val.trim()) || /order/i.test(val))) {
                cleaned[key] = val;
            }
            continue;
        }
        cleaned[key] = sanitizeCustomerToolResult(val);
    }
    return cleaned;
}

// ---------- SOP Refund vs. Store Credit Guardrails ----------

/**
 * Enforce strict OFFCOMFRT SOP rules on refunds:
 * - Original payment method refunds (5-7 business days) ONLY for:
 *   (a) Damaged on arrival
 *   (b) Wrong item delivered
 *   (c) Prepaid order cancelled before dispatch
 *   (d) RTO without receipt
 * - ALL other returns (size exchange, fit, style preference, change of mind) receive STORE CREDIT ONLY.
 * - This post-generation validator intercepts and corrects any hallucinated promise of a cash/bank refund.
 */
function applyRefundGuardrails(reply, userMessage, context) {
    if (!reply) return reply;
    const msg = String(userMessage || '').toLowerCase();
    const rep = String(reply).toLowerCase();

    // Check if customer query or context is about size, fit, or preference/change of mind
    const isSizeOrPreference = /size|fit|tight|loose|small|large|medium|exchange|don'?t\s*like|didn'?t\s*like|preference|changed?\s*my\s*mind|wrong\s*fit/i.test(msg)
        || (context && (context.lastScenario === 'size_exchange' || context.lastScenario === 'return_exchange'));

    // Check if query is explicitly about damaged product or wrong item delivered
    const isDamagedOrWrong = /damage|broken|torn|defective|faulty|stain|hole|wrong\s*(product|item|piece|order|size)|received\s*wrong|different\s*(item|product)|unboxing\s*video/i.test(msg)
        || (context && context.lastScenario === 'damaged_wrong_item');

    // Check if query is a pre-dispatch cancellation
    const isCancellation = /cancel/i.test(msg) || (context && context.lastScenario === 'cancellation');

    // Check if query is COD confusion / double payment refund (SOP Scenario 7)
    const isCodConfusion = /already\s*paid.*(cash|cod|asking|money)|paid\s*online.*(cod|cash|money)|double\s*charge|asking.*(cash|money).*paid|(prepaid|paid).*(asking|demanding).*(cash|money|payment|cod)|(delivery\s*(boy|guy|man|person|partner)|courier).*(asking|demanding|wants?).*(money|cash|payment)|cod\s*refund|paid\s*twice/i.test(msg)
        || (context && context.lastScenario === 'cod_confusion');

    // Check if reply promises original payment / bank / cash / card refund
    const promisesCashRefund = /refund(ed)?\s*(to|into|in)?\s*(your|the)?\s*(bank|account|original\s*payment|source|upi|card|mode)/i.test(rep)
        || /credited\s*(back)?\s*to\s*(your|the)?\s*(bank|account|source|card|upi)/i.test(rep)
        || /money\s*back\s*(to|into|in)\s*(your)?\s*(bank|account)/i.test(rep);

    // Case 1: Size/fit/preference returns MUST NOT receive bank/original payment refunds
    if (isSizeOrPreference && !isDamagedOrWrong && !isCancellation && !isCodConfusion) {
        if (promisesCashRefund || !/store\s*credit/i.test(rep)) {
            return "As per our return policy, returns for size, fit, or preference are provided as **store credit** only. Original payment method refunds (within 5 to 7 business days) are issued strictly for damaged products, wrong items delivered, or cancellations before dispatch. You can submit your exchange or return request within 2 days of delivery at offcomfrt.in/pages/return.";
        }
    }

    // Case 2: Customer specifically asks for bank/cash refund for general returns (without damage/wrong item/COD issue)
    const asksBankRefund = /bank|cash|original\s*payment|source|account|upi|google\s*pay|phonepe/i.test(msg) && /refund|money/i.test(msg);
    if (asksBankRefund && !isDamagedOrWrong && !isCancellation && !isCodConfusion) {
        if (!/store\s*credit/i.test(rep) || promisesCashRefund) {
            return "Refunds to the original payment method (within 5 to 7 business days) are provided strictly for damaged products, wrong items delivered, or cancellations before dispatch. All other returns (such as size, fit, or preference) receive **store credit only**. Requests can be submitted within 2 days of delivery at offcomfrt.in/pages/return.";
        }
    }

    return reply;
}

// ---------- Main chat function ----------

/**
 * Run one customer widget turn.
 * @param {object} opts
 * @param {string} opts.sessionId  - Client-generated session UUID
 * @param {string} opts.message    - Customer's message
 * @returns {{ reply: string, suggestedAction: string|null }}
 */
async function runCustomerAgent({ sessionId, message, visitorId, entities }) {
    if (!isConfigured()) {
        return {
            reply: 'Our support assistant is currently unavailable. Please reach out to us on WhatsApp for help.',
            suggestedAction: null
        };
    }

    const session = await getSessionAsync(sessionId);
    const toolSchemas = getCustomerToolSchemas();

    // Extract entities from this message and merge with client-supplied entities and session context
    const newEntities = extractEntities(message);
    const context = { ...session.context, ...(entities || {}), ...newEntities };
    saveSession(sessionId, session.history, context);
    if (Object.keys(context).length > 0) {
        persistContextToDb(sessionId, context).catch(err => console.warn('[widget] context persist error:', err.message));
    }

    // Detect language & sentiment
    const language = detectLanguage(message);
    const sentiment = detectCustomerSentiment(message);

    const systemPrompt = buildSystemPrompt(context, language, sentiment);

    // If the customer asks about an order/return without repeating the number,
    // remind the model of the IDs we already have so it never asks again.
    let userContent = message;
    const hasKnownId = context.orderId || context.requestId;
    if (hasKnownId && !newEntities.orderId && !newEntities.requestId && /track|status|where(\s+is)|deliver|ship|return|exchange|refund|pickup|kaha|kya\s+status/i.test(message)) {
        const idNote = [
            context.orderId ? `order ID ${context.orderId}` : null,
            context.requestId ? `return/exchange request ID ${context.requestId}` : null
        ].filter(Boolean).join(' and ');
        userContent = `${message}\n\n[System note: the customer's ${idNote} from earlier in this conversation is known. Use it directly with the tools (track_order_by_id, check_return_exchange_status, check_return_eligibility) — do NOT ask for the order/request number again.]`;
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        ...session.history,
        { role: 'user', content: userContent }
    ];

    let reply = null;
    let returnCard = null;
    const MAX_ROUNDS = 3;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalToolCalls = 0;
    let usedModel = null;

    for (let round = 0; round <= MAX_ROUNDS; round++) {
        const { message: aiMessage, usage, model } = await chatCompletion({
            messages,
            tools: toolSchemas.length ? toolSchemas : undefined,
            maxTokens: 400,
            temperature: 0.4
        });

        if (usage) {
            totalPromptTokens += usage.prompt_tokens || 0;
            totalCompletionTokens += usage.completion_tokens || 0;
        }
        if (model) usedModel = model;

        const toolCalls = aiMessage.tool_calls || [];
        totalToolCalls += toolCalls.length;
        if (!toolCalls.length) {
            reply = aiMessage.content || 'Let me know if there is anything else I can help with!';
            break;
        }

        if (round === MAX_ROUNDS) {
            reply = aiMessage.content || 'I was unable to complete the lookup. Would you like to speak with a support agent?';
            break;
        }

        messages.push(aiMessage);

        for (const call of toolCalls) {
            const name = call.function?.name;
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep {} */ }

            const tool = getTool(name);
            let result;

            if (!tool) {
                result = { error: `Unknown tool: ${name}` };
            } else {
                try {
                    result = await tool.execute(args, { isCustomerFacing: true });
                } catch (e) {
                    result = { error: e.message };
                }
            }

            result = sanitizeCustomerToolResult(result);

            // Clamp result size — guard against undefined/null results from tools
            if (result === undefined || result === null) result = { error: 'Tool returned no data' };
            let json = JSON.stringify(result);
            if (json.length > 3000) json = json.substring(0, 3000) + '...';

            messages.push({ role: 'tool', tool_call_id: call.id, content: json });

            // Surface the newest return/exchange request as a rich status card
            if (name === 'check_return_exchange_status' && result && result.found && (result.returns?.length || result.exchanges?.length)) {
                returnCard = buildReturnCard(result);
            }
        }
    }

    if (reply === null) reply = 'Sorry, I could not process your request. Please try again or contact support.';

    // ── SOP Refund vs. Store Credit Guardrails ──
    reply = applyRefundGuardrails(reply, message, context);

    // ── Privacy & PII Leak Guard ──
    const piiRequestPattern = /\b(customer\s*(details?|info\w*|name|phone|number|address|email)|phone\s*(no|number)?|mobile\s*(no|number)?|shipping\s*address|delivery\s*address|consignee|who\s*(ordered|placed|bought|is\s*the\s*customer))\b/i;
    const privacyRefusal = 'For privacy and security reasons, personal customer details like phone number and delivery address cannot be shared in chat.';

    if (piiRequestPattern.test(message)) {
        const containsRefusal = /privacy|cannot (be )?shared|security reasons|confidential|do not share/i.test(reply);
        if (!containsRefusal) {
            reply = `${privacyRefusal} If you need help with order tracking, return/exchange, or order status, I'd be happy to assist!`;
        }
    }

    // Always mask any stray phone numbers or emails in the reply
    reply = reply
        .replace(/\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, '[REDACTED]')
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED]');

    // Update context with detected scenario from reply
    if (reply) {
        if (/delivered.*(not\s*(received|delivered|got)|missing|haven'?t)|fake\s*delivery|pod\b|proof\s*of\s*delivery/i.test(message)) context.lastScenario = 'delayed_pod';
        else if (/damage|broken|torn|defective|faulty|wrong\s*(item|product|piece)|received\s*wrong|unboxing/i.test(message)) context.lastScenario = 'damaged_wrong_item';
        else if (/track|order|status|deliver|ship/i.test(message)) context.lastScenario = 'tracking';
        else if (/return|exchange|size/i.test(message)) context.lastScenario = 'return_exchange';
        else if (/cancel/i.test(message)) context.lastScenario = 'cancellation';
        else if (/already\s*paid.*(cash|cod)|paid\s*online.*(cod|cash)|courier.*asking.*(cash|money)|delivery.*asking.*(cash|money)/i.test(message)) context.lastScenario = 'cod_confusion';
        else if (/refund|money back/i.test(message)) context.lastScenario = 'refund';
    }

    // Detect if the AI or sentiment is suggesting escalation
    let suggestedAction = null;
    if (sentiment.needsImmediateEscalation) {
        suggestedAction = 'whatsapp_escalation';
    } else if (/ticket|support agent|human agent|whatsapp|escalat/i.test(reply)) {
        suggestedAction = 'create_ticket';
    }

    // Build priority WhatsApp escalation link
    const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
    const prefilledText = `Hi OFFCOMFRT Support, I need urgent assistance.\n${context.orderId ? 'Order: #' + context.orderId + '\n' : ''}Issue: ${message.substring(0, 150)}`;
    const whatsappLink = businessNumber ? `https://wa.me/${businessNumber}?text=${encodeURIComponent(prefilledText)}` : null;

    // Save session with updated context
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: reply });
    saveSession(sessionId, session.history, context);

    // ── Persist to database (fire-and-forget — never block the response) ──
    const totalCost = computeCostUsd(totalPromptTokens, totalCompletionTokens);
    persistWidgetChat(sessionId, message, reply, {
        model: usedModel,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        costUsd: totalCost,
        toolCalls: totalToolCalls,
        suggestedAction,
        entities: Object.keys(context).length ? context : null,
        richContent: returnCard ? { type: 'return_status', data: returnCard } : null,
        visitorId
    }).catch(err => console.warn('[widget] persist error:', err.message));

    return {
        reply,
        suggestedAction,
        cardType: returnCard ? 'return' : null,
        cardData: returnCard,
        entities: context,
        sentiment: sentiment.isFrustrated ? 'frustrated' : 'neutral',
        whatsappLink,
        usage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, cost_usd: totalCost }
    };
}

// ---------- Return/Exchange status card ----------

/** Human-friendly label for a stored return/exchange status. */
function humanizeReturnStatus(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pending_approval') return 'Under Review';
    if (s === 'approved') return 'Approved';
    if (s === 'pickup_scheduled') return 'Pickup Scheduled';
    if (s === 'rejected') return 'Rejected';
    if (s === 'completed' || s === 'refunded') return 'Completed';
    if (!s) return 'Pending';
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

/**
 * Build the widget return/exchange status card payload from a
 * check_return_exchange_status tool result (newest request wins).
 */
function buildReturnCard(result) {
    const latestReturn = (result.returns || [])[0];
    const latestExchange = (result.exchanges || [])[0];

    // Guard: if both are missing there is nothing to render
    if (!latestReturn && !latestExchange) return null;

    const newest = (() => {
        if (latestReturn && latestExchange) {
            return new Date(latestExchange.created_at) > new Date(latestReturn.created_at)
                ? { kind: 'exchange', row: latestExchange }
                : { kind: 'return', row: latestReturn };
        }
        return latestReturn ? { kind: 'return', row: latestReturn } : { kind: 'exchange', row: latestExchange };
    })();

    const { kind, row } = newest;
    if (!row) return null;
    const card = {
        type: kind === 'return' ? 'Return' : 'Exchange',
        status: humanizeReturnStatus(row.status),
        orderId: row.order_id || null,
        reason: row.reason || null,
        eta: row.pickup_scheduled_date ? `Pickup on ${String(row.pickup_scheduled_date).slice(0, 10)}` : null
    };

    if (kind === 'return') {
        card.returnId = row.return_id;
        if (row.refund_amount != null) {
            const refundState = String(row.refund_status || 'pending').toLowerCase();
            card.refundAmount = `₹${Number(row.refund_amount).toLocaleString('en-IN')}${refundState === 'completed' ? ' (refunded)' : ''}`;
        }
        if (String(row.status).toLowerCase() === 'pending_approval') {
            card.note = 'Our team reviews return requests within 24-48 hours.';
        }
    } else {
        card.returnId = row.exchange_id;
        if (row.price_difference > 0) {
            card.note = `₹${Number(row.price_difference).toLocaleString('en-IN')} extra payment ${String(row.payment_status || '').toLowerCase() === 'completed' ? 'completed' : 'required'}.`;
        } else if (row.price_difference < 0) {
            card.refundAmount = `₹${Math.abs(Number(row.price_difference)).toLocaleString('en-IN')} refund due`;
        }
        if (String(row.status).toLowerCase() === 'pending_approval') {
            card.note = card.note || 'Our team reviews exchange requests within 24-48 hours.';
        }
    }

    return card;
}

// ---------- Persistence (optimised: single upsert per turn) ----------

/**
 * Persist a customer+bot message pair and update the session summary.
 * Fire-and-forget — caller catches rejections.
 */
// ---------- Persistence helpers ----------

/**
 * Save the session context (entities) to the database so it survives
 * server restarts and in-memory session expiry.
 */
async function persistContextToDb(sessionId, context) {
    if (!sessionId || !context || !Object.keys(context).length) return;
    await dbAdapter.run(
        `UPDATE widget_chat_sessions SET context = $2 WHERE session_id = $1`,
        [sessionId, JSON.stringify(context)]
    );
}

async function persistWidgetChat(sessionId, customerMsg, botReply, opts) {
    const now = new Date().toISOString();
    const entitiesJSON = opts.entities ? JSON.stringify(opts.entities) : null;
    const visitorId = opts.visitorId || null;

    // 1. Insert both messages in one batch via two INSERTs
    await dbAdapter.run(
        `INSERT INTO widget_chats (session_id, sender, content, created_at) VALUES ($1, $2, $3, $4)`,
        [sessionId, 'customer', customerMsg, now]
    );
    await dbAdapter.run(
        `INSERT INTO widget_chats (session_id, sender, content, model, prompt_tokens, completion_tokens, cost_usd, tool_calls, suggested_action, entities, rich_content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [sessionId, 'bot', botReply, opts.model || null,
         opts.promptTokens || 0, opts.completionTokens || 0,
         opts.costUsd || 0, opts.toolCalls || 0,
         opts.suggestedAction || null, entitiesJSON,
         opts.richContent ? JSON.stringify(opts.richContent) : null, now]
    );

    // 2. Upsert session summary (single atomic statement) — also persist context + visitor_id
    const contextJson = opts.entities ? JSON.stringify(opts.entities) : null;
    await dbAdapter.run(
        `INSERT INTO widget_chat_sessions (session_id, message_count, total_prompt_tokens, total_completion_tokens, total_cost_usd, last_message_at, context, visitor_id, created_at)
         VALUES ($1, 2, $2, $3, $4, $5, $6, $7, $5)
         ON CONFLICT (session_id) DO UPDATE SET
           message_count = widget_chat_sessions.message_count + 2,
           total_prompt_tokens = widget_chat_sessions.total_prompt_tokens + $2,
           total_completion_tokens = widget_chat_sessions.total_completion_tokens + $3,
           total_cost_usd = widget_chat_sessions.total_cost_usd + $4,
           last_message_at = $5,
           context = COALESCE($6, widget_chat_sessions.context),
           visitor_id = COALESCE($7, widget_chat_sessions.visitor_id)`,
        [sessionId, opts.promptTokens || 0, opts.completionTokens || 0, opts.costUsd || 0, now, contextJson, visitorId]
    );
}

// ---------- Ticket creation ----------

/**
 * Create a support ticket from the widget.
 * @returns {{ ticketNumber: string, whatsappLink: string, ticketId: number }}
 */
async function createWidgetTicket({ name, phone, email, message, orderId, source, sessionId, visitorId }) {
    const ticketNumber = 'WDG-' + Date.now().toString(36).toUpperCase();

    // Assign portal via round-robin so every portal gets its fair share of widget tickets
    const portalId = await getPortalIdForNewTicket();

    // Source defaults to 'widget' for backward compatibility; testbot sends 'website'
    const ticketSource = source || 'widget';

    // If phone or email were omitted from client (for security), populate from order record
    let ticketName = name;
    let ticketPhone = phone;
    let ticketEmail = email;

    if ((!ticketPhone || !ticketEmail) && orderId) {
        try {
            const cleanId = String(orderId).replace(/^#/, '').trim();
            const shopperRows = await dbAdapter.query(
                `SELECT name, phone, email FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
                [cleanId]
            );
            if (shopperRows && shopperRows.length > 0) {
                if (!ticketName || ticketName === 'Customer' || ticketName === 'Widget Customer') {
                    ticketName = shopperRows[0].name || ticketName;
                }
                if (!ticketPhone) ticketPhone = shopperRows[0].phone || '';
                if (!ticketEmail) ticketEmail = shopperRows[0].email || '';
            }
        } catch (e) { /* best-effort lookup */ }
    }

    const inserted = await dbAdapter.insert('support_tickets', {
        ticket_number: ticketNumber,
        customer_name: ticketName || 'Widget Customer',
        customer_phone: ticketPhone || '',
        customer_email: ticketEmail || '',
        message: message || '',
        order_id: orderId || null,
        portal_id: portalId,
        status: 'open',
        source: ticketSource,
        channel: 'website',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });

    const ticketId = inserted?.id || null;

    // Link the chat session to this ticket (fire-and-forget)
    if (sessionId && ticketId) {
        dbAdapter.run(
            `UPDATE widget_chat_sessions SET has_ticket = TRUE, ticket_id = $1, ticket_number = $2 WHERE session_id = $3`,
            [ticketId, ticketNumber, sessionId]
        ).catch(err => console.warn('[widget] ticket link error:', err.message));

        // Also stamp the ticket_id on all chat messages for this session
        dbAdapter.run(
            `UPDATE widget_chats SET ticket_id = $1 WHERE session_id = $2 AND ticket_id IS NULL`,
            [ticketId, sessionId]
        ).catch(err => console.warn('[widget] chat stamp error:', err.message));
    }

    // Stamp visitor_id on the session if provided
    if (sessionId && visitorId) {
        dbAdapter.run(
            `UPDATE widget_chat_sessions SET visitor_id = $1 WHERE session_id = $2 AND visitor_id IS NULL`,
            [visitorId, sessionId]
        ).catch(err => console.warn('[widget] visitor_id stamp error:', err.message));
    }

    // Build WhatsApp deep link
    const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
    const prefilledText = `Hi, I need help with my order.\nTicket: ${ticketNumber}\n${orderId ? 'Order: ' + orderId + '\n' : ''}${message ? 'Issue: ' + message.substring(0, 200) : ''}`;
    const whatsappLink = `https://wa.me/${businessNumber}?text=${encodeURIComponent(prefilledText)}`;

    return { ticketNumber, whatsappLink, ticketId };
}

module.exports = {
    runCustomerAgent,
    createWidgetTicket,
    noteSessionContext,
    appendSessionExchange,
    applyRefundGuardrails,
    detectSopScenario,
    detectCustomerSentiment,
    getSessionAsync
};
