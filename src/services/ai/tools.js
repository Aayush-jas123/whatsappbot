/**
 * AI Copilot tool registry (whatsappbot).
 *
 * Each tool: { name, description, parameters (JSON Schema), requiresConfirmation,
 *              summary(args) — human-readable action description,
 *              execute(args, ctx) — runs the tool and returns a JSON-serializable result }
 *
 * Tools marked requiresConfirmation are NEVER executed directly by the agent loop;
 * they are stored as pending actions and executed only after an explicit admin confirm.
 */

const axios = require('axios');
const { dbAdapter } = require('../../database/db');
const Settings = require('../../models/Settings');

const MAX_ROWS = 100;

function truncateRows(rows, limit = MAX_ROWS) {
    if (!Array.isArray(rows)) return rows;
    return rows.length > limit ? rows.slice(0, limit) : rows;
}

// ---------- SELECT-only SQL guard ----------

const SQL_BLOCKLIST = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|do|call|execute|prepare|listen|notify|set|reset|comment|refresh|reindex|cluster|lock|merge)\b/i;

function validateReadOnlySql(sql) {
    if (!sql || typeof sql !== 'string') return 'SQL query is required';
    const trimmed = sql.trim();
    if (trimmed.includes(';')) return 'Multiple statements / semicolons are not allowed';
    const noComments = trimmed.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^(select|with)\b/i.test(noComments)) return 'Only SELECT queries are allowed';
    if (SQL_BLOCKLIST.test(noComments)) return 'Query contains a blocked keyword — only read-only SELECT queries are allowed';
    return null;
}

// ---------- Tool definitions ----------

