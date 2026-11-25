'use strict';
// The team portal has to work storefront Help & Tickets tickets as a thread
// instead of a WhatsApp chat: decide which tickets qualify, show the staff view
// of the thread, and append a reply exactly like the desk composer does.
// Runs fully offline: these three helpers are pure, the pg pool created by the
// service module never gets a query.
// Run: node --test test/testPortalTicketThread.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Support = require('../src/services/supportService');

/* ───────────────────────── fixtures ───────────────────────── */

const at = (n) => 1700000000000 + n;
const event = (text, extra = {}) => ({ kind: 'event', text, at: at(1), ...extra });
const msg = (role, text, extra = {}) => ({ role, text, at: at(2), ...extra });

function portalRow(overrides = {}) {
    return {
        id: 14313,
        ticket_number: 'TKT-73673',
        order_id: '73673',
        channel: 'website',
        source: 'website',
        status: 'open',
        priority: 'normal',
        customer_phone: '917499609179',
        thread: [event('Request raised: Delivery & address'), msg('customer', 'where is my parcel')],
        ...overrides
    };
}

/* ───────────────────────── which tickets are threads ───────────────────────── */

test('isStorefrontTicket is exported as the single rule', () => {
    assert.equal(typeof Support.isStorefrontTicket, 'function');
});

test('an account ticket (TKT-) is a thread', () => {
    assert.equal(Support.isStorefrontTicket(portalRow()), true);
});

test('a widget ticket (WDG-) keeps the WhatsApp chat view', () => {
    // Both lanes share channel='website'; the number prefix is the only marker,
    // and widget conversations are designed to continue on WhatsApp.
    assert.equal(Support.isStorefrontTicket(portalRow({ ticket_number: 'WDG-73673' })), false);
    assert.equal(Support.isStorefrontTicket(portalRow({ ticket_number: 'WDG-' })), false);
});

test('a website row with no ticket number is still worked as a thread', () => {
    // Deliberate: Postgres would drop such a row out of the desk's website lane
    // (NULL NOT LIKE is NULL), but every ticket-creating path stamps a number, so
    // the useful reading of an unnumbered website row is "storefront request".
    assert.equal(Support.isStorefrontTicket(portalRow({ ticket_number: null })), true);
    assert.equal(Support.isStorefrontTicket(portalRow({ ticket_number: '' })), true);
});

test('whatsapp and instagram tickets are never threads', () => {
    for (const channel of ['whatsapp', 'instagram']) {
        assert.equal(Support.isStorefrontTicket(portalRow({ channel })), false, channel);
    }
    assert.equal(Support.isStorefrontTicket(portalRow({ channel: null })), false);
});

test('isStorefrontTicket tolerates a missing row', () => {
    assert.equal(Support.isStorefrontTicket(null), false);
    assert.equal(Support.isStorefrontTicket(undefined), false);
    assert.equal(Support.isStorefrontTicket({}), false);
});

/* ───────────────────────── staff thread view ───────────────────────── */

test('portalThreadView keeps agent and customer entries in stored order', () => {
    const out = Support.portalThreadView(portalRow({
        thread: [
            event('Request raised: Delivery & address'),
            msg('customer', 'where is my parcel'),
            msg('agent', 'Checking with the courier', { agentId: 'portal:nitin-0gn0m7' }),
            msg('customer', 'thanks')
        ]
    }));
    assert.deepEqual(out.map(m => m.role), ['event', 'customer', 'agent', 'customer']);
    assert.deepEqual(out.map(m => m.text), [
        'Request raised: Delivery & address',
        'where is my parcel',
        'Checking with the courier',
        'thanks'
    ]);
});

test('the staff view surfaces internal events the storefront hides', () => {
    const thread = [
        event('Auto-routed to NITIN (shift portal, least load)', { internal: true }),
        event('Assigned to Returns & QC'),
        msg('agent', 'Reply')
    ];
    const staff = Support.portalThreadView(portalRow({ thread }));
    assert.deepEqual(staff.map(m => m.text), [
        'Auto-routed to NITIN (shift portal, least load)',
        'Assigned to Returns & QC',
        'Reply'
    ], 'the portal is a staff surface - nothing may be swallowed');
    assert.equal(staff[0].internal, true, 'the flag is carried so the UI can dim it');
    assert.equal(staff[1].internal, false, 'rows written before the flag exist read as normal events');

    // ...while the customer projection on the same row hides them.
    const customer = Support.customerTicket(portalRow({ thread }));
    assert.deepEqual(customer.thread.map(m => m.text), ['Reply']);
});

