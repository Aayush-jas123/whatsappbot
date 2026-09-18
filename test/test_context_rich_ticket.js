/**
 * Automated test suite for Change 14: Context-Rich Ticket Escalation with AI Summary & WhatsApp Deep Link
 * Run: node test/test_context_rich_ticket.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateEscalationSummary, createWidgetTicket } = require('../src/services/ai/customerAgent');

console.log('Testing Change 14: Context-Rich Ticket Escalation with AI Summary & WhatsApp Deep Link...\n');

// 1. Test generateEscalationSummary with scenario tags
const codMsg = '[COD_DOUBLE_PAYMENT_REFUND] Customer paid online but courier demanded cash at delivery. Advised to pay to prevent RTO.';
const codSummary = generateEscalationSummary(codMsg);
assert(codSummary.includes('COD Double Payment'), 'Must identify COD Double Payment');
assert(codSummary.includes('refund required'), 'Must specify refund required');
console.log('✅ generateEscalationSummary: Handled COD double payment tag');

const podMsg = '[POD_INVESTIGATION] Order #42000: Customer reports package marked as delivered was not received.';
const podSummary = generateEscalationSummary(podMsg);
assert(podSummary.includes('Delayed Delivery'), 'Must identify Delayed Delivery');
assert(podSummary.includes('POD inquiry'), 'Must specify POD inquiry');
console.log('✅ generateEscalationSummary: Handled POD investigation tag');

const damagedMsg = '[DAMAGED_ITEM_CLAIM] Order #53686: Customer received damaged shirt with torn seam.';
const damagedSummary = generateEscalationSummary(damagedMsg);
assert(damagedSummary.includes('Damaged Product'), 'Must identify Damaged Product');
console.log('✅ generateEscalationSummary: Handled damaged item claim tag');

const wrongMsg = '[WRONG_ITEM_CLAIM] Order #53686: Customer received completely different hoodie.';
const wrongSummary = generateEscalationSummary(wrongMsg);
assert(wrongSummary.includes('Wrong Product Delivered'), 'Must identify Wrong Product Delivered');
assert(wrongSummary.includes('unboxing video'), 'Must note unboxing video verification');
console.log('✅ generateEscalationSummary: Handled wrong item claim tag');

const editSizeMsg = '[PRE-DISPATCH SIZE CHANGE] Order #42000: Requested New Size: XL';
const editSizeSummary = generateEscalationSummary(editSizeMsg);
assert(editSizeSummary.includes('Pre-Dispatch Size Change'), 'Must identify pre-dispatch size change');
console.log('✅ generateEscalationSummary: Handled pre-dispatch size change tag');

// 2. Test fallback message text cleaning
const generalMsg = '[Website] [Delivery Problem] [Order #42000] When is my package arriving? It has been 4 days.';
const generalSummary = generateEscalationSummary(generalMsg);
assert(!generalSummary.includes('[Website]'), 'Must strip [Website] tag');
assert(!generalSummary.includes('[Delivery Problem]'), 'Must strip topic tag');
assert(!generalSummary.includes('[Order #42000]'), 'Must strip bracketed order tag');
assert(generalSummary.includes('When is my package arriving'), 'Must retain core customer question');
console.log('✅ generateEscalationSummary: Correctly cleaned raw ticket message');

// 3. Test createWidgetTicket return structure and WhatsApp deep link formatting
(async () => {
    const mockPayload = {
        name: 'Test Customer',
        phone: '9876543210',
        email: 'test@example.com',
        message: '[POD_INVESTIGATION] Package not delivered',
        orderId: '53686',
        source: 'website'
    };

    const result = await createWidgetTicket(mockPayload);
    assert(result.ticketNumber && result.ticketNumber.startsWith('WDG-'), 'Must return valid ticketNumber');
    assert(result.summary && result.summary.includes('Delayed Delivery'), 'Must return generated issue summary');
    assert(result.whatsappLink && result.whatsappLink.includes('wa.me'), 'Must return WhatsApp deep link');
    assert(result.whatsappLink.includes(encodeURIComponent('WDG-')), 'WhatsApp link must contain encoded ticket number');
    assert(result.whatsappLink.includes(encodeURIComponent('53686')), 'WhatsApp link must contain order ID');
    assert(result.whatsappLink.includes(encodeURIComponent('Delayed Delivery')), 'WhatsApp link must contain issue summary');
    console.log('✅ createWidgetTicket: Enriched ticket creation and prefilled WhatsApp link verified');

    // 4. Verify widgetRoutes.js POST /api/widget/ticket handles summary & context
    const widgetRoutesSrc = fs.readFileSync(path.join(__dirname, '../src/routes/widgetRoutes.js'), 'utf8');
    assert(widgetRoutesSrc.includes('summary: result.summary'), 'widgetRoutes.js must return summary in ticket response');
    assert(widgetRoutesSrc.includes('ticketId: result.ticketId'), 'widgetRoutes.js must return ticketId in ticket response');
    console.log('✅ widgetRoutes.js: /ticket endpoint returns summary and ticketId');

    // 5. Verify testbot.js renders summary in addTicketConfirmation
    const testbotSrc = fs.readFileSync(path.join(__dirname, '../public/widget/js/testbot.js'), 'utf8');
    assert(testbotSrc.includes('Issue Summary:'), 'testbot.js must render Issue Summary in confirmation');
    assert(testbotSrc.includes('context: flowContext'), 'testbot.js doCreateSupportTicket must pass context');
    console.log('✅ testbot.js: Client correctly renders Issue Summary and synchronizes context');

    console.log('\n========================================');
    console.log('All Change 14 Context-Rich Ticket tests passed! 🚀');
    process.exit(0);
})().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
