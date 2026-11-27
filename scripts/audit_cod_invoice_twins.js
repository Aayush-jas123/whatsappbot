#!/usr/bin/env node
/**
 * READ-ONLY audit: Shopify orders that carry TWO live Zoho invoices, one already
 * settled and one still owing. Those are duplicate bills, not uncollected COD —
 * the money was collected once, so the open twin must be VOIDED, never paid.
 * Paying it would book revenue nobody received.
 *
 * Why a separate report instead of a sweep fix: reconciliation keys on the order,
 * so once an order has a reconciled COD row the sweeper stops looking at it and
 * the twin stays overdue forever. That is what makes these invisible in the
 * dashboard while Zoho keeps chasing the amount.
 *
 * Usage:
 *   node scripts/audit_cod_invoice_twins.js                    # offline, cached snapshot
 *   node scripts/audit_cod_invoice_twins.js --snapshot=PATH     # another snapshot file
 *   node scripts/audit_cod_invoice_twins.js --live              # fresh ledger, ~250 paged calls
 *   node scripts/audit_cod_invoice_twins.js --limit=25          # examples printed
 *
 * Writes tmp/cod_invoice_twins_<date>.csv. Makes no write call of any kind.
 *
 * --live is the honest view; the snapshot is only as current as its mtime. The
 * invoice LIST row does carry reference_number / status / total / balance, which
 * is everything this classification needs — but it does NOT carry created_time,
 * credits_applied or payments, so any actual void must still re-read each
 * document and skip anything with a payment or credit on it.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = name => process.argv.includes(`--${name}`);

const SNAPSHOT = arg('snapshot', path.join(__dirname, '..', 'tmp', 'invoice_snapshot.json'));
const PRINT_LIMIT = parseInt(arg('limit', '15'), 10);
// Exchange/return/RTO documents bill different money against the same order
// reference on purpose, so they are legitimate siblings rather than twins.
const PROGRAM_DOC = /^(EXCH|RET|RETP|RTO)[-_]/i;

async function loadSnapshot() {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const invoices = Array.isArray(raw) ? raw : raw.invoices;
    if (!invoices || !invoices.length) throw new Error(`snapshot has no invoices: ${SNAPSHOT}`);
    const stamp = fs.statSync(SNAPSHOT).mtime.toISOString().slice(0, 10);
    return { invoices, source: `snapshot ${SNAPSHOT} (as of ${stamp})` };
}

/**
 * Pages the whole invoice ledger. Paced at ~1 call/second on purpose: Zoho
 * throttles bursts with an HTTP 400 that looks exactly like an empty result, so
 * a fast zero here would be a false "no duplicates" all-clear.
 */
async function loadLive() {
    const zohoService = require('../src/services/zohoService');
    const invoices = [];
    for (let page = 1; page <= 400; page++) {
        const rows = await zohoService.searchInvoice({ page, per_page: 200 });
        if (page === 1 && rows.length === 0) {
            throw new Error('first ledger page came back empty — throttling or auth, not an empty Books account');
        }
        invoices.push(...rows);
        console.log(`   page ${page}: +${rows.length} (total ${invoices.length})`);
        if (rows.length < 200) break;
        await new Promise(r => setTimeout(r, 1200));
    }
    return { invoices, source: `live Zoho Books ledger, fetched ${new Date().toISOString().slice(0, 10)}` };
}

