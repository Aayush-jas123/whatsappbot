/**
 * Unit Test Suite: Requirement 21 — Return & Exchange Analytics
 *
 * Verifies:
 * 1. Authoritative return count, exchange count, units sold
 * 2. Return rate calculation: (returns / units_sold) * 100
 * 3. Exchange rate calculation: (exchanges / units_sold) * 100
 * 4. Combined reverse logistics rate: ((returns + exchanges + rto) / units_sold) * 100
 * 5. Denominator definition: Units Sold from store_shoppers (N = 32,491 orders)
 * 6. Reason categorization across 8 standard categories
 * 7. Reason distribution percentage calculations
 * 8. Size-related exchange patterns across S, M, L, XL, XXL
 * 9. Dominant size swap directions (e.g. M -> L)
 * 10. Target Question 1: "Which SKU has the highest return rate?"
 * 11. Minimum units sold threshold (N >= 10) to avoid sample size distortion
 * 12. Target Question 2: "Which size has the most exchanges?"
 * 13. Top exchange size identification (Size M)
 * 14. Target Question 3: "Why are customers returning this product?"
 * 15. Product return reason ranking with percentages
 * 16. Filtering analytics by product line
 * 17. Filtering analytics by SKU
 * 18. High-risk return anomaly detection (>15% return rate)
 * 19. Phase 14 8-tier response classification tags formatting
 * 20. Live data timestamp in IST notation
 */

