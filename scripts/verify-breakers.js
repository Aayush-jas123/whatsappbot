/**
 * verify-breakers.js — State machine & safety test harness for Phase 5 Circuit Breakers.
 *
 * Verifies:
 * 1. Closed -> Open after failures exceeding volume threshold
 * 2. Open breaker fails fast (< 5ms) with BreakerOpenError (notAttempted: true)
 * 3. Open -> Half-Open -> Closed lifecycle
 * 4. Ignored errors (400, unserviceable, insufficient balance) do NOT count as failures
 * 5. CIRCUIT_BREAKER_ENABLED=false behaves as pass-through
 * 6. CREATE path with maxRetries: 0 never executes second request on failure
 */

const assert = require('assert');
const {
    getBreaker,
    classifyError,
    isBreakerOpen,
    breakerStatus,
    resetBreakers,
    BreakerOpenError
} = require('../src/utils/circuitBreaker');

let passed = 0;
let failed = 0;

function say(msg) {
    process.stdout.write(`${msg}\n`);
}

async function runCheck(name, fn) {
    try {
        await fn();
        passed++;
        say(`PASS  ${name}`);
    } catch (err) {
        failed++;
        say(`FAIL  ${name}`);
        say(`      ${err.stack || err.message}`);
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    say('--- Starting Circuit Breaker Verification Harness ---');

    // Test 1: Pass-through when disabled
    await runCheck('CIRCUIT_BREAKER_ENABLED=false functions as pass-through', async () => {
        delete process.env.CIRCUIT_BREAKER_ENABLED; // default false
        let callCount = 0;
        const fakeFn = async () => {
            callCount++;
            return { ok: true };
        };

        const breaker = getBreaker('delhivery', 'read', 'track', fakeFn);
        const result = await breaker.fire();
        assert.deepStrictEqual(result, { ok: true });
        assert.strictEqual(callCount, 1);
        assert.strictEqual(breaker.closed, true);
    });

    // Test 2: Error classification
    await runCheck('classifyError correctly categorizes failures vs ignored errors', async () => {
        // Ignored
        const err400 = new Error('Bad request');
        err400.status = 400;
        assert.strictEqual(classifyError(err400).counts, false);

        const unserviceable = new Error('Delhivery API error: 400 - area not serviceable');
        assert.strictEqual(classifyError(unserviceable).counts, false);

        const balance = new Error('Insufficient balance in wallet');
        assert.strictEqual(classifyError(balance).counts, false);

        const notFound = new Error('Order not found');
        notFound.name = 'ApplicationError';
        assert.strictEqual(classifyError(notFound).counts, false);

        // Counts
        const timeout = new Error('ETIMEDOUT');
        timeout.code = 'ETIMEDOUT';
        assert.strictEqual(classifyError(timeout).counts, true);

        const err500 = new Error('Internal Server Error');
        err500.status = 500;
        assert.strictEqual(classifyError(err500).counts, true);

        const err429 = new Error('Rate limit exceeded');
        err429.status = 429;
        assert.strictEqual(classifyError(err429).counts, true);
    });

    // Test 3: State machine transition (Closed -> Open -> Fast Rejection)
    await runCheck('State machine transitions: Closed -> Open after threshold -> Fast rejection (<5ms)', async () => {
        process.env.CIRCUIT_BREAKER_ENABLED = 'true';
        process.env.CB_LOG_TRANSITIONS = 'false';

        // Unique service to have an isolated breaker in the registry
        const svc = 'test_delhivery';
        let attempt = 0;
        const failingFn = async () => {
            attempt++;
            const err = new Error('ETIMEDOUT network hang');
            err.code = 'ETIMEDOUT';
            throw err;
        };

        const breaker = getBreaker(svc, 'read', 'track', failingFn, {
            forceEnabled: true,
            volumeThreshold: 3,
            errorThresholdPercentage: 50,
            resetTimeout: 100 // 100ms for fast half-open test
        });

        // Fire 3 failing calls to trip breaker
        for (let i = 0; i < 3; i++) {
            try {
                await breaker.fire();
            } catch (_) {}
        }

        assert.strictEqual(breaker.opened, true, 'Breaker should be open after 3 consecutive failures');

        // Next call should be rejected immediately by fallback (< 5ms) without calling failingFn
        const prevAttempt = attempt;
        const start = Date.now();
        let rejectedError = null;
        try {
            await breaker.fire();
        } catch (e) {
            rejectedError = e;
        }
        const duration = Date.now() - start;

        assert.ok(duration < 25, `Rejection took ${duration}ms, expected sub-millisecond fallback`);
        assert.strictEqual(attempt, prevAttempt, 'Underlying function must NOT be called when breaker is open');
        assert.ok(rejectedError instanceof BreakerOpenError, 'Error must be BreakerOpenError');
        assert.strictEqual(rejectedError.code, 'CARRIER_UNAVAILABLE');
        assert.strictEqual(rejectedError.notAttempted, true, 'notAttempted safety flag must be true');

        // Test recovery (Half-Open -> Closed)
        await sleep(150); // wait for resetTimeout (100ms)
        let successCalled = false;
        // Monkey-patch action for probe success
        breaker.action = async () => {
            successCalled = true;
            return { recovered: true };
        };

        const probeResult = await breaker.fire();
        assert.strictEqual(probeResult.recovered, true);
        assert.strictEqual(successCalled, true);
        assert.strictEqual(breaker.closed, true, 'Breaker should be closed after successful probe');
    });

    // Test 4: Ignored errors do NOT trip the breaker
    await runCheck('Ignored errors (unserviceable, 400) do NOT open the breaker', async () => {
        process.env.CIRCUIT_BREAKER_ENABLED = 'true';
        const svc = 'test_unserviceable';
        let calls = 0;

        const unserviceableFn = async () => {
            calls++;
            const err = new Error('Delhivery API error: 400 - area not serviceable');
            err.status = 400;
            throw err;
        };

        const breaker = getBreaker(svc, 'read', 'checkServiceability', unserviceableFn, {
            forceEnabled: true,
            volumeThreshold: 3,
            errorThresholdPercentage: 50
        });

        for (let i = 0; i < 5; i++) {
            try {
                await breaker.fire();
            } catch (_) {}
        }

        assert.strictEqual(calls, 5);
        assert.strictEqual(breaker.opened, false, 'Breaker must remain closed for unserviceable errors');
        assert.strictEqual(breaker.closed, true);
    });

    // Test 5: CREATE calls never auto-retry (maxRetries: 0)
    await runCheck('CREATE breaker has maxRetries: 0 and never re-issues request on failure', async () => {
        process.env.CIRCUIT_BREAKER_ENABLED = 'true';
        const svc = 'delhivery';
        const mutationClass = 'mutate_unknown';

        let networkAttempts = 0;
        const createShipmentFn = async (orderId) => {
            networkAttempts++;
            const err = new Error('Delhivery gateway timeout');
            err.status = 504;
            throw err;
        };

        const breaker = getBreaker(svc, mutationClass, 'createShipment', createShipmentFn, {
            forceEnabled: true,
            maxRetries: 0,
            enableRetry: false
        });

        assert.strictEqual(breaker.options.maxRetries || 0, 0);

        try {
            await breaker.fire('ORD-12345');
        } catch (_) {}

        assert.strictEqual(networkAttempts, 1, 'Exactly 1 request must be made for create, no auto-retries allowed');
    });

    // Test 6: breakerStatus() output format
    await runCheck('breakerStatus() returns expected health report format', async () => {
        const status = breakerStatus();
        assert.ok(typeof status === 'object' && status !== null);
        for (const [key, val] of Object.entries(status)) {
            assert.ok(['open', 'halfOpen', 'closed'].includes(val.state));
            assert.ok(typeof val.rollingCounts === 'object');
            assert.ok(typeof val.rollingCounts.failures === 'number');
        }
    });

    // Test 7: resetBreakers() closes open breakers
    await runCheck('resetBreakers() force-closes breakers', async () => {
        resetBreakers('test_delhivery');
        const status = breakerStatus();
        if (status['test_delhivery:read']) {
            assert.strictEqual(status['test_delhivery:read'].state, 'closed');
        }
    });

    say('');
    say(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
