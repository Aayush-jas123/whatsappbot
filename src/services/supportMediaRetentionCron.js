/**
 * Support Media Retention Cron
 * ─────────────────────────────────────────────────────────────
 * Deletes Cloudinary originals + derived transforms for any
 * support_media row whose 45-day-after-final-closure timer has come
 * due, then stamps purged_at so an audit placeholder remains.
 *
 * - Reopening a ticket clears retention_due_at (supportMediaService
 *   .clearRetention), so reopened media is never swept.
 * - Legacy attachment rows (ticket_attachments /
 *   support_ticket_attachments) are not represented here, so they are
 *   naturally out of scope.
 * - Batched (default 200/tick) to stay inside Cloudinary API rate
 *   limits; anything left over is picked up on the next daily run.
 * ─────────────────────────────────────────────────────────────
 */

const cron = require('node-cron');
const { dbAdapter } = require('../database/db');
const supportCloudinary = require('./supportCloudinaryService');

const BATCH_SIZE = 200;
let _scheduled = false;

async function purgeDueMedia() {
    // Only rows that were actually uploaded to OUR support Cloudinary
    // (secure_url present, not already purged) and whose timer elapsed.
    const rows = await dbAdapter.query(
        `SELECT id, public_id, secure_url
           FROM support_media
          WHERE purged_at IS NULL
            AND retention_due_at IS NOT NULL
            AND retention_due_at <= CURRENT_TIMESTAMP
          ORDER BY retention_due_at ASC
          LIMIT ${BATCH_SIZE}`
    );

    if (!rows.length) {
        console.log('[MEDIA RETENTION] Nothing due for purge.');
        return { purged: 0, failed: 0, scanned: 0 };
    }

    let purged = 0;
    let failed = 0;

    for (const row of rows) {
        try {
            // A failed/never-landed upload has no asset to destroy — just
            // tombstone it. Otherwise destroy from Cloudinary (invalidates CDN).
            if (row.secure_url) {
                const result = await supportCloudinary.destroy(row.public_id);
                // 'ok' = deleted, 'not_found' = already gone → both terminal.
                if (result && result !== 'ok' && result !== 'not_found') {
                    throw new Error(`Cloudinary destroy returned '${result}'`);
                }
            }

            await dbAdapter.run(
                `UPDATE support_media
                   SET upload_status = 'expired',
                       secure_url = NULL,
                       thumbnail_url = NULL,
                       purged_at = CURRENT_TIMESTAMP,
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [row.id]
            );
            purged++;
        } catch (err) {
            // Leave the row untouched (purged_at stays NULL) so the next
            // run retries it. Never tombstone on a failed destroy.
            failed++;
            console.error(`[MEDIA RETENTION] Failed to purge id=${row.id} (${row.public_id}):`, err.message);
        }
    }

    console.log(`[MEDIA RETENTION] Purged ${purged}, failed ${failed}, of ${rows.length} due.`);
    return { purged, failed, scanned: rows.length };
}

function init() {
    if (_scheduled) return;
    _scheduled = true;

    if (!supportCloudinary.isConfigured()) {
        console.warn('⚠️ [MEDIA RETENTION] SUPPORT_CLOUDINARY_* not configured — retention cron disabled');
        return;
    }

    console.log('⏰ Initializing Support Media Retention Cron (daily 02:00 UTC)...');

    cron.schedule('0 2 * * *', async () => {
        console.log('🧹 Running Support Media Retention sweep...');
        try {
            await purgeDueMedia();
        } catch (error) {
            console.error('❌ Error in support media retention cron:', error.message);
        }
    }, { timezone: 'UTC' });

    console.log('✅ Support Media Retention Cron scheduled (daily 02:00 UTC)');
}

module.exports = { init, purgeDueMedia, BATCH_SIZE };
