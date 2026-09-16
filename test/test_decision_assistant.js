/**
 * Automated Test Suite for Requirement 23: Next-Action Decision Assistant
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
    evaluateNextAction,
    identifyScenario,
    formatDecisionReport,
    SCENARIOS,
    BRAND_SOPS
} = require('../src/services/decisionAssistantService');

const { tools, getTool } = require('../src/services/ai/tools');

let testsPassed = 0;
let testsFailed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✅ ${desc}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ ${desc}`);
        console.error(err);
        testsFailed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✅ ${desc}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ ${desc}`);
        console.error(err);
        testsFailed++;
    }
}

(async () => {
    console.log('\n============================================================');
    console.log('TEST SUITE: REQUIREMENT 23 - NEXT-ACTION DECISION ASSISTANT');
    console.log('============================================================\n');

    console.log('--- 1. Scenario Identification Unit Tests ---');

    it('identifies DELIVERED_NOT_RECEIVED scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Order is marked delivered but customer says they did not receive it'),
            SCENARIOS.DELIVERED_NOT_RECEIVED
        );
        assert.strictEqual(
            identifyScenario('Tracking says delivered yesterday but package is missing'),
            SCENARIOS.DELIVERED_NOT_RECEIVED
        );
        assert.strictEqual(
            identifyScenario('False delivery scan reported by buyer'),
            SCENARIOS.DELIVERED_NOT_RECEIVED
        );
    });

    it('identifies WRONG_PRODUCT scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer received wrong product in parcel'),
            SCENARIOS.WRONG_PRODUCT
        );
        assert.strictEqual(
            identifyScenario('They received size M instead of L'),
            SCENARIOS.WRONG_PRODUCT
        );
    });

    it('identifies DAMAGED_DEFECTIVE scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('T-shirt arrived torn with stain on chest'),
            SCENARIOS.DAMAGED_DEFECTIVE
        );
        assert.strictEqual(
            identifyScenario('Defective stitch and broken buttons reported'),
            SCENARIOS.DAMAGED_DEFECTIVE
        );
    });

    it('identifies SIZE_EXCHANGE scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer wants an exchange for size XL'),
            SCENARIOS.SIZE_EXCHANGE
        );
        assert.strictEqual(
            identifyScenario('Shirt is too small, need size replacement'),
            SCENARIOS.SIZE_EXCHANGE
        );
    });

    it('identifies DISCRETIONARY_REFUND scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer wants full cash refund back to bank because they changed mind'),
            SCENARIOS.DISCRETIONARY_REFUND
        );
    });

    it('identifies PREPAID_DOUBLE_CHARGE scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer paid online with UPI but courier asked for cash COD at door'),
            SCENARIOS.PREPAID_DOUBLE_CHARGE
        );
    });

    it('identifies RTO_IN_TRANSIT scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Shipment failed delivery and is returned to origin RTO'),
            SCENARIOS.RTO_IN_TRANSIT
        );
    });

    it('identifies ADDRESS_CHANGE scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer wants to update shipping address'),
            SCENARIOS.ADDRESS_CHANGE
        );
    });

    it('identifies CANCELLATION scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer wants to cancel order'),
            SCENARIOS.CANCELLATION
        );
    });

    it('identifies RETURN_PICKUP_DELAY scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Reverse return pickup is pending and delayed for 3 days'),
            SCENARIOS.RETURN_PICKUP_DELAY
        );
    });

    it('identifies CUSTOMER_ESCALATION scenario accurately', () => {
        assert.strictEqual(
            identifyScenario('Customer is angry and demanding immediate manager callback'),
            SCENARIOS.CUSTOMER_ESCALATION
        );
    });

    console.log('\n--- 2. Live Decision Evaluation & Step-by-Step Guidance ---');

    let dDelivered;
    await itAsync('evaluates "What should I do?" for Delivered But Not Received (Order #50992)', async () => {
        dDelivered = await evaluateNextAction({
            problemDescription: 'Order #50992 is marked delivered but customer says they never received it. What should I do?',
            orderId: '50992'
        });

        assert.strictEqual(dDelivered.scenario, SCENARIOS.DELIVERED_NOT_RECEIVED);
        assert(dDelivered.situation.includes('50992'), 'Situation must reference order ID');
        assert(dDelivered.evidence.some(e => e.includes('AWB') || e.includes('Tracking')), 'Evidence must cite tracking/AWB');
        assert(dDelivered.applicable_policy.sop_section.includes('SOP Section 2'), 'Must cite SOP Section 2');
        assert(dDelivered.recommended_action.immediate_step.includes('POD'), 'Immediate step must request POD');
        assert(dDelivered.recommended_action.conditional_follow_up.includes('24 hours'), 'Follow-up must cite 24h window');
        assert(dDelivered.customer_facing_response.length > 50, 'Must produce personalized draft reply');
    });

    it('enforces Human-in-the-Loop safety (Step 5: never auto-execute)', () => {
        assert.strictEqual(dDelivered.action_executed, false, 'Action executed must strictly be false');
        assert.strictEqual(dDelivered.requires_manual_confirmation, true, 'Requires manual confirmation must be true');
        assert(dDelivered.recommended_action.safety_guard.includes('Never perform'), 'Safety guard must explicitly warn officer');
    });

    let dWrongProduct;
    await itAsync('evaluates "What\'s the correct process?" for Wrong Product (Order #42248)', async () => {
        dWrongProduct = await evaluateNextAction({
            problemDescription: 'Customer received size M instead of L for order #42248. What is the correct process?',
            orderId: '42248'
        });

        assert.strictEqual(dWrongProduct.scenario, SCENARIOS.WRONG_PRODUCT);
        assert(dWrongProduct.applicable_policy.sop_section.includes('SOP Section 5'), 'Must cite SOP Section 5');
        assert(dWrongProduct.evidence.some(e => e.includes('unboxing video')), 'Must require continuous uncut unboxing video');
        assert(dWrongProduct.recommended_action.immediate_step.includes('unboxing video'), 'Immediate step must request video proof');
    });

    let dDiscretionary;
    await itAsync('evaluates "How should I handle this?" for Discretionary Refund', async () => {
        dDiscretionary = await evaluateNextAction({
            problemDescription: 'Customer wants a full cash refund back to their bank account because they changed their mind. How should I handle this?'
        });

        assert.strictEqual(dDiscretionary.scenario, SCENARIOS.DISCRETIONARY_REFUND);
        assert(dDiscretionary.applicable_policy.sop_section.includes('Store Credit Gate'), 'Must enforce store credit gate');
        assert(dDiscretionary.recommended_action.immediate_step.includes('Store Credit'), 'Immediate step must explain Store Credit');
        assert(dDiscretionary.recommended_action.conditional_follow_up.includes('Do NOT promise a bank transfer'), 'Must strictly forbid bank refund promises');
    });

    console.log('\n--- 3. Standard Structured Output Format Tests ---');

    it('formatDecisionReport produces all 5 required structured sections', () => {
        const report = formatDecisionReport(dDelivered);
        assert(report.includes('### 🎯 Next-Action Decision Report'), 'Must contain header');
        assert(report.includes('#### 1. Situation'), 'Must contain Situation section');
        assert(report.includes('#### 2. Evidence'), 'Must contain Evidence section');
        assert(report.includes('#### 3. Applicable Policy'), 'Must contain Applicable Policy section');
        assert(report.includes('#### 4. Recommended Action'), 'Must contain Recommended Action section');
        assert(report.includes('#### 5. Customer-Facing Response (Ready to Send)'), 'Must contain Customer-Facing Response section');
        assert(report.includes('Safety Guard (Human-in-the-Loop)'), 'Must contain safety alert');
    });

    console.log('\n--- 4. AI Tool Registration & Trigger Routing Tests ---');

    it('get_next_action_recommendation is registered in tools array', () => {
        const tool = getTool('get_next_action_recommendation');
        assert(tool, 'Tool get_next_action_recommendation must be registered');
        assert.strictEqual(tool.name, 'get_next_action_recommendation');
        assert(tool.description.includes('decision-support'), 'Description must mention decision support');
        assert(tool.parameters.properties.problemDescription, 'Must require problemDescription');
        assert(tool.parameters.required.includes('problemDescription'), 'problemDescription is required parameter');
    });

    await itAsync('get_next_action_recommendation executes cleanly via tools dispatcher', async () => {
        const tool = getTool('get_next_action_recommendation');
        const res = await tool.execute({
            problemDescription: 'Customer says item not received despite delivered status',
            orderId: '50992'
        });

        assert.strictEqual(res.query_type, 'next_action_recommendation');
        assert.strictEqual(res.action_executed, false);
        assert(res.formatted_report, 'Result must contain formatted_report');
    });

    it('TOOL_TRIGGERS correctly routes target questions', () => {
        const toolsContent = fs.readFileSync(path.join(__dirname, '../src/services/ai/tools.js'), 'utf8');
        const triggerMatch = toolsContent.match(/get_next_action_recommendation:\s*(\/.*?\/[gimsuy]*)/);
        assert(triggerMatch, 'TOOL_TRIGGERS must define get_next_action_recommendation');

        const regex = eval(triggerMatch[1]);
        assert(regex.test('What should I do?'), 'Should match "What should I do?"');
        assert(regex.test("What's the correct process?"), 'Should match "What\'s the correct process?"');
        assert(regex.test('What is the correct process?'), 'Should match "What is the correct process?"');
        assert(regex.test('How should I handle this?'), 'Should match "How should I handle this?"');
        assert(regex.test('What next action should I take?'), 'Should match "next action"');
        assert(regex.test('Customer says order marked delivered but not received, what should I do?'), 'Should match compound question');
    });

    console.log('\n============================================================');
    console.log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
    console.log('============================================================\n');

    if (testsFailed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
