/**
 * Automated Test Suite for Requirement 6: SKU-Level Sales Analytics
 *
 * Tests:
 * 1. Timezone & Boundary calculations (Step 5: IST boundaries for today, yesterday, this week)
 * 2. Pure aggregation logic: SKU-level quantities, revenue, and product roll-ups
 * 3. Live database tests comparing results against known database values (Step 7)
 * 4. Answering all 4 target officer questions (Step 4):
 *    - "How many units of SKU X sold today?"
 *    - "What are today's best-selling SKUs?"
 *    - "Which SKU sold the most this week?"
 *    - "Which SKU generated the highest revenue?"
 * 5. Data freshness & explicit IST timestamp verification (Step 6)
 * 6. Specific SKU and product filtering (including non-existent product handling)
 * 7. Tool registration and token-lean intent routing via selectToolSchemas
 */

require('dotenv').config();
const assert = require('assert');
const {
    getSalesBySku,
    getIstPeriodBoundaries,
    formatIstDateTime,
    formatIstDateOnly,
    normalizeSkuKey,
    aggregateSalesData,
    buildTargetOfficerAnswers,
    buildSalesAnalyticsSummary
} = require('../src/services/skuSalesService');
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
    console.log('🧪 RUNNING REQUIREMENT 6: SKU-LEVEL SALES ANALYTICS TESTS');
    console.log('======================================================\n');

    // Group 1: Timezone and Period Boundary Tests (Step 5)
    console.log('--- Step 5: Timezone & Period Boundary Tests ---');

    it('getIstPeriodBoundaries accurately calculates start of today in IST (UTC+05:30)', () => {
        // Mock reference date: 2026-09-09T03:00:00Z (08:30 AM IST on 9 Sep 2026)
        const refDate = new Date('2026-09-09T03:00:00.000Z');
        const boundaries = getIstPeriodBoundaries('today', refDate);

        // 9 Sep 2026 00:00:00 IST is 8 Sep 2026 18:30:00 UTC
        assert.strictEqual(boundaries.startUtc.toISOString(), '2026-09-08T18:30:00.000Z');
        assert.strictEqual(boundaries.timezone, 'Asia/Kolkata (IST, UTC+05:30)');
        assert(boundaries.label.includes('Today'));
    });

    it('getIstPeriodBoundaries accurately calculates this week from Monday 00:00:00 IST', () => {
        // Wednesday 9 Sep 2026
        const refDate = new Date('2026-09-09T03:00:00.000Z');
        const boundaries = getIstPeriodBoundaries('this_week', refDate);

        // Monday of this week was 7 Sep 2026 00:00:00 IST = 6 Sep 2026 18:30:00 UTC
        assert.strictEqual(boundaries.startUtc.toISOString(), '2026-09-06T18:30:00.000Z');
        assert(boundaries.label.includes('This Week'));
    });

    it('formatIstDateTime formats UTC timestamp into human-readable IST string', () => {
        const utcDate = '2026-09-09T02:15:00.000Z'; // 07:45 AM IST
        const istString = formatIstDateTime(utcDate);
        assert(istString.includes('09 Sep 2026'));
        assert(istString.includes('07:45 AM IST'));
    });

    // Group 2: Pure Aggregation & SKU Normalization Tests
    console.log('\n--- Unit Tests: Aggregation & SKU Normalization ---');

    it('normalizeSkuKey produces canonical lowercase identifier', () => {
        assert.strictEqual(normalizeSkuKey({ title: 'WAFFLE - 001 ( W )', variant_title: 'M' }), 'waffle-001-w-m');
        assert.strictEqual(normalizeSkuKey({ sku: '6' }), '6');
        assert.strictEqual(normalizeSkuKey({ sku: 'OC-HNLY-001-B-S' }), 'oc-hnly-001-b-s');
    });

    it('aggregateSalesData aggregates unit quantities, revenue, and product roll-ups accurately', () => {
        const mockRows = [
            {
                status: 'confirmed',
                items_json: JSON.stringify([
                    { name: 'HENLEY - 001 ( ACID WASH ) - L', title: 'HENLEY - 001 ( ACID WASH )', variant_title: 'L', quantity: 2, price: '1299.00' },
                    { name: 'WAFFLE - 001 ( W ) - M', title: 'WAFFLE - 001 ( W )', variant_title: 'M', quantity: 1, price: '1199.00' }
                ])
            },
            {
                status: 'delivered',
                items_json: JSON.stringify([
                    { name: 'HENLEY - 001 ( ACID WASH ) - L', title: 'HENLEY - 001 ( ACID WASH )', variant_title: 'L', quantity: 1, price: '1299.00' },
                    { name: 'HENLEY - 001 ( ACID WASH ) - S', title: 'HENLEY - 001 ( ACID WASH )', variant_title: 'S', quantity: 3, price: '1299.00' }
                ])
            },
            {
                status: 'cancelled', // Cancelled order
                items_json: JSON.stringify([
                    { name: 'HENLEY - 001 ( ACID WASH ) - L', title: 'HENLEY - 001 ( ACID WASH )', variant_title: 'L', quantity: 1, price: '1299.00' }
                ])
            }
        ];

        const res = aggregateSalesData(mockRows, { sortBy: 'units' });

        // Total units = (2 + 1) + (1 + 3) + 1 = 8 units
        assert.strictEqual(res.summary.totalUnitsSold, 8);
        assert.strictEqual(res.summary.totalCancelledUnits, 1);
        // Total orders = 3
        assert.strictEqual(res.summary.totalOrders, 3);

        // Best-selling SKU variant check
        // HENLEY L: 2 + 1 + 1 = 4 units
        // HENLEY S: 3 units
        // WAFFLE M: 1 unit
        const henleyL = res.skus.find(s => s.name === 'HENLEY - 001 ( ACID WASH ) - L');
        assert(henleyL !== undefined);
        assert.strictEqual(henleyL.unitsSold, 4);
        assert.strictEqual(henleyL.grossRevenue, 4 * 1299);
        assert.strictEqual(henleyL.netUnitsSold, 3);

        // Product rollup check
        const henleyProd = res.products.find(p => p.productName === 'HENLEY - 001 ( ACID WASH )');
        assert(henleyProd !== undefined);
        assert.strictEqual(henleyProd.totalUnits, 7); // 4 L + 3 S
        assert.strictEqual(henleyProd.variantsBreakdown['L'], 4);
        assert.strictEqual(henleyProd.variantsBreakdown['S'], 3);
    });

    // Group 3: Answering Target Officer Questions (Step 4)
    console.log('\n--- Step 4: Answering Target Officer Questions ---');

    it('buildTargetOfficerAnswers generates accurate answers for all 4 required questions', () => {
        const periodInfo = { label: 'Today (09-Sep-2026)' };
        const skus = [
            { name: 'HENLEY - 001 ( ACID WASH ) - XS', productName: 'HENLEY - 001 ( ACID WASH )', variant: 'XS', unitsSold: 7, grossRevenue: 9093 },
            { name: 'HENLEY - 001 ( ACID WASH ) - S', productName: 'HENLEY - 001 ( ACID WASH )', variant: 'S', unitsSold: 5, grossRevenue: 6495 },
            { name: 'WAFFLE - 001 ( TRIPLE ) - L', productName: 'WAFFLE - 001 ( TRIPLE )', variant: 'L', unitsSold: 2, grossRevenue: 5598 }
        ];
        const products = [
            { productName: 'HENLEY - 001 ( ACID WASH )', totalUnits: 12, variantsBreakdown: { 'XS': 7, 'S': 5 } }
        ];

        // Q1: "How many units of SKU X sold today?"
        const q1Answers = buildTargetOfficerAnswers({ skus, products, periodInfo, filterTerm: 'HENLEY - 001 ( ACID WASH ) - XS' });
        assert(q1Answers.unitsSoldAnswer.includes('sold 7 unit(s)'));
        assert(q1Answers.unitsSoldAnswer.includes('₹9,093'));

        // Q2: "What are today's best-selling SKUs?"
        assert(q1Answers.todayBestSellersAnswer.includes('Best-selling SKUs for Today'));
        assert(q1Answers.todayBestSellersAnswer.includes('HENLEY - 001 ( ACID WASH ) - XS — 7 units'));

        // Q3: "Which SKU sold the most this week?"
        assert(q1Answers.weekTopSellerAnswer.includes('#1 best-selling SKU by units is "HENLEY - 001 ( ACID WASH ) - XS"'));

        // Q4: "Which SKU generated the highest revenue?"
        assert(q1Answers.highestRevenueSkuAnswer.includes('highest revenue is "HENLEY - 001 ( ACID WASH ) - XS"'));
    });

    // Group 4: Step 6 Data Freshness & Explicit Timestamp
    console.log('\n--- Step 6: Data Freshness & Data Timestamp Verification ---');

    it('buildSalesAnalyticsSummary states exact data timestamp and IST timezone', () => {
        const periodInfo = { label: 'Today (09-Sep-2026)', timezone: 'Asia/Kolkata (IST, UTC+05:30)' };
        const summary = { totalUnitsSold: 50, totalOrders: 40, totalGrossRevenue: 65000 };
        const skus = [{ name: 'HENLEY - 001 - M', unitsSold: 10, grossRevenue: 12990 }];
        const answers = {
            unitsSoldAnswer: '10 units sold.',
            highestRevenueSkuAnswer: 'HENLEY - 001 - M generating ₹12,990.'
        };

        const text = buildSalesAnalyticsSummary({ summary, skus, products: [], periodInfo, answers });

        assert(text.includes('Asia/Kolkata (IST, UTC+05:30)'));
        assert(text.includes('Data as of:'));
        assert(text.includes('IST (Live Database)'));
        assert(text.includes('Period: Today (09-Sep-2026)'));
    });

    // Group 5: Live Database Tests (Step 7)
    console.log('\n--- Step 7: Live Database Tests Against Known Values ---');

    await asyncIt('Retrieves today sales analytics for live database orders (09-Sep-2026 IST)', async () => {
        const result = await getSalesBySku({ dateRange: 'today' });

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.timeZone, 'Asia/Kolkata (IST, UTC+05:30)');
        assert(typeof result.dataTimestamp === 'string');
        assert(result.dataTimestamp.includes('IST'));
        assert.strictEqual(result.isLive, true);

        // Live DB verification: verify orders placed today IST
        assert(result.summary.totalOrders > 0, `Expected > 0 orders today, got ${result.summary.totalOrders}`);
        assert(result.summary.totalUnitsSold > 0, `Expected > 0 units sold today, got ${result.summary.totalUnitsSold}`);
        assert(result.summary.totalGrossRevenue > 0, `Expected > 0 revenue today, got ${result.summary.totalGrossRevenue}`);
        assert(result.bestSellingSkus.length > 0);

        // Top SKU check
        const topSku = result.bestSellingSkus[0];
        assert(topSku.unitsSold >= 1);
        assert(topSku.grossRevenue > 0);

        // Direct answer checks
        assert(result.answers.todayBestSellers.includes('Best-selling SKUs'));
        assert(result.answers.highestRevenueSkuAnswer.includes('highest revenue'));
    });

    await asyncIt('Answers "How many units of SKU X sold today?" for known SKU (HENLEY - 001 ACID WASH)', async () => {
        const result = await getSalesBySku({
            dateRange: 'today',
            skuOrProduct: 'HENLEY - 001 ( ACID WASH )'
        });

        assert.strictEqual(result.found, true);
        assert(result.bestSellingSkus.length > 0);
        
        // Product line roll-up check
        const acidWashProd = result.bestSellingProducts.find(p => p.productName.includes('ACID WASH'));
        assert(acidWashProd !== undefined);
        assert(acidWashProd.totalUnits >= 10, `Expected >= 10 units for ACID WASH line, got ${acidWashProd.totalUnits}`);

        // Q1 direct answer check
        assert(result.answers.unitsSoldToday.includes('sold'));
        assert(result.answers.unitsSoldToday.includes('unit(s)'));
    });

    await asyncIt('Accurately handles non-existent SKU query without error', async () => {
        const result = await getSalesBySku({
            dateRange: 'today',
            skuOrProduct: 'NON_EXISTENT_SKU_99999'
        });

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.bestSellingSkus.length, 0);
        assert(result.answers.unitsSoldToday.includes('0 units sold'));
    });

    await asyncIt('Retrieves weekly sales analytics for current week in IST', async () => {
        const result = await getSalesBySku({ dateRange: 'this_week' });

        assert.strictEqual(result.found, true);
        assert(result.summary.totalOrders >= 100, `Expected >= 100 orders this week, got ${result.summary.totalOrders}`);
        assert(result.summary.totalGrossRevenue > 100000, `Expected > ₹100,000 revenue this week, got ${result.summary.totalGrossRevenue}`);
        assert(result.answers.weekTopSeller.includes('#1 best-selling SKU'));
    });

    // Group 6: Tool Registration and Intent Routing Tests
    console.log('\n--- Tool Registration & Intent Routing Tests ---');

    it('get_sales_by_sku is registered in tools list', () => {
        const tool = tools.find(t => t.name === 'get_sales_by_sku');
        assert(tool !== undefined);
        assert.strictEqual(tool.requiresConfirmation, false);
    });

    it('selectToolSchemas routes "How many units of SKU X sold today?" to get_sales_by_sku', () => {
        const schemas = selectToolSchemas('How many units of SKU X sold today?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_sales_by_sku'));
    });

    it('selectToolSchemas routes "What are today\'s best-selling SKUs?" to get_sales_by_sku', () => {
        const schemas = selectToolSchemas("What are today's best-selling SKUs?");
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_sales_by_sku'));
    });

    it('selectToolSchemas routes "Which SKU sold the most this week?" to get_sales_by_sku', () => {
        const schemas = selectToolSchemas('Which SKU sold the most this week?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_sales_by_sku'));
    });

    it('selectToolSchemas routes "Which SKU generated the highest revenue?" to get_sales_by_sku', () => {
        const schemas = selectToolSchemas('Which SKU generated the highest revenue?');
        const names = schemas.map(s => s.function.name);
        assert(names.includes('get_sales_by_sku'));
    });

    console.log('\n======================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('======================================================\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
