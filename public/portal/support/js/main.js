// Support Portal JavaScript
const API_BASE = '/api';
let portalToken = localStorage.getItem('portalToken');
let portalSlug = null;
let portalInfo = null;
let allTickets = [];
let currentTicket = null;
let chatPollingInterval = null;
let ticketPollingInterval = null;
let lastKnownTicketIds = new Set();
let unreadMessageCount = 0;
let lastChatMessageCount = 0;
let lastAiSuggestedReply = null;
let currentChannelFilter = 'all'; // 'all', 'whatsapp', 'instagram'

// ── Channel Icon Helpers ─────────────────────────────────────
// Returns a small inline SVG icon for the given channel.
function channelIconSvg(channel, size = 14) {
    if (channel === 'instagram') {
        return `<svg class="ch-badge-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="Instagram"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" fill="currentColor"/></svg>`;
    }
    if (channel === 'whatsapp') {
        return `<svg class="ch-badge-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="WhatsApp"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="currentColor"/><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a8 8 0 01-4.243-1.214l-.29-.175-3.032.795.81-2.96-.192-.305A7.963 7.963 0 014 12a8 8 0 1116 0 8 8 0 01-8 8z" fill="currentColor"/></svg>`;
    }
    return '';
}

function channelLabel(channel) {
    if (channel === 'instagram') return 'Instagram';
    if (channel === 'whatsapp') return 'WhatsApp';
    return '';
}

// ============================================================
// INACTIVITY TIMEOUT — log out after 10 minutes of no user
// interaction (mouse, keyboard, scroll, touch).  A 60-second
// warning overlay is shown before the actual logout so the user
// can extend the session by interacting.
// ============================================================
const INACTIVITY_LIMIT_MS  = 10 * 60 * 1000;  // 10 minutes
const INACTIVITY_WARN_MS   = 9  * 60 * 1000;  // warn at 9 minutes
let inactivityTimer     = null;
let inactivityWarnTimer = null;
let inactivityWarnOverlay = null;
let lastInactivityReset = 0;
const INACTIVITY_RESET_THROTTLE_MS = 30 * 1000; // throttle resets to once per 30s

function resetInactivityTimer() {
    if (!portalToken) return;
    const now = Date.now();
    if (now - lastInactivityReset < INACTIVITY_RESET_THROTTLE_MS) return;
    lastInactivityReset = now;
    // Clear existing timers
    if (inactivityTimer)     { clearTimeout(inactivityTimer);     inactivityTimer = null; }
    if (inactivityWarnTimer) { clearTimeout(inactivityWarnTimer); inactivityWarnTimer = null; }
    dismissInactivityWarning();
    // Schedule warning
    inactivityWarnTimer = setTimeout(() => {
        showInactivityWarning();
    }, INACTIVITY_WARN_MS);
    // Schedule hard logout
    inactivityTimer = setTimeout(() => {
        logout();
        showToast('You were logged out due to inactivity.', 'info');
    }, INACTIVITY_LIMIT_MS);
}

