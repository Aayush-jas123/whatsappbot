/**
 * testPhase5Logger.js — Focused unit test for Phase 5 M0 Breaker Logger Shim.
 *
 * Verifies:
 * 1. logger exports { info, warn, error, debug }
 * 2. Exactly one JSON line per call written to stdout
 * 3. Reserved fields (ts, level, msg) cannot be overwritten by caller fields
 * 4. msg is guaranteed to always be a string
 * 5. Cycle detection correctly catches true circular references while permitting
 *    repeated / DAG object references without false positives
 * 6. BigInt values safely serialize to string
 * 7. Error instances safely serialize with name, message, stack, and custom properties
 * 8. Unusual objects (null prototype, exotic properties) do not crash
 * 9. LOG_LEVEL filtering respects debug | info | warn | error, defaulting to info
 * 10. Proxy whose ownKeys operation throws is safely caught and handled
 * 11. Object with throwing getter safely marks property as [Unserializable]
 */

const assert = require('assert');
const { logger } = require('../src/utils/logger');

let passed = 0;
let failed = 0;

function say(msg) {
    process.stdout.write(`${msg}\n`);
}

function captureStdout(fn) {
    const lines = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk, encoding, cb) => {
        lines.push(chunk.toString());
        if (typeof cb === 'function') cb();
        return true;
    };
    try {
        fn();
    } finally {
        process.stdout.write = origWrite;
    }
    return lines;
}

function runTest(name, fn) {
    const savedLevel = process.env.LOG_LEVEL;
    try {
        fn();
        passed++;
        say(`PASS  ${name}`);
    } catch (err) {
        failed++;
        say(`FAIL  ${name}`);
        say(`      ${err.stack || err.message}`);
    } finally {
        if (savedLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = savedLevel;
    }
}

// 1. Export check
runTest('logger exports debug, info, warn, error functions', () => {
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info, 'function');
    assert.strictEqual(typeof logger.warn, 'function');
    assert.strictEqual(typeof logger.error, 'function');
});

// 2. Exactly one JSON line per call
runTest('logger writes exactly one valid JSON line to stdout', () => {
    delete process.env.LOG_LEVEL;
    const lines = captureStdout(() => {
        logger.info('circuit breaker test event', { service: 'delhivery' });
    });
    assert.strictEqual(lines.length, 1, `Expected 1 line, got ${lines.length}`);
    assert.ok(lines[0].endsWith('\n'), 'Line must terminate with newline');
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.msg, 'circuit breaker test event');
    assert.strictEqual(parsed.service, 'delhivery');
    assert.ok(typeof parsed.ts === 'string' && !isNaN(Date.parse(parsed.ts)));
});

// 3. Reserved fields protection
runTest('reserved properties (ts, level, msg) cannot be overwritten by additional fields', () => {
    delete process.env.LOG_LEVEL;
    const lines = captureStdout(() => {
        logger.warn('actual message', {
            ts: 'fake-ts',
            level: 'fake-level',
            msg: 'fake-msg',
            allowed: 'preserved'
        });
    });
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.level, 'warn');
    assert.strictEqual(parsed.msg, 'actual message');
    assert.notStrictEqual(parsed.ts, 'fake-ts');
    assert.strictEqual(parsed.field_ts, 'fake-ts');
    assert.strictEqual(parsed.field_level, 'fake-level');
    assert.strictEqual(parsed.field_msg, 'fake-msg');
    assert.strictEqual(parsed.allowed, 'preserved');
});

// 4. Guaranteed string msg
runTest('msg is guaranteed to be a string even if non-string types are passed', () => {
    delete process.env.LOG_LEVEL;
    const testCases = [
        { input: 12345, expected: '12345' },
        { input: null, expected: '' },
        { input: undefined, expected: '' },
        { input: new Error('boom error'), expected: 'boom error' },
        { input: { toString: () => 'custom-obj' }, expected: 'custom-obj' }
    ];

    for (const { input, expected } of testCases) {
        const lines = captureStdout(() => {
            logger.info(input);
        });
        const parsed = JSON.parse(lines[0].trim());
        assert.strictEqual(typeof parsed.msg, 'string');
        assert.strictEqual(parsed.msg, expected);
    }
});

// 5. Circular references & DAG references
runTest('circular references are caught, while repeated (DAG) references are preserved', () => {
    delete process.env.LOG_LEVEL;
    // Shared object referenced multiple times in different properties (NOT circular)
    const shared = { name: 'shared-data', value: 42 };
    const dagPayload = { first: shared, second: shared };

    const lines1 = captureStdout(() => {
        logger.info('dag test', { data: dagPayload });
    });
    const parsed1 = JSON.parse(lines1[0].trim());
    assert.deepStrictEqual(parsed1.data.first, { name: 'shared-data', value: 42 });
    assert.deepStrictEqual(parsed1.data.second, { name: 'shared-data', value: 42 });
    assert.notStrictEqual(parsed1.data.second, '[Circular]');

    // True circular reference
    const circular = { id: 1 };
    circular.self = circular;

    const lines2 = captureStdout(() => {
        logger.error('circular test', { node: circular });
    });
    const parsed2 = JSON.parse(lines2[0].trim());
    assert.strictEqual(parsed2.node.id, 1);
    assert.strictEqual(parsed2.node.self, '[Circular]');
});

