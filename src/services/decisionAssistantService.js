/**
 * Next-Action Decision Assistant Service (Requirement 23)
 *
 * Provides intelligent decision-support to Customer Care Officers:
 * 1. Connects to authoritative SOPs, order data, shipment tracking, payments, returns, and customer history.
 * 2. Implements a 6-stage decision-support process:
 *    Understand issue -> Retrieve data -> Identify scenario -> Retrieve SOP -> Evaluate conditions -> Recommend next action
 * 3. Returns standard structured output:
 *    - Situation
 *    - Evidence
 *    - Applicable Policy
 *    - Recommended Action (Immediate step, conditional follow-up, escalation path)
 *    - Customer-Facing Response (ready-to-send draft)
 * 4. Strictly enforces Human-in-the-Loop safety (never auto-executing actions).
 */

const { dbAdapter } = require('../database/db');
const { getIstTimestamp } = require('./productInfoService');

// Lazy-loaded service dependencies to prevent circular imports
let orderIntelligenceService = null;
let shipmentIntelligenceService = null;
let returnInvestigationService = null;
let refundEligibilityService = null;
let customer360Service = null;

function getServices() {
    if (!orderIntelligenceService) {
        orderIntelligenceService = require('./orderIntelligenceService');
        shipmentIntelligenceService = require('./shipmentIntelligenceService');
        returnInvestigationService = require('./returnInvestigationService');
        refundEligibilityService = require('./refundEligibilityService');
        customer360Service = require('./customer360Service');
    }
    return {
        orderIntelligenceService,
        shipmentIntelligenceService,
        returnInvestigationService,
        refundEligibilityService,
        customer360Service
    };
}

/**
 * Standard Operational Scenarios
 */
const SCENARIOS = {
    DELIVERED_NOT_RECEIVED: 'DELIVERED_NOT_RECEIVED',
    TRANSIT_DELAY_STUCK: 'TRANSIT_DELAY_STUCK',
    RTO_IN_TRANSIT: 'RTO_IN_TRANSIT',
    WRONG_PRODUCT: 'WRONG_PRODUCT',
    DAMAGED_DEFECTIVE: 'DAMAGED_DEFECTIVE',
    SIZE_EXCHANGE: 'SIZE_EXCHANGE',
    DISCRETIONARY_REFUND: 'DISCRETIONARY_REFUND',
    PREPAID_DOUBLE_CHARGE: 'PREPAID_DOUBLE_CHARGE',
    ADDRESS_CHANGE: 'ADDRESS_CHANGE',
    CANCELLATION: 'CANCELLATION',
    RETURN_PICKUP_DELAY: 'RETURN_PICKUP_DELAY',
    CUSTOMER_ESCALATION: 'CUSTOMER_ESCALATION',
    GENERAL_SOP: 'GENERAL_SOP'
};

/**
 * Codified Brand Standard Operating Procedures (SOPs)
 */
