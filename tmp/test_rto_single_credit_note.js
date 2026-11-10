#!/usr/bin/env node
/**
 * End-to-end (offline) proof of the "one invoice, one credit note" fix.
 *
 * Nothing here talks to Zoho or Postgres. A tiny in-memory Zoho Books is
 * simulated — it prices credit note lines the way Books does, links a note to
 * the invoice passed as the invoice_id query parameter and auto-applies it —
 * and the REAL zohoReturnService source is loaded, so the flow under test is
 * byte-identical to what runs in production.
 *
 * The three cases are the exact invoice shapes pulled from production:
 *   1. ₹1,199 tax-inclusive product + ₹99 shipping   (order 65569 / OFF/26-27/51583)
 *   2. a returned BUNDLE that invoices as two components + ₹99 shipping (65405)
 *   3. the same order re-triggered through a DIFFERENT prefix (RET- vs RTO-)
 *
 * Before the fix each of 1 and 2 left a residual the finance team chased with
 * an RTO-MISC note and then an RTO-ROUND note; 3 is the trigger that silently
 * wrote a second document on top of the first.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src', 'services', 'zohoReturnService.js');
const zohoService = require(path.join(__dirname, '..', 'src', 'services', 'zohoService'));
const zohoCodService = require(path.join(__dirname, '..', 'src', 'services', 'zohoCodService'));
const { dbAdapter } = require(path.join(__dirname, '..', 'src', 'database', 'db'));

// ============================================================
// Fake Zoho Books
// ============================================================
let invoicesById = {};
let notes = [];               // credit notes already "in Zoho"
let applied = [];             // applyCreditNote calls, in order
let bundleRows = [];
let nextNoteNumber = 1;

const round2 = (n) => Math.round(n * 100) / 100;
const r2sum = (list) => round2(list.reduce((s, n) => s + (parseFloat(n) || 0), 0));

/**
 * Prices a line exactly as Books does. On a tax-INCLUSIVE document the GST
 * lives INSIDE the rate (rate 1199 @5% → item_total 1141.90, line total still
 * 1199), so the grand total is simply Σ(rate × qty − discount). On an
 * exclusive document the tax is added on top.
 */
function priceNote(payload) {
    const inclusive = !!payload.is_inclusive_tax;
    const lines = (payload.line_items || []).map(l => {
        const net = round2((parseFloat(l.rate) || 0) * (parseFloat(l.quantity) || 1) - (parseFloat(l.discount) || 0));
        const pct = (parseFloat(l.cgst_rate) || 0) + (parseFloat(l.sgst_rate) || 0) + (parseFloat(l.igst_rate) || 0);
        const tax = inclusive ? round2(net - net / (1 + pct / 100)) : round2(net * pct / 100);
        return { ...l, amount: net, tax_total: tax, tax_percentage: pct, total: inclusive ? net : round2(net + tax) };
    });
    return { lines, total: round2(lines.reduce((s, l) => s + l.total, 0)) };
}

zohoCodService.ensureInvoiceExists = async (orderId) => {
    const hit = Object.values(invoicesById).find(i => String(i.reference_number).includes(String(orderId)));
    return hit ? [{ ...hit }] : [];
};
// Every fetch returns a SNAPSHOT, like the real API: the caller's copy must not
// change when the note is created, or ensureCreditNoteApplied cannot see that
// Books has already applied it and would apply the amount a second time.
zohoService.getInvoice = async (id) => invoicesById[id] ? { ...invoicesById[id] } : null;
zohoService.getOrCreateCustomer = async () => ({ contact_id: 'CUST-1' });
zohoService.addInvoiceComment = async () => ({ code: 0 });
zohoService.searchInvoice = async () => [];