function showInactivityWarning() {
    if (inactivityWarnOverlay) return;
    let remaining = Math.ceil((INACTIVITY_LIMIT_MS - INACTIVITY_WARN_MS) / 1000);
    inactivityWarnOverlay = document.createElement('div');
    inactivityWarnOverlay.id = 'inactivityWarnOverlay';
    inactivityWarnOverlay.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;';
    inactivityWarnOverlay.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:32px 40px;text-align:center;color:#fff;max-width:380px;">
            <div style="font-size:36px;margin-bottom:12px;">⏱️</div>
            <h3 style="margin:0 0 8px;font-size:18px;">Session Expiring</h3>
            <p style="color:#aaa;font-size:14px;margin:0 0 16px;">Your portal session will expire in <span id="inactivityCountdown">${remaining}</span>s due to inactivity.</p>
            <button id="inactivityStayBtn" style="background:#6c5ce7;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;cursor:pointer;font-weight:600;">Stay Logged In</button>
        </div>`;
    document.body.appendChild(inactivityWarnOverlay);
    const countdownEl = document.getElementById('inactivityCountdown');
    const countdownInterval = setInterval(() => {
        remaining--;
        if (countdownEl) countdownEl.textContent = Math.max(remaining, 0);
        if (remaining <= 0) clearInterval(countdownInterval);
    }, 1000);
    document.getElementById('inactivityStayBtn').addEventListener('click', () => {
        resetInactivityTimer();
    });
}

function dismissInactivityWarning() {
    if (inactivityWarnOverlay) {
        inactivityWarnOverlay.remove();
        inactivityWarnOverlay = null;
    }
}

function clearInactivityTimer() {
    if (inactivityTimer)     { clearTimeout(inactivityTimer);     inactivityTimer = null; }
    if (inactivityWarnTimer) { clearTimeout(inactivityWarnTimer); inactivityWarnTimer = null; }
    dismissInactivityWarning();
}

function attachInactivityListeners() {
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
    events.forEach(evt => {
        document.addEventListener(evt, () => resetInactivityTimer(), { passive: true });
    });
}

// Get slug from URL
function getSlugFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

// ============================================================
// SINGLE-WINDOW LOCK — a portal session may run in only ONE
// window/tab per browser. The first window claims the lock and
// heartbeats it; later windows show a blocker and take over once
// the other window closes. The server additionally enforces one
// active login per portal.
// ============================================================
let portalWindowLockId = null;
let portalWindowLockChannel = null;
let portalWindowIsHolder = false;
let portalWindowLockHeartbeat = null;

function acquirePortalWindowLock(probeMs = 700) {
    return new Promise(resolve => {
        if (typeof BroadcastChannel === 'undefined') return resolve(true);

        portalWindowLockId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        portalWindowLockChannel = new BroadcastChannel(`offcomfrt-portal-lock-${portalSlug}`);
        let answered = false;

        portalWindowLockChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (!msg.id || msg.id === portalWindowLockId) return;
            if (msg.type === 'claim') {
                if (portalWindowIsHolder) {
                    // Simultaneous holders — smaller id keeps the lock
                    if (msg.id < portalWindowLockId) {
                        portalWindowIsHolder = false;
                        if (portalWindowLockHeartbeat) { clearInterval(portalWindowLockHeartbeat); portalWindowLockHeartbeat = null; }
                        showPortalBlockedScreen();
                    } else {
                        portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
                    }
                } else if (!answered) {
                    answered = true;
                    resolve(false);
                }
            } else if (msg.type === 'probe' && portalWindowIsHolder) {
                portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            }
        };

        portalWindowLockChannel.postMessage({ type: 'probe', id: portalWindowLockId });
        setTimeout(() => {
            if (answered) return;
            portalWindowIsHolder = true;
            portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            portalWindowLockHeartbeat = setInterval(() => {
                portalWindowLockChannel.postMessage({ type: 'claim', id: portalWindowLockId });
            }, 3000);
            window.addEventListener('pagehide', () => {
                try { portalWindowLockChannel.postMessage({ type: 'release', id: portalWindowLockId }); } catch (_) {}
            });
            resolve(true);
        }, probeMs);
    });
}

// Full-screen blocker shown to a second window of the same portal session
function showPortalBlockedScreen() {
    if (document.getElementById('portalWindowLockOverlay')) return;
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    stopTicketPolling();
    document.body.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.id = 'portalWindowLockOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0b0b0b;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;';
    overlay.innerHTML = `
        <div style="max-width:420px;padding:32px;">
            <div style="font-size:42px;margin-bottom:16px;">⚠️</div>
            <h2 style="margin:0 0 12px;font-size:20px;letter-spacing:.5px;">ALREADY OPEN IN ANOTHER WINDOW</h2>
            <p style="color:#999;font-size:14px;line-height:1.6;margin:0 0 8px;">
                This portal is active in another window or tab.<br>
                Only one window is allowed at a time.
            </p>
            <p style="color:#666;font-size:12px;line-height:1.6;margin:0;">
                Close the other window and this page will take over automatically.
            </p>
        </div>`;
    document.body.appendChild(overlay);

    // Poll: if the holder stops answering, this window takes over via reload
    setInterval(() => {
        if (portalWindowIsHolder) return;
        let gotClaim = false;
        const onMsg = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'claim' && msg.id !== portalWindowLockId) gotClaim = true;
        };
        portalWindowLockChannel.addEventListener('message', onMsg);
        portalWindowLockChannel.postMessage({ type: 'probe', id: portalWindowLockId });
        setTimeout(() => {
            portalWindowLockChannel.removeEventListener('message', onMsg);
            if (!gotClaim) window.location.reload();
        }, 1600);
    }, 5000);
}

// Initialize
async function init() {
    portalSlug = getSlugFromUrl();
    if (!portalSlug) {
        showLoginError('Invalid portal link. Please use the correct URL.');
        return;
    }

    // If we have a token, verify it's valid by trying to load tickets
    if (portalToken) {
        const valid = await verifyToken();
        if (valid) {
            if (!await acquirePortalWindowLock()) {
                showPortalBlockedScreen();
                return;
            }
            showApp();
            loadTickets();
            startTicketPolling();
            resetInactivityTimer();
        } else {
            portalToken = null;
            localStorage.removeItem('portalToken');
            showLogin();
        }
    } else {
        showLogin();
    }
}

// Auth
async function handleLogin(event) {
    event.preventDefault();
    const password = document.getElementById('portalPassword').value;
    const errorEl = document.getElementById('loginError');

    try {
        const response = await fetch(`${API_BASE}/portal/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: portalSlug, password })
        });

        const data = await response.json();

        if (data.success) {
            portalToken = data.token;
            portalInfo = data.portal;
            localStorage.setItem('portalToken', portalToken);
            if (!await acquirePortalWindowLock()) {
                showPortalBlockedScreen();
                return;
            }
            showApp();
            loadTickets();
            startTicketPolling();
            resetInactivityTimer();
        } else {
            errorEl.textContent = data.error || 'Invalid password';
        }
    } catch (error) {
        errorEl.textContent = 'Connection failed. Please try again.';
    }
}

