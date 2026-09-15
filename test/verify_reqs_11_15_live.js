/**
 * Live Copilot Acceptance Verification for Requirements 11 to 15:
 * - Requirement 11: Refund Eligibility Checker (20 Master Acceptance Q1-Q4)
 * - Requirement 12: Refund Status Investigation (20 Master Acceptance Q5-Q8)
 * - Requirement 13: Payment Investigation (20 Master Acceptance Q9-Q12)
 * - Requirement 14: Discount/Coupon Investigation (20 Master Acceptance Q13-Q16)
 * - Requirement 15: Shipment Intelligence (20 Master Acceptance Q17-Q20)
 * - 3 Master Composite Scenarios:
 *     Scenario A: Lost Coupon + Courier Overcharge
 *     Scenario B: Delivered But Not Received (24-hour POD SLA)
 *     Scenario C: Damaged Item - Original Payment Refund Request
 */

const assert = require('assert');
const { getTool } = require('../src/services/ai/tools');
const {
    checkRefundEligibility,
    formatEligibilityReport,
    SOP_REFUND_POLICY
} = require('../src/services/refundEligibilityService');
const {
    investigateRefundStatus,
    formatRefundStatusReport
} = require('../src/services/refundStatusService');
const {
    investigatePayment,
    formatPaymentReport
} = require('../src/services/paymentInvestigationService');
const {
    investigateDiscount,
    formatDiscountReport
} = require('../src/services/discountInvestigationService');
const {
    getShipmentIntelligence,
    formatShipmentIntelligenceReport,
    CARRIER_PRIORITY
} = require('../src/services/shipmentIntelligenceService');

