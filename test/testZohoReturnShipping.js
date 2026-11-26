// Offline regression test for charge lines on full Zoho returns.
// Run: node test/testZohoReturnShipping.js

const assert = require('assert/strict');
const zohoService = require('../src/services/zohoService');
const zohoCodService = require('../src/services/zohoCodService');
const { dbAdapter } = require('../src/database/db');
const { prepareAndCreateCreditNote } = require('../src/services/zohoReturnService');

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
let invoice;
let notes;
let payloads;

function makeInvoice({ quantity = 1, rate = 1199 } = {}) {
    const total = round2(rate * quantity + 99);
    return {
        invoice_id: 'INV-59526',
        invoice_number: 'OFF/26-27/59526',
        reference_number: '73237',
        customer_id: 'CUST-1',
        date: '2026-11-21',
        status: 'overdue',
        is_inclusive_tax: true,
        total,
        credits_applied: 0,
        balance: total,
        line_items: [
            {
                item_id: 'ITEM-HENLEY',
                name: 'HENLEY - 001 (GREY) - M',
                sku: 'HENLEY-001-GREY-M',
                quantity,
                rate,
                discount: 0,
                item_total: round2(rate * quantity / 1.05),
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            },
            {
                item_id: 'ITEM-SHIPPING',
                name: 'Shipping',
                description: 'Shipping for Order #73237',
                quantity: 1,
                rate: 99,
                discount: 0,
                item_total: 94.29,
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            }
        ]
    };
}

function reset(options) {
    invoice = makeInvoice(options);
    notes = [];
    payloads = [];

    zohoCodService.ensureInvoiceExists = async () => [{ ...invoice }];
    zohoService.getInvoice = async () => ({ ...invoice });
    zohoService.getOrCreateCustomer = async () => ({ contact_id: 'CUST-1' });
    zohoService.searchCreditNotes = async ({ reference_number, search_text } = {}) => {
        if (reference_number) {
            return notes.filter(n => n.reference_number === reference_number);
        }
        if (search_text) {
            return notes.filter(n => `${n.reference_number} ${n.invoice_number}`.includes(search_text));
        }
        return notes.slice();
    };
    zohoService.createCreditNote = async (payload) => {
        payloads.push(payload);
        const total = round2((payload.line_items || []).reduce((sum, line) => {
            const net = round2((parseFloat(line.rate) || 0) * (parseFloat(line.quantity) || 1)
                - (parseFloat(line.discount) || 0));
            const tax = (parseFloat(line.cgst_rate) || 0) + (parseFloat(line.sgst_rate) || 0)
                + (parseFloat(line.igst_rate) || 0);
            return sum + (payload.is_inclusive_tax ? net : net * (1 + tax / 100));
        }, 0));
        const remaining = round2(invoice.total - invoice.credits_applied);
        assert.ok(total <= remaining + 0.02, `credit ₹${total} exceeds remaining ₹${remaining}`);

        const note = {
            creditnote_id: `CN-${notes.length + 1}`,
            creditnote_number: `CN/26-27/${String(notes.length + 1).padStart(5, '0')}`,
            reference_number: payload.reference_number,
            invoice_number: invoice.invoice_number,
            line_items: payload.line_items,
            status: 'closed',
            total,
            balance: 0
        };
        notes.push(note);
        invoice.credits_applied = round2(invoice.credits_applied + total);
        invoice.balance = round2(invoice.total - invoice.credits_applied);
        return note;
    };
    zohoService.applyCreditNote = async () => ({ code: 0 });
    dbAdapter.query = async (sql) => (/zoho_bundle_map/.test(sql) ? [] : []);
}

const shopifyOrder = {
    order_number: '73237',
    email: 'buyer@example.com',
    phone: '+919000000000',
    customer: { first_name: 'Test', last_name: 'Buyer' },
    shipping_address: { province: 'West Bengal' },
    total_price: 1298
};

function returnedItem(quantity = 1, price = 1199) {
    return {
        title: 'HENLEY - 001 (GREY) - M',
        sku: 'HENLEY-001-GREY-M',
        quantity,
        price
    };
}

async function credit({ returnType, reference, quantity = 1, price = 1199, invoiceOptions } = {}) {
    reset(invoiceOptions);
    const result = await prepareAndCreateCreditNote({
        shopifyOrder,
        orderId: '73237',
        returnItems: [returnedItem(quantity, price)],
        returnType,
        reference
    });
    assert.equal(result.success, true);
    return result;
}

function hasShipping(note) {
    return (note.line_items || []).some(line => /shipping/i.test(`${line.name} ${line.description || ''}`));
}

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

(async () => {
    await check('full Shopify return credits product and shipping in one note', async () => {
        await credit({ returnType: 'return', reference: 'RET-73237-1003712545012' });
        assert.equal(notes.length, 1);
        assert.equal(notes[0].total, 1298);
        assert.equal(payloads[0].line_items.length, 2);
        assert.equal(hasShipping(notes[0]), true);
        assert.equal(payloads[0].line_items[1].igst_rate, 5);
        assert.equal(invoice.balance, 0);
    });

    await check('partial return leaves shipping outstanding', async () => {
        await credit({
            returnType: 'return',
            reference: 'RET-73237-partial',
            invoiceOptions: { quantity: 2, rate: 599.5 }
        });
        assert.equal(notes.length, 1);
        assert.equal(notes[0].total, 599.5);
        assert.equal(hasShipping(notes[0]), false);
        assert.equal(invoice.balance, 698.5);
    });

    await check('exchange credit note still excludes original shipping', async () => {
        await credit({ returnType: 'exchange', reference: 'EXCH-73237' });
        assert.equal(notes.length, 1);
        assert.equal(notes[0].total, 1199);
        assert.equal(hasShipping(notes[0]), false);
        assert.equal(invoice.balance, 99);
    });

    await check('full RTO behavior remains unchanged', async () => {
        await credit({ returnType: 'rto', reference: 'RTO-73237' });
        assert.equal(notes.length, 1);
        assert.equal(notes[0].total, 1298);
        assert.equal(hasShipping(notes[0]), true);
        assert.equal(invoice.balance, 0);
    });

    console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
    process.exit(failures ? 1 : 0);
})().catch(error => {
    console.error(`Fatal: ${error.stack || error.message}`);
    process.exit(1);
});