async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE}/portal/${portalSlug}/tickets`, {
            headers: { 'Authorization': `Bearer ${portalToken}` }
        });
        return response.status === 200;
    } catch {
        return false;
    }
}

function logout() {
    portalToken = null;
    localStorage.removeItem('portalToken');
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    stopTicketPolling();
    clearInactivityTimer();
    showLogin();
}

// UI State
function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('portalPassword').value = '';
    document.getElementById('loginError').textContent = '';
}

function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'flex';
    if (portalInfo) {
        document.getElementById('portalNameDisplay').textContent = portalInfo.name || 'Support Portal';
    }
}

// API helper
async function portalApi(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${portalToken}`
        }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (response.status === 401) {
        let message = 'Session expired. Please log in again.';
        try {
            const data = await response.json();
            if (data && data.error) message = data.error;
        } catch (_) { /* non-JSON 401 body */ }
        logout();
        const errorEl = document.getElementById('loginError');
        if (errorEl) errorEl.textContent = message;
        throw new Error(message);
    }

    return response.json();
}

// Tickets
async function loadTickets(isPolling = false) {
    try {
        const channelParam = currentChannelFilter !== 'all' ? `&channel=${currentChannelFilter}` : '';
        const data = await portalApi(`/portal/${portalSlug}/tickets?1=1${channelParam}`);
        if (data.success) {
            const newTickets = data.tickets || [];
            const newTicketIds = new Set(newTickets.map(t => String(t.id)));

            // Check for new tickets (only on polling, not initial load)
            if (isPolling && lastKnownTicketIds.size > 0) {
                const hasNewTickets = newTickets.some(t => !lastKnownTicketIds.has(String(t.id)));
                if (hasNewTickets) {
                    unreadMessageCount++;
                    updateNotificationBadge();
                }
            }

            allTickets = newTickets;
            lastKnownTicketIds = newTicketIds;
            filterTickets();
            updateHeaderCount();
        }
    } catch (error) {
        if (!isPolling) showToast(error.message, 'error');
    }
}

function startTicketPolling() {
    if (ticketPollingInterval) clearInterval(ticketPollingInterval);
    ticketPollingInterval = setInterval(() => {
        if (portalToken) loadTickets(true);
    }, 15000);
}

function stopTicketPolling() {
    if (ticketPollingInterval) {
        clearInterval(ticketPollingInterval);
        ticketPollingInterval = null;
    }
}

