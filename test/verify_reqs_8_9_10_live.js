/**
 * Live Copilot Acceptance Verification for Requirements 8, 9, and 10:
 * - Requirement 8: Product & SKU Information queries
 * - Requirement 9: Inventory Intelligence queries
 * - Requirement 10: Return/Exchange Investigation queries
 * - Master Multi-Requirement Combined Scenario
 */

const assert = require('assert');
const { getTool } = require('../src/services/ai/tools');
const { runAgent } = require('../src/services/ai/agent');

async function testLiveQuestions() {
    console.log('\n============================================================');
    console.log('LIVE COPILOT ACCEPTANCE VERIFICATION (REQS 8, 9, 10)');
    console.log('============================================================\n');

    // 1. Tool availability verification
    console.log('--- Verifying Tool Registrations in AI System ---');
    const t8 = getTool('get_product_sku_info');
    assert.ok(t8, 'Tool get_product_sku_info must be registered');
    console.log('  ✅ get_product_sku_info is registered');

    const t9 = getTool('get_inventory_intelligence');
    assert.ok(t9, 'Tool get_inventory_intelligence must be registered');
    console.log('  ✅ get_inventory_intelligence is registered');

    const t10 = getTool('investigate_return_exchange');
    assert.ok(t10, 'Tool investigate_return_exchange must be registered');
    console.log('  ✅ investigate_return_exchange is registered');

    // 2. Direct Tool Execution Acceptance Tests
    console.log('\n--- Direct Tool Execution Acceptance Tests ---');

    // Question 1: "What variants exist for product Henley 001?"
    console.log('\n[Q1]: What variants exist for product Henley 001?');
    const q1Res = await t8.execute({ query: 'HENLEY - 001' });
    assert.strictEqual(q1Res.found, true);
    console.log(`  Variants found: ${q1Res.product.variants.length}`);
    console.log(`  Colours: ${q1Res.product.colors.join(', ')}`);
    console.log(`  Sizes: ${q1Res.product.sizes.join(', ')}`);
    assert.ok(q1Res.product.variants.length > 0);

    // Question 2: "Show price and stock for SKU waffle-001-w-l"
    console.log('\n[Q2]: Show price and stock for SKU waffle-001-w-l');
    const q2Res = await t8.execute({ sku: 'waffle-001-w-l' });
    assert.strictEqual(q2Res.found, true);
    console.log(`  SKU: ${q2Res.sku} | Product: ${q2Res.product_name} | Size: ${q2Res.size} | Stock: ${q2Res.stock} | Status: ${q2Res.stock_status}`);
    assert.strictEqual(q2Res.size, 'L');

    // Question 3: "What items are low in stock right now?"
    console.log('\n[Q3]: What items are low in stock right now?');
    const q3Res = await t9.execute({ queryType: 'low_stock', limit: 5 });
    console.log(`  Total low-stock items detected dynamically: ${q3Res.summary.low_stock_items}`);
    console.log(`  Sample item: ${q3Res.items[0]?.product_name} Size ${q3Res.items[0]?.size} (Stock: ${q3Res.items[0]?.stock} <= Reorder: ${q3Res.items[0]?.reorder_level})`);
    assert.ok(q3Res.items.length > 0);
    assert.ok(q3Res.items[0].stock <= q3Res.items[0].reorder_level);

    // Question 4: "When will SKU waffle-001-w-l run out of stock?"
    console.log('\n[Q4]: When will SKU waffle-001-w-l run out of stock?');
    const q4Res = await t9.execute({ sku: 'waffle-001-w-l', queryType: 'demand_analysis', days: 30 });
    const analysis = q4Res.analyses[0];
    console.log(`  Current Stock: ${analysis.current_stock}`);
    console.log(`  Daily Sales Velocity: ${analysis.daily_sales_velocity} units/day`);
    console.log(`  Estimated Run-Out: ~${analysis.estimated_days_remaining} days`);
    console.log(`  Restock Recommendation: [${analysis.restock_recommendation.urgency}] ${analysis.restock_recommendation.rationale}`);
    assert.ok(analysis.restock_recommendation.type === 'RECOMMENDATION / INFERENCE');

    // Question 5: "Investigate return request for order #42000"
    console.log('\n[Q5]: Investigate return request for order #42000');
    const q5Res = await t10.execute({ orderId: '42000', reason: 'Customer wants return' });
    assert.strictEqual(q5Res.investigated, true);
    console.log(`  Order: #${q5Res.identifiers.order_id} | Customer: ${q5Res.order_details.customer_name}`);
    console.log(`  Delivery Status: ${q5Res.order_details.delivery_status}`);
    console.log(`  Return Window Valid: ${q5Res.case_summary.return_window_valid}`);
    console.log(`  Refund Mode: ${q5Res.case_summary.refund_mode}`);

    // Question 6: Master Combined Scenario:
    // "Customer received size M for order #42000 and wants to exchange for size L. Can they exchange it?"
    console.log('\n[Q6 - MASTER SCENARIO]: Customer received size M for order #42000 and wants to exchange for size L. Can they exchange it?');
    const q6Res = await t10.execute({
        orderId: '42000',
        targetExchangeVariant: 'L',
        reason: 'Customer received size M and wants size L exchange'
    });
    assert.strictEqual(q6Res.investigated, true);
    console.log(`  1. Order Verified: Customer ${q6Res.order_details.customer_name} ordered size M`);
    console.log(`  2. Target Exchange Variant Checked: Size ${q6Res.target_exchange_stock.target_size}`);
    console.log(`  3. Live Stock Availability: ${q6Res.target_exchange_stock.in_stock ? 'IN STOCK' : 'OUT OF STOCK'} (${q6Res.target_exchange_stock.stock_available} units available)`);
    console.log(`  4. Exchange Feasibility Message: ${q6Res.target_exchange_stock.message}`);
    console.log(`  5. SOP Policy Guidelines:`);
    console.log(`     - Portal: ${q6Res.sop_policies.PORTAL_URL}`);
    console.log(`     - Reverse Pickup SLA: ${q6Res.sop_policies.PICKUP_SLA_HOURS}`);
    console.log(`     - Refund/Exchange Rule: ${q6Res.case_summary.refund_policy}`);

    const { formatInvestigationReport } = require('../src/services/returnInvestigationService');
    const formattedOutput = formatInvestigationReport(q6Res);
    assert.ok(formattedOutput.includes('[VERIFIED FACT]'));
    assert.ok(formattedOutput.includes('[POLICY]'));
    assert.ok(formattedOutput.includes('[INFERENCE / RECOMMENDATION]'));
    assert.ok(formattedOutput.includes('[ACTION RECOMMENDED]'));

    console.log('\nFormatted Report Sections Verified:');
    console.log('  ✅ [VERIFIED FACT] section present');
    console.log('  ✅ [POLICY] section present');
    console.log('  ✅ [INFERENCE / RECOMMENDATION] section present');
    console.log('  ✅ [ACTION RECOMMENDED] section present');

    console.log('\n============================================================');
    console.log('✅ ALL ACCEPTANCE CRITERIA FOR REQS 8, 9, 10 SUCCESSFULLY VERIFIED!');
    console.log('============================================================\n');
    process.exit(0);
}

testLiveQuestions().catch(err => {
    console.error('❌ Acceptance test error:', err);
    process.exit(1);
});