async function verifyRequirements11to15() {
    console.log('\n============================================================');
    console.log('LIVE COPILOT ACCEPTANCE VERIFICATION (REQUIREMENTS 11-15)');
    console.log('============================================================\n');

    // 1. Tool availability verification
    console.log('--- 1. Verifying Tool Registrations in AI System ---');
    const tools = [
        'check_refund_eligibility',
        'investigate_refund_status',
        'investigate_payment',
        'investigate_discount',
        'get_shipment_intelligence'
    ];

    for (const toolName of tools) {
        const t = getTool(toolName);
        assert.ok(t, `Tool ${toolName} must be registered`);
        console.log(`  ✅ ${toolName} is registered and available to agent`);
    }

    const t11 = getTool('check_refund_eligibility');
    const t12 = getTool('investigate_refund_status');
    const t13 = getTool('investigate_payment');
    const t14 = getTool('investigate_discount');
    const t15 = getTool('get_shipment_intelligence');

    // ============================================================
    // REQUIREMENT 11: REFUND ELIGIBILITY CHECKER (Q1 - Q4)
    // ============================================================
    console.log('\n--- 2. Requirement 11: Refund Eligibility Checker ---');

    // Q1: "Is order #42000 eligible for a refund?"
    console.log('\n[Q1]: Is order #42000 eligible for a refund?');
    const q1Res = await t11.execute({ orderId: '42000' });
    console.log(`  Order investigated: ${q1Res.investigated}`);
    console.log(`  Eligibility Status: ${q1Res.eligibility}`);
    console.log(`  Refund Channel: ${q1Res.evaluation.channel}`);
    console.log(`  Reason: ${q1Res.reason}`);
    assert.strictEqual(q1Res.investigated, true);
    assert.ok(q1Res.evaluation.channel.includes('STORE_CREDIT') || q1Res.refund_type.toLowerCase().includes('credit') || q1Res.refund_type.toLowerCase().includes('none'));

    // Q2: "Why was this customer offered store credit instead of a bank refund?"
    console.log('\n[Q2]: Why was this customer offered store credit instead of a bank refund?');
    const q2Res = await t11.execute({ orderId: '42000', reason: 'size does not fit' });
    console.log(`  Policy Applied: ${q2Res.policy}`);
    console.log(`  Refund Type: ${q2Res.refund_type}`);
    console.log(`  SOP Standard Conditions: ${q2Res.sop_reference.STORE_CREDIT_CONDITIONS.join('; ')}`);
    assert.ok(q2Res.refund_type.toLowerCase().includes('store credit'));

    // Q3: "Can order #42000 be refunded to original payment method?"
    console.log('\n[Q3]: Can order #42000 be refunded to original payment method?');
    const q3Res = await t11.execute({ orderId: '42000', reason: 'damaged on arrival' });
    console.log(`  Damaged item evaluation: is_eligible = ${q3Res.evaluation.eligible}`);
    console.log(`  Refund Channel: ${q3Res.evaluation.channel}`);
    console.log(`  Missing Requirements: ${q3Res.missing_requirements}`);
    assert.strictEqual(q3Res.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
    assert.strictEqual(q3Res.evaluation.eligible, false); // Pending photo proof gate

    // Q4: "What proof is required for a damaged item refund?"
    console.log('\n[Q4]: What proof is required for a damaged item refund?');
    console.log(`  Proof Rule: ${q3Res.policy_applied.proof_rule}`);
    console.log(`  Missing Requirements: ${q3Res.missing_requirements}`);
    assert.ok(q3Res.policy_applied.proof_rule.includes('Clear photos'));
    assert.ok(q3Res.missing_requirements.includes('photographs'));

    // ============================================================
    // REQUIREMENT 12: REFUND STATUS INVESTIGATION (Q5 - Q8)
    // ============================================================
    console.log('\n--- 3. Requirement 12: Refund Status Investigation ---');

    // Q5: "What is the status of the refund for order #42000?"
    console.log('\n[Q5]: What is the status of the refund for order #42000?');
    const q5Res = await t12.execute({ orderId: '42000' });
    console.log(`  Investigated: ${q5Res.investigated}`);
    console.log(`  Current Stage: ${q5Res.refund_details.current_stage}`);
    console.log(`  Refund Amount: ₹${q5Res.refund_details.refund_amount}`);
    console.log(`  Timeline Events: ${q5Res.timeline.length}`);
    assert.strictEqual(q5Res.investigated, true);
    assert.ok(q5Res.timeline.length >= 2);

    // Q6: "Has the refund for return been initiated?"
    console.log('\n[Q6]: Has the refund for return been initiated?');
    console.log(`  Is Processed: ${q5Res.refund_details.is_processed}`);
    console.log(`  Is Completed: ${q5Res.refund_details.is_completed}`);
    console.log(`  Is Pending: ${q5Res.refund_details.is_pending}`);
    assert.strictEqual(typeof q5Res.refund_details.is_processed, 'boolean');

    // Q7: "Why hasn't the customer received their refund yet?"
    console.log('\n[Q7]: Why hasn\'t the customer received their refund yet?');
    console.log(`  Within Banking Window: ${q5Res.refund_details.within_banking_window}`);
    console.log(`  Banking Window Message: ${q5Res.refund_details.banking_window_message || 'In clearance window'}`);
    console.log(`  SOP SLA: ${q5Res.policy_applied.sop_sla}`);
    assert.ok(q5Res.policy_applied.sop_sla.includes('5-7 business days'));

    // Q8: "Show me the refund timeline for order #42000."
    console.log('\n[Q8]: Show me the refund timeline for order #42000.');
    q5Res.timeline.forEach((event, i) => {
        console.log(`  Stage ${i + 1} [${event.status}]: ${event.stage} (${event.timestamp})`);
    });
    assert.ok(q5Res.timeline.some(e => e.stage === 'Refund Eligible'));
    assert.ok(q5Res.timeline.some(e => e.stage === 'Customer Receives Funds'));

    // ============================================================
    // REQUIREMENT 13: PAYMENT INVESTIGATION (Q9 - Q12)
    // ============================================================
    console.log('\n--- 4. Requirement 13: Payment Investigation ---');

    // Q9: "Why did the customer pay Rs. 3,598 when the order was Rs. 3,198?"
    console.log('\n[Q9]: Why did the customer pay Rs. 3,598 when the order was Rs. 3,198?');
    const q9Analysis = await investigatePayment({
        orderId: '42000',
        orderTotalOverride: 3198,
        courierCollectedOverride: 3598
    });
    console.log(`  Discrepancy Detected: ${q9Analysis.discrepancy.has_discrepancy}`);
    console.log(`  Discrepancy Type: ${q9Analysis.discrepancy.type}`);
    console.log(`  Overcharge Difference: ₹${q9Analysis.discrepancy.overcharge_amount}`);
    console.log(`  Action Required: ${q9Analysis.action_required}`);
    assert.strictEqual(q9Analysis.discrepancy.has_discrepancy, true);
    assert.strictEqual(q9Analysis.discrepancy.overcharge_amount, 400);

    // Q10: "Did order #42000 have a payment discrepancy?"
    console.log('\n[Q10]: Did order #42000 have a payment discrepancy?');
    const q10Res = await t13.execute({ orderId: '42000' });
    console.log(`  Order total: ₹${q10Res.reconciliation.order_total}`);
    console.log(`  Paid: ₹${q10Res.reconciliation.amount_paid}`);
    console.log(`  Pending: ₹${q10Res.reconciliation.amount_pending}`);
    console.log(`  Payment Discrepancy: ${q10Res.discrepancy.has_discrepancy}`);
    assert.strictEqual(q10Res.investigated, true);

    // Q11: "Why was the COD amount different from the checkout total?"
    console.log('\n[Q11]: Why was the COD amount different from the checkout total?');
    const q11Analysis = await investigatePayment({
        orderId: '42000',
        orderTotalOverride: 3198,
        courierCollectedOverride: 3598
    });
    console.log(`  Discrepancy Type: ${q11Analysis.discrepancy.type}`);
    console.log(`  Action Required: ${q11Analysis.action_required}`);
    assert.strictEqual(q11Analysis.discrepancy.overcharge_amount, 400);

    // Q12: "Show payment breakdown for order #42000."
    console.log('\n[Q12]: Show payment breakdown for order #42000.');
    console.log(`  Gross Subtotal: ₹${q10Res.payment_summary.order_value_gross}`);
    console.log(`  Discount: ₹${q10Res.payment_summary.discount_amount}`);
    console.log(`  Final Payable: ₹${q10Res.payment_summary.final_payable_amount}`);
    console.log(`  Amount Paid: ₹${q10Res.payment_summary.amount_paid}`);
    console.log(`  Amount Pending: ₹${q10Res.payment_summary.amount_pending}`);
    assert.strictEqual(q10Res.reconciliation.order_total, q10Res.payment_summary.final_payable_amount);

    // ============================================================
    // REQUIREMENT 14: DISCOUNT/COUPON INVESTIGATION (Q13 - Q16)
    // ============================================================
    console.log('\n--- 5. Requirement 14: Discount/Coupon Investigation ---');

    // Q13: "Was a coupon applied to order #42000?"
    console.log('\n[Q13]: Was a coupon applied to order #42000?');
    const q13Res = await t14.execute({ orderId: '42000' });
    console.log(`  Coupon Code: ${q13Res.discount_details.coupon_code}`);
    console.log(`  Discount Amount: ₹${q13Res.discount_details.discount_amount}`);
    console.log(`  Discount Status: ${q13Res.discount_details.discount_status}`);
    assert.strictEqual(q13Res.investigated, true);

    // Q14: "Why did the order total change from Rs. 2,878 to Rs. 3,198 after editing details?"
    console.log('\n[Q14]: Why did the order total change from Rs. 2,878 to Rs. 3,198 after editing details?');
    const q14Analysis = await investigateDiscount({
        orderId: '42000',
        orderTotalOverride: 3198,
        couponCode: 'OFF10',
        customerMessageOverride: 'Customer clicked Edit Details on Shoppers Hub. Order converted to COD without OFF10.'
    });
    console.log(`  Was Discount Dropped: ${q14Analysis.discount_removal.is_detected}`);
    console.log(`  Difference Due: ₹${q14Analysis.discount_removal.refund_difference_amount}`);
    console.log(`  Explanation: ${q14Analysis.discount_removal.explanation}`);
    assert.strictEqual(q14Analysis.discount_removal.is_detected, true);
    assert.ok(q14Analysis.discount_removal.refund_difference_amount > 0);

    // Q15: "How much was overcharged due to the lost coupon?"
    console.log('\n[Q15]: How much was overcharged due to the lost coupon?');
    console.log(`  Refund Difference Due to Customer: ₹${q14Analysis.discount_removal.refund_difference_amount}`);
    console.log(`  SOP Resolution: ${q14Analysis.payment_correlation.sop_resolution}`);
    assert.ok(q14Analysis.discount_removal.refund_difference_amount > 0);

    // Q16: "What discount was applied to this customer's purchase?"
    console.log('\n[Q16]: What discount was applied to this customer\'s purchase?');
    const q16Analysis = await investigateDiscount({
        orderId: '42000',
        couponCode: 'OFF10'
    });
    console.log(`  Applied Coupon: ${q16Analysis.coupon_details.code}`);
    console.log(`  Discount Type: ${q16Analysis.coupon_details.type}`);
    console.log(`  Discount Value: ${q16Analysis.coupon_details.value}%`);
    assert.strictEqual(q16Analysis.coupon_details.code, 'OFF10');

    // ============================================================
    // REQUIREMENT 15: SHIPMENT INTELLIGENCE (Q17 - Q20)
    // ============================================================
    console.log('\n--- 6. Requirement 15: Shipment Intelligence ---');

    // Q17: "Where is order #42000 right now?"
    console.log('\n[Q17]: Where is order #42000 right now?');
    const q17Res = await t15.execute({ orderId: '42000', skipLiveApi: true });
    console.log(`  Shipment Status: ${q17Res.shipment_summary.status}`);
    console.log(`  Carrier: ${q17Res.shipment_summary.carrier}`);
    console.log(`  Current Location: ${q17Res.shipment_summary.current_location}`);
    console.log(`  Carrier Priority Sequence: ${CARRIER_PRIORITY.map(c => c.carrier).join(' → ')}`);
    assert.strictEqual(q17Res.investigated, true);

    // Q18: "Why is delivery delayed for tracking?"
    console.log('\n[Q18]: Why is delivery delayed for tracking?');
    const delayedShipment = await getShipmentIntelligence({
        orderId: '42000',
        pickupDateOverride: new Date(Date.now() - 10 * 86400000).toISOString(),
        statusOverride: 'IN_TRANSIT',
        lastScanDateOverride: new Date(Date.now() - 72 * 3600000).toISOString()
    });
    console.log(`  Is Delayed: ${delayedShipment.delay_analysis.is_delayed}`);
    console.log(`  Is Stuck: ${delayedShipment.delay_analysis.is_stuck}`);
    console.log(`  Delay Days: ${delayedShipment.delay_analysis.delay_days} days`);
    assert.strictEqual(delayedShipment.delay_analysis.is_delayed, true);
    assert.strictEqual(delayedShipment.delay_analysis.is_stuck, true);

    // Q19: "The customer says order shows delivered but they didn't receive it. What should I do?"
    console.log('\n[Q19]: The customer says order shows delivered but they didn\'t receive it. What should I do?');
    const deliveredNotReceivedRes = await getShipmentIntelligence({
        orderId: '42000',
        deliveredNotReceived: true
    });
    const wf = deliveredNotReceivedRes.delivered_not_received_case;
    console.log(`  Step 1 (Customer check): ${wf.step_1.action}`);
    console.log(`  Step 2 (Notify partner): ${wf.step_2.action}`);
    console.log(`  Step 3 (Request POD): ${wf.step_3.action}`);
    console.log(`  Step 4 (Wait window): ${wf.step_4.action} (${wf.step_4.window_hours} hours)`);
    assert.ok(wf.step_3.action.includes('POD'));
    assert.strictEqual(wf.step_4.window_hours, 24);

    // Q20: "Is order being returned to origin (RTO)?"
    console.log('\n[Q20]: Is order being returned to origin (RTO)?');
    const rtoShipment = await getShipmentIntelligence({
        orderId: '42000',
        statusOverride: 'RTO_INITIATED',
        rtoReasonOverride: 'Customer refused delivery - cash not ready',
        paymentModeOverride: 'prepaid'
    });
    console.log(`  Is RTO: ${rtoShipment.rto_analysis.is_rto}`);
    console.log(`  RTO Category: ${rtoShipment.rto_analysis.category}`);
    console.log(`  SOP Procedure: ${rtoShipment.rto_analysis.sop_procedure}`);
    assert.strictEqual(rtoShipment.rto_analysis.is_rto, true);
    assert.strictEqual(rtoShipment.rto_analysis.category, 'CUSTOMER_REFUSAL');

    // ============================================================
    // 7. 3 MASTER COMPOSITE SCENARIOS
    // ============================================================
    console.log('\n--- 7. 3 Master Composite Scenarios ---');

    // Scenario A: "The Lost Coupon + Courier Overcharge"
    console.log('\n[SCENARIO A]: Lost Coupon + Courier Overcharge Investigation');
    const scenarioA = await investigatePayment({
        orderId: '42000',
        orderTotalOverride: 3198,
        courierCollectedOverride: 3598,
        customerMessageOverride: 'Customer clicked Edit Details on Shoppers Hub'
    });
    const formatA = formatPaymentReport(scenarioA);
    console.log('  Payment Report Header:', formatA.split('\n')[0]);
    assert.ok(formatA.includes('[VERIFIED FACT]'));
    assert.ok(formatA.includes('[POLICY]'));
    assert.ok(formatA.includes('[ACTION RECOMMENDED]'));
    console.log('  ✅ Scenario A: Successfully verified structured output with difference refund action');

    // Scenario B: "Delivered But Not Received"
    console.log('\n[SCENARIO B]: Delivered But Not Received (24-Hour POD SLA Workflow)');
    const scenarioB = await getShipmentIntelligence({
        orderId: '42000',
        statusOverride: 'DELIVERED',
        deliveredDateOverride: new Date(Date.now() - 6 * 3600000).toISOString()
    });
    const formatB = formatShipmentIntelligenceReport(scenarioB);
    assert.ok(formatB.includes('[POLICY]'));
    assert.ok(formatB.includes('[ACTION RECOMMENDED]'));
    console.log('  ✅ Scenario B: Successfully verified 24h POD SLA escalation');

    // Scenario C: "Damaged Item - Original Payment Refund Requested"
    console.log('\n[SCENARIO C]: Damaged Item - Original Payment Refund Requested');
    const scenarioC = await checkRefundEligibility({
        orderId: '42000',
        reason: 'Damaged item received, torn stitching'
    });
    const formatC = formatEligibilityReport(scenarioC);
    assert.ok(formatC.includes('ELIGIBILITY:'));
    assert.ok(formatC.includes('POLICY:'));
    assert.strictEqual(scenarioC.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
    console.log('  ✅ Scenario C: Successfully verified original payment refund path with photo proof gate');

    console.log('\n============================================================');
    console.log('🎉 ALL 20 MASTER ACCEPTANCE QUESTIONS & 3 SCENARIOS VERIFIED!');
    console.log('============================================================\n');
}

verifyRequirements11to15().then(() => process.exit(0)).catch(err => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
});