test('portalThreadView keeps the entry metadata the composer needs', () => {
    const out = Support.portalThreadView(portalRow({
        thread: [msg('agent', 'Can you share the order id?', { ask: true, agentId: 'desk:Sunny' })]
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].ask, true);
    assert.equal(out[0].agentId, 'desk:Sunny');
    assert.equal(out[0].at, at(2));
});

test('portalThreadView drops holes, coerces junk text and keeps missing fields null', () => {
    const out = Support.portalThreadView(portalRow({
        thread: [null, undefined, { role: 'customer', at: at(3) }, msg('customer', 'real')]
    }));
    assert.deepEqual(out.map(m => m.text), ['', 'real']);
    assert.equal(out[0].at, at(3));
    assert.equal(out[0].agentId, null);
});

test('portalThreadView tolerates a missing or non-array thread', () => {
    assert.deepEqual(Support.portalThreadView(portalRow({ thread: undefined })), []);
    assert.deepEqual(Support.portalThreadView(portalRow({ thread: 'Ticket raised' })), []);
    assert.deepEqual(Support.portalThreadView(null), []);
});

/* ───────────────────────── reply patch ───────────────────────── */

test('portalAgentReplyPatch appends exactly one agent entry', () => {
    const row = portalRow();
    const patch = Support.portalAgentReplyPatch(row, { text: '  Your parcel is in Delhi  ', now: at(10) });
    assert.equal(patch.thread.length, 3);
    assert.deepEqual(patch.thread[2], {
        role: 'agent', text: 'Your parcel is in Delhi', at: at(10), agentId: null
    });
    // The earlier entries are untouched, and the row's own array is not mutated.
    assert.deepEqual(patch.thread.slice(0, 2), row.thread);
    assert.equal(row.thread.length, 2, 'the patch must not write through the fetched row');
});

test('a portal reply carries the portal identity when given one', () => {
    const patch = Support.portalAgentReplyPatch(portalRow(), {
        text: 'On it', agentId: 'portal:nitin-0gn0m7', now: at(10)
    });
    assert.equal(patch.thread[2].agentId, 'portal:nitin-0gn0m7');
});

test('a reply moves the ticket to awaiting and stamps the agent clock', () => {
    const patch = Support.portalAgentReplyPatch(portalRow(), { text: 'On it', now: at(10) });
    assert.equal(patch.status, 'awaiting');
    assert.equal(patch.last_agent_at, new Date(at(10)).toISOString());
    assert.equal(patch.updated_at, new Date(at(10)).toISOString());
});

test('first_response_at is set once and never overwritten', () => {
    const first = Support.portalAgentReplyPatch(portalRow(), { text: 'On it', now: at(10) });
    assert.equal(first.first_response_at, new Date(at(10)).toISOString());

    const again = Support.portalAgentReplyPatch(
        portalRow({ first_response_at: new Date(at(5)).toISOString() }),
        { text: 'Any update?', now: at(20) }
    );
    assert.ok(!('first_response_at' in again), 'the original first response must survive');
});

test('a reply never touches internal notes or assignment fields', () => {
    const patch = Support.portalAgentReplyPatch(portalRow({ notes: [{ text: 'internal', at: 1 }] }), { text: 'On it' });
    assert.ok(!('notes' in patch), 'a reply is not a note');
    assert.ok(!('assigned_to' in patch));
    assert.ok(!('portal_id' in patch));
    assert.ok(!('team' in patch));
});

test('blank text produces no patch, long text is capped at 5000', () => {
    assert.equal(Support.portalAgentReplyPatch(portalRow(), { text: '' }), null);
    assert.equal(Support.portalAgentReplyPatch(portalRow(), { text: '   \n  ' }), null);
    assert.equal(Support.portalAgentReplyPatch(portalRow(), {}), null);
    assert.equal(Support.portalAgentReplyPatch(null, { text: 'On it' }), null);

    const patch = Support.portalAgentReplyPatch(portalRow(), { text: 'x'.repeat(6000) });
    assert.equal(patch.thread[2].text.length, 5000);
});

test('a reply works on a ticket that has no thread yet', () => {
    const patch = Support.portalAgentReplyPatch(portalRow({ thread: null }), { text: 'On it', now: at(10) });
    assert.deepEqual(patch.thread, [{ role: 'agent', text: 'On it', at: at(10), agentId: null }]);
});

/* ───────────────────────── the lane cannot drift ───────────────────────── */

test('portal and desk agree on which tickets are threads', () => {
    // DESK_WEBSITE_COND is the desk's SQL spelling of the same rule; the exported
    // predicate must answer identically for every row the desk can actually
    // return (both creation paths stamp ticket_number, so NULL never appears).
    const cases = [
        [{ channel: 'website', ticket_number: 'TKT-73673' }, true],
        [{ channel: 'website', ticket_number: 'ORD-1234' }, true],
        [{ channel: 'website', ticket_number: 'WDG-73673' }, false],
        [{ channel: 'whatsapp', ticket_number: 'TKT-73673' }, false],
        [{ channel: 'instagram', ticket_number: 'IG-73673' }, false]
    ];
    for (const [row, expected] of cases) {
        const sqlWebsite = row.channel === 'website' && !String(row.ticket_number || '').startsWith('WDG-');
        assert.equal(Support.isStorefrontTicket(row), expected, JSON.stringify(row));
        assert.equal(Support.isStorefrontTicket(row), sqlWebsite, 'SQL and JS predicates disagree');
    }
});

test('all three helpers are exported', () => {
    for (const fn of ['isStorefrontTicket', 'portalThreadView', 'portalAgentReplyPatch']) {
        assert.equal(typeof Support[fn], 'function', fn + ' must be exported');
    }
});