function updateHeaderCount() {
    const count = allTickets.length;
    document.getElementById('headerTicketCount').textContent = `${count} ticket${count !== 1 ? 's' : ''}`;
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
        if (unreadMessageCount > 0) {
            badge.textContent = unreadMessageCount > 99 ? '99+' : unreadMessageCount;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

function clearNotificationBadge() {
    unreadMessageCount = 0;
    updateNotificationBadge();
}

function filterTickets() {
    const search = document.getElementById('ticketSearch').value.toLowerCase();
    const statusFilter = document.getElementById('statusFilter').value;
    const unreadOnly = document.getElementById('unreadFilterBtn')?.classList.contains('active') || false;
    const dateFrom = document.getElementById('dateFromFilter')?.value || '';
    const dateTo = document.getElementById('dateToFilter')?.value || '';
    const timeFrom = document.getElementById('timeFromFilter')?.value || '';
    const timeTo = document.getElementById('timeToFilter')?.value || '';

    let filtered = allTickets;

    // Unread filter
    if (unreadOnly) {
        filtered = filtered.filter(t => !t.is_read);
    }

    // Status filter
    if (statusFilter) {
        filtered = filtered.filter(t => t.status === statusFilter);
    }

    // Search filter
    if (search) {
        filtered = filtered.filter(t =>
            (t.ticket_number || '').toLowerCase().includes(search) ||
            (t.customer_name || '').toLowerCase().includes(search) ||
            (t.customer_phone || '').toLowerCase().includes(search) ||
            (t.message || '').toLowerCase().includes(search)
        );
    }

    // Date filter
    if (dateFrom || dateTo) {
        filtered = filtered.filter(t => {
            const ticketDate = new Date(t.created_at);
            const ticketDateStr = ticketDate.toISOString().split('T')[0];
            
            if (dateFrom && ticketDateStr < dateFrom) return false;
            if (dateTo && ticketDateStr > dateTo) return false;
            return true;
        });
    }

    // Time filter
    if (timeFrom || timeTo) {
        filtered = filtered.filter(t => {
            const ticketTime = new Date(t.created_at);
            const ticketTimeStr = ticketTime.toTimeString().split(' ')[0].substring(0, 5);
            
            if (timeFrom && ticketTimeStr < timeFrom) return false;
            if (timeTo && ticketTimeStr > timeTo) return false;
            return true;
        });
    }

    renderTickets(filtered);
}

function renderTickets(tickets) {
    const list = document.getElementById('ticketsList');
    const empty = document.getElementById('ticketsEmpty');

    if (tickets.length === 0) {
        list.style.display = 'none';
        empty.style.display = 'flex';
        return;
    }

    list.style.display = 'block';
    empty.style.display = 'none';

    const newHtml = tickets.map(t => {
        const isUnread = !t.is_read;
        const channel = t.channel || 'whatsapp';
        const isIG = channel === 'instagram';
        const channelBadge = `<span class="channel-badge ${channel}" title="${channelLabel(channel)}">${channelIconSvg(channel, 12)}</span>`;
        const customerDisplay = isIG
            ? (t.ig_username ? `@${escapeHtml(t.ig_username)}` : escapeHtml(t.customer_phone))
            : escapeHtml(t.customer_phone);
        return `
        <div class="ticket-item ${t.status === 'resolved' ? 'resolved' : ''} ${isUnread ? 'unread' : ''}" data-ticket-id="${t.id}" data-phone="${escapeJs(t.customer_phone)}" data-name="${escapeJs(t.customer_name || 'Customer')}" data-status="${t.status}" data-channel="${channel}">
            <div class="col-ticket-number">
                <span class="ticket-number-badge">${escapeHtml(t.ticket_number || 'N/A')}</span>
                ${channelBadge}
            </div>
            <div class="col-customer">
                <div class="ticket-customer-name ${isUnread ? 'unread-name' : ''}">
                    ${isUnread ? '<span class="unread-dot"></span>' : ''}
                    ${escapeHtml(t.customer_name || 'Customer')}
                </div>
                <div class="ticket-customer-phone">${isIG ? customerDisplay : escapeHtml(t.customer_phone)}</div>
            </div>
            <div class="col-message">${escapeHtml(truncate(t.message, 80))}</div>
            <div class="col-status">
                <span class="ticket-status ${t.status}">${t.status}</span>
            </div>
            <div class="col-time">${formatDate(t.created_at)}</div>
            <div class="col-actions">
                <button class="ticket-btn" data-chat="${t.id}">Chat</button>
            </div>
        </div>
    `;
    }).join('');

    // Only update DOM if content actually changed (prevents scroll jumps)
    if (list.innerHTML !== newHtml) {
        list.innerHTML = newHtml;
    }

    // Attach event listeners to ticket items
    list.querySelectorAll('.ticket-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openChat(item.dataset.ticketId, item.dataset.phone, item.dataset.name, item.dataset.status, item.dataset.channel || 'whatsapp');
        });
    });
    list.querySelectorAll('.ticket-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = btn.closest('.ticket-item');
            openChat(item.dataset.ticketId, item.dataset.phone, item.dataset.name, item.dataset.status, item.dataset.channel || 'whatsapp');
        });
    });
}

