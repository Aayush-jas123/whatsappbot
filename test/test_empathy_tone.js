/**
 * Automated tests for Change 13: "Customer Feels Heard" Tone & Empathy Enhancement
 * Run: node test/test_empathy_tone.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectCustomerSentiment, detectSopScenario } = require('../src/services/ai/customerAgent');

console.log('Testing "Customer Feels Heard" Tone & Empathy Enhancement (Change 13)...\n');

// 1. Test Sentiment Detection - Severe Anger / Fraud / Legal Threats
const severeMsg = 'You scammers cheated me, this is third class service! I will take legal action in consumer court against your brand!';
const severeResult = detectCustomerSentiment(severeMsg);
assert.strictEqual(severeResult.isFrustrated, true, 'Severe anger/legal threat must be marked as frustrated');
assert.strictEqual(severeResult.needsImmediateEscalation, true, 'Severe anger/legal threat must trigger immediate escalation');
assert(severeResult.triggers.length > 0, 'Must capture trigger keywords');
console.log('✅ Sentiment: Successfully detected severe anger and legal action threat');

// 2. Test Sentiment Detection - Delay Frustration (English)
const delayMsgEng = 'Why is there so much delay? Still not delivered and nobody is replying to my messages, I am fed up!';
const delayEngResult = detectCustomerSentiment(delayMsgEng);
assert.strictEqual(delayEngResult.isFrustrated, true, 'English delay frustration must be detected');
assert(delayEngResult.triggers.some(t => /delay|still not delivered|fed up|nobody replying/i.test(t)), 'Must record delay triggers');
console.log('✅ Sentiment: Successfully detected English delivery delay frustration');

// 3. Test Sentiment Detection - Hinglish Frustration
const delayMsgHinglish = 'Kitna time lagega bhai, ab tak nahi aaya mera parcel? Kab milega? Bahut bakwas experience hai';
const delayHinglishResult = detectCustomerSentiment(delayMsgHinglish);
assert.strictEqual(delayHinglishResult.isFrustrated, true, 'Hinglish delay frustration must be detected');
console.log('✅ Sentiment: Successfully detected Hinglish delay and frustration');

// 4. Test Sentiment Detection - Urgent Human Escalation Demand
const urgentMsg = 'Connect me to a real person or human manager immediately right now!';
const urgentResult = detectCustomerSentiment(urgentMsg);
assert.strictEqual(urgentResult.isUrgent, true, 'Must detect urgency in human escalation request');
assert.strictEqual(urgentResult.needsImmediateEscalation, true, 'Urgent human demand must trigger immediate escalation');
console.log('✅ Sentiment: Successfully detected urgent human/manager escalation request');

// 5. Test Sentiment Detection - Neutral Query (No false positives)
const neutralMsg = 'Hi, where is my order #53686? Can you check the delivery status please?';
const neutralResult = detectCustomerSentiment(neutralMsg);
assert.strictEqual(neutralResult.isFrustrated, false, 'Neutral query must not be flagged as frustrated');
assert.strictEqual(neutralResult.isUrgent, false, 'Neutral query must not be flagged as urgent');
assert.strictEqual(neutralResult.needsImmediateEscalation, false, 'Neutral query must not trigger immediate escalation');
console.log('✅ Sentiment: Verified neutral query produces no false positive frustration');

// 6. Test Empathy System Prompt Content
const customerAgentSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai/customerAgent.js'), 'utf8');
assert(customerAgentSrc.includes('EMPATHY & ACTIVE LISTENING PRINCIPLES'), 'System prompt must contain EMPATHY & ACTIVE LISTENING PRINCIPLES');
assert(customerAgentSrc.includes('Validate feelings first'), 'Must instruct AI to validate customer feelings first');
assert(customerAgentSrc.includes('No phone callbacks'), 'Must instruct AI that no phone callbacks are promised');
assert(customerAgentSrc.includes('Priority Escalation'), 'Must include priority escalation guidance');
assert(customerAgentSrc.includes('CUSTOMER SENTIMENT: High Frustration'), 'System prompt must dynamically inject sentiment note');
console.log('✅ System Prompt: Empathy and active listening principles verified');

// 7. Test Widget Routes chat endpoint includes sentiment and whatsappLink
const widgetRoutesSrc = fs.readFileSync(path.join(__dirname, '../src/routes/widgetRoutes.js'), 'utf8');
assert(widgetRoutesSrc.includes('sentiment: result.sentiment || \'neutral\''), 'Widget chat endpoint must return sentiment');
assert(widgetRoutesSrc.includes('whatsappLink: result.whatsappLink || null'), 'Widget chat endpoint must return whatsappLink');
console.log('✅ Widget Routes: Sentiment and whatsappLink return contract verified');

// 8. Test Widget frontend (testbot.js) handling of empathy escalation
const testbotJsSrc = fs.readFileSync(path.join(__dirname, '../public/widget/js/testbot.js'), 'utf8');
assert(testbotJsSrc.includes('open_whatsapp_escalation_'), 'Widget must implement open_whatsapp_escalation_ handler');
assert(testbotJsSrc.includes('Chat on WhatsApp'), 'Widget must render Chat on WhatsApp button');
assert(testbotJsSrc.includes('Priority Support Ticket'), 'Widget must offer Priority Support Ticket');
console.log('✅ Testbot Widget: Empathetic WhatsApp and Priority Ticket escalation verified');

console.log('\nAll Change 13 empathy tests passed successfully! 🚀');
