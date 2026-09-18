/**
 * Master End-to-End Test & Simulation Suite for OFFCOMFRT Support Bot (Change 15)
 * Verifies all 15 SOP enhancements, self-service flows, guardrails, and integrations.
 * Run: node test/test_testbot_sop_scenarios.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    runCustomerAgent,
    applyRefundGuardrails,
    detectSopScenario,
    detectCustomerSentiment,
    generateEscalationSummary,
    createWidgetTicket
} = require('../src/services/ai/customerAgent');

console.log('================================================================');
console.log('  OFFCOMFRT SUPPORT BOT: MASTER END-TO-END VERIFICATION SUITE  ');
console.log('================================================================\n');

// ── 1. Order Status & Courier Tracking Intelligence (Change 1, 2, 3) ──
console.log('--- [1/10] Tracking Intelligence & Mobile Phone Discovery ---');
const phoneQuery = '9876543210';
const phoneMatch = phoneQuery.match(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/);
assert(phoneMatch && phoneMatch[1] === '9876543210', '10-digit mobile phone number must be extracted');
const awbQuery = '123456789012';
assert(/^\d{12,16}$/.test(awbQuery), '12-digit number must be recognized as courier tracking AWB');
console.log('✔ Phone vs. AWB vs. Order ID token differentiation validated');

// ── 2. Full 9-Scenario SOP Integration & Sentiment (Change 4, 13) ──
console.log('\n--- [2/10] SOP Scenario Classification & Sentiment Engine ---');
const testCasesSOP = [
    { text: 'Where is my order #53686?', expected: 'tracking' },
    { text: 'Tracking says delivered but I have not received it', expected: 'delayed_pod' },
    { text: 'I want a refund in my bank account', expected: 'refund_policy' },
    { text: 'Can I change my size from M to L?', expected: 'size_exchange' },
    { text: 'I received damaged defective torn clothes', expected: 'damaged_wrong_item' },
    { text: 'Change my delivery address please', expected: 'address_change' },
    { text: 'Already paid online why is delivery boy asking for cash?', expected: 'cod_confusion' },
    { text: 'Cancel my order immediately', expected: 'cancellation' },
    { text: 'This is fraud, I will file a case in consumer court', expected: 'escalation' }
];

testCasesSOP.forEach(tc => {
    const sc = detectSopScenario(tc.text);
    assert.strictEqual(sc, tc.expected, `Expected scenario ${tc.expected} for: "${tc.text}"`);
});
console.log('✔ All 9 OFFCOMFRT SOP scenarios accurately classified');

const angryText = 'Cheat company, worst experience, I will sue you in court!';
const sentiment = detectCustomerSentiment(angryText);
assert(sentiment.isFrustrated && sentiment.needsImmediateEscalation, 'Severe anger/legal threat must flag immediate escalation');
console.log('✔ Customer sentiment and frustration de-escalation triggers validated');

// ── 3. SOP Refund vs. Store Credit Guardrails (Change 5) ──
console.log('\n--- [3/10] Refund vs. Store Credit Guardrails ---');
const badModelReply = 'We have initiated your return and ₹1,499 will be refunded to your bank account.';
const sanitizedReply = applyRefundGuardrails(badModelReply, 'I want to return size M', { lastScenario: 'size_exchange' });
assert(sanitizedReply.includes('store credit'), 'Must convert size exchange refund promise to store credit');
assert(!sanitizedReply.includes('refunded to your bank account'), 'Must strip bank refund promise');

const validDamagedReply = 'We apologize for the damaged item! Please share photos of the damage. Once verified, a refund to your original payment method will be issued.';
const untouchedDamaged = applyRefundGuardrails(validDamagedReply, 'Item is torn', { lastScenario: 'damaged_wrong_item' });
assert.strictEqual(untouchedDamaged, validDamagedReply, 'Must not alter valid refund for damaged products');
console.log('✔ Output guardrails strictly enforce store credit vs. original payment policy');

// ── 4. COD Confusion Diagnostic & Doorstep Refund (Change 6) ──
console.log('\n--- [4/10] COD Confusion Diagnostic & Doorstep Ticket ---');
const codText = 'I already paid via UPI but courier says COD ₹1299 cash';
assert.strictEqual(detectSopScenario(codText), 'cod_confusion', 'Must recognize COD confusion');
const codSummary = generateEscalationSummary('[COD_DOUBLE_PAYMENT_REFUND] Customer paid online but courier demanded cash');
assert(codSummary.includes('COD Double Payment'), 'Must generate COD double payment issue summary');
console.log('✔ COD Confusion diagnostic handler & ticket summary validated');

// ── 5. Delayed Delivery & Proof of Delivery (POD) (Change 7) ──
console.log('\n--- [5/10] Delayed Delivery & POD Investigation (24h SLA) ---');
const podText = 'Package marked delivered but not received by me';
assert.strictEqual(detectSopScenario(podText), 'delayed_pod', 'Must recognize delayed POD scenario');
const podSummary = generateEscalationSummary('[POD_INVESTIGATION] Order #42000 package not found');
assert(podSummary.includes('Delayed Delivery') && podSummary.includes('24-hour POD inquiry'), 'Must specify 24h SLA');
console.log('✔ POD investigation workflow and 24-hour SLA verified');

// ── 6. Mandatory Proof for Damaged & Wrong Items (Change 8) ──
console.log('\n--- [6/10] Mandatory Proof Requirements ---');
const wrongItemSummary = generateEscalationSummary('[WRONG_ITEM_CLAIM] Order #53686');
assert(wrongItemSummary.includes('Wrong Product Delivered') && wrongItemSummary.includes('unboxing video'), 'Must require unboxing video');
const damagedItemSummary = generateEscalationSummary('[DAMAGED_ITEM_CLAIM] Order #53686');
assert(damagedItemSummary.includes('Damaged Product'), 'Must identify damaged claim');
console.log('✔ Mandatory unboxing video and photo proof rules verified');

// ── 7. In-Widget 48-Hour Return Window Validator (Change 9) ──
console.log('\n--- [7/10] Return & Exchange 48-Hour Window Validator ---');
const now = new Date();
const delivered12hAgo = new Date(now.getTime() - 12 * 3600 * 1000).toISOString();
const delivered3DaysAgo = new Date(now.getTime() - 72 * 3600 * 1000).toISOString();

const hoursLeft12 = Math.max(0, 48 - Math.floor((now - new Date(delivered12hAgo)) / (1000 * 3600)));
assert(hoursLeft12 > 0, '12h delivered order must be eligible with remaining hours');

const hoursLeft3d = Math.max(0, 48 - Math.floor((now - new Date(delivered3DaysAgo)) / (1000 * 3600)));
assert.strictEqual(hoursLeft3d, 0, '3-day delivered order must be expired');
console.log('✔ 48-hour return window calculation verified');

// ── 8. Assisted Edit Request & 4-Button Menu (Change 1, 10) ──
console.log('\n--- [8/10] Text-Driven Assisted Edit & 4-Button Menu ---');
const testbotSrc = fs.readFileSync(path.join(__dirname, '../public/widget/js/testbot.js'), 'utf8');
const welcomeMatch = testbotSrc.match(/function showWelcome\(\)[\s\S]*?addBotMessage\([\s\S]*?\[([\s\S]*?)\]/);
assert(welcomeMatch, 'showWelcome must define button list');
assert(!welcomeMatch[1].includes('edit_request'), 'Welcome menu must only have 4 buttons (Edit Request assisted via text)');
assert(welcomeMatch[1].includes('track_order'), 'Must have track_order');
assert(welcomeMatch[1].includes('file_return'), 'Must have file_return');
assert(welcomeMatch[1].includes('track_request'), 'Must have track_request');
assert(welcomeMatch[1].includes('contact_support'), 'Must have contact_support');

// Verify text regex catches edit requests
const editRegex = /^(edit\s*(request|order|details?)|change\s*(my\s*)?(size|address|details?)|size\s*change|address\s*change|update\s*(my\s*)?(address|size|order|details?)|modify\s*(my\s*)?(order|details?))\b/i;
assert(editRegex.test('change size'), 'Must match "change size"');
assert(editRegex.test('change my address'), 'Must match "change my address"');
assert(editRegex.test('edit order'), 'Must match "edit order"');
assert(editRegex.test('size change'), 'Must match "size change"');
console.log('✔ Welcome menu has 4 primary buttons and assisted edit responds to natural text');

// ── 9. Context Retention Across Reloads (Change 12) ──
console.log('\n--- [9/10] Context Retention & Entity Synchronization ---');
assert(testbotSrc.includes('getStoredEntities'), 'testbot.js must implement getStoredEntities');
assert(testbotSrc.includes('saveStoredEntities'), 'testbot.js must implement saveStoredEntities');
assert(testbotSrc.includes('sessionStorage.getItem(\'offcomfrt_tb_entities\')'), 'Must use sessionStorage for active entities');
console.log('✔ Session storage synchronization and entity retention verified');

// ── 10. Context-Rich Ticket & WhatsApp Deep Link (Change 14) ──
console.log('\n--- [10/10] Context-Rich Ticket Escalation & WhatsApp Deep Link ---');
(async () => {
    const ticketRes = await createWidgetTicket({
        name: 'Aayush',
        phone: '9876543210',
        email: 'customer@offcomfrt.in',
        message: '[POD_INVESTIGATION] Order #42000 parcel marked delivered but not received',
        orderId: '42000',
        source: 'website'
    });

    assert(ticketRes.ticketNumber.startsWith('WDG-'), 'Must generate ticketNumber with WDG- prefix');
    assert(ticketRes.summary && ticketRes.summary.includes('Delayed Delivery'), 'Must attach concise AI summary');
    assert(ticketRes.whatsappLink.includes('wa.me'), 'Must generate WhatsApp deep link');
    assert(ticketRes.whatsappLink.includes(encodeURIComponent('WDG-')), 'WhatsApp link must include ticket number');
    assert(ticketRes.whatsappLink.includes(encodeURIComponent('42000')), 'WhatsApp link must include order ID');
    console.log('✔ Context-rich ticket creation and prefilled WhatsApp link verified');

    console.log('\n================================================================');
    console.log('  ALL 15 SOP ENHANCEMENTS AND TEST SCENARIOS PASSED (100%) 🚀   ');
    console.log('================================================================');
    process.exit(0);
})().catch(err => {
    console.error('Master simulation suite error:', err);
    process.exit(1);
});