// Chat
async function openChat(ticketId, phone, name, status, channel = 'whatsapp') {
    currentTicket = { id: ticketId, phone, name, status, channel };

    // Clear notification badge when opening a ticket
    clearNotificationBadge();

    document.getElementById('chatCustomerName').textContent = name;

    // Show channel-aware customer info with icon
    const phoneDisplay = document.getElementById('chatCustomerPhone');
    const chIcon = channelIconSvg(channel, 13);
    const chLabel = channelLabel(channel);
    if (channel === 'instagram') {
        phoneDisplay.innerHTML = `${escapeHtml(phone)} <span class="chat-channel-badge instagram">${chIcon} ${escapeHtml(chLabel)}</span>`;
    } else {
        phoneDisplay.innerHTML = `${escapeHtml(phone)} <span class="chat-channel-badge whatsapp">${chIcon} ${escapeHtml(chLabel)}</span>`;
    }

    document.getElementById('chatMessages').innerHTML = `
        <div class="chat-loading">
            <div class="spinner"></div>
            <span>Loading conversation...</span>
        </div>
    `;
    document.getElementById('chatModal').classList.add('active');

    // Resolve button visibility
    const resolveBtn = document.getElementById('resolveChatBtn');
    if (resolveBtn) {
        resolveBtn.style.display = status === 'resolved' ? 'none' : 'inline-flex';
    }

    await loadChatMessages(phone);

    // Warm the AI suggestion cache in the background so the ✨ click feels instant
    try { prefetchAiSuggestions(phone, ticketId); } catch (e) { /* never block chat open */ }

    // Start polling
    if (chatPollingInterval) clearInterval(chatPollingInterval);
    chatPollingInterval = setInterval(() => {
        if (currentTicket) loadChatMessages(currentTicket.phone, false);
    }, 15000);
}

