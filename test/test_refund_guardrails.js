/**
 * Automated tests for Change 5: SOP Refund vs. Store Credit Guardrails
 * Run: node test/test_refund_guardrails.js
 */

const assert = require('assert');
const { applyRefundGuardrails } = require('../src/services/ai/customerAgent');

console.log('Testing SOP Refund vs. Store Credit Guardrails (Change 5)...\n');

// 1. Intercept hallucinated bank refund for size exchange
const sizeQuery = 'I want to exchange size M to L, can I get refund in my bank account?';
const badModelReply1 = 'Sure, we have initiated your return and the refund will be processed to your bank account within 5-7 business days.';
const correctedReply1 = applyRefundGuardrails(badModelReply1, sizeQuery, { lastScenario: 'size_exchange' });

assert(correctedReply1.includes('store credit'), 'Must state store credit for size exchange');
assert(!correctedReply1.includes('Sure, we have initiated your return and the refund will be processed to your bank account'), 'Must strip erroneous bank refund promise');
console.log('✅ Intercepted hallucinated bank refund for size exchange');

// 2. Intercept hallucinated card/UPI refund for change of mind / preference
const preferenceQuery = "I didn't like the fabric, can you refund to my original payment method or UPI?";
const badModelReply2 = 'Yes, the amount will be credited back to your original payment method or UPI.';
const correctedReply2 = applyRefundGuardrails(badModelReply2, preferenceQuery, { lastScenario: 'return_exchange' });

assert(correctedReply2.includes('store credit'), 'Must enforce store credit for preference returns');
assert(!correctedReply2.includes('Yes, the amount will be credited back to your original payment method'), 'Must block card/UPI refund promise for preference');
console.log('✅ Intercepted hallucinated card/UPI refund for preference return');

// 3. Allow original payment refund for damaged items (SOP-compliant)
const damagedQuery = 'I received a damaged and torn shirt, need my refund';
const validDamagedReply = 'We apologize for the damaged item! Please share photos of the damage and tags at offcomfrt.in/pages/return within 2 days of delivery. Once verified, a refund to your original payment method will be processed within 5-7 business days.';
const outputDamaged = applyRefundGuardrails(validDamagedReply, damagedQuery, { lastScenario: 'damaged_wrong_item' });

assert.strictEqual(outputDamaged, validDamagedReply, 'Must not alter valid refund reply for damaged items');
console.log('✅ Correctly allowed original payment refund for damaged items');

// 4. Allow original payment refund for wrong product with unboxing video
const wrongQuery = 'Wrong item received, I have the unboxing video ready';
const validWrongReply = 'Thank you for having the unboxing video ready! Please submit your claim at offcomfrt.in/pages/return. Once verified by our team, a full refund to your original payment method will be issued.';
const outputWrong = applyRefundGuardrails(validWrongReply, wrongQuery, { lastScenario: 'damaged_wrong_item' });

assert.strictEqual(outputWrong, validWrongReply, 'Must not alter valid refund reply for wrong items');
console.log('✅ Correctly allowed original payment refund for wrong product');

// 5. Allow original payment refund for pre-dispatch cancellations
const cancelQuery = 'Cancel my prepaid order #53686 before dispatch';
const validCancelReply = 'Your cancellation request has been received. Since your order has not shipped yet, your full refund will be processed to your original payment method within 5 to 7 business days.';
const outputCancel = applyRefundGuardrails(validCancelReply, cancelQuery, { lastScenario: 'cancellation' });

assert.strictEqual(outputCancel, validCancelReply, 'Must not alter valid cancellation refund');
console.log('✅ Correctly allowed original payment refund for pre-dispatch cancellations');

// 6. Generic bank refund inquiry without damage/wrong item
const genericBankQuery = 'Can I get a cash refund to my Google Pay?';
const genericReply = 'Yes, you can request a return.';
const correctedGeneric = applyRefundGuardrails(genericReply, genericBankQuery, {});

assert(correctedGeneric.includes('store credit only'), 'Must inform customer that general returns receive store credit only');
console.log('✅ Handled generic cash/bank refund inquiry with store credit clarification');

console.log('\n========================================');
console.log('All SOP Refund vs. Store Credit Guardrails tests passed! 🚀');
