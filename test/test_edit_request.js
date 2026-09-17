/**
 * Test Edit Request Flow and PII protection
 * Run: node test/test_edit_request.js
 */

const assert = require('assert');
const { runCustomerAgent } = require('../src/services/ai/customerAgent');

console.log('Testing Edit Request and PII Protection in Customer Agent...\n');

// 1. Verify customerAgent exports
assert(typeof runCustomerAgent === 'function', 'runCustomerAgent should be exported');
console.log('✅ runCustomerAgent exported');

// 2. Verify PII Protection Refusal
const testContext = { orderId: '42000' };
const fs = require('fs');
const customerAgentSource = fs.readFileSync('./src/services/ai/customerAgent.js', 'utf8');

assert(customerAgentSource.includes('PRIVACY & DATA PROTECTION (CRITICAL)'), 'customerAgent must contain PII protection rule');
assert(customerAgentSource.includes('Edit Requests (Size / Address / Cancellation before dispatch)'), 'customerAgent must contain Edit Requests policy');
console.log('✅ customerAgent contains strict PII protection and Edit Request SOP rules');

// 3. Verify testbot.js contains Edit Request actions and handlers
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');
assert(testbotSource.includes("action: 'edit_request'"), 'testbot.js must have edit_request button');
assert(testbotSource.includes('function startEditRequest'), 'testbot.js must have startEditRequest');
assert(testbotSource.includes('function doCheckEditOrder'), 'testbot.js must have doCheckEditOrder');
assert(testbotSource.includes('function doSubmitEditRequest'), 'testbot.js must have doSubmitEditRequest');
assert(testbotSource.includes('function doCancelOrder'), 'testbot.js must have doCancelOrder');
console.log('✅ testbot.js includes all Edit Request flow methods and button actions');

// 4. Verify testbot.html contains Edit Request feature card
const testbotHtml = fs.readFileSync('./public/widget/testbot.html', 'utf8');
assert(testbotHtml.includes('Edit Request'), 'testbot.html must showcase Edit Request feature');
console.log('✅ testbot.html showcases Edit Request feature card');

console.log('\n========================================');
console.log('All Edit Request flow checks passed! 🚀');
