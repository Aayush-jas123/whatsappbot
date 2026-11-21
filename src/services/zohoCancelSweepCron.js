const cron = require('node-cron');
const zohoCancelService = require('./zohoCancelService');

/**
 * Hourly safety net for Shopify cancellations → Zoho invoice voids.
 *
 * Exists because Shopify's orders/cancelled webhook is not subscribed to
 * /webhooks/zoho/orders/cancelled, so the webhook handler alone voids nothing.
 * Hourly (not every 30 min) because each tick re-runs the Shopify discovery
 * list call; the Zoho daily budget, not the tick rate, is what paces the
 * backlog drain.
 */
class ZohoCancelSweepCron {
    init() {
        console.log('⏰ Initializing Zoho Cancel Sweep Cron...');

        cron.schedule('0 * * * *', async () => {
            console.log('🧾 Running Zoho cancel sweep (cancelled orders → invoice voids)...');
            try {
                const result = await zohoCancelService.sweepCancelledInvoices();
                if (result.skipped) {
                    console.log(`⏭️  Zoho cancel sweep skipped: ${result.skipped}`);
                    return;
                }
                const used = process.memoryUsage();
                console.log(`[MEMORY] After Zoho cancel sweep - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
            } catch (error) {
                console.error('❌ Error in Zoho cancel sweep cron:', error.message);
            }
        });

        console.log('✅ Zoho Cancel Sweep Cron Scheduled (Every hour)');
    }
}

module.exports = new ZohoCancelSweepCron();
