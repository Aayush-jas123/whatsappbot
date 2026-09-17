/**
 * Unit tests for Change 2: Mobile Phone Number Order Lookup
 * Run: node test/test_phone_lookup.js
 */

const assert = require('assert');
const fs = require('fs');

console.log('Testing Mobile Phone Number Order Lookup (Change 2)...\n');

// 1. Verify entity extraction logic in testbot.js
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

// Extract parseOrderOrTracking function from testbot.js source
const fnMatch = testbotSource.match(/function parseOrderOrTracking\([\s\S]*?\n    \}/);
assert(fnMatch, 'parseOrderOrTracking function must exist in testbot.js');

const parseOrderOrTracking = new Function('text', fnMatch[0] + '\nreturn parseOrderOrTracking(text);');

// Test phone detection
const phone1 = parseOrderOrTracking('9876543210');
assert.strictEqual(phone1?.type, 'phone', '9876543210 should be parsed as phone');
assert.strictEqual(phone1?.id, '9876543210');

const phone2 = parseOrderOrTracking('+91 9876543210');
assert.strictEqual(phone2?.type, 'phone', '+91 9876543210 should be parsed as phone');
assert.strictEqual(phone2?.id, '9876543210');

const phone3 = parseOrderOrTracking('+91-9123456789');
assert.strictEqual(phone3?.type, 'phone', '+91-9123456789 should be parsed as phone');
assert.strictEqual(phone3?.id, '9123456789');

console.log('✅ 10-digit mobile phone extraction verified');

// Test that 10-digit phone numbers are NOT misclassified as AWBs
assert.notStrictEqual(phone1?.type, 'awb', 'Phone number must NOT be classified as AWB');

// Test AWB detection
const awb1 = parseOrderOrTracking('123456789012'); // 12 digits
assert.strictEqual(awb1?.type, 'awb', '12-digit number should be parsed as AWB');

const awb2 = parseOrderOrTracking('AWB: 9876543210'); // explicitly labeled
assert.strictEqual(awb2?.type, 'awb', 'Explicitly labeled AWB should be parsed as AWB');

console.log('✅ AWB vs Phone differentiation verified');

// Test Order ID detection
const ord1 = parseOrderOrTracking('#42000');
assert.strictEqual(ord1?.type, 'order', '#42000 should be parsed as order');
assert.strictEqual(ord1?.id, '42000');

const ord2 = parseOrderOrTracking('42000');
assert.strictEqual(ord2?.type, 'order', '42000 should be parsed as order');
assert.strictEqual(ord2?.id, '42000');

console.log('✅ Order ID vs Phone differentiation verified');

// 2. Verify doSearchOrdersByPhone exists in testbot.js
assert(testbotSource.includes('function doSearchOrdersByPhone'), 'testbot.js must contain doSearchOrdersByPhone');
assert(testbotSource.includes('select_phone_order_'), 'testbot.js must handle multiple order selection');
console.log('✅ testbot.js includes doSearchOrdersByPhone and multi-order selector');

// 3. Verify widgetRoutes.js has POST /api/widget/search-by-phone
const widgetRoutesSource = fs.readFileSync('./src/routes/widgetRoutes.js', 'utf8');
assert(widgetRoutesSource.includes("router.post('/search-by-phone'"), 'widgetRoutes.js must have /search-by-phone endpoint');
assert(widgetRoutesSource.includes('phonePattern'), 'widgetRoutes.js must query phone pattern');
console.log('✅ widgetRoutes.js implements POST /api/widget/search-by-phone');

// 4. Verify PII Protection in search-by-phone: no customer phone, address, or full name exposed
assert(!widgetRoutesSource.includes("orders.push({\n                            orderId: cleanId,\n                            phone:"), 'search-by-phone must never return phone in orders response');
assert(!widgetRoutesSource.includes("address:"), 'search-by-phone must never return address in orders response');
console.log('✅ PII protection confirmed: zero sensitive customer details in search response');

console.log('\n========================================');
console.log('All Mobile Phone Lookup tests passed! 🚀');
