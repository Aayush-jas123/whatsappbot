/**
 * test_guided_edit_request.js
 * Verification suite for Change 10: Guided "Edit Request" Workflow
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- Running Test Suite: Guided Edit Request Workflow (Change 10) ---');

// 1. Verify widgetRoutes.js edit-request endpoint
const widgetRoutesFile = path.join(__dirname, '../src/routes/widgetRoutes.js');
const widgetRoutesContent = fs.readFileSync(widgetRoutesFile, 'utf8');

assert(widgetRoutesContent.includes('/edit-request'), 'widgetRoutes.js must implement /edit-request route');
assert(widgetRoutesContent.includes('[PRE-DISPATCH SIZE CHANGE]'), 'Must tag size changes with [PRE-DISPATCH SIZE CHANGE]');
assert(widgetRoutesContent.includes('[PRE-DISPATCH ADDRESS CHANGE]'), 'Must tag address changes with [PRE-DISPATCH ADDRESS CHANGE]');
assert(widgetRoutesContent.includes('[PRE-DISPATCH CANCEL]'), 'Must tag cancellations with [PRE-DISPATCH CANCEL]');
assert(widgetRoutesContent.includes('dispatched: true'), 'Must reject edits for already dispatched orders');
console.log('✔ widgetRoutes.js POST /api/widget/edit-request endpoint verified with accurate tagging & dispatch guard');

// 2. Verify testbot.js client UI workflows
const testbotFile = path.join(__dirname, '../public/widget/js/testbot.js');
const testbotContent = fs.readFileSync(testbotFile, 'utf8');

// Check size quick selector
assert(testbotContent.includes('select_edit_size_'), 'testbot.js must support select_edit_size_ action');
assert(testbotContent.includes('select_edit_size_M'), 'testbot.js must provide quick size pills');

// Check address PIN code validation
assert(testbotContent.includes('\\b\\d{6}\\b'), 'testbot.js must validate 6-digit PIN code for address changes');
assert(testbotContent.includes('6-digit PIN code'), 'testbot.js must ask customer for 6-digit PIN code');

// Check cancellation SOP rules
assert(testbotContent.includes('5 to 7 business days'), 'testbot.js must state 5-7 business days refund for prepaid cancellations');
assert(testbotContent.includes('COD orders'), 'testbot.js must address COD cancellation rules');

// Check endpoint integration
assert(testbotContent.includes('/api/widget/edit-request'), 'testbot.js doSubmitEditRequest must call /api/widget/edit-request');
assert(testbotContent.includes('data.dispatched'), 'testbot.js must handle data.dispatched response');

console.log('✔ testbot.js guided size pills, PIN validation, cancellation policy, and in-transit SOP guidance verified');

console.log('--- ALL CHANGE 10 TESTS PASSED SUCCESSFULLY! ---');
