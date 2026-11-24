'use strict';
// The storefront must never receive internal ops events (portal routing, team
// hand-offs, triage levels, named-staff actions) — they were rendered as chat
// chips next to the customer's own conversation.
// Runs fully offline: customerTicket and isCustomerVisibleEntry are pure, the
// pg pool created by the service module never gets a query.
// Run: node --test test/testSupportThreadPrivacy.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Support = require('../src/services/supportService');

/* ───────────────────────── fixtures ───────────────────────── */

// The thread shape TKT-73673 actually carries: raise, description, then every
// desk action appended as an event.
function deskRow(thread) {
    return {
        id: 41,
        ticket_number: 'TKT-73673',
        order_id: '73673',
        status: 'open',
        priority: 'high',
        reason: 'delivery', reason_label: 'Delivery & address',
        sub: 'other', sub_label: 'Other',
        message: 'where is my parcel',
        csat: 0,
        reopen_count: 0,
        payment_link: null,
        created_at: '2026-11-23T15:18:00.000Z',
        updated_at: '2026-11-23T16:02:00.000Z',
        // Desk-only columns that must stay out of the customer payload.
        notes: [{ text: 'customer is loud, tread carefully', at: 1 }],
        assigned_to: 'Nitin',
        history: [{ order_id: '73673', total: 2499 }],
        thread
    };
}

const event = (text, extra = {}) => ({ kind: 'event', text, at: Date.now(), ...extra });
const msg = (role, text) => ({ role, text, at: Date.now() });

/* ───────────────────────── hidden events ───────────────────────── */

const HIDDEN = [
    'Auto-routed to NITIN (shift portal, least load)',
    'Assigned to Chat support',
    'Assigned to Returns & QC',
    'Assigned to Logistics & labels',
    'Assigned to Calling team',
    'Taken by Sunny',
    'Priority set to High',
    'Priority set to Normal',
    'Reopened by Nitin'
];

test('internal ops events never reach the customer thread', () => {
    const out = Support.customerTicket(deskRow([
        event('Ticket raised'),
        msg('customer', 'where is my parcel'),
        ...HIDDEN.map(t => event(t))
    ]));
    assert.deepEqual(out.thread.map(m => m.text), ['Ticket raised', 'where is my parcel'],
        'only the raise event and the customer message survive');
});

test('every hidden event text is dropped on its own', () => {
    for (const text of HIDDEN) {
        const out = Support.customerTicket(deskRow([event(text)]));
        assert.equal(out.thread.length, 0, `"${text}" must not be serialised`);
    }
});

test('the internal flag hides an event whatever its wording', () => {
    // Forward path: new writes carry the flag, so the rule does not depend on
    // the phrasing staying stable.
    const out = Support.customerTicket(deskRow([
        event('Moved to the night desk', { internal: true }),
        event('Ticket raised')
    ]));
    assert.equal(out.thread.length, 1);
    assert.equal(out.thread[0].text, 'Ticket raised');
});

/* ───────────────────────── kept events ───────────────────────── */

const KEPT = [
    'Ticket raised',
    'Request raised: Cancel order',
    'Request approved: Cancel order',
    'Request approved: Convert to prepaid (link generated)',
    'Request declined',
    'Closed: refund processed',
    'Ticket reopened by customer',
    'Customer rated this 5/5'
];

test('customer-relevant milestones stay in the thread', () => {
    const out = Support.customerTicket(deskRow(KEPT.map(t => event(t))));
    assert.deepEqual(out.thread.map(m => m.text), KEPT, 'nothing neutral may be swallowed');
});

/* ───────────────────────── messages are never filtered ───────────────────────── */

test('messages pass even when their text looks like an internal event', () => {
    const out = Support.customerTicket(deskRow([
        msg('customer', 'Assigned to Chat support was the last update you gave me'),
        msg('agent', 'Priority set to High — escalated to the calling team'),
        event('Assigned to Chat support')
    ]));
    assert.equal(out.thread.length, 2);
    assert.deepEqual(out.thread.map(m => m.role), ['customer', 'agent']);
});

test('thread order is preserved and holes are dropped', () => {
    const out = Support.customerTicket(deskRow([
        event('Ticket raised'),
        null,
        msg('customer', 'first'),
        event('Assigned to Chat support'),
        msg('agent', 'second'),
        event('Ticket reopened by customer'),
        msg('customer', 'third')
    ]));
    assert.deepEqual(out.thread.map(m => m.text), ['Ticket raised', 'first', 'second', 'Ticket reopened by customer', 'third']);
});

/* ───────────────────────── shape of the projection ───────────────────────── */

test('other customer fields are passed through untouched', () => {
    const row = deskRow([event('Ticket raised'), event('Assigned to Chat support')]);
    row.payment_link = 'https://rzp.io/x';
    row.csat = 4;
    row.status = 'awaiting';
    const out = Support.customerTicket(row);
    assert.equal(out.ticket_number, 'TKT-73673');
    assert.equal(out.payment_link, 'https://rzp.io/x');
    assert.equal(out.csat, 4);
    assert.equal(out.status, 'awaiting');
    assert.equal(out.thread.length, 1);
});

test('desk-only columns stay out of the customer payload', () => {
    const out = Support.customerTicket(deskRow([event('Ticket raised')]));
    assert.ok(!('notes' in out), 'internal notes must never be serialised');
    assert.ok(!('assigned_to' in out), 'staff identity must never be serialised');
    assert.ok(!('history' in out), 'the customer snapshot must never be serialised');
});

test('missing or non-array thread yields an empty thread', () => {
    assert.deepEqual(Support.customerTicket(deskRow(undefined)).thread, []);
    assert.deepEqual(Support.customerTicket(deskRow('Ticket raised')).thread, []);
    assert.equal(Support.customerTicket(null), null);
});

/* ───────────────────────── the shared rule ───────────────────────── */

test('isCustomerVisibleEntry is exported as the single rule', () => {
    assert.equal(typeof Support.isCustomerVisibleEntry, 'function');
    assert.equal(Support.isCustomerVisibleEntry(event('Assigned to Chat support')), false);
    assert.equal(Support.isCustomerVisibleEntry(event('Ticket raised')), true);
    assert.equal(Support.isCustomerVisibleEntry(msg('agent', 'Assigned to Chat support')), true);
    assert.equal(Support.isCustomerVisibleEntry(null), false);
});