async function loadChatMessages(phone, showLoading = true) {
    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/${encodeURIComponent(phone)}`);
        if (data.success) {
            renderChatMessages(data.messages, showLoading);
        }
    } catch (error) {
        if (showLoading) {
            document.getElementById('chatMessages').innerHTML = `
                <div class="chat-loading">Failed to load messages</div>
            `;
        }
    }
}

function renderChatMessages(messages, isInitialLoad = true) {
    const container = document.getElementById('chatMessages');

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="tickets-empty" style="padding: 40px;">
                <div class="empty-text">No messages yet</div>
            </div>
        `;
        lastChatMessageCount = 0;
        return;
    }

    // If polling and no new messages, skip re-render entirely
    if (!isInitialLoad && messages.length === lastChatMessageCount) {
        return;
    }

    // If polling and only new messages at the end, append them
    if (!isInitialLoad && messages.length > lastChatMessageCount && lastChatMessageCount > 0) {
        const newMessages = messages.slice(lastChatMessageCount);
        const newHtml = newMessages.map(msg => {
            const isAgent = msg.isAdmin;
            const time = formatTime(msg.timestamp);
            const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');
            return `
                <div class="chat-message ${isAgent ? 'agent' : 'customer'}">
                    <div class="msg-bubble">
                        <div class="msg-content">${content}</div>
                        <div class="msg-meta">
                            ${isAgent ? '<span class="msg-type-badge">Manual</span>' : ''}
                            <span class="msg-time">${time}</span>
                            ${isAgent ? '<span class="msg-status msg-status-sent">&#10003;</span>' : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        container.insertAdjacentHTML('beforeend', newHtml);
        lastChatMessageCount = messages.length;

        // Only auto-scroll if user is already near the bottom
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (isNearBottom) {
            container.scrollTop = container.scrollHeight;
        }
        return;
    }

    // Full render (initial load or significant change)
    container.innerHTML = messages.map(msg => {
        const isAgent = msg.isAdmin;
        const time = formatTime(msg.timestamp);
        const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');

        return `
            <div class="chat-message ${isAgent ? 'agent' : 'customer'}">
                <div class="msg-bubble">
                    <div class="msg-content">${content}</div>
                    <div class="msg-meta">
                        ${isAgent ? '<span class="msg-type-badge">Manual</span>' : ''}
                        <span class="msg-time">${time}</span>
                        ${isAgent ? '<span class="msg-status msg-status-sent">&#10003;</span>' : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    lastChatMessageCount = messages.length;

    // Scroll to bottom only on initial load
    if (isInitialLoad) {
        container.scrollTop = container.scrollHeight;
    }
}

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();

    if (!message || !currentTicket) return;

    // Optimistic update
    const container = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message agent';
    msgDiv.innerHTML = `
        <div class="msg-bubble">
            <div class="msg-content">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
            <div class="msg-meta">
                <span class="msg-type-badge">Manual</span>
                <span class="msg-time">${formatTime(new Date().toISOString())}</span>
                <span class="msg-status msg-status-sent">&#10003;</span>
            </div>
        </div>
    `;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    input.value = '';
    input.style.height = 'auto';

    try {
        const data = await portalApi(`/portal/${portalSlug}/chat/send`, 'POST', {
            phone: currentTicket.phone,
            message,
            suggestedText: lastAiSuggestedReply
        });

        // AI learning signal consumed — clear regardless of send outcome
        lastAiSuggestedReply = null;

        if (data.success) {
            // Refresh to get actual status
            await loadChatMessages(currentTicket.phone, false);
        } else {
            msgDiv.classList.add('msg-failed');
            const meta = msgDiv.querySelector('.msg-meta');
            if (meta) meta.innerHTML += '<span class="msg-error">Failed</span>';
        }
    } catch (error) {
        msgDiv.classList.add('msg-failed');
        const meta = msgDiv.querySelector('.msg-meta');
        if (meta) meta.innerHTML += '<span class="msg-error">Failed</span>';
    }
}

function closeChat() {
    document.getElementById('chatModal').classList.remove('active');
    currentTicket = null;
    if (chatPollingInterval) {
        clearInterval(chatPollingInterval);
        chatPollingInterval = null;
    }
    // Hide any leftover AI suggestions for the closed chat
    const box = document.getElementById('aiSuggestions');
    if (box) {
        box.classList.remove('open');
        box.innerHTML = '';
    }
    lastAiSuggestedReply = null;
}

// ---------- AI reply suggestions (drafts only — agent reviews before sending) ----------
const aiSuggestPrefetch = new Map(); // key -> { promise, at }
const AI_PREFETCH_FRESH_MS = 90 * 1000;

function aiSuggestKey(phone, ticketId) {
    return `${phone}:${ticketId || ''}`;
}

async function aiSuggestFetch(phone, ticketId, prefetch = false) {
    const data = await portalApi(`/portal/${portalSlug}/ai/suggest-reply`, 'POST', {
        phone,
        ticketId,
        prefetch
    });
    if (!data.success) throw new Error(data.error || 'AI suggestions unavailable');
    return data;
}

// Prefetch: warm the suggestion cache the moment a chat opens so the ✨
// click feels instant. Failures are silent — the button still works as a
// plain on-demand request.
function prefetchAiSuggestions(phone, ticketId) {
    if (!phone || !portalToken) return;
    const key = aiSuggestKey(phone, ticketId);
    const existing = aiSuggestPrefetch.get(key);
    if (existing && Date.now() - existing.at < AI_PREFETCH_FRESH_MS) return;
    aiSuggestPrefetch.set(key, {
        promise: aiSuggestFetch(phone, ticketId, true).catch(() => null),
        at: Date.now()
    });
}

function injectAiSuggestButton() {
    const inputArea = document.querySelector('#chatModal .chat-input-area');
    if (!inputArea || document.getElementById('aiSuggestReplyBtn')) return;

    const suggestionsBox = document.createElement('div');
    suggestionsBox.id = 'aiSuggestions';
    inputArea.parentNode.insertBefore(suggestionsBox, inputArea);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'aiSuggestReplyBtn';
    btn.title = 'AI: suggest replies from this conversation';
    btn.innerHTML = '✨';
    const sendBtn = document.getElementById('sendMessageBtn');
    inputArea.insertBefore(btn, sendBtn);

    btn.onclick = async () => {
        if (!currentTicket) { showToast('Open a customer chat first', 'error'); return; }
        const phone = currentTicket.phone;
        const ticketId = currentTicket.id;

        btn.disabled = true;
        btn.innerHTML = '…';
        suggestionsBox.classList.add('open');
        suggestionsBox.innerHTML = '<div class="ai-suggestions-note">Generating suggestions…</div>';
        try {
            // Reuse the prefetch started when the chat opened — if it already
            // resolved this renders instantly; otherwise we just await it
            const key = aiSuggestKey(phone, ticketId);
            const pre = aiSuggestPrefetch.get(key);
            let data = (pre && Date.now() - pre.at < AI_PREFETCH_FRESH_MS) ? await pre.promise : null;
            aiSuggestPrefetch.delete(key); // single-use: next click re-checks the server
            if (!data || !data.suggestions) {
                data = await aiSuggestFetch(phone, ticketId);
            }

            if (!data.suggestions || !data.suggestions.length) {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">No suggestions available for this chat.</div>';
            } else {
                suggestionsBox.innerHTML = '<div class="ai-suggestions-note">✨ Tap a draft to insert it — review before sending:</div>';
                data.suggestions.forEach(s => {
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'ai-suggestion-chip';
                    chip.textContent = s;
                    chip.onclick = () => {
                        const input = document.getElementById('chatInput');
                        if (input) {
                            input.value = s;
                            input.focus();
                            input.style.height = 'auto';
                            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
                        }
                        // Remember the draft so the send flow can report whether
                        // it was sent as-is or edited (AI learning signal)
                        lastAiSuggestedReply = s;
                        suggestionsBox.classList.remove('open');
                        suggestionsBox.innerHTML = '';
                    };
                    suggestionsBox.appendChild(chip);
                });
            }
        } catch (e) {
            suggestionsBox.innerHTML = '';
            const note = document.createElement('div');
            note.className = 'ai-suggestions-note';
            note.textContent = `❌ ${e.message}`;
            suggestionsBox.appendChild(note);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '✨';
        }
    };
}

async function resolveCurrentTicket() {
    if (!currentTicket) return;
    if (!confirm('Mark this ticket as resolved?')) return;

    try {
        const data = await portalApi(`/portal/${portalSlug}/tickets/${currentTicket.id}`, 'PUT', {
            status: 'resolved'
        });

        if (data.success) {
            showToast('Ticket resolved!', 'success');
            closeChat();
            loadTickets();
        } else {
            throw new Error(data.error);
        }
    } catch (error) {
        showToast(error.message || 'Failed to resolve ticket', 'error');
    }
}

// Utilities
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeJs(text) {
    if (!text) return '';
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function truncate(text, length) {
    if (!text) return '';
    return text.length > length ? text.substring(0, length) + '...' : text;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    // Convert to IST
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffsetMs);
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    if (el) el.textContent = msg;
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    init();

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });
    }

    // Close modal on backdrop click
    document.getElementById('chatModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('chatModal')) {
            closeChat();
        }
    });

    // Event listeners for elements that had inline handlers
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('ticketSearch')?.addEventListener('input', filterTickets);
    document.getElementById('statusFilter')?.addEventListener('change', filterTickets);
    document.getElementById('refreshTicketsBtn')?.addEventListener('click', loadTickets);
    document.getElementById('resolveChatBtn')?.addEventListener('click', resolveCurrentTicket);
    document.getElementById('closeChatBtn')?.addEventListener('click', closeChat);
    document.getElementById('sendMessageBtn')?.addEventListener('click', sendMessage);

    // AI reply suggestions (✨ button in the chat input area)
    injectAiSuggestButton();

    // Inactivity timeout (10-min auto-logout)
    attachInactivityListeners();
    
    // View All Orders button
    document.getElementById('viewAllOrdersBtn')?.addEventListener('click', () => {
        if (currentTicket) {
            showAllOrdersModal(currentTicket.phone);
        }
    });
    
    // Close All Orders modal
    document.getElementById('closeAllOrdersModal')?.addEventListener('click', closeAllOrdersModal);
    
    // New filter controls
    document.getElementById('unreadFilterBtn')?.addEventListener('click', toggleUnreadFilter);
    document.getElementById('dateFromFilter')?.addEventListener('change', filterTickets);
    document.getElementById('dateToFilter')?.addEventListener('change', filterTickets);
    document.getElementById('timeFromFilter')?.addEventListener('change', filterTickets);
    document.getElementById('timeToFilter')?.addEventListener('change', filterTickets);
    document.getElementById('resetFiltersBtn')?.addEventListener('click', resetAllFilters);

    // Channel toggle buttons
    document.querySelectorAll('.channel-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.channel-toggle').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentChannelFilter = btn.dataset.channel;
            loadTickets();
        });
    });
});

