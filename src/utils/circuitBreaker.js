/**
 * circuitBreaker.js — Opossum Circuit Breaker wrapper with per-service configuration,
 * failure classification, safe fallback, and pass-through kill-switch.
 *
 * Implements Phase 5 M2 requirements according to 01-circuit-breakers.md.
 */

const CircuitBreaker = require('opossum');
const { logger } = require('./logger');

class BreakerOpenError extends Error {
    constructor(service, remainingHalfOpenMs = 30000) {
        super(`Service ${service} is temporarily unavailable (circuit breaker open)`);
        this.name = 'BreakerOpenError';
        this.service = service;
        this.code = 'CARRIER_UNAVAILABLE';
        this.retryAfter = remainingHalfOpenMs;
        this.notAttempted = true; // Safety flag: request never reached the carrier
    }
}

function isBreakerOpen(err) {
    if (!err) return false;
    return err.name === 'BreakerOpenError' || err.code === 'CARRIER_UNAVAILABLE' || err.notAttempted === true;
}

/**
 * Check if an error message indicates an unserviceable location
 * Reuses the heuristic matching isUnserviceableError in server.js
 */
function isUnserviceableMsg(message) {
    if (!message) return false;
    const lower = String(message).toLowerCase();
    return lower.includes('unserviceable') ||
           lower.includes('not serviceable') ||
           lower.includes('serviceability') ||
           lower.includes('pincode not serviceable');
}

/**
 * Classify error: returns { counts: boolean, reason: string }
 *
 * Counts as failure:
 * - network: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, socket hang up, AbortError/timeout
 * - opossum TimeoutError
 * - HTTP 5xx
 * - HTTP 429
 * - HTTP 401/403 only when mid-session on previously healthy service (err.upstreamBreakage)
 *
 * Ignored (counts: false, errorFilter returns true):
 * - HTTP 400 / 422 validation rejections
 * - unserviceable pincodes/areas
 * - business rejections in 200 body (insufficient balance)
 * - ApplicationError for order not found
 */
function classifyError(err) {
    if (!err) return { counts: false, reason: 'no-error' };
    if (isBreakerOpen(err)) return { counts: false, reason: 'breaker-open' };

    const name = String(err.name || '');
    const code = String(err.code || '');
    const msg = String(err.message || '').toLowerCase();
    const status = Number(err.status || err.statusCode || err.response?.status || 0);

    // Ignored errors (never open breaker)
    if (status === 400 || status === 422) {
        return { counts: false, reason: 'validation-4xx' };
    }
    if (isUnserviceableMsg(msg)) {
        return { counts: false, reason: 'unserviceable' };
    }
    if (msg.includes('insufficient balance') || msg.includes('insufficient wallet')) {
        return { counts: false, reason: 'business-rejection-balance' };
    }
    if (name === 'ApplicationError' || msg.includes('order not found') || msg.includes('not found in database')) {
        return { counts: false, reason: 'application-not-found' };
    }

    // Failures (count towards tripping)
    if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' ||
        msg.includes('socket hang up') || msg.includes('timed out') || msg.includes('abort')) {
        return { counts: true, reason: 'network-timeout' };
    }
    if (status >= 500 || msg.includes('api error: 5') || msg.includes('status 50')) {
        return { counts: true, reason: status ? `http-${status}` : 'http-5xx' };
    }
    if (status === 429 || msg.includes('429') || msg.includes('rate limit')) {
        return { counts: true, reason: 'rate-limit-429' };
    }
    if (status === 401 || status === 403) {
        if (err.upstreamBreakage) {
            return { counts: true, reason: `upstream-auth-${status}` };
        }
        return { counts: false, reason: `auth-${status}` };
    }

    return { counts: false, reason: 'unclassified' };
}

/**
 * Filter function for Opossum: return true to IGNORE error, false to COUNT error
 */
function errorFilter(err) {
    const classification = classifyError(err);
    return !classification.counts;
}

