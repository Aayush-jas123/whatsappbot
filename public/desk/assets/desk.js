/* ============================================================
   Offcomfrt Support Desk — agent dashboard
   Login → KPI bar → queue (left) → full ticket context (right).
   Admin settings modal: SLA, teams, canned responses, resolution
   templates, cost config, whitelist, order sync.
   ============================================================ */
(function () {
  'use strict';

  // The desk is served by this app (/desk), so API calls stay same-origin.
  // __DESK_API only exists for local development against another host.
  var API = String(window.__DESK_API || '').replace(/\/$/, '');
  var TOKEN_KEY = 'ofc_support_desk_token';
  var USER_KEY = 'ofc_support_desk_user';

  var S = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: localStorage.getItem(USER_KEY) || 'agent',
    stats: null,
    tickets: [],
    filters: { status: 'open', q: '', team: '', priority: '', category: '' },
    selectedId: null,
    detail: null,
    settings: { teams: {}, canned: [], templates: {}, sla: {} },
    composer: { mode: 'reply', text: '' },
    modal: null,          // { tab: 'sla'|'teams'|'canned'|'templates'|'cost'|'whitelist' }
    mobileShow: 'queue'   // queue | detail (small screens)
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return '\u20B9' + (Math.round(Number(n) || 0)).toLocaleString('en-IN'); }
  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + S.token }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, opts).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Session expired — sign in again'); }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return data;
      });
    });
  }
  function toast(msg, isErr) {
    var t = document.createElement('div');
    t.className = 'desk-toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  var STAGE_LABELS = {
    unshipped: 'Not shipped', shipped: 'In transit', out_for_delivery: 'Out for delivery',
    delivered: 'Delivered', exchange: 'Exchange in progress', return: 'Return pickup',
    cancelled: 'Cancelled', rto: 'RTO'
  };
  var REASON_LABELS = {
    order: 'Order', delivery: 'Delivery', product: 'Product', fit: 'Size & fit',
    return: 'Return', credit: 'Credit', other: 'Other'
  };

  // ---------- auth ----------
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    S.token = '';
    showLogin();
  }
  function showLogin(errMsg) {
    var root = $('DeskRoot');
    root.innerHTML = '<div class="desk-login"><div class="desk-login-card">'
      + '<h1>Support Desk</h1><p>Offcomfrt customer support console</p>'
      + '<input type="text" id="DeskUser" class="desk-input" placeholder="Username" autocomplete="username" onkeydown="if(event.key===\'Enter\'){event.preventDefault();document.getElementById(\'DeskPass\').focus();}">'
      + '<input type="password" id="DeskPass" class="desk-input" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')DESK.login()">'
      + '<div class="desk-error">' + esc(errMsg || '') + '</div>'
      + '<button class="desk-btn" style="width:100%;justify-content:center" onclick="DESK.login()">Sign in</button>'
      + '<p class="desk-login-note">Operators need the <strong>Support Desk</strong> permission.</p>'
      + '</div></div>';
    var user = $('DeskUser');
    if (user) user.focus();
  }
  function login() {
    var user = $('DeskUser'), pass = $('DeskPass');
    if (!user || !pass || !user.value.trim() || !pass.value.trim()) return;
    fetch(API + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.value.trim(), password: pass.value })
    }).then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); }).then(function (res) {
      var d = res.d || {};
      if (!d.success || !d.token) throw new Error(res.r.status === 403 ? 'No Support Desk permission for this account' : (d.error || 'Invalid credentials'));
      S.token = d.token;
      S.user = (d.operator && d.operator.username) || d.username || 'agent';
      localStorage.setItem(TOKEN_KEY, S.token);
      localStorage.setItem(USER_KEY, S.user);
      bootDesk();
    }).catch(function (e) { showLogin(e.message); });
  }

  // ---------- boot ----------
  function bootDesk() {
    loadSettings().then(function () {
      renderShell();
      refreshAll();
      setInterval(function () { refreshStats(); }, 30000);
    });
  }
  function refreshAll() { refreshStats(); loadTickets(); }
  function loadSettings() {
    return api('/api/support/admin/settings').then(function (st) {
      S.settings = {
        teams: st.teams || {},
        canned: st.canned_responses || [],
        templates: st.resolution_templates || {},
        sla: st.sla || {},
        cost: st.cost_config || {}
      };
    }).catch(function (e) { toast(e.message, true); });
  }
  function refreshStats() {
    api('/api/support/admin/stats').then(function (st) {
      S.stats = st;
      var k = $('DeskKpis');
      if (k) k.innerHTML = kpiHtml();
    }).catch(function () {});
  }
  function loadTickets() {
    var f = S.filters;
    var qs = '?status=' + encodeURIComponent(f.status)
      + '&channel=' + encodeURIComponent(f.channel || 'website');
    if (f.q) qs += '&q=' + encodeURIComponent(f.q);
    if (f.team) qs += '&team=' + encodeURIComponent(f.team);
    if (f.priority) qs += '&priority=' + encodeURIComponent(f.priority);
    if (f.category) qs += '&category=' + encodeURIComponent(f.category);
    api('/api/support/admin/tickets' + qs).then(function (d) {
      S.tickets = d.tickets || [];
      var q = $('DeskQueue');
      if (q) q.innerHTML = queueHtml();
    }).catch(function (e) { toast(e.message, true); });
  }
  function loadDetail(id) {
    var el = $('DeskDetail');
    if (el) el.innerHTML = '<div class="desk-loading"><span class="desk-spin"></span>Loading full ticket context\u2026</div>';
    api('/api/support/admin/tickets/' + id).then(function (d) {
      S.detail = d;
      S.composer = { mode: 'reply', text: '' };
      renderDetail();
    }).catch(function (e) {
      if (el) el.innerHTML = '<div class="desk-empty-detail">' + esc(e.message) + '</div>';
    });
  }

  // ---------- shell ----------
  function renderShell() {
    var root = $('DeskRoot');
    root.innerHTML = '<div class="desk-shell">'
      + '<div class="desk-topbar">'
      +   '<h1>Support Desk</h1>'
      +   '<span class="desk-tag">' + esc(S.user) + '</span>'
      +   '<span class="spacer"></span>'
      +   '<button class="desk-btn-plain" onclick="DESK.syncOrders()">Sync orders</button>'
      +   '<button class="desk-btn-plain" onclick="DESK.openSettings()">Settings</button>'
      +   '<button class="desk-btn-plain" onclick="DESK.logout()">Sign out</button>'
      + '</div>'
      + '<div class="desk-kpis" id="DeskKpis">' + kpiHtml() + '</div>'
      + '<div class="desk-main">'
      +   '<div class="desk-queue" id="DeskQueue"><div class="desk-loading"><span class="desk-spin"></span>Loading queue\u2026</div></div>'
      +   '<div class="desk-detail" id="DeskDetail"><div class="desk-empty-detail">Select a ticket from the queue to see the full order, issue and conversation context.</div></div>'
      + '</div>'
      + '</div>';
  }
  function kpiHtml() {
    var s = S.stats || {};
    return kpi(s.open, 'Open')
      + kpi(s.awaiting, 'Awaiting')
      + kpi(s.sla, 'Past SLA', s.sla > 0)
      + kpi(s.requests, 'To approve')
      + kpi(s.closedToday, 'Closed today')
      + '<div class="desk-kpi"><div class="n">' + (s.avgCsat == null ? '\u2013' : s.avgCsat + '/5') + '</div><div class="l">Avg CSAT</div></div>';
  }
  function kpi(n, l, bad) {
    return '<div class="desk-kpi' + (bad ? ' bad' : '') + '"><div class="n">' + (n || 0) + '</div><div class="l">' + l + '</div></div>';
  }

  // ---------- queue ----------
  function queueHtml() {
    var f = S.filters;
    var counts = { open: S.stats ? S.stats.open : 0, awaiting: S.stats ? S.stats.awaiting : 0, closed: '' };
    var html = '<div class="desk-queue-head">'
      + '<div class="desk-tabs">'
      +   qTab('open', 'Open', counts.open) + qTab('awaiting', 'Awaiting', counts.awaiting) + qTab('closed', 'Closed', '\u221E')
      + '</div>'
      + '<input class="desk-search" placeholder="Search ticket, order, name, phone\u2026" value="' + esc(f.q) + '" '
      +   'onkeydown="if(event.key===\'Escape\')this.blur()" onchange="DESK.setFilter(\'q\',this.value)">'
      + '<div class="desk-filters">'
      +   '<select onchange="DESK.setFilter(\'category\',this.value)"><option value="">All categories</option>'
      +     Object.keys(REASON_LABELS).map(function (k) { return '<option value="' + k + '"' + (f.category === k ? ' selected' : '') + '>' + REASON_LABELS[k] + '</option>'; }).join('')
      +   '</select>'
      +   '<select onchange="DESK.setFilter(\'team\',this.value)"><option value="">All teams</option>'
      +     Object.keys(S.settings.teams).map(function (k) { return '<option value="' + k + '"' + (f.team === k ? ' selected' : '') + '>' + esc(S.settings.teams[k]) + '</option>'; }).join('')
      +   '</select>'
      +   '<select onchange="DESK.setFilter(\'priority\',this.value)"><option value="">Priority</option>'
      +     '<option value="high"' + (f.priority === 'high' ? ' selected' : '') + '>High</option>'
      +     '<option value="normal"' + (f.priority === 'normal' ? ' selected' : '') + '>Normal</option>'
      +   '</select>'
      + '</div>'
      + '</div><div class="desk-list">';
    if (!S.tickets.length) {
      html += '<div class="desk-loading">No tickets match.</div>';
    } else {
      S.tickets.forEach(function (t) { html += rowHtml(t); });
    }
    return html + '</div>';
  }
  function qTab(key, label, count) {
    return '<button class="desk-tab' + (S.filters.status === key ? ' active' : '') + '" onclick="DESK.setStatus(\'' + key + '\')">'
      + '<b>' + count + '</b>' + label + '</button>';
  }
  function rowHtml(t) {
    var sel = t.id === S.selectedId ? ' selected' : '';
    var sla = t.sla ? (t.sla.bad
      ? '<span class="desk-tag sla-bad">' + esc(t.sla.label) + '</span>'
      : '<span class="desk-tag sla-ok">' + esc(t.sla.label) + '</span>') : '';
    return '<div class="desk-row' + sel + '" onclick="DESK.select(' + t.id + ')">'
      + '<div class="desk-row-top"><span class="desk-row-num">' + esc(t.ticket_number) + '</span>'
      + '<span class="desk-row-time">' + fmtTime(t.updated_at) + '</span></div>'
      + '<div class="desk-row-cust">' + esc(t.customer_name || t.customer_phone) + '</div>'
      + '<div class="desk-row-issue">' + esc(t.sub_label || t.reason_label || '') + '</div>'
      + '<div class="desk-row-meta">'
      +   (t.priority === 'high' ? '<span class="desk-tag high">High</span>' : '')
      +   (t.isRequest ? '<span class="desk-tag request">Request</span>' : '')
      +   (t.channel === 'whatsapp' ? '<span class="desk-tag ch-whatsapp">WA</span>' : '')
      +   sla
      +   (t.order ? '<span class="desk-tag">' + esc(STAGE_LABELS[t.order.stage] || t.order.stage) + '</span>' : '')
      + '</div></div>';
  }
  function setStatus(st) { S.filters.status = st; loadTickets(); }
  function setFilter(key, val) { S.filters[key] = val; loadTickets(); }

  // ---------- detail ----------
  function select(id) {
    S.selectedId = id;
    S.mobileShow = 'detail';
    var q = $('DeskQueue'), d = $('DeskDetail');
    if (window.innerWidth < 980) { if (q) q.classList.add('hide-mobile'); if (d) d.classList.remove('hide-mobile'); }
    var rows = document.querySelectorAll('.desk-row');
    rows.forEach(function (r) { r.classList.remove('selected'); });
    loadDetail(id);
  }
  function backToQueue() {
    S.mobileShow = 'queue';
    var q = $('DeskQueue'), d = $('DeskDetail');
    if (q) q.classList.remove('hide-mobile');
    if (d) d.classList.add('hide-mobile');
  }

  function renderDetail() {
    var el = $('DeskDetail');
    if (!el || !S.detail) return;
    var d = S.detail, t = d.ticket, o = d.order || {}, h = d.history || {};
    var custHtml = customerCard(d, t, h);
    var orderHtml = orderCard(d, t, o);
    var approveHtml = d.requestKey ? approveCard(d, t) : '';
    var riskHtml = riskCard(d);
    var issueHtml = issueCard(d, t);
    var contextHtml = contextCard(d);
    var threadHtml = threadCard(d, t);
    el.innerHTML = ''
      + '<div class="desk-card desk-detail-head">'
      +   '<button class="desk-btn-plain" style="display:none" id="DeskBack" onclick="DESK.backToQueue()">\u2190 Queue</button>'
      +   '<span class="t">' + esc(t.ticket_number) + '</span>'
      +   '<span class="desk-pill ' + t.status + '">' + t.status + '</span>'
      +   (t.priority === 'high' ? '<span class="desk-tag high">HIGH</span>' : '')
      +   '<span class="sub">' + esc(t.reason_label || '') + '</span>'
      +   '<span style="flex:1"></span>'
      +   priorityControls(t)
      + '</div>'
      + '<div class="desk-grid2">' + custHtml + orderHtml + '</div>'
      + approveHtml
      + '<div class="desk-grid2">' + riskHtml + issueHtml + '</div>'
      + contextHtml
      + threadHtml;
    if (window.innerWidth < 980) { var b = $('DeskBack'); if (b) b.style.display = ''; }
  }

  function priorityControls(t) {
    var teams = Object.keys(S.settings.teams);
    return '<select class="desk-select" style="max-width:130px" onchange="DESK.patchTicket({priority:this.value})">'
      + '<option value="normal"' + (t.priority !== 'high' ? ' selected' : '') + '>Normal</option>'
      + '<option value="high"' + (t.priority === 'high' ? ' selected' : '') + '>High</option>'
      + '</select>'
      + '<select class="desk-select" style="max-width:170px" onchange="DESK.patchTicket({team:this.value})">'
      + '<option value="">Unassigned</option>'
      + teams.map(function (k) { return '<option value="' + k + '"' + (t.team === k ? ' selected' : '') + '>' + esc(S.settings.teams[k]) + '</option>'; }).join('')
      + '</select>';
  }

  function customerCard(d, t, h) {
    var phone10 = String(t.customer_phone || '').replace(/\D/g, '').slice(-10);
    return '<div class="desk-card"><h3>Customer</h3>'
      + '<div class="desk-kv"><span class="k">Name</span><span class="v">' + esc(t.customer_name || '\u2013') + '</span></div>'
      + '<div class="desk-kv"><span class="k">Phone</span><span class="v"><a href="tel:+' + esc(t.customer_phone) + '">+' + esc(t.customer_phone) + '</a></span></div>'
      + (t.customer_email ? '<div class="desk-kv"><span class="k">Email</span><span class="v">' + esc(t.customer_email) + '</span></div>' : '')
      + '<div class="desk-kv"><span class="k">Prefers</span><span class="v">' + (t.contact_via === 'phone' ? 'Phone call' : 'WhatsApp') + '</span></div>'
      + '<div class="desk-kv"><span class="k">History</span><span class="v">' + (h.orders || 0) + ' orders \u00b7 ' + (h.delivered || 0) + ' delivered \u00b7 ' + (h.rto || 0) + ' RTO</span></div>'
      + '<div class="desk-kv"><span class="k">Tickets</span><span class="v">' + (d.ticketCount || 1) + ' lifetime</span></div>'
      + '<div style="margin-top:9px"><a class="desk-btn desk-btn-ghost desk-btn-sm" target="_blank" rel="noopener" href="https://wa.me/91' + esc(phone10) + '">WhatsApp chat</a></div>'
      + '</div>';
  }

  function orderCard(d, t, o) {
    var items = (o.items || []).map(function (i) {
      return '<tr><td>' + esc(i.n) + (i.v ? ' <span style="color:#999">(' + esc(i.v) + ')</span>' : '') + '</td>'
        + '<td class="num">x' + (i.q || 1) + '</td><td class="num">' + money(i.p) + '</td></tr>';
    }).join('');
    var track = o.awb && /delhivery/i.test(o.courier || '')
      ? '<a href="https://www.delhivery.com/track/package/' + esc(o.awb) + '" target="_blank" rel="noopener">' + esc(o.awb) + '</a>' : esc(o.awb || '\u2013');
    return '<div class="desk-card"><h3>Order</h3>'
      + '<div class="desk-kv"><span class="k">Number</span><span class="v">#' + esc(o.id || t.order_id) + '</span></div>'
      + '<div class="desk-kv"><span class="k">Payment</span><span class="v">' + esc(o.payment || '\u2013') + ' \u00b7 ' + money(o.total) + '</span></div>'
      + '<div class="desk-kv"><span class="k">Stage</span><span class="v"><span class="desk-pill stage">' + esc(STAGE_LABELS[o.stage] || o.stage || '\u2013') + '</span></span></div>'
      + '<div class="desk-kv"><span class="k">Courier</span><span class="v">' + esc(o.courier || '\u2013') + ' \u00b7 ' + track + '</span></div>'
      + (o.address ? '<div class="desk-kv"><span class="k">Address</span><span class="v">' + esc(o.address) + '</span></div>' : '')
      + (o.placed ? '<div class="desk-kv"><span class="k">Placed</span><span class="v">' + fmtTime(o.placed) + '</span></div>' : '')
      + (items ? '<table class="desk-items"><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th></tr>' + items + '</table>' : '')
      + '</div>';
  }

  // Shoppers Hub customer context — the same orders / returns / exchanges /
  // RTO aggregation the Shoppers Hub chat sidebar renders for this phone.
  function contextCard(d) {
    var ctx = d.context;
    if (!ctx) return '';
    var tid = String(d.ticket.order_id || '').replace(/^#/, '');
    var orderRows = (ctx.orders || []).map(function (o) {
      var st = String(o.status || '').toLowerCase();
      var label = STAGE_LABELS[st] || st.replace(/_/g, ' ');
      var cur = String(o.order_id || '').replace(/^#/, '') === tid;
      return '<div class="desk-ctx-row' + (cur ? ' current' : '') + '">'
        + '<span class="o">#' + esc(o.order_id) + (cur ? ' \u00b7 this ticket' : '') + '</span>'
        + '<span class="s">' + esc(label) + '</span>'
        + '<span class="t">' + (o.awb ? esc(o.awb) + ' \u00b7 ' : '') + money(o.total) + '</span>'
        + '</div>';
    }).join('');
    var reqs = [];
    (ctx.returns || []).forEach(function (r) { reqs.push({ kind: 'Return', r: r }); });
    (ctx.exchanges || []).forEach(function (r) { reqs.push({ kind: 'Exchange', r: r }); });
    reqs.sort(function (a, b) { return new Date(b.r.created_at || 0) - new Date(a.r.created_at || 0); });
    var reqRows = reqs.slice(0, 6).map(function (x) {
      return '<div class="desk-ctx-row">'
        + '<span class="o">' + x.kind + ' #' + esc(x.r.order_id) + '</span>'
        + '<span class="s">' + esc(String(x.r.status || '').replace(/_/g, ' ')) + '</span>'
        + '<span class="t">' + (x.r.source === 'portal' ? 'portal' : 'local') + ' \u00b7 ' + fmtTime(x.r.created_at) + '</span>'
        + '</div>';
    }).join('');
    var chips = [];
    if ((ctx.returns || []).length) chips.push(ctx.returns.length + ' return' + (ctx.returns.length > 1 ? 's' : ''));
    if ((ctx.exchanges || []).length) chips.push(ctx.exchanges.length + ' exchange' + (ctx.exchanges.length > 1 ? 's' : ''));
    if ((ctx.rto || []).length) chips.push(ctx.rto.length + ' RTO');
    return '<div class="desk-card"><h3>Customer history <span class="ctx-sub">(Shoppers Hub)</span></h3>'
      + '<div class="desk-ctx-summary">' + (ctx.orders || []).length + ' orders' + (chips.length ? ' \u00b7 ' + chips.join(' \u00b7 ') : '') + '</div>'
      + (reqRows ? '<div class="desk-ctx-sec">Open returns &amp; exchanges</div>' + reqRows : '')
      + (orderRows ? '<div class="desk-ctx-sec">Orders</div>' + orderRows : '')
      + '</div>';
  }

  function approveCard(d, t) {
    var key = d.requestKey;
    var inner = '';
    if (d.requestNote) inner += '<div class="req-note">' + esc(d.requestNote) + '</div>';
    switch (key) {
      case 'order/cancel':
        inner += '<div class="desk-kv"><span class="k">Settlement</span><span class="v">' + (d.order && d.order.payment === 'COD' ? 'COD \u2014 nothing to refund' : 'Prepaid \u2014 confirm refund route with customer') + '</span></div>';
        break;
      case 'order/edit':
        inner += '<input class="desk-input" id="AprNote" placeholder="What should change (size, colour, qty)?">';
        break;
      case 'order/prepay':
        inner += '<div class="desk-kv"><span class="k">Amount</span><span class="v">' + money(d.order && d.order.total) + '</span></div>';
        break;
      case 'delivery/address_change':
      case 'delivery/reship_new':
      case 'delivery/pay_reship':
        inner += '<div class="desk-kv"><span class="k">New address</span><span class="v">' + esc(t.new_address || '\u2013') + '</span></div>'
          + '<div class="desk-set-sub">Optional \u2014 structured fields for a direct Shopify address update (blank = tag + note for ops):</div>'
          + '<div class="desk-form-grid">'
          +   '<div><label>Address line</label><input id="AprAddr1"></div>'
          +   '<div><label>City</label><input id="AprCity"></div>'
          +   '<div><label>Province</label><input id="AprProv"></div>'
          +   '<div><label>PIN code</label><input id="AprZip"></div>'
          + '</div>';
        break;
      case 'return/return_credit':
      case 'return/exchange_req':
        inner += '<div class="desk-kv"><span class="k">Preference</span><span class="v">' + esc(t.preference || '\u2013') + '</span></div>'
          + '<div class="desk-set-sub">Approving creates a pending entry in the returns panel; the pickup flow takes over from there.</div>';
        break;
    }
    return '<div class="desk-card desk-approve"><h3>Request approval</h3>'
      + '<div class="req-title">' + esc(d.requestLabel) + '</div>'
      + inner
      + '<div class="desk-approve-actions">'
      +   '<button class="desk-btn" onclick="DESK.approve()">Approve</button>'
      +   '<button class="desk-btn desk-btn-danger" onclick="DESK.decline()">Decline</button>'
      + '</div></div>';
  }

  function riskCard(d) {
    var r = d.risk || { level: 'Low', factors: [] };
    var econ = d.econ || { rows: [], tip: '' };
    return '<div class="desk-card"><h3>Cost &amp; risk</h3>'
      + '<span class="desk-pill risk-' + r.level.toLowerCase() + '">' + r.level + ' risk</span>'
      + '<div class="desk-risk-factors">' + (r.factors || []).map(function (f) { return '<span class="desk-tag">' + esc(f) + '</span>'; }).join('') + '</div>'
      + '<table class="desk-econ"><tr><th>Option</th><th>Est. cost</th><th>Why</th></tr>'
      + (econ.rows || []).map(function (row) {
          return '<tr><td>' + esc(row[0]) + '</td><td class="cost">' + money(row[1]) + '</td><td>' + esc(row[2]) + '</td></tr>';
        }).join('')
      + '</table>'
      + (econ.tip ? '<div class="desk-tip">' + esc(econ.tip) + '</div>' : '')
      + '</div>';
  }

  function issueCard(d, t) {
    return '<div class="desk-card"><h3>Issue details</h3>'
      + '<div class="desk-kv"><span class="k">Category</span><span class="v">' + esc(t.reason_label || '\u2013') + '</span></div>'
      + '<div class="desk-kv"><span class="k">Sub-issue</span><span class="v">' + esc(t.sub_label || '\u2013') + '</span></div>'
      + (t.preference ? '<div class="desk-kv"><span class="k">Preference</span><span class="v">' + esc(t.preference) + '</span></div>' : '')
      + (t.new_address ? '<div class="desk-kv"><span class="k">New address</span><span class="v">' + esc(t.new_address) + '</span></div>' : '')
      + (t.video_url ? '<div class="desk-kv"><span class="k">Video</span><span class="v"><a href="' + esc(t.video_url) + '" target="_blank" rel="noopener">Unboxing video</a></span></div>' : '')
      + (t.message ? '<div class="desk-kv"><span class="k">Description</span><span class="v">' + esc(t.message) + '</span></div>' : '')
      + ((t.images || []).length ? '<div class="desk-imggrid">' + t.images.map(function (u) { return '<img src="' + esc(u) + '" onclick="DESK.lightbox(\'' + esc(u) + '\')">'; }).join('') + '</div>' : '')
      + '</div>';
  }

  function threadCard(d, t) {
    var thread = Array.isArray(t.thread) ? t.thread : [];
    var notes = Array.isArray(t.notes) ? t.notes : [];
    var html = '<div class="desk-card"><h3>Conversation</h3><div class="desk-thread" id="DeskThread">';
    thread.forEach(function (m) {
      if (m.kind === 'event') {
        html += '<div class="desk-ev">' + esc(m.text) + ' \u00b7 ' + fmtTime(m.at) + '</div>';
      } else if (m.role === 'customer') {
        html += '<div class="desk-msg desk-msg-cust"><div class="desk-msg-bubble">' + esc(m.text) + '</div>'
          + '<div class="desk-msg-meta">' + esc(t.customer_name || 'Customer') + ' \u00b7 ' + fmtTime(m.at) + '</div></div>';
      } else {
        html += '<div class="desk-msg desk-msg-agent"><div class="desk-msg-bubble">' + esc(m.text) + '</div>'
          + '<div class="desk-msg-meta">' + esc(m.agentId || 'agent') + (m.ask ? ' \u00b7 asked customer' : '') + ' \u00b7 ' + fmtTime(m.at) + '</div></div>';
      }
    });
    if (t.status === 'closed' && t.resolution_label) {
      html += '<div class="desk-ev">Closed: ' + esc(t.resolution_label) + ' \u00b7 ' + fmtTime(t.resolution_at) + (t.csat ? ' \u00b7 rated ' + t.csat + '/5' : '') + '</div>';
    }
    notes.forEach(function (n) {
      html += '<div class="desk-msg desk-msg-note"><div class="desk-msg-bubble">' + esc(n.text) + '</div>'
        + '<div class="desk-msg-meta">Internal note \u00b7 ' + esc(n.agentId || '') + ' \u00b7 ' + fmtTime(n.at) + '</div></div>';
    });
    html += '</div>';

    // composer (only when not closed)
    if (t.status !== 'closed') {
      var canned = S.settings.canned.filter(function (c) { return !c.mode || c.mode === S.composer.mode; });
      html += '<div class="desk-composer" style="margin-top:12px">'
        + '<div class="desk-composer-row">'
        +   '<button class="desk-mode' + (S.composer.mode === 'reply' ? ' active' : '') + '" onclick="DESK.setMode(\'reply\')">Reply</button>'
        +   '<button class="desk-mode' + (S.composer.mode === 'ask' ? ' active' : '') + '" onclick="DESK.setMode(\'ask\')">Ask customer</button>'
        +   '<button class="desk-mode mode-note' + (S.composer.mode === 'note' ? ' active' : '') + '" onclick="DESK.setMode(\'note\')">Internal note</button>'
        +   '<span style="flex:1"></span>'
        +   (canned.length ? '<select class="desk-select" onchange="DESK.useCanned(this.value)"><option value="">Saved replies\u2026</option>'
        +     canned.map(function (c) { return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>'; }).join('') + '</select>' : '')
        + '</div>'
        + '<textarea id="DeskMsg" placeholder="' + (S.composer.mode === 'note' ? 'Visible to the team only\u2026' : 'Message the customer\u2026') + '" oninput="DESK.setMsg(this.value)">' + esc(S.composer.text) + '</textarea>'
        + '<div class="desk-composer-row">'
        +   '<button class="desk-btn desk-btn-ghost" onclick="DESK.openResolve()">Resolve &amp; close</button>'
        +   '<span style="flex:1"></span>'
        +   '<button class="desk-btn" onclick="DESK.sendComposer()">' + (S.composer.mode === 'note' ? 'Add note' : 'Send') + '</button>'
        + '</div></div>';
    } else {
      html += '<div class="desk-composer" style="margin-top:10px">'
        + '<button class="desk-btn desk-btn-ghost desk-btn-sm" onclick="DESK.agentReopen()">Reopen ticket</button></div>';
    }
    html += '</div>';
    return html;
  }

  // ---------- composer actions ----------
  function setMode(m) { S.composer.mode = m; S.composer.text = ''; renderDetail(); }
  function setMsg(v) { S.composer.text = v; }
  function useCanned(key) {
    var c = S.settings.canned.filter(function (x) { return x.key === key; })[0];
    if (!c) return;
    var d = S.detail;
    var text = String(c.text || '')
      .replace(/\{order\}/g, d.ticket.order_id || '')
      .replace(/\{courier\}/g, (d.order && d.order.courier) || 'the courier')
      .replace(/\{awb\}/g, (d.order && d.order.awb) || 'on file')
      .replace(/\{amount\}/g, money(d.order && d.order.total));
    S.composer.text = text;
    var ta = $('DeskMsg');
    if (ta) { ta.value = text; ta.focus(); }
  }
  function sendComposer() {
    var t = S.detail.ticket;
    var text = S.composer.text.trim();
    if (!text) { toast('Message is empty', true); return; }
    var path = S.composer.mode === 'note' ? '/note' : (S.composer.mode === 'ask' ? '/ask' : '/reply');
    api('/api/support/admin/tickets/' + t.id + path, { method: 'POST', body: { text: text } })
      .then(function () {
        S.composer.text = '';
        loadDetail(t.id);
        refreshStats();
      })
      .catch(function (e) { toast(e.message, true); });
  }
  function patchTicket(patch) {
    var t = S.detail.ticket;
    api('/api/support/admin/tickets/' + t.id, { method: 'PATCH', body: patch })
      .then(function () { loadDetail(t.id); loadTickets(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- resolve ----------
  function openResolve() {
    var tpls = S.settings.templates;
    var keys = Object.keys(tpls);
    S.modal = { type: 'resolve', sel: keys[0] || '' };
    var ov = document.createElement('div');
    ov.className = 'desk-modal-overlay';
    ov.id = 'DeskModal';
    ov.innerHTML = '<div class="desk-modal"><div class="desk-modal-head"><h2>Resolve &amp; close</h2>'
      + '<button class="desk-btn-plain" onclick="DESK.closeModal()">Close</button></div>'
      + '<div class="desk-modal-body">'
      + '<label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#888">Resolution</label>'
      + '<select class="desk-select" style="max-width:100%;width:100%;margin:6px 0 12px" onchange="DESK.pickResolution(this.value)">'
      + keys.map(function (k) { return '<option value="' + k + '">' + k.replace(/_/g, ' ') + '</option>'; }).join('')
      + '</select>'
      + (keys[0] === 'store_credit' ? '<div class="desk-set-sub">Create the store credit code in Shopify (titled with the order number) before closing.</div>' : '')
      + '<label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#888">Message to customer</label>'
      + '<textarea id="RslMsg" class="desk-input" style="margin-top:6px;min-height:100px"></textarea>'
      + '</div><div class="desk-modal-foot">'
      + '<button class="desk-btn" onclick="DESK.confirmResolve()">Close ticket</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    pickResolution(keys[0] || '');
  }
  function pickResolution(key) {
    S.modal.sel = key;
    var t = S.detail.ticket, d = S.detail;
    var text = String(S.settings.templates[key] || '')
      .replace(/\{order\}/g, t.order_id || '')
      .replace(/\{courier\}/g, (d.order && d.order.courier) || 'the courier')
      .replace(/\{awb\}/g, (d.order && d.order.awb) || 'on file')
      .replace(/\{amount\}/g, money(d.order && d.order.total));
    var ta = $('RslMsg');
    if (ta) ta.value = text;
  }
  function confirmResolve() {
    var t = S.detail.ticket;
    var msg = ($('RslMsg') || {}).value || '';
    api('/api/support/admin/tickets/' + t.id + '/resolve', { method: 'POST', body: { type: S.modal.sel, message: msg } })
      .then(function () { closeModal(); loadDetail(t.id); refreshAll(); toast('Ticket closed'); })
      .catch(function (e) { toast(e.message, true); });
  }
  function agentReopen() {
    var t = S.detail.ticket;
    api('/api/support/admin/tickets/' + t.id + '/reopen', { method: 'POST', body: {} })
      .then(function () { loadDetail(t.id); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- approve / decline ----------
  function approve() {
    var d = S.detail, t = d.ticket;
    var body = {};
    if (d.requestKey === 'order/edit') body.note = ($('AprNote') || {}).value || '';
    if (/address|reship/.test(d.requestKey || '')) {
      var a1 = ($('AprAddr1') || {}).value, city = ($('AprCity') || {}).value,
          prov = ($('AprProv') || {}).value, zip = ($('AprZip') || {}).value;
      if (a1) body.address = { address1: a1, city: city || '', province: prov || '', zip: zip || '', country: 'IN' };
    }
    api('/api/support/admin/tickets/' + t.id + '/approve', { method: 'POST', body: body })
      .then(function (r) {
        if (r.paymentLink) {
          toast('Payment link generated \u2014 pasted below');
          S.composer.mode = 'reply';
          S.composer.text = 'Here is a secure link to pay ' + money(r.amount) + ' online for order #' + t.order_id + ': ' + r.paymentLink + '\n\nOnce paid, your order becomes prepaid.';
          loadDetail(t.id);
        } else {
          toast('Request approved' + (r.requestId ? ' (' + r.requestId + ')' : ''));
          loadDetail(t.id);
        }
        refreshAll();
      })
      .catch(function (e) { toast(e.message, true); });
  }
  function decline() {
    var t = S.detail.ticket;
    var note = window.prompt('Decline note (required \u2014 the customer will see this):');
    if (!note || !note.trim()) return;
    api('/api/support/admin/tickets/' + t.id + '/decline', { method: 'POST', body: { note: note.trim() } })
      .then(function () { toast('Request declined'); loadDetail(t.id); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---------- settings modal ----------
  function openSettings(tab) {
    S.modal = { tab: tab || 'sla' };
    var ov = document.createElement('div');
    ov.className = 'desk-modal-overlay';
    ov.id = 'DeskModal';
    ov.innerHTML = '<div class="desk-modal"><div class="desk-modal-head"><h2>Desk settings</h2>'
      + '<button class="desk-btn-plain" onclick="DESK.closeModal()">Close</button></div>'
      + '<div class="desk-modal-body" id="DeskSetBody"></div></div>';
    document.body.appendChild(ov);
    renderSettingsTab();
  }
  function setTab(tab) { S.modal.tab = tab; renderSettingsTab(); }
  function renderSettingsTab() {
    var el = $('DeskSetBody');
    if (!el) return;
    var tabs = [['sla', 'SLA'], ['teams', 'Teams'], ['canned', 'Saved replies'], ['templates', 'Resolutions'], ['cost', 'Cost & risk'], ['whitelist', 'Access']];
    var html = '<div class="desk-set-nav">'
      + tabs.map(function (x) { return '<button class="desk-mode' + (S.modal.tab === x[0] ? ' active' : '') + '" onclick="DESK.setTab(\'' + x[0] + '\')">' + x[1] + '</button>'; }).join('')
      + '</div>';
    var st = S.settings;
    if (S.modal.tab === 'sla') {
      html += '<div class="desk-form-grid">'
        + '<div><label>High priority (hours)</label><input id="SlaHigh" type="number" min="1" value="' + (st.sla.high_hours != null ? st.sla.high_hours : 4) + '"></div>'
        + '<div><label>Normal (hours)</label><input id="SlaNormal" type="number" min="1" value="' + (st.sla.normal_hours != null ? st.sla.normal_hours : 12) + '"></div>'
        + '</div><div style="margin-top:14px"><button class="desk-btn" onclick="DESK.saveSla()">Save SLA</button></div>';
    } else if (S.modal.tab === 'teams') {
      html += '<div id="TeamList">' + Object.keys(st.teams).map(function (k) {
        return '<div class="desk-set-item"><div class="row"><input type="text" value="' + esc(k) + '" data-k disabled style="max-width:140px;font-family:monospace">'
          + '<input type="text" value="' + esc(st.teams[k]) + '" data-v data-k="' + esc(k) + '">'
          + '<button class="desk-btn-plain" onclick="DESK.delTeam(\'' + esc(k) + '\')">Remove</button></div></div>';
      }).join('') + '</div>'
        + '<div class="row" style="display:flex;gap:8px;margin:10px 0"><input id="NewTeamKey" placeholder="key (e.g. social)" style="flex:0 0 160px;padding:8px 10px;border:1px solid #e8e8e8;border-radius:8px;font-size:12.5px">'
        + '<input id="NewTeamLabel" placeholder="Label (e.g. Social support)" style="flex:1;padding:8px 10px;border:1px solid #e8e8e8;border-radius:8px;font-size:12.5px">'
        + '<button class="desk-btn-plain" onclick="DESK.addTeam()">Add</button></div>'
        + '<button class="desk-btn" onclick="DESK.saveTeams()">Save teams</button>';
    } else if (S.modal.tab === 'canned') {
      html += '<div class="desk-set-sub">Variables: {order} {courier} {awb} {amount}. Mode = which composer button offers it.</div>'
        + '<div id="CannedList">' + st.canned.map(function (c, i) {
          return '<div class="desk-set-item" data-i="' + i + '"><div class="row">'
            + '<input type="text" value="' + esc(c.key) + '" data-f="key" placeholder="key" style="max-width:110px;font-family:monospace">'
            + '<input type="text" value="' + esc(c.label) + '" data-f="label" placeholder="Label">'
            + '<select data-f="mode"><option value="reply"' + (c.mode !== 'ask' ? ' selected' : '') + '>Reply</option><option value="ask"' + (c.mode === 'ask' ? ' selected' : '') + '>Ask</option></select>'
            + '<button class="desk-btn-plain" onclick="DESK.delCanned(' + i + ')">Remove</button></div>'
            + '<textarea data-f="text">' + esc(c.text) + '</textarea></div>';
        }).join('') + '</div>'
        + '<button class="desk-btn-plain" onclick="DESK.addCanned()">+ Add reply</button> '
        + '<button class="desk-btn" onclick="DESK.saveCanned()">Save replies</button>';
    } else if (S.modal.tab === 'templates') {
      html += '<div class="desk-set-sub">Auto-filled message per resolution type, offered in the Resolve flow. Variables: {order} {courier} {awb}.</div>'
        + '<div id="TplList">' + Object.keys(st.templates).map(function (k) {
          return '<div class="desk-set-item"><div class="row"><input type="text" value="' + esc(k) + '" disabled style="max-width:200px;font-family:monospace"></div>'
            + '<textarea data-k="' + esc(k) + '">' + esc(st.templates[k]) + '</textarea></div>';
        }).join('') + '</div>'
        + '<button class="desk-btn" onclick="DESK.saveTemplates()">Save templates</button>';
    } else if (S.modal.tab === 'cost') {
      var c = st.cost || {};
      html += '<div class="desk-form-grid">'
        + cf('FwdShip', 'Forward shipping', c.fwd_ship) + cf('RtoShip', 'RTO shipping', c.rto_ship)
        + cf('RevPickup', 'Reverse pickup', c.reverse_pickup) + cf('Packing', 'Packing', c.packing)
        + cf('CodFee', 'COD fee', c.cod_fee) + cf('RtoRateCod', 'RTO rate COD (0-1)', c.rto_rate_cod)
        + cf('RtoRatePre', 'RTO rate prepaid (0-1)', c.rto_rate_prepaid) + cf('HighValue', 'High value threshold', c.high_value)
        + cf('ReturnWindow', 'Return window (days)', c.return_window_days) + cf('DnrDays', 'DNR report (days)', c.dnr_report_days)
        + '</div><div style="margin-top:14px"><button class="desk-btn" onclick="DESK.saveCost()">Save cost config</button></div>';
    } else if (S.modal.tab === 'whitelist') {
      html += '<div class="desk-set-sub">Only these phone numbers see the Help &amp; Tickets tab in the customer account. Add the number with country code (e.g. 919876543210).</div>'
        + '<div class="row" style="display:flex;gap:8px;margin-bottom:14px">'
        + '<input id="WlPhone" placeholder="919876543210" style="flex:0 0 200px;padding:9px 11px;border:1px solid #e8e8e8;border-radius:9px;font-size:13px">'
        + '<input id="WlNote" placeholder="Note (optional)" style="flex:1;padding:9px 11px;border:1px solid #e8e8e8;border-radius:9px;font-size:13px">'
        + '<button class="desk-btn" onclick="DESK.addWl()">Add</button></div>'
        + '<div id="WlList"><div class="desk-loading"><span class="desk-spin"></span>Loading\u2026</div></div>';
      loadWhitelist();
    }
    el.innerHTML = html;
  }
  function cf(id, label, val) {
    return '<div><label>' + label + '</label><input id="Cf' + id + '" type="number" step="any" value="' + (val != null ? val : '') + '"></div>';
  }
  function loadWhitelist() {
    api('/api/support/admin/whitelist').then(function (d) {
      var el = $('WlList');
      if (!el) return;
      el.innerHTML = (d.whitelist || []).map(function (w) {
        return '<div class="desk-set-item"><div class="row">'
          + '<input type="text" value="+' + esc(w.phone) + '" disabled style="max-width:160px;font-family:monospace">'
          + '<input type="text" value="' + esc(w.note || '') + '" disabled placeholder="">'
          + '<button class="desk-btn-plain" onclick="DESK.delWl(\'' + esc(w.phone) + '\')">Remove</button>'
          + '</div></div>';
      }).join('') || '<div class="desk-set-sub">No phones whitelisted yet.</div>';
    }).catch(function (e) { toast(e.message, true); });
  }
  function saveSla() {
    api('/api/support/admin/settings/sla', { method: 'PUT', body: { value: {
      high_hours: Number(($('SlaHigh') || {}).value) || 4,
      normal_hours: Number(($('SlaNormal') || {}).value) || 12
    } } }).then(function () { toast('SLA saved'); loadSettings(); }).catch(function (e) { toast(e.message, true); });
  }
  function collectTeams() {
    var out = {};
    document.querySelectorAll('#TeamList [data-v]').forEach(function (inp) {
      var k = inp.getAttribute('data-k'), v = inp.value.trim();
      if (k && v) out[k] = v;
    });
    var nk = ($('NewTeamKey') || {}).value, nl = ($('NewTeamLabel') || {}).value;
    if (nk && nl) out[nk.trim()] = nl.trim();
    return out;
  }
  function saveTeams() {
    api('/api/support/admin/settings/teams', { method: 'PUT', body: { value: collectTeams() } })
      .then(function () { toast('Teams saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function addTeam() { /* handled inside saveTeams via NewTeam inputs */ toast('Fill key + label, then Save teams'); }
  function delTeam(k) {
    var out = collectTeams();
    delete out[k];
    api('/api/support/admin/settings/teams', { method: 'PUT', body: { value: out } })
      .then(function () { return loadSettings(); }).then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function collectCanned() {
    var out = [];
    document.querySelectorAll('#CannedList .desk-set-item').forEach(function (item) {
      var rec = {};
      item.querySelectorAll('[data-f]').forEach(function (inp) { rec[inp.getAttribute('data-f')] = inp.value; });
      var ta = item.querySelector('textarea[data-f="text"]') || item.querySelector('textarea');
      if (ta) rec.text = ta.value;
      if (rec.key && rec.label) out.push(rec);
    });
    return out;
  }
  function addCanned() {
    S.settings.canned.push({ key: 'reply_' + Date.now(), label: 'New reply', text: '', mode: 'reply' });
    renderSettingsTab();
  }
  function delCanned(i) {
    S.settings.canned.splice(i, 1);
    renderSettingsTab();
  }
  function saveCanned() {
    api('/api/support/admin/settings/canned_responses', { method: 'PUT', body: { value: collectCanned() } })
      .then(function () { toast('Saved replies updated'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function saveTemplates() {
    var out = {};
    document.querySelectorAll('#TplList textarea[data-k]').forEach(function (ta) {
      out[ta.getAttribute('data-k')] = ta.value;
    });
    api('/api/support/admin/settings/resolution_templates', { method: 'PUT', body: { value: out } })
      .then(function () { toast('Templates saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function saveCost() {
    var v = {
      fwd_ship: Number(($('CfFwdShip') || {}).value) || 75,
      rto_ship: Number(($('CfRtoShip') || {}).value) || 75,
      reverse_pickup: Number(($('CfRevPickup') || {}).value) || 90,
      packing: Number(($('CfPacking') || {}).value) || 20,
      cod_fee: Number(($('CfCodFee') || {}).value) || 35,
      rto_rate_cod: Number(($('CfRtoRateCod') || {}).value) || 0.25,
      rto_rate_prepaid: Number(($('CfRtoRatePre') || {}).value) || 0.05,
      high_value: Number(($('CfHighValue') || {}).value) || 2500,
      return_window_days: Number(($('CfReturnWindow') || {}).value) || 7,
      dnr_report_days: Number(($('CfDnrDays') || {}).value) || 3
    };
    api('/api/support/admin/settings/cost_config', { method: 'PUT', body: { value: v } })
      .then(function () { toast('Cost config saved'); return loadSettings(); })
      .then(renderSettingsTab).catch(function (e) { toast(e.message, true); });
  }
  function addWl() {
    var ph = ($('WlPhone') || {}).value, note = ($('WlNote') || {}).value;
    if (!ph) return;
    api('/api/support/admin/whitelist', { method: 'POST', body: { phone: ph, note: note } })
      .then(function () { toast('Phone whitelisted'); loadWhitelist(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function delWl(ph) {
    api('/api/support/admin/whitelist/' + encodeURIComponent(ph), { method: 'DELETE' })
      .then(function () { toast('Phone removed'); loadWhitelist(); })
      .catch(function (e) { toast(e.message, true); });
  }
  function closeModal() {
    var m = $('DeskModal');
    if (m) m.remove();
    S.modal = null;
  }
  function syncOrders() {
    toast('Syncing orders for whitelisted customers\u2026');
    api('/api/support/admin/order-cache/sync', { method: 'POST', body: {} })
      .then(function (r) { toast('Sync done: ' + (r.customers || 0) + ' customers processed'); })
      .catch(function (e) { toast(e.message, true); });
  }
  function lightbox(url) {
    var lb = document.createElement('div');
    lb.className = 'desk-lightbox';
    lb.innerHTML = '<img src="' + esc(url) + '">';
    lb.onclick = function () { lb.remove(); };
    document.body.appendChild(lb);
  }

  // ---------- exports / boot ----------
  window.DESK = {
    login: login, logout: logout, setStatus: setStatus, setFilter: setFilter,
    select: select, backToQueue: backToQueue, patchTicket: patchTicket,
    setMode: setMode, setMsg: setMsg, useCanned: useCanned, sendComposer: sendComposer,
    openResolve: openResolve, pickResolution: pickResolution, confirmResolve: confirmResolve,
    agentReopen: agentReopen, approve: approve, decline: decline,
    openSettings: openSettings, setTab: setTab, saveSla: saveSla, saveTeams: saveTeams,
    addTeam: addTeam, delTeam: delTeam, addCanned: addCanned, delCanned: delCanned, saveCanned: saveCanned,
    saveTemplates: saveTemplates, saveCost: saveCost, addWl: addWl, delWl: delWl,
    closeModal: closeModal, syncOrders: syncOrders, lightbox: lightbox
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (S.token) bootDesk(); else showLogin();
    });
  } else {
    if (S.token) bootDesk(); else showLogin();
  }
})();
