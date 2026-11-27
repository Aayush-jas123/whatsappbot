/**
 * Support Cloudinary Service
 * ─────────────────────────────────────────────────────────────
 * Dedicated Cloudinary account for support-ticket media (website
 * Help & Tickets, internal Support Desk, WhatsApp/Instagram portal).
 *
 * This is intentionally SEPARATE from the shared cloudinaryService
 * (which targets the returns/marketing account). Support images use
 * their own credentials so retention purges and rate limits never
 * touch business-critical product assets.
 *
 * Env vars (see .env.example):
 *   SUPPORT_CLOUDINARY_CLOUD_NAME
 *   SUPPORT_CLOUDINARY_API_KEY
 *   SUPPORT_CLOUDINARY_API_SECRET
 *
 * Flow (signed browser direct upload):
 *   1. Server mints a deterministic public_id (makePublicId).
 *   2. Server returns signed upload params (buildUploadParams) —
 *      the API secret never leaves the server.
 *   3. Browser POSTs the file directly to Cloudinary (XHR for progress).
 *   4. Server finalizes by verifying the asset really landed
 *      (finalize) and returns canonical metadata.
 *   5. Retention cron deletes purged assets (destroy).
 * ─────────────────────────────────────────────────────────────
 */

// Lazy-load cloudinary so we don't pay the ~5-10MB startup cost
// unless a support surface actually uploads media.
let _cloudinary = null;
function getCloudinary() {
    if (!_cloudinary) {
        _cloudinary = require('cloudinary').v2;
        _cloudinary.config({
            cloud_name: process.env.SUPPORT_CLOUDINARY_CLOUD_NAME,
            api_key: process.env.SUPPORT_CLOUDINARY_API_KEY,
            api_secret: process.env.SUPPORT_CLOUDINARY_API_SECRET
        });
    }
    return _cloudinary;
}

function isConfigured() {
    const cloud = process.env.SUPPORT_CLOUDINARY_CLOUD_NAME;
    const key = process.env.SUPPORT_CLOUDINARY_API_KEY;
    const secret = process.env.SUPPORT_CLOUDINARY_API_SECRET;
    const isPlaceholder = (v) => !v || /your_|YOUR_|<.*>/g.test(v || '');
    return !!(cloud && key && secret && !isPlaceholder(cloud) && !isPlaceholder(key) && !isPlaceholder(secret));
}

// Delivery transforms: keep originals, but serve size/format-tuned
// variants via f_auto,q_auto so chat threads stay light.
const UPLOAD_EAGER = [
    { width: 400, height: 400, crop: 'limit', format: 'webp' } // thumbnail chip
];
const UPLOAD_TRANSFORMATION = [
    { width: 1920, crop: 'limit', quality: 'auto', fetch_format: 'auto' }
];

// Canonical delivery strings for the signed browser direct-upload path.
// generate_transformation_string() consumes a `format` key as the trailing
// file-extension segment (so it silently drops f_webp from an eager chip),
// and the signature must be computed over the exact bytes the browser sends
// back. These transforms are static, so pin them as explicit strings and sign
// those. They mirror UPLOAD_EAGER / UPLOAD_TRANSFORMATION above.
const UPLOAD_EAGER_STR = 'w_400,h_400,c_limit,f_webp';
const UPLOAD_TRANSFORMATION_STR = 'w_1920,c_limit,q_auto,f_auto';

const SUPPORTED_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per original

