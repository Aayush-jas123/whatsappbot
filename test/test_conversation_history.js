/**
 * Automated Test Suite for Requirement 3: Previous Conversation History
 * Tests:
 * 1. Customer resolution (phone, order ID, ticket number, email, name)
 * 2. Interaction session clustering & timeline ordering
 * 3. Answering all 5 required officer questions:
 *    - "What did the customer tell us previously?"
 *    - "When did they last contact us?"
 *    - "What resolution was given?"
 *    - "Did we promise anything?"
 *    - "Is this a repeat issue?"
 * 4. Structured summarization format (Previous issue, Previous action, Current status, Outstanding commitment, Relevant dates)
 * 5. Explicit commitment extraction (dispatch, refund, pickup, callback)
 * 6. Guarantee of "None" when no commitments were made (NO hallucinated promises)
 * 7. Repeat issue detection across multiple sessions
 * 8. Copilot tool registration and trigger pattern verification
 */

require('dotenv').config();
const assert = require('assert');
const {
    getCustomerConversationHistory,
    resolveCustomer,
    filterRelevantMessages,
    clusterInteractionSessions,
    extractExplicitCommitments,
    analyzeRepeatIssues,
    formatDateTime
} = require('../src/services/conversationHistoryService');
const { tools, selectToolSchemas } = require('../src/services/ai/tools');

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(`    Error: ${err.message}`);
        failed++;
    }
}

async function asyncIt(desc, fn) {
    try {
        await fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(`    Error: ${err.message}`);
        failed++;
    }
}

