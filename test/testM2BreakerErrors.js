const assert = require('assert');
const { getBreaker, isBreakerOpen, resetBreakers } = require('../src/utils/circuitBreaker');

async function run() {
    process.env.CIRCUIT_BREAKER_ENABLED = 'true';
    const upstream = Object.assign(new Error('carrier rate limited'), { status: 429, response: { status: 429 } });
    const breaker = getBreaker('m2-regression', 'read', 'upstream', fn => fn(), { forceEnabled: true, volumeThreshold: 10 });
    await assert.rejects(() => breaker.fire(async () => { throw upstream; }), error => error === upstream);

    breaker.open();
    let dispatched = false;
    await assert.rejects(() => breaker.fire(async () => { dispatched = true; }), error => isBreakerOpen(error) && error.notAttempted === true);
    assert.strictEqual(dispatched, false);
    resetBreakers('m2-regression');
    console.log('PASS M2 preserves upstream errors and marks only open-breaker rejections notAttempted');
}
run().catch(error => { console.error('FAIL M2:', error); process.exitCode = 1; });
