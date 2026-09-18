/**
 * Automated tests for Change 11: Return & Exchange Request Tracking Rich Status Cards
 * Run: node test/test_return_status_cards.js
 */

const assert = require('assert');
const fs = require('fs');

console.log('Testing Return & Exchange Request Tracking Rich Status Cards (Change 11)...\n');

// 1. Verify CSS styles in testbot.js
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

assert(testbotSource.includes('.oftb-return-card'), 'testbot.js must have .oftb-return-card style');
assert(testbotSource.includes('.oftb-return-card-header'), 'testbot.js must have .oftb-return-card-header style');
assert(testbotSource.includes('.oftb-return-type'), 'testbot.js must have .oftb-return-type style');
assert(testbotSource.includes('.oftb-return-status'), 'testbot.js must have .oftb-return-status style');
assert(testbotSource.includes('.oftb-return-approved'), 'testbot.js must have .oftb-return-approved style');
assert(testbotSource.includes('.oftb-return-pending'), 'testbot.js must have .oftb-return-pending style');
assert(testbotSource.includes('.oftb-return-scheduled'), 'testbot.js must have .oftb-return-scheduled style');
assert(testbotSource.includes('.oftb-return-transit'), 'testbot.js must have .oftb-return-transit style');
assert(testbotSource.includes('.oftb-return-completed'), 'testbot.js must have .oftb-return-completed style');
assert(testbotSource.includes('.oftb-return-rejected'), 'testbot.js must have .oftb-return-rejected style');
assert(testbotSource.includes('.oftb-return-highlight'), 'testbot.js must have .oftb-return-highlight style');
assert(testbotSource.includes('.oftb-return-explanation'), 'testbot.js must have .oftb-return-explanation style');
assert(testbotSource.includes('.oftb-return-nextstep'), 'testbot.js must have .oftb-return-nextstep style');
console.log('✅ All return & exchange status badge and card CSS classes verified in testbot.js');

// 2. Verify addRequestCard rendering logic in testbot.js
assert(testbotSource.includes('addRequestCard(req)'), 'testbot.js must have addRequestCard function');
assert(testbotSource.includes('req.status_class'), 'addRequestCard must use status_class for styling');
assert(testbotSource.includes('req.status_label'), 'addRequestCard must use status_label');
assert(testbotSource.includes('req.pickup_scheduled_date'), 'addRequestCard must render pickup_scheduled_date highlight');
assert(testbotSource.includes('req.refund_amount'), 'addRequestCard must render refund_amount highlight');
assert(testbotSource.includes('Store Credit'), 'addRequestCard must display store credit tag for refunds');
assert(testbotSource.includes('oftb-return-explanation'), 'addRequestCard must render explanation box');
assert(testbotSource.includes('oftb-return-nextstep'), 'addRequestCard must render next step guidance');
console.log('✅ addRequestCard rich rendering logic verified in testbot.js');

// 3. Verify widgetRoutes.js implementation
const widgetRoutesSource = fs.readFileSync('./src/routes/widgetRoutes.js', 'utf8');

assert(widgetRoutesSource.includes('function enrichRequestStatus(r)'), 'widgetRoutes.js must define enrichRequestStatus');
assert(widgetRoutesSource.includes('pickup_scheduled_date: r.pickup_scheduled_date'), 'widgetRoutes.js must map pickup_scheduled_date in returns/exchanges');
assert(widgetRoutesSource.includes('refund_amount: r.refund_amount'), 'widgetRoutes.js must map refund_amount in returns');
assert(widgetRoutesSource.includes('deduped.map(enrichRequestStatus)'), 'widgetRoutes.js must enrich track-request results');
console.log('✅ widgetRoutes.js enrichRequestStatus and data mapping verified');

// 4. Test enrichRequestStatus behavior across SOP scenarios
// Create a sandbox execution of enrichRequestStatus
const enrichFnMatch = widgetRoutesSource.match(/function enrichRequestStatus\(r\)\s*\{([\s\S]*?)\n\}/);
assert(enrichFnMatch, 'enrichRequestStatus function body must be parseable');
const enrichRequestStatus = new Function('r', enrichFnMatch[1]);

