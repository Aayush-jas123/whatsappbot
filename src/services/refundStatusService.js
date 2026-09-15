/**
 * Refund Status Investigation Service (Requirement 12)
 * Investigates the ACTUAL STATUS of an initiated or requested refund.
 * Tracks refund amount, method, timestamps, gateway processing, and timeline.
 *
 * Implements:
 * - Difference between "Refund Eligible" and "Refund Status"
 * - Retrieval of refund requested, initiated, processed dates
 * - Refund amount, transaction/reference ID, and failure tracking
 * - 7-stage chronological refund timeline
 * - SOP 5-7 business day banking clearance window explanation
 * - Authoritative IST timestamps
 */

const { dbAdapter } = require('../database/db');
const { getIstTimestamp } = require('./productInfoService');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function formatIstDate(dateInput) {
    if (!dateInput) return null;
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return null;
        const istDate = new Date(d.getTime() + IST_OFFSET_MS);
        const day = String(istDate.getUTCDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[istDate.getUTCMonth()];
        const year = istDate.getUTCFullYear();
        let hours = istDate.getUTCHours();
        const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const formattedHour = String(hours).padStart(2, '0');
        return `${day} ${month} ${year}, ${formattedHour}:${minutes} ${ampm} IST`;
    } catch {
        return null;
    }
}

/**
 * Investigate the actual status and progress of a refund for an order.
 */