const tools = [
    {
        name: 'query_stats',
        description: 'Get high-level dashboard statistics: total customers, orders, messages, open support tickets, pending abandoned carts.',
        parameters: { type: 'object', properties: {}, required: [] },
        requiresConfirmation: false,
        async execute() {
            const [customers, orders, messages, tickets, carts] = await Promise.all([
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM customers'),
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM orders'),
                dbAdapter.query('SELECT COUNT(*)::int AS c FROM messages'),
                dbAdapter.query(`SELECT COUNT(*)::int AS c FROM support_tickets WHERE status = 'open'`),
                dbAdapter.query(`SELECT COUNT(*)::int AS c FROM abandoned_carts WHERE status = 'pending'`)
            ]);
            return {
                totalCustomers: customers[0]?.c || 0,
                totalOrders: orders[0]?.c || 0,
                totalMessages: messages[0]?.c || 0,
                openTickets: tickets[0]?.c || 0,
                pendingAbandonedCarts: carts[0]?.c || 0
            };
        }
    },
    {
        name: 'search_customers',
        description: 'Search customers by name, phone or email (partial match). Returns up to 20 matches with order counts.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name, phone digits or email fragment to search for' }
            },
            required: ['query']
        },
        requiresConfirmation: false,
        async execute({ query }) {
            const q = `%${String(query).trim()}%`;
            const rows = await dbAdapter.query(
                `SELECT phone, name, email, order_count, created_at FROM customers
                 WHERE phone ILIKE ? OR name ILIKE ? OR email ILIKE ?
                 ORDER BY updated_at DESC NULLS LAST LIMIT 20`,
                [q, q, q]
            );
            return { count: rows.length, customers: rows };
        }
    },
    {
        name: 'get_customer_360',
        description: 'Get comprehensive, factual Customer 360 intelligence: total orders, delivered orders, cancelled orders, returned orders, exchanged orders, total spend, refund history, latest order, active open orders, and open support issues. Accepts customer phone number, order ID (#12345), email, or customer name.',
        parameters: {
            type: 'object',
            properties: {
                customerIdentifier: { type: 'string', description: 'Customer phone number, order ID (#12345), email, or customer name' }
            },
            required: ['customerIdentifier']
        },
        requiresConfirmation: false,
        async execute({ customerIdentifier }, ctx) {
            const { getCustomer360 } = require('../customer360Service');
            return await getCustomer360(customerIdentifier, ctx);
        }
    },
    {
        name: 'get_conversation_history',
        description: 'Retrieve and summarize previous customer support interactions across WhatsApp messages, support tickets, and notes. Answers what customer said, when they last contacted us, what resolution was given, explicit commitments/promises made, and whether this is a repeat issue. Accepts customer phone, order ID (#12345), ticket number (TKT-...), email, or name.',
        parameters: {
            type: 'object',
            properties: {
                customerIdentifier: { type: 'string', description: 'Customer phone number, order ID (#12345), ticket number (TKT-...), email, or customer name' },
                query: { type: 'string', description: 'Optional question or focus area (e.g. "what was promised", "last contact date")' }
            },
            required: ['customerIdentifier']
        },
        requiresConfirmation: false,
        async execute({ customerIdentifier, query }, ctx) {
            const { getCustomerConversationHistory } = require('../conversationHistoryService');
            return await getCustomerConversationHistory(customerIdentifier, { query, ...ctx });
        }
    },
    {
        name: 'get_customer_behavior_patterns',
        description: 'Identify factual customer behavior and history patterns: number of orders, returns, exchanges, cancellations, RTOs, support contacts, and repeat issue categories. Answers "Has this customer had the same issue before?", "How many size-related complaints did they have?", and "How many returns did this customer make?". Strictly neutral, objective reporting without defamatory labels.',
        parameters: {
            type: 'object',
            properties: {
                customerIdentifier: { type: 'string', description: 'Customer phone number, order ID (#12345), ticket number (TKT-...), email, or customer name' },
                currentIssue: { type: 'string', description: 'Optional current or queried issue (e.g. "size", "delayed delivery", "defect") to check for previous recurrence' }
            },
            required: ['customerIdentifier']
        },
        requiresConfirmation: false,
        async execute({ customerIdentifier, currentIssue }, ctx) {
            const { getCustomerBehaviorPatterns } = require('../customerBehaviorService');
            return await getCustomerBehaviorPatterns(customerIdentifier, { currentIssue, ...ctx });
        }
    },
    {
        name: 'detect_repeat_contact',
        description: 'Detect when the same customer repeatedly contacts support about the same order or problem. Correlates customer + order + issue category + time. Shows number of previous contacts, previous contact dates, previous actions taken, and current unresolved issue. Strictly follows company escalation rules without auto-escalating.',
        parameters: {
            type: 'object',
            properties: {
                customerIdentifier: { type: 'string', description: 'Customer phone number, order ID (#12345), ticket number (TKT-...), email, or customer name' },
                orderId: { type: 'string', description: 'Optional specific order ID to check repeat contact for' },
                currentIssue: { type: 'string', description: 'Optional current message or issue description to evaluate' },
                issueCategory: { type: 'string', description: 'Optional issue category if already identified' }
            },
            required: ['customerIdentifier']
        },
        requiresConfirmation: false,
        async execute({ customerIdentifier, orderId, currentIssue, issueCategory }, ctx) {
            const { detectRepeatContact } = require('../repeatContactService');
            return await detectRepeatContact(customerIdentifier, { orderId, currentIssue, issueCategory, ...ctx });
        }
    },
    {
        name: 'get_sales_by_sku',
        description: 'Get real-time product- and SKU-level sales analytics: units sold, best-selling SKUs, top revenue generators, and variant breakdowns. Answers "How many units of SKU X sold today?", "What are today\'s best-selling SKUs?", "Which SKU sold the most this week?", and "Which SKU generated the highest revenue?". Timezone is strictly India Standard Time (IST, UTC+05:30) and all data is explicitly timestamped.',
        parameters: {
            type: 'object',
            properties: {
                dateRange: {
                    type: 'string',
                    description: 'Date range to analyze: "today", "yesterday", "this_week", "last_7_days", "this_month", or "all_time" (default "today" in IST)'
                },
                skuOrProduct: {
                    type: 'string',
                    description: 'Optional SKU or product name to filter (e.g. "HENLEY - 001", "waffle-001-w-m", "SLUB - 001")'
                },
                sortBy: {
                    type: 'string',
                    enum: ['units', 'revenue'],
                    description: 'Sort by "units" (quantity sold) or "revenue" (gross sales amount in INR, default "units")'
                },
                limit: {
                    type: ['integer', 'string'],
                    description: 'Max results to return (default 10)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ dateRange, skuOrProduct, sortBy, limit }, ctx) {
            const { getSalesBySku } = require('../skuSalesService');
            return await getSalesBySku({ dateRange, skuOrProduct, sortBy, limit: parseInt(limit, 10) || 10, ...ctx });
        }
    },
    {
        name: 'get_size_wise_sales',
        description: 'Get real-time sales analytics broken down by size, variant, and colour. Answers questions like: "How many units of size M were sold today?", "Which size sells the most for SKU X?", "Give me today\'s sales breakdown by size.", "Did we sell more M or L this week?", "Compare size-wise sales this week with last week.", "How many Black M units were sold today?", "Which sizes had zero sales today?", "What\'s our best-selling size this month?", and "Which size should we stock more of?". All timezones are strictly India Standard Time (IST, UTC+05:30) and data is explicitly timestamped.',
        parameters: {
            type: 'object',
            properties: {
                size: {
                    type: 'string',
                    description: 'Specific size to query or filter (e.g. "M", "L", "XL", "XS", "XXL", "28", "30", "Free Size")'
                },
                color: {
                    type: 'string',
                    description: 'Specific colour to filter (e.g. "Black", "White", "Acid Wash", "Grey", "Sage")'
                },
                sku: {
                    type: 'string',
                    description: 'Specific SKU or product identifier (e.g. "henley-001-b-m", "waffle-001")'
                },
                product: {
                    type: 'string',
                    description: 'Product name or title (e.g. "HENLEY - 001", "WAFFLE - 001", "SLUB - 001")'
                },
                dateRange: {
                    type: 'string',
                    description: 'Time period to analyze: "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days", or "custom"'
                },
                comparePeriod: {
                    type: 'string',
                    description: 'Period to compare against (e.g. "last_week" when querying "this_week", "last_month" when querying "this_month")'
                },
                compareSizes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of two sizes to compare directly, e.g. ["M", "L"]'
                },
                startDate: {
                    type: 'string',
                    description: 'Custom start date (ISO string or YYYY-MM-DD)'
                },
                endDate: {
                    type: 'string',
                    description: 'Custom end date (ISO string or YYYY-MM-DD)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute(params, ctx) {
            const { getSizeWiseSales } = require('../sizeSalesService');
            return await getSizeWiseSales({ ...params, ...ctx });
        }
    },
    {
        name: 'get_product_sku_info',
        description: 'Get authoritative product, variant, and SKU information from the product catalog. Answers: "What variants exist for product X?", "What is the SKU for Size L?", "Is SKU X active?", "What sizes exist for this product?", "Show price and stock for SKU X", "Is this product available in colour Y?". Returns Product -> Variant -> SKU -> Size -> Colour -> Price -> Stock mapping, active status, and availability.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Product name, variant, or search keyword (e.g. "HENLEY - 001", "Waffle", "Acid Wash")'
                },
                sku: {
                    type: 'string',
                    description: 'Specific SKU code to look up directly (e.g. "henley-001-w-l", "waffle-001-b-m")'
                },
                productId: {
                    type: 'string',
                    description: 'Shopify or system product ID'
                },
                handle: {
                    type: 'string',
                    description: 'Product slug/handle (e.g. "henley-001-b")'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ query, sku, productId, handle }, ctx) {
            const { getProductInfo, getVariantBySku } = require('../productInfoService');
            if (sku && !query && !productId && !handle) {
                return await getVariantBySku(sku);
            }
            return await getProductInfo({ query, sku, productId, handle });
        }
    },
    {
        name: 'get_inventory_intelligence',
        description: 'Get live inventory intelligence: stock levels by SKU, size, colour, product; detect low-stock items using configured reorder_level (NOT hardcoded constants); detect out-of-stock items; calculate sales velocity and run-out days; and provide restocking recommendations. Answers: "How much stock do we have for SKU X?", "Which sizes are out of stock for product Y?", "What items are low in stock?", "Do we have size L in stock for this shirt?", "Show inventory breakdown for product X", "When will SKU X run out of stock?", "Which SKUs need restocking urgently?".',
        parameters: {
            type: 'object',
            properties: {
                sku: {
                    type: 'string',
                    description: 'Filter by specific SKU code'
                },
                productName: {
                    type: 'string',
                    description: 'Filter by product name (e.g. "HENLEY - 001", "WAFFLE - 001")'
                },
                size: {
                    type: 'string',
                    description: 'Filter by size (e.g. "XS", "S", "M", "L", "XL")'
                },
                color: {
                    type: 'string',
                    description: 'Filter by colour (e.g. "Black", "White", "Acid Wash")'
                },
                category: {
                    type: 'string',
                    description: 'Filter by category (e.g. "T-SHIRT")'
                },
                queryType: {
                    type: 'string',
                    enum: ['stock', 'low_stock', 'out_of_stock', 'demand_analysis', 'restock_recommendations'],
                    description: 'Type of inventory query: "stock" (default), "low_stock" (quantity <= reorder_level), "out_of_stock" (quantity <= 0), "demand_analysis" (sales velocity and run-out days), or "restock_recommendations"'
                },
                days: {
                    type: ['integer', 'string'],
                    description: 'Number of past days to analyze sales velocity for demand calculations (default 30)'
                },
                limit: {
                    type: ['integer', 'string'],
                    description: 'Maximum items to return (default 50)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ sku, productName, size, color, category, queryType = 'stock', days, limit }, ctx) {
            const iis = require('../inventoryIntelligenceService');
            const nLimit = parseInt(limit, 10) || 50;
            const nDays = parseInt(days, 10) || 30;

            if (queryType === 'low_stock') {
                return await iis.getLowStockItems({ limit: nLimit, category, size });
            }
            if (queryType === 'out_of_stock') {
                return await iis.getOutOfStockItems({ limit: nLimit, category });
            }
            if (queryType === 'demand_analysis') {
                return await iis.analyzeStockVsDemand({ sku, productName, days: nDays });
            }
            if (queryType === 'restock_recommendations') {
                return await iis.getRestockingRecommendations({ limit: nLimit });
            }
            return await iis.getInventoryStock({ sku, productName, size, color, category, limit: nLimit });
        }
    },
    {
        name: 'investigate_return_exchange',
        description: 'Conduct a comprehensive case investigation for returns, exchanges, refunds, replacements, or damaged/wrong product claims. Cross-references orders, returns table, exchanges table, support tickets, and SOP policies. Checks proof requirements (unboxing video mandatory for wrong product, photos for damaged product), verifies return window, evaluates refund eligibility (store credit vs original payment), reconstructs chronological event timeline, and checks live replacement stock for size exchange requests (e.g. customer wants size L for order #1234). If no orderId or phone is provided (e.g. "tell me 5 exchange list that are most recent", "list recent exchanges"), automatically retrieves the 5 most recent return and exchange cases from the live database. Demarcates VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION RECOMMENDED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                requestId: {
                    type: 'string',
                    description: 'Return or exchange request ID (e.g. "REQ-12345", "RET-101")'
                },
                targetExchangeVariant: {
                    type: 'string',
                    description: 'Target size or replacement variant requested by customer (e.g. "L", "XL", "Black / L")'
                },
                reason: {
                    type: 'string',
                    description: 'Stated reason or complaint (e.g. "Size M too small, need L", "Wrong item delivered", "Damaged on arrival")'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, phone, requestId, targetExchangeVariant, reason }, ctx) {
            const ris = require('../returnInvestigationService');
            return await ris.investigateReturnExchange({ orderId, phone, requestId, targetExchangeVariant, reason });
        }
    },
    {
        name: 'check_refund_eligibility',
        description: 'Evaluate authoritative refund eligibility for an order based on OFFCOMFRT SOP rules (Sections 3, 5, 6, 7, 8). Determines refund channel: STORE CREDIT vs ORIGINAL PAYMENT METHOD vs DIFFERENCE REFUND. Checks policy gates: 2-day return window, delivery status, damaged on arrival (photos required), wrong product delivered (uncut unboxing video MANDATORY), prepaid cancelled pre-dispatch, prepaid RTO, and reverse pickup logistics charge (Rs. 100). Emits structured breakdown with VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                reason: {
                    type: 'string',
                    description: 'Stated reason: "damaged", "wrong_item", "size_issue", "prepaid_cancel", "prepaid_rto", "cancellation", "buyer_remorse", etc.'
                },
                hasPhotos: {
                    type: 'boolean',
                    description: 'Whether photos of the received item/defect were provided'
                },
                hasUnboxingVideo: {
                    type: 'boolean',
                    description: 'Whether an uncut unboxing video showing shipping label was provided'
                },
                cancelledPreDispatch: {
                    type: 'boolean',
                    description: 'Whether order was cancelled prior to courier dispatch'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, phone, reason, hasPhotos, hasUnboxingVideo, cancelledPreDispatch }, ctx) {
            const { checkRefundEligibility } = require('../refundEligibilityService');
            return await checkRefundEligibility({ orderId, phone, reason, hasPhotos, hasUnboxingVideo, cancelledPreDispatch });
        }
    },
    {
        name: 'investigate_refund_status',
        description: 'Investigate live refund status and actual progress across returns, store_shoppers, and Shopify records. Reconstructs a 7-stage chronological refund timeline (REQUEST_SUBMITTED -> PICKUP_SCHEDULED -> REVERSE_PICKUP_DONE -> QC_VERIFIED -> REFUND_INITIATED -> GATEWAY_PROCESSING -> COMPLETED). Evaluates SOP 5-7 business day banking clearance window, detects pending actions, and flags overdue refunds. Emits status with VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, ACTION COMPLETED, and ACTION PENDING.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                refundId: {
                    type: 'string',
                    description: 'Refund or return ID (e.g. "REF-12345", "RET-101")'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, phone, refundId }, ctx) {
            const { investigateRefundStatus } = require('../refundStatusService');
            return await investigateRefundStatus({ orderId, phone, refundId });
        }
    },
    {
        name: 'investigate_payment',
        description: 'Investigate payment reconciliation, order total vs paid vs pending amounts, and detect payment discrepancies. Investigates the Shoppers Hub COD conversion case where customer clicked "Edit Details" on a prepaid discounted order, dropping the discount and converting order to COD with higher collectible amount. Calculates courier payment collected vs expected price, and identifies difference amount to refund. Emits structured report with VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                paymentMode: {
                    type: 'string',
                    description: 'Payment mode if known ("prepaid", "cod", "upi")'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, phone, paymentMode }, ctx) {
            const { investigatePayment } = require('../paymentInvestigationService');
            return await investigatePayment({ orderId, phone, paymentMode });
        }
    },
    {
        name: 'investigate_discount',
        description: 'Investigate coupon codes, percentage/fixed discounts, line item discount allocations, and discount drop issues during order editing. Specifically detects when an order edit in Shopify/Shoppers Hub removed a coupon code (e.g. OFF10), leading to courier overcharging on COD delivery. Calculates exact overcharge difference to refund to customer. Emits structured report with VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                couponCode: {
                    type: 'string',
                    description: 'Coupon code to inspect (e.g. "OFF10", "WELCOME15")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, couponCode, phone }, ctx) {
            const { investigateDiscount } = require('../discountInvestigationService');
            return await investigateDiscount({ orderId, couponCode, phone });
        }
    },
    {
        name: 'get_shipment_intelligence',
        description: 'Get comprehensive carrier and shipment intelligence: full 8-stage lifecycle timeline, delay detection, stuck-in-transit analysis, RTO detection and root causes, carrier performance comparison, and SOP carrier priority sequence (1. Shiprocket -> 2. Delhivery One -> 3. Ekart for prepaid). Implements the 24-hour POD "Delivered but not received" SOP workflow (check neighbours/security -> notify carrier -> request POD -> wait 24h -> share POD). Emits structured breakdown with VERIFIED FACT, POLICY, INFERENCE / RECOMMENDATION, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                awb: {
                    type: 'string',
                    description: 'Carrier tracking/AWB number'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                deliveredNotReceived: {
                    type: 'boolean',
                    description: 'Set true if customer states package marked delivered but was not received'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, awb, phone, deliveredNotReceived }, ctx) {
            const { getShipmentIntelligence } = require('../shipmentIntelligenceService');
            return await getShipmentIntelligence({ orderId, awb, phone, deliveredNotReceived });
        }
    },
    {
        name: 'investigate_rto',
        description: 'Investigate an order that is at risk of RTO, in the process of RTO, marked RTO, or completed RTO. Reconstructs full chronological milestone timeline, delivery attempts and failed delivery reasons, customer support interactions, payment method (Prepaid vs COD), and authoritative post-RTO SOP rules (100% refund for prepaid; zero refund for COD). Emits structured breakdown with VERIFIED FACT, POLICY, INFERENCE, RECOMMENDATION, ACTION COMPLETED, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                awb: {
                    type: 'string',
                    description: 'Carrier tracking/AWB number'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                },
                rtoReason: {
                    type: 'string',
                    description: 'Known or suspected RTO reason if mentioned by officer'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, awb, phone, rtoReason }, ctx) {
            const { investigateRto } = require('../rtoInvestigationService');
            return await investigateRto({ orderId, awb, phone, rtoReasonOverride: rtoReason });
        }
    },
    {
        name: 'get_courier_analytics',
        description: 'Analyze historical courier performance across Delhivery, Ekart, and Shiprocket using authoritative shipment data. Computes delivery success rates, RTO rates, delay rates, average transit times, period comparisons (this month vs last month, weekly), head-to-head courier comparisons, and pincode-specific delivery performance with minimum sample size gating (N >= 10). Emits report with VERIFIED FACT, PATTERN, INFERENCE, and RECOMMENDATION.',
        parameters: {
            type: 'object',
            properties: {
                period: {
                    type: 'string',
                    description: 'Time period: "today", "this_week", "last_week", "this_month", "last_month", or "all"'
                },
                courier: {
                    type: 'string',
                    description: 'Specific courier name (e.g. "Delhivery", "Ekart", "Shiprocket")'
                },
                compareCourier: {
                    type: 'string',
                    description: 'Second courier name for head-to-head comparison'
                },
                comparePeriod: {
                    type: 'string',
                    description: 'Comparison period (e.g. "last_month", "last_week")'
                },
                pincode: {
                    type: 'string',
                    description: '6-digit destination pincode to analyze'
                },
                metric: {
                    type: 'string',
                    description: 'Ranking metric: "delivery_success_rate", "lowest_rto_rate", "fastest_delivery_time", "lowest_delay_rate", "highest_rto_rate", "most_delays"'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ period, courier, compareCourier, comparePeriod, pincode, metric }, ctx) {
            const { getCourierPerformanceAnalytics } = require('../courierAnalyticsService');
            return await getCourierPerformanceAnalytics({ period, courier, compareCourier, comparePeriod, pincode, metric });
        }
    },
    {
        name: 'investigate_return_pickup',
        description: 'Investigate the complete return pickup lifecycle for returns and exchanges. Distinguishes whether product is still with customer (Pickup Pending), in reverse transit, at warehouse (Return Received), or awaiting refund/exchange QC completion. Identifies reverse partner assignment, scheduled dates, pickup attempts, failure reasons, rescheduling, and SLA compliance (24-48h). Emits report with VERIFIED FACT, POLICY, INFERENCE, ACTION COMPLETED, and ACTION REQUIRED.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID (e.g. "42000", "#42000")'
                },
                returnId: {
                    type: 'string',
                    description: 'Return request ID (e.g. "RET-101")'
                },
                exchangeId: {
                    type: 'string',
                    description: 'Exchange request ID (e.g. "EXC-101")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, returnId, exchangeId, phone }, ctx) {
            const { investigateReturnPickup } = require('../returnPickupService');
            return await investigateReturnPickup({ orderId, returnId, exchangeId, phone });
        }
    },
    {
        name: 'detect_delivery_anomalies',
        description: 'Detect unusual, delayed, or suspicious delivery patterns across shipments, couriers, or pincodes using defined data-driven baselines. Flags stuck-in-transit (>48h/72h without scan), excessive delivery attempts (>=3 NDR attempts), rapid deliveries (<6h from dispatch), severe transit delays, high pincode failure clusters (>=25% RTO), and weekly courier performance surges. Emits report with ANOMALY, WHAT WAS DETECTED, EVIDENCE, BASELINE, SEVERITY, and RECOMMENDED ACTION.',
        parameters: {
            type: 'object',
            properties: {
                orderId: {
                    type: 'string',
                    description: 'Order number or ID to inspect'
                },
                awb: {
                    type: 'string',
                    description: 'Carrier tracking/AWB number'
                },
                courier: {
                    type: 'string',
                    description: 'Courier name filter'
                },
                pincode: {
                    type: 'string',
                    description: '6-digit destination pincode'
                },
                windowDays: {
                    type: 'number',
                    description: 'Number of past days to scan (default: 7)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, awb, courier, pincode, windowDays }, ctx) {
            const { detectDeliveryAnomalies } = require('../deliveryAnomalyService');
            return await detectDeliveryAnomalies({ orderId, awb, courier, pincode, windowDays });
        }
    },
    {
        name: 'get_complaint_patterns',
        description: 'Analyze customer support tickets and conversations to identify recurring complaint patterns, topic distributions, period-over-period trend changes (this week vs last week), product-specific issues (e.g. size/fit or damage per SKU), and courier grievances. Strictly factual pattern analysis without negative customer profiling. Emits report with VERIFIED FACT, PATTERN, INFERENCE, and RECOMMENDATION.',
        parameters: {
            type: 'object',
            properties: {
                period: {
                    type: 'string',
                    description: 'Analysis period: "today", "this_week", "this_month", or "all"'
                },
                comparePeriod: {
                    type: 'string',
                    description: 'Period to compare against (e.g. "last_week", "last_month")'
                },
                category: {
                    type: 'string',
                    description: 'Specific category filter'
                },
                product: {
                    type: 'string',
                    description: 'Product or SKU name filter'
                },
                courier: {
                    type: 'string',
                    description: 'Courier name filter'
                },
                pincode: {
                    type: 'string',
                    description: '6-digit destination pincode filter'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ period, comparePeriod, category, product, courier, pincode }, ctx) {
            const { getComplaintPatterns } = require('../complaintPatternService');
            return await getComplaintPatterns({ period, comparePeriod, category, product, courier, pincode });
        }
    },
    {
        name: 'get_return_exchange_analytics',
        description: 'Analyze product returns and exchanges by product, SKU, size, and reason. Calculates authoritative return counts, exchange counts, return rates (%), exchange rates (%), reason distributions (e.g. size small, fabric defect, color mismatch), and size swap trajectories (e.g. M -> L). Supports officer queries: "Which SKU has the highest return rate?", "Which size has the most exchanges?", and "Why are customers returning this product?". Strictly declares denominators (Units Sold from store_shoppers) and emits Phase 14 VERIFIED FACT, POLICY, PATTERN, ANOMALY, and RECOMMENDATION tags.',
        parameters: {
            type: 'object',
            properties: {
                queryType: {
                    type: 'string',
                    description: 'Type of query: "overview" (full breakdown), "top_returned_skus" (rank SKUs by return rate), "size_exchanges" (size exchange patterns & swap directions), "return_reasons" (why customers return a product)'
                },
                skuOrProduct: {
                    type: 'string',
                    description: 'Filter by specific SKU or product name (e.g. "HENLEY - 001 ( ACID WASH )", "WAFFLE")'
                },
                size: {
                    type: 'string',
                    description: 'Filter by garment size (e.g. "S", "M", "L", "XL", "XXL")'
                },
                period: {
                    type: 'string',
                    description: 'Analysis time window: "today", "this_week", "this_month", or "all"'
                },
                sortBy: {
                    type: 'string',
                    description: 'Sort metric: "return_rate", "exchange_rate", or "returns_count"'
                },
                limit: {
                    type: ['integer', 'string'],
                    description: 'Max records to return (default 10)'
                },
                minUnits: {
                    type: ['integer', 'string'],
                    description: 'Minimum units sold threshold to prevent sample size distortion (default 10)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ queryType, skuOrProduct, size, period, sortBy, limit, minUnits }, ctx) {
            const {
                getReturnExchangeAnalytics,
                getTopReturnedSkus,
                getSizeExchangePatterns,
                getProductReturnReasons,
                formatReturnAnalyticsReport
            } = require('../returnAnalyticsService');

            const lim = parseInt(limit) || 10;
            const minU = parseInt(minUnits) || 10;

            if (queryType === 'top_returned_skus') {
                return await getTopReturnedSkus({ limit: lim, minUnits: minU });
            } else if (queryType === 'size_exchanges') {
                return await getSizeExchangePatterns({ product: skuOrProduct });
            } else if (queryType === 'return_reasons') {
                return await getProductReturnReasons({ product: skuOrProduct || 'HENLEY - 001 ( ACID WASH )' });
            }

            const res = await getReturnExchangeAnalytics({
                skuOrProduct,
                size,
                period: period || 'all',
                sortBy: sortBy || 'return_rate',
                limit: lim,
                minUnits: minU
            });
            return {
                ...res,
                formatted_report: formatReturnAnalyticsReport(res)
            };
        }
    },
    {
        name: 'get_location_analytics',
        description: 'Analyze orders, operational performance, delivery delays, RTO rates, customer complaint concentrations, and COD cancellations by location (pincode, city, or state). Supports officer queries: "Which pincodes have the highest RTO?", "Where are delivery complaints concentrated?", "Which cities have the most orders?", and "What is the COD cancellation rate by location?". Strictly enforces PII protection (zero customer names, phone numbers, or street addresses). Emits report with VERIFIED FACT, POLICY, PATTERN, ANOMALY, and RECOMMENDATION tags.',
        parameters: {
            type: 'object',
            properties: {
                queryType: {
                    type: 'string',
                    description: 'Analysis type: "top_pincodes_rto" (pincodes with highest RTO rate), "top_cities_volume" (cities with highest order volume and GMV), "complaint_concentration" (locations with highest support/delivery grievances), "cod_cancellations" (locations with highest COD cancellation rates), "delivery_delay" (locations with highest delivery transit duration/delays), "location_overview" (deep-dive for a specific pincode, city, or state)'
                },
                pincode: {
                    type: 'string',
                    description: 'Optional 6-digit destination pincode filter (e.g. "500055", "395001")'
                },
                city: {
                    type: 'string',
                    description: 'Optional city name filter (e.g. "Mumbai", "Bangalore", "Pune")'
                },
                state: {
                    type: 'string',
                    description: 'Optional state/province filter (e.g. "Maharashtra", "Karnataka")'
                },
                period: {
                    type: 'string',
                    description: 'Analysis time window: "today", "this_week", "this_month", or "all"'
                },
                minOrders: {
                    type: ['integer', 'string'],
                    description: 'Minimum orders/shipments sample threshold (default 10)'
                },
                limit: {
                    type: ['integer', 'string'],
                    description: 'Max locations to return (default 10)'
                }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ queryType, pincode, city, state, period, minOrders, limit }, ctx) {
            const {
                getLocationAnalytics,
                formatLocationAnalyticsReport
            } = require('../locationAnalyticsService');

            const lim = parseInt(limit) || 10;
            const minN = parseInt(minOrders) || 10;

            const res = await getLocationAnalytics({
                queryType: queryType || (pincode ? 'location_overview' : 'top_cities_volume'),
                pincode,
                city,
                state,
                period: period || 'all',
                minOrders: minN,
                limit: lim
            });

            return {
                ...res,
                formatted_report: formatLocationAnalyticsReport(res)
            };
        }
    },
    {
        name: 'get_next_action_recommendation',
        description: 'Provide operational decision-support for customer support situations. Evaluates codified brand SOPs, live order data, carrier tracking, payment mode, return history, and customer profile to recommend the exact next operational step. Answers: "What should I do?", "What\'s the correct process?", and "How should I handle this?". Strictly enforces human-in-the-loop safety (recommends next action but never auto-executes destructive or financial actions). Emits structured Situation, Evidence, Applicable Policy, Recommended Action, and Customer-Facing Response.',
        parameters: {
            type: 'object',
            properties: {
                problemDescription: {
                    type: 'string',
                    description: 'Description of the customer issue, complaint, or operational question (e.g. "Order marked delivered but customer says they didn\'t receive it", "Customer received size M instead of L", "Wants cash refund for return")'
                },
                orderId: {
                    type: 'string',
                    description: 'Order ID or number if known (e.g. "50992", "#42248")'
                },
                phone: {
                    type: 'string',
                    description: 'Customer phone number if known'
                },
                customerIdentifier: {
                    type: 'string',
                    description: 'Optional customer identifier (phone, order ID, email, name)'
                },
                customerFacingRequested: {
                    type: 'boolean',
                    description: 'Whether to include a ready-to-send draft message for the customer (default true)'
                }
            },
            required: ['problemDescription']
        },
        requiresConfirmation: false,
        async execute({ problemDescription, orderId, phone, customerIdentifier, customerFacingRequested }, ctx) {
            const {
                evaluateNextAction,
                formatDecisionReport
            } = require('../decisionAssistantService');

            const res = await evaluateNextAction({
                problemDescription,
                orderId,
                phone,
                customerIdentifier,
                customerFacingRequested: customerFacingRequested !== false
            });

            return {
                ...res,
                formatted_report: formatDecisionReport(res)
            };
        }
    },
    {
        name: 'search_messages',
        description: 'Get the recent WhatsApp conversation (incoming and outgoing messages) for a customer phone number.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number (any format)' },
                limit: { type: ['integer', 'string'], description: 'Number of recent messages (default 20, max 50)' }
            },
            required: ['phone']
        },
        requiresConfirmation: false,
        async execute({ phone, limit }) {
            const digits = String(phone).replace(/\D/g, '');
            const n = Math.min(parseInt(limit) || 20, 50);
            const rows = await dbAdapter.query(
                `SELECT message_type, message_content, status, created_at FROM messages
                 WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT ?`,
                [`%${digits.slice(-10)}`, n]
            );
            return { count: rows.length, messages: rows.reverse() };
        }
    },
    {
        name: 'list_tickets',
        description: 'List support tickets, optionally filtered by status (open/resolved/closed) or customer phone.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Filter by status: open, resolved, closed' },
                phone: { type: 'string', description: 'Filter by customer phone' },
                limit: { type: ['integer', 'string'], description: 'Max tickets to return (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ status, phone, limit }) {
            const params = [];
            let sql = 'SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, created_at, updated_at FROM support_tickets WHERE 1=1';
            if (status) { sql += ' AND status = ?'; params.push(status); }
            if (phone) { sql += ' AND customer_phone LIKE ?'; params.push(`%${String(phone).replace(/\D/g, '').slice(-10)}`); }
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(Math.min(parseInt(limit) || 20, 50));
            const rows = await dbAdapter.query(sql, params);
            return { count: rows.length, tickets: rows };
        }
    },
    {
        name: 'search_learned_replies',
        description: 'Find approved replies our support team previously sent for similar customer questions. Use when drafting a reply to match proven wording and policies.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The customer question or topic to match' }
            },
            required: ['question']
        },
        requiresConfirmation: false,
        async execute({ question }) {
            const { findSimilarExamples } = require('./learning');
            const examples = await findSimilarExamples(question, 3);
            return { count: examples.length, examples };
        }
    },
    {
        name: 'update_ticket',
        description: 'Update a support ticket status (open, resolved, closed). Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                ticketId: { type: ['integer', 'string'], description: 'Support ticket ID' },
                status: { type: 'string', enum: ['open', 'resolved', 'closed'], description: 'New status' }
            },
            required: ['ticketId', 'status']
        },
        requiresConfirmation: true,
        summary: (args) => `Update support ticket #${args.ticketId} status to "${args.status}"`,
        async execute({ ticketId, status }) {
            const rows = await dbAdapter.query('SELECT id, status, customer_phone FROM support_tickets WHERE id = ?', [ticketId]);
            if (!rows.length) throw new Error(`Ticket ${ticketId} not found`);
            await dbAdapter.update('support_tickets', { status, updated_at: new Date().toISOString() }, { id: ticketId });
            // Outcome signal for AI learning: resolution means recent replies worked
            if ((status === 'resolved' || status === 'closed') && rows[0].customer_phone) {
                const { boostFromResolvedTicket } = require('./learning');
                boostFromResolvedTicket(rows[0].customer_phone).catch(() => {});
            }
            return { ticketId, previousStatus: rows[0].status, newStatus: status };
        }
    },
    {
        name: 'get_abandoned_carts',
        description: 'List abandoned checkout carts, optionally filtered by status (pending/recovered/expired).',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', description: 'Filter: pending, recovered, expired' },
                limit: { type: ['integer', 'string'], description: 'Max carts (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ status, limit }) {
            const params = [];
            let sql = 'SELECT checkout_id, customer_phone, customer_name, total_amount, currency, status, created_at, recovered_at FROM abandoned_carts WHERE 1=1';
            if (status) { sql += ' AND status = ?'; params.push(status); }
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(Math.min(parseInt(limit) || 20, 50));
            const rows = await dbAdapter.query(sql, params);
            return { count: rows.length, carts: rows };
        }
    },
    {
        name: 'shopify_search_orders',
        description: 'Search Shopify orders by order name/number (e.g. "#1234") or fetch recent orders. Returns live data from the Shopify Admin API.',
        parameters: {
            type: 'object',
            properties: {
                orderName: { type: 'string', description: 'Order name like #1234 (omit to list recent orders)' },
                limit: { type: ['integer', 'string'], description: 'Max orders when listing recent (default 10, max 25)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderName, limit }) {
            const shop = process.env.SHOPIFY_STORE;
            const token = process.env.SHOPIFY_ACCESS_TOKEN;
            if (!shop || !token) throw new Error('Shopify is not configured on this server');
            const fields = 'id,name,created_at,total_price,currency,financial_status,fulfillment_status,customer,line_items,shipping_address';
            let url;
            if (orderName) {
                const name = String(orderName).replace(/^#/, '');
                url = `https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(name)}&status=any&fields=${fields}`;
            } else {
                const n = Math.min(parseInt(limit) || 10, 25);
                url = `https://${shop}/admin/api/2024-01/orders.json?status=any&limit=${n}&fields=${fields}`;
            }
            const response = await axios.get(url, {
                headers: { 'X-Shopify-Access-Token': token },
                timeout: 15000
            });
            const orders = (response.data?.orders || []).map(o => ({
                id: o.id,
                name: o.name,
                createdAt: o.created_at,
                total: o.total_price,
                currency: o.currency,
                financialStatus: o.financial_status,
                fulfillmentStatus: o.fulfillment_status,
                customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : null,
                phone: o.customer?.phone || o.shipping_address?.phone || null,
                items: (o.line_items || []).map(li => `${li.title} (${li.variant_title || 'standard'}) x${li.quantity} [SKU: ${li.sku || 'N/A'}]`)
            }));
            return { count: orders.length, orders };
        }
    },
    {
        name: 'get_order_intelligence',
        description: 'Consolidated, verified order intelligence across all systems (Shopify, Shoppers Hub, shipments, carrier tracking, return/exchange system, edits, customer requests). Use whenever an officer asks for complete details of an order, what happened to an order, whether an order was edited, what size was originally ordered or changed to, whether it shipped, which courier is handling it, or what payment method was used.',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order ID or number (e.g. "12345" or "#12345")' }
            },
            required: ['orderId']
        },
        requiresConfirmation: false,
        async execute({ orderId }) {
            const { investigateOrder } = require('../orderIntelligenceService');
            return await investigateOrder(orderId);
        }
    },
    {
        name: 'track_awb',
        description: 'Track a shipment by AWB / waybill number using the configured carrier (Delhivery or Shiprocket). Returns the tracking timeline.',
        parameters: {
            type: 'object',
            properties: {
                awb: { type: 'string', description: 'AWB / waybill number' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier (default: try Delhivery first, then Shiprocket)' }
            },
            required: ['awb']
        },
        requiresConfirmation: false,
        async execute({ awb, carrier }) {
            const { getAdapter, getConfiguredCarriers } = require('../carriers');
            const order = carrier ? [carrier] : getConfiguredCarriers().map(c => c.key);
            const errors = [];
            for (const key of order) {
                try {
                    const adapter = getAdapter(key);
                    if (!adapter || !adapter.isConfigured()) continue;
                    const result = await adapter.track(awb);
                    if (result && result.success !== false) {
                        return { carrier: key, tracking: result.data || result };
                    }
                    errors.push(`${key}: ${result?.error || 'no data'}`);
                } catch (e) {
                    errors.push(`${key}: ${e.message}`);
                }
            }
            return { error: `No tracking data found for AWB ${awb}`, attempts: errors };
        }
    },
    {
        name: 'track_order_by_id',
        description: 'Track a shipment using ONLY the OFFCOMFRT order ID (the 4-5 digit order number, e.g. "42000" or "#42000"). Resolves the AWB internally from Shoppers Hub shipment data and returns live carrier tracking. Customers never need to provide an AWB — always prefer this tool over track_awb for customer queries.',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order ID / order number (e.g. "42000" or "#42000")' }
            },
            required: ['orderId']
        },
        requiresConfirmation: false,
        async execute({ orderId }) {
            const name = String(orderId || '').replace(/^#/, '').trim();
            if (!name) return { error: 'Order ID is required' };

            // 1. Shoppers Hub shipment record — carries the AWB + carrier we booked with
            let shipment = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, carrier, awb, courier_name, status, tracking_url, created_at
                     FROM shipments
                     WHERE order_id = ? AND awb IS NOT NULL
                     ORDER BY CASE WHEN status NOT IN ('cancelled', 'failed') THEN 0 ELSE 1 END, id DESC
                     LIMIT 1`,
                    [name]
                );
                shipment = rows[0] || null;
            } catch (e) { /* shipments table may not exist yet */ }

            // 2. Fallback: cached orders table
            let orderRow = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, status, awb, courier_name, expected_delivery, created_at
                     FROM orders WHERE order_id = ? LIMIT 1`,
                    [name]
                );
                orderRow = rows[0] || null;
            } catch (e) { /* ignore */ }

            const awb = shipment?.awb || orderRow?.awb || null;

            // 3. Live carrier tracking — try the booking carrier first, then the rest
            if (awb) {
                const { getAdapter, getConfiguredCarriers } = require('../carriers');
                const preferred = shipment?.carrier ? [shipment.carrier] : [];
                const carrierOrder = [
                    ...preferred,
                    ...getConfiguredCarriers().map(c => c.key).filter(k => !preferred.includes(k))
                ];
                const errors = [];
                for (const key of carrierOrder) {
                    try {
                        const adapter = getAdapter(key);
                        if (!adapter || !adapter.isConfigured()) continue;
                        const result = await adapter.track(awb);
                        if (result && result.success !== false) {
                            return { carrier: key, orderId: name, awb, tracking: result.data || result };
                        }
                        errors.push(`${key}: ${result?.error || 'no data'}`);
                    } catch (e) {
                        errors.push(`${key}: ${e.message}`);
                    }
                }
                return {
                    orderId: name,
                    awb,
                    shipmentStatus: shipment?.status || orderRow?.status || null,
                    note: 'Shipment found but live tracking is not available yet. Please check back later.',
                    attempts: errors
                };
            }

            // 4. No AWB yet — report what Shoppers Hub knows about the order
            let shopper = null;
            try {
                const rows = await dbAdapter.query(
                    `SELECT order_id, status, product_name, delivery_type
                     FROM store_shoppers WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
                    [name]
                );
                shopper = rows[0] || null;
            } catch (e) { /* ignore */ }

            if (shipment || shopper || orderRow) {
                return {
                    orderId: name,
                    awb: null,
                    shipmentStatus: shipment?.status || null,
                    shopperStatus: shopper?.status || null,
                    orderStatus: orderRow?.status || null,
                    note: 'This order has not been handed to a courier yet, so live tracking is not available. Tracking will appear here as soon as it ships.'
                };
            }

            return { error: `No order found with ID ${name}` };
        }
    },
    {
        name: 'check_serviceability',
        description: 'Check whether a delivery pincode is serviceable (COD / prepaid availability) with the configured carriers.',
        parameters: {
            type: 'object',
            properties: {
                pincode: { type: 'string', description: '6-digit delivery pincode' },
                paymentMode: { type: 'string', enum: ['COD', 'Prepaid'], description: 'Payment mode (default Prepaid)' }
            },
            required: ['pincode']
        },
        requiresConfirmation: false,
        async execute({ pincode, paymentMode }) {
            const { getConfiguredCarriers, getAdapter } = require('../carriers');
            const ctx = {
                consignee: { pincode: String(pincode) },
                payment: { mode: paymentMode || 'Prepaid' }
            };
            const results = {};
            for (const c of getConfiguredCarriers()) {
                try {
                    const adapter = getAdapter(c.key);
                    const r = await adapter.checkServiceability(ctx);
                    results[c.key] = r.success === false ? { error: r.error } : (r.data || r);
                } catch (e) {
                    results[c.key] = { error: e.message };
                }
            }
            return results;
        }
    },
    {
        name: 'list_shipments',
        description: 'List shipments created via the Shopper Hub shipping module, optionally filtered by order ID or status.',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Filter by order ID' },
                status: { type: 'string', description: 'Filter by shipment status' },
                limit: { type: ['integer', 'string'], description: 'Max results (default 20, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ orderId, status, limit }) {
            const shippingService = require('../shippingService');
            const rows = await shippingService.listShipments({ orderId, status, limit: Math.min(parseInt(limit) || 20, 50) });
            return { count: rows.length, shipments: truncateRows(rows, 50) };
        }
    },
    {
        name: 'book_shipment',
        description: 'Create a shipment (book a courier) for a confirmed shopper order via the shipping module. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                shopperId: { type: 'string', description: 'Shopper record ID (from store_shoppers)' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier to use' },
                courierId: { type: 'string', description: 'Courier ID (Shiprocket only, optional)' }
            },
            required: ['shopperId', 'carrier']
        },
        requiresConfirmation: true,
        summary: (args) => `Book a ${args.carrier} shipment for shopper order ${args.shopperId}`,
        async execute({ shopperId, carrier, courierId }) {
            const shippingService = require('../shippingService');
            const result = await shippingService.ship({ shopperId, carrier, courierId, shippedBy: 'ai-copilot' });
            return result;
        }
    },
    {
        name: 'schedule_pickup',
        description: 'Schedule a courier pickup for an existing shipment. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                shipmentId: { type: ['integer', 'string'], description: 'Internal shipment ID (from list_shipments)' },
                pickupDate: { type: 'string', description: 'Pickup date YYYY-MM-DD' }
            },
            required: ['shipmentId', 'pickupDate']
        },
        requiresConfirmation: true,
        summary: (args) => `Schedule pickup for shipment #${args.shipmentId} on ${args.pickupDate}`,
        async execute({ shipmentId, pickupDate }) {
            const shippingService = require('../shippingService');
            return await shippingService.schedulePickup(shipmentId, pickupDate);
        }
    },
    {
        name: 'send_whatsapp_message',
        description: 'Send a WhatsApp text message to a customer. Requires admin confirmation. Note: free-form messages only deliver inside the 24h customer service window.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number' },
                message: { type: 'string', description: 'Message text to send' }
            },
            required: ['phone', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => `Send WhatsApp message to ${args.phone}: "${String(args.message).substring(0, 120)}${String(args.message).length > 120 ? '…' : ''}"`,
        async execute({ phone, message }) {
            const whatsappService = require('../whatsappService');
            const result = await whatsappService.sendMessage(phone, message);
            if (result === false) throw new Error('Message rejected by Meta (recipient not in allowed test list)');
            return { sent: true, messageId: result?.messages?.[0]?.id || null };
        }
    },
    {
        name: 'create_broadcast_draft',
        description: 'Create a DRAFT broadcast campaign record (title, message, segment). It is NOT sent — an admin must review and send it from the Broadcasts page. Requires admin confirmation.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Broadcast title' },
                message: { type: 'string', description: 'Broadcast message text' },
                segment: { type: 'string', description: 'Target segment: all, pending_orders, delivered, etc. (default all)' }
            },
            required: ['title', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => `Create draft broadcast "${args.title}" for segment "${args.segment || 'all'}" (will NOT be sent automatically)`,
        async execute({ title, message, segment }) {
            const row = await dbAdapter.insert('broadcasts', {
                title: `[DRAFT] ${title}`,
                message,
                segment: segment || 'all',
                total_recipients: 0,
                sent_count: 0,
                failed_count: 0,
                created_by: 'ai-copilot',
                created_at: new Date().toISOString()
            });
            return { draftId: row?.id || null, title: `[DRAFT] ${title}`, note: 'Draft saved. Review and send it manually from the Broadcasts page.' };
        }
    },
    {
        name: 'run_sql_read',
        description: 'Run a read-only SQL SELECT query against the bot database (PostgreSQL). Tables: customers, orders, messages, support_tickets, support_portals, broadcasts, abandoned_carts, store_shoppers, shipments, returns, exchanges, follow_up_campaigns, follow_up_recipients, system_settings. Only SELECT is allowed; results capped at 100 rows.',
        parameters: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'A single SELECT statement (no semicolons)' }
            },
            required: ['sql']
        },
        requiresConfirmation: false,
        async execute({ sql }) {
            const validationError = validateReadOnlySql(sql);
            if (validationError) throw new Error(validationError);
            const wrapped = `SELECT * FROM (${sql.trim()}) AS ai_sub LIMIT ${MAX_ROWS}`;
            const rows = await dbAdapter.query(wrapped, []);
            return { rowCount: rows.length, rows: truncateRows(rows), truncatedAt: MAX_ROWS };
        }
    },
    {
        name: 'query_returns_system',
        description: 'Query the exchange/return tracking system for return/exchange requests, influencer stats or marketing data. Ask a resource: requests, request_stats, influencers, settings.',
        parameters: {
            type: 'object',
            properties: {
                resource: { type: 'string', enum: ['requests', 'request_stats', 'influencers'], description: 'What to fetch from the returns system' },
                query: { type: 'string', description: 'Optional filter, e.g. order number or status' },
                limit: { type: ['integer', 'string'], description: 'Max rows (default 20)' }
            },
            required: ['resource']
        },
        requiresConfirmation: false,
        async execute({ resource, query, limit }) {
            const baseUrl = process.env.RETURNS_SERVER_URL;
            const token = process.env.WHATSAPP_INTERNAL_TOKEN;
            if (!baseUrl) {
                const ris = require('../returnInvestigationService');
                return await ris.getRecentReturnExchangeRequests({ limit: parseInt(limit) || 5, query, type: resource === 'requests' ? 'all' : resource });
            }
            try {
                const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/internal/ai-data`, {
                    params: { resource, query: query || '', limit: Math.min(parseInt(limit) || 20, 50) },
                    headers: { 'x-internal-token': token || '' },
                    timeout: 15000
                });
                return response.data;
            } catch (err) {
                console.warn('⚠️ Returns system remote URL unreachable, falling back to authoritative database:', err.message);
                const ris = require('../returnInvestigationService');
                return await ris.getRecentReturnExchangeRequests({ limit: parseInt(limit) || 5, query, type: resource === 'requests' ? 'all' : resource });
            }
        }
    },
    // ---------- Batch / bulk tools ----------
    {
        name: 'batch_update_tickets',
        description: 'Update multiple support tickets at once (resolve, close, or reopen). Requires admin confirmation. Returns count of affected tickets.',
        parameters: {
            type: 'object',
            properties: {
                ticketIds: { type: 'string', description: 'Comma-separated ticket IDs, e.g. "12,15,18"' },
                status: { type: 'string', enum: ['open', 'resolved', 'closed'], description: 'New status for all selected tickets' },
                filterStatus: { type: 'string', description: 'Alternatively, update ALL tickets matching this status (open/resolved/closed)' },
                filterPortalId: { type: ['integer', 'string'], description: 'Limit filter to a specific support portal ID' }
            },
            required: ['status']
        },
        requiresConfirmation: true,
        summary: (args) => {
            if (args.ticketIds) return `Update ${String(args.ticketIds).split(',').length} ticket(s) to "${args.status}"`;
            return `Update all "${args.filterStatus || 'open'}" tickets to "${args.status}"`;
        },
        async execute({ ticketIds, status, filterStatus, filterPortalId }) {
            let ids = [];
            if (ticketIds) {
                ids = String(ticketIds).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            } else if (filterStatus) {
                let sql = 'SELECT id FROM support_tickets WHERE status = ?';
                const params = [filterStatus];
                if (filterPortalId) { sql += ' AND portal_id = ?'; params.push(filterPortalId); }
                sql += ' LIMIT 100';
                const rows = await dbAdapter.query(sql, params);
                ids = rows.map(r => r.id);
            }
            if (!ids.length) throw new Error('No tickets matched the criteria');
            const now = new Date().toISOString();
            for (const id of ids) {
                await dbAdapter.update('support_tickets', { status, updated_at: now }, { id });
            }
            return { updated: ids.length, ticketIds: ids, newStatus: status };
        }
    },
    {
        name: 'bulk_send_whatsapp',
        description: 'Send the same WhatsApp message to multiple customers. Requires admin confirmation. Max 50 recipients per call. Free-form messages only deliver inside the 24h service window.',
        parameters: {
            type: 'object',
            properties: {
                phones: { type: 'string', description: 'Comma-separated phone numbers, or a segment keyword: "all_customers", "open_tickets", "pending_carts"' },
                message: { type: 'string', description: 'Message text to send to all recipients' }
            },
            required: ['phones', 'message']
        },
        requiresConfirmation: true,
        summary: (args) => {
            const count = /^all_customers|open_tickets|pending_carts$/i.test(args.phones) ? args.phones : String(args.phones).split(',').length;
            return `Send WhatsApp to ${count} recipient(s): "${String(args.message).substring(0, 80)}…"`;
        },
        async execute({ phones, message }) {
            const whatsappService = require('../whatsappService');
            let recipients = [];
            const segment = String(phones).trim();
            if (/^all_customers$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT phone FROM customers LIMIT 50');
                recipients = rows.map(r => r.phone);
            } else if (/^open_tickets$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT DISTINCT customer_phone FROM support_tickets WHERE status = \'open\' LIMIT 50');
                recipients = rows.map(r => r.customer_phone);
            } else if (/^pending_carts$/i.test(segment)) {
                const rows = await dbAdapter.query('SELECT DISTINCT customer_phone FROM abandoned_carts WHERE status = \'pending\' LIMIT 50');
                recipients = rows.map(r => r.customer_phone);
            } else {
                recipients = segment.split(',').map(p => p.trim()).filter(Boolean).slice(0, 50);
            }
            if (!recipients.length) throw new Error('No recipients found');
            const results = { sent: 0, failed: 0, errors: [] };
            for (const phone of recipients) {
                try {
                    const r = await whatsappService.sendMessage(phone, message);
                    if (r === false) results.failed++;
                    else results.sent++;
                } catch (e) {
                    results.failed++;
                    results.errors.push(`${phone}: ${e.message}`);
                }
            }
            return { ...results, totalRecipients: recipients.length };
        }
    },
    {
        name: 'batch_book_shipments',
        description: 'Book shipments for multiple shopper orders at once. Requires admin confirmation. Max 25 per batch.',
        parameters: {
            type: 'object',
            properties: {
                shopperIds: { type: 'string', description: 'Comma-separated shopper record IDs' },
                carrier: { type: 'string', enum: ['delhivery', 'shiprocket'], description: 'Carrier to use for all shipments' }
            },
            required: ['shopperIds', 'carrier']
        },
        requiresConfirmation: true,
        summary: (args) => `Book ${String(args.shopperIds).split(',').length} ${args.carrier} shipment(s)`,
        async execute({ shopperIds, carrier }) {
            const shippingService = require('../shippingService');
            const ids = String(shopperIds).split(',').map(s => s.trim()).filter(Boolean).slice(0, 25);
            if (!ids.length) throw new Error('No shopper IDs provided');
            const results = { booked: 0, failed: 0, errors: [] };
            for (const shopperId of ids) {
                try {
                    await shippingService.ship({ shopperId, carrier, shippedBy: 'ai-copilot-batch' });
                    results.booked++;
                } catch (e) {
                    results.failed++;
                    results.errors.push(`${shopperId}: ${e.message}`);
                }
            }
            return { ...results, carrier };
        }
    },
    {
        name: 'smart_triage_tickets',
        description: 'AI-powered analysis of open support tickets: groups them by topic, estimates priority, and suggests portal assignment. Read-only — does not modify tickets.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: ['integer', 'string'], description: 'Max tickets to analyze (default 30, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ limit }) {
            const n = Math.min(parseInt(limit) || 30, 50);
            const rows = await dbAdapter.query(
                `SELECT id, ticket_number, customer_phone, customer_name, message, status, portal_id, created_at
                 FROM support_tickets WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`,
                [n]
            );
            // Simple keyword-based triage (no extra AI call needed)
            const categories = {
                'Order Status': /\b(where|status|track|when|deliver|arriv|ship)\b/i,
                'Return/Exchange': /\b(return|exchange|refund|replace|size|wrong)\b/i,
                'Payment': /\b(payment|pay|cod|prepaid|refund|upi|card|money)\b/i,
                'Product Query': /\b(product|stock|available|size|color|material|fabric)\b/i,
                'Complaint': /\b(complain|bad|worst|damage|defect|broken|poor)\b/i,
                'General': /./
            };
            const triaged = rows.map(t => {
                let category = 'General';
                for (const [cat, pattern] of Object.entries(categories)) {
                    if (pattern.test(t.message || '')) { category = cat; break; }
                }
                const ageHours = Math.round((Date.now() - new Date(t.created_at).getTime()) / 3600000);
                const priority = ageHours > 48 ? 'high' : ageHours > 24 ? 'medium' : 'low';
                return { id: t.id, ticket_number: t.ticket_number, customer_name: t.customer_name, message: String(t.message || '').substring(0, 120), category, priority, ageHours, portal_id: t.portal_id };
            });
            const summary = {};
            triaged.forEach(t => { summary[t.category] = (summary[t.category] || 0) + 1; });
            return { total: triaged.length, categorySummary: summary, tickets: triaged };
        }
    },
    {
        name: 'get_pending_shipments',
        description: 'List shopper orders that are confirmed but not yet shipped. Shows order details ready for batch shipment booking.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: ['integer', 'string'], description: 'Max results (default 25, max 50)' }
            },
            required: []
        },
        requiresConfirmation: false,
        async execute({ limit }) {
            const n = Math.min(parseInt(limit) || 25, 50);
            const rows = await dbAdapter.query(
                `SELECT id, customer_name, customer_phone, product_name, total_amount, status, created_at
                 FROM store_shoppers
                 WHERE status IN ('confirmed', 'processing')
                 ORDER BY created_at ASC LIMIT ?`,
                [n]
            );
            return { count: rows.length, pendingShipment: rows };
        }
    },
    // ---------- Customer-facing tools ----------
    {
        name: 'search_orders_by_phone',
        description: 'Look up a customer\'s recent orders using their phone number. Returns order IDs, status, and basic details.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Customer phone number (with or without country code)' }
            },
            required: ['phone']
        },
        requiresConfirmation: false,
        async execute({ phone }) {
            const digits = String(phone || '').replace(/\D/g, '');
            const phonePattern = `%${digits.slice(-10)}`;
            const rows = await dbAdapter.query(
                `SELECT order_id, status, awb, courier_name, total, payment_method, expected_delivery, created_at
                 FROM orders WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 5`,
                [phonePattern]
            );
            return { count: rows.length, orders: rows };
        }
    },
    {
        name: 'faq_lookup',
        description: 'Search the knowledge base of learned FAQ replies for answers to common customer questions about OFFCOMFRT policies, shipping, returns, etc.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'Customer question to find a matching FAQ answer for' }
            },
            required: ['question']
        },
        requiresConfirmation: false,
        async execute({ question }) {
            const { findSimilarExamples } = require('./learning');
            const examples = await findSimilarExamples(question, 3);
            return {
                count: examples.length,
                answers: examples.map(e => ({ question: e.q, answer: e.a, relevance: e.uses }))
            };
        }
    },
    {
        name: 'check_return_eligibility',
        description: 'Check if an order is eligible for return/exchange based on delivery date (within 2-day window).',
        parameters: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order ID to check eligibility for' }
            },
            required: ['orderId']
        },
        requiresConfirmation: false,
        async execute({ orderId }) {
            const name = String(orderId || '').replace(/^#/, '');
            let rows = [];
            try {
                rows = await dbAdapter.query(
                    `SELECT order_id, status, created_at, updated_at, delivered_at
                     FROM orders WHERE order_id = ? LIMIT 1`,
                    [name]
                );
            } catch (e) {
                // delivered_at column may not exist yet on un-migrated databases
                rows = await dbAdapter.query(
                    `SELECT order_id, status, created_at, updated_at
                     FROM orders WHERE order_id = ? LIMIT 1`,
                    [name]
                );
            }
            if (!rows.length) return { eligible: false, reason: 'Order not found' };
            const order = rows[0];
            // Check if order is delivered and within 2-day return window.
            // Measure from the REAL delivery timestamp (stamped by shipment
            // status sync), never the order placement date — an order placed
            // 5 days ago but delivered today is still inside the window.
            const deliveredDate = order.status?.toLowerCase().includes('delivered')
                ? new Date(order.delivered_at || order.updated_at || order.created_at)
                : null;
            if (!deliveredDate || isNaN(deliveredDate.getTime())) {
                return { eligible: false, reason: 'Order not yet delivered', status: order.status };
            }
            const daysSinceDelivery = (Date.now() - deliveredDate.getTime()) / (1000 * 60 * 60 * 24);
            const eligible = daysSinceDelivery <= 2;
            return {
                eligible,
                orderId: order.order_id,
                status: order.status,
                deliveredAt: deliveredDate.toISOString(),
                daysSinceDelivery: Math.round(daysSinceDelivery * 10) / 10,
                reason: eligible ? 'Within 2-day return window' : 'Return window expired (more than 2 days since delivery)',
                portalUrl: 'offcomfrt.in → Support → Return/Exchange'
            };
        }
    },
    {
        name: 'check_return_exchange_status',
        description: 'Look up the customer\'s actual return and exchange requests (live status from the returns system). Use when a customer asks about the status of a return, exchange, refund, or pickup — e.g. "has my return been approved", "when is the pickup", "where is my refund". Works with JUST the order ID (no REQ- request ID needed) — also accepts a REQ- request ID or phone number.',
        parameters: {
            type: 'object',
            properties: {
                requestId: { type: 'string', description: 'Return/exchange request ID with REQ- prefix (e.g. "REQ-12345")' },
                orderId: { type: 'string', description: 'Order ID the return/exchange was filed for (e.g. "42000")' },
                phone: { type: 'string', description: 'Customer phone number — fallback lookup if no order ID is known' }
            }
        },
        requiresConfirmation: false,
        async execute({ requestId, orderId, phone }) {
            const reqId = String(requestId || '').trim().toUpperCase();
            const name = String(orderId || '').replace(/^#/, '').trim();
            const digits = String(phone || '').replace(/\D/g, '');

            // Direct request-ID match first (REQ- prefix IDs from the returns portal)
            if (reqId) {
                const bareId = reqId.replace(/^REQ-/, '');
                const returnRows = await dbAdapter.query(
                    `SELECT return_id, order_id, reason, status, pickup_scheduled_date,
                            refund_amount, refund_status, created_at, updated_at
                     FROM returns WHERE return_id = ? OR return_id = ? ORDER BY created_at DESC LIMIT 3`,
                    [reqId, bareId]
                );
                const exchangeRows = await dbAdapter.query(
                    `SELECT exchange_id, order_id, old_items, new_items, reason, status,
                            price_difference, payment_status, pickup_scheduled_date, created_at, updated_at
                     FROM exchanges WHERE exchange_id = ? OR exchange_id = ? ORDER BY created_at DESC LIMIT 3`,
                    [reqId, bareId]
                );
                if (returnRows.length || exchangeRows.length) {
                    const safeParse = (v) => {
                        if (!v || typeof v !== 'string') return v;
                        try { return JSON.parse(v); } catch { return v; }
                    };
                    return {
                        found: true,
                        returns: returnRows.map(r => ({ ...r, items: safeParse(r.items) })),
                        exchanges: exchangeRows.map(e => ({ ...e, old_items: safeParse(e.old_items), new_items: safeParse(e.new_items) }))
                    };
                }
                // Fall through to order/phone lookup in case the customer mixed up IDs
            }

            const clauses = [];
            const params = [];
            if (name) {
                // Exact match plus "#42000" and suffixed forms (returns system may
                // store channel-prefixed order IDs) — order numbers are 4-6 digits,
                // so a trailing-match LIKE stays precise.
                clauses.push('(order_id = ? OR order_id = ? OR order_id LIKE ?)');
                params.push(name, `#${name}`, `%${name}`);
            }
            if (digits.length >= 10) { clauses.push('customer_phone LIKE ?'); params.push(`%${digits.slice(-10)}`); }
            if (!clauses.length) {
                return { error: 'Provide a REQ- request ID, orderId, or phone number to look up return/exchange requests' };
            }
            const where = `(${clauses.join(' OR ')})`;

            const returnRows = await dbAdapter.query(
                `SELECT return_id, order_id, reason, status, pickup_scheduled_date,
                        refund_amount, refund_status, created_at, updated_at
                 FROM returns WHERE ${where} ORDER BY created_at DESC LIMIT 3`,
                params
            );

            const exchangeRows = await dbAdapter.query(
                `SELECT exchange_id, order_id, old_items, new_items, reason, status,
                        price_difference, payment_status, pickup_scheduled_date, created_at, updated_at
                 FROM exchanges WHERE ${where} ORDER BY created_at DESC LIMIT 3`,
                params
            );

            // items / old_items / new_items are stored as JSON strings
            const safeParse = (v) => {
                if (!v || typeof v !== 'string') return v;
                try { return JSON.parse(v); } catch { return v; }
            };
            const returns = returnRows.map(r => ({ ...r, items: safeParse(r.items) }));
            const exchanges = exchangeRows.map(e => ({ ...e, old_items: safeParse(e.old_items), new_items: safeParse(e.new_items) }));

            if (!returns.length && !exchanges.length) {
                // Fallback: search support_tickets for return/exchange messages about this order
                const ticketClauses = [];
                const ticketParams = [];
                if (name) {
                    ticketClauses.push('(message ILIKE ? OR customer_phone ILIKE ?)');
                    ticketParams.push(`%${name}%`, `%${name}%`);
                }
                if (digits.length >= 10) {
                    ticketClauses.push('customer_phone LIKE ?');
                    ticketParams.push(`%${digits.slice(-10)}`);
                }
                let supportTickets = [];
                if (ticketClauses.length) {
                    const ticketWhere = `(${ticketClauses.join(' OR ')}) AND (message ILIKE '%return%' OR message ILIKE '%exchange%' OR message ILIKE '%refund%')`;
                    try {
                        supportTickets = await dbAdapter.query(
                            `SELECT ticket_number, customer_phone, customer_name, message, status, created_at
                             FROM support_tickets WHERE ${ticketWhere} ORDER BY created_at DESC LIMIT 5`,
                            ticketParams
                        );
                    } catch (e) {
                        console.warn('[check_return_exchange_status] support_tickets fallback query failed:', e.message);
                    }
                }

                // Fallback: search store_shoppers for return-related status on this order
                let shopperRecords = [];
                if (name) {
                    try {
                        shopperRecords = await dbAdapter.query(
                            `SELECT order_id, phone, name, status, customer_message, updated_at
                             FROM store_shoppers WHERE (order_id ILIKE ? OR order_id ILIKE ? OR order_id ILIKE ?)
                             ORDER BY updated_at DESC LIMIT 5`,
                            [name, `#${name}`, `%${name}`]
                        );
                    } catch (e) {
                        console.warn('[check_return_exchange_status] store_shoppers fallback query failed:', e.message);
                    }
                }

                if (!supportTickets.length && !shopperRecords.length) {
                    return {
                        found: false,
                        message: 'No return or exchange request found for this order/phone',
                        hint: 'Requests must be submitted via the returns page at offcomfrt.in/pages/return within 2 days of delivery'
                    };
                }

                return {
                    found: true,
                    returns,
                    exchanges,
                    supportTickets: supportTickets.map(t => ({
                        ticketNumber: t.ticket_number,
                        phone: t.customer_phone,
                        name: t.customer_name,
                        message: t.message,
                        status: t.status,
                        createdAt: t.created_at
                    })),
                    shopperRecords: shopperRecords.map(s => ({
                        orderId: s.order_id,
                        phone: s.phone,
                        name: s.name,
                        status: s.status,
                        customerMessage: s.customer_message,
                        updatedAt: s.updated_at
                    })),
                    note: 'Return/exchange not found in dedicated returns tables — showing related support tickets and shopper records instead'
                };
            }

            return { found: true, returns, exchanges };
        }
    }
];