// ── Service Configuration Profiles (§6) ──────────────────────────────────────
const SERVICE_PROFILES = {
    'shopify:read': {
        timeout: 20000,
        errorThresholdPercentage: 50,
        volumeThreshold: 10,
        rollingCountTimeout: 60000,
        resetTimeout: 30000,
        maxConcurrency: 2,
        enableRetry: true,
        maxRetries: 2
    },
    'shopify:mutate_idempotent': {
        timeout: 25000,
        errorThresholdPercentage: 50,
        volumeThreshold: 5,
        rollingCountTimeout: 60000,
        resetTimeout: 30000,
        maxConcurrency: 2,
        enableRetry: true,
        maxRetries: 1
    },
    'delhivery:read': {
        timeout: 20000,
        errorThresholdPercentage: 50,
        volumeThreshold: 8,
        rollingCountTimeout: 60000,
        resetTimeout: 30000,
        maxConcurrency: 3,
        enableRetry: true,
        maxRetries: 2
    },
    'delhivery:mutate_unknown': {
        timeout: 30000,
        errorThresholdPercentage: 60,
        volumeThreshold: 5,
        rollingCountTimeout: 60000,
        resetTimeout: 45000,
        maxConcurrency: 2,
        enableRetry: false,
        maxRetries: 0
    },
    'ekart:read': {
        timeout: 20000,
        errorThresholdPercentage: 50,
        volumeThreshold: 8,
        rollingCountTimeout: 60000,
        resetTimeout: 30000,
        maxConcurrency: 3,
        enableRetry: true,
        maxRetries: 2
    },
    'ekart:mutate_unknown': {
        timeout: 30000,
        errorThresholdPercentage: 60,
        volumeThreshold: 5,
        rollingCountTimeout: 60000,
        resetTimeout: 45000,
        maxConcurrency: 2,
        enableRetry: false,
        maxRetries: 0
    },
    'shiprocket:read': {
        timeout: 25000,
        errorThresholdPercentage: 50,
        volumeThreshold: 8,
        rollingCountTimeout: 60000,
        resetTimeout: 45000,
        maxConcurrency: 2,
        enableRetry: true,
        maxRetries: 2
    },
    'shiprocket:mutate_unknown': {
        timeout: 35000,
        errorThresholdPercentage: 60,
        volumeThreshold: 5,
        rollingCountTimeout: 60000,
        resetTimeout: 60000,
        maxConcurrency: 1,
        enableRetry: false,
        maxRetries: 0
    },
    'zoho:mutate_unknown': {
        timeout: 30000,
        errorThresholdPercentage: 50,
        volumeThreshold: 5,
        rollingCountTimeout: 90000,
        resetTimeout: 60000,
        maxConcurrency: 1,
        enableRetry: false,
        maxRetries: 0
    },
    'internal:read': {
        timeout: 10000,
        errorThresholdPercentage: 50,
        volumeThreshold: 10,
        rollingCountTimeout: 60000,
        resetTimeout: 20000,
        maxConcurrency: 5,
        enableRetry: true,
        maxRetries: 1
    }
};

function resolveConfig(service, mutationClass, overrides = {}) {
    const key = `${service.toLowerCase()}:${mutationClass.toLowerCase()}`;
    const base = SERVICE_PROFILES[key] || {
        timeout: 25000,
        errorThresholdPercentage: 50,
        volumeThreshold: 5,
        rollingCountTimeout: 60000,
        resetTimeout: 30000,
        maxConcurrency: 2,
        enableRetry: mutationClass.toLowerCase() === 'read',
        maxRetries: mutationClass.toLowerCase() === 'read' ? 2 : 0
    };

    const sEnv = service.toUpperCase();
    const cEnv = mutationClass.toUpperCase();

    const envTimeout = process.env[`CB_${sEnv}_${cEnv}_TIMEOUT_MS`];
    const envThreshold = process.env[`CB_${sEnv}_${cEnv}_ERROR_THRESHOLD`];
    const envVolume = process.env[`CB_${sEnv}_${cEnv}_VOLUME_THRESHOLD`];
    const envReset = process.env[`CB_${sEnv}_${cEnv}_RESET_TIMEOUT_MS`];

    return {
        ...base,
        timeout: envTimeout ? parseInt(envTimeout, 10) : base.timeout,
        errorThresholdPercentage: envThreshold ? parseInt(envThreshold, 10) : base.errorThresholdPercentage,
        volumeThreshold: envVolume ? parseInt(envVolume, 10) : base.volumeThreshold,
        resetTimeout: envReset ? parseInt(envReset, 10) : base.resetTimeout,
        ...overrides
    };
}

