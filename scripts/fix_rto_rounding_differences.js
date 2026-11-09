#!/usr/bin/env node
/**
 * Fix rounding differences on RTO invoices
 * Creates additional credit notes for the exact remaining balance
 * Handles both small (₹1-10) and larger (₹10-100) residuals
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zohoService = require('../src/services/zohoService');

const WINDOW_START = '2026-09-01';

function log(msg) {
  console.log(`[FIX] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('Fetching overdue invoices with small balances...');
  
  const allInvoices = [];
  let page = 1;
  const perPage = 200;
  
  while (true) {
    const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/invoices`, null, {
      status: 'overdue',
      date_start: WINDOW_START,
      per_page: perPage,
      page: page
    });
    
    const invoices = result.invoices || [];
    if (invoices.length === 0) break;
    
    allInvoices.push(...invoices);
    
    if (invoices.length < perPage) break;
    page++;
    await sleep(300);
  }

  log(`Found ${allInvoices.length} overdue invoices`);

  // Fetch RTO credit notes to build order number set and customer info
  log('Fetching RTO credit notes...');
  
  const allCreditNotes = [];
  page = 1;
  
  while (true) {
    const result = await zohoService.zohoRequest('get', `${zohoService.BOOKS_BASE()}/creditnotes`, null, {
      date_start: WINDOW_START,
      per_page: perPage,
      page: page
    });
    
    const creditNotes = result.creditnotes || [];
    if (creditNotes.length === 0) break;
    
    allCreditNotes.push(...creditNotes);
    
    if (creditNotes.length < perPage) break;
    page++;
    await sleep(300);
  }

  // Build set of order numbers with RTO credit notes + customer info map + tax type
  const rtoOrderSet = new Set();
  const customerMap = new Map();
  // Orders that already got a rounding note: this script ran twice on 22 Oct
  // and issued a second RTO-ROUND note for the same order on ~200 invoices,
  // because nothing here remembered the notes it had just created.
  const alreadyRounded = new Set();
  for (const cn of allCreditNotes) {
    const ref = cn.reference_number || '';
    const roundMatch = ref.match(/^RTO-ROUND-.*?(\d{3,})/);
    if (roundMatch) alreadyRounded.add(roundMatch[1]);
    const match = ref.match(/RTO[-_]?(?:MISC[-_]|ROUND[-_])?(\d+)/);
    if (match) {
      const orderNum = match[1];
      rtoOrderSet.add(orderNum);
      if (!customerMap.has(orderNum)) {
        // Detect tax type from credit note line items
        let taxType = 'igst'; // default
        if (cn.line_items && cn.line_items.length > 0) {
          const firstItem = cn.line_items[0];
          if (firstItem.cgst_rate || firstItem.sgst_rate) {
            taxType = 'cgst_sgst';
          } else if (firstItem.igst_rate) {
            taxType = 'igst';
          }
        }
        customerMap.set(orderNum, {
          customer_id: cn.customer_id,
          customer_name: cn.customer_name,
          tax_type: taxType
        });
      }
    }
  }

  log(`Found ${allCreditNotes.length} credit notes, ${rtoOrderSet.size} with RTO references`);

  // Debug: show sample RTO order numbers
  const sampleRtoOrders = Array.from(rtoOrderSet).slice(0, 5);
  log(`Sample RTO order numbers: ${sampleRtoOrders.join(', ')}`);

  // Debug: show invoices with balances
  const balInvoices = allInvoices.filter(inv => {
    const balance = parseFloat(inv.balance);
    return balance > 0.5 && balance <= 100;
  });
  log(`Invoices with balance ₹0.50-100: ${balInvoices.length}`);
  if (balInvoices.length > 0) {
    const sample = balInvoices.slice(0, 3);
    for (const inv of sample) {
      const invRef = inv.reference_number || '';
      const orderNum = invRef.replace(/^#/, '').replace(/.*\//, '').trim();
      log(`  Sample: ${inv.invoice_number}, balance: ₹${inv.balance}, credits: ₹${inv.credits_applied}, orderNum: ${orderNum}, inRtoSet: ${rtoOrderSet.has(orderNum)}`);
    }
  }

  // Filter to invoices with balances (₹0.50-100) that have RTO credit notes
  // Expanded from ₹1-10 to catch larger residuals like ₹61.86
  const smallBalanceInvoices = allInvoices.filter(inv => {
    const balance = parseFloat(inv.balance);
    const invRef = inv.reference_number || '';
    const orderNum = invRef.replace(/^#/, '').replace(/.*\//, '').trim();
    
    // Balance in range + in RTO set = needs rounding fix
    return balance > 0.5 && balance <= 100 && rtoOrderSet.has(orderNum)
        && !alreadyRounded.has(orderNum);
  });

  log(`Found ${smallBalanceInvoices.length} invoices with balances (₹0.50-100) and RTO credit notes`);

  if (smallBalanceInvoices.length === 0) {
    log('No invoices to fix');
    return;
  }

  // Process each small balance invoice
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];
  let totalFixed = 0;

  for (let i = 0; i < smallBalanceInvoices.length; i++) {
    const inv = smallBalanceInvoices[i];
    const balance = parseFloat(inv.balance);
    
    try {
      // Extract order number
      const invRef = inv.reference_number || '';
      const orderNum = invRef.replace(/^#/, '').replace(/.*\//, '').trim();
      
      const customerInfo = customerMap.get(orderNum);
      if (!customerInfo) {
        log(`  [${i+1}/${smallBalanceInvoices.length}] ⚠️  ${inv.invoice_number}: No customer info found`);
        skipped++;
        continue;
      }
      
      // The note is issued tax-INCLUSIVE (is_inclusive_tax: true below), the
      // same basis as the invoice, so the line rate IS the amount credited:
      // rate = balance. Searching for a rate whose rate+GST equals the balance
      // makes Books extract the GST inside the given rate, so the note credits
      // less than the balance and the invoice keeps owing tax — the very
      // residual this script exists to clear, which is how one invoice ended up
      // with an RTO note, an RTO-MISC note and two RTO-ROUND notes.
      const lineItem = {
        name: 'RTO Rounding Adjustment',
        description: 'Adjustment for tax rounding difference on RTO order',
        quantity: 1,
        rate: Math.round(balance * 100) / 100
      };
            
      // Apply tax based on invoice tax type
      if (customerInfo.tax_type === 'cgst_sgst') {
        lineItem.cgst_rate = 2.5;
        lineItem.sgst_rate = 2.5;
      } else {
        lineItem.igst_rate = 5;
      }
      
      const creditNotePayload = {
        customer_id: customerInfo.customer_id,
        customer_name: customerInfo.customer_name,
        date: new Date().toISOString().split('T')[0],
        line_items: [lineItem],
        notes: `RTO rounding adjustment — Shopify Order ${orderNum}`,
        reference_number: `RTO-ROUND-${inv.reference_number || inv.invoice_number}`,
        is_inclusive_tax: true
      };

      const cnResult = await zohoService.zohoRequest(
        'post',
        `${zohoService.BOOKS_BASE()}/creditnotes`,
        creditNotePayload,
        { invoice_id: inv.invoice_id }
      );
      
      const creditNoteNumber = cnResult.creditnote.creditnote_number;
      
      log(`  [${i+1}/${smallBalanceInvoices.length}] ✅ ${inv.invoice_number} (Order ${orderNum}): ₹${balance.toFixed(2)} → ${creditNoteNumber}`);
      created++;
      totalFixed += balance;

      await sleep(600);

    } catch (err) {
      log(`  [${i+1}/${smallBalanceInvoices.length}] ❌ ${inv.invoice_number}: ${err.message}`);
      failed++;
      errors.push(`${inv.invoice_number}: ${err.message}`);
      
      if (err.message.includes('400') || err.message.includes('network') || err.message.includes('timeout')) {
        log('  ⏳ Waiting 30s before retry...');
        await sleep(30000);
      }
    }
  }

  log('\n========================================');
  log(`Fix complete!`);
  log(`  Created: ${created}`);
  log(`  Skipped: ${skipped}`);
  log(`  Failed:  ${failed}`);
  log(`  Total fixed: ₹${totalFixed.toFixed(2)}`);
  log('========================================\n');

  if (errors.length > 0) {
    log('Failed invoices:');
    errors.forEach(e => log(`  - ${e}`));
  }

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    totalInvoices: smallBalanceInvoices.length,
    created,
    skipped,
    failed,
    totalFixed,
    errors
  };

  const reportPath = path.join(__dirname, `../tmp/rto_rounding_fix_${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Report written to ${reportPath}`);
}

main().catch(err => {
  console.error('[FIX] Fatal error:', err);
  process.exit(1);
});