// 6. BigInt serialization
runTest('BigInt values safely serialize to string without throwing', () => {
    delete process.env.LOG_LEVEL;
    const lines = captureStdout(() => {
        logger.info('bigint test', {
            orderId: 9007199254740993n,
            nested: { big: 12345678901234567890n }
        });
    });
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.orderId, '9007199254740993');
    assert.strictEqual(parsed.nested.big, '12345678901234567890');
});

// 7. Error serialization with custom properties
runTest('Error instances safely serialize name, message, stack, and custom properties', () => {
    delete process.env.LOG_LEVEL;
    const err = new Error('Carrier timeout');
    err.status = 504;
    err.service = 'delhivery';
    err.retryable = true;

    const lines = captureStdout(() => {
        logger.error('Outbound call failed', { error: err });
    });
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.error.name, 'Error');
    assert.strictEqual(parsed.error.message, 'Carrier timeout');
    assert.ok(typeof parsed.error.stack === 'string');
    assert.strictEqual(parsed.error.status, 504);
    assert.strictEqual(parsed.error.service, 'delhivery');
    assert.strictEqual(parsed.error.retryable, true);
});

// 8. Unusual objects (null prototype)
runTest('unusual objects with null prototype serialize safely', () => {
    delete process.env.LOG_LEVEL;
    const nullProto = Object.create(null);
    nullProto.key = 'value';
    nullProto.num = 100;

    const lines = captureStdout(() => {
        logger.info('null proto test', { meta: nullProto });
    });
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.meta.key, 'value');
    assert.strictEqual(parsed.meta.num, 100);
});

// 9. LOG_LEVEL filtering and default behavior
runTest('LOG_LEVEL filtering respects debug | info | warn | error and defaults to info', () => {
    // Default info: debug is dropped, info/warn/error pass
    delete process.env.LOG_LEVEL;
    let lines = captureStdout(() => {
        logger.debug('debug drop');
        logger.info('info pass');
        logger.warn('warn pass');
        logger.error('error pass');
    });
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(JSON.parse(lines[0]).level, 'info');
    assert.strictEqual(JSON.parse(lines[1]).level, 'warn');
    assert.strictEqual(JSON.parse(lines[2]).level, 'error');

    // LOG_LEVEL=error: only error passes
    process.env.LOG_LEVEL = 'error';
    lines = captureStdout(() => {
        logger.debug('debug drop');
        logger.info('info drop');
        logger.warn('warn drop');
        logger.error('error pass');
    });
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).level, 'error');

    // LOG_LEVEL=debug: all 4 pass
    process.env.LOG_LEVEL = 'debug';
    lines = captureStdout(() => {
        logger.debug('debug pass');
        logger.info('info pass');
        logger.warn('warn pass');
        logger.error('error pass');
    });
    assert.strictEqual(lines.length, 4);
});

// 10. Proxy whose ownKeys throws
runTest('Proxy whose ownKeys throws is safely caught and falls back to [Unserializable]', () => {
    delete process.env.LOG_LEVEL;
    const badProxy = new Proxy({}, {
        ownKeys() {
            throw new Error('Proxy ownKeys failed');
        }
    });

    const lines = captureStdout(() => {
        logger.error('proxy failure test', badProxy);
    });
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.level, 'error');
    assert.strictEqual(parsed.msg, 'proxy failure test');
    assert.strictEqual(parsed.metadata, '[Unserializable]');
    assert.ok(typeof parsed.ts === 'string');
});

// 11. Object with a throwing getter
runTest('Object with a throwing getter safely marks that property as [Unserializable]', () => {
    delete process.env.LOG_LEVEL;
    const badGetterObj = {
        validProp: 'healthy-value',
        get explosiveProp() {
            throw new Error('Getter access exploded');
        },
        get msg() {
            throw new Error('Reserved msg getter exploded');
        }
    };

    const lines = captureStdout(() => {
        logger.warn('throwing getter test', badGetterObj);
    });
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0].trim());
    assert.strictEqual(parsed.level, 'warn');
    assert.strictEqual(parsed.msg, 'throwing getter test');
    assert.strictEqual(parsed.validProp, 'healthy-value');
    assert.strictEqual(parsed.explosiveProp, '[Unserializable]');
    assert.strictEqual(parsed.field_msg, '[Unserializable]');
    assert.ok(typeof parsed.ts === 'string');
});

say('');
say(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