// Scenario A: Pending / Under Review
const pendingRes = enrichRequestStatus({ status: 'pending', type: 'return' });
assert.strictEqual(pendingRes.stage, 'pending_approval');
assert.strictEqual(pendingRes.status_label, 'Under Review');
assert.strictEqual(pendingRes.status_class, 'oftb-return-pending');
assert(pendingRes.explanation.includes('24 to 48 hours'), 'Pending explanation must mention 24-48h SLA');
assert(pendingRes.next_step.includes('brand tags attached'), 'Next step must mention brand tags');
console.log('✅ Scenario: Pending / Under review correctly enriched');

// Scenario B: Pickup Scheduled
const scheduledRes = enrichRequestStatus({
    status: 'pickup_scheduled',
    type: 'return',
    pickup_scheduled_date: '2026-09-20'
});
assert.strictEqual(scheduledRes.stage, 'pickup_scheduled');
assert.strictEqual(scheduledRes.status_label, 'Pickup Scheduled');
assert.strictEqual(scheduledRes.status_class, 'oftb-return-scheduled');
assert(scheduledRes.explanation.includes('Reverse pickup has been scheduled'), 'Explanation must mention scheduled pickup');
assert(scheduledRes.next_step.includes('hand over the securely packed parcel'), 'Next step must instruct handing over to executive');
console.log('✅ Scenario: Pickup Scheduled correctly enriched');

// Scenario C: Approved
const approvedRes = enrichRequestStatus({ status: 'approved', type: 'exchange' });
assert.strictEqual(approvedRes.stage, 'approved');
assert.strictEqual(approvedRes.status_label, 'Approved');
assert.strictEqual(approvedRes.status_class, 'oftb-return-approved');
assert(approvedRes.explanation.includes('2 to 3 business days'), 'Approved explanation must mention 2-3 business days');
console.log('✅ Scenario: Approved correctly enriched');

// Scenario D: In Transit
const transitRes = enrichRequestStatus({ status: 'in_transit', type: 'return' });
assert.strictEqual(transitRes.stage, 'in_transit');
assert.strictEqual(transitRes.status_label, 'In Transit to Warehouse');
assert.strictEqual(transitRes.status_class, 'oftb-return-transit');
assert(transitRes.explanation.includes('fulfillment center'), 'Explanation must mention fulfillment center');
assert(transitRes.next_step.includes('24 to 48 hours'), 'Next step must mention quality check duration');
console.log('✅ Scenario: In Transit correctly enriched');

// Scenario E: Completed Return (Store Credit)
const completedReturnRes = enrichRequestStatus({
    status: 'completed',
    type: 'return',
    refund_amount: 1499
});
assert.strictEqual(completedReturnRes.stage, 'completed');
assert.strictEqual(completedReturnRes.status_label, 'Refund Completed');
assert.strictEqual(completedReturnRes.status_class, 'oftb-return-completed');
assert(completedReturnRes.explanation.includes('1499'), 'Explanation must mention refund amount');
assert(completedReturnRes.explanation.includes('Store credit'), 'Explanation must mention store credit');
console.log('✅ Scenario: Completed Return (Store Credit) correctly enriched');

// Scenario F: Completed Exchange
const completedExchangeRes = enrichRequestStatus({
    status: 'completed',
    type: 'exchange'
});
assert.strictEqual(completedExchangeRes.stage, 'completed');
assert.strictEqual(completedExchangeRes.status_label, 'Exchange Dispatched');
assert.strictEqual(completedExchangeRes.status_class, 'oftb-return-completed');
assert(completedExchangeRes.explanation.toLowerCase().includes('dispatched'), 'Explanation must mention dispatch');
console.log('✅ Scenario: Completed Exchange correctly enriched');

// Scenario G: Rejected
const rejectedRes = enrichRequestStatus({
    status: 'rejected',
    type: 'return',
    rejection_reason: 'Return requested beyond 2-day delivery window'
});
assert.strictEqual(rejectedRes.stage, 'rejected');
assert.strictEqual(rejectedRes.status_label, 'Request Rejected');
assert.strictEqual(rejectedRes.status_class, 'oftb-return-rejected');
assert(rejectedRes.explanation.includes('beyond 2-day delivery window'), 'Explanation must include rejection reason');
assert(rejectedRes.next_step.includes('support team for a manual case review'), 'Next step must offer support escalation');
console.log('✅ Scenario: Rejected correctly enriched');

console.log('\n========================================');
console.log('All Return Status Cards tests passed! 🚀');
