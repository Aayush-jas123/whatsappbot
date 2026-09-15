/**
 * Automated Test Suite for Requirement 5: Repeat Contact Detection
 *
 * Tests:
 * 1. First contact scenario: Customer contacting for the first time -> isRepeatContact: false
 * 2. Repeated contact scenario: Same customer + same order + same issue category -> isRepeatContact: true, "Repeat contact detected."
 * 3. Unrelated contact scenario: Same customer + same order + DIFFERENT issue category -> isRepeatContact: false
 * 4. Multiple orders scenario: Same customer + DIFFERENT order ID -> isRepeatContact: false
 * 5. Configured escalation rule checking (Step 6):
 *    - Threshold not met -> shouldEscalate: false (no auto-escalation)
 *    - Threshold met or frustration/escalation scenario -> shouldEscalate: true
 * 6. Strict Neutrality Audit: Zero defamatory labels
 * 7. Live Database Integration: Tests against live database customer records
 * 8. Copilot Tool Registration & Token-Lean Intent Routing
 */

require('dotenv').config();
const assert = require('assert');
const {
    detectRepeatContact,
    correlateContacts,
    evaluateEscalationRule,
    normalizeOrderId,
    extractOrderIdFromText,
    buildRepeatContactSummary
} = require('../src/services/repeatContactService');
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
    console.log('======================================================');
    console.log('🧪 RUNNING REQUIREMENT 5: REPEAT CONTACT DETECTION TESTS');
    console.log('======================================================\n');

    // Group 1: Helpers and Order Normalization
    console.log('--- Helper & Utility Tests ---');

    it('normalizeOrderId strips # and formatting', () => {
        assert.strictEqual(normalizeOrderId('#51209'), '51209');
        assert.strictEqual(normalizeOrderId('order-12345'), '12345');
        assert.strictEqual(normalizeOrderId('99887'), '99887');
        assert.strictEqual(normalizeOrderId(null), null);
    });

    it('extractOrderIdFromText captures order numbers accurately', () => {
        assert.strictEqual(extractOrderIdFromText('Where is my package for order #51209?'), '51209');
        assert.strictEqual(extractOrderIdFromText('Checking status of 48945 please'), '48945');
        assert.strictEqual(extractOrderIdFromText('I need help with my account'), null);
    });

    // Group 2: First Contact Scenario
    console.log('\n--- Scenario 1: First Contact (Step 7) ---');

    it('First contact reports isRepeatContact: false and 0 previous contacts', () => {
        const currentContact = {
            orderId: '1001',
            issueCategory: 'Delivery & Tracking',
            issueText: 'Where is my order #1001?',
            timestamp: '2026-09-05T10:00:00.000Z'
        };

        const result = correlateContacts({
            currentContact,
            historicalSessions: [] // No prior sessions
        });

        assert.strictEqual(result.isRepeatContact, false);
        assert.strictEqual(result.previousContactsCount, 0);
        assert.strictEqual(result.previousDates.length, 0);
        assert.strictEqual(result.previousActions.length, 0);
        assert.strictEqual(result.alert, 'First contact (No repeat contact detected).');
        assert.strictEqual(result.currentUnresolvedIssue.orderId, '#1001');
        assert.strictEqual(result.currentUnresolvedIssue.category, 'Delivery & Tracking');
        assert(result.neutralSummary.includes('First contact'));
    });

    // Group 3: Repeated Contact Scenario
    console.log('\n--- Scenario 2: Repeated Contact (Step 3 & 4) ---');

    it('Repeated contact correctly flags isRepeatContact: true with count, dates, and previous actions', () => {
        const currentContact = {
            orderId: '1001',
            issueCategory: 'Delivery & Tracking',
            issueText: 'Still have not received my order #1001, tracking is stuck',
            timestamp: '2026-09-08T12:00:00.000Z'
        };

        const historicalSessions = [
            {
                id: 'sess-1',
                timestamp: '2026-09-02T10:00:00.000Z',
                dateFormatted: '02 Sep 2026, 03:30 PM IST',
                orderId: '1001',
                issueCategory: 'Delivery & Tracking',
                summary: 'Customer inquired why shipment is delayed',
                actionTaken: 'Support requested carrier tracking update from Delhivery',
                status: 'in_progress',
                ticketNumber: 'TKT-260902-101'
            },
            {
                id: 'sess-2',
                timestamp: '2026-09-05T14:30:00.000Z',
                dateFormatted: '05 Sep 2026, 08:00 PM IST',
                orderId: '1001',
                issueCategory: 'Delivery & Tracking',
                summary: 'Customer followed up regarding pending delivery',
                actionTaken: 'Escalated to dispatch hub supervisor; promised delivery within 48h',
                status: 'open',
                ticketNumber: 'TKT-260905-202'
            }
        ];

        const result = correlateContacts({
            currentContact,
            historicalSessions,
            config: { thresholdConfig: 3 }
        });

        assert.strictEqual(result.isRepeatContact, true);
        assert.strictEqual(result.alert, 'Repeat contact detected.');
        assert.strictEqual(result.previousContactsCount, 2);
        assert.strictEqual(result.previousDates.length, 2);
        assert.strictEqual(result.previousDates[0], '02 Sep 2026, 03:30 PM IST');
        assert.strictEqual(result.previousDates[1], '05 Sep 2026, 08:00 PM IST');
        assert.strictEqual(result.previousActions.length, 2);
        assert(result.previousActions[0].includes('Delhivery'));
        assert(result.previousActions[1].includes('dispatch hub'));
        assert.strictEqual(result.currentUnresolvedIssue.category, 'Delivery & Tracking');
        assert(result.neutralSummary.includes('Repeat contact detected.'));
        assert(result.neutralSummary.includes('2 previous contact(s)'));
    });

    // Group 4: Unrelated Contact Scenario (Different Issue Category)
    console.log('\n--- Scenario 3: Unrelated Contact / Different Issue (Step 7) ---');

    it('Does NOT group contacts with different issue categories as repeat contacts', () => {
        const currentContact = {
            orderId: '1001',
            issueCategory: 'Payment & Checkout',
            issueText: 'My COD payment was deducted twice',
            timestamp: '2026-09-05T10:00:00.000Z'
        };

        const historicalSessions = [
            {
                id: 'sess-1',
                timestamp: '2026-09-01T10:00:00.000Z',
                dateFormatted: '01 Sep 2026, 03:30 PM IST',
                orderId: '1001',
                issueCategory: 'Size & Fit', // Different category!
                summary: 'Customer asked for size chart',
                actionTaken: 'Sent size guide PDF',
                status: 'resolved'
            }
        ];

        const result = correlateContacts({
            currentContact,
            historicalSessions
        });

        // Should NOT be flagged as repeat contact for this issue!
        assert.strictEqual(result.isRepeatContact, false);
        assert.strictEqual(result.previousContactsCount, 0);
        assert.strictEqual(result.unrelatedCategoryContactsCount, 1);
        assert(result.alert.includes('First contact'));
        assert(result.neutralSummary.includes('different topics'));
    });

    // Group 5: Multiple Orders Scenario (Different Order IDs)
    console.log('\n--- Scenario 4: Multiple Orders (Step 7) ---');

    it('Does NOT group contacts for different order IDs as repeat contacts', () => {
        const currentContact = {
            orderId: '2002', // Target order is #2002
            issueCategory: 'Delivery & Tracking',
            issueText: 'Where is order #2002?',
            timestamp: '2026-09-05T10:00:00.000Z'
        };

        const historicalSessions = [
            {
                id: 'sess-1',
                timestamp: '2026-09-01T10:00:00.000Z',
                dateFormatted: '01 Sep 2026, 03:30 PM IST',
                orderId: '1001', // Different order!
                issueCategory: 'Delivery & Tracking',
                summary: 'Delivery tracking inquiry for Order #1001',
                actionTaken: 'Provided tracking link for #1001',
                status: 'resolved'
            }
        ];

        const result = correlateContacts({
            currentContact,
            historicalSessions
        });

        // Order #2002 is contacted for the first time!
        assert.strictEqual(result.isRepeatContact, false);
        assert.strictEqual(result.previousContactsCount, 0);
        assert.strictEqual(result.unrelatedOrderContactsCount, 1);
        assert(result.alert.includes('First contact'));
        assert(result.neutralSummary.includes('different orders'));
    });

    // Group 6: Step 6 Configured Escalation Rule Checking
    console.log('\n--- Scenario 5: Configured Escalation Rule Checking (Step 6) ---');

    it('Does NOT automatically escalate when repeat count is under configured threshold', () => {
        const esc = evaluateEscalationRule({
            repeatCount: 2,
            sentiment: 'neutral',
            scenario: 'tracking',
            thresholdConfig: 3 // Configured threshold is 3
        });

        assert.strictEqual(esc.shouldEscalate, false);
        assert(esc.escalationStatus.includes('Not triggered'));
        assert(esc.policyReason.includes('under escalation threshold'));
    });

    it('Escalates only when configured threshold is reached or exceeded', () => {
        const esc = evaluateEscalationRule({
            repeatCount: 3,
            sentiment: 'neutral',
            scenario: 'tracking',
            thresholdConfig: 3
        });

        assert.strictEqual(esc.shouldEscalate, true);
        assert(esc.escalationStatus.includes('Escalation recommended'));
        assert(esc.policyReason.includes('reached or exceeded company threshold'));
    });

    it('Escalates when customer sentiment is explicitly frustrated per company policy', () => {
        const esc = evaluateEscalationRule({
            repeatCount: 1, // Even on 1 repeat contact
            sentiment: 'frustrated',
            scenario: 'tracking',
            thresholdConfig: 3
        });

        assert.strictEqual(esc.shouldEscalate, true);
        assert(esc.policyReason.includes('sentiment is frustrated'));
    });

    it('Escalates when customer explicitly demands manager/supervisor escalation', () => {
        const esc = evaluateEscalationRule({
            repeatCount: 1,
            sentiment: 'neutral',
            scenario: 'escalation', // Supervisor demand
            thresholdConfig: 3
        });

        assert.strictEqual(esc.shouldEscalate, true);
        assert(esc.policyReason.includes('explicitly requested supervisor/manager'));
    });

    // Group 7: Strict Neutrality Guarantee
    console.log('\n--- Scenario 6: Strict Neutrality Audit ---');

    it('buildRepeatContactSummary generates strictly objective text free of derogatory labels', () => {
        const summary = buildRepeatContactSummary({
            isRepeatContact: true,
            previousContactsCount: 4,
            previousDates: ['01 Sep 2026', '03 Sep 2026', '05 Sep 2026', '07 Sep 2026'],
            previousActions: ['Provided tracking', 'Escalated to carrier', 'Scheduled inspection', 'Issued update'],
            currentUnresolved: {
                orderId: '#51209',
                category: 'Delivery & Tracking',
                description: 'Customer reports package has not been delivered',
                status: 'Unresolved / Active'
            },
            escalation: {
                shouldEscalate: true,
                escalationStatus: 'Escalation recommended per company policy',
                policyReason: 'Threshold of 3 contacts reached.'
            },
            unrelatedOrderContactsCount: 1,
            unrelatedCategoryContactsCount: 0
        });

        const forbiddenRegex = /\b(fraud|fraudulent|serial\s*returner|high\s*risk|scam|scammer|abusive|troublemaker|bad\s*customer|unreliable|blacklisted)\b/i;
        assert(!forbiddenRegex.test(summary), `Summary contained forbidden label: "${summary}"`);
        assert(summary.includes('Repeat contact detected.'));
        assert(summary.includes('4 previous contact(s)'));
    });

    // Group 8: Live Database Resolution Tests
    console.log('\n--- Scenario 7: Live Database Integration Tests ---');

    await asyncIt('Performs repeat contact detection for Order #51209 (Sathvik Ch)', async () => {
        const res = await detectRepeatContact('51209', {
            currentIssue: 'Where is my delivery for order #51209?'
        });

        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '9959487924');
        assert.strictEqual(res.customer.name, 'Sathvik Ch');
        assert(typeof res.isRepeatContact === 'boolean');
        assert(typeof res.alert === 'string');
        assert(typeof res.previousContactsCount === 'number');
        assert(Array.isArray(res.previousDates));
        assert(Array.isArray(res.previousActions));
        assert(res.currentUnresolvedIssue !== undefined);
        assert(res.escalation !== undefined);
        assert(typeof res.escalation.shouldEscalate === 'boolean');
    });

    await asyncIt('Performs repeat contact detection for customer 7902452931 (Adithya Premkumar)', async () => {
        const res = await detectRepeatContact('7902452931', {
            currentIssue: 'I want to modify my order details'
        });

        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '7902452931');
        assert(res.customer.name.toLowerCase().includes('adithya'));
        assert(typeof res.isRepeatContact === 'boolean');
        assert(typeof res.alert === 'string');
        assert(res.neutralSummary !== undefined);
    });

    await asyncIt('Handles non-existent customer gracefully', async () => {
        const res = await detectRepeatContact('0000000000');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('No order or interaction records found'));
    });

    await asyncIt('Handles blank identifier gracefully', async () => {
        const res = await detectRepeatContact('');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('required'));
    });

    // Group 9: Tool Registration and Intent Routing
    console.log('\n--- Scenario 8: Tool Registration & Intent Routing ---');

    it('detect_repeat_contact is registered in tools list', () => {
        const tool = tools.find(t => t.name === 'detect_repeat_contact');
        assert(tool !== undefined);
        assert.strictEqual(tool.requiresConfirmation, false);
        assert.strictEqual(tool.parameters.required[0], 'customerIdentifier');
    });

    it('selectToolSchemas routes "Repeat contact detected?" to detect_repeat_contact', () => {
        const schemas = selectToolSchemas('Has repeat contact been detected for this customer?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('detect_repeat_contact'));
    });

    it('selectToolSchemas routes "Has the customer contacted us before" to detect_repeat_contact', () => {
        const schemas = selectToolSchemas('Has the customer contacted us before about this order?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('detect_repeat_contact'));
    });

    it('selectToolSchemas routes "Is the customer reaching out again" to detect_repeat_contact', () => {
        const schemas = selectToolSchemas('Is this customer reaching out again about the same problem?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('detect_repeat_contact'));
    });

    it('selectToolSchemas routes "Check repeat contact history" to detect_repeat_contact', () => {
        const schemas = selectToolSchemas('Check repeat contact history for 7902452931');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('detect_repeat_contact'));
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
