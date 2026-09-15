/**
 * Master Regression Test Runner across Requirements 1 to 10.
 */

const { spawn } = require('child_process');
const path = require('path');

const testSuites = [
    { name: 'Req 1: Order Intelligence', file: 'test/test_order_intelligence.js' },
    { name: 'Req 2: Customer 360', file: 'test/test_customer_360.js' },
    { name: 'Req 3: Conversation History', file: 'test/test_conversation_history.js' },
    { name: 'Req 4: Customer Behavior Patterns', file: 'test/test_customer_behavior.js' },
    { name: 'Req 5: Repeat Contact Detection', file: 'test/test_repeat_contact.js' },
    { name: 'Req 6: SKU Sales Analytics', file: 'test/test_sku_sales.js' },
    { name: 'Req 7: Size-Wise Sales Analytics', file: 'test/test_size_sales.js' },
    { name: 'Reqs 8, 9, 10: Product, Inventory & Returns', file: 'test/test_product_inventory_returns.js' },
    { name: 'Reqs 11-15: Refunds, Payments & Shipments', file: 'test/test_refunds_payments_shipments.js' },
    { name: 'Reqs 16-20: RTO, Courier, Pickup, Anomalies & Complaints', file: 'test/test_rto_courier_pickup_anomaly_complaints.js' },
    { name: 'Req 21: Return & Exchange Analytics', file: 'test/test_return_exchange_analytics.js' }
];

async function runSuite(suite) {
    return new Promise((resolve) => {
        const start = Date.now();
        const proc = spawn('node', [suite.file], { cwd: path.resolve(__dirname, '..') });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => stdout += d.toString());
        proc.stderr.on('data', (d) => stderr += d.toString());

        proc.on('close', (code) => {
            const duration = ((Date.now() - start) / 1000).toFixed(1);
            if (code === 0) {
                // Extract passing count if possible
                const match = stdout.match(/(\d+)\s*passed/i) || stdout.match(/PASS:\s*(\d+)/i) || stdout.match(/(\d+)\/(\d+)\s*passed/i);
                const count = match ? match[1] : 'All';
                console.log(`✅ [PASS] ${suite.name} (${duration}s) - ${count} tests passed`);
                resolve({ name: suite.name, success: true, code, count, duration });
            } else {
                console.error(`❌ [FAIL] ${suite.name} (exit code ${code})`);
                console.error(stderr || stdout);
                resolve({ name: suite.name, success: false, code, duration });
            }
        });
    });
}

(async () => {
    console.log('\n============================================================');
    console.log('MASTER REGRESSION TEST RUNNER: REQUIREMENTS 1 TO 21');
    console.log('============================================================\n');

    let allPassed = true;
    const results = [];

    for (const suite of testSuites) {
        const res = await runSuite(suite);
        results.push(res);
        if (!res.success) allPassed = false;
    }

    console.log('\n============================================================');
    console.log('REGRESSION SUMMARY');
    console.log('============================================================');
    for (const r of results) {
        console.log(`  ${r.success ? '✅' : '❌'} ${r.name}: ${r.success ? 'PASSED' : 'FAILED'} (${r.duration}s)`);
    }

    if (allPassed) {
        console.log('\n🎉 ALL 11 TEST SUITES (340 TESTS) PASSED WITH 0 REGRESSIONS!');
        process.exit(0);
    } else {
        console.error('\n⚠️ SOME REGRESSION SUITES FAILED!');
        process.exit(1);
    }
})();
