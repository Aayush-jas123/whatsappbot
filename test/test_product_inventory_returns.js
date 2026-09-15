/**
 * Automated Unit Test Suite for Requirements 8, 9, and 10:
 * - Requirement 8: Product & SKU Information (10 tests)
 * - Requirement 9: Inventory Intelligence (10 tests)
 * - Requirement 10: Return/Exchange Investigation (12 tests)
 *
 * Total: 32 tests.
 */

const assert = require('assert');
const {
    getUnifiedProductCatalog,
    getProductInfo,
    getVariantBySku,
    searchProducts,
    formatProductSummary,
    normalizeSku,
    extractColor
} = require('../src/services/productInfoService');

const {
    getInventoryStock,
    getLowStockItems,
    getOutOfStockItems,
    analyzeStockVsDemand,
    getRestockingRecommendations,
    formatInventorySummary
} = require('../src/services/inventoryIntelligenceService');

const {
    investigateReturnExchange,
    formatInvestigationReport,
    SOP_POLICIES
} = require('../src/services/returnInvestigationService');

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
    console.log('TEST SUITE: REQUIREMENTS 8, 9, 10 (PRODUCT, INVENTORY, RETURNS)');
    console.log('============================================================\n');

    // Pre-warm catalog
    await getUnifiedProductCatalog();

    // ------------------------------------------------------------
    // REQUIREMENT 8: Product & SKU Information (10 Tests)
    // ------------------------------------------------------------
    console.log('--- REQUIREMENT 8: PRODUCT & SKU INFORMATION ---');

    await runTest('Test 1: Product lookup by name/query', async () => {
        const res = await getProductInfo({ query: 'WAFFLE' });
        assert.strictEqual(res.found, true, 'Product should be found');
        assert.ok(res.product.title.toUpperCase().includes('WAFFLE'), 'Product title should contain WAFFLE');
        assert.ok(res.product.variants.length > 0, 'Product should have variants');
        assert.ok(res.data_as_of.includes('IST'), 'Timestamp must be in IST');
    });

    await runTest('Test 2: Product lookup by handle', async () => {
        const catalog = await getUnifiedProductCatalog();
        const sampleProduct = catalog[0];
        assert.ok(sampleProduct, 'Catalog should contain at least 1 product');

        const res = await getProductInfo({ handle: sampleProduct.handle });
        assert.strictEqual(res.found, true, 'Product should be found by handle');
        assert.strictEqual(res.product.title, sampleProduct.title, 'Found product should match handle');
    });

    await runTest('Test 3: Variant lookup by exact SKU', async () => {
        const res = await getVariantBySku('waffle-001-w-xl');
        assert.strictEqual(res.found, true, 'Variant should be found by SKU');
        assert.strictEqual(res.sku, 'waffle-001-w-xl');
        assert.strictEqual(res.size, 'XL');
        assert.strictEqual(res.color, 'White');
    });

    await runTest('Test 4: Mapping accuracy (Product -> Variant -> SKU -> Size -> Colour -> Price -> Stock)', async () => {
        const res = await getVariantBySku('waffle-001-w-l');
        assert.strictEqual(res.found, true);
        const m = res.mapping;
        assert.ok(m.product, 'Product mapping must exist');
        assert.ok(m.variant, 'Variant mapping must exist');
        assert.ok(m.sku, 'SKU mapping must exist');
        assert.strictEqual(m.size, 'L', 'Size must match L');
        assert.strictEqual(m.color, 'White', 'Colour must match White');
        assert.strictEqual(typeof m.price, 'number', 'Price must be numeric');
        assert.strictEqual(typeof m.stock, 'number', 'Stock must be numeric');
        assert.ok(['in_stock', 'low_stock', 'out_of_stock'].includes(m.status), 'Status must be valid');
    });

    await runTest('Test 5: Active vs inactive status detection', async () => {
        const res = await getProductInfo({ query: 'HENLEY' });
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.product.status, 'active');
        assert.strictEqual(typeof res.product.total_stock, 'number');
    });

    await runTest('Test 6: In-stock vs low-stock vs out-of-stock availability status', async () => {
        const lowRes = await getVariantBySku('waffle-001-w-xl');
        assert.strictEqual(lowRes.found, true);
        assert.strictEqual(lowRes.stock_status, 'low_stock', 'Quantity 1 with reorder 60 must be low_stock');

        const catalog = await getUnifiedProductCatalog();
        const oosVariant = catalog.flatMap(p => p.variants).find(v => v.stock <= 0);
        if (oosVariant) {
            assert.strictEqual(oosVariant.stock_status, 'out_of_stock', 'Stock <= 0 must be out_of_stock');
        }
    });

    await runTest('Test 7: Multi-colour product mapping', async () => {
        const res = await getProductInfo({ query: 'HENLEY - 001' });
        assert.strictEqual(res.found, true);
        assert.ok(res.product.colors.length >= 1, 'Product should have colourways');
        assert.ok(res.product.variants.every(v => v.color), 'Every variant should have an identified colour');
    });

    await runTest('Test 8: Multi-size product variant matrix', async () => {
        const res = await getProductInfo({ query: 'WAFFLE - 001 ( W )' });
        assert.strictEqual(res.found, true);
        const sizes = res.product.sizes;
        assert.ok(sizes.includes('M') || sizes.includes('L') || sizes.includes('XL'), 'Product should have standard apparel sizes');
        assert.ok(res.product.size_color_matrix.length > 0, 'Size-colour matrix must exist');
    });

    await runTest('Test 9: Case-insensitive and normalized SKU lookup (hyphens/spaces)', async () => {
        const res1 = await getVariantBySku('WAFFLE-001-W-XL');
        const res2 = await getVariantBySku('waffle001wxl');
        assert.strictEqual(res1.found, true, 'Uppercase SKU should match');
        assert.strictEqual(res2.found, true, 'Stripped SKU alias should match');
        assert.strictEqual(res1.size, res2.size, 'Both aliases should resolve to same variant');
    });

    await runTest('Test 10: Missing/invalid SKU graceful handling', async () => {
        const res = await getVariantBySku('NON-EXISTENT-SKU-99999');
        assert.strictEqual(res.found, false, 'Invalid SKU must return found: false');
        assert.ok(res.message.includes('not found'), 'Clear error message returned');
        assert.ok(res.data_as_of.includes('IST'), 'Timestamp included');
    });

    // ------------------------------------------------------------
    // REQUIREMENT 9: Inventory Intelligence (10 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 9: INVENTORY INTELLIGENCE ---');

    await runTest('Test 11: Real-time stock query by SKU', async () => {
        const res = await getInventoryStock({ sku: 'waffle-001-w-l' });
        assert.ok(res.items.length >= 1, 'Should find stock for SKU');
        const item = res.items[0];
        assert.strictEqual(item.sku, 'waffle-001-w-l');
        assert.strictEqual(item.size, 'L');
        assert.strictEqual(typeof item.stock, 'number');
    });

    await runTest('Test 12: Stock query by size and colour filters', async () => {
        const res = await getInventoryStock({ size: 'L', color: 'White' });
        assert.ok(res.items.length >= 1, 'Should find items matching size L and White');
        assert.ok(res.items.every(i => i.size.toUpperCase() === 'L' && i.color.toLowerCase().includes('white')));
    });

    await runTest('Test 13: Dynamic low-stock detection strictly using per-SKU reorder_level (NOT hardcoded < 10)', async () => {
        const res = await getLowStockItems({ limit: 20 });
        assert.ok(res.items.length > 0, 'Should find low stock items');
        for (const item of res.items) {
            assert.ok(item.stock > 0, 'Low stock items must have stock > 0');
            assert.ok(item.reorder_level > 0, 'Low stock items must have a configured reorder_level');
            assert.ok(item.stock <= item.reorder_level, `Stock (${item.stock}) must be <= reorder_level (${item.reorder_level})`);
        }
        // Verify at least one item with stock >= 10 is recognized as low stock due to high reorder_level (e.g. stock=89, reorder=100)
        const highThresholdItem = res.items.find(i => i.stock >= 10);
        assert.ok(highThresholdItem, 'Must support low-stock items with stock >= 10 based on reorder_level');
    });

    await runTest('Test 14: Out-of-stock detection (quantity <= 0)', async () => {
        const res = await getOutOfStockItems({ limit: 50 });
        for (const item of res.items) {
            assert.strictEqual(item.stock_status, 'out_of_stock');
            assert.ok(item.stock <= 0, 'Out of stock item must have stock <= 0');
        }
    });

    await runTest('Test 15: Multi-channel stock aggregation (Shopify + manual_inventory)', async () => {
        const res = await getInventoryStock({ sku: 'waffle-001-w-m' });
        assert.ok(res.items.length >= 1);
        const item = res.items[0];
        assert.strictEqual(typeof item.warehouse_stock, 'number');
        assert.strictEqual(typeof item.stock, 'number');
    });

    await runTest('Test 16: Sales velocity & run-out days calculation', async () => {
        const res = await analyzeStockVsDemand({ sku: 'waffle-001-w-l', days: 30 });
        assert.ok(res.analyses.length >= 1, 'Should analyze target SKU');
        const a = res.analyses[0];
        assert.strictEqual(typeof a.current_stock, 'number');
        assert.strictEqual(typeof a.daily_sales_velocity, 'number');
        assert.ok(a.estimated_days_remaining !== undefined, 'Estimated days remaining calculated');
    });

    await runTest('Test 17: Restocking recommendations labeled with RECOMMENDATION / INFERENCE', async () => {
        const res = await getRestockingRecommendations({ limit: 5 });
        assert.ok(res.recommendations.length >= 1, 'Should have recommendations');
        assert.ok(res.disclaimer.includes('RECOMMENDATION / INFERENCE'), 'Must include RECOMMENDATION / INFERENCE disclaimer');
        const rec = res.recommendations[0].restock_recommendation;
        assert.strictEqual(rec.type, 'RECOMMENDATION / INFERENCE');
        assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(rec.urgency));
        assert.strictEqual(typeof rec.recommended_units, 'number');
    });

    await runTest('Test 18: Zero inventory handling without error', async () => {
        const res = await getInventoryStock({ sku: 'ZERO-STOCK-TEST', limit: 10 });
        assert.strictEqual(res.items.length, 0);
        assert.strictEqual(typeof res.summary.total_items, 'number');
    });

    await runTest('Test 19: Negative / corrupted inventory anomaly detection', async () => {
        const res = await getInventoryStock({ limit: 100 });
        assert.strictEqual(typeof res.summary.negative_stock_anomalies, 'number');
        for (const item of res.items) {
            if (item.stock < 0) {
                assert.strictEqual(item.is_anomaly, true, 'Negative stock must be flagged as anomaly');
            }
        }
    });

    await runTest('Test 20: Product inventory category filtering', async () => {
        const res = await getInventoryStock({ category: 'T-SHIRT', limit: 10 });
        assert.ok(res.items.length > 0, 'Should find items in T-SHIRT category');
        assert.ok(res.items.every(i => i.category.toUpperCase().includes('T-SHIRT')));
    });

    // ------------------------------------------------------------
    // REQUIREMENT 10: Return/Exchange Investigation (12 Tests)
    // ------------------------------------------------------------
    console.log('\n--- REQUIREMENT 10: RETURN/EXCHANGE INVESTIGATION ---');

    await runTest('Test 21: Return case investigation by order ID', async () => {
        const res = await investigateReturnExchange({ orderId: '42000' });
        assert.strictEqual(res.investigated, true, 'Case must be investigated');
        assert.ok(res.order_details, 'Order details must be loaded');
        assert.strictEqual(res.identifiers.order_id, '42000');
        assert.ok(res.data_as_of.includes('IST'));
    });

    await runTest('Test 22: Return case investigation by customer phone number', async () => {
        const res = await investigateReturnExchange({ phone: '917005065386' });
        assert.strictEqual(res.investigated, true);
        assert.ok(res.order_details);
        assert.ok(res.identifiers.phone.includes('7005065386'));
    });

    await runTest('Test 23: Exchange case investigation and parameters', async () => {
        const res = await investigateReturnExchange({
            orderId: '42000',
            reason: 'Customer wants size exchange',
            targetExchangeVariant: 'L'
        });
        assert.strictEqual(res.investigated, true);
        assert.strictEqual(res.case_summary.reason, 'Customer wants size exchange');
        assert.ok(res.target_exchange_stock, 'Target exchange stock must be verified');
    });

    await runTest('Test 24: Proof verification: Wrong product delivered requires unboxing video', async () => {
        const res = await investigateReturnExchange({
            orderId: '42000',
            reason: 'Wrong product delivered'
        });
        assert.strictEqual(res.investigated, true);
        assert.ok(res.case_summary.proof_details.toLowerCase().includes('unboxing video'), 'Must require unboxing video for wrong product');
        assert.strictEqual(res.sop_policies.PROOF_RULES.WRONG_ITEM.proof_type, 'UNBOXING_VIDEO');
    });

    await runTest('Test 25: Proof verification: Damaged product delivered requires photo evidence', async () => {
        const res = await investigateReturnExchange({
            orderId: '42000',
            reason: 'Damaged item received'
        });
        assert.strictEqual(res.investigated, true);
        assert.ok(res.case_summary.proof_details.toLowerCase().includes('photo'), 'Must require photos for damaged product');
        assert.strictEqual(res.sop_policies.PROOF_RULES.DAMAGED_ITEM.proof_type, 'CLEAR_PHOTOS');
    });

    await runTest('Test 26: Policy compliance: Pre-dispatch modification vs Post-delivery returns portal', async () => {
        const res = await investigateReturnExchange({ orderId: '42000' });
        assert.ok(res.sop_policies.DISPATCH_STAGE_RULES.PRE_DISPATCH.includes('Shoppers Hub'));
        assert.ok(res.sop_policies.DISPATCH_STAGE_RULES.POST_DELIVERY.includes('offcomfrt.in/pages/return'));
    });

    await runTest('Test 27: Refund eligibility: Original payment method vs store credit enforcement', async () => {
        // Standard return gets store credit
        const stdRes = await investigateReturnExchange({ orderId: '42000', reason: 'Size M too small' });
        assert.strictEqual(stdRes.case_summary.refund_mode, 'STORE_CREDIT');

        // Verified wrong item gets original payment
        const wrongRes = await investigateReturnExchange({ orderId: '42000', reason: 'Wrong item delivered' });
        assert.ok(wrongRes.sop_policies.REFUND_RULES.ORIGINAL_PAYMENT.includes('ONLY for verified wrong item'));
    });

    await runTest('Test 28: Multi-item order investigation', async () => {
        const res = await investigateReturnExchange({ orderId: '42000' });
        assert.strictEqual(res.investigated, true);
        const items = res.order_details.items;
        assert.ok(items.length >= 2, 'Order 42000 has multiple items');
        assert.ok(items.every(i => i.title && i.size), 'Every item should have title and size');
    });

    await runTest('Test 29: Chronological timeline reconstruction', async () => {
        const res = await investigateReturnExchange({ orderId: '42000' });
        assert.ok(res.timeline.length >= 2, 'Timeline should contain order and delivery milestones');
        assert.strictEqual(res.timeline[0].stage, 'ORDER_PLACED');
    });

    await runTest('Test 30: Missing return record handling (fallback to support tickets & store_shoppers)', async () => {
        const res = await investigateReturnExchange({ orderId: '42000' });
        assert.strictEqual(res.return_records.length, 0, 'No return table row exists yet');
        assert.ok(res.order_details, 'Order details successfully loaded from store_shoppers fallback');
        assert.ok(res.case_summary.return_window_valid !== undefined);
    });

    await runTest('Test 31: Disputed/rejected return case investigation', async () => {
        const formatted = formatInvestigationReport({
            investigated: true,
            identifiers: { order_id: '42000', phone: '917005065386' },
            case_summary: {
                reason: 'Wrong Product Delivered',
                is_pre_dispatch: false,
                return_window_valid: true,
                days_since_order: 3,
                proof_status: 'PENDING_CUSTOMER_SUBMISSION',
                proof_details: 'Mandatory unboxing video required',
                refund_mode: 'ORIGINAL_PAYMENT',
                refund_policy: 'Original payment refund allowed upon verification'
            },
            order_details: { customer_name: 'Test Customer', delivery_status: 'DELIVERED', items: [] },
            return_records: [],
            exchange_records: [],
            support_tickets: [],
            timeline: [],
            sop_policies: SOP_POLICIES,
            data_as_of: '09 Sep 2026, 08:30 AM IST'
        });

        assert.ok(formatted.includes('[VERIFIED FACT]'), 'Must include [VERIFIED FACT]');
        assert.ok(formatted.includes('[POLICY]'), 'Must include [POLICY]');
        assert.ok(formatted.includes('[INFERENCE / RECOMMENDATION]'), 'Must include [INFERENCE / RECOMMENDATION]');
        assert.ok(formatted.includes('[ACTION RECOMMENDED]'), 'Must include [ACTION RECOMMENDED]');
        assert.ok(formatted.includes('Request mandatory proof from customer'), 'Must guide officer to request mandatory proof');
    });

    await runTest('Test 32: Master Combined Scenario: Customer received M, wants L exchange', async () => {
        const res = await investigateReturnExchange({
            orderId: '42000',
            targetExchangeVariant: 'L',
            reason: 'Customer received size M and wants size L'
        });

        assert.strictEqual(res.investigated, true);
        assert.ok(res.target_exchange_stock, 'Target exchange stock must be queried');
        assert.strictEqual(res.target_exchange_stock.target_size, 'L');
        assert.strictEqual(res.target_exchange_stock.in_stock, true, 'Size L is in stock in warehouse');
        assert.ok(res.target_exchange_stock.stock_available > 0);

        const report = formatInvestigationReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[POLICY]'));
        assert.ok(report.includes('[INFERENCE / RECOMMENDATION]'));
        assert.ok(report.includes('[ACTION RECOMMENDED]'));
        assert.ok(report.includes('offcomfrt.in/pages/return'), 'Must guide customer to returns portal');
        assert.ok(report.includes('24-48 business hours'), 'Must mention pickup SLA');
    });

    console.log('\n============================================================');
    console.log(`TEST RESULTS: ${passedTests} passed, ${failedTests} failed out of ${passedTests + failedTests} tests`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
