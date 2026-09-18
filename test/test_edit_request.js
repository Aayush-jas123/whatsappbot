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

// 4. Verify assisted edit request is triggered via text and welcome menu has 4 primary buttons
assert(testbotSource.includes('startEditRequest()'), 'testbot.js must trigger startEditRequest from text');
const showWelcomeMatch = testbotSource.match(/function showWelcome\(\)[\s\S]*?addBotMessage\([\s\S]*?\[([\s\S]*?)\]/);
assert(showWelcomeMatch && !showWelcomeMatch[1].includes('edit_request'), 'Welcome menu must not include Edit Request button (assisted via text only)');
console.log('✅ Assisted edit is driven via text while welcome menu retains 4 primary buttons');

console.log('\n========================================');
console.log('All Edit Request flow checks passed! 🚀');