const BRAND_SOPS = {
    [SCENARIOS.DELIVERED_NOT_RECEIVED]: {
        title: 'Delivered But Not Received (False Delivery / Missing Package)',
        sop_section: 'SOP Section 2 (Delivered But Not Received Workflow)',
        rules: [
            '1. If courier tracking shows "Delivered" but customer denies receipt, advise customer to check with immediate neighbours, building security, or household members.',
            '2. Simultaneously, raise an NDR / False Delivery dispute ticket with the courier partner (Delhivery / Shiprocket / Ekart) requesting official Proof of Delivery (POD) including recipient signature and delivery geo-coordinates.',
            '3. Mandatory SLA Wait Window: 24 business hours for partner POD submission and field verification.',
            '4. If courier confirms non-delivery or POD is invalid/unsigned after 24h, initiate immediate free express replacement or 100% refund to original prepaid payment method.',
            '5. Do NOT mark order as refunded or reshipped before logging courier dispute and observing the 24h verification window.'
        ],
        timeframe: '24-hour partner POD SLA',
        resolution_path: 'POD verification -> Replacement or 100% Refund'
    },
    [SCENARIOS.TRANSIT_DELAY_STUCK]: {
        title: 'Shipment Delayed in Transit / Stuck Without Tracking Scans',
        sop_section: 'SOP Section 1 & 2 (Carrier Tracking & In-Transit Delay)',
        rules: [
            '1. Standard shipping transit SLA is 3–5 business days nationwide.',
            '2. Check tracking sequence: 1. Shiprocket, 2. Delhivery One, 3. Ekart (prepaid only).',
            '3. If package has no courier scan for >48 hours, mark as "Stuck in Transit" and raise priority escalation with courier account manager.',
            '4. If package is stuck >5 business days past estimated delivery date without resolution, declare transit loss: dispatch fresh replacement via priority air cargo or issue 100% refund if customer prefers.'
        ],
        timeframe: '48h scan threshold; 5 days past SLA for declared transit loss',
        resolution_path: 'Carrier escalation -> Priority air reshipment or refund'
    },
    [SCENARIOS.RTO_IN_TRANSIT]: {
        title: 'Shipment Return to Origin (RTO)',
        sop_section: 'SOP Section 3 & 6 (Post-RTO SOP Procedure)',
        rules: [
            '1. Prepaid RTO: Qualifies for 100% refund to original payment method (takes 5-7 business days) once returned to origin without customer receipt, OR OFFCOMFRT can dispatch a fresh replacement shipment if customer re-confirms delivery address and phone number.',
            '2. COD RTO: Zero refund is required because no payment was collected. Close order in Shoppers Hub as RTO. Re-attempt delivery or dispatch fresh order ONLY if customer re-confirms active intent and valid delivery address.',
            '3. If RTO is currently in transit, monitor tracking until warehouse check-in before releasing final refund.'
        ],
        timeframe: '5–7 business days for prepaid refund upon warehouse check-in',
        resolution_path: 'Prepaid: 100% refund or reshipment; COD: zero refund'
    },
    [SCENARIOS.WRONG_PRODUCT]: {
        title: 'Wrong Product or Variant Delivered',
        sop_section: 'SOP Section 5 (Wrong Product Verification & Resolution)',
        rules: [
            '1. Mandatory Proof: Customer must provide continuous uncut unboxing video showing outer courier label and product opening.',
            '2. Once verified by QA, order qualifies for immediate free reverse pickup and expedited dispatch of correct product.',
            '3. If correct product is out of stock, customer is entitled to 100% refund to original payment source or Store Credit based on customer choice.'
        ],
        timeframe: 'Report within 7 days of delivery; 24h verification SLA',
        resolution_path: 'Video verification -> Free exchange or 100% refund'
    },
    [SCENARIOS.DAMAGED_DEFECTIVE]: {
        title: 'Damaged, Torn, or Defective Item Received',
        sop_section: 'SOP Section 5 (Damaged Item Verification & Resolution)',
        rules: [
            '1. Mandatory Proof: Clear photos of damaged area, fabric defect, or tear alongside the brand tag and shipping label.',
            '2. Must be submitted via offcomfrt.in/pages/return within 48–72 hours of delivery.',
            '3. Once verified, customer qualifies for 100% refund to original payment method OR free immediate replacement.',
            '4. Reverse pickup arranged at zero extra cost to customer.'
        ],
        timeframe: 'Report within 72h of delivery; immediate replacement dispatch upon photo confirmation',
        resolution_path: 'Photo verification -> 100% refund or free replacement'
    },
    [SCENARIOS.SIZE_EXCHANGE]: {
        title: 'Size Change or Fit Exchange Request',
        sop_section: 'SOP Section 4 & 5 (Size Exchange Policy)',
        rules: [
            '1. Pre-dispatch: Customer can update size directly using "Edit Details" on WhatsApp Shoppers Hub confirmation message.',
            '2. Post-delivery: Request must be logged on returns portal (offcomfrt.in/pages/return) within 7 days of delivery.',
            '3. Garment must be unworn, unwashed, with original brand tags intact.',
            '4. Size exchanges receive a direct size replacement (e.g. M -> L) at zero shipping fee.',
            '5. If requested size is out of stock, customer receives 100% Store Credit (valid for 1 year).'
        ],
        timeframe: '7-day post-delivery window; 24-48h pickup arrangement',
        resolution_path: 'Returns portal request -> Reverse pickup -> Replacement dispatched'
    },
    [SCENARIOS.DISCRETIONARY_REFUND]: {
        title: 'Discretionary Return / Refund Request (No Defect / Change of Mind)',
        sop_section: 'SOP Section 3 & 5 (Refund Policy & Store Credit Gate)',
        rules: [
            '1. Original payment method refunds (cash/bank) are strictly restricted to: (a) Damaged on arrival, (b) Wrong product delivered, (c) Prepaid cancelled pre-dispatch, or (d) RTO undelivered.',
            '2. All other returns (dislike color/style, customer preference, change of mind) receive STORE CREDIT ONLY, valid for 1 year.',
            '3. Never promise a bank/cash refund for discretionary returns. Store credit coupon is issued automatically once returned item passes warehouse inspection.'
        ],
        timeframe: 'Store credit issued within 24h of warehouse inspection',
        resolution_path: 'Portal return -> Warehouse QC -> Store Credit Coupon'
    },
    [SCENARIOS.PREPAID_DOUBLE_CHARGE]: {
        title: 'Payment Discrepancy / Courier Collected Cash on Prepaid Order',
        sop_section: 'SOP Section 7 (Payment Reconciliation & Overcharge)',
        rules: [
            '1. If customer paid online via Razorpay/UPI but courier collected COD cash at doorstep (typically caused by discount drop during "Edit Details"):',
            '2. Verify Razorpay transaction ID and courier POD cash collection record.',
            '3. Instruct customer to provide UPI ID / bank details for excess cash refund.',
            '4. Process 100% refund of the extra amount collected to customer within 24–48 hours.'
        ],
        timeframe: '24–48 hours refund for verified overcharges',
        resolution_path: 'Reconcile gateway & courier -> Direct UPI/bank refund'
    },
    [SCENARIOS.ADDRESS_CHANGE]: {
        title: 'Customer Address Change Request',
        sop_section: 'SOP Section 8 (Address Modification Policy)',
        rules: [
            '1. Pre-dispatch: Customer can update delivery address via "Edit Details" on WhatsApp confirmation message or officer can update in Shoppers Hub.',
            '2. Post-dispatch: Active shipments in transit CANNOT have delivery address modified by carrier API.',
            '3. For Prepaid: Request courier return/recall, and dispatch a fresh replacement shipment to the corrected address immediately.',
            '4. For COD: Instruct customer to refuse original parcel at doorstep, and create a fresh order with updated address.'
        ],
        timeframe: 'Immediate action required before carrier handover',
        resolution_path: 'Pre-dispatch: Update Shoppers Hub; Post-dispatch: Reship to new address'
    },
    [SCENARIOS.CANCELLATION]: {
        title: 'Order Cancellation Request',
        sop_section: 'SOP Section 6 (Order Cancellation Workflow)',
        rules: [
            '1. Pre-dispatch: Cancel order in Shoppers Hub. For prepaid, trigger 100% refund via Shopify Admin API (reflects in 5-7 business days). For COD, simply update status to "Cancelled".',
            '2. Post-dispatch: If shipment has already left warehouse, shipment cannot be cancelled digitally. For Prepaid: mark courier recall in-transit and initiate refund once RTO scans. For COD: advise customer to refuse delivery when courier calls/arrives.'
        ],
        timeframe: 'Immediate cancellation in Shoppers Hub; 5-7 days for prepaid refund',
        resolution_path: 'Pre-dispatch cancel + refund; Post-dispatch recall/refuse'
    },
    [SCENARIOS.RETURN_PICKUP_DELAY]: {
        title: 'Reverse Return Pickup Delayed / Pending',
        sop_section: 'SOP Section 9 (Reverse Pickup SLA & Escalation)',
        rules: [
            '1. Standard Reverse Pickup SLA: 24 to 48 business hours from return approval.',
            '2. If pickup has not occurred within 48h, check courier partner status for pickup attempts or courier assignment.',
            '3. If courier partner failed pickup, re-trigger reverse pickup token via Shiprocket/Delhivery reverse portal.',
            '4. Remind customer that refunds/exchanges trigger ONLY after the item reaches warehouse and completes QC inspection.'
        ],
        timeframe: '24-48 business hours SLA',
        resolution_path: 'Courier reverse pickup re-trigger -> Warehouse check-in -> QC pass'
    },
    [SCENARIOS.CUSTOMER_ESCALATION]: {
        title: 'Customer Frustrated / Demanding Manager Callback',
        sop_section: 'SOP Section 10 (De-escalation & Supervisor Protocol)',
        rules: [
            '1. De-escalate over WhatsApp/chat first. Acknowledge customer frustration empathetically and apologize for the inconvenience.',
            '2. Never argue, deflect blame, or quote cold policy. State the exact factual next step and timeline.',
            '3. Do not arrange arbitrary manager callbacks without consulting admin: "We resolve all issues over chat first and consult admin for the best possible solution before arranging any call."',
            '4. If customer persists, compile comprehensive ticket summary (Order ID, issue timeline, promises made) and assign ticket to Level 2 supervisor.'
        ],
        timeframe: 'Immediate de-escalation; 2-hour supervisor escalation SLA',
        resolution_path: 'Empathetic chat de-escalation -> Factual summary -> Level 2 review'
    },
    [SCENARIOS.GENERAL_SOP]: {
        title: 'General Support & Operational Inquiry',
        sop_section: 'Brand General Support Framework',
        rules: [
            '1. Provide clear, objective, factual guidance aligned with OFFCOMFRT policies.',
            '2. Maintain neutral, professional tone without negative customer profiling.',
            '3. Direct customers to offcomfrt.in for standard self-service portal actions.'
        ],
        timeframe: 'Standard resolution SLA',
        resolution_path: 'Standard SOP guidance'
    }
};

