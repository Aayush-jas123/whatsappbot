/**
 * Automated Test Suite for Requirement 4: Customer Behavior and History Patterns
 * Tests:
 * 1. Issue text classification (Size & Fit, Delivery & Tracking, Damaged/Defective, etc.)
 * 2. Factual metrics aggregation:
 *    - number of orders
 *    - returns
 *    - exchanges
 *    - cancellations
 *    - RTOs (Return To Origin)
 *    - support contacts
 *    - repeated issue categories
 * 3. Accurate answers to the 3 mandatory officer questions:
 *    - "Has this customer had the same issue before?"
 *    - "How many size-related complaints did they have?"
 *    - "How many returns did this customer make?"
 * 4. Strict Neutrality Guarantee (Step 4):
 *    - Zero defamatory, subjective, or speculative labels ("fraudulent", "serial returner", "high risk", etc.)
 * 5. Live DB customer lookups (by Order ID, Phone, Ticket Number)
 * 6. Tool registration and token-lean routing via TOOL_TRIGGERS
 */

require('dotenv').config();
const assert = require('assert');
const {
    getCustomerBehaviorPatterns,
    classifyIssueText,
    analyzeCustomerPatterns,
    answerOfficerQuestions,
    buildNeutralPatternSummary
} = require('../src/services/customerBehaviorService');
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
    console.log('🧪 RUNNING REQUIREMENT 4: CUSTOMER BEHAVIOR PATTERNS TESTS');
    console.log('======================================================\n');

    // Warm up DB pool connection
    try {
        const { dbAdapter } = require('../src/database/db');
        await dbAdapter.query('SELECT 1');
    } catch (e) {
        console.warn('DB warmup note:', e.message);
    }

    // Group 1: Unit tests on Issue Classification
    console.log('--- Unit Tests: Issue Text Classification ---');

    it('classifies size complaints into "Size & Fit"', () => {
        assert.strictEqual(classifyIssueText('The shirt is too small for me'), 'Size & Fit');
        assert.strictEqual(classifyIssueText('Can I exchange for larger size L?'), 'Size & Fit');
        assert.strictEqual(classifyIssueText('Size M is very tight around chest'), 'Size & Fit');
        assert.strictEqual(classifyIssueText('Please share size chart measurements'), 'Size & Fit');
    });

    it('classifies delivery queries into "Delivery & Tracking"', () => {
        assert.strictEqual(classifyIssueText('Where is my order? When will it reach?'), 'Delivery & Tracking');
        assert.strictEqual(classifyIssueText('Tracking link shows delayed courier'), 'Delivery & Tracking');
        assert.strictEqual(classifyIssueText('Can you please delivered my product on 10th sept'), 'Delivery & Tracking');
        assert.strictEqual(classifyIssueText('Is the package out for delivery today?'), 'Delivery & Tracking');
    });

    it('classifies defects into "Damaged / Defective Product"', () => {
        assert.strictEqual(classifyIssueText('The fabric is torn near the collar'), 'Damaged / Defective Product');
        assert.strictEqual(classifyIssueText('Received defective item with dirty stain'), 'Damaged / Defective Product');
        assert.strictEqual(classifyIssueText('Broken button on the jacket'), 'Damaged / Defective Product');
    });

    it('classifies refund requests into "Return & Refund"', () => {
        assert.strictEqual(classifyIssueText('I want my money back refund status'), 'Return & Refund');
        assert.strictEqual(classifyIssueText('When will the return pickup happen?'), 'Return & Refund');
    });

    it('classifies cancel and edit requests into "Order Modification / Cancellation"', () => {
        assert.strictEqual(classifyIssueText('shop_cancel'), 'Order Modification / Cancellation');
        assert.strictEqual(classifyIssueText('I want to change my delivery address'), 'Order Modification / Cancellation');
        assert.strictEqual(classifyIssueText('Please cancel my order #12345'), 'Order Modification / Cancellation');
    });

    it('classifies payment issues into "Payment & Checkout"', () => {
        assert.strictEqual(classifyIssueText('Money deducted from bank but order failed'), 'Payment & Checkout');
        assert.strictEqual(classifyIssueText('Razorpay payment transaction failed'), 'Payment & Checkout');
    });

    // Group 2: Factual Metrics Calculation
    console.log('\n--- Factual Metrics Calculation Tests ---');

    it('calculates exact order counts, returns, exchanges, cancellations, and RTOs', () => {
        const mockHistory = {
            shoppers: [
                { order_id: '101', status: 'delivered', customer_message: null, created_at: '2026-08-01T10:00:00Z' },
                { order_id: '102', status: 'cancelled', customer_message: 'Ordered by mistake', created_at: '2026-08-10T10:00:00Z' },
                { order_id: '103', status: 'rto', customer_message: null, created_at: '2026-08-15T10:00:00Z' },
                { order_id: '104', status: 'delivered', customer_message: null, created_at: '2026-08-20T10:00:00Z' }
            ],
            orders: [
                { order_id: '101', status: 'delivered' },
                { order_id: '102', status: 'cancelled', cancel_reason: 'Customer request' },
                { order_id: '103', status: 'rto' },
                { order_id: '104', status: 'delivered' }
            ],
            shipments: [
                { order_id: '103', status: 'rto_delivered', courier_name: 'Delhivery', awb: 'AWB103', created_at: '2026-08-16T10:00:00Z' }
            ],
            returns: [
                { return_id: 'RET-1', order_id: '101', reason: 'Size too tight', status: 'completed', refund_amount: 1298, created_at: '2026-08-05T10:00:00Z' }
            ],
            exchanges: [
                { exchange_id: 'EXC-1', order_id: '104', reason: 'Need size L instead of M', status: 'delivered', created_at: '2026-08-22T10:00:00Z' }
            ],
            tickets: [
                { ticket_number: 'TKT-1', message: 'The shirt size is too tight', status: 'closed', created_at: '2026-08-04T10:00:00Z' },
                { ticket_number: 'TKT-2', message: 'Where is my delivery?', status: 'closed', created_at: '2026-08-12T10:00:00Z' }
            ],
            messages: []
        };

        const patterns = analyzeCustomerPatterns({ name: 'Test User' }, mockHistory);

        assert.strictEqual(patterns.metrics.totalOrders, 4);
        assert.strictEqual(patterns.metrics.deliveredOrders, 2);
        assert.strictEqual(patterns.metrics.cancelledOrders, 1);
        assert.strictEqual(patterns.metrics.returnedOrders, 1);
        assert.strictEqual(patterns.metrics.exchangedOrders, 1);
        assert.strictEqual(patterns.metrics.rtoOrders, 1);
        assert.strictEqual(patterns.metrics.supportContacts, 2);

        // Size complaints: 1 return (Size too tight) + 1 exchange (Need size L) + 1 ticket (size is too tight) = 3
        assert.strictEqual(patterns.categoryOccurrences['Size & Fit'].length, 3);
        assert.strictEqual(patterns.categoryOccurrences['Delivery & Tracking'].length, 1);
        assert.strictEqual(patterns.categoryOccurrences['Order Modification / Cancellation'].length, 1);

        // Repeated categories: Size & Fit (3 times)
        assert.strictEqual(patterns.repeatedCategories.length, 1);
        assert.strictEqual(patterns.repeatedCategories[0].category, 'Size & Fit');
        assert.strictEqual(patterns.repeatedCategories[0].count, 3);
    });

    // Group 3: Answering Target Officer Questions
    console.log('\n--- Answering Target Officer Questions Tests ---');

    it('accurately answers "Has this customer had the same issue before?" when issue matches', () => {
        const mockHistory = {
            shoppers: [], orders: [], shipments: [], returns: [],
            exchanges: [{ exchange_id: 'EX-1', order_id: '100', reason: 'Size M too small, need L', status: 'delivered', created_at: '2026-08-01T10:00:00Z' }],
            tickets: [{ ticket_number: 'TKT-1', message: 'Size was too tight', status: 'closed', created_at: '2026-08-02T10:00:00Z' }],
            messages: []
        };
        const patterns = analyzeCustomerPatterns({ name: 'Test User' }, mockHistory);
        const answers = answerOfficerQuestions(patterns, 'size problem');

        assert(answers.hasCustomerHadSameIssueBefore.startsWith('Yes'));
        assert(answers.hasCustomerHadSameIssueBefore.includes('Size & Fit'));
        assert(answers.hasCustomerHadSameIssueBefore.includes('2 total occurrences'));
    });

    it('accurately answers "Has this customer had the same issue before?" when issue is new', () => {
        const mockHistory = {
            shoppers: [], orders: [], shipments: [], returns: [], exchanges: [],
            tickets: [{ ticket_number: 'TKT-1', message: 'Where is my order?', status: 'closed', created_at: '2026-08-02T10:00:00Z' }],
            messages: []
        };
        const patterns = analyzeCustomerPatterns({ name: 'Test User' }, mockHistory);
        const answers = answerOfficerQuestions(patterns, 'torn fabric defect');

        assert(answers.hasCustomerHadSameIssueBefore.startsWith('No'));
        assert(answers.hasCustomerHadSameIssueBefore.includes('not had prior recorded issues regarding "Damaged / Defective Product"'));
    });

    it('accurately answers "How many size-related complaints did they have?"', () => {
        const mockHistory = {
            shoppers: [], orders: [], shipments: [],
            returns: [{ return_id: 'R-1', order_id: '101', reason: 'Size too loose', status: 'completed', created_at: '2026-08-01T10:00:00Z' }],
            exchanges: [{ exchange_id: 'E-1', order_id: '102', reason: 'Need smaller size S', status: 'delivered', created_at: '2026-08-10T10:00:00Z' }],
            tickets: [], messages: []
        };
        const patterns = analyzeCustomerPatterns({ name: 'Test User' }, mockHistory);
        const answers = answerOfficerQuestions(patterns);

        assert(answers.howManySizeRelatedComplaints.includes('2 size-related complaint(s)/request(s)'));
        assert(answers.howManySizeRelatedComplaints.includes('Size too loose'));
        assert(answers.howManySizeRelatedComplaints.includes('Need smaller size S'));
    });

    it('accurately answers "How many returns did this customer make?"', () => {
        const mockHistory = {
            shoppers: [], orders: [], shipments: [],
            returns: [
                { return_id: 'R-1', order_id: '101', reason: 'Defective zipper', status: 'completed', refund_amount: 1148, created_at: '2026-08-01T10:00:00Z' },
                { return_id: 'R-2', order_id: '102', reason: 'Did not like color', status: 'completed', refund_amount: 1298, created_at: '2026-08-15T10:00:00Z' }
            ],
            exchanges: [], tickets: [], messages: []
        };
        const patterns = analyzeCustomerPatterns({ name: 'Test User' }, mockHistory);
        const answers = answerOfficerQuestions(patterns);

        assert(answers.howManyReturnsMade.includes('The customer has made 2 return(s)'));
        assert(answers.howManyReturnsMade.includes('Order #101'));
        assert(answers.howManyReturnsMade.includes('Order #102'));
    });

    // Group 4: Strict Neutrality Guarantee (Step 4)
    console.log('\n--- Strict Neutrality Guarantee (Step 4) Tests ---');

    it('buildNeutralPatternSummary presents facts neutrally with zero derogatory words', () => {
        const mockPatterns = {
            metrics: {
                totalOrders: 10,
                deliveredOrders: 4,
                cancelledOrders: 2,
                returnedOrders: 3,
                exchangedOrders: 1,
                rtoOrders: 2,
                supportContacts: 6
            },
            issueBreakdown: { 'Size & Fit': 3, 'Delivery & Tracking': 2, 'Return & Refund': 1 },
            repeatedCategories: [{ category: 'Size & Fit', count: 3 }]
        };

        const summary = buildNeutralPatternSummary({ name: 'Rohan Gupta' }, mockPatterns);

        // Factual verification
        assert(summary.includes('Rohan Gupta has placed 10 order(s) in total'));
        assert(summary.includes('4 delivered'));
        assert(summary.includes('2 cancelled'));
        assert(summary.includes('3 returned'));
        assert(summary.includes('2 RTOs'));
        assert(summary.includes('Size & Fit (3 times)'));

        // Prohibited labels audit:
        const forbiddenRegex = /\b(fraud|fraudulent|serial\s*returner|high\s*risk|scam|scammer|abusive|troublemaker|bad\s*customer|unreliable|blacklisted)\b/i;
        assert(!forbiddenRegex.test(summary), `Summary contained forbidden subjective label: "${summary}"`);
    });

    // Group 5: Live Database Integration Tests
    console.log('\n--- Live Database Integration Tests ---');

    await asyncIt('Retrieves behavior patterns for customer associated with Order #51209 (Sathvik Ch)', async () => {
        const res = await getCustomerBehaviorPatterns('51209');
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.name, 'Sathvik Ch');
        assert.strictEqual(res.customer.cleanPhone, '9959487924');
        assert.strictEqual(res.metrics.totalOrders, 1);
        assert.strictEqual(res.metrics.returnedOrders, 0);
        assert.strictEqual(res.metrics.cancelledOrders, 0);
        assert.strictEqual(res.metrics.rtoOrders, 0);
        assert(res.neutralPatternSummary.includes('Sathvik Ch has placed 1 order(s) in total'));
        assert(res.answersToOfficerQuestions.howManySizeRelatedComplaints.includes('0 size-related complaints'));
        assert(res.answersToOfficerQuestions.howManyReturnsMade.includes('0 returns'));
    });

    await asyncIt('Retrieves behavior patterns for customer 7902452931 (Adithya Premkumar)', async () => {
        const res = await getCustomerBehaviorPatterns('7902452931', { currentIssue: 'delivery' });
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.customer.cleanPhone, '7902452931');
        assert(res.customer.name.toLowerCase().includes('adithya'));
        assert(res.metrics.totalOrders >= 1);
        assert(typeof res.metrics.supportContacts === 'number');
        assert(res.neutralPatternSummary !== undefined);
        assert(typeof res.answersToOfficerQuestions.hasCustomerHadSameIssueBefore === 'string');
    });

    await asyncIt('Gracefully handles non-existent customer identifier', async () => {
        const res = await getCustomerBehaviorPatterns('0000000000');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('No order or interaction records found'));
    });

    await asyncIt('Gracefully handles blank identifier', async () => {
        const res = await getCustomerBehaviorPatterns('');
        assert.strictEqual(res.found, false);
        assert(res.error.includes('required'));
    });

    // Group 6: Tool Registration & Intent Routing
    console.log('\n--- Tool Registration & Intent Routing Tests ---');

    it('get_customer_behavior_patterns is registered in tools list', () => {
        const tool = tools.find(t => t.name === 'get_customer_behavior_patterns');
        assert(tool !== undefined);
        assert.strictEqual(tool.requiresConfirmation, false);
        assert.strictEqual(tool.parameters.required[0], 'customerIdentifier');
    });

    it('selectToolSchemas routes "Has this customer had the same issue before" to get_customer_behavior_patterns', () => {
        const schemas = selectToolSchemas('Has this customer had the same issue before?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_customer_behavior_patterns'));
    });

    it('selectToolSchemas routes "How many size-related complaints did they have" to get_customer_behavior_patterns', () => {
        const schemas = selectToolSchemas('How many size-related complaints did they have?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_customer_behavior_patterns'));
    });

    it('selectToolSchemas routes "How many returns did this customer make" to get_customer_behavior_patterns', () => {
        const schemas = selectToolSchemas('How many returns did this customer make?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_customer_behavior_patterns'));
    });

    it('selectToolSchemas routes "Show customer behavior and order patterns" to get_customer_behavior_patterns', () => {
        const schemas = selectToolSchemas('Show customer behavior and history patterns');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_customer_behavior_patterns'));
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
