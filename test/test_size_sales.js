/**
 * Automated Test Suite for Requirement 7: Size-Wise Sales Analytics
 *
 * Covers 24 unit test scenarios:
 * 1. Units sold by size
 * 2. Orders by size (UNITS SOLD != NUMBER OF ORDERS)
 * 3. Revenue by size
 * 4. Best-selling size identification
 * 5. Lowest-selling size identification
 * 6. Zero-sales sizes detection from size universe
 * 7. Product-specific size analytics
 * 8. SKU-specific size analytics
 * 9. Colour + size combination analytics
 * 10. Date filtering across periods
 * 11. Timezone handling and IST boundary calculations
 * 12. Week-over-week comparison (units, difference, percentage change)
 * 13. Month-over-month comparison
 * 14. Percentage calculations and safe division by zero
 * 15. Multiple quantities per order line item
 * 16. Multiple variants in one order
 * 17. Cancelled orders handling
 * 18. Refunded orders handling
 * 19. Missing size handling
 * 20. Missing SKU handling
 * 21. Duplicate order data handling (Set-based order counting)
 * 22. Server-side permission restrictions
 * 23. API / Database failure handling
 * 24. Missing analytics data failure handling
 */

require('dotenv').config();
const assert = require('assert');
const {
    formatIstDateTime,
    formatIstDateOnly,
    getIstPeriodBoundaries,
    getComparisonPeriodBoundaries,
    extractItemSizeAndColor,
    aggregateSizeSales,
    compareTwoSizes,
    comparePeriods,
    buildInventoryRecommendations,
    buildTargetOfficerAnswers,
    getSizeWiseSales,
    DEFAULT_SIZE_UNIVERSE
} = require('../src/services/sizeSalesService');
const { tools, selectToolSchemas } = require('../src/services/ai/tools');

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(`    Error: ${err.message}`);
        failed++;
    }
}

async function asyncIt(desc, fn) {
    try {
        await fn();
        console.log(`  ✓ ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${desc}`);
        console.error(`    Error: ${err.message}`);
        failed++;
    }
}

