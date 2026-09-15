/**
 * Refund Eligibility Service (Requirement 11)
 * Evaluates whether an order or customer case qualifies for a refund,
 * the applicable refund type (Original Payment vs Store Credit vs Difference Refund),
 * and required proof based strictly on authoritative business data and company SOP.
 *
 * SOP Rules Source of Truth:
 * - Original Payment Method Refund (5-7 days):
 *   (a) Damaged on arrival (with photo proof)
 *   (b) Wrong product delivered (with unboxing video proof)
 *   (c) Prepaid order cancelled at confirmation / pre-dispatch
 *   (d) Prepaid RTO without receipt by customer
 * - Store Credit:
 *   All other return/exchange cases (size/fit preference, discretionary return).
 * - COD Conversion:
 *   Overcharge due to discount loss during Edit Details is refunded separately.
 * - COD RTO / Pre-delivery Cancellation:
 *   Zero refund required (no money was collected upfront).
 */

const { dbAdapter } = require('../database/db');
const { getIstTimestamp } = require('./productInfoService');

const SOP_REFUND_POLICY = {
    ORIGINAL_PAYMENT_CONDITIONS: [
        'Damaged product on arrival (with photo proof)',
        'Wrong product delivered (with mandatory uncut unboxing video)',
        'Prepaid order cancelled before dispatch or at confirmation',
        'Prepaid shipment returned to origin (RTO) without customer delivery'
    ],
    STORE_CREDIT_CONDITIONS: [
        'Size change or exchange requests',
        'Customer preference or discretionary return',
        'Standard returns where replacement is not desired'
    ],
    PROCESSING_WINDOW: '5–7 business days to reflect in customer bank account once processed',
    PORTAL_URL: 'offcomfrt.in/pages/return'
};

/**
 * Check refund eligibility for an order or customer inquiry.
 */