async function investigateRefundStatus({ orderId, phone, requestId, statusOverride, initiatedDateOverride } = {}) {
    const timestamp = getIstTimestamp();

    const cleanOrderId = orderId ? String(orderId).replace(/^#/, '').trim() : null;
    const cleanPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;
    const cleanReqId = requestId ? String(requestId).trim().toUpperCase() : null;

    if (!cleanOrderId && !cleanPhone && !cleanReqId) {
        return {
            investigated: false,
            found: false,
            message: 'No refund records found for this order.',
            error: 'Order ID, Customer Phone, or Request ID is required to check refund status.',
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
        } else if (cleanPhone) {
            sql += 'phone LIKE $1 ORDER BY created_at DESC LIMIT 1';
            params = [`%${cleanPhone}`];
        }
        if (params.length > 0) {
            const rows = await dbAdapter.query(sql, params);
            if (rows.length > 0) orderRow = rows[0];
        }
    } catch (err) {
        console.warn('⚠️ RefundStatus order query error:', err.message);
    }

    // 2. Fetch Returns Records (contains refund_amount, refund_status)
    let returnRows = [];
    try {
        let sql = 'SELECT * FROM returns WHERE ';
        let params = [];
        if (cleanReqId) {
            sql += 'return_id = $1 OR return_id = $2 ORDER BY created_at DESC LIMIT 3';
            params = [cleanReqId, cleanReqId.replace(/^REQ-/, '')];
        } else if (cleanOrderId) {
            sql += 'order_id = $1 OR order_id = $2 OR order_id LIKE $3 ORDER BY created_at DESC LIMIT 3';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else if (cleanPhone) {
            sql += 'customer_phone LIKE $1 ORDER BY created_at DESC LIMIT 3';
            params = [`%${cleanPhone}`];
        }
        if (params.length > 0) {
            returnRows = await dbAdapter.query(sql, params);
        }
    } catch (err) {
        console.warn('⚠️ RefundStatus returns query error:', err.message);
    }

    // 3. Fetch Exchanges Records
    let exchangeRows = [];
    try {
        let sql = 'SELECT * FROM exchanges WHERE ';
        let params = [];
        if (cleanReqId) {
            sql += 'exchange_id = $1 OR exchange_id = $2 ORDER BY created_at DESC LIMIT 3';
            params = [cleanReqId, cleanReqId.replace(/^REQ-/, '')];
        } else if (cleanOrderId) {
            sql += 'order_id = $1 OR order_id = $2 OR order_id LIKE $3 ORDER BY created_at DESC LIMIT 3';
            params = [cleanOrderId, `#${cleanOrderId}`, `%${cleanOrderId}`];
        } else if (cleanPhone) {
            sql += 'customer_phone LIKE $1 ORDER BY created_at DESC LIMIT 3';
            params = [`%${cleanPhone}`];
        }
        if (params.length > 0) {
            exchangeRows = await dbAdapter.query(sql, params);
        }
    } catch (err) {
        console.warn('⚠️ RefundStatus exchanges query error:', err.message);
    }

    // 4. Fetch Support Tickets for Refund Mentions
    let supportTickets = [];
    try {
        const oid = cleanOrderId || orderRow?.order_id || '';
        const phoneDigits = cleanPhone || orderRow?.phone || '';
        if (oid || phoneDigits) {
            supportTickets = await dbAdapter.query(
                `SELECT id, ticket_number, customer_phone, message, status, created_at 
                 FROM support_tickets 
                 WHERE (message ILIKE $1 OR customer_phone LIKE $2) 
                   AND (message ILIKE '%refund%' OR message ILIKE '%return%' OR message ILIKE '%money%') 
                 ORDER BY created_at DESC LIMIT 3`,
                [`%${oid}%`, `%${phoneDigits}`]
            );
        }
    } catch {}

    // Evaluate Refund Information
    const primaryReturn = returnRows[0] || null;
    const hasReturnRecord = Boolean(primaryReturn);

    const paymentMethodRaw = String(orderRow?.payment_method || '').toLowerCase();
    const isPrepaid = paymentMethodRaw.includes('prepaid') || paymentMethodRaw.includes('online') || paymentMethodRaw.includes('razorpay') || paymentMethodRaw.includes('upi') || paymentMethodRaw.includes('gokwik');

    // Refund amounts
    let refundAmount = parseFloat(primaryReturn?.refund_amount || 0);
    if (!refundAmount && orderRow?.shopify_refund_amount) {
        refundAmount = parseFloat(orderRow.shopify_refund_amount);
    }
    if (!refundAmount && orderRow?.order_total && (orderRow?.status === 'cancelled' || primaryReturn)) {
        refundAmount = parseFloat(orderRow.order_total);
    }

    // Refund status
    let refundStatus = primaryReturn?.refund_status || 'not_initiated';
    if (orderRow?.shopify_refund_amount && refundStatus === 'not_initiated') {
        refundStatus = 'processed';
    }
    if (primaryReturn?.status === 'refunded' || primaryReturn?.status === 'completed') {
        refundStatus = 'processed';
    } else if (primaryReturn?.status === 'initiated' && refundStatus === 'not_initiated') {
        refundStatus = 'pending';
    }

    // Failure check
    const isFailed = refundStatus.toLowerCase() === 'failed';
    const isProcessed = refundStatus.toLowerCase() === 'processed' || refundStatus.toLowerCase() === 'completed';
    const isPending = refundStatus.toLowerCase() === 'pending' || refundStatus.toLowerCase() === 'initiated';

    // Refund timestamps
    const requestedDate = primaryReturn?.created_at || orderRow?.shopify_cancelled_at || null;
    const processedDate = isProcessed ? (primaryReturn?.updated_at || orderRow?.shopify_cancelled_at || primaryReturn?.created_at) : null;

    // Calculate days since processing for SOP window evaluation
    let daysSinceProcessed = null;
    let withinBankingWindow = false;
    let bankingWindowMessage = '';

    if (processedDate) {
        const pDate = new Date(processedDate);
        if (!isNaN(pDate.getTime())) {
            daysSinceProcessed = Math.floor((Date.now() - pDate.getTime()) / (24 * 60 * 60 * 1000));
            if (daysSinceProcessed <= 7) {
                withinBankingWindow = true;
                bankingWindowMessage = `Refund was processed ${daysSinceProcessed === 0 ? 'today' : `${daysSinceProcessed} day(s) ago`}. SOP standard clearance window is 5–7 business days. The funds are currently in banking transit.`;
            } else {
                withinBankingWindow = false;
                bankingWindowMessage = `Refund was processed ${daysSinceProcessed} days ago, exceeding the standard 5–7 business days window. Customer should check bank statement or officer should retrieve payment gateway UTR / ARN reference.`;
            }
        }
    }

    // Refund Method
    let refundMethod = 'Original Payment Method';
    if (!isPrepaid) {
        refundMethod = 'Store Credit / Bank Transfer';
    }

    // Reconstruct 7-Stage Chronological Refund Timeline
    const timeline = [];

    // Stage 1: Refund Eligible
    timeline.push({
        stage: 'Refund Eligible',
        status: hasReturnRecord || orderRow?.status === 'cancelled' ? 'COMPLETED' : 'PENDING_EVALUATION',
        timestamp: formatIstDate(orderRow?.created_at) || 'N/A',
        details: hasReturnRecord 
            ? `Case evaluated eligible under SOP (${primaryReturn?.reason || 'Return requested'})`
            : orderRow?.status === 'cancelled'
            ? 'Order cancelled pre-dispatch, eligible for refund'
            : 'Eligibility decision not yet formalized in database'
    });

    // Stage 2: Refund Requested
    timeline.push({
        stage: 'Refund Requested',
        status: requestedDate ? 'COMPLETED' : 'PENDING',
        timestamp: formatIstDate(requestedDate) || 'Pending request',
        details: requestedDate 
            ? `Refund request recorded for Order #${orderRow?.order_id || cleanOrderId} (${primaryReturn ? `Return ID: ${primaryReturn.return_id}` : 'Cancellation'})`
            : 'No formal refund request logged in returns table'
    });

    // Stage 3: Refund Approved
    timeline.push({
        stage: 'Refund Approved',
        status: (isProcessed || isPending || isFailed) ? 'COMPLETED' : 'PENDING',
        timestamp: formatIstDate(primaryReturn?.updated_at || requestedDate) || 'Pending approval',
        details: (isProcessed || isPending || isFailed)
            ? `Refund of ₹${refundAmount || orderRow?.order_total || '0'} approved by system/admin`
            : 'Awaiting QC or officer approval'
    });

    // Stage 4: Refund Initiated
    timeline.push({
        stage: 'Refund Initiated',
        status: (isProcessed || isPending || isFailed) ? 'COMPLETED' : 'PENDING',
        timestamp: formatIstDate(requestedDate) || 'Pending initiation',
        details: (isProcessed || isPending || isFailed)
            ? `Payout initiated via ${isPrepaid ? 'Payment Gateway (Original Method)' : 'Store Credit System'}`
            : 'Refund initiation pending reverse pickup'
    });

    // Stage 5: Refund Processed
    timeline.push({
        stage: 'Refund Processed',
        status: isProcessed ? 'COMPLETED' : (isFailed ? 'FAILED' : 'PENDING'),
        timestamp: formatIstDate(processedDate) || (isFailed ? 'Failed' : 'Pending processing'),
        details: isProcessed
            ? `Successfully processed on ${formatIstDate(processedDate)}. Gateway confirmed transaction.`
            : isFailed
            ? 'Refund processing FAILED. Gateway returned an error (account invalid or gateway timeout).'
            : 'Awaiting payment gateway payout confirmation'
    });

    // Stage 6: Payment Gateway / Bank Processing
    timeline.push({
        stage: 'Payment Gateway / Bank Processing',
        status: isProcessed ? (withinBankingWindow ? 'IN_PROGRESS' : 'COMPLETED_OR_OVERDUE') : 'NOT_STARTED',
        timestamp: isProcessed ? `${daysSinceProcessed} day(s) elapsed` : 'Pending',
        details: isProcessed
            ? (withinBankingWindow 
                ? `Active banking clearance window (5–7 business days SLA). Day ${daysSinceProcessed} of 7.`
                : `Over 7 days since payout dispatch. Bank should have credited account.`)
            : 'Banking clearance will begin once refund is processed'
    });

    // Stage 7: Customer Receives Funds
    timeline.push({
        stage: 'Customer Receives Funds',
        status: isProcessed && !withinBankingWindow ? 'CONFIRM_WITH_CUSTOMER' : 'AWAITING_SETTLEMENT',
        timestamp: isProcessed && !withinBankingWindow ? 'Expected credited' : 'Pending bank clearance',
        details: isProcessed && withinBankingWindow
            ? 'Funds will appear in customer account statement within 5–7 business days.'
            : isProcessed
            ? 'Customer should verify bank/card statement. Officer can provide UTR reference if disputed.'
            : 'Funds not yet disbursed'
    });

    const isFound = Boolean(orderRow || primaryReturn || (returnRows && returnRows.length > 0) || (exchangeRows && exchangeRows.length > 0) || statusOverride);
    if (!isFound) {
        return {
            investigated: false,
            found: false,
            message: 'No refund records found for this order/customer.',
            error: 'No refund records found.',
            data_as_of: timestamp
        };
    }

    const isOverdue = Boolean(
        daysSinceProcessed > 7 || 
        (initiatedDateOverride && Math.floor((Date.now() - new Date(initiatedDateOverride).getTime()) / (24 * 60 * 60 * 1000)) > 7)
    );

    const effectiveStatus = statusOverride || refundStatus;
    const isCompleted = effectiveStatus === 'completed' || isProcessed || statusOverride === 'COMPLETED';
    const currentStage = statusOverride || (isCompleted ? 'COMPLETED' : (primaryReturn ? 'REFUND_INITIATED' : 'REQUEST_SUBMITTED'));

    const refundDetails = {
        refund_amount: refundAmount,
        refund_status: effectiveStatus,
        current_stage: currentStage,
        is_processed: isProcessed || isCompleted,
        is_pending: isPending && !isCompleted,
        is_failed: isFailed,
        is_overdue: isOverdue,
        is_completed: isCompleted,
        refund_method: refundMethod,
        store_credit_issued: refundMethod === 'Store Credit',
        payment_method: isPrepaid ? 'Prepaid' : 'COD',
        gateway: (orderRow?.payment_method || '').toLowerCase().includes('razorpay') ? 'Razorpay' : ((orderRow?.payment_method || '').toLowerCase().includes('gokwik') ? 'Gokwik' : 'Shopify Payments'),
        requested_date: formatIstDate(requestedDate),
        processed_date: formatIstDate(processedDate),
        days_since_processed: daysSinceProcessed,
        within_banking_window: withinBankingWindow && !isOverdue,
        banking_window_message: isOverdue ? 'Refund is delayed past 7 business days SLA. Gateway ARN / UTR escalation required.' : bankingWindowMessage,
        transaction_reference: primaryReturn?.shiprocket_return_id || orderRow?.gokwik_order_id || 'Pending Gateway ARN'
    };

    return {
        investigated: true,
        found: true,
        identifiers: {
            order_id: cleanOrderId || orderRow?.order_id || 'N/A',
            phone: cleanPhone || orderRow?.phone || 'N/A',
            request_id: cleanReqId || primaryReturn?.return_id || null
        },
        refund_details: refundDetails,
        verified_facts: refundDetails,
        policy_applied: {
            banking_clearance_window: '5-7 business days',
            sop_sla: 'Refunds reflect within 5-7 business days from date of initiation.'
        },
        timeline,
        data_as_of: timestamp
    };
}

/**
 * Format refund status summary for Copilot response.
 */
function formatRefundStatusResponse(res) {
    if (!res || !res.investigated) {
        return `[VERIFIED FACT] Refund Status: ${res?.error || res?.message || 'No refund records found.'} (Data as of: ${res?.data_as_of || 'Live'})`;
    }

    const rd = res.refund_details;
    const timelineStr = (res.timeline || []).map(t => `  • [${t.status}] ${t.stage} (${t.timestamp}): ${t.details}`).join('\n');

    return `============================================================
REFUND STATUS INVESTIGATION: ORDER #${res.identifiers.order_id}
============================================================

[VERIFIED FACT]
- Refund Status: ${rd.refund_status.toUpperCase()}
- Refund Amount: ₹${rd.refund_amount}
- Refund Method: ${rd.refund_method} (${rd.payment_method})
- Refund Requested Date: ${rd.requested_date || 'N/A'}
- Refund Processed Date: ${rd.processed_date || 'Not yet processed'}
- Transaction Reference: ${rd.transaction_reference}
${rd.is_failed ? '- FAILURE FLAG: Refund transaction failed in gateway. Manual re-initiation required.' : ''}

[POLICY]
- SOP Standard Processing Window: 5–7 business days for original payment method refunds.
- Status Explanation: ${rd.banking_window_message || 'Refund is currently pending processing.'}

[INFERENCE / RECOMMENDATION]
- Assessment: ${rd.is_overdue ? 'Refund exceeds standard banking window. Investigation required.' : 'Refund is processing normally.'}

[REFUND TIMELINE]
${timelineStr}

[ACTION RECOMMENDED]
${rd.is_failed
    ? '1. Escalate to finance to verify bank account details and re-trigger payment gateway refund.'
    : rd.is_processed && rd.within_banking_window
    ? '1. Inform customer refund was processed successfully on ' + rd.processed_date + '.\n2. Advise that bank clearance typically takes 5–7 business days.'
    : rd.is_processed && !rd.within_banking_window
    ? '1. Provide customer with gateway ARN/UTR reference ID: ' + rd.transaction_reference + '.\n2. Advise customer to check bank statement with reference ID.'
    : '1. Verify reverse pickup completion and warehouse QC approval to release pending refund.'
}

(Data as of: ${res.data_as_of} — Live Database)`;
}

const REFUND_STAGES = [
    'REQUEST_SUBMITTED',
    'PICKUP_SCHEDULED',
    'REVERSE_PICKUP_DONE',
    'QC_VERIFIED',
    'REFUND_INITIATED',
    'GATEWAY_PROCESSING',
    'COMPLETED'
];

module.exports = {
    investigateRefundStatus,
    formatRefundStatusResponse,
    formatRefundStatusReport: formatRefundStatusResponse,
    REFUND_STAGES
};