class SupportCloudinaryService {
    /**
     * Deterministic, non-forgeable public_id for a support upload.
     * @param {string} channel  website | whatsapp | instagram
     * @param {string} ticketRef ticket_number or portal slug (optional)
     * @returns {string}
     */
    makePublicId(channel, ticketRef) {
        const crypto = require('crypto');
        const safeChannel = String(channel || 'generic').replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const safeRef = ticketRef
            ? String(ticketRef).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60)
            : 'unassigned';
        const dateFolder = new Date().toISOString().slice(0, 7).replace('-', '/');
        return `support/${safeChannel}/${safeRef}/${dateFolder}/${crypto.randomUUID()}`;
    }

    /**
     * Build the signed payload the browser needs to upload directly.
     * The public_id is pinned into the signature so a tampered client
     * cannot write to an attacker-chosen path.
     * @param {string} publicId
     * @returns {{ cloud_name, api_key, timestamp, signature, public_id, resource_type, eager, transformation }}
     */
    buildUploadParams(publicId) {
        const cld = getCloudinary();
        const timestamp = Math.round(Date.now() / 1000);

        // Cloudinary's api_sign_request serializes array params with a plain
        // Array.join(","), which turns transform *objects* into "[object
        // Object]" and makes a browser that echoes the objects back fail
        // signature verification. So we sign the canonical delivery strings
        // (static, see UPLOAD_EAGER_STR) and return those same strings; the
        // client must append them verbatim.
        const paramsToSign = {
            timestamp,
            public_id: publicId,
            eager: UPLOAD_EAGER_STR,
            transformation: UPLOAD_TRANSFORMATION_STR
        };

        const signature = cld.utils.api_sign_request(paramsToSign, process.env.SUPPORT_CLOUDINARY_API_SECRET);

        return {
            cloud_name: process.env.SUPPORT_CLOUDINARY_CLOUD_NAME,
            api_key: process.env.SUPPORT_CLOUDINARY_API_KEY,
            timestamp,
            signature,
            public_id: publicId,
            resource_type: 'image',
            eager: UPLOAD_EAGER_STR,
            transformation: UPLOAD_TRANSFORMATION_STR
        };
    }

    /**
     * Verify an asset actually landed in OUR support account and return
     * canonical metadata. Used by the finalize endpoint (server-side,
     * never trusts the client-provided URL blindly).
     * @param {string} publicId
     * @returns {Promise<{ secure_url, thumbnail_url, width, height, bytes, format }>}
     */
    async finalize(publicId) {
        const cld = getCloudinary();
        const res = await cld.api.resource(publicId, { resource_type: 'image' });

        const eagerThumb = (res.eager || []).find(e => e && e.secure_url) || null;

        return {
            secure_url: res.secure_url,
            thumbnail_url: eagerThumb ? eagerThumb.secure_url : (res.thumbnail_url || null),
            width: res.width,
            height: res.height,
            bytes: res.bytes,
            format: res.format
        };
    }

    /**
     * Delete a support asset (original + all derived transforms) and
     * invalidate the CDN cache.
     * @param {string} publicId
     * @returns {Promise<string>} cloudinary result ('ok' | 'not_found')
     */
    async destroy(publicId) {
        const cld = getCloudinary();
        const result = await cld.uploader.destroy(publicId, {
            resource_type: 'image',
            invalidate: true
        });
        return result.result;
    }

    /**
     * Build an optimized public delivery URL for a support asset.
     * @param {string} publicId
     * @param {{ width?: number }} [opts]
     * @returns {string}
     */
    optimizedUrl(publicId, opts = {}) {
        const cld = getCloudinary();
        const transformations = ['f_auto', 'q_auto'];
        if (opts.width) transformations.push(`w_${opts.width}`, 'c_limit');
        return cld.utils.url(publicId, {
            cloud_name: process.env.SUPPORT_CLOUDINARY_CLOUD_NAME,
            resource_type: 'image',
            transformation: [transformations.join(',')]
        });
    }

    /**
     * True when the given URL points at OUR support cloud (anti-tamper
     * host check used during finalize).
     * @param {string} url
     * @returns {boolean}
     */
    isOwnSecureUrl(url) {
        const cloud = process.env.SUPPORT_CLOUDINARY_CLOUD_NAME;
        if (!url || !cloud) return false;
        try {
            const parsed = new URL(url);
            return parsed.hostname === 'res.cloudinary.com' &&
                   parsed.pathname.split('/')[1] === cloud;
        } catch (e) {
            return false;
        }
    }

    /**
     * Upload a server-side local file path (fallback used by the incoming
     * WhatsApp/Instagram media pipeline where there is no browser).
     * @param {string} filePath
     * @param {string} publicId
     * @returns {Promise<{ secure_url, thumbnail_url, width, height, bytes, format, public_id }>}
     */
    async uploadFromPath(filePath, publicId) {
        const cld = getCloudinary();
        const result = await cld.uploader.upload(filePath, {
            public_id: publicId,
            resource_type: 'image',
            eager: UPLOAD_EAGER,
            transformation: UPLOAD_TRANSFORMATION
        });
        const eagerThumb = (result.eager || []).find(e => e && e.secure_url) || null;
        return {
            secure_url: result.secure_url,
            thumbnail_url: eagerThumb ? eagerThumb.secure_url : (result.thumbnail_url || null),
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            format: result.format,
            public_id: result.public_id
        };
    }
}

module.exports = new SupportCloudinaryService();
module.exports.SUPPORTED_FORMATS = SUPPORTED_FORMATS;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.isConfigured = isConfigured;
