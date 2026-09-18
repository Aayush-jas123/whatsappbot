/**
 * Automated tests for Change 4: Full 9-Scenario SOP Knowledge Integration in customerAgent.js
 * Run: node test/test_sop_integration.js
 */

const assert = require('assert');
const fs = require('fs');

console.log('Testing Full 9-Scenario SOP Integration (Change 4)...\n');

const agentSource = fs.readFileSync('./src/services/ai/customerAgent.js', 'utf8');

// 1. Verify all 9 SOP Scenarios are embedded in customerAgent.js
const expectedScenarios = [
    'tracking',
    'delayed_pod',
    'refund_policy',
    'size_exchange',
    'damaged_wrong_item',
    'address_change',
    'cod_confusion',
    'cancellation',
    'escalation'
];

for (const sc of expectedScenarios) {
    assert(agentSource.includes(`**${sc}**`), `customerAgent.js must contain SOP scenario definition for ${sc}`);
}
console.log('✅ All 9 SOP scenario definitions verified in system prompt');

// 2. Verify key SOP policy details in customerAgent.js
assert(agentSource.includes('Shiprocket (primary) → Delhivery One → Ekart'), 'Must state exact carrier sequence');
assert(agentSource.includes('24 to 48 hours'), 'Must state 24 to 48 hours dispatch rule');
assert(agentSource.includes('Proof of Delivery (POD)'), 'Must include POD procedure');
assert(agentSource.includes('STORE CREDIT ONLY'), 'Must enforce store credit for preference/size returns');
assert(agentSource.includes('Unboxing video is MANDATORY'), 'Must require mandatory unboxing video for wrong items');
assert(agentSource.includes('cannot be rerouted mid-way'), 'Must state post-dispatch address rule');
assert(agentSource.includes('refund that exact paid amount back'), 'Must include COD confusion resolution');
assert(agentSource.includes('refuse delivery'), 'Must state COD post-dispatch cancellation rule');
assert(agentSource.includes('DO NOT offer or promise phone callbacks'), 'Must prohibit phone callbacks');
console.log('✅ All core SOP policy guardrails verified');

// 3. Test scenario detection logic
const detectMatch = agentSource.match(/function detectSopScenario\([\s\S]*?\n\}/);
assert(detectMatch, 'detectSopScenario must exist in customerAgent.js');
const detectSopScenario = new Function('text', detectMatch[0] + '\nreturn detectSopScenario(text);');

assert.strictEqual(detectSopScenario('Where is my package? Track order status'), 'tracking');
assert.strictEqual(detectSopScenario('It says delivered but I have not received my order'), 'delayed_pod');
assert.strictEqual(detectSopScenario('Can I get a refund back to my bank account?'), 'refund_policy');
assert.strictEqual(detectSopScenario('I need a size exchange for M to L'), 'size_exchange');
assert.strictEqual(detectSopScenario('I received damaged defective product'), 'damaged_wrong_item');
assert.strictEqual(detectSopScenario('I received wrong item, here is unboxing video'), 'damaged_wrong_item');
assert.strictEqual(detectSopScenario('Please update my delivery address to Mumbai'), 'address_change');
assert.strictEqual(detectSopScenario('Already paid online but courier is asking for COD cash at door'), 'cod_confusion');
assert.strictEqual(detectSopScenario('Please cancel my order #53388'), 'cancellation');
assert.strictEqual(detectSopScenario('This is fraud, I want a phone call from your manager'), 'escalation');

console.log('✅ detectSopScenario correctly classifies all 9 user scenarios');

// 4. Test entity extraction with scenario and phone detection
const extractMatch = agentSource.match(/function extractEntities\([\s\S]*?\n\}/);
assert(extractMatch, 'extractEntities must exist in customerAgent.js');
const extractEntities = new Function('text', detectMatch[0] + '\n' + extractMatch[0] + '\nreturn extractEntities(text);');

const test1 = extractEntities('Where is my order #53686? My phone is 9596317406');
assert.strictEqual(test1.orderId, '53686');
assert.strictEqual(test1.phone, '9596317406');
assert.strictEqual(test1.lastScenario, 'tracking');

const test2 = extractEntities('Cancel order 42000');
assert.strictEqual(test2.orderId, '42000');
assert.strictEqual(test2.lastScenario, 'cancellation');

console.log('✅ extractEntities correctly captures orderId, phone, and lastScenario');

console.log('\n========================================');
console.log('All 9 SOP Integration tests passed! 🚀');