zohoService.createCreditNote = async (payload) => {
    const { invoice_id, ...body } = payload;
    const priced = priceNote(body);
    const invoice = invoicesById[invoice_id];
    if (!invoice) throw new Error('400: invoice not found');
    const remaining = round2(parseFloat(invoice.total) - (parseFloat(invoice.credits_applied) || 0));
    if (priced.total > remaining + 0.02) {
        throw new Error(`400: credit note total ₹${priced.total} exceeds creditable ₹${remaining}`);
    }
    const note = {
        creditnote_id: `CN-${nextNoteNumber}`,
        creditnote_number: `CN/26-27/0000${nextNoteNumber}`,
        reference_number: body.reference_number,
        customer_id: body.customer_id,
        invoice_number: invoice.invoice_number,
        line_items: priced.lines,
        total: priced.total,
        balance: 0
    };
    nextNoteNumber++;
    notes.push(note);
    // Books auto-applies a note created against an invoice
    invoice.credits_applied = round2((parseFloat(invoice.credits_applied) || 0) + priced.total);
    invoice.balance = round2(parseFloat(invoice.total) - invoice.credits_applied);
    return note;
};
zohoService.applyCreditNote = async (creditNoteId, invoiceId, amount) => {
    applied.push({ creditNoteId, invoiceId, amount: round2(amount) });
    const invoice = invoicesById[invoiceId];
    const note = notes.find(n => n.creditnote_id === creditNoteId);
    invoice.credits_applied = round2((parseFloat(invoice.credits_applied) || 0) + amount);
    invoice.balance = round2(parseFloat(invoice.total) - invoice.credits_applied);
    if (note) {
        note.balance = round2((parseFloat(note.balance) || 0) - amount);
        // Books closes a note once nothing is left unapplied
        if (note.balance <= 0.01) { note.status = 'closed'; note.balance = 0; }
    }
    return { code: 0 };
};
zohoService.searchCreditNotes = async ({ reference_number, search_text } = {}) => {
    if (reference_number) return notes.filter(n => String(n.reference_number).trim() === String(reference_number).trim());
    if (search_text) return notes.filter(n => `${n.reference_number} ${n.invoice_number}`.includes(String(search_text)));
    return notes.slice();
};

dbAdapter.query = async (sql) => (/zoho_bundle_map/.test(sql) ? bundleRows : []);

// ---------------------------------------------------------- load the real source
const mod = new Module(SRC, null);
mod.filename = SRC;
mod.paths = Module._nodeModulePaths(path.dirname(SRC));
mod._compile(fs.readFileSync(SRC, 'utf8'), SRC);
const { prepareAndCreateCreditNote } = mod.exports;