/**
 * Step 1 & 2: Identify Operational Scenario from user query and context
 */
function identifyScenario(text, orderData = null, shipmentData = null) {
    const q = String(text || '').toLowerCase();

    // 1. Delivered but not received / missing item despite delivered scan
    if ((q.includes('delivered') && (q.includes('not received') || q.includes("didn't receive") || q.includes('never got') || q.includes('missing') || q.includes('not got') || q.includes('haven\'t received'))) ||
        (q.includes('fake delivery') || q.includes('false delivery') || q.includes('marked delivered'))) {
        return SCENARIOS.DELIVERED_NOT_RECEIVED;
    }

    // 2. Damaged / torn / defective item
    if (q.includes('damaged') || q.includes('defect') || q.includes('torn') || q.includes('stain') || q.includes('broken') || q.includes('cut')) {
        return SCENARIOS.DAMAGED_DEFECTIVE;
    }

    // 3. Wrong item / wrong product / wrong size delivered
    if (q.includes('wrong item') || q.includes('wrong product') || q.includes('received different') || q.includes('got wrong') || (q.includes('received size') && q.includes('instead of'))) {
        return SCENARIOS.WRONG_PRODUCT;
    }

    // 4. Return reverse pickup delayed
    if ((q.includes('pickup') || q.includes('reverse')) && (q.includes('delay') || q.includes('not picked') || q.includes('haven\'t picked') || q.includes('pending') || q.includes('when will they pick'))) {
        return SCENARIOS.RETURN_PICKUP_DELAY;
    }

    // 5. Size exchange
    if (q.includes('exchange') || (q.includes('size') && (q.includes('change') || q.includes('replace') || q.includes('too small') || q.includes('too large') || q.includes('tight') || q.includes('loose')))) {
        return SCENARIOS.SIZE_EXCHANGE;
    }

    // 6. Address change
    if (q.includes('address') && (q.includes('change') || q.includes('update') || q.includes('wrong address') || q.includes('new address') || q.includes('modify'))) {
        return SCENARIOS.ADDRESS_CHANGE;
    }

    // 7. Cancellation
    if (q.includes('cancel') || q.includes('cancellation')) {
        return SCENARIOS.CANCELLATION;
    }

    // 8. Overcharge / Double charge / Paid online but asked COD
    if (q.includes('double charge') || q.includes('charged twice') || (q.includes('paid online') && q.includes('cod')) || q.includes('courier asked cash') || q.includes('overcharg')) {
        return SCENARIOS.PREPAID_DOUBLE_CHARGE;
    }

    // 9. RTO
    if (q.includes('rto') || q.includes('returned to origin') || q.includes('failed delivery') || q.includes('undelivered')) {
        return SCENARIOS.RTO_IN_TRANSIT;
    }

    // 10. Transit delay / stuck
    if (q.includes('stuck') || (q.includes('delay') && (q.includes('shipment') || q.includes('order') || q.includes('delivery') || q.includes('tracking')))) {
        return SCENARIOS.TRANSIT_DELAY_STUCK;
    }

    // 11. Discretionary refund / changed mind
    if (q.includes('refund') && (q.includes('bank') || q.includes('cash') || q.includes('original') || q.includes('dislike') || q.includes('don\'t like') || q.includes('change of mind'))) {
        return SCENARIOS.DISCRETIONARY_REFUND;
    }

    // 12. Escalation / Manager call
    if (q.includes('call') || q.includes('manager') || q.includes('supervisor') || q.includes('escalat') || q.includes('angry') || q.includes('consumer court')) {
        return SCENARIOS.CUSTOMER_ESCALATION;
    }

    // Check live shipment data as fallback context
    if (shipmentData) {
        if (shipmentData.status === 'delivered') return SCENARIOS.DELIVERED_NOT_RECEIVED;
        if (shipmentData.status && shipmentData.status.includes('rto')) return SCENARIOS.RTO_IN_TRANSIT;
        if (shipmentData.is_delayed) return SCENARIOS.TRANSIT_DELAY_STUCK;
    }

    return SCENARIOS.GENERAL_SOP;
}