// Toggle unread filter
function toggleUnreadFilter() {
    const btn = document.getElementById('unreadFilterBtn');
    if (btn) {
        btn.classList.toggle('active');
        filterTickets();
    }
}

// Reset all filters
function resetAllFilters() {
    const unreadBtn = document.getElementById('unreadFilterBtn');
    const statusFilter = document.getElementById('statusFilter');
    const dateFrom = document.getElementById('dateFromFilter');
    const dateTo = document.getElementById('dateToFilter');
    const timeFrom = document.getElementById('timeFromFilter');
    const timeTo = document.getElementById('timeToFilter');
    const searchInput = document.getElementById('ticketSearch');
    
    if (unreadBtn) unreadBtn.classList.remove('active');
    if (statusFilter) statusFilter.value = '';
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    if (timeFrom) timeFrom.value = '';
    if (timeTo) timeTo.value = '';
    if (searchInput) searchInput.value = '';

    // Reset channel filter to 'All'
    currentChannelFilter = 'all';
    document.querySelectorAll('.channel-toggle').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('.channel-toggle[data-channel="all"]');
    if (allBtn) allBtn.classList.add('active');
    
    filterTickets();
}

// All Orders Modal Functions
async function showAllOrdersModal(phone) {
    const modal = document.getElementById('allOrdersModal');
    const container = document.getElementById('allOrdersMessages');
    const phoneDisplay = document.getElementById('allOrdersCustomerPhone');
    
    phoneDisplay.textContent = phone;
    container.innerHTML = `
        <div class="chat-loading">
            <div class="spinner"></div>
            <span>Loading orders from database...</span>
        </div>
    `;
    modal.classList.add('active');
    
    try {
        const response = await fetch(`${API_BASE}/portal/${portalSlug}/customers/${phone}/all-orders`, {
            headers: { 'Authorization': `Bearer ${portalToken}` }
        });
        
        const data = await response.json();
        
        if (data.success && data.orders && data.orders.length > 0) {
            renderAllOrders(data.orders);
        } else {
            container.innerHTML = `
                <div class="chat-empty-state">
                    <div class="chat-empty-text">No orders found</div>
                    <div class="chat-empty-sub">This customer has no order history in our database.</div>
                </div>
            `;
        }
    } catch (error) {
        container.innerHTML = `
            <div class="chat-loading">Failed to fetch orders</div>
        `;
        showToast('Failed to fetch orders', 'error');
        console.error('Error fetching all orders:', error);
    }
}