async function runTests() {
    console.log('\n======================================================');
    console.log('🧪 RUNNING REQUIREMENT 3: CONVERSATION HISTORY TESTS');
    console.log('======================================================\n');

    // Warm up database connection
    try {
        const { dbAdapter } = require('../src/database/db');
        await dbAdapter.query('SELECT 1');
    } catch {
        try {
            const { dbAdapter } = require('../src/database/db');
            await dbAdapter.query('SELECT 1');
        } catch (e) {
            console.warn('DB warmup warning:', e.message);
        }
    }

    // Group 1: Unit tests on pure functions
    console.log('--- Unit Tests: Formatting & Extraction ---');

    it('formatDateTime formats ISO strings to IST human-readable format', () => {
        const formatted = formatDateTime('2026-09-08T15:21:00.000Z');
        assert(formatted.includes('8 Sep 2026') || formatted.includes('Sep 2026'));
        assert(formatted.includes('IST'));
    });

    it('filterRelevantMessages preserves inbound customer messages and agent replies', () => {
        const raw = [
            { id: 1, message_type: 'incoming', message_content: 'Where is my order?', created_at: '2026-09-01T10:00:00Z' },
            { id: 2, message_type: 'manual_reply', message_content: 'Your order is shipped with Delhivery', created_at: '2026-09-01T10:05:00Z' },
            { id: 3, message_type: 'broadcast', message_content: 'Mega Festive Sale! Use code FEST50', created_at: '2026-09-05T10:00:00Z' }
        ];
        const filtered = filterRelevantMessages(raw);
        assert.strictEqual(filtered.length, 2);
        assert.strictEqual(filtered[0].role, 'customer');
        assert.strictEqual(filtered[1].role, 'agent');
    });

    it('clusterInteractionSessions groups messages separated by < 24h into one session', () => {
        const msgs = [
            { role: 'customer', cleanContent: 'Can I change size?', created_at: '2026-09-01T10:00:00Z' },
            { role: 'agent', cleanContent: 'Yes, changed to L', created_at: '2026-09-01T10:15:00Z' },
            { role: 'customer', cleanContent: 'Thanks!', created_at: '2026-09-01T11:00:00Z' }
        ];
        const sessions = clusterInteractionSessions(msgs, [], [], [], []);
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].id, 'SESSION-1');
        assert.strictEqual(sessions[0].customerInquiries.length, 2);
        assert.strictEqual(sessions[0].agentResponses.length, 1);
    });

    it('clusterInteractionSessions splits messages separated by > 24h into distinct sessions', () => {
        const msgs = [
            { role: 'customer', cleanContent: 'Where is order?', created_at: '2026-09-01T10:00:00Z' },
            { role: 'agent', cleanContent: 'Shipped today', created_at: '2026-09-01T10:05:00Z' },
            { role: 'customer', cleanContent: 'I want to exchange it', created_at: '2026-09-04T12:00:00Z' },
            { role: 'agent', cleanContent: 'Exchange initiated', created_at: '2026-09-04T12:10:00Z' }
        ];
        const sessions = clusterInteractionSessions(msgs, [], [], [], []);
        assert.strictEqual(sessions.length, 2);
        assert.strictEqual(sessions[0].id, 'SESSION-1');
        assert.strictEqual(sessions[1].id, 'SESSION-2');
    });

    // Group 2: Explicit Commitment Detection & Zero-Hallucination Guarantee (Step 6)
    console.log('\n--- Commitment Extraction & Integrity Tests ---');

    it('extractExplicitCommitments extracts explicit dispatch promises', () => {
        const msgs = [
            { role: 'agent', message_type: 'manual_reply', message_content: 'Don’t worry, your replacement will be dispatched tomorrow.', created_at: '2026-09-08T10:00:00Z' }
        ];
        const commitments = extractExplicitCommitments(msgs, [], [], []);
        assert.strictEqual(commitments.length, 1);
        assert.strictEqual(commitments[0].type, 'dispatch');
        assert(commitments[0].commitment.includes('will be dispatched tomorrow'));
    });

    it('extractExplicitCommitments extracts explicit refund promises', () => {
        const msgs = [
            { role: 'agent', message_type: 'outgoing', message_content: 'Your refund of ₹1298 will be processed within 3 working days.', created_at: '2026-09-08T10:00:00Z' }
        ];
        const commitments = extractExplicitCommitments(msgs, [], [], []);
        assert.strictEqual(commitments.length, 1);
        assert.strictEqual(commitments[0].type, 'refund');
        assert(commitments[0].commitment.includes('refund'));
    });

    it('extractExplicitCommitments extracts scheduled pickup from returns records', () => {
        const returns = [
            { return_id: 'RET-101', order_id: '51200', status: 'pickup_scheduled', pickup_scheduled_date: '2026-09-12', created_at: '2026-09-08T10:00:00Z' }
        ];
        const commitments = extractExplicitCommitments([], [], returns, []);
        assert.strictEqual(commitments.length, 1);
        assert.strictEqual(commitments[0].type, 'pickup');
        assert(commitments[0].commitment.includes('pickup scheduled'));
    });

    it('extractExplicitCommitments returns EMPTY when no promises were made (Step 6 verification)', () => {
        const msgs = [
            { role: 'agent', message_type: 'manual_reply', message_content: 'Here is your tracking link: https://delhivery.com/track/12345. Let us know if you need anything else.', created_at: '2026-09-08T10:00:00Z' }
        ];
        const commitments = extractExplicitCommitments(msgs, [], [], []);
        assert.strictEqual(commitments.length, 0);
    });

    // Group 3: Repeat Issue Detection
    console.log('\n--- Repeat Issue Analysis Tests ---');

    it('analyzeRepeatIssues flags repeat when customer contacts multiple times on same topic', () => {
        const sessions = [
            { id: 'S1', topic: 'Delivery & Shipment Tracking' },
            { id: 'S2', topic: 'Delivery & Shipment Tracking' }
        ];
        const rep = analyzeRepeatIssues(sessions);
        assert.strictEqual(rep.isRepeat, true);
        assert.strictEqual(rep.count, 2);
        assert.strictEqual(rep.category, 'Delivery & Shipment Tracking');
        assert(rep.details.includes('repeat issue'));
    });

    it('analyzeRepeatIssues reports no repeat when sessions cover different topics', () => {
        const sessions = [
            { id: 'S1', topic: 'Order & Address Modification' },
            { id: 'S2', topic: 'Size & Exchange Request' }
        ];
        const rep = analyzeRepeatIssues(sessions);
        assert.strictEqual(rep.isRepeat, false);
        assert(rep.details.includes('different topics'));
    });

    it('analyzeRepeatIssues reports no repeat for single session customer', () => {
        const sessions = [
            { id: 'S1', topic: 'General Support Inquiry' }
        ];
        const rep = analyzeRepeatIssues(sessions);
        assert.strictEqual(rep.isRepeat, false);
        assert(rep.details.includes('only contacted us once'));
    });

    // Group 4: Live DB Integration Tests
    console.log('\n--- Live Database Resolution & Retrieval Tests ---');

    await asyncIt('Resolves customer and returns structured conversation history for Order #51209', async () => {
        const res = await getCustomerConversationHistory('51209');
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.name, 'Sathvik Ch');
        assert.strictEqual(res.customer.cleanPhone, '9959487924');
        assert(res.structuredSummary.previousIssue !== undefined);
        assert(res.structuredSummary.previousAction !== undefined);
        assert(res.structuredSummary.currentStatus !== undefined);
        assert.strictEqual(res.structuredSummary.outstandingCommitment, 'None');
        assert(res.structuredSummary.relevantDates.includes('Last contact'));
    });

    await asyncIt('Answers all 5 officer questions accurately for Order #51209', async () => {
        const res = await getCustomerConversationHistory('51209');
        const q = res.answersToOfficerQuestions;
        assert(typeof q.whatCustomerToldUs === 'string');
        assert(q.whenDidTheyLastContactUs.includes('The customer last contacted us'));
        assert(typeof q.whatResolutionWasGiven === 'string');
        assert(q.didWePromiseAnything.includes('None'));
        assert(q.isThisARepeatIssue.includes('Customer has only contacted us once'));
    });

    await asyncIt('Resolves customer via Support Ticket number (e.g. TKT-260909-1770)', async () => {
        const res = await getCustomerConversationHistory('TKT-260909-1770');
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '7902452931');
        assert(res.customer.name.toLowerCase().includes('adithya'));
        assert(res.metrics.totalInteractionSessions >= 1);
        assert(res.structuredSummary.currentStatus.includes('Open support ticket') || res.structuredSummary.currentStatus.includes('Resolved'));
    });

    await asyncIt('Resolves customer via raw 10-digit Phone number (9959487924)', async () => {
        const res = await getCustomerConversationHistory('9959487924');
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '9959487924');
        assert.strictEqual(res.customer.name, 'Sathvik Ch');
    });

    await asyncIt('Resolves customer via E.164 formatted Phone (+919959487924)', async () => {
        const res = await getCustomerConversationHistory('+919959487924');
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '9959487924');
    });

    await asyncIt('Gracefully handles non-existent customer identifier', async () => {
        const res = await getCustomerConversationHistory('0000000000');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('Could not find any customer'));
    });

    await asyncIt('Gracefully handles empty identifier argument', async () => {
        const res = await getCustomerConversationHistory('');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('required'));
    });

    // Group 5: Tool Registration & Triggers
    console.log('\n--- Tool Registration & Intent Routing Tests ---');

    it('get_conversation_history is registered in tools list', () => {
        const tool = tools.find(t => t.name === 'get_conversation_history');
        assert(tool !== undefined);
        assert.strictEqual(tool.requiresConfirmation, false);
        assert.strictEqual(tool.parameters.required[0], 'customerIdentifier');
    });

    it('selectToolSchemas routes "What did the customer tell us previously" to get_conversation_history', () => {
        const schemas = selectToolSchemas('What did the customer tell us previously about order 51209?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_conversation_history'));
    });

    it('selectToolSchemas routes "Did we promise anything" to get_conversation_history', () => {
        const schemas = selectToolSchemas('Did we promise anything to this customer?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_conversation_history'));
    });

    it('selectToolSchemas routes "Is this a repeat issue" to get_conversation_history', () => {
        const schemas = selectToolSchemas('Is this a repeat issue for customer 9959487924?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_conversation_history'));
    });

    it('selectToolSchemas routes "When did they last contact us" to get_conversation_history', () => {
        const schemas = selectToolSchemas('When did they last contact us?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_conversation_history'));
    });

    it('selectToolSchemas routes ticket numbers like TKT-260908-5122 to get_conversation_history', () => {
        const schemas = selectToolSchemas('Check history for TKT-260908-5122');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_conversation_history'));
    });

    console.log('\n======================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
