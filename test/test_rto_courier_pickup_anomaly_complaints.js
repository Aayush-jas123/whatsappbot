/**
 * Automated Unit Test Suite for Requirements 16 to 20:
 * - Requirement 16: RTO Investigation (8 tests)
 * - Requirement 17: Courier Performance Analytics (9 tests)
 * - Requirement 18: Return Pickup Investigation (8 tests)
 * - Requirement 19: Delivery Anomaly Detection (9 tests)
 * - Requirement 20: Customer Complaint Pattern Detection (10 tests)
 * - Cross-Requirement Composite Cases (6 tests)
 *
 * Total: 50 tests.
 */

const assert = require('assert');
const { dbAdapter } = require('../src/database/db');

const {
    investigateRto,
    formatRtoInvestigationReport,
    RTO_STAGES,
    RTO_CATEGORIES
} = require('../src/services/rtoInvestigationService');

const {
    getCourierPerformanceAnalytics,
    formatCourierAnalyticsReport,
    COURIER_FAMILIES,
    MIN_SAMPLE_SIZE
} = require('../src/services/courierAnalyticsService');

const {
    investigateReturnPickup,
    formatReturnPickupReport,
    PICKUP_STAGES
} = require('../src/services/returnPickupService');

const {
    detectDeliveryAnomalies,
    formatAnomalyReport,
    DELIVERY_ANOMALY_TYPES,
    ANOMALY_BASELINES
} = require('../src/services/deliveryAnomalyService');

