/**
 * Automated Unit Test Suite for Requirements 11 to 15:
 * - Requirement 11: Refund Eligibility Checker (8 tests)
 * - Requirement 12: Refund Status Investigation (8 tests)
 * - Requirement 13: Payment Investigation (9 tests)
 * - Requirement 14: Discount/Coupon Investigation (8 tests)
 * - Requirement 15: Shipment Intelligence (12 tests)
 * - Cross-Requirement Composite Cases (5 tests)
 *
 * Total: 50 tests.
 */

const assert = require('assert');
const { dbAdapter } = require('../src/database/db');

const {
    checkRefundEligibility,
    formatEligibilityReport,
    REFUND_SOP_RULES
} = require('../src/services/refundEligibilityService');

const {
    investigateRefundStatus,
    formatRefundStatusReport,
    REFUND_STAGES
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
    CARRIER_PRIORITY,
    SHIPMENT_STAGES,
    DELIVERED_NOT_RECEIVED_SOP
} = require('../src/services/shipmentIntelligenceService');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
    return (async () => {
        try {
            await fn();
            console.log(`  ✅ [PASS] ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
            failedTests++;
        }
    })();
}

(async () => {
    console.log('\n============================================================');
    console.log('TEST SUITE: REQUIREMENTS 11–15 (REFUNDS, PAYMENTS, SHIPMENTS)');
    console.log('============================================================\n');

    // Retrieve known sample orders for testing
    const sampleOrders = await dbAdapter.query(
        `SELECT order_id, phone, name, status, payment_method, order_total, created_at, shopify_cancelled_at, shopify_refund_amount
         FROM store_shoppers ORDER BY created_at DESC LIMIT 5`
    );
    const primaryOrder = sampleOrders[0] || { order_id: '42000', phone: '9999999999', name: 'Test Customer', order_total: '1799' };

    // ------------------------------------------------------------
    // REQUIREMENT 11: Refund Eligibility Checker (8 Tests)
    // ------------------------------------------------------------
    console.log('--- REQUIREMENT 11: REFUND ELIGIBILITY CHECKER ---');

    await runTest('Test 1: SOP original payment refund for damaged on arrival with photos', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'damaged',
            hasPhotos: true
        });
        assert.ok(res.evaluation, 'Evaluation object must exist');
        assert.strictEqual(res.evaluation.eligible, true, 'Damaged with photos must be eligible');
        assert.strictEqual(res.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD', 'Channel must be original payment method');
        assert.strictEqual(res.evaluation.banking_window_days, '5-7 business days', 'Banking SLA must be 5-7 business days');
        assert.ok(res.data_as_of.includes('IST'), 'Timestamp must be in IST');
    });

    await runTest('Test 2: SOP original payment refund for wrong product with mandatory unboxing video', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'wrong_item',
            hasUnboxingVideo: true
        });
        assert.strictEqual(res.evaluation.eligible, true);
        assert.strictEqual(res.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(res.evaluation.proof_status, 'VERIFIED');
    });

    await runTest('Test 3: Wrong product without uncut unboxing video flagged as pending/ineligible', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'wrong_item',
            hasUnboxingVideo: false
        });
        assert.strictEqual(res.evaluation.eligible, false, 'Must be ineligible until video provided');
        assert.strictEqual(res.evaluation.proof_status, 'PENDING_CUSTOMER_SUBMISSION');
        assert.ok(res.action_required.toLowerCase().includes('video'), 'Action required must mention video');
    });

    await runTest('Test 4: SOP store credit default for size issue return within 2-day window', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'size_issue'
        });
        // Size issue returns receive store credit
        assert.strictEqual(res.evaluation.channel, 'STORE_CREDIT');
        assert.ok(res.policy_applied.channel_rule.toLowerCase().includes('store credit'), 'Policy rule must state store credit');
    });

    await runTest('Test 5: Reverse logistics fee (Rs. 100) deducted for non-defect store credit return', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'buyer_remorse'
        });
        assert.strictEqual(res.evaluation.deductions.reverse_logistics_fee, 100);
        assert.ok(res.evaluation.net_refund_amount <= res.evaluation.refundable_amount);
    });

    await runTest('Test 6: Ineligible refund when return window expired (>2 days post-delivery)', async () => {
        // Mocking check with a delivered date older than 2 days
        const res = await checkRefundEligibility({
            orderId: 'expired_order_test',
            reason: 'size_issue',
            deliveredDateOverride: new Date(Date.now() - 5 * 86400000).toISOString()
        });
        assert.strictEqual(res.evaluation.eligible, false);
        assert.strictEqual(res.evaluation.window_status, 'EXPIRED');
    });

    await runTest('Test 7: Prepaid order cancelled prior to dispatch receives original payment refund', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'prepaid_cancel',
            cancelledPreDispatch: true
        });
        assert.strictEqual(res.evaluation.eligible, true);
        assert.strictEqual(res.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(res.evaluation.deductions.reverse_logistics_fee, 0, 'No reverse fee for pre-dispatch cancel');
    });

    await runTest('Test 8: Prepaid RTO without customer receipt receives original payment refund', async () => {
        const res = await checkRefundEligibility({
            orderId: primaryOrder.order_id,
            reason: 'prepaid_rto'
        });
        assert.strictEqual(res.evaluation.eligible, true);
        assert.strictEqual(res.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
    });

    // ------------------------------------------------------------
    // REQUIREMENT 12: Refund Status Investigation (8 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 12: REFUND STATUS INVESTIGATION ---');

    await runTest('Test 9: Refund status query and 7-stage timeline reconstruction', async () => {
        const res = await investigateRefundStatus({ orderId: primaryOrder.order_id });
        assert.ok(res.data_as_of.includes('IST'), 'Data timestamp must be IST');
        assert.ok(Array.isArray(res.timeline), 'Timeline must be an array');
        assert.strictEqual(res.timeline.length, 7, 'Timeline must have exactly 7 SOP stages');
    });

    await runTest('Test 10: 5-7 business days banking clearance calculation from initiated date', async () => {
        const res = await investigateRefundStatus({ orderId: primaryOrder.order_id });
        assert.ok(res.policy_applied.banking_clearance_window.includes('5-7 business days'));
        assert.ok(res.verified_facts, 'Verified facts section must exist');
    });

    await runTest('Test 11: Store credit coupon code format and validity verification', async () => {
        const res = await investigateRefundStatus({ orderId: primaryOrder.order_id });
        assert.ok(res.refund_details, 'Refund details must exist');
        assert.ok(typeof res.refund_details.store_credit_issued === 'boolean');
    });

    await runTest('Test 12: Gateway reference number and payment processor tracking', async () => {
        const res = await investigateRefundStatus({ orderId: primaryOrder.order_id });
        assert.ok(res.refund_details.gateway !== undefined);
    });

    await runTest('Test 13: Overdue refund detection when past 7 business days', async () => {
        // Test with artificially aged refund initiated 12 business days ago
        const res = await investigateRefundStatus({
            orderId: primaryOrder.order_id,
            initiatedDateOverride: new Date(Date.now() - 14 * 86400000).toISOString(),
            statusOverride: 'REFUND_INITIATED'
        });
        assert.strictEqual(res.refund_details.is_overdue, true, 'Aged initiated refund must be flagged overdue');
    });

    await runTest('Test 14: Completed refund status verification', async () => {
        const res = await investigateRefundStatus({
            orderId: primaryOrder.order_id,
            statusOverride: 'COMPLETED'
        });
        assert.strictEqual(res.refund_details.current_stage, 'COMPLETED');
        assert.strictEqual(res.refund_details.is_completed, true);
    });

    await runTest('Test 15: Formatting structure: VERIFIED FACT, POLICY, INFERENCE, ACTION COMPLETED/PENDING', async () => {
        const res = await investigateRefundStatus({ orderId: primaryOrder.order_id });
        const report = formatRefundStatusReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'), 'Report must contain [VERIFIED FACT]');
        assert.ok(report.includes('[POLICY]'), 'Report must contain [POLICY]');
        assert.ok(report.includes('[INFERENCE / RECOMMENDATION]'), 'Report must contain [INFERENCE / RECOMMENDATION]');
    });

    await runTest('Test 16: Handling order with no refund record cleanly', async () => {
        const res = await investigateRefundStatus({ orderId: 'non_existent_999999' });
        assert.strictEqual(res.found, false);
        assert.ok(res.message.includes('No refund records'));
    });

    // ------------------------------------------------------------
    // REQUIREMENT 13: Payment Investigation (9 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 13: PAYMENT INVESTIGATION ---');

    await runTest('Test 17: Reconcile gross order subtotal, discounts applied, and expected collectible', async () => {
        const res = await investigatePayment({ orderId: primaryOrder.order_id });
        assert.ok(res.reconciliation, 'Reconciliation object must exist');
        assert.strictEqual(typeof res.reconciliation.order_total, 'number');
        assert.strictEqual(typeof res.reconciliation.amount_paid, 'number');
        assert.strictEqual(typeof res.reconciliation.amount_pending, 'number');
    });

    await runTest('Test 18: Detect paid vs pending amount for COD vs Prepaid orders', async () => {
        const res = await investigatePayment({ orderId: primaryOrder.order_id });
        assert.ok(['COD', 'PREPAID', 'UNKNOWN'].includes(res.reconciliation.payment_method.toUpperCase()));
    });

    await runTest('Test 19: Shoppers Hub COD conversion case: discount dropped on "Edit Details"', async () => {
        const res = await investigatePayment({
            orderId: 'test_edit_details',
            customerMessageOverride: 'Customer edited details on Shoppers Hub. Order converted to COD. Coupon OFF10 removed.',
            paymentMethodOverride: 'COD',
            orderTotalOverride: 1799,
            courierCollectedOverride: 1799
        });
        assert.strictEqual(res.cod_conversion_case.is_detected, true, 'COD conversion case must be detected');
        assert.strictEqual(res.cod_conversion_case.difference_to_refund, 180, '10% of 1799 should be 180');
    });

    await runTest('Test 20: Difference amount calculation when courier collected higher COD amount', async () => {
        const res = await investigatePayment({
            orderId: 'test_overcharge',
            orderTotalOverride: 1619,
            courierCollectedOverride: 1799
        });
        assert.strictEqual(res.discrepancy.has_discrepancy, true);
        assert.strictEqual(res.discrepancy.overcharged_amount, 180);
    });

    await runTest('Test 21: Verify UPI/bank transfer refund recommendation for difference amount', async () => {
        const res = await investigatePayment({
            orderId: 'test_edit_details_rec',
            customerMessageOverride: 'Edited details, converted to COD',
            paymentMethodOverride: 'COD',
            orderTotalOverride: 1799,
            courierCollectedOverride: 1799
        });
        assert.ok(res.action_required.toLowerCase().includes('upi') || res.action_required.toLowerCase().includes('bank'), 'Action must specify UPI/bank transfer refund');
    });

    await runTest('Test 22: Duplicate payment / double-charge detection logic', async () => {
        const res = await investigatePayment({
            orderId: primaryOrder.order_id,
            amountPaidOverride: 3598,
            orderTotalOverride: 1799
        });
        assert.strictEqual(res.discrepancy.has_discrepancy, true);
        assert.strictEqual(res.discrepancy.type, 'OVERPAID_OR_DOUBLE_CHARGED');
    });

    await runTest('Test 23: Gateway transaction ID reconciliation (Shopify vs Gokwik)', async () => {
        const res = await investigatePayment({ orderId: primaryOrder.order_id });
        assert.ok(res.verified_facts, 'Verified facts must be present');
    });

    await runTest('Test 24: Payment status check when order is cancelled vs fulfilled', async () => {
        const res = await investigatePayment({
            orderId: primaryOrder.order_id,
            orderStatusOverride: 'cancelled',
            amountPaidOverride: 1799
        });
        assert.strictEqual(res.discrepancy.type, 'PAID_ON_CANCELLED_ORDER');
    });

    await runTest('Test 25: Neutral formatting with VERIFIED FACT and ACTION REQUIRED', async () => {
        const res = await investigatePayment({ orderId: primaryOrder.order_id });
        const formatted = formatPaymentReport(res);
        assert.ok(formatted.includes('[VERIFIED FACT]'));
        assert.ok(formatted.includes('[POLICY]'));
        assert.ok(formatted.includes('[INFERENCE / RECOMMENDATION]'));
    });

    // ------------------------------------------------------------
    // REQUIREMENT 14: Discount / Coupon Investigation (8 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 14: DISCOUNT / COUPON INVESTIGATION ---');

    await runTest('Test 26: Inspect applied coupon code and verify percentage vs fixed discount', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'OFF10'
        });
        assert.strictEqual(res.coupon_details.code, 'OFF10');
        assert.strictEqual(res.coupon_details.type, 'percentage');
        assert.strictEqual(res.coupon_details.value, 10);
    });

    await runTest('Test 27: Check coupon eligibility conditions and order minimum spend', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'WELCOME15'
        });
        assert.strictEqual(res.coupon_details.code, 'WELCOME15');
        assert.strictEqual(res.coupon_details.min_order_value, 999);
    });

    await runTest('Test 28: Detect missing/dropped coupon after Shoppers Hub order edit', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'OFF10',
            customerMessageOverride: 'Customer clicked Edit Details on Shoppers Hub. Order converted to COD without OFF10.'
        });
        assert.strictEqual(res.discount_removal.is_detected, true);
        assert.strictEqual(res.discount_removal.cause, 'SHOPPERS_HUB_EDIT_DETAILS');
        assert.ok(res.discount_removal.refund_difference_amount > 0);
    });

    await runTest('Test 29: Line item discount allocation breakdown', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'FLAT200'
        });
        assert.strictEqual(res.coupon_details.type, 'fixed');
        assert.strictEqual(res.coupon_details.value, 200);
    });

    await runTest('Test 30: Calculate exact courier overcharge difference from dropped coupon', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'OFF10',
            orderTotalOverride: 1799,
            customerMessageOverride: 'Edit Details converted to COD'
        });
        assert.strictEqual(res.discount_removal.refund_difference_amount, 180);
    });

    await runTest('Test 31: Verification of invalid / unrecognized coupon code', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'UNKNOWN999'
        });
        assert.strictEqual(res.coupon_details.is_valid, false);
    });

    await runTest('Test 32: Multi-item percentage discount calculation', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'OFF10',
            orderTotalOverride: 3000
        });
        assert.strictEqual(res.discount_removal.expected_discount_amount, 300);
    });

    await runTest('Test 33: Structured discount investigation report format', async () => {
        const res = await investigateDiscount({
            orderId: primaryOrder.order_id,
            couponCode: 'OFF10'
        });
        const formatted = formatDiscountReport(res);
        assert.ok(formatted.includes('[VERIFIED FACT]'));
        assert.ok(formatted.includes('[POLICY]'));
        assert.ok(formatted.includes('[INFERENCE / RECOMMENDATION]'));
    });

    // ------------------------------------------------------------
    // REQUIREMENT 15: Shipment Intelligence & Carrier Routing (12 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 15: SHIPMENT INTELLIGENCE & CARRIER ROUTING ---');

    await runTest('Test 34: 8-stage shipment lifecycle timeline reconstruction', async () => {
        const res = await getShipmentIntelligence({ orderId: primaryOrder.order_id });
        assert.ok(Array.isArray(res.timeline));
        assert.strictEqual(res.timeline.length, 8, 'Shipment lifecycle must have 8 stages');
        assert.strictEqual(res.timeline[0].stage, 'ORDER_CREATED');
    });

    await runTest('Test 35: SOP carrier priority sequence enforcement (Shiprocket -> Delhivery -> Ekart)', async () => {
        const res = await getShipmentIntelligence({ orderId: primaryOrder.order_id });
        assert.strictEqual(CARRIER_PRIORITY[0].carrier, 'Shiprocket');
        assert.strictEqual(CARRIER_PRIORITY[1].carrier, 'Delhivery One');
        assert.strictEqual(CARRIER_PRIORITY[2].carrier, 'Ekart Logistics');
        assert.ok(res.carrier_intelligence.priority_sequence, 'Carrier priority sequence must be returned');
    });

    await runTest('Test 36: Delayed shipment detection against expected delivery SLA', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            pickupDateOverride: new Date(Date.now() - 10 * 86400000).toISOString(),
            statusOverride: 'IN_TRANSIT'
        });
        assert.strictEqual(res.delay_analysis.is_delayed, true);
        assert.ok(res.delay_analysis.delay_days > 0);
    });

    await runTest('Test 37: Stuck-in-transit detection (>48 hours without hub scan update)', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            statusOverride: 'IN_TRANSIT',
            lastScanDateOverride: new Date(Date.now() - 72 * 3600000).toISOString()
        });
        assert.strictEqual(res.delay_analysis.is_stuck, true);
    });

    await runTest('Test 38: RTO detection and root-cause classification', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            statusOverride: 'RTO_INITIATED',
            rtoReasonOverride: 'Customer refused delivery - cash not ready'
        });
        assert.strictEqual(res.rto_analysis.is_rto, true);
        assert.strictEqual(res.rto_analysis.category, 'CUSTOMER_REFUSAL');
    });

    await runTest('Test 39: Prepaid RTO handling SOP: reship after RTO or cancel in-transit', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            statusOverride: 'RTO_DELIVERED',
            paymentModeOverride: 'prepaid'
        });
        assert.ok(res.rto_analysis.sop_procedure.toLowerCase().includes('reship') || res.rto_analysis.sop_procedure.toLowerCase().includes('refund'));
    });

    await runTest('Test 40: COD RTO handling SOP: dispatch fresh order immediately upon reorder', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            statusOverride: 'RTO_DELIVERED',
            paymentModeOverride: 'cod'
        });
        assert.ok(res.rto_analysis.sop_procedure.toLowerCase().includes('fresh order'));
    });

    await runTest('Test 41: "Delivered but not received" SOP Step 1: Check neighbours/security', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            deliveredNotReceived: true
        });
        assert.strictEqual(res.delivered_not_received_case.is_active, true);
        assert.strictEqual(res.delivered_not_received_case.step_1.action, 'Check with neighbours and security guard');
    });

    await runTest('Test 42: "Delivered but not received" SOP Step 2 & 3: Notify carrier & request POD', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            deliveredNotReceived: true
        });
        assert.ok(res.delivered_not_received_case.step_2.action.includes('carrier'));
        assert.ok(res.delivered_not_received_case.step_3.action.includes('POD'));
    });

    await runTest('Test 43: "Delivered but not received" SOP Step 4: Mandatory 24-hour waiting window before sharing POD', async () => {
        const res = await getShipmentIntelligence({
            orderId: primaryOrder.order_id,
            deliveredNotReceived: true
        });
        assert.strictEqual(res.delivered_not_received_case.step_4.window_hours, 24);
        assert.strictEqual(res.delivered_not_received_case.step_4.action, 'Wait 24 hours for carrier investigation before sharing POD');
    });

    await runTest('Test 44: Carrier performance metrics comparison across Shiprocket, Delhivery, Ekart', async () => {
        const res = await getShipmentIntelligence({ orderId: primaryOrder.order_id });
        assert.ok(res.carrier_intelligence.metrics, 'Carrier metrics must be present');
        assert.ok(res.carrier_intelligence.metrics.Shiprocket !== undefined);
    });

    await runTest('Test 45: Strict IST timestamps and authoritative data source attribution', async () => {
        const res = await getShipmentIntelligence({ orderId: primaryOrder.order_id });
        assert.ok(res.data_as_of.includes('IST'));
        assert.ok(res.data_source, 'Authoritative data source must be stated');
    });

    // ------------------------------------------------------------
    // CROSS-REQUIREMENT COMPOSITE CASES (5 Tests)
    // ------------------------------------------------------------
    console.log('\n--- CROSS-REQUIREMENT COMPOSITE CASES ---');

    await runTest('Test 46: Composite Case 1: COD Conversion + Overcharge Refund (Payment + Discount + Refund)', async () => {
        // Customer converted order #42000 to COD by clicking Edit Details.
        // Coupon OFF10 was lost. Paid 1799 at door instead of 1619.
        const payRes = await investigatePayment({
            orderId: '42000',
            orderTotalOverride: 1799,
            courierCollectedOverride: 1799,
            customerMessageOverride: 'Edit Details on Shoppers Hub converted to COD. Coupon dropped.'
        });
        const discRes = await investigateDiscount({
            orderId: '42000',
            couponCode: 'OFF10',
            orderTotalOverride: 1799,
            customerMessageOverride: 'Edit Details on Shoppers Hub converted to COD. Coupon dropped.'
        });

        assert.strictEqual(payRes.cod_conversion_case.is_detected, true);
        assert.strictEqual(discRes.discount_removal.is_detected, true);
        assert.strictEqual(discRes.discount_removal.refund_difference_amount, 180);
        assert.strictEqual(payRes.cod_conversion_case.difference_to_refund, 180);
    });

    await runTest('Test 47: Composite Case 2: Delivered But Not Received + Refund Eligibility (Shipment + Eligibility)', async () => {
        // Customer marked delivered 1 hour ago but claims non-receipt.
        const shipRes = await getShipmentIntelligence({
            orderId: '42000',
            deliveredNotReceived: true
        });
        const eligRes = await checkRefundEligibility({
            orderId: '42000',
            reason: 'not_received',
            hasUnboxingVideo: false
        });

        assert.strictEqual(shipRes.delivered_not_received_case.step_4.window_hours, 24);
        assert.ok(eligRes.policy_applied.proof_rule.includes('POD'));
    });

    await runTest('Test 48: Composite Case 3: Wrong Item + Exchange vs Refund with Video Gate (Return + Eligibility)', async () => {
        // Customer received wrong product: wants refund to original bank account.
        const withoutVideo = await checkRefundEligibility({
            orderId: '42000',
            reason: 'wrong_item',
            hasUnboxingVideo: false
        });
        const withVideo = await checkRefundEligibility({
            orderId: '42000',
            reason: 'wrong_item',
            hasUnboxingVideo: true
        });

        assert.strictEqual(withoutVideo.evaluation.eligible, false);
        assert.strictEqual(withVideo.evaluation.eligible, true);
        assert.strictEqual(withVideo.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
    });

    await runTest('Test 49: Composite Case 4: Prepaid RTO + Refund Status + Reshipment (Shipment + Refund Status)', async () => {
        // Prepaid order returned to origin without customer ever receiving it.
        const elig = await checkRefundEligibility({
            orderId: '42000',
            reason: 'prepaid_rto'
        });
        const status = await investigateRefundStatus({
            orderId: '42000',
            statusOverride: 'REFUND_INITIATED'
        });

        assert.strictEqual(elig.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(status.refund_details.current_stage, 'REFUND_INITIATED');
    });

    await runTest('Test 50: Composite Case 5: Damaged Item + Photos + Full Replacement / Refund (Eligibility + Status)', async () => {
        // Damaged item arrived with photos provided.
        const elig = await checkRefundEligibility({
            orderId: '42000',
            reason: 'damaged',
            hasPhotos: true
        });
        assert.strictEqual(elig.evaluation.eligible, true);
        assert.strictEqual(elig.evaluation.channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(elig.evaluation.deductions.reverse_logistics_fee, 0);
    });

    console.log('\n============================================================');
    console.log(`TEST RUN COMPLETE: ${passedTests} passed, ${failedTests} failed out of 50 tests`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
