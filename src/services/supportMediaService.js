/**
 * Support Media Service
 * ─────────────────────────────────────────────────────────────
 * Central lifecycle helpers for support-ticket images backed by
 * the dedicated support Cloudinary account (supportCloudinaryService).
 *
 * Shared by supportRoutes (customer), supportDeskRoutes (agent),
 * portalRoutes (WhatsApp/Instagram), messageHandler (inbound WA
 * media) and the retention cron — so the intent → upload → finalize
 * → send → receipt → purge flow lives in exactly one place.
 * ─────────────────────────────────────────────────────────────
 */

const { dbAdapter } = require('../database/db');
const supportCloudinary = require('./supportCloudinaryService');

const MAX_BYTES = supportCloudinary.MAX_BYTES;               // 10 MB
const ALLOWED_FORMATS = supportCloudinary.SUPPORTED_FORMATS; // jpg/jpeg/png/webp/heic/heif
const MAX_PER_MESSAGE = 5;
const RETENTION_DAYS = 45;

// Terminal-ish statuses that are safe to render from the client.
const STATUS = {
    PENDING: 'pending',
    UPLOADING: 'uploading',
    UPLOADED: 'uploaded',
    SENDING: 'sending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    SEEN: 'seen',
    FAILED: 'failed',
    EXPIRED: 'expired'
};

function normalizePublicId(raw) {
    return String(raw || '').trim();
}

// ── Intent ────────────────────────────────────────────────────
/**
 * Create a support_media row in 'pending' and return the signed
 * params the browser needs to upload directly to Cloudinary.
 * @returns {Promise<{ media_id, public_id, upload_params }>}
 */
async function createIntent({ channel, ticketRef, direction, actor }) {
    const publicId = supportCloudinary.makePublicId(channel, ticketRef);
    const uploadParams = supportCloudinary.buildUploadParams(publicId);

    const row = await dbAdapter.insert('support_media', {
        public_id: publicId,
        channel: channel || 'website',
        ticket_ref: ticketRef || null,
        direction: direction || 'outgoing',
        actor: actor || null,
        upload_status: STATUS.PENDING
    });

    return {
        media_id: row.id,
        public_id: publicId,
        upload_params: uploadParams
    };
}

// ── Finalize ──────────────────────────────────────────────────
/**
 * Verify the asset landed in OUR support account (server-side truth,
 * never trusts the client URL), then persist canonical metadata.
 * @returns {Promise<object>} the updated support_media row
 */
async function finalize({ mediaId }) {
    const existing = await getById(mediaId);
    if (!existing) {
        throw Object.assign(new Error('Media not found'), { code: 'NOT_FOUND' });
    }

    // Pull authoritative metadata from Cloudinary. If the object isn't
    // there (upload never completed / wrong account), this throws.
    let meta;
    try {
        meta = await supportCloudinary.finalize(existing.public_id);
    } catch (err) {
        await markFailed(mediaId, 'Cloudinary asset not found');
        throw Object.assign(new Error('Upload not verified with Cloudinary'), { code: 'NOT_UPLOADED' });
    }

    if (!supportCloudinary.isOwnSecureUrl(meta.secure_url)) {
        await markFailed(mediaId, 'Secure URL host mismatch');
        throw Object.assign(new Error('Invalid asset host'), { code: 'HOST_MISMATCH' });
    }
    if (meta.bytes && meta.bytes > MAX_BYTES) {
        await markFailed(mediaId, `File exceeds ${MAX_BYTES} bytes`);
        throw Object.assign(new Error('File too large'), { code: 'TOO_LARGE' });
    }
    if (meta.format && !ALLOWED_FORMATS.has(String(meta.format).toLowerCase())) {
        await markFailed(mediaId, `Unsupported format: ${meta.format}`);
        throw Object.assign(new Error('Unsupported format'), { code: 'BAD_FORMAT' });
    }

    await dbAdapter.run(
        `UPDATE support_media
           SET secure_url = ?, thumbnail_url = ?, width = ?, height = ?,
               file_size = ?, mime_type = ?, upload_status = ?, error_text = NULL,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            meta.secure_url,
            meta.thumbnail_url,
            meta.width,
            meta.height,
            meta.bytes,
            `image/${String(meta.format || 'jpeg').toLowerCase()}`,
            STATUS.UPLOADED,
            mediaId
        ]
    );

    return getById(mediaId);
}

// ── Retry ─────────────────────────────────────────────────────
/**
 * Re-issue signed params for a failed/pending upload.
 * @returns {Promise<{ public_id, upload_params }>}
 */
async function retry({ mediaId }) {
    const row = await getById(mediaId);
    if (!row) {
        throw Object.assign(new Error('Media not found'), { code: 'NOT_FOUND' });
    }
    if (row.upload_status !== STATUS.FAILED && row.upload_status !== STATUS.PENDING) {
        throw Object.assign(new Error('Nothing to retry'), { code: 'BAD_STATE' });
    }
    const uploadParams = supportCloudinary.buildUploadParams(row.public_id);
    await dbAdapter.run(
        `UPDATE support_media SET upload_status = ?, error_text = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [STATUS.PENDING, mediaId]
    );
    return { public_id: row.public_id, upload_params: uploadParams };
}