// ── Registry Keyed by service:class ──────────────────────────────────────────
const breakerRegistry = new Map();

function isCircuitBreakerEnabled() {
    return String(process.env.CIRCUIT_BREAKER_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Returns a circuit breaker (or pass-through if disabled) for service:class
 */
function getBreaker(service, mutationClass, actionName, fn, opts = {}) {
    const s = String(service).toLowerCase();
    const c = String(mutationClass).toLowerCase();
    const registryKey = `${s}:${c}`;

    // Pass-through when circuit breakers disabled
    if (!isCircuitBreakerEnabled() && !opts.forceEnabled) {
        return {
            fire: async (...args) => fn(...args),
            opened: false,
            closed: true,
            halfOpen: false,
            stats: {}
        };
    }

    if (breakerRegistry.has(registryKey)) {
        return breakerRegistry.get(registryKey);
    }

    const cfg = resolveConfig(s, c, opts);

    const opossumOpts = {
        timeout: cfg.timeout,
        errorThresholdPercentage: cfg.errorThresholdPercentage,
        volumeThreshold: cfg.volumeThreshold,
        rollingCountTimeout: cfg.rollingCountTimeout,
        resetTimeout: cfg.resetTimeout,
        capacity: cfg.maxConcurrency,
        errorFilter: errorFilter
    };

    const breaker = new CircuitBreaker(fn, opossumOpts);

    breaker.lastOpened = null;

    const fire = breaker.fire.bind(breaker);
    breaker.fire = async (...args) => {
        try {
            return await fire(...args);
        } catch (err) {
            // EOPENBREAKER is emitted before the action is dispatched. Keep
            // ordinary upstream errors intact for adapter-specific handling.
            if (err && err.code === 'EOPENBREAKER') {
                const elapsedMs = breaker.lastOpened ? Date.now() - breaker.lastOpened : 0;
                throw new BreakerOpenError(s, Math.max(0, cfg.resetTimeout - elapsedMs));
            }
            throw err;
        }
    };

    const logTransitions = String(process.env.CB_LOG_TRANSITIONS || 'true').toLowerCase() !== 'false';

    breaker.on('open', () => {
        breaker.lastOpened = Date.now();
        if (logTransitions) {
            logger.warn(`[CircuitBreaker] Opened for ${registryKey}`, {
                service: s,
                mutationClass: c,
                stats: breaker.stats
            });
        }
    });

    breaker.on('halfOpen', () => {
        if (logTransitions) {
            logger.info(`[CircuitBreaker] Half-open probe for ${registryKey}`, {
                service: s,
                mutationClass: c
            });
        }
    });

    breaker.on('close', () => {
        breaker.lastOpened = null;
        if (logTransitions) {
            logger.info(`[CircuitBreaker] Closed (recovered) for ${registryKey}`, {
                service: s,
                mutationClass: c,
                stats: breaker.stats
            });
        }
    });

    breakerRegistry.set(registryKey, breaker);
    return breaker;
}

function breakerStatus() {
    const status = {};
    for (const [key, breaker] of breakerRegistry.entries()) {
        const stats = breaker.stats || {};
        const isOpened = breaker.opened;
        const isHalfOpen = breaker.halfOpen;
        const resetTimeout = (breaker.options && breaker.options.resetTimeout) || 30000;

        status[key] = {
            state: isOpened ? 'open' : isHalfOpen ? 'halfOpen' : 'closed',
            rollingCounts: {
                failures: stats.failures || 0,
                successes: stats.successes || 0,
                timeouts: stats.timeouts || 0,
                rejects: stats.rejects || 0
            },
            openUntil: isOpened && breaker.lastOpened
                ? new Date(breaker.lastOpened + resetTimeout).toISOString()
                : null
        };
    }
    return status;
}

function resetBreakers(service) {
    for (const [key, breaker] of breakerRegistry.entries()) {
        if (!service || key.startsWith(String(service).toLowerCase())) {
            breaker.close();
            breaker.lastOpened = null;
        }
    }
}

function wrapAll(fn, opts = {}) {
    return fn;
}

module.exports = {
    getBreaker,
    classifyError,
    isBreakerOpen,
    breakerStatus,
    resetBreakers,
    wrapAll,
    BreakerOpenError,
    isCircuitBreakerEnabled,
    resolveConfig,
    SERVICE_PROFILES
};