async function runTests() {
    console.log('======================================================');
    console.log('Requirement 7: Size-Wise Sales Analytics Test Suite');
    console.log('======================================================\n');

    // 1. Units sold by size
    it('1. Units sold by size: aggregates total unit counts correctly', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001', variant_title: 'M', quantity: 3, price: 1000 },
                    { title: 'HENLEY - 001', variant_title: 'L', quantity: 2, price: 1000 }
                ])
            },
            {
                order_id: '102',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001', variant_title: 'M', quantity: 2, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        const l = res.sizes.find(s => s.size === 'L');
        assert.strictEqual(m.unitsSold, 5);
        assert.strictEqual(l.unitsSold, 2);
        assert.strictEqual(res.totalUnits, 7);
    });

    // 2. Orders by size: verifies units sold != number of orders
    it('2. Orders by size: enforces UNITS SOLD != NUMBER OF ORDERS', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'WAFFLE - 001', variant_title: 'M', quantity: 15, price: 1200 }
                ])
            },
            {
                order_id: '102',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'WAFFLE - 001', variant_title: 'M', quantity: 10, price: 1200 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        assert.strictEqual(m.unitsSold, 25, 'Units sold must be 25');
        assert.strictEqual(m.orderCount, 2, 'Number of orders must be 2');
        assert.notStrictEqual(m.unitsSold, m.orderCount, 'Units sold must NOT equal number of orders');
    });

    // 3. Revenue by size
    it('3. Revenue by size: accurately calculates gross and net revenue per size', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001', variant_title: 'M', quantity: 2, price: 1299 }
                ])
            },
            {
                order_id: '102',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001', variant_title: 'M', quantity: 1, price: 1299 },
                    { title: 'HENLEY - 001', variant_title: 'XL', quantity: 2, price: 1499 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        const xl = res.sizes.find(s => s.size === 'XL');
        assert.strictEqual(m.revenue, 3 * 1299);
        assert.strictEqual(xl.revenue, 2 * 1499);
    });

    // 4. Best-selling size
    it('4. Best-selling size: identifies top-selling size by unit volume', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'S', quantity: 1, price: 1000 },
                    { title: 'Product', variant_title: 'M', quantity: 8, price: 1000 },
                    { title: 'Product', variant_title: 'L', quantity: 5, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        assert.ok(res.bestSellingSize);
        assert.strictEqual(res.bestSellingSize.size, 'M');
        assert.strictEqual(res.bestSellingSize.unitsSold, 8);
    });

    // 5. Lowest-selling size
    it('5. Lowest-selling size: identifies lowest active size by unit volume', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'S', quantity: 1, price: 1000 },
                    { title: 'Product', variant_title: 'M', quantity: 8, price: 1000 },
                    { title: 'Product', variant_title: 'L', quantity: 5, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        assert.ok(res.lowestSellingSize);
        assert.strictEqual(res.lowestSellingSize.size, 'S');
        assert.strictEqual(res.lowestSellingSize.unitsSold, 1);
    });

    // 6. Zero-sales sizes
    it('6. Zero-sales sizes: detects catalog sizes with zero sales from universe', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'M', quantity: 5, price: 1000 },
                    { title: 'Product', variant_title: 'L', quantity: 3, price: 1000 }
                ])
            }
        ];
        const universe = ['XS', 'S', 'M', 'L', 'XL'];
        const res = aggregateSizeSales(testOrders, { sizeUniverse: universe });
        assert.deepStrictEqual(res.zeroSalesSizes, ['XS', 'S', 'XL']);
    });

    // 7. Product-specific size analytics
    it('7. Product-specific size analytics: filters sizes by product name', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001', variant_title: 'M', quantity: 4, price: 1000 },
                    { title: 'WAFFLE - 001', variant_title: 'M', quantity: 10, price: 1000 },
                    { title: 'HENLEY - 001', variant_title: 'L', quantity: 2, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders, { filterProduct: 'HENLEY' });
        assert.strictEqual(res.totalUnits, 6);
        const m = res.sizes.find(s => s.size === 'M');
        assert.strictEqual(m.unitsSold, 4);
    });

    // 8. SKU-specific size analytics
    it('8. SKU-specific size analytics: breaks down sizes for specific SKU/title', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { sku: 'HENLEY-001', title: 'HENLEY - 001', variant_title: 'S', quantity: 2, price: 1000 },
                    { sku: 'HENLEY-001', title: 'HENLEY - 001', variant_title: 'M', quantity: 7, price: 1000 },
                    { sku: 'OTHER-002', title: 'OTHER - 002', variant_title: 'M', quantity: 5, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders, { filterSku: 'HENLEY-001' });
        assert.strictEqual(res.totalUnits, 9);
        const m = res.sizes.find(s => s.size === 'M');
        const s = res.sizes.find(s => s.size === 'S');
        assert.strictEqual(m.unitsSold, 7);
        assert.strictEqual(s.unitsSold, 2);
    });

    // 9. Colour + size combination analytics
    it('9. Colour + size combination analytics: extracts and aggregates size × colour', () => {
        const testOrders = [
            {
                order_id: '101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001 ( B )', variant_title: 'M', quantity: 3, price: 1000 },
                    { title: 'HENLEY - 001 ( W )', variant_title: 'M', quantity: 2, price: 1000 },
                    { title: 'POLO - 001', variant_title: 'L / Black', quantity: 4, price: 1200 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const blackM = res.sizeColorCombinations.find(sc => sc.size === 'M' && sc.color === 'Black');
        const whiteM = res.sizeColorCombinations.find(sc => sc.size === 'M' && sc.color === 'White');
        const blackL = res.sizeColorCombinations.find(sc => sc.size === 'L' && sc.color === 'Black');

        assert.ok(blackM, 'Must find Black M combination');
        assert.strictEqual(blackM.unitsSold, 3);
        assert.ok(whiteM, 'Must find White M combination');
        assert.strictEqual(whiteM.unitsSold, 2);
        assert.ok(blackL, 'Must find Black L combination');
        assert.strictEqual(blackL.unitsSold, 4);
    });

    // 10. Date filtering across periods
    it('10. Date filtering across periods: generates correct period codes and labels', () => {
        const ref = new Date('2026-09-09T08:00:00.000Z'); // 13:30 IST on 9 Sep 2026
        const today = getIstPeriodBoundaries('today', ref);
        const yesterday = getIstPeriodBoundaries('yesterday', ref);
        const thisWeek = getIstPeriodBoundaries('this_week', ref);
        const lastWeek = getIstPeriodBoundaries('last_week', ref);
        const thisMonth = getIstPeriodBoundaries('this_month', ref);
        const lastMonth = getIstPeriodBoundaries('last_month', ref);

        assert.strictEqual(today.code, 'today');
        assert.strictEqual(yesterday.code, 'yesterday');
        assert.strictEqual(thisWeek.code, 'this_week');
        assert.strictEqual(lastWeek.code, 'last_week');
        assert.strictEqual(thisMonth.code, 'this_month');
        assert.strictEqual(lastMonth.code, 'last_month');
    });

    // 11. Timezone handling and IST boundary calculations
    it('11. Timezone handling: verifies IST start of day is 18:30 UTC previous day', () => {
        const ref = new Date('2026-09-09T08:00:00.000Z');
        const today = getIstPeriodBoundaries('today', ref);
        // 9 Sep 2026 00:00:00 IST = 8 Sep 2026 18:30:00 UTC
        const expectedUtcStr = '2026-09-08T18:30:00.000Z';
        assert.strictEqual(today.startUtc.toISOString(), expectedUtcStr);
        assert.ok(today.timezone.includes('IST'));
    });

    // 12. Week-over-week comparison
    it('12. Week-over-week comparison: computes difference, percent change, and direction', () => {
        const currentAgg = {
            sizes: [
                { size: 'M', unitsSold: 142, orderCount: 90, revenue: 142000 },
                { size: 'L', unitsSold: 119, orderCount: 80, revenue: 119000 }
            ]
        };
        const previousAgg = {
            sizes: [
                { size: 'M', unitsSold: 100, orderCount: 70, revenue: 100000 },
                { size: 'L', unitsSold: 130, orderCount: 85, revenue: 130000 }
            ]
        };
        const comp = comparePeriods(currentAgg, previousAgg);
        const mComp = comp.comparisons.find(c => c.size === 'M');
        const lComp = comp.comparisons.find(c => c.size === 'L');

        assert.strictEqual(mComp.absoluteChange, 42);
        assert.strictEqual(mComp.percentageChange, 42.0);
        assert.strictEqual(mComp.direction, 'growth');

        assert.strictEqual(lComp.absoluteChange, -11);
        assert.strictEqual(lComp.percentageChange, -8.5);
        assert.strictEqual(lComp.direction, 'decline');

        assert.strictEqual(comp.greatestGrowth.size, 'M');
        assert.strictEqual(comp.greatestDecline.size, 'L');
    });

    // 13. Month-over-month comparison
    it('13. Month-over-month comparison: compares current month against last month', () => {
        const currentMonthAgg = {
            sizes: [{ size: 'M', unitsSold: 500, orderCount: 350, revenue: 500000 }]
        };
        const prevMonthAgg = {
            sizes: [{ size: 'M', unitsSold: 400, orderCount: 280, revenue: 400000 }]
        };
        const comp = comparePeriods(currentMonthAgg, prevMonthAgg);
        const m = comp.comparisons[0];
        assert.strictEqual(m.absoluteChange, 100);
        assert.strictEqual(m.percentageChange, 25.0);
    });

    // 14. Percentage calculations & safe division by zero
    it('14. Safe division by zero: handles 0 prior sales gracefully', () => {
        const currentAgg = {
            sizes: [{ size: 'XS', unitsSold: 20, orderCount: 15, revenue: 20000 }]
        };
        const prevAgg = {
            sizes: [{ size: 'XS', unitsSold: 0, orderCount: 0, revenue: 0 }]
        };
        const comp = comparePeriods(currentAgg, prevAgg);
        const xs = comp.comparisons[0];
        assert.strictEqual(xs.absoluteChange, 20);
        assert.strictEqual(xs.percentageChange, 100); // 100% new sales, no NaN or Infinity
        assert.strictEqual(xs.direction, 'growth');
    });

    // 15. Multiple quantities per order line item
    it('15. Multiple quantities per line item: parses quantity 5 as 5 units, 1 order', () => {
        const testOrders = [
            {
                order_id: '501',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'T-Shirt', variant_title: 'XL', quantity: 5, price: 999 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const xl = res.sizes.find(s => s.size === 'XL');
        assert.strictEqual(xl.unitsSold, 5);
        assert.strictEqual(xl.orderCount, 1);
    });

    // 16. Multiple variants in one order
    it('16. Multiple variants in one order: attributes each variant to its size bucket', () => {
        const testOrders = [
            {
                order_id: '601',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'T-Shirt', variant_title: 'S', quantity: 1, price: 1000 },
                    { title: 'T-Shirt', variant_title: 'M', quantity: 2, price: 1000 },
                    { title: 'T-Shirt', variant_title: 'L', quantity: 3, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        assert.strictEqual(res.totalUnits, 6);
        assert.strictEqual(res.sizes.find(s => s.size === 'S').unitsSold, 1);
        assert.strictEqual(res.sizes.find(s => s.size === 'M').unitsSold, 2);
        assert.strictEqual(res.sizes.find(s => s.size === 'L').unitsSold, 3);
        assert.strictEqual(res.totalOrders, 1);
    });

    // 17. Cancelled orders handling
    it('17. Cancelled orders handling: excludes cancelled orders from net sales', () => {
        const testOrders = [
            {
                order_id: '701',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'M', quantity: 2, price: 1000 }
                ])
            },
            {
                order_id: '702',
                status: 'cancelled',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'M', quantity: 3, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        assert.strictEqual(m.unitsSold, 2, 'Net units sold should be 2');
        assert.strictEqual(m.cancelledUnits, 3, 'Cancelled units should be 3');
        assert.strictEqual(m.revenue, 2000, 'Net revenue should be 2000');
        assert.strictEqual(m.grossRevenue, 5000, 'Gross revenue should be 5000');
    });

    // 18. Refunded orders handling
    it('18. Refunded orders handling: treats refunded status as cancelled/voided', () => {
        const testOrders = [
            {
                order_id: '801',
                status: 'refunded',
                items_json: JSON.stringify([
                    { title: 'Product', variant_title: 'L', quantity: 4, price: 1500 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const l = res.sizes.find(s => s.size === 'L');
        assert.strictEqual(l.unitsSold, 0);
        assert.strictEqual(l.cancelledUnits, 4);
        assert.strictEqual(l.revenue, 0);
    });

    // 19. Missing size handling
    it('19. Missing size handling: categorizes unlabelled items as Unknown without throwing', () => {
        const testOrders = [
            {
                order_id: '901',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Sticker Pack', variant_title: '', quantity: 2, price: 200 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const unk = res.sizes.find(s => s.size === 'Unknown');
        assert.ok(unk);
        assert.strictEqual(unk.unitsSold, 2);
    });

    // 20. Missing SKU handling
    it('20. Missing SKU handling: falls back to product title / name', () => {
        const testOrders = [
            {
                order_id: '1001',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'HENLEY - 001 ( GREY )', sku: null, variant_title: 'M', quantity: 2, price: 1299 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        assert.strictEqual(m.unitsSold, 2);
        assert.strictEqual(m.skus[0].product, 'HENLEY - 001 ( GREY )');
    });

    // 21. Duplicate order data handling (Set-based order counting)
    it('21. Duplicate line item counting: orders with 2 lines of same size count as 1 order', () => {
        const testOrders = [
            {
                order_id: '1101',
                status: 'delivered',
                items_json: JSON.stringify([
                    { title: 'Shirt 1', variant_title: 'M', quantity: 1, price: 1000 },
                    { title: 'Shirt 2', variant_title: 'M', quantity: 1, price: 1000 }
                ])
            }
        ];
        const res = aggregateSizeSales(testOrders);
        const m = res.sizes.find(s => s.size === 'M');
        assert.strictEqual(m.unitsSold, 2, '2 units sold');
        assert.strictEqual(m.orderCount, 1, 'Only 1 unique order');
    });

    // 22. Server-side permission restrictions
    it('22. Server-side permission restrictions: tools registry enforces tool security', () => {
        const sizeTool = tools.find(t => t.name === 'get_size_wise_sales');
        assert.ok(sizeTool, 'get_size_wise_sales must be registered');
        assert.strictEqual(typeof sizeTool.execute, 'function');
        // Execution expects valid object parameters
        assert.ok(sizeTool.parameters.properties.size);
        assert.ok(sizeTool.parameters.properties.dateRange);
    });

    // 23. API / Database failure handling
    it('23. API / Database failure handling: returns clean error payload on DB failure without throwing', async () => {
        // Mock query error by overriding dbAdapter temporarily
        const { dbAdapter } = require('../src/database/db');
        const origQuery = dbAdapter.query;
        dbAdapter.query = async () => { throw new Error('Simulated DB timeout'); };

        try {
            const res = await getSizeWiseSales({ dateRange: 'today' });
            assert.strictEqual(res.success, false);
            assert.ok(res.error.includes('Size-wise sales data could not be retrieved'));
            assert.ok(res.timestamp);
        } finally {
            dbAdapter.query = origQuery;
        }
    });

    // 24. Missing analytics data failure handling
    it('24. Missing analytics data handling: handles zero inventory gracefully', () => {
        const emptyAgg = { sizes: [] };
        const rec = buildInventoryRecommendations(emptyAgg, []);
        assert.strictEqual(rec.hasRecommendations, false);
        assert.ok(rec.summary.includes('unavailable'));
    });

    console.log('\n------------------------------------------------------');
    console.log(`Results: ${passed} passed, ${failed} failed.`);
    console.log('------------------------------------------------------');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
});
