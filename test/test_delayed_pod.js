/**
 * Automated tests for Change 7: Delayed Delivery & Proof of Delivery (POD) Workflow
 * Run: node test/test_delayed_pod.js
 */

const assert = require('assert');
const fs = require('fs');
const { detectSopScenario } = require('../src/services/ai/customerAgent');

console.log('Testing Delayed Delivery & Proof of Delivery (POD) Workflow (Change 7)...\n');

// 1. Scenario Detection for various "delivered but not received" customer queries
const podQueries = [
    'It says delivered but I have not received my order',
    'tracking says delivered but I didn\'t get it',
    'package marked delivered but not delivered to me',
    'courier marked delivered but nothing arrived',
    'fake delivery marked by courier partner',
    'delivery boy marked delivered without delivering',
    'where is my order it shows delivered but missing',
    'can you provide proof of delivery for my shipment',
    'I want to request POD from courier'
];

for (const q of podQueries) {
    const scenario = detectSopScenario(q);
    assert.strictEqual(
        scenario,
        'delayed_pod',
        `Query "${q}" should be classified as delayed_pod, got "${scenario}"`
    );
}
console.log('✅ detectSopScenario accurately classifies diverse "delivered but not received" inquiries');

// 2. System Prompt & SOP Policy Instructions
const agentSource = fs.readFileSync('./src/services/ai/customerAgent.js', 'utf8');

assert(
    agentSource.includes('building security guard, reception desk, or neighbours'),
    'Must instruct customer to check with security/reception/neighbours'
);
assert(
    agentSource.includes('requested official Proof of Delivery (POD)'),
    'Must state official Proof of Delivery (POD) request'
);
assert(
    agentSource.includes('within 24 hours'),
    'Must promise update within 24 hours per SOP'
);
assert(
    agentSource.includes('[POD_INVESTIGATION]'),
    'Must instruct ticket tagging with [POD_INVESTIGATION]'
);
console.log('✅ customerAgent.js system prompt contains complete SOP Scenario 2 (Delayed Delivery / POD) policy');

// 3. Client-side Widget (testbot.js) Flow & Buttons
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

assert(testbotSource.includes('support_delayed_pod'), 'testbot.js must define support_delayed_pod action');
assert(testbotSource.includes('raise_pod_ticket'), 'testbot.js must define raise_pod_ticket action');
assert(testbotSource.includes('[POD_INVESTIGATION]'), 'testbot.js must tag tickets with [POD_INVESTIGATION]');
assert(testbotSource.includes('Delivered but Not Received (POD)'), 'testbot.js must include Delivered but Not Received (POD) button label');
assert(testbotSource.includes('awaiting_pod_order_id'), 'testbot.js must handle awaiting_pod_order_id flow state');
assert(testbotSource.includes('pod_inquiry'), 'testbot.js must support pod_inquiry intent in phone search');
assert(testbotSource.includes('24 hours'), 'testbot.js must promise 24-hour SLA in POD response');

console.log('✅ testbot.js contains complete interactive POD workflow, buttons, and ticket creation');

console.log('\nAll Change 7 tests PASSED successfully!');