async function checkRefundEligibility({
    orderId,
    phone,
    reason,
    proofProvided,
    hasPhotos,
    hasUnboxingVideo,
    cancelledPreDispatch,
    deliveredDateOverride,
    caseType
} = {}) {
    const timestamp = getIstTimestamp();

    const cleanOrderId = orderId ? String(orderId).replace(/^#/, '').trim() : null;
    const cleanPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;

    if (!cleanOrderId && !cleanPhone) {
        return {
            investigated: false,
            eligibility: 'Cannot determine',
            reason: 'Order number or customer phone number is required to verify refund eligibility.',
            policy: 'Refund evaluation requires order details and payment method verification per company SOP.',
            case_evidence: 'No identifier provided',
            missing_requirements: 'Order ID or Customer Phone',
            refund_type: 'Cannot determine',
            next_action: 'Request order ID or phone number from customer.',
            data_as_of: timestamp
        };
    }

    // 1. Fetch Order Record from store_shoppers
    let orderRow = null;
    try {
        let sql = 'SELECT * FROM store_shoppers WHERE ';
        let params = [];
        if (cleanOrderId && cleanPhone) {
            sql += '(order_id = $1 OR order_id = $2 OR order_id LIKE $3) AND phone LIKE $4 LIMIT 1';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`, `%${cleanPhone}`];
        } else if (cleanOrderId) {
            sql += '(order_id = $1 OR order_id = $2 OR order_id LIKE $3) LIMIT 1';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else {
            sql += 'phone LIKE $1 ORDER BY created_at DESC LIMIT 1';
            params = [`%${cleanPhone}`];
        }
        const rows = await dbAdapter.query(sql, params);
        if (rows.length > 0) orderRow = rows[0];
    } catch (err) {
        console.warn('⚠️ RefundEligibility order lookup warning:', err.message);
    }

    // 2. Fetch Shipment Record
    let shipmentRow = null;
    if (cleanOrderId || orderRow?.order_id) {
        const oid = cleanOrderId || orderRow.order_id;
        try {
            const sRows = await dbAdapter.query(
                `SELECT * FROM shipments WHERE order_id = $1 OR order_id = $2 ORDER BY id DESC LIMIT 1`,
                [oid, `#${oid}`]
            );
            if (sRows.length > 0) shipmentRow = sRows[0];
        } catch {}
    }

    // 3. Fetch Returns and Exchanges Records
    let returnRows = [];
    let exchangeRows = [];
    if (cleanOrderId || cleanPhone) {
        const oid = cleanOrderId || orderRow?.order_id || '';
        try {
            returnRows = await dbAdapter.query(
                `SELECT * FROM returns WHERE order_id = $1 OR order_id = $2 OR customer_phone LIKE $3 ORDER BY created_at DESC LIMIT 3`,
                [oid, `#${oid}`, `%${cleanPhone || '9999999999'}`]
            );
        } catch {}
        try {
            exchangeRows = await dbAdapter.query(
                `SELECT * FROM exchanges WHERE order_id = $1 OR order_id = $2 OR customer_phone LIKE $3 ORDER BY created_at DESC LIMIT 3`,
                [oid, `#${oid}`, `%${cleanPhone || '9999999999'}`]
            );
        } catch {}
    }

    // 4. Fetch Support Tickets
    let supportTickets = [];
    if (cleanOrderId || cleanPhone) {
        const oid = cleanOrderId || orderRow?.order_id || '';
        try {
            supportTickets = await dbAdapter.query(
                `SELECT id, ticket_number, customer_phone, customer_name, message, status, ai_scenario, created_at 
                 FROM support_tickets 
                 WHERE message ILIKE $1 OR customer_phone LIKE $2 
                 ORDER BY created_at DESC LIMIT 5`,
                [`%${oid}%`, `%${cleanPhone || '9999999999'}`]
            );
        } catch {}
    }

    // Detect stated reason
    const ticketText = supportTickets.map(t => `${t.ai_scenario || ''} ${t.message || ''}`).join(' ').toLowerCase();
    const returnRecord = returnRows[0] || null;
    const statedReason = reason || returnRecord?.reason || (
        ticketText.includes('wrong') ? 'Wrong product delivered' :
        ticketText.includes('damag') || ticketText.includes('defect') ? 'Damaged product on arrival' :
        ticketText.includes('size') || ticketText.includes('fit') ? 'Size / fit issue' :
        (orderRow?.status === 'cancelled' || orderRow?.shopify_cancelled_at) ? 'Order cancelled' : 'Return requested'
    );

    const normReason = statedReason.toLowerCase();
    const isWrong = normReason.includes('wrong') || normReason.includes('incorrect');
    const isDamaged = normReason.includes('damag') || normReason.includes('defect') || normReason.includes('torn');
    const isSizeOrPreference = normReason.includes('size') || normReason.includes('fit') || normReason.includes('exchange') || normReason.includes('preference') || normReason.includes('mind');
    const isCodConfusion = normReason.includes('cod') && (normReason.includes('discount') || normReason.includes('full amount') || normReason.includes('asking'));

    // Derive attributes
    const rawPaymentMethod = (orderRow?.payment_method || shipmentRow?.payment_mode || '').toLowerCase();
    const isPrepaid = rawPaymentMethod.includes('prepaid') || rawPaymentMethod.includes('online') || rawPaymentMethod.includes('razorpay') || rawPaymentMethod.includes('upi') || rawPaymentMethod.includes('gokwik') || normReason.includes('prepaid') || Boolean(cancelledPreDispatch);
    const isCod = !isPrepaid && (rawPaymentMethod.includes('cod') || rawPaymentMethod.includes('cash'));

    const orderStatus = (orderRow?.status || '').toLowerCase();
    const shipmentStatus = (shipmentRow?.status || '').toLowerCase();
    const isCancelled = orderStatus === 'cancelled' || Boolean(orderRow?.shopify_cancelled_at) || Boolean(orderRow?.cancel_reason);
    const isRto = shipmentStatus.includes('rto') || orderStatus.includes('rto');
    const isDelivered = shipmentStatus === 'delivered' || orderStatus === 'delivered';
    const isPreDispatch = /pending|confirmed|processing|unfulfilled/i.test(orderStatus) && !shipmentRow?.awb;

    // Detect proof provided
    const proofFoundInTickets = supportTickets.some(t => /video|unboxing|photo|image|drive\.google|attachment/i.test(t.message || ''));
    const photoVerified = Boolean(hasPhotos || proofProvided || proofFoundInTickets);
    const videoVerified = Boolean(hasUnboxingVideo);

    let eligibility = 'Cannot determine';
    let reasonText = '';
    let policyText = '';
    let caseEvidence = '';
    let missingRequirements = 'None';
    let refundType = 'None';
    let nextAction = '';

    // ── SCENARIO A: Damaged Product on Arrival ──
    if (isDamaged) {
        policyText = 'SOP Section 3 & 5: Damaged on arrival qualifies for refund to original payment method, subject to verified photo proof.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} (${isPrepaid ? 'Prepaid' : 'COD'}). Reason: ${statedReason}.`;
        if (photoVerified) {
            eligibility = 'Eligible';
            refundType = 'Original payment';
            reasonText = 'Customer reported damaged item on arrival and provided supporting photographic evidence.';
            nextAction = 'Officer should inspect photographs of damage and packaging, approve return, and issue refund to original payment method upon QC.';
        } else {
            eligibility = 'Eligible pending proof';
            refundType = 'Original payment (upon verification)';
            missingRequirements = 'Clear photographs of the damaged product and outer shipping packaging showing the label.';
            reasonText = 'Damaged product qualifies for original payment refund, but mandatory photo proof has not yet been verified.';
            nextAction = 'Request clear photographs of the damage and outer package from the customer before approving refund.';
        }
    }

    // ── SCENARIO B: Wrong Product Delivered ──
    else if (isWrong) {
        policyText = 'SOP Section 3 & 5: Wrong product delivered qualifies for refund to original payment method, strictly requiring a continuous, uncut unboxing video showing the shipping label.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} (${isPrepaid ? 'Prepaid' : 'COD'}). Reason: ${statedReason}.`;
        if (videoVerified) {
            eligibility = 'Eligible';
            refundType = 'Original payment';
            reasonText = 'Customer received wrong product and provided unboxing video proof.';
            nextAction = 'Verify unboxing video is uncut with clear label visibility, schedule reverse pickup, and process refund to original payment method.';
        } else {
            eligibility = 'Eligible pending proof';
            refundType = 'Original payment (upon verification)';
            missingRequirements = 'Mandatory continuous, uncut unboxing video showing the outer shipping label and package opening.';
            reasonText = 'Wrong product claims qualify for original payment refund, but an uncut unboxing video is mandatory per SOP.';
            nextAction = 'Ask customer to provide continuous unboxing video showing outer package and label before refund can be approved.';
        }
    }

    // ── SCENARIO C: Standard Return / Size Exchange / Preference ──
    else if (isSizeOrPreference) {
        policyText = 'SOP Section 3 & 4: Size, fit, or preference returns/exchanges are processed via Store credit only. Cash/original payment refunds are strictly not permitted for sizing/preference.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} (${orderStatus}). Reason: ${statedReason}.`;
        eligibility = 'Eligible for Store Credit';
        refundType = 'Store credit';
        reasonText = 'Item is returned for size/preference reasons. Under company SOP, all sizing and preference returns receive store credit.';
        nextAction = `Direct customer to portal ${SOP_REFUND_POLICY.PORTAL_URL} to file return/exchange. Issue store credit voucher upon reverse pickup and QC inspection.`;
    }

    // ── SCENARIO D: Prepaid Cancellation at Confirmation / Pre-Dispatch ──
    else if (cancelledPreDispatch || normReason.includes('cancel') || isCancelled) {
        policyText = 'SOP Section 3 & 8: Prepaid orders cancelled at confirmation or before dispatch qualify for 100% refund to original payment method.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} - Payment: ${isPrepaid ? 'Prepaid' : 'COD'}, Status: ${orderStatus}. Cancel reason: ${orderRow?.cancel_reason || 'Customer request'}.`;
        if (isPrepaid) {
            eligibility = 'Eligible';
            refundType = 'Original payment';
            reasonText = 'Prepaid order was cancelled prior to dispatch / at confirmation. Customer is entitled to a full refund to original payment method.';
            nextAction = 'Process refund to original payment method via gateway. Refund reflects in 5-7 business days.';
        } else {
            eligibility = 'Not eligible (No refund required)';
            refundType = 'None';
            reasonText = 'Order was placed via Cash on Delivery (COD). Since no funds were collected upfront, no refund is owed.';
            nextAction = 'Confirm cancellation in Shoppers Hub. Inform customer no payment was taken.';
        }
    }

    // ── SCENARIO E: RTO (Returned to Origin) ──
    else if (isRto || normReason.includes('rto')) {
        policyText = 'SOP Section 3 & 6: Orders returned to origin (RTO) without delivery to customer qualify for refund if prepaid. COD orders do not receive refunds.';
        caseEvidence = `Shipment AWB: ${shipmentRow?.awb || 'N/A'}, Status: ${shipmentStatus || 'RTO'}, Payment: ${isPrepaid ? 'Prepaid' : 'COD'}.`;
        if (isPrepaid) {
            eligibility = 'Eligible';
            refundType = 'Original payment';
            reasonText = 'Prepaid shipment went RTO and customer never received the parcel. Eligible for full refund to original payment method.';
            nextAction = 'Verify package has arrived at warehouse or is confirmed in RTO transit, then initiate refund to original payment method.';
        } else {
            eligibility = 'Not eligible (No refund required)';
            refundType = 'None';
            reasonText = 'Shipment went RTO on a COD order. Customer did not pay any money; hence no refund is applicable.';
            nextAction = 'Close order in system as RTO. If customer still wants items, offer to dispatch a fresh confirmed order.';
        }
    }

    // ── SCENARIO F: COD Conversion Overcharge / Discount Lost ──
    else if (isCodConfusion || (isCod && orderRow?.customer_message && /edit|discount/i.test(orderRow.customer_message))) {
        policyText = 'SOP Section 7: If "Edit Details" caused discount loss and converted order to full COD price, customer pays full amount at door, and OFFCOMFRT refunds the difference separately.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} converted to COD. Stated issue: ${statedReason}.`;
        eligibility = 'Eligible for Difference Refund';
        refundType = 'Difference refund (Original payment / Bank transfer)';
        reasonText = 'Order converted to COD after editing details without carrying over discount. Customer is eligible for refund of the overpaid difference.';
        nextAction = 'Confirm amount paid by customer at delivery, calculate discount difference, and issue difference refund via UPI/bank transfer.';
    }

    // ── SCENARIO G: Delivered but Not Received ──
    else if (normReason.includes('not received') || normReason.includes('missing') || normReason.includes('not delivered')) {
        policyText = 'SOP Section 2: When tracking shows delivered but customer disputes receipt, refund/replacement is held pending partner Proof of Delivery (POD) investigation (24-hour SLA).';
        caseEvidence = `Tracking status: ${shipmentRow?.status || 'Delivered'}. Customer statement: parcel not received.`;
        eligibility = 'Pending POD Investigation';
        refundType = 'Pending POD resolution';
        missingRequirements = 'Carrier Proof of Delivery (POD) verification';
        reasonText = 'Tracking indicates delivery. Refund cannot be issued until 24-hour POD investigation confirms delivery failure.';
        nextAction = 'Ask customer to check with neighbours/security, raise POD request with courier partner, and wait 24 hours for POD copy.';
    }

    // Fallback default
    else {
        policyText = 'SOP Section 3: Original payment refunds require verified damage, wrong item, prepaid cancellation, or prepaid RTO. All other eligible returns receive store credit.';
        caseEvidence = `Order #${orderRow?.order_id || cleanOrderId} (${rawPaymentMethod || 'Payment unknown'}). Status: ${orderStatus}.`;
        eligibility = isPrepaid ? 'Eligible for Store Credit' : 'Not eligible';
        refundType = isPrepaid ? 'Store credit' : 'None';
        reasonText = `General return inquiry under evaluation for reason: ${statedReason}.`;
        nextAction = `Confirm case details with customer and direct to ${SOP_REFUND_POLICY.PORTAL_URL}.`;
    }

    // ── Delivery Window & Deductions calculation ──
    const deliveredDate = deliveredDateOverride ? new Date(deliveredDateOverride) : (shipmentRow?.delivered_at || orderRow?.delivered_at ? new Date(shipmentRow?.delivered_at || orderRow?.delivered_at) : null);
    let isWindowExpired = false;
    if (deliveredDate && !isNaN(deliveredDate.getTime())) {
        const daysSinceDelivered = (Date.now() - deliveredDate.getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceDelivered > 2 && !isDamaged && !isWrong && !cancelledPreDispatch && !normReason.includes('cancel')) {
            isWindowExpired = true;
            eligibility = 'Not eligible (Return window expired)';
            reasonText = 'Return window expired. SOP requires returns/exchanges to be initiated within 2 days of delivery.';
        }
    }

    const isDefectOrPrepaid = isDamaged || isWrong || cancelledPreDispatch || normReason.includes('cancel') || normReason.includes('rto');
    const fee = isDefectOrPrepaid ? 0 : 100;
    const grossTotal = parseFloat(orderRow?.order_total) || 1799;
    const netRefund = Math.max(0, grossTotal - fee);

    const isEligibleBool = (eligibility === 'Eligible' || eligibility === 'Eligible for Store Credit' || eligibility === 'Eligible for Difference Refund') && !isWindowExpired;
    const channel = refundType.toLowerCase().includes('original') 
        ? 'ORIGINAL_PAYMENT_METHOD' 
        : (refundType.toLowerCase().includes('store credit') 
            ? 'STORE_CREDIT' 
            : (refundType.toLowerCase().includes('difference') ? 'DIFFERENCE_REFUND' : 'NONE'));

    const proofStatus = isWrong 
        ? (Boolean(hasUnboxingVideo) ? 'VERIFIED' : 'PENDING_CUSTOMER_SUBMISSION') 
        : (isDamaged ? (Boolean(photoVerified) ? 'VERIFIED' : 'PENDING_CUSTOMER_SUBMISSION') : 'NOT_REQUIRED');

    const evaluation = {
        eligible: isEligibleBool,
        channel,
        proof_status: proofStatus,
        window_status: isWindowExpired ? 'EXPIRED' : 'VALID',
        banking_window_days: '5-7 business days',
        deductions: { reverse_logistics_fee: fee },
        net_refund_amount: netRefund,
        refundable_amount: grossTotal
    };

    const policyApplied = {
        channel_rule: policyText,
        proof_rule: isWrong ? 'Mandatory uncut unboxing video' : (isDamaged ? 'Clear photos required' : ((normReason.includes('not received') || normReason.includes('not_received') || normReason.includes('pod')) ? 'Pending 24-hour partner POD investigation' : 'No proof required')),
        banking_clearance_window: '5-7 business days'
    };

    return {
        investigated: true,
        identifiers: {
            order_id: cleanOrderId || orderRow?.order_id || 'N/A',
            phone: cleanPhone || orderRow?.phone || 'N/A'
        },
        eligibility,
        reason: reasonText,
        policy: policyText,
        case_evidence: caseEvidence,
        missing_requirements: missingRequirements,
        refund_type: refundType,
        next_action: nextAction,
        action_required: nextAction,
        evaluation,
        policy_applied: policyApplied,
        order_context: {
            payment_method: isPrepaid ? 'Prepaid' : (isCod ? 'COD' : 'Unknown'),
            order_status: orderStatus,
            shipment_status: shipmentStatus,
            stated_reason: statedReason,
            proof_verified: photoVerified || videoVerified
        },
        sop_reference: SOP_REFUND_POLICY,
        data_as_of: timestamp
    };
}

/**
 * Format structured response strictly conforming to Phase 11.4 format:
 * ELIGIBILITY: ...
 * REASON: ...
 * POLICY: ...
 * CASE EVIDENCE: ...
 * MISSING REQUIREMENTS: ...
 * REFUND TYPE: ...
 * NEXT ACTION: ...
 */
function formatRefundEligibilityResponse(res) {
    if (!res || !res.investigated) {
        return `[VERIFIED FACT] Refund Eligibility: ${res?.reason || 'Unable to investigate order refund eligibility.'} (Data as of: ${res?.data_as_of || 'Live'})`;
    }

    return `ELIGIBILITY:
${res.eligibility}

REASON:
${res.reason}

POLICY:
${res.policy}

CASE EVIDENCE:
${res.case_evidence}

MISSING REQUIREMENTS:
${res.missing_requirements}

REFUND TYPE:
${res.refund_type}

NEXT ACTION:
${res.next_action}

(Data as of: ${res.data_as_of} — Live Database)`;
}

module.exports = {
    checkRefundEligibility,
    formatRefundEligibilityResponse,
    formatEligibilityReport: formatRefundEligibilityResponse,
    SOP_REFUND_POLICY,
    REFUND_SOP_RULES: SOP_REFUND_POLICY
};
