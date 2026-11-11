const assert = require('assert');
const axios = require('axios');
const BaseCarrier = require('../src/services/carriers/baseCarrier');
const delhivery = require('../src/services/carriers/delhiveryAdapter');
const ekart = require('../src/services/carriers/ekartAdapter');
const shiprocket = require('../src/services/carriers/shiprocketAdapter');
const shopify = require('../src/services/shopifyService');
const shiprocketService = require('../src/services/shiprocketService');
const customerContext = require('../src/services/customerContextService');
process.env.ZOHO_TOKEN_CACHE_FILE = '/private/tmp/phase5-m8-zoho-token.json';
const zoho = require('../src/services/zohoService');
const { classifyError, getBreaker, resetBreakers } = require('../src/utils/circuitBreaker');

async function run() {
    process.env.CIRCUIT_BREAKER_ENABLED = 'true';
    const carrier = new BaseCarrier('delhivery', 'Delhivery');
    const normal = await carrier.withBreaker('READ', 'normal', async () => carrier.ok({ tracked: true }));
    assert.strictEqual(normal.success, true);
    const breaker = getBreaker('delhivery', 'read', 'tracking', fn => fn(), { forceEnabled: true });
    breaker.open();
    let called = false;
    const unavailable = await carrier.withBreaker('READ', 'tracking', async () => { called = true; return carrier.ok({}); });
    assert.strictEqual(called, false);
    assert.deepStrictEqual(unavailable.raw, { code: 'CARRIER_UNAVAILABLE', notAttempted: true });
    resetBreakers('delhivery');

    // Exercise the real Delhivery tracking adapter path, including its existing
    // axios timeout and the pre-dispatch circuit-breaker rejection.
    const originalGet = axios.get;
    let requests = 0;
    try {
        axios.get = async (_url, config) => {
            requests++;
            assert.strictEqual(config.timeout, 20000);
            return { data: { ShipmentData: [{ Shipment: {
                Status: { Status: 'In Transit', StatusType: 'IT' }, Scans: []
            } }] } };
        };
        const tracked = await delhivery.track('1234567890');
        assert.strictEqual(tracked.success, true);
        assert.strictEqual(requests, 1);

        getBreaker('delhivery', 'READ', 'track', request => request(), { forceEnabled: true }).open();
        const unavailableTrack = await delhivery.track('1234567890');
        assert.strictEqual(requests, 1, 'open breaker must prevent axios dispatch');
        assert.deepStrictEqual(unavailableTrack.raw, { code: 'CARRIER_UNAVAILABLE', notAttempted: true });
    } finally {
        axios.get = originalGet;
        resetBreakers('delhivery');
    }

    assert.strictEqual(classifyError({ response: { status: 400 }, message: 'invalid pincode' }).counts, false);
    assert.strictEqual(classifyError({ response: { status: 503 }, message: 'upstream unavailable' }).counts, true);

    const originalEkartRequest = ekart.request;
    let ekartRequests = 0;
    try {
        ekart.request = async config => {
            ekartRequests++;
            assert.strictEqual(config.timeout, 20000);
            return { data: { track: { status: 'Out for delivery', details: [] } } };
        };
        assert.strictEqual((await ekart.track('EK123')).success, true);
        getBreaker('ekart', 'READ', 'track', request => request(), { forceEnabled: true }).open();
        const unavailableEkart = await ekart.track('EK123');
        assert.strictEqual(ekartRequests, 1, 'open Ekart breaker must prevent adapter request');
        assert.deepStrictEqual(unavailableEkart.raw, { code: 'CARRIER_UNAVAILABLE', notAttempted: true });
    } finally {
        ekart.request = originalEkartRequest;
        resetBreakers('ekart');
    }

    let shopifyRequests = 0;
    assert.deepStrictEqual(await shopify._rateLimitedRequest(async () => {
        shopifyRequests++;
        return { data: { ok: true } };
    }, 0), { data: { ok: true } });
    getBreaker('shopify', 'MUTATE_IDEMPOTENT', 'fulfillment', request => request(), { forceEnabled: true }).open();
    await assert.rejects(
        () => shopify._rateLimitedRequest(async () => { shopifyRequests++; }, 0),
        error => error.code === 'CARRIER_UNAVAILABLE' && error.notAttempted === true
    );
    assert.strictEqual(shopifyRequests, 1, 'open Shopify breaker must prevent fulfillment request');
    resetBreakers('shopify');

    const originalPost = axios.post;
    const savedZohoEnv = {
        clientId: process.env.ZOHO_CLIENT_ID,
        clientSecret: process.env.ZOHO_CLIENT_SECRET,
        refreshToken: process.env.ZOHO_REFRESH_TOKEN
    };
    let zohoRequests = 0;
    try {
        process.env.ZOHO_CLIENT_ID = 'client';
        process.env.ZOHO_CLIENT_SECRET = 'secret';
        process.env.ZOHO_REFRESH_TOKEN = 'refresh';
        axios.post = async (_url, _body, config) => {
            zohoRequests++;
            assert.strictEqual(config.headers['Content-Type'], 'application/x-www-form-urlencoded');
            return { data: { access_token: `token-${zohoRequests}`, expires_in: 3600 } };
        };
        assert.strictEqual(await zoho.getAccessToken(true), 'token-1');
        getBreaker('zoho', 'MUTATE_UNKNOWN', 'refreshAccessToken', request => request(), { forceEnabled: true }).open();
        await assert.rejects(() => zoho.getAccessToken(true), error => error.code === 'CARRIER_UNAVAILABLE' && error.notAttempted === true);
        assert.strictEqual(zohoRequests, 1, 'open Zoho breaker must prevent token request');
    } finally {
        axios.post = originalPost;
        process.env.ZOHO_CLIENT_ID = savedZohoEnv.clientId;
        process.env.ZOHO_CLIENT_SECRET = savedZohoEnv.clientSecret;
        process.env.ZOHO_REFRESH_TOKEN = savedZohoEnv.refreshToken;
        resetBreakers('zoho');
    }

    const originalContextGet = axios.get;
    const savedReturnsUrl = process.env.RETURNS_SERVER_URL;
    let internalRequests = 0;
    try {
        process.env.RETURNS_SERVER_URL = 'https://returns.test';
        axios.get = async (_url, config) => {
            internalRequests++;
            assert.strictEqual(config.timeout, 15000);
            return { data: { success: true, requests: [] } };
        };
        assert.strictEqual((await customerContext.fetchReturnsServerPipeline(90)).connected, true);
        getBreaker('internal', 'READ', 'returnsPipeline', request => request(), { forceEnabled: true }).open();
        assert.strictEqual((await customerContext.fetchReturnsServerPipeline(90)).connected, false);
        assert.strictEqual(internalRequests, 1, 'open internal breaker must prevent returns-server request');
    } finally {
        axios.get = originalContextGet;
        if (savedReturnsUrl === undefined) delete process.env.RETURNS_SERVER_URL;
        else process.env.RETURNS_SERVER_URL = savedReturnsUrl;
        resetBreakers('internal');
    }

    const originalTracking = shiprocketService.getTrackingByAWB;
    let trackingRequests = 0;
    try {
        shiprocketService.getTrackingByAWB = async () => {
            trackingRequests++;
            return { tracking_data: { shipment_track: [{ current_status: 'In Transit' }], shipment_track_activities: [] } };
        };
        assert.strictEqual((await shiprocket.track('SR123')).success, true);
        getBreaker('shiprocket', 'READ', 'track', request => request(), { forceEnabled: true }).open();
        const unavailableShiprocket = await shiprocket.track('SR123');
        assert.strictEqual(trackingRequests, 1, 'open Shiprocket breaker must prevent tracking dispatch');
        assert.deepStrictEqual(unavailableShiprocket.raw, { code: 'CARRIER_UNAVAILABLE', notAttempted: true });
    } finally {
        shiprocketService.getTrackingByAWB = originalTracking;
        resetBreakers('shiprocket');
    }

    const originalShiprocketPost = axios.post;
    const originalShiprocketAuth = shiprocket.authHeaders;
    let shiprocketPosts = 0;
    try {
        shiprocket.authHeaders = async () => ({ Authorization: 'Bearer test' });
        axios.post = async (url, body, config) => {
            shiprocketPosts++;
            assert.strictEqual(config.timeout, 30000);
            if (url.endsWith('/courier/generate/label')) {
                assert.deepStrictEqual(body, { shipment_id: [42] });
                return { data: { label_url: 'https://labels.test/42.pdf' } };
            }
            assert.deepStrictEqual(body, { shipment_id: [42] });
            return { data: { pickup_status: 1, response: { pickup_token_number: 'P1' } } };
        };
        assert.strictEqual((await shiprocket.generateLabel({ carrier_shipment_id: 42 })).success, true);
        assert.strictEqual((await shiprocket.schedulePickup({ carrier_shipment_id: 42 })).success, true);
        getBreaker('shiprocket', 'MUTATE_UNKNOWN', 'schedulePickup', request => request(), { forceEnabled: true }).open();
        const unavailablePickup = await shiprocket.schedulePickup({ carrier_shipment_id: 42 });
        assert.strictEqual(shiprocketPosts, 2, 'open Shiprocket mutation breaker must prevent axios dispatch');
        assert.deepStrictEqual(unavailablePickup.raw, { code: 'CARRIER_UNAVAILABLE', notAttempted: true });
    } finally {
        axios.post = originalShiprocketPost;
        shiprocket.authHeaders = originalShiprocketAuth;
        resetBreakers('shiprocket');
    }
    console.log('PASS M8 base, Delhivery, Ekart, Shopify, Zoho, internal, and Shiprocket breaker integration');
}
run().then(
    () => process.exit(0),
    error => { console.error('FAIL M8:', error); process.exit(1); }
);