/**
 * Step 1, 2, 3, 4, 5: Master Decision Evaluation Pipeline
 */
async function evaluateNextAction({
    problemDescription,
    orderId = null,
    phone = null,
    customerIdentifier = null,
    customerFacingRequested = true
} = {}) {
    const timestamp = getIstTimestamp();
    const services = getServices();

    // Extract Order ID or phone from text if not explicitly provided
    let resolvedOrderId = orderId;
    let resolvedPhone = phone;

    if (!resolvedOrderId && problemDescription) {
        const ordMatch = problemDescription.match(/#?(\d{4,6})\b/);
        if (ordMatch) resolvedOrderId = ordMatch[1];
    }
    if (!resolvedPhone && problemDescription) {
        const phMatch = problemDescription.match(/\b([6-9]\d{9})\b/);
        if (phMatch) resolvedPhone = phMatch[1];
    }

    // Step 2: Retrieve Relevant Data across tables
    let orderData = null;
    let shipmentData = null;
    let returnData = null;
    let customerData = null;

    if (resolvedOrderId) {
        try {
            orderData = await services.orderIntelligenceService.investigateOrder(resolvedOrderId);
        } catch (e) {
            console.warn('⚠️ DecisionAssistant order lookup error:', e.message);
        }
        try {
            shipmentData = await services.shipmentIntelligenceService.getShipmentIntelligence(resolvedOrderId);
        } catch (e) {
            console.warn('⚠️ DecisionAssistant shipment lookup error:', e.message);
        }
        try {
            returnData = await services.returnInvestigationService.investigateReturnExchange(resolvedOrderId);
        } catch (e) {
            console.warn('⚠️ DecisionAssistant return lookup error:', e.message);
        }
    }

    const targetCustomer = resolvedPhone || (orderData && orderData.customer && orderData.customer.phone) || customerIdentifier;
    if (targetCustomer) {
        try {
            customerData = await services.customer360Service.getCustomer360(targetCustomer);
        } catch (e) {
            console.warn('⚠️ DecisionAssistant customer 360 error:', e.message);
        }
    }

    // Step 2 & 3: Identify Scenario & Retrieve SOP
    const scenarioKey = identifyScenario(problemDescription, orderData, shipmentData);
    const sop = BRAND_SOPS[scenarioKey] || BRAND_SOPS[SCENARIOS.GENERAL_SOP];

    // Step 2 & 5: Evaluate Conditions
    const isPrepaid = orderData?.payment?.is_prepaid || 
                     (orderData?.payment?.method && !orderData.payment.method.toLowerCase().includes('cod')) ||
                     (shipmentData?.payment_mode === 'Prepaid');
    const paymentMethodLabel = isPrepaid ? 'Prepaid (Paid Online)' : 'Cash on Delivery (COD)';
    const currentStatus = shipmentData?.status || orderData?.currentStatus || orderData?.status || 'Processing';
    const customerName = orderData?.customer?.name || customerData?.name || 'Customer';
    const awb = shipmentData?.awb || orderData?.shipment?.awb || 'Pending Assignment';
    const carrier = shipmentData?.carrier || orderData?.shipment?.carrier || 'Delhivery / Shiprocket';

    // Build Contextual Situation & Evidence
    let situationText = '';
    let evidenceItems = [];
    let immediateAction = '';
    let conditionalFollowUp = '';
    let safetyGuard = 'Never perform a financial refund, cancellation, or shipment reshipment automatically. Review and confirm in the appropriate operational portal.';
    let customerDraft = '';

    switch (scenarioKey) {
        case SCENARIOS.DELIVERED_NOT_RECEIVED:
            situationText = `Customer ${customerName} (Order #${resolvedOrderId || 'N/A'}, ${paymentMethodLabel}) states they have not received their package, but tracking indicates it was marked Delivered.`;
            evidenceItems = [
                `Carrier: ${carrier}`,
                `Tracking Number (AWB): ${awb}`,
                `Tracking Milestone: Delivered (${shipmentData?.delivered_at ? shipmentData.delivered_at : 'Timestamp recorded by carrier'})`,
                `Payment Status: ${paymentMethodLabel} (₹${orderData?.total_price || shipmentData?.cod_amount || 0})`,
                `Proof of Delivery (POD): Currently Not on File / Unverified`
            ];
            immediateAction = `1. Request the customer to verify with nearby flats, neighbours, building security, or reception desk.\n2. Immediately log a False Delivery / NDR Dispute with ${carrier} via carrier dashboard requesting official signed Proof of Delivery (POD) and GPS drop coordinates.\n3. Mark support ticket as "Pending Partner POD (24h SLA)".`;
            conditionalFollowUp = `If carrier fails to provide a valid signed POD within 24 hours, or confirms misdelivery:\n- For Prepaid: Initiate 100% refund to original payment source OR dispatch immediate free replacement from stock.\n- For COD: Dispatch fresh order to customer if customer still wishes to receive the item.`;
            customerDraft = `Hi ${customerName}, we apologize for the concern regarding your order #${resolvedOrderId || ''}. Our delivery partner's tracking system indicates this package was marked delivered; however, we take non-receipt reports very seriously. Could you please check with your security desk or neighbours in the meantime? We have officially raised an escalation with ${carrier} to obtain the signed Proof of Delivery (POD). We will update you with their findings within 24 hours to ensure this is resolved for you!`;
            break;

        case SCENARIOS.TRANSIT_DELAY_STUCK:
            situationText = `Customer ${customerName} reports an extended delivery delay for Order #${resolvedOrderId || 'N/A'}. Package is currently in transit without recent progress scans.`;
            evidenceItems = [
                `Carrier: ${carrier}`,
                `AWB: ${awb}`,
                `Current Shipment Status: ${currentStatus}`,
                `Payment Mode: ${paymentMethodLabel}`
            ];
            immediateAction = `1. Check carrier tracking sequence: verify latest status on Shiprocket, then Delhivery One.\n2. Raise an urgent transit escalation ticket with ${carrier} account support requesting priority movement.\n3. Inform customer that priority tracking is activated.`;
            conditionalFollowUp = `If package has zero movement for >5 business days past estimated delivery date, declare transit loss and offer customer immediate replacement dispatch or 100% refund.`;
            customerDraft = `Hi ${customerName}, thank you for reaching out regarding your order #${resolvedOrderId || ''}. We understand waiting for your parcel is frustrating. Your shipment is currently in transit with ${carrier} (AWB: ${awb}). We have placed a high-priority escalation with their logistics team to expedite clearance and delivery. We are monitoring this closely and will update you shortly!`;
            break;

        case SCENARIOS.RTO_IN_TRANSIT:
            situationText = `Order #${resolvedOrderId || 'N/A'} has failed delivery and is returned to origin (RTO).`;
            evidenceItems = [
                `Carrier: ${carrier}`,
                `AWB: ${awb}`,
                `RTO Status: ${currentStatus}`,
                `Payment Mode: ${paymentMethodLabel}`
            ];
            if (isPrepaid) {
                immediateAction = `1. Verify if customer still desires the order at a verified address OR prefers a full refund.\n2. If customer wants item: Re-confirm full street address and phone number, then book a fresh replacement shipment.\n3. If customer wants refund: Note that 100% refund will be processed back to their original payment method upon warehouse check-in (5-7 business days).`;
                conditionalFollowUp = `Once shipment checks in at warehouse, verify package integrity and execute refund via Shopify Admin / Razorpay.`;
                customerDraft = `Hi ${customerName}, tracking shows your order #${resolvedOrderId || ''} could not be delivered and is returning to our warehouse. Since this was a prepaid order, you are fully eligible for a 100% refund back to your original payment method (takes 5-7 business days once received), or we can gladly dispatch a fresh replacement to a reconfirmed address. Please let us know which option you prefer!`;
            } else {
                immediateAction = `1. Mark order status as "RTO" in Shoppers Hub.\n2. Note: COD orders receive ZERO refund as no funds were collected.\n3. If customer contacts wishing to receive items, dispatch fresh order only after customer confirms active delivery intent and verified address.`;
                conditionalFollowUp = `Restock items into inventory once physically checked in at warehouse.`;
                customerDraft = `Hi ${customerName}, your COD order #${resolvedOrderId || ''} was returned to origin by the courier as delivery could not be completed. Since this was Cash on Delivery, no payment was deducted. If you would still like to receive these items, please confirm your complete delivery address and we will gladly arrange a fresh order for you!`;
            }
            break;

        case SCENARIOS.WRONG_PRODUCT:
            situationText = `Customer ${customerName} states they received an incorrect item or variant for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Order Items: ${orderData?.line_items?.map(i => `${i.title} (${i.size || i.variant_title})`).join(', ') || 'N/A'}`,
                `Proof Required: Mandatory continuous unboxing video showing outer courier label and product opening`
            ];
            immediateAction = `1. Request customer to upload their uncut unboxing video at offcomfrt.in/pages/return or share via WhatsApp.\n2. Verify the unboxing video: check if label matches AWB ${awb} and item is genuinely mismatched.\n3. Check inventory stock for the originally ordered item.`;
            conditionalFollowUp = `Once video proof is verified:\n- If correct item in stock: Approve exchange and schedule free reverse pickup + dispatch replacement.\n- If correct item out of stock: Offer 100% original payment refund or Store Credit.`;
            customerDraft = `Hi ${customerName}, we are truly sorry for the mix-up with order #${resolvedOrderId || ''}! Per our company quality policy, please share a brief unboxing video showing the outer parcel label and the item received (you can upload it at offcomfrt.in/pages/return or send it here). Once our QA team confirms the mismatch, we will immediately arrange a free replacement or complete refund for you!`;
            break;

        case SCENARIOS.DAMAGED_DEFECTIVE:
            situationText = `Customer ${customerName} reports receiving a damaged, torn, or defective item for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Order Items: ${orderData?.line_items?.map(i => i.title).join(', ') || 'N/A'}`,
                `Proof Required: Clear photos of damaged area, brand tags, and parcel packaging`
            ];
            immediateAction = `1. Request customer to provide clear photos of the defect, brand tags, and courier label.\n2. Submit or approve claim in returns portal (offcomfrt.in/pages/return).\n3. Check warehouse stock for replacement availability.`;
            conditionalFollowUp = `Upon photo verification:\n- Customer is entitled to an immediate free replacement dispatch OR a 100% refund back to original payment source.\n- Schedule free reverse pickup for the damaged item.`;
            customerDraft = `Hi ${customerName}, we are so sorry that your item arrived damaged in order #${resolvedOrderId || ''}. We hold our products to the highest standards. Please share 2-3 clear photos showing the damaged area along with the brand tag. Once verified, we will immediately send you a brand new replacement or issue a 100% refund to your original payment method!`;
            break;

        case SCENARIOS.SIZE_EXCHANGE:
            situationText = `Customer ${customerName} is requesting a size or fit exchange for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Current Items: ${orderData?.line_items?.map(i => `${i.title} (${i.size || i.variant_title})`).join(', ') || 'N/A'}`,
                `Policy Window: Within 7 days of delivery`,
                `Exchange Fee: ₹0 (Free size exchange)`
            ];
            immediateAction = `1. Confirm whether item was delivered within the last 7 days and has original tags attached.\n2. Verify stock availability for the requested size in inventory.\n3. Direct customer to submit exchange request on offcomfrt.in/pages/return to generate reverse pickup token.`;
            conditionalFollowUp = `Reverse pickup will be scheduled within 24-48 hours. Once picked up and inspected at warehouse, the replacement size will be dispatched automatically.`;
            customerDraft = `Hi ${customerName}, we are happy to help you get the perfect fit for order #${resolvedOrderId || ''}! We offer size exchanges within 7 days of delivery as long as tags remain intact. Please head to offcomfrt.in/pages/return to select your desired replacement size, and our courier partner will pick up the current item from your doorstep!`;
            break;

        case SCENARIOS.DISCRETIONARY_REFUND:
            situationText = `Customer ${customerName} wants a cash or bank refund for Order #${resolvedOrderId || 'N/A'} due to change of mind or personal preference.`;
            evidenceItems = [
                `Policy: SOP Section 3 & 5 (Store Credit for Discretionary Returns)`,
                `Original Payment Refunds: Strictly restricted to Damaged/Wrong items, pre-dispatch cancellations, or undelivered RTOs`
            ];
            immediateAction = `1. Politely inform customer of the brand policy: discretionary returns qualify for Store Credit (valid 1 year for any item), not bank refunds.\n2. Guide customer to log their return request on offcomfrt.in/pages/return.\n3. Explain that store credit coupon will be emailed within 24 hours of warehouse QC check.`;
            conditionalFollowUp = `Do NOT promise a bank transfer or UPI refund under any circumstances for discretionary returns.`;
            customerDraft = `Hi ${customerName}, thank you for contacting us. Under our return policy, standard returns where the item is undamaged qualify for Store Credit (valid for 1 full year across our entire collection). You can log your return request at offcomfrt.in/pages/return. Once the item is received and passes inspection, your store credit voucher will be sent to you immediately!`;
            break;

        case SCENARIOS.PREPAID_DOUBLE_CHARGE:
            situationText = `Customer ${customerName} was charged twice or courier collected cash on a prepaid order for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Prepaid Amount: ₹${orderData?.total_price || 0}`,
                `COD Collected: Check courier POD collection receipt`
            ];
            immediateAction = `1. Reconcile Razorpay online payment transaction with courier cash collection status.\n2. Confirm the exact excess amount collected from the customer.\n3. Request customer's UPI ID / bank details to initiate overcharge refund.`;
            conditionalFollowUp = `Process direct UPI refund for the excess amount within 24-48 business hours and share payment screenshot with customer.`;
            customerDraft = `Hi ${customerName}, we sincerely apologize for the payment discrepancy on order #${resolvedOrderId || ''}. We are verifying the transaction with our payment gateway and delivery partner right now. Please share your UPI ID or bank account details, and we will refund the excess amount collected directly back to you within 24–48 hours!`;
            break;

        case SCENARIOS.ADDRESS_CHANGE:
            situationText = `Customer ${customerName} is requesting a delivery address change for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Fulfillment Status: ${orderData?.fulfillment_status || currentStatus}`,
                `Carrier AWB: ${awb}`
            ];
            if (currentStatus === 'Processing' || !shipmentData?.awb) {
                immediateAction = `1. Update the shipping address immediately in Shoppers Hub and Shopify Admin before manifest creation.\n2. Re-verify the updated address with the customer.`;
                conditionalFollowUp = `Ensure warehouse team prints the updated shipping label prior to handover.`;
                customerDraft = `Hi ${customerName}, we have received your updated delivery address and successfully updated your order #${resolvedOrderId || ''} before dispatch! Your parcel will be shipped to your new address.`;
            } else {
                immediateAction = `1. Note that active shipments with assigned AWB ${awb} cannot be redirected in transit by the carrier.\n2. For Prepaid: Log courier recall and dispatch a fresh replacement shipment to the updated address.\n3. For COD: Instruct customer to refuse original parcel at doorstep, and create a fresh order with updated address.`;
                conditionalFollowUp = `Track original shipment until it confirms RTO return.`;
                customerDraft = `Hi ${customerName}, your order #${resolvedOrderId || ''} has already been dispatched with ${carrier} (AWB: ${awb}), and delivery partners cannot alter destination addresses once in transit. To resolve this: ${isPrepaid ? 'we will arrange a fresh replacement shipment to your new address while recalling the original package.' : 'please simply refuse the package when the courier calls, and we will place a fresh order for you with your updated address!'}`;
            }
            break;

        case SCENARIOS.CANCELLATION:
            situationText = `Customer ${customerName} is requesting cancellation for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Fulfillment Status: ${currentStatus}`,
                `Payment Mode: ${paymentMethodLabel}`
            ];
            if (currentStatus === 'Processing' || !shipmentData?.awb) {
                immediateAction = `1. Cancel order immediately in Shoppers Hub.\n2. For Prepaid: Process 100% refund via Shopify Admin API (5-7 business days).\n3. For COD: Mark status as "Cancelled" with zero refund required.`;
                conditionalFollowUp = `Confirm cancellation email / WhatsApp notification sent to customer.`;
                customerDraft = `Hi ${customerName}, your cancellation request for order #${resolvedOrderId || ''} has been processed. ${isPrepaid ? 'Since this was a prepaid order, a 100% refund has been initiated to your original payment method and will reflect in your account within 5-7 business days.' : 'Since this was Cash on Delivery, no payment was deducted.'}`;
            } else {
                immediateAction = `1. Shipment has already been handed over to courier. Inform customer that in-transit parcels cannot be cancelled digitally.\n2. Instruct customer to simply refuse delivery at the doorstep when courier attempts.\n3. For Prepaid: Monitor RTO status to release 100% refund once package returns.`;
                conditionalFollowUp = `Once RTO is marked delivered at warehouse, process prepaid refund.`;
                customerDraft = `Hi ${customerName}, your order #${resolvedOrderId || ''} has already left our warehouse with the courier. Please simply refuse delivery when the delivery executive arrives at your doorstep. Once the package returns to us, we will close the order ${isPrepaid ? 'and process your 100% refund to your original payment method.' : '.'}`;
            }
            break;

        case SCENARIOS.RETURN_PICKUP_DELAY:
            situationText = `Customer ${customerName} states reverse return pickup has not occurred for Order #${resolvedOrderId || 'N/A'}.`;
            evidenceItems = [
                `Reverse Pickup SLA: 24–48 business hours`,
                `Return Status: ${returnData?.returns?.[0]?.status || 'Pending Pickup'}`
            ];
            immediateAction = `1. Check reverse pickup token and courier assignment on Shiprocket/Delhivery reverse logistics panel.\n2. Re-trigger the pickup request with the carrier and flag as overdue.\n3. Reassure customer of the revised pickup date.`;
            conditionalFollowUp = `Monitor reverse AWB until courier successfully collects the parcel from customer.`;
            customerDraft = `Hi ${customerName}, thank you for your patience. Our reverse pickup SLA is 24-48 business hours. We apologize that the courier has not arrived yet. We have re-escalated your pickup request with our logistics team for priority collection within the next 24 hours. Please keep the item packed with original tags intact!`;
            break;

        case SCENARIOS.CUSTOMER_ESCALATION:
            situationText = `Customer ${customerName} is dissatisfied, demanding a manager callback or threatening formal escalation.`;
            evidenceItems = [
                `Lifetime Orders: ${customerData?.total_orders || 1}`,
                `Customer Since: ${customerData?.customer_since || 'Recent customer'}`,
                `Open Tickets: ${customerData?.open_issues || 'Active issue'}`
            ];
            immediateAction = `1. Empathetically acknowledge customer frustration over WhatsApp/chat: "We resolve all issues over chat first and consult admin for the best possible solution before arranging any call."\n2. Provide clear, objective next step with exact timeline.\n3. Compile comprehensive ticket dossier and assign ticket to Senior Support Supervisor.`;
            conditionalFollowUp = `If unresolved within 2 hours, supervisor conducts direct phone callback.`;
            customerDraft = `Hi ${customerName}, I completely understand your frustration, and I sincerely apologize for the inconvenience caused. We want to resolve this for you as quickly as possible. We handle all investigations over chat first so our management team has a complete written record to provide the best resolution. I am personally overseeing your case and coordinating with our operations lead. May I confirm the key details so we can get this sorted for you today?`;
            break;

        default:
            situationText = `General operational inquiry regarding customer issue or standard brand process.`;
            evidenceItems = [`Order context: ${resolvedOrderId || 'Not specified'}`];
            immediateAction = `1. Retrieve order or customer details to evaluate specific facts.\n2. Apply applicable SOP clause based on customer request.\n3. Guide customer to appropriate self-service portal (offcomfrt.in).`;
            conditionalFollowUp = `Follow standard customer care workflow.`;
            customerDraft = `Hi ${customerName}, thank you for contacting OFFCOMFRT support! How can we assist you with your order today?`;
            break;
    }

    const decision = {
        query_type: 'next_action_recommendation',
        timestamp,
        order_id: resolvedOrderId,
        phone: resolvedPhone || targetCustomer,
        scenario: scenarioKey,
        scenario_title: sop.title,
        situation: situationText,
        evidence: evidenceItems,
        applicable_policy: {
            sop_section: sop.sop_section,
            rules: sop.rules,
            timeframe: sop.timeframe,
            resolution_path: sop.resolution_path
        },
        recommended_action: {
            immediate_step: immediateAction,
            conditional_follow_up: conditionalFollowUp,
            safety_guard: safetyGuard
        },
        customer_facing_response: customerDraft,
        action_executed: false,
        requires_manual_confirmation: true
    };

    return decision;
}

