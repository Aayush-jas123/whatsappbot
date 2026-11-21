const cron = require('node-cron');
const zohoCodService = require('./zohoCodService');

/**
 * Hourly safety net for delivered COD orders → Zoho invoice payments.
 *
 * Exists because reconciliation otherwise fires exactly ONCE, from the carrier
 * webhook or the shipment-status hook, at the delivery transition. A Zoho rate
 * limit, an invoice that had not synced yet, a parcel delivered before the
 * hook existed or a restart mid-flight all left the invoice sitting unpaid
 * with nothing ever looking again — which is what reads as "COD shows unpaid
 * in many orders". The sweep walks the oldest unreconciled delivery first and
 * stops when the daily Zoho budget is spent, so the backlog drains itself.
 *
 * Runs at :20 — the shipment sync cron that fires the live hook runs at
 * :00/:30, so the two never queue Zoho calls at the same moment.
 */
class ZohoCodSweepCron {
    init() {
        console.log('⏰ Initializing Zoho COD Sweep Cron...');

        cron.schedule('20 * * * *', async () => {
            console.log('💰 Running Zoho COD sweep (delivered COD → invoice payments)...');
            try {
                const result = await zohoCodService.sweepUnreconciledCod();
                if (result.skipped) {
                    console.log(`⏭️  Zoho COD sweep skipped: ${result.skipped}`);
                    return;
                }
                const used = process.memoryUsage();
                console.log(`[MEMORY] After Zoho COD sweep - RSS: ${Math.round(used.rss / 1024 / 1024)}MB, Heap Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
            } catch (error) {
                console.error('❌ Error in Zoho COD sweep cron:', error.message);
            }
        });

        console.log('✅ Zoho COD Sweep Cron Scheduled (Every hour at :20)');
    }
}

module.exports = new ZohoCodSweepCron();
