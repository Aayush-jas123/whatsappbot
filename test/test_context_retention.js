/**
 * Automated tests for Change 12: Context Retention & Persistent Entities Across Reloads
 * Run: node test/test_context_retention.js
 */

const assert = require('assert');
const fs = require('fs');

console.log('Testing Context Retention & Persistent Entities (Change 12)...\n');

// 1. Verify testbot.js client storage and entity persistence helpers
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

assert(testbotSource.includes('function getStoredEntities()'), 'testbot.js must define getStoredEntities');
assert(testbotSource.includes('function saveStoredEntities(patch)'), 'testbot.js must define saveStoredEntities');
assert(testbotSource.includes('function syncSessionContextFromServer()'), 'testbot.js must define syncSessionContextFromServer');
assert(testbotSource.includes('offcomfrt_tb_entities'), 'testbot.js must use offcomfrt_tb_entities in sessionStorage');
console.log('✅ testbot.js entity storage and synchronization helpers verified');

// 2. Verify smart context-aware flow confirmations in testbot.js
assert(testbotSource.includes('We found your active Order'), 'startTrackOrder must offer 1-click tracking for known order');
assert(testbotSource.includes('track_order_direct_'), 'testbot.js must handle direct track order action');
assert(testbotSource.includes('check_return_direct_'), 'testbot.js must handle direct check return action');
assert(testbotSource.includes('edit_order_direct_'), 'testbot.js must handle direct edit order action');
assert(testbotSource.includes('track_request_direct_'), 'testbot.js must handle direct track request action');
assert(testbotSource.includes('I have your Order'), 'startContactSupport must acknowledge known active order');
console.log('✅ testbot.js smart context-aware cards and direct action routing verified');

// 3. Verify widgetRoutes.js context retention endpoints
const widgetRoutesSource = fs.readFileSync('./src/routes/widgetRoutes.js', 'utf8');

assert(widgetRoutesSource.includes('router.get(\'/session-context\''), 'widgetRoutes.js must expose GET /session-context endpoint');
assert(widgetRoutesSource.includes('const { sessionId, message, visitorId, entities } = req.body;'), 'POST /chat must accept entities in body');
assert(widgetRoutesSource.includes('entities: result.entities'), 'POST /chat response must return enriched entities');
console.log('✅ widgetRoutes.js session context endpoint and entity passing verified');

// 4. Verify customerAgent.js context retention prompt and runtime handling
const agentSource = fs.readFileSync('./src/services/ai/customerAgent.js', 'utf8');

assert(agentSource.includes('Customer\'s registered mobile number:'), 'buildSystemPrompt must format customer phone from context');
assert(agentSource.includes('Customer\'s name:'), 'buildSystemPrompt must format customer name from context');
assert(agentSource.includes('PERSISTENT CONTEXT RETENTION:'), 'System prompt rules must enforce persistent context retention');
assert(agentSource.includes('entities: context'), 'runCustomerAgent return payload must include entities');
assert(agentSource.includes('getSessionAsync'), 'customerAgent must export getSessionAsync');
console.log('✅ customerAgent.js prompt instructions and entity returns verified');

// 5. Functional test of context merging in customerAgent runtime
const { runCustomerAgent, getSessionAsync } = require('../src/services/ai/customerAgent');

async function testRuntimeContextRetention() {
    const testSessionId = 'test_ctx_' + Date.now();
    const initialEntities = {
        orderId: '42000',
        phone: '9876543210',
        customerName: 'Aayush',
        lastScenario: 'tracking'
    };

    // First call: pass client entities into agent
    const res = await runCustomerAgent({
        sessionId: testSessionId,
        message: 'Where is my order?',
        visitorId: 'test_vis_123',
        entities: initialEntities
    });

    assert(res, 'runCustomerAgent must return a valid response object');
    assert(res.entities, 'Response must include updated entities');
    assert.strictEqual(res.entities.orderId, '42000', 'Entities must preserve orderId');
    assert.strictEqual(res.entities.phone, '9876543210', 'Entities must preserve phone');
    assert.strictEqual(res.entities.customerName, 'Aayush', 'Entities must preserve customerName');

    // Second call: simulate reload / follow-up query without re-providing order number
    const sessionState = await getSessionAsync(testSessionId);
    assert.strictEqual(sessionState.context.orderId, '42000', 'Session store must persist orderId');
    assert.strictEqual(sessionState.context.phone, '9876543210', 'Session store must persist phone');

    console.log('✅ Runtime context persistence across conversation turns verified');
}

testRuntimeContextRetention()
    .then(() => {
        console.log('\n========================================');
        console.log('All Context Retention tests passed! 🚀');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ Test failed:', err);
        process.exit(1);
    });