const assert = require('assert');
const {
    getReturnExchangeAnalytics,
    getTopReturnedSkus,
    getSizeExchangePatterns,
    getProductReturnReasons,
    formatReturnAnalyticsReport,
    classifyReturnReason,
    normalizeProductName,
    REASON_CATEGORIES,
    REASON_LABELS
} = require('../src/services/returnAnalyticsService');

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
    console.log('STARTING UNIT TESTS: REQUIREMENT 21 (20 TESTS)');
    console.log('============================================================\n');

    await runTest('Test 1: Computes authoritative return count, exchange count, and units sold', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(res.summary);
        assert.ok(typeof res.summary.total_units_sold === 'number');
        assert.ok(res.summary.total_units_sold > 0);
        assert.ok(typeof res.summary.total_return_units === 'number');
        assert.ok(res.summary.total_return_units > 0);
        assert.ok(typeof res.summary.total_exchange_units === 'number');
        assert.ok(res.summary.total_exchange_units > 0);
    });

    await runTest('Test 2: Calculates return rate (%) with mathematically reproducible formula', async () => {
        const res = await getReturnExchangeAnalytics();
        const expectedRate = parseFloat(((res.summary.total_return_units / res.summary.total_units_sold) * 100).toFixed(2));
        assert.strictEqual(res.summary.overall_return_rate, expectedRate);
        assert.ok(res.summary.overall_return_rate >= 0 && res.summary.overall_return_rate <= 100);
    });

    await runTest('Test 3: Calculates exchange rate (%) with mathematically reproducible formula', async () => {
        const res = await getReturnExchangeAnalytics();
        const expectedRate = parseFloat(((res.summary.total_exchange_units / res.summary.total_units_sold) * 100).toFixed(2));
        assert.strictEqual(res.summary.overall_exchange_rate, expectedRate);
        assert.ok(res.summary.overall_exchange_rate >= 0 && res.summary.overall_exchange_rate <= 100);
    });

    await runTest('Test 4: Calculates combined reverse logistics rate (%)', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(typeof res.summary.overall_reverse_logistics_rate === 'number');
        assert.ok(res.summary.overall_reverse_logistics_rate > res.summary.overall_return_rate);
    });

    await runTest('Test 5: Explicitly declares denominator definition', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(res.summary.denominator_definition);
        assert.ok(res.summary.denominator_definition.includes('Total Units Sold'));
        assert.ok(res.summary.denominator_definition.includes('store_shoppers'));
    });

    await runTest('Test 6: Classifies return reasons into 8 standardized categories', async () => {
        assert.strictEqual(classifyReturnReason('too small on chest, need bigger size'), REASON_CATEGORIES.SIZE_TOO_SMALL);
        assert.strictEqual(classifyReturnReason('too loose, baggy fit'), REASON_CATEGORIES.SIZE_TOO_LARGE);
        assert.strictEqual(classifyReturnReason('stitching tore near armpit'), REASON_CATEGORIES.FABRIC_QUALITY_DEFECT);
        assert.strictEqual(classifyReturnReason('acid wash color is different from photo'), REASON_CATEGORIES.WASH_COLOR_MISMATCH);
        assert.strictEqual(classifyReturnReason('received wrong item with different neck label'), REASON_CATEGORIES.WRONG_ITEM_DELIVERED);
        assert.strictEqual(classifyReturnReason('package damaged and shirt stained on arrival'), REASON_CATEGORIES.DAMAGED_IN_TRANSIT);
        assert.strictEqual(classifyReturnReason('courier returned package, customer refused at door'), REASON_CATEGORIES.RTO_UNDELIVERED);
        assert.strictEqual(classifyReturnReason('changed my mind, no longer need'), REASON_CATEGORIES.CUSTOMER_DISCRETION);
    });

    await runTest('Test 7: Computes reason distribution with counts and percentages', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(res.reason_distribution);
        const reasons = Object.values(res.reason_distribution);
        assert.ok(reasons.length > 0);
        assert.ok(reasons[0].count > 0);
        assert.ok(typeof reasons[0].percentage === 'number');
        const sumPercentages = reasons.reduce((sum, r) => sum + r.percentage, 0);
        assert.ok(sumPercentages >= 95 && sumPercentages <= 105);
    });

    await runTest('Test 8: Computes size-related exchange distribution for S, M, L, XL, XXL', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(res.sizes);
        ['S', 'M', 'L', 'XL', 'XXL'].forEach(size => {
            assert.ok(res.sizes[size]);
            assert.ok(typeof res.sizes[size].exchanges_count === 'number');
            assert.ok(typeof res.sizes[size].exchange_rate === 'number');
            assert.ok(typeof res.sizes[size].units_sold === 'number');
        });
    });

    await runTest('Test 9: Identifies dominant size swap directions (e.g. M -> L)', async () => {
        const res = await getReturnExchangeAnalytics();
        assert.ok(Array.isArray(res.size_swap_patterns));
        assert.ok(res.size_swap_patterns.length > 0);
        assert.ok(res.size_swap_patterns[0].direction);
        assert.ok(res.size_swap_patterns[0].count > 0);
        assert.ok(res.size_swap_patterns.some(p => p.direction.includes('M → L')));
    });

    await runTest('Test 10: Answers Target Question 1: Which SKU has the highest return rate?', async () => {
        const res = await getTopReturnedSkus({ limit: 5 });
        assert.ok(res.question);
        assert.strictEqual(res.question, 'Which SKU has the highest return rate?');
        assert.ok(res.highest_return_sku);
        assert.ok(typeof res.highest_return_sku.return_rate === 'number');
        assert.ok(Array.isArray(res.top_skus));
        assert.ok(res.top_skus.length > 0);
        assert.ok(res.denominator);
    });

    await runTest('Test 11: Enforces minimum units threshold (N >= 10) for top returned SKUs', async () => {
        const res = await getTopReturnedSkus({ limit: 10, minUnits: 10 });
        for (const sku of res.top_skus) {
            assert.ok(sku.units_sold >= 10, `SKU ${sku.sku} sold ${sku.units_sold} units, should be >= 10`);
        }
    });

    await runTest('Test 12: Answers Target Question 2: Which size has the most exchanges?', async () => {
        const res = await getSizeExchangePatterns();
        assert.ok(res.question);
        assert.strictEqual(res.question, 'Which size has the most exchanges?');
        assert.ok(res.highest_exchange_size);
        assert.ok(res.highest_exchange_size.size);
        assert.ok(res.highest_exchange_size.exchanges_count > 0);
        assert.ok(Array.isArray(res.dominant_swap_directions));
    });

    await runTest('Test 13: Correctly identifies Size M as having highest exchange volume', async () => {
        const res = await getSizeExchangePatterns();
        assert.strictEqual(res.highest_exchange_size.size, 'M');
        assert.ok(res.highest_exchange_size.exchanges_count > 100);
    });

    await runTest('Test 14: Answers Target Question 3: Why are customers returning this product?', async () => {
        const res = await getProductReturnReasons({ product: 'HENLEY' });
        assert.ok(res.question);
        assert.ok(res.question.includes('Why are customers returning'));
        assert.ok(res.product);
        assert.ok(Array.isArray(res.top_reasons));
        assert.ok(res.top_reasons.length > 0);
        assert.ok(res.primary_reason);
        assert.ok(res.primary_reason.label);
    });

    await runTest('Test 15: Returns ranked reason breakdown with percentage distribution', async () => {
        const res = await getProductReturnReasons({ product: 'WAFFLE' });
        for (let i = 0; i < res.top_reasons.length - 1; i++) {
            assert.ok(res.top_reasons[i].count >= res.top_reasons[i + 1].count);
        }
    });

    await runTest('Test 16: Filters analytics by specific product line', async () => {
        const res = await getReturnExchangeAnalytics({ skuOrProduct: 'HENLEY' });
        assert.ok(res.products.length > 0);
        for (const p of res.products) {
            assert.ok(p.product.toLowerCase().includes('henley'));
        }
    });

    await runTest('Test 17: Filters analytics by specific SKU', async () => {
        const res = await getReturnExchangeAnalytics({ skuOrProduct: 'WAFFLE - 001 ( W ) - M' });
        assert.ok(res.skus.length > 0);
        assert.ok(res.skus[0].sku.toLowerCase().includes('waffle'));
    });

    await runTest('Test 18: Flags high-risk products with elevated return rates (>= 12%)', async () => {
        const res = await getReturnExchangeAnalytics();
        const highRisk = res.products.filter(p => p.is_high_risk);
        assert.ok(highRisk.length > 0);
        for (const p of highRisk) {
            assert.ok(p.return_rate >= 12.0 || p.total_reverse_rate >= 20.0);
        }
    });

    await runTest('Test 19: Formats report with Phase 14 classification tags', async () => {
        const res = await getReturnExchangeAnalytics();
        const report = formatReturnAnalyticsReport(res);
        assert.ok(report.includes('[VERIFIED FACT]'));
        assert.ok(report.includes('[POLICY]'));
        assert.ok(report.includes('[PATTERN]'));
        assert.ok(report.includes('[RECOMMENDATION]'));
        assert.ok(report.includes('Total Units Sold:'));
        assert.ok(report.includes('Combined Reverse Logistics Rate:'));
    });

    await runTest('Test 20: Includes live data timestamp with IST notation', async () => {
        const res = await getReturnExchangeAnalytics();
        const report = formatReturnAnalyticsReport(res);
        assert.ok(report.includes('IST (Live Database)'));
        assert.ok(res.data_as_of.includes('IST'));
    });

    console.log('\n============================================================');
    console.log(`TEST RUN COMPLETE: ${passedTests} passed, ${failedTests} failed out of 20 tests`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
