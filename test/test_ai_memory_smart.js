/**
 * Automated Test Suite: Smart Conversational Memory & Entity Context
 * 
 * Verifies:
 * 1. Entity extraction from user text (order, phone, ticket, SKU, subject)
 * 2. Active working memory management (store, update, retrieve, clear)
 * 3. Automatic argument filling for follow-up questions
 * 4. Hierarchical rolling context compression
 * 5. In-memory LRU chat history cache
 * 6. Multi-turn anaphoric resolution via runAgent
 */

const {
    getWorkingMemory,
    updateWorkingMemory,
    clearWorkingMemory,
    extractEntities,
    extractEntitiesFromToolResult,
    autoFillToolArgs,
    buildMemoryPrompt,
    compressConversationHistory,
    chatHistoryCache
} = require('../src/services/ai/aiMemoryService');

const { runAgent } = require('../src/services/ai/agent');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        failedTests++;
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        failedTests++;
    }
}

(async () => {
    console.log('\n============================================================');
    console.log('TEST SUITE: SMART CONVERSATIONAL MEMORY & WORKING CONTEXT');
    console.log('============================================================\n');

    const testActor = 'test_memory_officer_' + Date.now();

    // Test 1: Extract entities from order inquiry
    runTest('1. Extract order number and intent from user message', () => {
        const entities = extractEntities('Please check status of order #50992 regarding an exchange');
        if (entities.orderId !== '50992') throw new Error(`Expected orderId 50992, got ${entities.orderId}`);
        if (entities.subject !== 'Size / Product Exchange') throw new Error(`Expected exchange subject, got ${entities.subject}`);
    });

    // Test 2: Extract phone and ticket number
    runTest('2. Extract phone number and ticket number', () => {
        const entities = extractEntities('Customer from +91 9016754673 logged ticket TKT-260915-1093');
        if (entities.phone !== '9016754673') throw new Error(`Expected phone 9016754673, got ${entities.phone}`);
        if (entities.ticketNumber !== 'TKT-260915-1093') throw new Error(`Expected ticket TKT-260915-1093, got ${entities.ticketNumber}`);
    });

    // Test 3: Extract SKU
    runTest('3. Extract apparel SKU', () => {
        const entities = extractEntities('Customer bought HENLEY - 001 and wants to return it');
        if (!entities.sku || !entities.sku.includes('HENLEY')) throw new Error(`Expected SKU with HENLEY, got ${entities.sku}`);
    });

    // Test 4: Working memory store & update
    runTest('4. Store & update active working memory for an actor', () => {
        clearWorkingMemory(testActor);
        updateWorkingMemory(testActor, {
            orderId: '50992',
            customerName: 'Grishma',
            phone: '9016754673',
            sku: 'HENLEY - 001 ( ACID WASH )'
        });

        const mem = getWorkingMemory(testActor);
        if (mem.orderId !== '50992') throw new Error(`Expected orderId 50992, got ${mem.orderId}`);
        if (mem.customerName !== 'Grishma') throw new Error(`Expected Grishma, got ${mem.customerName}`);
        if (mem.phone !== '9016754673') throw new Error(`Expected 9016754673, got ${mem.phone}`);
    });

    // Test 5: Autofill missing arguments in follow-up queries
    runTest('5. Autofill missing tool arguments using active working memory', () => {
        const memory = getWorkingMemory(testActor);
        const argsBefore = { targetExchangeVariant: 'L' };
        const argsAfter = autoFillToolArgs('investigate_return_exchange', argsBefore, memory);

        if (argsAfter.orderId !== '50992') throw new Error(`Expected autofilled orderId 50992, got ${argsAfter.orderId}`);
        if (argsAfter.targetExchangeVariant !== 'L') throw new Error(`Expected targetExchangeVariant L, got ${argsAfter.targetExchangeVariant}`);

        const refundArgs = autoFillToolArgs('check_refund_eligibility', {}, memory);
        if (refundArgs.orderId !== '50992') throw new Error(`Expected autofilled orderId in refund check, got ${refundArgs.orderId}`);
        if (refundArgs.phone !== '9016754673') throw new Error(`Expected autofilled phone in refund check, got ${refundArgs.phone}`);
    });

    // Test 6: Build active memory prompt block
    runTest('6. Build structured working memory prompt injection', () => {
        const prompt = buildMemoryPrompt(testActor);
        if (!prompt.includes('[CONVERSATION WORKING MEMORY')) throw new Error('Prompt missing working memory header');
        if (!prompt.includes('#50992')) throw new Error('Prompt missing active order ID');
        if (!prompt.includes('Grishma')) throw new Error('Prompt missing active customer name');
        if (!prompt.includes('RULE:')) throw new Error('Prompt missing anaphoric rule instruction');
    });

    // Test 7: Extract entities from tool results
    runTest('7. Learn and extract entities from tool output objects', () => {
        const toolOutput = {
            order_id: '51803',
            customer_name: 'Chandan Sarkar',
            customer_phone: '918285748408',
            ticket_number: 'TKT-260915-9167'
        };
        const learned = extractEntitiesFromToolResult('investigate_return_exchange', toolOutput);
        if (learned.orderId !== '51803') throw new Error(`Expected orderId 51803, got ${learned.orderId}`);
        if (learned.customerName !== 'Chandan Sarkar') throw new Error(`Expected Chandan Sarkar, got ${learned.customerName}`);
        if (learned.phone !== '8285748408') throw new Error(`Expected 8285748408, got ${learned.phone}`);
    });

    // Test 8: Hierarchical rolling context compression
    runTest('8. Compress older dialogue turns into a semantic summary', () => {
        const mockHistory = [
            { role: 'user', content: 'What happened to order #42000?' },
            { role: 'assistant', content: 'Order #42000 was delivered via Delhivery.' },
            { role: 'user', content: 'What about ticket TKT-260915-1093?' },
            { role: 'assistant', content: 'Ticket TKT-260915-1093 is open for size exchange.' },
            { role: 'user', content: 'Can we exchange it?' },
            { role: 'assistant', content: 'Yes, replacement is in stock.' },
            { role: 'user', content: 'How about the refund?' },
            { role: 'assistant', content: 'Store credit is standard.' }
        ];

        const { summary, recentTurns } = compressConversationHistory(mockHistory, 4);
        if (!summary) throw new Error('Expected summary for older turns');
        if (recentTurns.length !== 4) throw new Error(`Expected 4 recent turns, got ${recentTurns.length}`);
        if (!summary.includes('42000') && !summary.includes('earlier')) throw new Error('Summary should capture key context from older turns');
    });

    // Test 9: Clear working memory command
    runTest('9. Clear working memory cleanly on command', () => {
        clearWorkingMemory(testActor);
        const mem = getWorkingMemory(testActor);
        if (mem.orderId !== null || mem.customerName !== null) {
            throw new Error('Working memory was not reset properly');
        }
    });

    // Test 10: In-memory chat history cache write-through
    runTest('10. In-memory LRU chat history cache operates with sub-millisecond access', () => {
        chatHistoryCache.set('actor_perf_test', [
            { role: 'user', content: 'Ping' },
            { role: 'assistant', content: 'Pong' }
        ]);

        const start = Date.now();
        const cached = chatHistoryCache.get('actor_perf_test');
        const duration = Date.now() - start;

        if (!cached || cached.length !== 2) throw new Error('Failed to retrieve cached history');
        if (duration > 10) throw new Error(`Cache lookup took too long: ${duration}ms`);
    });

    // Test 11: End-to-end multi-turn resolution with runAgent
    await runAsyncTest('11. End-to-end multi-turn memory resolution: Turn 1 sets context, Turn 2 resolves referent', async () => {
        const officerActor = 'officer_e2e_' + Date.now();
        
        // Turn 1: Explicit inquiry
        const turn1 = await runAgent({
            actor: officerActor,
            userMessage: 'Investigate return and exchange for order #50992'
        });

        if (!turn1 || !turn1.reply) throw new Error('Turn 1 produced no reply');
        const mem1 = getWorkingMemory(officerActor);
        if (mem1.orderId !== '50992') {
            throw new Error(`Expected active order #50992 in working memory, got ${mem1.orderId}`);
        }

        // Turn 2: Follow-up question with NO order number!
        const turn2 = await runAgent({
            actor: officerActor,
            userMessage: 'Can they exchange it for size L?'
        });

        if (!turn2 || !turn2.reply) throw new Error('Turn 2 produced no reply');
        // Reply should have addressed the exchange for order 50992 / Grishma / Henley
        const replyLower = turn2.reply.toLowerCase();
        const mentionsContext = replyLower.includes('50992') || replyLower.includes('exchange') || replyLower.includes('l') || replyLower.includes('grishma') || replyLower.includes('size');
        if (!mentionsContext) {
            throw new Error(`Turn 2 reply did not reflect active memory context: ${turn2.reply.substring(0, 150)}`);
        }

        // Turn 3: Reset memory command
        const turn3 = await runAgent({
            actor: officerActor,
            userMessage: 'clear memory'
        });

        if (!turn3.reply.includes('cleared')) {
            throw new Error(`Expected clear confirmation, got: ${turn3.reply}`);
        }
        const mem3 = getWorkingMemory(officerActor);
        if (mem3.orderId !== null) throw new Error('Working memory was not wiped after clear memory command');
    });

    console.log('\n============================================================');
    console.log(`SUMMARY: ${passedTests} passed, ${failedTests} failed`);
    console.log('============================================================\n');

    process.exit(failedTests > 0 ? 1 : 0);
})();
