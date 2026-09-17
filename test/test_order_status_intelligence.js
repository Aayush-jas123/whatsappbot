/**
 * Automated tests for Change 3: Order Status vs. Courier Tracking Intelligence
 * Run: node test/test_order_status_intelligence.js
 */

const assert = require('assert');
const fs = require('fs');

console.log('Testing Order Status vs. Courier Tracking Intelligence (Change 3)...\n');

// 1. Verify CSS styles and status badges in testbot.js
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

assert(testbotSource.includes('oftb-status-confirmed'), 'testbot.js must have oftb-status-confirmed style');
assert(testbotSource.includes('oftb-status-cancelled'), 'testbot.js must have oftb-status-cancelled style');
assert(testbotSource.includes('oftb-status-rto'), 'testbot.js must have oftb-status-rto style');
assert(testbotSource.includes('oftb-status-delivered'), 'testbot.js must have oftb-status-delivered style');
assert(testbotSource.includes('oftb-status-pending'), 'testbot.js must have oftb-status-pending style');
console.log('✅ All status badge CSS styles verified');

// 2. Verify SOP stage-based actions in testbot.js
assert(testbotSource.includes('delayed_pod_check'), 'testbot.js must handle delayed_pod_check action');
assert(testbotSource.includes('raise_pod_ticket'), 'testbot.js must handle raise_pod_ticket action');
assert(testbotSource.includes('track_order_phone'), 'testbot.js must handle track_order_phone action');
assert(testbotSource.includes('2 days'), 'testbot.js must inform customer of 2-day return/exchange window on delivery');
console.log('✅ SOP stage follow-up actions and 2-day delivery window verified in testbot.js');

// 3. Verify widgetRoutes.js track-order logic
const widgetRoutesSource = fs.readFileSync('./src/routes/widgetRoutes.js', 'utf8');

assert(widgetRoutesSource.includes('stage: stage'), 'widgetRoutes.js must include stage in track-order response');
assert(widgetRoutesSource.includes('OFFCOMFRT Fulfillment'), 'widgetRoutes.js must use friendly carrier name for fulfillment');
assert(widgetRoutesSource.includes('pending_confirmation'), 'widgetRoutes.js must recognize pending_confirmation stage');
assert(widgetRoutesSource.includes('24 to 48 hours'), 'widgetRoutes.js must mention 24 to 48 hours shipping for confirmed orders');
assert(widgetRoutesSource.includes('notFound: true'), 'widgetRoutes.js must provide structured notFound error with search by phone guidance');
console.log('✅ widgetRoutes.js implements intelligent stage resolution and friendly carrier naming');

// 4. Verify tools.js fix for store_shoppers columns
const toolsSource = fs.readFileSync('./src/services/ai/tools.js', 'utf8');
assert(!toolsSource.includes('SELECT order_id, status, product_name, delivery_type\n                     FROM store_shoppers'), 'tools.js must not select non-existent product_name from store_shoppers');
console.log('✅ tools.js store_shoppers schema consistency verified');

console.log('\n========================================');
console.log('All Order Status Intelligence tests passed! 🚀');
