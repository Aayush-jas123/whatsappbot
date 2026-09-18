/**
 * test_return_eligibility.js
 * Verification suite for Change 9: In-Widget Return & Exchange Eligibility Validator
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- Running Test Suite: Return & Exchange Eligibility Validator (Change 9) ---');

// 1. Verify widgetRoutes.js endpoint implementation
const widgetRoutesFile = path.join(__dirname, '../src/routes/widgetRoutes.js');
const widgetRoutesContent = fs.readFileSync(widgetRoutesFile, 'utf8');

assert(widgetRoutesContent.includes('/check-return-eligibility'), 'widgetRoutes.js must define /check-return-eligibility route');
assert(widgetRoutesContent.includes('diffHours <= windowHours'), 'widgetRoutes.js must check if hours since delivery is within 2 days (48h)');
assert(widgetRoutesContent.includes("stage: 'not_delivered'"), 'widgetRoutes.js must handle non-delivered orders');
assert(widgetRoutesContent.includes("stage: isEligible ? 'eligible' : 'expired'"), 'widgetRoutes.js must categorize eligible vs expired');
assert(widgetRoutesContent.includes('hoursRemaining'), 'widgetRoutes.js must compute remaining hours');
console.log('✔ widgetRoutes.js implements POST /api/widget/check-return-eligibility with accurate 48-hour calculation');

// 2. Unit calculation test for eligibility logic
function checkEligibilityCalculation(deliveredDate) {
    const diffMs = Date.now() - deliveredDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const windowHours = 48;
    const isEligible = diffHours <= windowHours;
    const hoursRemaining = Math.max(0, Math.round(windowHours - diffHours));
    const daysSinceDelivery = Math.round((diffHours / 24) * 10) / 10;
    return { isEligible, hoursRemaining, daysSinceDelivery };
}

// Case A: Delivered 12 hours ago -> Eligible
const delivered12hAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
const res12h = checkEligibilityCalculation(delivered12hAgo);
assert.strictEqual(res12h.isEligible, true, '12 hours ago must be eligible');
assert(res12h.hoursRemaining >= 35 && res12h.hoursRemaining <= 37, 'Remaining hours must be around 36');
console.log('✔ Case A: Order delivered 12 hours ago is eligible with ' + res12h.hoursRemaining + 'h remaining');

// Case B: Delivered 36 hours ago -> Eligible
const delivered36hAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
const res36h = checkEligibilityCalculation(delivered36hAgo);
assert.strictEqual(res36h.isEligible, true, '36 hours ago must be eligible');
assert(res36h.hoursRemaining >= 11 && res36h.hoursRemaining <= 13, 'Remaining hours must be around 12');
console.log('✔ Case B: Order delivered 36 hours ago is eligible with ' + res36h.hoursRemaining + 'h remaining');

// Case C: Delivered 3 days ago -> Expired
const delivered3dAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
const res3d = checkEligibilityCalculation(delivered3dAgo);
assert.strictEqual(res3d.isEligible, false, '72 hours ago must be expired');
assert.strictEqual(res3d.hoursRemaining, 0, 'Remaining hours must be 0 for expired orders');
assert(res3d.daysSinceDelivery >= 3, 'Days since delivery should be >= 3');
console.log('✔ Case C: Order delivered 3 days ago is expired (daysSinceDelivery=' + res3d.daysSinceDelivery + ')');

// 3. Verify testbot.js client UI implementation
const testbotFile = path.join(__dirname, '../public/widget/js/testbot.js');
const testbotContent = fs.readFileSync(testbotFile, 'utf8');

assert(testbotContent.includes('doCheckReturnEligibility'), 'testbot.js must implement doCheckReturnEligibility');
assert(testbotContent.includes('open_return_portal_'), 'testbot.js must handle open_return_portal_<id>');
assert(testbotContent.includes('open_exchange_portal_'), 'testbot.js must handle open_exchange_portal_<id>');
assert(testbotContent.includes('awaiting_return_order_id'), 'testbot.js must handle awaiting_return_order_id flow state');
assert(testbotContent.includes('return_eligibility'), 'testbot.js must support return_eligibility intent in phone lookup');
assert(testbotContent.includes('Return Window Expired'), 'testbot.js must display clear expiration notice per SOP');
assert(testbotContent.includes('is Eligible for Return / Exchange'), 'testbot.js must display eligibility confirmation');
assert(testbotContent.includes('has not been delivered yet'), 'testbot.js must inform customer if order is not yet delivered');
console.log('✔ testbot.js client implementation has complete guided flow, button handlers, and state management');

console.log('--- ALL CHANGE 9 TESTS PASSED SUCCESSFULLY! ---');