function renderAllOrders(orders) {
    const container = document.getElementById('allOrdersMessages');
    
    // Summary header
    let html = `
        <div class="orders-summary-card">
            <strong>${orders.length}</strong> total order${orders.length !== 1 ? 's' : ''}
        </div>
    `;
    
    // Orders list
    orders.forEach(order => {
        html += `
            <div class="order-card">
                <div class="order-card-header">
                    <span class="order-id">${escapeHtml(order.order_id || 'N/A')}</span>
                    <span class="order-status ${order.status}">${escapeHtml(order.status || 'unknown')}</span>
                </div>
                <div class="order-card-details">
                    <div class="order-detail">
                        <span class="order-label">Date:</span>
                        <span>${formatDate(order.created_at)}</span>
                    </div>
                    ${order.total ? `
                        <div class="order-detail">
                            <span class="order-label">Amount:</span>
                            <span>₹${parseFloat(order.total).toFixed(2)}</span>
                        </div>
                    ` : ''}
                    ${order.payment_method ? `
                        <div class="order-detail">
                            <span class="order-label">Payment:</span>
                            <span>${escapeHtml(order.payment_method)}</span>
                        </div>
                    ` : ''}
                    ${order.product_name ? `
                        <div class="order-detail">
                            <span class="order-label">Product:</span>
                            <span>${escapeHtml(order.product_name)}</span>
                        </div>
                    ` : ''}
                    ${order.awb ? `
                        <div class="order-detail">
                            <span class="order-label">AWB:</span>
                            <span>${escapeHtml(order.awb)}</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function closeAllOrdersModal() {
    document.getElementById('allOrdersModal').classList.remove('active');
}