// ============================================================
// Assertions
// ============================================================
let passed = 0, failed = 0;
function check(label, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function invoice51583() {
    return {
        invoice_id: 'INV-51583',
        invoice_number: 'OFF/26-27/51583',
        reference_number: '65569',
        customer_id: 'CUST-1',
        date: '2026-11-07',
        status: 'sent',
        is_inclusive_tax: true,
        total: 1298.00,
        credits_applied: 0,
        balance: 1298.00,
        line_items: [
            {
                item_id: 'ITEM-RAGLAN', name: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M',
                quantity: 1, rate: 1199.00, discount: 0,
                item_total: 1141.90,           // ex-GST — the trap
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            },
            {
                item_id: 'ITEM-SHIP', name: 'Shipping Charges', description: 'Shipping',
                quantity: 1, rate: 99.00, discount: 0, item_total: 94.29,
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            }
        ]
    };
}

/** Same invoice, but the customer bought two units of the same product. */
function invoice51583Partial() {
    const inv = invoice51583();
    inv.line_items[0].quantity = 2;
    inv.line_items[0].rate = 599.50;      // ₹1,199 across two units
    return inv;
}

function invoice51415() {
    return {
        invoice_id: 'INV-51415',
        invoice_number: 'OFF/26-27/51415',
        reference_number: '65405',
        customer_id: 'CUST-1',
        date: '2026-11-06',
        status: 'sent',
        is_inclusive_tax: true,
        total: 2098.00,
        credits_applied: 0,
        balance: 2098.00,
        line_items: [
            {
                item_id: 'ITEM-A', name: 'TRIPLE-BUNDLE - M (ACID WASH)', sku: 'TRIPLE-A',
                quantity: 1, rate: 999.50, discount: 0, item_total: 951.90,
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            },
            {
                item_id: 'ITEM-B', name: 'TRIPLE-BUNDLE - M (STONE WASH)', sku: 'TRIPLE-B',
                quantity: 1, rate: 999.50, discount: 0, item_total: 951.90,
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            },
            {
                item_id: 'ITEM-SHIP', name: 'Shipping Charges', description: 'Shipping',
                quantity: 1, rate: 99.00, discount: 0, item_total: 94.29,
                taxes: [{ tax_name: 'IGST', rate: 5 }]
            }
        ]
    };
}

const shopifyOrder = (orderNumber) => ({
    order_number: orderNumber,
    email: 'buyer@example.com',
    phone: '+919000000000',
    customer: { first_name: 'Leetom', last_name: 'Damei' },
    shipping_address: { province: 'Mizoram' },
    total_price: 1298
});

function reset(invoice) {
    invoicesById = { [invoice.invoice_id]: invoice };
    notes = [];
    applied = [];
    nextNoteNumber = 1;
}

(async () => {
    // ---------------------------------------------------------------- CASE 1
    console.log('\n1️⃣  Single tax-inclusive product + shipping, full RTO (production shape of OFF/26-27/51583)');
    reset(invoice51583());
    let res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 1199 }],
        returnType: 'rto',
        reference: 'RTO-65569'
    });
    const inv1 = invoicesById['INV-51583'];
    check('one credit note created', notes.length === 1, `got ${notes.length}`);
    check('product line keeps the invoice rate ₹1,199 (not the ex-GST ₹1,141.90)',
        round2(parseFloat(inv1 && notes[0] && notes[0].line_items[0].rate)) === 1199,
        notes[0] && `got ${notes[0].line_items[0].rate}`);
    check('shipping reversed inside the same note',
        notes.length === 1 && notes[0].line_items.some(l => /shipping/i.test(`${l.name} ${l.description || ''}`)));
    check('note credits the FULL invoice ₹1,298.00', notes[0] && notes[0].total === 1298, notes[0] && `got ₹${notes[0].total}`);
    check('invoice balance is ₹0.00', inv1.balance === 0, `got ₹${inv1.balance}`);
    check('flow reports success', res.success === true && !res.fullyCredited);

    // ---------------------------------------------------------------- CASE 2
    console.log('\n2️⃣  Returned bundle credited as two components + shipping (OFF/26-27/51415)');
    bundleRows = [
        { bundle_sku: 'TRIPLE-BUNDLE', component_sku: 'TRIPLE-BUNDLE - M (ACID WASH)', component_qty: 1, gst_rate: 5 },
        { bundle_sku: 'TRIPLE-BUNDLE', component_sku: 'TRIPLE-BUNDLE - M (STONE WASH)', component_qty: 1, gst_rate: 5 }
    ];
    reset(invoice51415());
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65405'),
        orderId: '65405',
        // The bundle arrives as ONE line even though the invoice has two
        returnItems: [{ title: 'TRIPLE-BUNDLE', sku: 'TRIPLE-BUNDLE', quantity: 1, price: 1999, variant: 'M' }],
        returnType: 'rto',
        reference: 'RTO-65405'
    });
    const inv2 = invoicesById['INV-51415'];
    check('one credit note created', notes.length === 1, `got ${notes.length}`);
    check('both bundle components credited at ₹999.50',
        notes[0] && notes[0].line_items.filter(l => l.amount === 999.5).length === 2,
        notes[0] && JSON.stringify(notes[0].line_items.map(l => l.amount)));
    check('shipping reversal included (all-items test sees expanded qty)',
        notes.length === 1 && notes[0].line_items.some(l => /shipping/i.test(`${l.name} ${l.description || ''}`)));
    check('note credits the FULL invoice ₹2,098.00', notes[0] && notes[0].total === 2098, notes[0] && `got ₹${notes[0].total}`);
    check('invoice balance is ₹0.00', inv2.balance === 0, `got ₹${inv2.balance}`);

    // ---------------------------------------------------------------- CASE 3
    console.log('\n3️⃣  Same fully-credited order re-triggered under a different prefix (RET- after RTO-)');
    const notesBefore = notes.length;
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65405'),
        orderId: '65405',
        returnItems: [{ title: 'TRIPLE-BUNDLE', sku: 'TRIPLE-BUNDLE', quantity: 1, price: 1999, variant: 'M' }],
        returnType: 'return',
        reference: 'RET-65405-refund-99'
    });
    check('no second document written', notes.length === notesBefore, `notes went ${notesBefore} → ${notes.length}`);
    check('flow reports nothing left to credit', res.success === true && (res.alreadyProcessed || res.fullyCredited), JSON.stringify(res));
    check('invoice still at ₹0.00', invoicesById['INV-51415'].balance === 0, `got ₹${invoicesById['INV-51415'].balance}`);

    // ---------------------------------------------------------------- CASE 4
    console.log('\n4️⃣  Partial return (1 of 2 units) → one note for that unit only, shipping stays payable');
    bundleRows = [];
    reset(invoice51583Partial());
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 599.50 }],
        returnType: 'rto',
        reference: 'RTO-65569'
    });
    const inv4 = invoicesById['INV-51583'];
    check('one note of ₹599.50', notes.length === 1 && notes[0].total === 599.50,
        notes.map(n => `₹${n.total}`).join(', ') || 'none');
    check('shipping NOT reversed while units remain unpaid',
        notes.length === 1 && !notes[0].line_items.some(l => /shipping/i.test(`${l.name} ${l.description || ''}`)));
    check('balance drops to ₹698.50', inv4.balance === 698.50, `got ₹${inv4.balance}`);

    // ---------------------------------------------------------------- CASE 5
    console.log('\n5️⃣  The SECOND unit returned later, under a different prefix — legitimately a 2nd note');
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 599.50 }],
        returnType: 'return',
        reference: 'RET-65569-REFUND-42'
    });
    check('a second note was allowed (the ledger was not yet at the invoice total)', notes.length === 2, `got ${notes.length}`);
    check('second note is also ₹599.50', notes[1] && notes[1].total === 599.50, notes[1] && `got ₹${notes[1].total}`);
    check('two notes never exceed the invoice total', notes.reduce((s, n) => s + n.total, 0) <= 1298.01);
    check('shipping ₹99.00 still due (correctly not reversed on a part return)',
        invoicesById['INV-51583'].balance === 99, `got ₹${invoicesById['INV-51583'].balance}`);

    // ---------------------------------------------------------------- CASE 6
    console.log('\n6️⃣  Production shape of OFF/26-27/47489: a full-amount note raised on top of an UNAPPLIED one');
    bundleRows = [];
    const inv6 = invoice51583();
    reset(inv6);
    // An earlier RTO note already reverses the whole invoice but Books left it
    // OPEN (unapplied) — the invoice still shows the full amount due.
    notes.push({
        creditnote_id: 'CN-EARLY', creditnote_number: 'CN/26-27/07365',
        reference_number: 'RTO-65569', invoice_number: inv6.invoice_number,
        status: 'open', total: 1298.00, balance: 1298.00, line_items: []
    });
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 1199 }],
        returnType: 'rto',
        reference: 'RTO-65569-2'
    });
    check('no second full-amount document was written', notes.length === 1, `got ${notes.length}`);
    check('flow reports alreadyProcessed', res.alreadyProcessed === true, JSON.stringify(res));
    check('the unapplied note was APPLIED instead', applied.some(a => a.creditNoteId === 'CN-EARLY'),
        JSON.stringify(applied));
    check('invoice now at ₹0.00', invoicesById['INV-51583'].balance === 0, `got ₹${invoicesById['INV-51583'].balance}`);

    // ---------------------------------------------------------------- CASE 7
    console.log('\n7️⃣  Ledger only partly reversed → the new note is capped to the headroom, not the full amount');
    reset(invoice51583());
    notes.push({
        creditnote_id: 'CN-EARLY-2', creditnote_number: 'CN/26-27/07366',
        reference_number: 'RTO-65569', invoice_number: invoicesById['INV-51583'].invoice_number,
        status: 'open', total: 1199.00, balance: 1199.00, line_items: []
    });
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 1199 }],
        returnType: 'rto',
        reference: 'RTO-65569-3'
    });
    check('one extra note issued', notes.length === 2, `got ${notes.length}`);
    check('capped to the ₹99.00 headroom instead of repeating ₹1,298',
        notes[1] && notes[1].total === 99, notes[1] && `got ₹${notes[1].total}`);
    check('ledger now sums exactly to the invoice total',
        r2sum(notes.map(n => n.total)) === 1298, `got ₹${r2sum(notes.map(n => n.total))}`);

    // ---------------------------------------------------------------- CASE 8
    console.log('\n8️⃣  Sub-₹1 residual must not earn its own document (the RTO-ROUND note)');
    reset({ ...invoice51583(), credits_applied: 1297.40, balance: 0.60 });
    res = await prepareAndCreateCreditNote({
        shopifyOrder: shopifyOrder('65569'),
        orderId: '65569',
        returnItems: [{ title: 'RAGLAN 001 - M', sku: 'RAGLAN-001-M', quantity: 1, price: 1199 }],
        returnType: 'rto',
        reference: 'RTO-65569'
    });
    check('no credit note issued for ₹0.60 dust', notes.length === 0, `got ${notes.length}`);
    check('flow reports fullyCredited', res.fullyCredited === true, JSON.stringify(res));

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('💥 Fatal:', err);
    process.exit(1);
});