const toolMap = new Map(tools.map(t => [t.name, t]));

function getTool(name) {
    return toolMap.get(name) || null;
}

/** OpenAI-format tool definitions for the chat completions API. */
function getToolSchemas() {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

// ---------- Token-lean tool routing ----------
// Tool schemas are re-sent on every agent round and dominate the request size,
// so we only send the tools whose triggers match the conversation context.
// run_sql_read is always included as a generic escape hatch; if nothing
// matches, the full toolbox is sent so capability is never lost.
const TOOL_TRIGGERS = {
    query_stats: /\b(stats?|statistics|overview|summary|dashboard|how many|total|count)\b/i,
    search_customers: /\b(customers?|shoppers?|buyers?|clients?|who is|email|phone|number|contact)\b/i,
    get_customer_360: /\b(customers?|shoppers?|buyers?|client|everything\s+about|how\s+many\s+orders|how\s+many\s+returns|latest\s+order|open\s+issues|spend|profile|360)\b|\b\d{10}\b/i,
    get_conversation_history: /\b(previous\s*(?:conversations?|interactions?|chats?|support|history)|what\s*did\s*the\s*customer\s*tell|when\s*did\s*they\s*last\s*contact|what\s*resolution|did\s*we\s*promise|repeat\s*issue|commitments?|promises?|support\s*history|last\s*contact)\b|TKT-[\w-]+/i,
    get_customer_behavior_patterns: /\b(behavior|patterns?|same\s*issue|size[- ]related|how\s*many\s*(?:returns|exchanges|complaints|cancellations|rtos)|history\s*pattern|habit|repeat\s*complaint|repeated\s*issue)\b/i,
    detect_repeat_contact: /\b(repeat\s*contacts?|repeated\s*contacts?|contacted\s*(?:us\s*)?before|multiple\s*times|same\s*(?:order|problem|issue)\s*again|reaching\s*out\s*again|contact\s*history|repeat\s*inquir\w*|repeat\s*query)\b/i,
    get_sales_by_sku: /\b(sku|best-?selling|sold|units|sales|revenue|how\s*many\s*(?:units|pieces|orders)|which\s*sku|top\s*(?:selling|sku)|sales\s*analytics|highest\s*revenue)\b/i,
    get_size_wise_sales: /\b(size|sizes|size-wise|sizewise|which\s*size|best-?selling\s*size|lowest-?selling\s*size|zero-?sales?|size\s*breakdown|demand\s*for\s*(?:xs|s|m|l|xl|xxl)|size\s*sales|size\s*comparison|more\s*[smlx]+\s*or\s*[smlx]+|stock\s*more|inventory\s*recommendation|black\s*[smlx]+|white\s*[smlx]+)\b/i,
    get_product_sku_info: /\b(product\s*(?:info|details?|catalog)|variants?|what\s*(?:sizes?|colours?|colors?)\s*exist|sku\s*info|is\s*sku|price\s*and\s*stock|active\s*sku|what\s*is\s*the\s*sku|product\s*available)\b/i,
    investigate_return_exchange: /\b(investigat\w*\s*(?:return|exchange|case)|return\s*investigat\w*|exchange\s*investigat\w*|can\s*(?:i|they)\s*exchange|unboxing\s*video|proof|damaged\s*item|wrong\s*(?:product|item)|exchange\s*.*for\s*size|size\s*m\s*.*size\s*l|refund\s*eligib\w*|recent\s*(?:exchanges?|returns?)|(?:tell|show|give|list|get)\s*(?:me\s*)?(?:\d+\s*)?(?:recent\s*)?(?:exchange|return)s?\s*(?:list|requests?|cases?)?|exchange\s*list)\b/i,
    check_refund_eligibility: /\b(refund\s*eligib\w*|can\s*(?:i|they)\s*get\s*a?\s*refund|eligible\s*for\s*(?:a\s*)?refund|refund\s*policy|store\s*credit\s*or\s*(?:bank|cash|original)|is\s*this\s*order\s*eligible\s*for\s*refund)\b/i,
    investigate_refund_status: /\b(refund\s*status|where\s*is\s*my\s*refund|refund\s*timeline|when\s*will\s*(?:i|my)\s*refund|has\s*the\s*refund\s*been|refund\s*processed|5-?7\s*(?:business\s*)?days|refund\s*delay\w*)\b/i,
    investigate_payment: /\b(payment\s*(?:investigat\w*|issue|status|discrepanc\w*|reconcil\w*)|double\s*charge\w*|charged\s*twice|cod\s*conversion|overcharg\w*|paid\s*more|courier\s*collected|edit\s*details\s*payment)\b/i,
    investigate_discount: /\b(discount\s*(?:investigat\w*|drop\w*|lost|remov\w*|missing)|coupon\s*(?:code|not\s*applied|disappear\w*|remov\w*|valid)|edit\s*details\s*discount|off10|promo\s*code|coupon\s*investigat\w*)\b/i,
    get_shipment_intelligence: /\b(shipment\s*intel\w*|carrier\s*(?:priority|sequence|status)|delivered\s*but\s*not\s*received|fake\s*deliver\w*|pod\s*request|proof\s*of\s*delivery|stuck\s*in\s*transit|shipment\s*delay\w*|rto\s*reason|shiprocket|delhivery|ekart)\b/i,
    investigate_rto: /\b(rto\s*investigat\w*|rto\s*status|rto\s*initiated|rto\s*delivered|why\s*(?:did|is)\s*(?:the\s*)?(?:order|package|shipment)\s*rto|rto\s*reason|at\s*risk\s*of\s*rto|rto\s*timeline|customer\s*refused|failed\s*delivery|delivery\s*failed|ndr|undelivered|post-?rto)\b/i,
    get_courier_analytics: /\b(courier\s*analytics|courier\s*performance|delivery\s*success\s*rate|courier\s*ranking|which\s*courier|best\s*courier|delhivery\s*vs\s*ekart|courier\s*comparison|rto\s*rate\s*by\s*courier|courier\s*speed|average\s*transit\s*time|courier\s*delay|pincode\s*performance)\b/i,
    investigate_return_pickup: /\b(return\s*pickup|pickup\s*investigat\w*|pickup\s*status|pickup\s*pending|pickup\s*attempt|pickup\s*failed|when\s*will\s*(?:the\s*)?pickup|reverse\s*pickup|has\s*the\s*pickup\s*been|pickup\s*sla|pickup\s*delay\w*|pickup\s*partner)\b/i,
    detect_delivery_anomalies: /\b(delivery\s*anomal\w*|anomaly\s*detect\w*|unusual\s*delivery|stuck\s*in\s*transit|excessive\s*attempts|rapid\s*deliver\w*|delivery\s*delay\w*|suspicious\s*deliver\w*|tracking\s*anomal\w*|pincode\s*failure\s*cluster|courier\s*surge)\b/i,
    get_complaint_patterns: /\b(complaint\s*patterns?|complaints?\s*analytics|recurring\s*(?:issues?|complaints?)|complaint\s*trend|ticket\s*trend|most\s*common\s*complaints?|grievance\s*pattern|complaint\s*categor\w*|customer\s*complaints?|complaints?\s*by\s*product|complaints?\s*by\s*courier)\b/i,
    get_return_exchange_analytics: /\b(return\s*analytics|exchange\s*analytics|return\s*rate|exchange\s*rate|which\s*sku\s*has\s*the\s*highest\s*return|which\s*size\s*has\s*the\s*most\s*exchanges|why\s*(?:are\s*)?customers\s*returning|returns?\s*by\s*product|returns?\s*by\s*sku|returns?\s*by\s*size|size\s*exchange\s*patterns?|product\s*problems?|defect\s*rate|highest\s*return\s*rate|most\s*exchanges)\b/i,
    get_location_analytics: /\b(location\s*analytics|pincode\s*analytics|city\s*analytics|state\s*analytics|which\s*pincodes?\s*have\s*the\s*highest\s*rto|where\s*(?:are\s*)?delivery\s*complaints\s*concentrated|which\s*cities\s*have\s*the\s*most\s*orders|orders\s*by\s*(?:city|pincode|state|location)|rto\s*by\s*(?:pincode|city|state|location)|highest\s*rto\s*pincode|delivery\s*delay\s*by\s*(?:city|pincode)|cod\s*cancellation\s*by\s*(?:city|pincode)|pincode\s*rto|city\s*orders|pincode\s*\d{6})\b/i,
    get_next_action_recommendation: /\b(what\s*(?:should|do|can)\s*(?:i|we)\s*do|what(?:'s|\s*is)\s*the\s*correct\s*process|how\s*(?:should|do|can)\s*(?:i|we)\s*handle|next\s*action|decision\s*assistant|sop\s*procedure|how\s*to\s*proceed|what\s*action\s*to\s*take|advise\s*me|customer\s*says?\s*.*(?:what\s*should\s*i|how\s*to\s*handle))\b/i,
    search_messages: /\b(messages?|chats?|conversations?|whatsapp|said|replied|history)\b/i,
    list_tickets: /\b(tickets?|support|complaints?|issues?|queries|grievance)\b/i,
    search_learned_replies: /\b(reply|replies|respond|draft|answer|suggest\w*|how (do|did|should) we)\b/i,
    update_ticket: /\b(tickets?|resolve|closed?|reopen)\b/i,
    get_abandoned_carts: /\b(carts?|abandon\w*|checkouts?|recover\w*)\b/i,
    shopify_search_orders: /\b(orders?|shopify|purchases?|bought|payments?|refunds?|fulfill?\w*|cod|prepaid)\b|#\d+/i,
    get_order_intelligence: /\b(orders?|details?|investigat\w*|what\s+happened|status|edited?|edits?|sizes?|originally|changed\s+to|couriers?|awb|payments?|shipped|tracking)\b|#?\d{4,6}/i,
    track_awb: /\b(track\w*|awb|waybill|shipments?|couriers?|deliver\w*|transit|shipping)\b/i,
    track_order_by_id: /\b(track\w*|orders?|status|where|deliver\w*|ship\w*)\b|#?\d{4,5}/i,
    check_serviceability: /\b(pin ?codes?|serviceab\w*|deliverable|cod|prepaid)\b/i,
    list_shipments: /\b(shipments?|shipped|awb|couriers?|labels?|manifest|shipping)\b/i,
    book_shipment: /\b(book\w*|ship\b|shipment|couriers?)\b/i,
    schedule_pickup: /\b(pick ?-?ups?)\b/i,
    send_whatsapp_message: /\b(send|message|whatsapp|reply|notify|inform|tell)\b/i,
    create_broadcast_draft: /\b(broadcasts?|campaigns?|blast|announce\w*)\b/i,
    run_sql_read: /\b(sql|query|database|db|tables?|select)\b/i,
    query_returns_system: /\b(returns?|exchanges?|influencers?|refunds?)\b/i,
    check_return_exchange_status: /\b(returns?|exchanges?|refunds?|pickups?)\b|req-\d+/i,
    batch_update_tickets: /\b(batch|bulk|mass|all tickets|resolve all|close all)\b/i,
    bulk_send_whatsapp: /\b(bulk\s*send|broadcast\s*whatsapp|mass\s*message|send\s*to\s*all)\b/i,
    batch_book_shipments: /\b(batch\s*ship|bulk\s*ship|ship\s*all|book\s*all)\b/i,
    smart_triage_tickets: /\b(triage|categorize|classify|prioritiz|sort\s*tickets)\b/i,
    get_pending_shipments: /\b(pending\s*ship|unshipped|not\s*shipped|ready\s*to\s*ship)\b/i
};

/** Pick only the tool schemas relevant to the given conversation context. */
function selectToolSchemas(contextText) {
    const text = String(contextText || '');
    const names = new Set(
        tools.filter(t => TOOL_TRIGGERS[t.name] && TOOL_TRIGGERS[t.name].test(text)).map(t => t.name)
    );
    if (!names.size) return getToolSchemas(); // ambiguous intent — full toolbox
    names.add('run_sql_read'); // generic fallback so routing misses stay answerable
    return tools
        .filter(t => names.has(t.name))
        .map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
}

/** Human-readable summary for a confirmation-gated action. */
function summarizeTool(name, args) {
    const tool = getTool(name);
    if (!tool) return name;
    if (typeof tool.summary === 'function') {
        try { return tool.summary(args || {}); } catch { return name; }
    }
    return `${name}(${JSON.stringify(args || {})})`;
}

module.exports = { tools, getTool, getToolSchemas, selectToolSchemas, summarizeTool, validateReadOnlySql };