/**
 * Step 4: Format Decision Report in standard structured output
 */
function formatDecisionReport(decision) {
    if (!decision) return 'No decision support data available.';
    const ts = decision.timestamp || getIstTimestamp();

    const evidenceList = (decision.evidence || []).map(e => `- ${e}`).join('\n');
    const policyRules = (decision.applicable_policy?.rules || []).join('\n');

    return `### 🎯 Next-Action Decision Report
*Generated: ${ts}*

#### 1. Situation
${decision.situation}

#### 2. Evidence
${evidenceList || '- None recorded'}

#### 3. Applicable Policy
**${decision.applicable_policy?.sop_section || 'Standard Brand SOP'}**
- **SLA / Timeframe**: ${decision.applicable_policy?.timeframe || 'Standard SLA'}
- **Resolution Path**: ${decision.applicable_policy?.resolution_path || 'Standard Path'}

*SOP Guidelines*:
${policyRules}

#### 4. Recommended Action
**Immediate Step (Officer Action)**:
${decision.recommended_action?.immediate_step}

**Conditional Follow-up**:
${decision.recommended_action?.conditional_follow_up}

> [!WARNING]
> **Safety Guard (Human-in-the-Loop)**: ${decision.recommended_action?.safety_guard}
> *Action Executed: false. This is decision support only.*

#### 5. Customer-Facing Response (Ready to Send)
\`\`\`text
${decision.customer_facing_response}
\`\`\`
`;
}

module.exports = {
    evaluateNextAction,
    identifyScenario,
    formatDecisionReport,
    SCENARIOS,
    BRAND_SOPS
};
