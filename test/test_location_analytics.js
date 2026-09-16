/**
 * Automated Test Suite for Requirement 22: Pincode and Location Analytics
 */

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
    getLocationAnalytics,
    getTopPincodesByRto,
    getTopCitiesByOrderVolume,
    getDeliveryComplaintConcentrations,
    getCodCancellationByLocation,
    getDeliveryDelayByLocation,
    getLocationOverview,
    formatLocationAnalyticsReport,
    sanitizeLocationData
} = require('../src/services/locationAnalyticsService');

const { tools, getTool } = require('../src/services/ai/tools');

let testsPassed = 0;
let testsFailed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✅ ${desc}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ ${desc}`);
        console.error(err);
        testsFailed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✅ ${desc}`);
        testsPassed++;
    } catch (err) {
        console.error(`  ❌ ${desc}`);
        console.error(err);
        testsFailed++;
    }
}

(async () => {
    console.log('\n============================================================');
    console.log('TEST SUITE: REQUIREMENT 22 - PINCODE & LOCATION ANALYTICS');
    console.log('============================================================\n');

    console.log('--- 1. PII Sanitization Unit Tests ---');

    it('sanitizeLocationData removes sensitive PII fields', () => {
        const dirty = [
            { pincode: '500055', city: 'Hyderabad', customer_name: 'John Doe', name: 'John', phone: '919999999999', address: 'Flat 101 Street', email: 'test@example.com', rto_rate_pct: 45.5 }
        ];
        const clean = sanitizeLocationData(dirty);
        assert.strictEqual(clean[0].pincode, '500055');
        assert.strictEqual(clean[0].city, 'Hyderabad');
        assert.strictEqual(clean[0].rto_rate_pct, 45.5);
        assert.strictEqual(clean[0].customer_name, undefined);
        assert.strictEqual(clean[0].name, undefined);
        assert.strictEqual(clean[0].phone, undefined);
        assert.strictEqual(clean[0].address, undefined);
        assert.strictEqual(clean[0].email, undefined);
    });

    it('sanitizeLocationData handles non-array input safely', () => {
        assert.strictEqual(sanitizeLocationData(null), null);
        assert.strictEqual(sanitizeLocationData(undefined), undefined);
    });

    console.log('\n--- 2. Live Database Analytics Tests ---');

    let pincodeData;
    await itAsync('getTopPincodesByRto calculates RTO rates with sample size gating', async () => {
        pincodeData = await getTopPincodesByRto({ minOrders: 10, limit: 10 });
        assert.strictEqual(pincodeData.query_type, 'top_pincodes_rto');
        assert(Array.isArray(pincodeData.pincodes), 'pincodes must be an array');
        assert(pincodeData.pincodes.length > 0, 'should return at least 1 pincode');
        
        const top = pincodeData.pincodes[0];
        assert(/^\d{6}$/.test(top.pincode), `Pincode ${top.pincode} must be 6 digits`);
        assert(top.actionable_shipments >= 10, 'Actionable shipments must satisfy N >= 10 threshold');
        assert(typeof top.rto_rate_pct === 'number', 'RTO rate must be numeric');
        assert(top.rto_rate_pct >= 0 && top.rto_rate_pct <= 100, 'RTO rate must be between 0 and 100');
    });

    it('getTopPincodesByRto enforces strict zero PII exposure', () => {
        assert(pincodeData && pincodeData.pincodes.length > 0);
        for (const p of pincodeData.pincodes) {
            assert.strictEqual(p.customer_name, undefined);
            assert.strictEqual(p.name, undefined);
            assert.strictEqual(p.phone, undefined);
            assert.strictEqual(p.address, undefined);
            assert.strictEqual(p.email, undefined);
        }
    });

    let cityData;
    await itAsync('getTopCitiesByOrderVolume ranks cities by demand and GMV', async () => {
        cityData = await getTopCitiesByOrderVolume({ limit: 10 });
        assert.strictEqual(cityData.query_type, 'top_cities_volume');
        assert(Array.isArray(cityData.cities), 'cities must be an array');
        assert(cityData.cities.length >= 5, 'should return top demand cities');

        const top = cityData.cities[0];
        assert.strictEqual(top.city, 'MUMBAI', 'Mumbai should be the top demand city');
        assert(top.total_orders > 1000, 'Mumbai should have > 1000 orders');
        assert(top.total_gmv > 1000000, 'Mumbai GMV should be > 10,00,000 INR');
        assert(typeof top.rto_rate_pct === 'number', 'RTO rate should be numeric');

        // Check descending order
        for (let i = 0; i < cityData.cities.length - 1; i++) {
            assert(cityData.cities[i].total_orders >= cityData.cities[i+1].total_orders, 'Cities must be sorted descending by total_orders');
        }
    });

    it('getTopCitiesByOrderVolume enforces strict zero PII exposure', () => {
        for (const c of cityData.cities) {
            assert.strictEqual(c.customer_name, undefined);
            assert.strictEqual(c.name, undefined);
            assert.strictEqual(c.phone, undefined);
            assert.strictEqual(c.address, undefined);
        }
    });

    let complaintData;
    await itAsync('getDeliveryComplaintConcentrations identifies areas with delivery grievances', async () => {
        complaintData = await getDeliveryComplaintConcentrations({ level: 'city', limit: 10 });
        assert.strictEqual(complaintData.query_type, 'complaint_concentration');
        assert(Array.isArray(complaintData.locations), 'locations must be an array');
        assert(complaintData.locations.length > 0, 'should return complaint concentrations');

        const top = complaintData.locations[0];
        assert(top.total_complaints > 0, 'Total complaints must be > 0');
        assert(top.delivery_complaints > 0, 'Delivery complaints must be > 0');
        assert(typeof top.delivery_complaint_pct === 'number', 'Complaint pct must be numeric');
    });

    let codData;
    await itAsync('getCodCancellationByLocation calculates COD cancellation rates', async () => {
        codData = await getCodCancellationByLocation({ minCodOrders: 20, limit: 10 });
        assert.strictEqual(codData.query_type, 'cod_cancellations');
        assert(Array.isArray(codData.cities), 'cities must be an array');
        assert(codData.cities.length > 0, 'should return COD cancellation data');

        const top = codData.cities[0];
        assert(top.cod_orders >= 20, 'Must satisfy minimum sample size gating');
        assert(typeof top.cod_cancellation_rate_pct === 'number', 'COD cancellation rate must be numeric');
        assert(top.cod_cancellation_rate_pct >= 0 && top.cod_cancellation_rate_pct <= 100);
    });

    let delayData;
    await itAsync('getDeliveryDelayByLocation calculates average transit duration and delay rate', async () => {
        delayData = await getDeliveryDelayByLocation({ minShipments: 15, limit: 10 });
        assert.strictEqual(delayData.query_type, 'delivery_delay');
        assert(Array.isArray(delayData.cities), 'cities must be an array');
        assert(delayData.cities.length > 0, 'should return delay data');

        const top = delayData.cities[0];
        assert(top.delivered_shipments >= 15, 'Must satisfy minimum delivered shipments threshold');
        assert(typeof top.avg_transit_days === 'number', 'Avg transit days must be numeric');
        assert(typeof top.delay_rate_pct === 'number', 'Delay rate must be numeric');
    });

    await itAsync('getLocationOverview returns comprehensive stats for specific pincode', async () => {
        const overview = await getLocationOverview({ pincode: '500055' });
        assert.strictEqual(overview.query_type, 'location_overview');
        assert.strictEqual(overview.location.pincode, '500055');
        assert(overview.metrics.total_orders > 0, 'Should have recorded orders');
        assert(typeof overview.metrics.rto_rate_pct === 'number', 'RTO rate must be numeric');
        assert(overview.metrics.rto_rate_pct >= 50, 'Pincode 500055 is a verified high-RTO hotspot');
    });

    console.log('\n--- 3. Report Formatting and Phase 14 Tags ---');

    it('formatLocationAnalyticsReport includes Phase 14 classification tags', () => {
        const report = formatLocationAnalyticsReport(pincodeData);
        assert(report.includes('[VERIFIED FACT]'), 'Must include [VERIFIED FACT]');
        assert(report.includes('[POLICY]'), 'Must include [POLICY]');
        assert(report.includes('[PATTERN]'), 'Must include [PATTERN]');
        assert(report.includes('[ANOMALY]'), 'Must include [ANOMALY]');
        assert(report.includes('[RECOMMENDATION]'), 'Must include [RECOMMENDATION]');
        assert(report.includes('(IST)'), 'Must include IST timestamp');
        assert(report.includes('500055'), 'Must reference highest RTO pincode');
    });

    it('formatLocationAnalyticsReport for top cities volume has correct tags', () => {
        const report = formatLocationAnalyticsReport(cityData);
        assert(report.includes('[VERIFIED FACT]'), 'Must include [VERIFIED FACT]');
        assert(report.includes('[PATTERN]'), 'Must include [PATTERN]');
        assert(report.includes('[RECOMMENDATION]'), 'Must include [RECOMMENDATION]');
        assert(report.includes('MUMBAI'), 'Must reference top demand city Mumbai');
    });

    it('formatLocationAnalyticsReport for complaints has correct tags', () => {
        const report = formatLocationAnalyticsReport(complaintData);
        assert(report.includes('[VERIFIED FACT]'), 'Must include [VERIFIED FACT]');
        assert(report.includes('[PATTERN]'), 'Must include [PATTERN]');
        assert(report.includes('[RECOMMENDATION]'), 'Must include [RECOMMENDATION]');
    });

    console.log('\n--- 4. AI Tool Registration & Trigger Routing Tests ---');

    it('get_location_analytics is registered in tools array', () => {
        const tool = getTool('get_location_analytics');
        assert(tool, 'Tool get_location_analytics must be registered');
        assert.strictEqual(tool.name, 'get_location_analytics');
        assert(tool.description.includes('location'), 'Tool description should mention location');
        assert(tool.parameters.properties.queryType, 'Should have queryType parameter');
        assert(tool.parameters.properties.pincode, 'Should have pincode parameter');
        assert(tool.parameters.properties.city, 'Should have city parameter');
    });

    await itAsync('get_location_analytics executes cleanly via tools dispatcher', async () => {
        const tool = getTool('get_location_analytics');
        const res = await tool.execute({ queryType: 'top_cities_volume', limit: 5 });
        assert(res.cities, 'Result must contain cities');
        assert.strictEqual(res.cities.length, 5);
        assert(res.formatted_report, 'Result must contain formatted_report');
    });

    it('TOOL_TRIGGERS correctly routes target location questions', () => {
        const fs = require('fs');
        const toolsContent = fs.readFileSync(path.join(__dirname, '../src/services/ai/tools.js'), 'utf8');
        const triggerMatch = toolsContent.match(/get_location_analytics:\s*(\/.*?\/[gimsuy]*)/);
        assert(triggerMatch, 'TOOL_TRIGGERS must define get_location_analytics');

        const regex = eval(triggerMatch[1]);
        assert(regex.test('Which pincodes have the highest RTO?'), 'Should match "Which pincodes have the highest RTO?"');
        assert(regex.test('Where are delivery complaints concentrated?'), 'Should match "Where are delivery complaints concentrated?"');
        assert(regex.test('Which cities have the most orders?'), 'Should match "Which cities have the most orders?"');
        assert(regex.test('Show me location analytics'), 'Should match "location analytics"');
        assert(regex.test('What is the RTO by pincode?'), 'Should match "rto by pincode"');
        assert(regex.test('Tell me about pincode 500055'), 'Should match "pincode 500055"');
    });

    console.log('\n============================================================');
    console.log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
    console.log('============================================================\n');

    if (testsFailed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
})();
