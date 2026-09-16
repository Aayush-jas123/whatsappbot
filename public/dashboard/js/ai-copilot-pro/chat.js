/**
 * AI Copilot Pro — Chat Section
 *
 * Full-height conversational copilot with rich message rendering,
 * action confirmation cards, quick-action chips, and conversation save.
 */
(function () {
    'use strict';
    const CP = window.CopilotPro;
    if (!CP) return;

    const SECTION = 'chat';
    let initialized = false;
    let busy = false;
    let historyLoaded = false;

    // ── Styles (scoped to #section-chat) ──
    const style = document.createElement('style');
    style.textContent = `
    #section-chat { background: var(--bg-primary); }
    .chat-layout { display: flex; flex-direction: column; height: 100%; }
    .chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .chat-msg { max-width: 75%; padding: 12px 16px; border-radius: 16px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; }
    .chat-msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
    .chat-msg.assistant { align-self: flex-start; background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .chat-msg.system { align-self: center; background: transparent; color: var(--text-muted); font-size: 12px; text-align: center; max-width: 90%; }
    .chat-msg.assistant table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
    .chat-msg.assistant th, .chat-msg.assistant td { padding: 4px 8px; border: 1px solid var(--border); text-align: left; }
    .chat-msg.assistant th { background: var(--bg-input); font-weight: 600; }
    .chat-typing { align-self: flex-start; color: var(--text-muted); font-size: 12px; padding: 8px 16px; display: flex; align-items: center; gap: 6px; }
    .chat-typing .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: typingDot 1.2s infinite; }
    .chat-typing .dot:nth-child(2) { animation-delay: .2s; }
    .chat-typing .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes typingDot { 0%,80%,100%{opacity:.3} 40%{opacity:1} }

    /* Confirmation card */
    .chat-confirm { align-self: stretch; max-width: 500px; background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.3); border-radius: var(--radius); padding: 16px; }
    .chat-confirm-title { font-weight: 600; color: var(--warning); font-size: 12px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .chat-confirm-summary { color: var(--text-primary); font-size: 13px; margin-bottom: 12px; line-height: 1.5; }
    .chat-confirm-btns { display: flex; gap: 8px; }
    .chat-confirm-btns button { flex: 1; padding: 8px; border-radius: var(--radius-sm); border: none; font-size: 13px; font-weight: 600; }
    .chat-confirm-yes { background: var(--success); color: #fff; }
    .chat-confirm-no { background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border) !important; }

    /* Quick chips */
    .chat-quick-bar { padding: 8px 20px; display: flex; gap: 8px; overflow-x: auto; border-top: 1px solid var(--border); background: var(--bg-secondary); }
    .quick-chip { white-space: nowrap; padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-secondary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
    .quick-chip:hover { background: var(--accent-bg); color: var(--accent-hover); border-color: var(--accent); }

    /* Smart Working Memory Bar */
    .chat-memory-bar { padding: 6px 20px; display: flex; align-items: center; justify-content: space-between; background: rgba(99, 102, 241, 0.08); border-top: 1px solid rgba(99, 102, 241, 0.25); font-size: 11.5px; color: #a5b4fc; }
    .chat-memory-content { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chat-memory-content b { color: #818cf8; font-weight: 600; }
    .chat-memory-clear { background: none; border: 1px solid rgba(99, 102, 241, 0.3); color: #c7d2fe; font-size: 11px; padding: 2px 8px; border-radius: 12px; cursor: pointer; flex-shrink: 0; transition: all .15s; }
    .chat-memory-clear:hover { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border-color: rgba(239, 68, 68, 0.4); }

    /* Input area */
    .chat-input-area { display: flex; gap: 10px; padding: 16px 20px; border-top: 1px solid var(--border); background: var(--bg-secondary); align-items: flex-end; }
    .chat-input-area textarea { flex: 1; resize: none; border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; font-size: 13.5px; background: var(--bg-input); color: var(--text-primary); outline: none; max-height: 120px; min-height: 44px; line-height: 1.4; }
    .chat-input-area textarea:focus { border-color: var(--accent); }
    .chat-input-area textarea::placeholder { color: var(--text-muted); }
    .chat-send-btn { background: var(--accent); color: #fff; border: none; border-radius: var(--radius); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .chat-send-btn:disabled { opacity: .4; cursor: not-allowed; }
    .chat-send-btn svg { width: 18px; height: 18px; }

    /* Save conversation btn */
    .chat-save-btn { align-self: flex-end; background: none; border: 1px solid var(--border); color: var(--text-muted); font-size: 11px; padding: 4px 10px; border-radius: 12px; cursor: pointer; margin-top: -4px; }
    .chat-save-btn:hover { color: var(--accent-hover); border-color: var(--accent); }

    /* Enhanced Markdown / Live Data Styling */
    .chat-msg.assistant strong { font-weight: 700; color: #f8fafc; }
    .chat-msg.assistant em { font-style: italic; color: #cbd5e1; }
    .chat-msg.assistant ul { margin: 6px 0 6px 18px; padding: 0; list-style-type: disc; }
    .chat-msg.assistant li { margin-bottom: 4px; }
    .chat-msg.assistant p { margin: 6px 0; }
    .chat-msg.assistant code { background: rgba(0,0,0,0.25); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #38bdf8; }

    /* Modern live metadata pills */
    .chat-meta-footer { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; }
    .chat-meta-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 12px; background: rgba(99, 102, 241, 0.12); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.25); font-weight: 500; }
    .chat-meta-pill.live-db { background: rgba(34, 197, 94, 0.12); color: #4ade80; border-color: rgba(34, 197, 94, 0.25); }
    .chat-meta-pill.denominator { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border-color: rgba(245, 158, 11, 0.25); }

    /* Phase 14 Categorization Badges */
    .badge-tier { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; margin-right: 4px; vertical-align: middle; letter-spacing: 0.5px; }
    .badge-verified-fact { background: #059669; color: #ffffff; }
    .badge-policy { background: #0284c7; color: #ffffff; }
    .badge-pattern { background: #7c3aed; color: #ffffff; }
    .badge-anomaly { background: #dc2626; color: #ffffff; }
    .badge-recommendation { background: #d97706; color: #ffffff; }
    .badge-inference { background: #475569; color: #ffffff; }
    `;
    document.head.appendChild(style);

    // ── Render ──
    function render() {
        const root = document.getElementById('section-chat');
        root.innerHTML = `
        <div class="chat-layout">
            <div class="chat-messages" id="chatMessages">
                <div class="chat-msg system">Welcome to AI Copilot Pro. I can look up customers, orders, tickets, shipments, run analytics, and perform actions — all with your confirmation.</div>
            </div>
            <div class="chat-memory-bar" id="chatMemoryBar" style="display:none;">
                <div class="chat-memory-content" id="chatMemoryContent"></div>
                <button class="chat-memory-clear" id="chatMemoryClear" title="Clear conversational memory and start a fresh inquiry">× Forget Context</button>
            </div>
            <div class="chat-quick-bar" id="chatQuickBar">
                <button class="quick-chip" data-prompt="Show me open support tickets today">Open tickets today</button>
                <button class="quick-chip" data-prompt="What are the dashboard stats?">Dashboard stats</button>
                <button class="quick-chip" data-prompt="Triage my open tickets by category and priority">Triage tickets</button>
                <button class="quick-chip" data-prompt="List pending shipments that need booking">Pending shipments</button>
                <button class="quick-chip" data-prompt="Top customer questions this week">Top questions</button>
                <button class="quick-chip" data-prompt="Show AI usage and cost summary">AI cost summary</button>
            </div>
            <div class="chat-input-area">
                <textarea id="chatInput" rows="1" placeholder="Ask about customers, orders, tickets, shipments… or say 'triage tickets'"></textarea>
                <button class="chat-send-btn" id="chatSendBtn" title="Send">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
            </div>
        </div>`;

        // Event listeners
        document.getElementById('chatSendBtn').addEventListener('click', sendMessage);
        document.getElementById('chatInput').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        document.querySelectorAll('.quick-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.getElementById('chatInput').value = chip.dataset.prompt;
                sendMessage();
            });
        });
        const memClear = document.getElementById('chatMemoryClear');
        if (memClear) {
            memClear.addEventListener('click', () => {
                document.getElementById('chatInput').value = 'clear memory';
                sendMessage();
            });
        }
    }

    // ── Message rendering ──
    function addMsg(role, text) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const div = document.createElement('div');
        div.className = `chat-msg ${role}`;
        if (role === 'assistant') {
            div.innerHTML = renderRichContent(text);
        } else {
            div.textContent = text;
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function renderRichContent(text) {
        if (!text) return '';
        let html = escapeHtml(text);

        // 1. Convert timestamp footers: "*Data as of: ...*" or "Data as of: ..."
        let footerMeta = '';
        html = html.replace(/(?:^|\n)\*?Data as of:\s*([^*<\n\r]+?)\*?(?=\n|$)/gi, (match, p1) => {
            const clean = p1.replace(/\s*\(Live Database\)/i, '').trim();
            footerMeta += `<div class="chat-meta-pill" title="Verified Live Database Record"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> <span>Live Data: ${clean}</span> <span class="meta-dot"></span> <span class="meta-tag">Live DB</span></div>`;
            return '';
        });

        // 2. Convert Denominator lines: "*Denominator: ...*" or "Denominator: ..."
        html = html.replace(/(?:^|\n)\*?Denominator:\s*([^*<\n\r]+?)\*?(?=\n|$)/gi, (match, p1) => {
            footerMeta += `<div class="chat-denom-pill"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 12h10"/></svg> <span>Denominator: ${p1.trim()}</span></div>`;
            return '';
        });

        // 3. Phase 14 8-tier Classification Badges
        html = html.replace(/\[VERIFIED FACT\]/g, '<span class="tier-badge tier-verified">✓ VERIFIED FACT</span>');
        html = html.replace(/\[POLICY\]/g, '<span class="tier-badge tier-policy">📋 POLICY</span>');
        html = html.replace(/\[PATTERN\]/g, '<span class="tier-badge tier-pattern">📈 PATTERN</span>');
        html = html.replace(/\[ANOMALY(?:\s*-\s*HIGH RATE)?\]/g, '<span class="tier-badge tier-anomaly">⚠️ ANOMALY</span>');
        html = html.replace(/\[INFERENCE\]/g, '<span class="tier-badge tier-inference">💡 INFERENCE</span>');
        html = html.replace(/\[RECOMMENDATION\]/g, '<span class="tier-badge tier-recommendation">🎯 RECOMMENDATION</span>');
        html = html.replace(/\[ACTION COMPLETED\]/g, '<span class="tier-badge tier-verified">✓ ACTION COMPLETED</span>');
        html = html.replace(/\[ACTION REQUIRED\]/g, '<span class="tier-badge tier-anomaly">⚡ ACTION REQUIRED</span>');

        // 4. Bold: **text**
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // 5. Italic: *text*
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // 6. Inline code or JSON tables: `code` or {key: value}
        html = html.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');
        html = html.replace(/\{(\w+):[^}]+\}/g, match => `<code class="chat-code">${match}</code>`);

        // 7. Bullet lists and numbered lists
        html = html.replace(/^[•\-\*]\s+(.+)$/gm, '<div class="chat-list-item">&#8226; $1</div>');
        html = html.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="chat-list-item"><span class="list-num">$1.</span> $2</div>');

        // 8. Line breaks and paragraphs
        html = html.replace(/\n\n+/g, '<div class="chat-paragraph-gap"></div>');
        html = html.replace(/\n/g, '<br>');
        html = html.replace(/<\/div><br>/g, '</div>');

        // 9. Attach modern footer pills if present
        if (footerMeta) {
            html += `<div class="chat-meta-footer">${footerMeta}</div>`;
        }

        return html;
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addTyping() {
        const container = document.getElementById('chatMessages');
        if (!container) return null;
        const div = document.createElement('div');
        div.className = 'chat-typing';
        div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span> Thinking…';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function addConfirmCard(pending) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const card = document.createElement('div');
        card.className = 'chat-confirm';
        card.innerHTML = `
            <div class="chat-confirm-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Confirmation required
            </div>
            <div class="chat-confirm-summary"></div>
            <div class="chat-confirm-btns">
                <button class="chat-confirm-yes">Confirm &amp; Execute</button>
                <button class="chat-confirm-no">Cancel</button>
            </div>`;
        card.querySelector('.chat-confirm-summary').textContent = pending.summary || pending.toolName;
        const yes = card.querySelector('.chat-confirm-yes');
        const no = card.querySelector('.chat-confirm-no');

        yes.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            yes.textContent = 'Executing…';
            try {
                const data = await CP.apiFetch(`/ai/confirm/${pending.id}`, 'POST');
                card.remove();
                addMsg('system', `Executed: ${data.summary || pending.summary}`);
                if (data.result && typeof data.result === 'object') {
                    addMsg('assistant', `Result: ${JSON.stringify(data.result, null, 2).substring(0, 600)}`);
                }
            } catch (e) {
                card.remove();
                addMsg('system', `Failed: ${e.message}`);
            }
        };
        no.onclick = async () => {
            yes.disabled = true; no.disabled = true;
            try { await CP.apiFetch(`/ai/cancel/${pending.id}`, 'POST'); } catch (e) { /* ignore */ }
            card.remove();
            addMsg('system', 'Action cancelled.');
        };
        container.appendChild(card);
        container.scrollTop = container.scrollHeight;
    }

    // ── Send message ──
    async function sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        document.getElementById('chatSendBtn').disabled = true;
        input.value = '';
        input.style.height = '44px';
        addMsg('user', text);
        const typing = addTyping();
        try {
            const data = await CP.apiFetch('/ai/chat', 'POST', { message: text });
            if (typing) typing.remove();
            addMsg('assistant', data.reply || 'Done.');
            if (data.pendingAction && data.pendingAction.id) addConfirmCard(data.pendingAction);
            if (data.activeMemory) {
                updateMemoryBar(data.activeMemory);
            } else if (/clear\s*memory|forget/i.test(text)) {
                updateMemoryBar(null);
            }
            // Add save-to-training button on last assistant message
            addSaveBtn(data.reply);
        } catch (e) {
            if (typing) typing.remove();
            addMsg('system', `Error: ${e.message}`);
        } finally {
            busy = false;
            document.getElementById('chatSendBtn').disabled = false;
            input.focus();
        }
    }

    function updateMemoryBar(mem) {
        const bar = document.getElementById('chatMemoryBar');
        const content = document.getElementById('chatMemoryContent');
        if (!bar || !content) return;

        if (!mem || (!mem.orderId && !mem.phone && !mem.customerName && !mem.ticketNumber && !mem.sku)) {
            bar.style.display = 'none';
            return;
        }

        const pills = [];
        if (mem.orderId) pills.push(`Order <b>#${escapeHtml(mem.orderId)}</b>`);
        if (mem.customerName) pills.push(`<b>${escapeHtml(mem.customerName)}</b>`);
        if (mem.phone) pills.push(`+91 ${escapeHtml(mem.phone)}`);
        if (mem.ticketNumber) pills.push(`Ticket <b>#${escapeHtml(mem.ticketNumber)}</b>`);
        if (mem.sku) pills.push(`SKU: <b>${escapeHtml(mem.sku)}</b>`);
        if (mem.subject) pills.push(`Focus: ${escapeHtml(mem.subject)}`);

        content.innerHTML = `🧠 <b>Active Context:</b> ${pills.join(' <span style="opacity:0.35;margin:0 2px;">•</span> ')}`;
        bar.style.display = 'flex';
    }

    function addSaveBtn(replyText) {
        if (!replyText || replyText.length < 20) return;
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const btn = document.createElement('button');
        btn.className = 'chat-save-btn';
        btn.textContent = 'Save as training example';
        btn.onclick = async () => {
            const question = prompt('What customer question does this answer?');
            if (!question) return;
            try {
                await CP.apiFetch('/ai/learned', 'POST', { question, reply: replyText, pinned: true });
                btn.textContent = 'Saved!';
                btn.style.color = 'var(--success)';
                btn.style.borderColor = 'var(--success)';
            } catch (e) {
                btn.textContent = 'Failed: ' + e.message;
            }
        };
        container.appendChild(btn);
    }

    // ── Load history ──
    async function loadHistory() {
        if (historyLoaded) return;
        historyLoaded = true;
        try {
            const data = await CP.apiFetch('/ai/history');
            (data.history || []).forEach(turn => {
                if (turn.role === 'user' || turn.role === 'assistant') addMsg(turn.role, turn.content);
            });
            if (data.activeMemory) updateMemoryBar(data.activeMemory);
        } catch (e) { /* optional */ }
    }

    // ── Section lifecycle ──
    document.addEventListener('copilot-section-activate', (e) => {
        if (e.detail.section === SECTION) {
            if (!initialized) { render(); initialized = true; }
            loadHistory();
        }
    });
})();