/** Groups every order-numbered document and keeps settled-plus-open pairs. */
function classify(invoices) {
    const byRef = new Map();
    for (const inv of invoices) {
        const ref = String(inv.reference_number || '').trim().replace(/^#/, '');
        if (!/^\d+$/.test(ref)) continue;
        if (PROGRAM_DOC.test(inv.invoice_number || '')) continue;
        if (!byRef.has(ref)) byRef.set(ref, []);
        byRef.get(ref).push(inv);
    }

    const twins = [];
    let multiLive = 0;
    for (const [ref, list] of byRef) {
        const live = list.filter(i => i.status !== 'void' && i.status !== 'deleted');
        if (live.length < 2) continue;
        multiLive++;
        const isOwed = i => parseFloat(i.balance) > 0;
        const open = live.filter(isOwed);
        const settled = live.filter(i => !isOwed(i));
        if (!open.length || !settled.length) continue;
        // A "settled" sibling only proves the money arrived if it was actually
        // billed for something. A ₹0 document reaching paid says nothing, so on
        // those orders the open twin may be a genuine receivable, not a
        // duplicate — they must not be voided on the strength of this report.
        const collectionRecorded = settled.some(i => parseFloat(i.total || 0) > 0);
        twins.push({
            order_id: ref,
            // Normally one open twin; more than one means the order was billed 3x.
            open: open.map(i => ({ invoice: i.invoice_number, id: i.invoice_id, status: i.status, balance: parseFloat(i.balance) })),
            settled: settled.map(i => ({ invoice: i.invoice_number, id: i.invoice_id, status: i.status, total: parseFloat(i.total) })),
            phantom: open.reduce((s, i) => s + parseFloat(i.balance), 0),
            collectionRecorded,
        });
    }
    return { twins, multiLive, refs: byRef.size };
}

/**
 * Cross-checks our own COD log: an order we already reconciled yet still having
 * an open twin is proof the sweeper walked past it, not proof of fresh COD due.
 */
async function markReconciled(orderIds) {
    const { dbAdapter } = require('../src/database/db');
    const done = new Set();
    for (let i = 0; i < orderIds.length; i += 500) {
        const chunk = orderIds.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await dbAdapter.query(
            `SELECT DISTINCT REGEXP_REPLACE(shopify_order_id, '^#', '') AS order_id
             FROM zoho_cod_payments WHERE payment_status = 'reconciled'
               AND REGEXP_REPLACE(shopify_order_id, '^#', '') IN (${placeholders})`,
            chunk
        );
        rows.forEach(r => done.add(String(r.order_id)));
    }
    return done;
}

async function main() {
    const { invoices, source } = has('live') ? await loadLive() : await loadSnapshot();
    console.log(`\nScanning ${invoices.length} invoice rows — ${source}`);

    const { twins, multiLive, refs } = classify(invoices);
    const phantom = twins.reduce((s, t) => s + t.phantom, 0);
    const reconciled = await markReconciled(twins.map(t => t.order_id));
    const backed = twins.filter(t => t.collectionRecorded);
    const thin = twins.filter(t => !t.collectionRecorded);

    console.log(`\norders with a numeric invoice reference : ${refs}`);
    console.log(`  >1 live invoice                       : ${multiLive}`);
    console.log(`  settled twin AND still-owed twin      : ${twins.length}`);
    console.log(`    of which we already reconciled COD  : ${twins.filter(t => reconciled.has(t.order_id)).length}`);
    console.log(`  phantom receivable total              : ₹${phantom.toFixed(2)}`);
    console.log(`\nsplit by whether the settled sibling was really billed:`);
    console.log(`  void candidates (₹>0 already collected): ${backed.length} — ₹${backed.reduce((s, t) => s + t.phantom, 0).toFixed(2)}`);
    console.log(`  open twin may be genuinely due (only ₹0 siblings): ${thin.length} — ₹${thin.reduce((s, t) => s + t.phantom, 0).toFixed(2)}`);

    const out = path.join(__dirname, '..', 'tmp', `cod_invoice_twins_${new Date().toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(out, [
        'order_id,zoho_cod_reconciled,open_invoice,open_status,open_balance,open_invoice_id,settled_sibling_billed,settled_invoice,settled_status,settled_total',
        ...twins.map(t => t.open.map(o => [
            t.order_id, reconciled.has(t.order_id) ? 'yes' : 'no',
            o.invoice, o.status, o.balance.toFixed(2), o.id,
            t.collectionRecorded ? 'yes' : 'no',
            t.settled.map(s => `${s.invoice} (${s.status} ₹${parseFloat(s.total).toFixed(2)})`).join(' + '),
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'))
    ].join('\n') + '\n');

    console.log(`\nvoid candidates (settled sibling was billed ₹>0), showing ${Math.min(PRINT_LIMIT, backed.length)} of ${backed.length}:`);
    backed.slice(0, PRINT_LIMIT).forEach(t => console.log(
        `  #${t.order_id}${reconciled.has(t.order_id) ? ' [COD reconciled]' : '                  '} ` +
        `owed ${t.open.map(o => `${o.invoice} ${o.status} ₹${o.balance.toFixed(2)}`).join(' + ')}  |  ` +
        `paid ${t.settled.map(s => s.invoice).join(', ')}`
    ));
    console.log(`\nfull report: ${out}`);
    console.log('Nothing was changed in Zoho. Review the CSV, then void per document —');
    console.log('re-read each one first: the list payload has no created_time, credits_applied');
    console.log('or payments, and anything carrying a payment or credit must be left alone.');
}

main()
    .then(() => process.exit(0))     // the pg pool keeps handles open otherwise
    .catch(err => { console.error(`\n❌ audit failed: ${err.message}`); process.exit(1); });