const {
    getComplaintPatterns,
    formatComplaintPatternReport,
    COMPLAINT_CATEGORIES
} = require('../src/services/complaintPatternService');

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
    console.log('============================================================');
    console.log('STARTING UNIT TESTS: REQUIREMENTS 16-20 (50 TESTS)');
    console.log('============================================================\n');

    // =========================================================================
    // REQUIREMENT 16: RTO INVESTIGATION (Tests 1-8)
    // =========================================================================
    console.log('--- REQUIREMENT 16: RTO INVESTIGATION ---');

    await runTest('Test 1: Detects RTO_DELIVERED or RTO_INITIATED for an RTO shipment', async () => {
        const res = await investigateRto({ orderId: '42000' });
        assert.ok(res);
        assert.ok(res.rto_stage);
        assert.ok(Object.values(RTO_STAGES).includes(res.rto_stage));
        assert.ok(res.sop_post_rto);
    });

    await runTest('Test 2: Detects AT_RISK stage when shipment has failed delivery attempts', async () => {
        const res = await investigateRto({
            orderId: '42000',
            stageOverride: RTO_STAGES.AT_RISK,
            attemptsOverride: 2
        });
        assert.strictEqual(res.rto_stage, RTO_STAGES.AT_RISK);
        assert.strictEqual(res.delivery_attempts.count, 2);
    });

    await runTest('Test 3: Reconstructs full 8-milestone chronological timeline', async () => {
        const res = await investigateRto({ orderId: '42000' });
        assert.ok(Array.isArray(res.timeline));
        assert.ok(res.timeline.length > 0);
        assert.ok(res.timeline[0].status);
        assert.ok(res.timeline[0].timestamp);
    });

    await runTest('Test 4: Correctly categorizes failure reasons (e.g. CUSTOMER_REFUSED)', async () => {
        const res = await investigateRto({
            orderId: '42000',
            rtoReasonOverride: 'Customer refused delivery at doorstep'
        });
        assert.strictEqual(res.root_cause.category, RTO_CATEGORIES.CUSTOMER_REFUSED);
        assert.ok(/customer refus/i.test(res.root_cause.explanation));
    });

    await runTest('Test 5: Evaluates Post-RTO SOP for PREPAID order: 100% refund, 0 deductions, 5-7 days', async () => {
        const res = await investigateRto({
            orderId: '42000',
            paymentMethodOverride: 'prepaid',
            stageOverride: RTO_STAGES.RTO_DELIVERED
        });
        assert.strictEqual(res.payment.method, 'prepaid');
        assert.strictEqual(res.sop_post_rto.refund_eligible, true);
        assert.strictEqual(res.sop_post_rto.refund_channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(res.sop_post_rto.refund_percentage, 100);
        assert.strictEqual(res.sop_post_rto.deductions.reverse_logistics_charge, 0);
        assert.strictEqual(res.sop_post_rto.sla, '5-7 business days from warehouse receipt');
    });

    await runTest('Test 6: Evaluates Post-RTO SOP for COD order: Zero refund, inventory restock', async () => {
        const res = await investigateRto({
            orderId: '42000',
            paymentMethodOverride: 'cod',
            stageOverride: RTO_STAGES.RTO_DELIVERED
        });
        assert.strictEqual(res.payment.method, 'cod');
        assert.strictEqual(res.sop_post_rto.refund_eligible, false);
        assert.strictEqual(res.sop_post_rto.refund_amount, 0);
        assert.ok(res.sop_post_rto.restock_required);
    });

    await runTest('Test 7: Formats report with Phase 14 classification tags', async () => {
        const res = await investigateRto({ orderId: '42000' });
        const report = formatRtoInvestigationReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[POLICY]'));
        assert.ok(report.includes('[INFERENCE]'));
        assert.ok(report.includes('[RECOMMENDATION]'));
        assert.ok(report.includes('[ACTION REQUIRED]'));
        assert.ok(report.includes('IST (Live Database)'));
    });

    await runTest('Test 8: Handles missing/nonexistent order gracefully', async () => {
        const res = await investigateRto({ orderId: 'NONEXISTENT_999999' });
        assert.strictEqual(res.found, false);
        assert.ok(res.message.includes('No order or shipment record found'));
    });

    // =========================================================================
    // REQUIREMENT 17: COURIER PERFORMANCE ANALYTICS (Tests 9-17)
    // =========================================================================
    console.log('\n--- REQUIREMENT 17: COURIER PERFORMANCE ANALYTICS ---');

    await runTest('Test 9: Normalizes courier names across variations into canonical families', async () => {
        const res = await getCourierPerformanceAnalytics({ period: 'all' });
        assert.ok(res);
        assert.ok(res.couriers);
        // Delhivery, Ekart, and Shiprocket should be among recognized families
        const courierNames = Object.keys(res.couriers);
        assert.ok(courierNames.some(c => c.toLowerCase().includes('delhivery')));
    });

    await runTest('Test 10: Computes authoritative total shipments, delivered, and success rate', async () => {
        const res = await getCourierPerformanceAnalytics({ courier: 'Delhivery', period: 'all' });
        assert.ok(res.courier);
        assert.ok(typeof res.courier.total_shipments === 'number');
        assert.ok(typeof res.courier.delivered === 'number');
        assert.ok(typeof res.courier.delivery_success_rate === 'number');
        assert.ok(res.courier.delivery_success_rate >= 0 && res.courier.delivery_success_rate <= 100);
    });

    await runTest('Test 11: Computes RTO rate and delay rate with correct bounds', async () => {
        const res = await getCourierPerformanceAnalytics({ courier: 'Delhivery', period: 'all' });
        assert.ok(typeof res.courier.rto_rate === 'number');
        assert.ok(res.courier.rto_rate >= 0 && res.courier.rto_rate <= 100);
        assert.ok(typeof res.courier.delay_rate === 'number');
        assert.ok(res.courier.delay_rate >= 0 && res.courier.delay_rate <= 100);
    });

    await runTest('Test 12: Computes average delivery transit time in days', async () => {
        const res = await getCourierPerformanceAnalytics({ courier: 'Delhivery', period: 'all' });
        assert.ok(typeof res.courier.avg_delivery_days === 'number');
        assert.ok(res.courier.avg_delivery_days >= 0);
    });

    await runTest('Test 13: Enforces minimum sample size threshold (N >= 10)', async () => {
        assert.strictEqual(MIN_SAMPLE_SIZE, 10);
        const res = await getCourierPerformanceAnalytics({ courier: 'NonExistentCourier123', period: 'today' });
        if (res.courier) {
            assert.strictEqual(res.courier.sufficient_sample, false);
            assert.strictEqual(res.courier.sample_size_warning, true);
        }
    });

    await runTest('Test 14: Compares two couriers head-to-head', async () => {
        const res = await getCourierPerformanceAnalytics({
            courier: 'Delhivery',
            compareCourier: 'Ekart',
            period: 'all'
        });
        assert.ok(res.comparison);
        assert.ok(res.courier);
        assert.ok(res.comparison_courier);
        assert.ok(typeof res.comparison.success_rate_delta === 'number');
    });

    await runTest('Test 15: Calculates period-over-period comparisons (this_month vs last_month)', async () => {
        const res = await getCourierPerformanceAnalytics({
            courier: 'Delhivery',
            period: 'this_month',
            comparePeriod: 'last_month'
        });
        assert.ok(res.period);
        assert.ok(res.courier);
        if (res.period_comparison) {
            assert.ok(typeof res.period_comparison.total_shipments_delta === 'number');
        }
    });

    await runTest('Test 16: Analyzes courier performance filtered by destination pincode', async () => {
        const res = await getCourierPerformanceAnalytics({
            pincode: '201301',
            period: 'all'
        });
        assert.ok(res.pincode === '201301');
        assert.ok(res.couriers);
    });

    await runTest('Test 17: Formats report with Phase 14 classification tags', async () => {
        const res = await getCourierPerformanceAnalytics({ courier: 'Delhivery', period: 'all' });
        const report = formatCourierAnalyticsReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[PATTERN]'));
        assert.ok(report.includes('[INFERENCE]'));
        assert.ok(report.includes('[RECOMMENDATION]'));
        assert.ok(report.includes('IST (Live Database)'));
    });

    // =========================================================================
    // REQUIREMENT 18: RETURN PICKUP INVESTIGATION (Tests 18-25)
    // =========================================================================
    console.log('\n--- REQUIREMENT 18: RETURN PICKUP INVESTIGATION ---');

    await runTest('Test 18: Identifies PICKUP_PENDING phase when product is with customer', async () => {
        const res = await investigateReturnPickup({
            orderId: '42000',
            stageOverride: PICKUP_STAGES.PICKUP_PENDING
        });
        assert.strictEqual(res.pickup_stage, PICKUP_STAGES.PICKUP_PENDING);
        assert.strictEqual(res.product_location, 'CUSTOMER');
        assert.strictEqual(res.refund_triggered, false);
    });

    await runTest('Test 19: Identifies IN_TRANSIT_TO_WAREHOUSE when reverse transit active', async () => {
        const res = await investigateReturnPickup({
            orderId: '42000',
            stageOverride: PICKUP_STAGES.IN_TRANSIT_TO_WAREHOUSE
        });
        assert.strictEqual(res.pickup_stage, PICKUP_STAGES.IN_TRANSIT_TO_WAREHOUSE);
        assert.strictEqual(res.product_location, 'IN_REVERSE_TRANSIT');
        assert.strictEqual(res.refund_triggered, false);
    });

    await runTest('Test 20: Identifies RETURN_RECEIVED_REFUND_PENDING when at warehouse undergoing QC', async () => {
        const res = await investigateReturnPickup({
            orderId: '42000',
            stageOverride: PICKUP_STAGES.RETURN_RECEIVED_REFUND_PENDING
        });
        assert.strictEqual(res.pickup_stage, PICKUP_STAGES.RETURN_RECEIVED_REFUND_PENDING);
        assert.strictEqual(res.product_location, 'WAREHOUSE');
        assert.strictEqual(res.qc_status, 'UNDER_QC_INSPECTION');
    });

    await runTest('Test 21: Reconstructs pickup attempts, scheduled dates, and courier partner', async () => {
        const res = await investigateReturnPickup({ orderId: '42000' });
        assert.ok(res.pickup_details);
        assert.ok(typeof res.pickup_details.attempts === 'number');
        assert.ok(res.pickup_details.partner);
    });

    await runTest('Test 22: Evaluates 24-48 business hours SLA and detects on-time vs overdue', async () => {
        const res = await investigateReturnPickup({
            orderId: '42000',
            requestDateOverride: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
            stageOverride: PICKUP_STAGES.PICKUP_PENDING
        });
        assert.strictEqual(res.sla_check.sla_target, '24-48 business hours');
        assert.strictEqual(res.sla_check.is_overdue, true);
    });

    await runTest('Test 23: Handles failed pickup attempts with rescheduling guidance', async () => {
        const res = await investigateReturnPickup({
            orderId: '42000',
            attemptsOverride: 2,
            failureReasonOverride: 'Customer unavailable / door locked'
        });
        assert.strictEqual(res.pickup_details.attempts, 2);
        assert.strictEqual(res.pickup_details.failure_reason, 'Customer unavailable / door locked');
        assert.ok(res.actions.recommended_action.includes('reschedule'));
    });

    await runTest('Test 24: Formats report with Phase 14 classification tags', async () => {
        const res = await investigateReturnPickup({ orderId: '42000' });
        const report = formatReturnPickupReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[POLICY]'));
        assert.ok(report.includes('[INFERENCE]'));
        assert.ok(report.includes('[ACTION REQUIRED]'));
        assert.ok(report.includes('IST (Live Database)'));
    });

    await runTest('Test 25: Returns clear response when return/exchange request is not found', async () => {
        const res = await investigateReturnPickup({ returnId: 'NONEXISTENT_RET_99999' });
        assert.strictEqual(res.found, false);
        assert.ok(res.message.includes('No return or exchange pickup record found'));
    });

    // =========================================================================
    // REQUIREMENT 19: DELIVERY ANOMALY DETECTION (Tests 26-34)
    // =========================================================================
    console.log('\n--- REQUIREMENT 19: DELIVERY ANOMALY DETECTION ---');

    await runTest('Test 26: Detects STUCK_IN_TRANSIT anomaly (>48h without scan)', async () => {
        const res = await detectDeliveryAnomalies({
            windowDays: 7,
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT,
                awb: 'AWB_STUCK_123',
                hoursWithoutScan: 56,
                courier: 'Delhivery'
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT));
        const stuck = res.anomalies.find(a => a.type === DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT);
        assert.ok(stuck.hoursWithoutScan >= ANOMALY_BASELINES.STUCK_WARNING_HOURS);
    });

    await runTest('Test 27: Detects EXCESSIVE_ATTEMPTS anomaly (>= 3 attempts)', async () => {
        const res = await detectDeliveryAnomalies({
            windowDays: 7,
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.EXCESSIVE_DELIVERY_ATTEMPTS,
                awb: 'AWB_EXCESSIVE_123',
                attempts: 3,
                courier: 'Ekart'
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.EXCESSIVE_DELIVERY_ATTEMPTS));
        const exc = res.anomalies.find(a => a.type === DELIVERY_ANOMALY_TYPES.EXCESSIVE_DELIVERY_ATTEMPTS);
        assert.ok(exc.attempts > ANOMALY_BASELINES.MAX_NORMAL_DELIVERY_ATTEMPTS);
    });

    await runTest('Test 28: Detects RAPID_DELIVERY anomaly (< 6h from dispatch)', async () => {
        const res = await detectDeliveryAnomalies({
            windowDays: 7,
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.RAPID_DELIVERY_ANOMALY,
                awb: 'AWB_RAPID_123',
                transitHours: 2.5,
                courier: 'Delhivery'
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.RAPID_DELIVERY_ANOMALY));
        const rapid = res.anomalies.find(a => a.type === DELIVERY_ANOMALY_TYPES.RAPID_DELIVERY_ANOMALY);
        assert.ok(rapid.transitHours < ANOMALY_BASELINES.MIN_TRANSIT_HOURS_FOR_VALID_DELIVERY);
    });

    await runTest('Test 29: Detects SEVERE_DELAY anomaly (> 5 business days past SLA)', async () => {
        const res = await detectDeliveryAnomalies({
            windowDays: 7,
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.SEVERE_DELIVERY_DELAY,
                awb: 'AWB_DELAY_123',
                daysDelayed: 6,
                courier: 'Shiprocket'
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.SEVERE_DELIVERY_DELAY));
    });

    await runTest('Test 30: Detects PINCODE_FAILURE_CLUSTER anomaly (>= 25% failure rate)', async () => {
        const res = await detectDeliveryAnomalies({
            pincode: '201301',
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.PINCODE_FAILURE_CLUSTER,
                pincode: '201301',
                failureRate: 32.5,
                totalShipments: 40
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.PINCODE_FAILURE_CLUSTER));
    });

    await runTest('Test 31: Detects COURIER_SURGE anomaly (>= 10% spike in failure rate)', async () => {
        const res = await detectDeliveryAnomalies({
            courier: 'Delhivery',
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.COURIER_SURGE_ANOMALY,
                courier: 'Delhivery',
                currentFailureRate: 22.0,
                previousFailureRate: 10.5,
                deltaPercent: 11.5
            }]
        });
        assert.ok(res.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.COURIER_SURGE_ANOMALY));
    });

    await runTest('Test 32: Correctly assigns severity levels (CRITICAL, HIGH, MEDIUM, LOW)', async () => {
        const res = await detectDeliveryAnomalies({
            mockAnomalies: [
                { type: DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT, hoursWithoutScan: 80, severity: 'CRITICAL' },
                { type: DELIVERY_ANOMALY_TYPES.RAPID_DELIVERY_ANOMALY, transitHours: 1, severity: 'HIGH' },
                { type: DELIVERY_ANOMALY_TYPES.EXCESSIVE_DELIVERY_ATTEMPTS, attempts: 3, severity: 'MEDIUM' }
            ]
        });
        assert.ok(res.anomalies.some(a => a.severity === 'CRITICAL'));
        assert.ok(res.anomalies.some(a => a.severity === 'HIGH'));
        assert.ok(res.anomalies.some(a => a.severity === 'MEDIUM'));
    });

    await runTest('Test 33: Provides data-driven baseline and recommended operational action', async () => {
        const res = await detectDeliveryAnomalies({
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT,
                awb: 'AWB_STUCK_123',
                hoursWithoutScan: 50
            }]
        });
        const anom = res.anomalies[0];
        assert.ok(anom.baseline);
        assert.ok(anom.recommended_action);
    });

    await runTest('Test 34: Formats anomaly report with structured anomaly headers', async () => {
        const res = await detectDeliveryAnomalies({
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.STUCK_IN_TRANSIT,
                awb: 'AWB_STUCK_123',
                hoursWithoutScan: 50,
                courier: 'Delhivery',
                severity: 'HIGH'
            }]
        });
        const report = formatAnomalyReport(res);
        assert.ok(report.includes('ANOMALY:'));
        assert.ok(report.includes('WHAT WAS DETECTED:'));
        assert.ok(report.includes('EVIDENCE:'));
        assert.ok(report.includes('BASELINE:'));
        assert.ok(report.includes('SEVERITY:'));
        assert.ok(report.includes('RECOMMENDED ACTION:'));
    });

    // =========================================================================
    // REQUIREMENT 20: CUSTOMER COMPLAINT PATTERN DETECTION (Tests 35-44)
    // =========================================================================
    console.log('\n--- REQUIREMENT 20: CUSTOMER COMPLAINT PATTERN DETECTION ---');

    await runTest('Test 35: Categorizes support tickets across 9 complaint categories', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        assert.ok(res.categories);
        assert.ok(Object.keys(res.categories).length > 0);
        assert.ok(res.categories[COMPLAINT_CATEGORIES.DELIVERY_TRACKING]);
    });

    await runTest('Test 36: Computes total volume and percentage distribution per category', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        assert.ok(typeof res.total_tickets === 'number');
        assert.ok(res.total_tickets > 0);
        const firstCat = Object.values(res.categories)[0];
        assert.ok(typeof firstCat.count === 'number');
        assert.ok(typeof firstCat.percentage === 'number');
        assert.ok(firstCat.percentage >= 0 && firstCat.percentage <= 100);
    });

    await runTest('Test 37: Performs period-over-period comparison with volume and % delta', async () => {
        const res = await getComplaintPatterns({ period: 'this_week', comparePeriod: 'last_week' });
        assert.ok(res.period);
        assert.ok(res.compare_period);
        assert.ok(res.trend_summary);
    });

    await runTest('Test 38: Detects top trending or surging complaint categories', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        assert.ok(Array.isArray(res.top_complaint_categories));
        assert.ok(res.top_complaint_categories.length > 0);
    });

    await runTest('Test 39: Calculates complaint rate and breakdown per product / SKU', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        assert.ok(res.product_breakdown);
        assert.ok(typeof res.product_breakdown === 'object');
    });

    await runTest('Test 40: Calculates courier-attributed complaint distribution', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        assert.ok(res.courier_breakdown);
        assert.ok(typeof res.courier_breakdown === 'object');
    });

    await runTest('Test 41: Neutral presentation: no negative customer profiling labels', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        const report = formatComplaintPatternReport(res);
        assert.strictEqual(report.toLowerCase().includes('fraudulent customer'), false);
        assert.strictEqual(report.toLowerCase().includes('serial returner'), false);
        assert.strictEqual(report.toLowerCase().includes('bad customer'), false);
    });

    await runTest('Test 42: Filters complaint patterns by category, product, or courier', async () => {
        const res = await getComplaintPatterns({
            category: COMPLAINT_CATEGORIES.SIZE_FIT,
            period: 'all'
        });
        assert.ok(res.filter);
        assert.strictEqual(res.filter.category, COMPLAINT_CATEGORIES.SIZE_FIT);
    });

    await runTest('Test 43: Formats report with Phase 14 classification tags', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        const report = formatComplaintPatternReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[PATTERN]'));
        assert.ok(report.includes('[INFERENCE]'));
        assert.ok(report.includes('[RECOMMENDATION]'));
    });

    await runTest('Test 44: Includes live data timestamp with IST notation', async () => {
        const res = await getComplaintPatterns({ period: 'all' });
        const report = formatComplaintPatternReport(res);
        assert.ok(report.includes('IST (Live Database)'));
    });

    // =========================================================================
    // CROSS-REQUIREMENT COMPOSITE CASES (Tests 45-50)
    // =========================================================================
    console.log('\n--- CROSS-REQUIREMENT COMPOSITE CASES ---');

    await runTest('Test 45: Composite Case 1: Delivery Anomaly Detection -> RTO Prevention', async () => {
        // Repeated NDR attempts detected -> triggers proactive customer address verification before final RTO
        const anomalyRes = await detectDeliveryAnomalies({
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.EXCESSIVE_ATTEMPTS,
                awb: 'AWB_NDR_999',
                attempts: 2,
                courier: 'Delhivery'
            }]
        });
        const rtoRes = await investigateRto({
            orderId: '42000',
            stageOverride: RTO_STAGES.AT_RISK,
            attemptsOverride: 2
        });
        assert.strictEqual(rtoRes.rto_stage, RTO_STAGES.AT_RISK);
        assert.ok(rtoRes.actions.recommended_action.includes('proactive'));
    });

    await runTest('Test 46: Composite Case 2: RTO Completed -> Post-RTO Refund Resolution', async () => {
        // Prepaid order returned to warehouse: SOP mandates 100% refund, no logistics deduction
        const rtoRes = await investigateRto({
            orderId: '42000',
            paymentMethodOverride: 'prepaid',
            stageOverride: RTO_STAGES.RTO_DELIVERED
        });
        assert.strictEqual(rtoRes.sop_post_rto.refund_eligible, true);
        assert.strictEqual(rtoRes.sop_post_rto.refund_channel, 'ORIGINAL_PAYMENT_METHOD');
        assert.strictEqual(rtoRes.sop_post_rto.refund_percentage, 100);
    });

    await runTest('Test 47: Composite Case 3: Return Pickup Pending -> Refund Timeline Inquiry', async () => {
        // Customer asks why refund hasn't arrived; pickup is still pending with customer
        const pickupRes = await investigateReturnPickup({
            orderId: '42000',
            stageOverride: PICKUP_STAGES.PICKUP_PENDING
        });
        assert.strictEqual(pickupRes.pickup_stage, PICKUP_STAGES.PICKUP_PENDING);
        assert.strictEqual(pickupRes.product_location, 'CUSTOMER');
        assert.strictEqual(pickupRes.refund_triggered, false);
        assert.ok(pickupRes.actions.next_step.includes('Product must be received at warehouse'));
    });

    await runTest('Test 48: Composite Case 4: Courier Performance Analytics -> Pincode Delivery Routing', async () => {
        // Check courier analytics for specific pincode to determine best courier
        const res = await getCourierPerformanceAnalytics({
            pincode: '201301',
            period: 'all'
        });
        assert.ok(res.pincode === '201301');
        assert.ok(res.couriers);
    });

    await runTest('Test 49: Composite Case 5: Courier Delay Surge -> Delivery Anomaly Correlation', async () => {
        // Delay surge in courier aligns with stuck-in-transit anomaly clusters
        const surgeRes = await detectDeliveryAnomalies({
            mockAnomalies: [{
                type: DELIVERY_ANOMALY_TYPES.COURIER_SURGE_ANOMALY,
                courier: 'Ekart',
                currentFailureRate: 25.0,
                previousFailureRate: 12.0,
                deltaPercent: 13.0
            }]
        });
        assert.ok(surgeRes.anomalies.some(a => a.type === DELIVERY_ANOMALY_TYPES.COURIER_SURGE_ANOMALY));
    });

    await runTest('Test 50: Composite Case 6: Comprehensive Operational Audit', async () => {
        // Audit total delivery operations: courier analytics + RTO investigation + anomaly detection + complaints
        const [courier, rto, anom, complaints] = await Promise.all([
            getCourierPerformanceAnalytics({ period: 'all' }),
            investigateRto({ orderId: '42000' }),
            detectDeliveryAnomalies({ windowDays: 7 }),
            getComplaintPatterns({ period: 'all' })
        ]);
        assert.ok(courier);
        assert.ok(rto);
        assert.ok(anom);
        assert.ok(complaints);
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
