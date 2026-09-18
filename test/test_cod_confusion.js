/**
 * Automated tests for Change 6: COD Confusion Diagnostic Handler and Refund Flow
 * Run: node test/test_cod_confusion.js
 */

const assert = require('assert');
const fs = require('fs');
const { detectSopScenario, applyRefundGuardrails } = require('../src/services/ai/customerAgent');

console.log('Testing COD Confusion Diagnostic Handler (Change 6)...\n');

// 1. Scenario Detection for diverse customer inquiries
const testQueries = [
    'I already paid online why is delivery boy asking for cash?',
    'courier is asking for money but I paid online',
    'delivery boy is asking for money at the door',
    'delivery guy demanding cash for my prepaid order',
    'why is it showing COD when I already paid?',
    'already paid online courier asking cod',
    'paid online why delivery partner demanding payment'
];

for (const q of testQueries) {
    const scenario = detectSopScenario(q);
    assert.strictEqual(
        scenario,
        'cod_confusion',
        `Query "${q}" should be classified as cod_confusion, got "${scenario}"`
    );
}
console.log('✅ detectSopScenario accurately classifies diverse COD confusion customer queries');

// 2. System Prompt & SOP Policy Instructions
const agentSource = fs.readFileSync('./src/services/ai/customerAgent.js', 'utf8');

assert(
    agentSource.includes('converted the order to COD without re-applying the prepaid discount'),
    'Must explain the root cause of COD conversion'
);
assert(
    agentSource.includes('accept the package and pay the delivery executive at the door'),
    'Must advise customer to accept and pay at door to avoid RTO'
);
assert(
    agentSource.includes('refund that exact paid amount back') && agentSource.includes('original payment method or bank account'),
    'Must promise refund of the exact collected cash back to original payment method or bank account'
);
assert(
    agentSource.includes('[COD_DOUBLE_PAYMENT_REFUND]'),
    'Must specify the [COD_DOUBLE_PAYMENT_REFUND] ticket tag'
);
console.log('✅ customerAgent.js system prompt contains complete SOP Scenario 7 root-cause & resolution guidance');

// 3. Guardrails Exemption for COD Double-Payment Refunds
// COD double payment refund to original payment/bank account must NOT be forced into store credit!
const codRefundQuery = 'I already paid online but courier took cash at delivery, please refund that cash to my bank account';
const validCodRefundReply = 'We understand the issue! Since you paid online and also paid cash at delivery, our team will verify the payment and refund the collected cash amount directly to your original payment method or bank account within 5 to 7 business days.';

const guardrailOutput = applyRefundGuardrails(validCodRefundReply, codRefundQuery, { lastScenario: 'cod_confusion' });
assert.strictEqual(
    guardrailOutput,
    validCodRefundReply,
    'applyRefundGuardrails must not alter or force store credit for COD double-payment refunds'
);
assert(
    !guardrailOutput.includes('store credit only'),
    'COD double-payment refund must not say store credit only'
);
console.log('✅ applyRefundGuardrails exempts COD double-payment refunds from store credit restrictions');

// 4. Client-side Widget (testbot.js) Flow & Buttons
const testbotSource = fs.readFileSync('./public/widget/js/testbot.js', 'utf8');

assert(testbotSource.includes('support_cod_confusion'), 'testbot.js must define support_cod_confusion action');
assert(testbotSource.includes('raise_cod_refund_ticket'), 'testbot.js must define raise_cod_refund_ticket action');
assert(testbotSource.includes('[COD_DOUBLE_PAYMENT_REFUND]'), 'testbot.js must tag tickets with [COD_DOUBLE_PAYMENT_REFUND]');
assert(testbotSource.includes('Paid Online but Asking COD'), 'testbot.js must include Paid Online but Asking COD button label');
assert(testbotSource.includes('awaiting_cod_order_id'), 'testbot.js must handle awaiting_cod_order_id flow state');
assert(testbotSource.includes('accept the package and pay the delivery executive'), 'testbot.js must reassure and instruct doorstep payment to prevent RTO');

console.log('✅ testbot.js contains complete interactive COD confusion flow, buttons, and ticket creation');

console.log('\nAll Change 6 tests PASSED successfully!');