// ── Marking ───────────────────────────────────────────────────
async function markFailed(mediaId, errorText) {
    await dbAdapter.run(
        `UPDATE support_media SET upload_status = ?, error_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [STATUS.FAILED, String(errorText || 'failed').slice(0, 500), mediaId]
    );
}

async function setStatus(mediaId, status) {
    await dbAdapter.run(
        `UPDATE support_media SET upload_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, mediaId]
    );
}

/**
 * Attach finalized media to a just-sent thread message: flips each
 * to 'sent' and records its position in the ticket thread.
 */
async function attachToMessage(mediaIds, { threadEntryIdx, status = STATUS.SENT } = {}) {
    const ids = (mediaIds || []).map(Number).filter(Boolean);
    for (const id of ids) {
        await dbAdapter.run(
            `UPDATE support_media
               SET upload_status = ?, thread_entry_idx = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND upload_status IN ('uploaded','pending','sending','failed')`,
            [status, threadEntryIdx != null ? threadEntryIdx : null, id]
        );
    }
    return ids;
}

/**
 * Bind media that was uploaded before the ticket existed (raise form)
 * to the newly created ticket and mark it sent. Also used when an agent
 * replies with media so ticket_ref is guaranteed to be set.
 */
async function attachToTicket(mediaIds, { ticketRef, threadEntryIdx, status = STATUS.SENT } = {}) {
    const ids = (mediaIds || []).map(Number).filter(Boolean);
    for (const id of ids) {
        await dbAdapter.run(
            `UPDATE support_media
               SET ticket_ref = ?, upload_status = ?, thread_entry_idx = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [ticketRef || null, status, threadEntryIdx != null ? threadEntryIdx : null, id]
        );
    }
    return ids;
}

/**
 * Record the provider (WhatsApp) message id and flip to 'sending' so
 * the async webhook can resolve the final delivery status by wa_message_id.
 */
async function recordWaMessageId(mediaId, waMessageId) {
    await dbAdapter.run(
        `UPDATE support_media
           SET wa_message_id = ?, upload_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [waMessageId || null, STATUS.SENT, mediaId]
    );
}

/**
 * WhatsApp status webhook calls this to advance media from sent →
 * delivered → read / failed. Only ever moves forward (monotonic) so a
 * late 'sent' callback can't downgrade a 'delivered'.
 */
const DELIVERY_RANK = { failed: 0, sent: 1, delivered: 2, read: 3 };
async function applyDeliveryStatus(waMessageId, status) {
    if (!waMessageId) return;
    const rows = await dbAdapter.query(
        'SELECT id, upload_status, delivery_status FROM support_media WHERE wa_message_id = ? LIMIT 1',
        [waMessageId]
    );
    if (!rows.length) return;
    const row = rows[0];

    const currentRank = DELIVERY_RANK[row.delivery_status] ?? -1;
    const nextRank = DELIVERY_RANK[status] ?? -1;

    if (nextRank === -1) return; // unknown status token
    if (nextRank < currentRank) return; // never move backwards

    await dbAdapter.run(
        `UPDATE support_media
           SET delivery_status = ?, upload_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, status, row.id]
    );
}

/**
 * Website 'seen' receipts: when the recipient opens a ticket, promote
 * the sender's media from 'sent' to 'seen'.
 * @param {string} ticketRef
 * @param {string} viewerDirection 'incoming' when the customer is viewing
 *        (promote outgoing agent media), 'outgoing' when the agent views.
 */
async function markSeen(ticketRef, viewerDirection) {
    if (!ticketRef) return;
    const opposite = viewerDirection === 'incoming' ? 'outgoing' : 'incoming';
    await dbAdapter.run(
        `UPDATE support_media
           SET upload_status = 'seen', updated_at = CURRENT_TIMESTAMP
         WHERE ticket_ref = ? AND direction = ? AND upload_status = 'sent'`,
        [ticketRef, opposite]
    );
}

// ── Retention ─────────────────────────────────────────────────
/**
 * Start the 45-day deletion timer on final closure.
 * @param {string} ticketRef
 * @param {Date|string} resolutionAt  the canonical closure timestamp
 */
async function armRetention(ticketRef, resolutionAt) {
    if (!ticketRef || !resolutionAt) return;
    await dbAdapter.run(
        `UPDATE support_media
           SET retention_due_at = ($2::timestamp + INTERVAL '45 days'), updated_at = CURRENT_TIMESTAMP
         WHERE ticket_ref = ? AND purged_at IS NULL`,
        [ticketRef, resolutionAt]
    );
}

/**
 * Cancel the timer on reopen (repeated closes re-arm from the latest).
 */
async function clearRetention(ticketRef) {
    if (!ticketRef) return;
    await dbAdapter.run(
        `UPDATE support_media SET retention_due_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE ticket_ref = ? AND purged_at IS NULL`,
        [ticketRef]
    );
}

// ── Reads ─────────────────────────────────────────────────────
async function getById(id) {
    const rows = await dbAdapter.query('SELECT * FROM support_media WHERE id = ?', [Number(id)]);
    return rows[0] || null;
}

async function getByIds(ids) {
    const clean = (ids || []).map(Number).filter(Boolean);
    if (!clean.length) return [];
    const placeholders = clean.map(() => '?').join(',');
    return dbAdapter.query(
        `SELECT * FROM support_media WHERE id IN (${placeholders})`,
        clean
    );
}

/**
 * All media for a ticket (for inline thread hydration), oldest first.
 */
async function listForTicket(ticketRef) {
    if (!ticketRef) return [];
    return dbAdapter.query(
        'SELECT * FROM support_media WHERE ticket_ref = ? ORDER BY created_at ASC, id ASC',
        [ticketRef]
    );
}

/**
 * Media across every ticket belonging to a portal phone (mirrors the
 * last-10-digit LIKE match mediaService.getAttachmentsForPhone uses).
 */
async function listForPortalPhone(phone) {
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    if (!last10) return [];
    return dbAdapter.query(
        `SELECT m.* FROM support_media m
           JOIN support_tickets t ON t.ticket_number = m.ticket_ref
          WHERE t.customer_phone LIKE ?
          ORDER BY m.created_at ASC, m.id ASC`,
        [`%${last10}`]
    );
}

/**
 * Public, size-tuned delivery URL for a media row (used when sending
 * to WhatsApp/Instagram so the carrier fetches an optimized variant).
 */
function optimizedUrlFor(row, opts) {
    return supportCloudinary.optimizedUrl(row.public_id, opts);
}

/**
 * Shape a media row for the browser. Hides internal ids, keeps only
 * what a client needs to render a thumbnail + status chip.
 */
function publicView(row) {
    if (!row) return null;
    const purged = !!row.purged_at || row.upload_status === STATUS.EXPIRED;
    return {
        id: row.id,
        channel: row.channel,
        direction: row.direction,
        thumb_url: purged ? null : (row.thumbnail_url || row.secure_url),
        full_url: purged ? null : row.secure_url,
        width: row.width,
        height: row.height,
        upload_status: row.upload_status,
        delivery_status: row.delivery_status || null,
        thread_entry_idx: row.thread_entry_idx,
        error_text: row.upload_status === STATUS.FAILED ? (row.error_text || null) : null,
        expired: purged,
        created_at: row.created_at
    };
}

/**
 * Persist an inbound WhatsApp/Instagram image that was downloaded
 * server-side (no browser): upload it to the support Cloudinary,
 * then create the lifecycle row in one shot.
 * @returns {Promise<object|null>} the support_media row
 */
async function saveIncoming({ channel, ticketRef, actor, filePath, mimeHint, meta }) {
    const publicId = supportCloudinary.makePublicId(channel, ticketRef);
    try {
        const uploaded = await supportCloudinary.uploadFromPath(filePath, publicId);
        const row = await dbAdapter.insert('support_media', {
            public_id: uploaded.public_id,
            channel: channel || 'whatsapp',
            ticket_ref: ticketRef || null,
            direction: 'incoming',
            actor: actor || null,
            mime_type: mimeHint || `image/${uploaded.format || 'jpeg'}`,
            file_size: uploaded.bytes,
            width: uploaded.width,
            height: uploaded.height,
            secure_url: uploaded.secure_url,
            thumbnail_url: uploaded.thumbnail_url,
            upload_status: STATUS.SENT
        });
        return row;
    } catch (err) {
        console.error('[SUPPORT_MEDIA] inbound upload failed:', err.message);
        // Still record a failed row so the ticket shows the send attempt.
        try {
            return await dbAdapter.insert('support_media', {
                public_id: publicId,
                channel: channel || 'whatsapp',
                ticket_ref: ticketRef || null,
                direction: 'incoming',
                actor: actor || null,
                mime_type: mimeHint || null,
                upload_status: STATUS.FAILED,
                error_text: String(err.message || 'upload failed').slice(0, 500)
            });
        } catch (e2) {
            console.error('[SUPPORT_MEDIA] failed to record inbound failure row:', e2.message);
            return null;
        }
    }
}

/**
 * Register a lifecycle row for an inbound image that was already uploaded
 * to the support Cloudinary server-side (WhatsApp/Instagram webhook path).
 * No re-upload — we already have the public_id and URLs.
 * @returns {Promise<object|null>}
 */
async function registerIncoming({ channel, ticketRef, actor, publicId, secureUrl, thumbnailUrl, width, height, bytes, mimeType }) {
    if (!publicId) return null;
    try {
        return await dbAdapter.insert('support_media', {
            public_id: publicId,
            channel: channel || 'whatsapp',
            ticket_ref: ticketRef || null,
            direction: 'incoming',
            actor: actor || null,
            mime_type: mimeType || null,
            file_size: bytes || null,
            width: width || null,
            height: height || null,
            secure_url: secureUrl || null,
            thumbnail_url: thumbnailUrl || null,
            upload_status: STATUS.SENT
        });
    } catch (err) {
        console.error('[SUPPORT_MEDIA] registerIncoming failed:', err.message);
        return null;
    }
}

module.exports = {
    STATUS,
    MAX_BYTES,
    MAX_PER_MESSAGE,
    ALLOWED_FORMATS,
    RETENTION_DAYS,
    createIntent,
    finalize,
    retry,
    markFailed,
    setStatus,
    attachToMessage,
    attachToTicket,
    recordWaMessageId,
    applyDeliveryStatus,
    markSeen,
    armRetention,
    clearRetention,
    getById,
    getByIds,
    listForTicket,
    listForPortalPhone,
    optimizedUrlFor,
    publicView,
    saveIncoming,
    registerIncoming
};
