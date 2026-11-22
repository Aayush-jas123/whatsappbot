require('dotenv').config();
const axios = require('axios');

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

if (!accessToken || !wabaId) {
    console.error('❌ Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID in .env');
    process.exit(1);
}

async function submitTemplate(template) {
    console.log(`\n🚀 Submitting template: "${template.name}" ...`);
    try {
        const res = await axios.post(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
            template,
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log(`✅ "${template.name}" submitted! ID: ${res.data.id}  Status: ${res.data.status}`);
        return res.data;
    } catch (err) {
        const errData = err.response?.data?.error;
        console.error(`❌ Failed to submit "${template.name}":`, JSON.stringify(errData || err.message, null, 2));
        return null;
    }
}

async function run() {
    // ─── Support Desk introduction template ──────────────────────────────
    // MARKETING category — feature announcement sent when customers are
    // granted Help & Tickets access (Support Desk ▸ Access console).
    // Body Parameters:
    //   {{1}} = Customer Name
    // Button:
    //   Static URL (no dynamic suffix), so Meta validates it at definition
    //   time and nothing extra is needed at send time.
    // The original announcement is trimmed to stay under Meta's 1024-char
    // body limit; the sign-off moves to the footer.
    const template = {
        name: 'support_desk_intro',
        language: 'en',
        category: 'MARKETING',
        components: [
            {
                type: 'HEADER',
                format: 'TEXT',
                text: 'Introducing The Offcomfrt Support Desk'
            },
            {
                type: 'BODY',
                text: `Hi {{1}},\n\nWe've launched our new *Support Desk* to make resolving your concerns easier, more organized and more transparent.\n\nWhether it's an order, delivery, return, exchange, payment or product issue, you can now raise a support ticket directly on our website:\n\n1. Log in at *offcomfrt.in*\n2. Open the *Help & Support* section, or tap *Need Help?* below your order\n3. Submit your concern \u2014 our team takes it from there\n\nEvery ticket is documented and tracked until it's resolved, and we aim for a *full and final resolution within 72 hours* of ticket creation.\n\n*All customer support requests must now be raised through our Support Desk.*\n\nWe're committed to making your experience with Offcomfrt better, every step of the way \ud83e\udd0d`,
                example: {
                    body_text: [['Aaryan']]
                }
            },
            {
                type: 'FOOTER',
                text: 'Team Offcomfrt'
            },
            {
                type: 'BUTTONS',
                buttons: [
                    {
                        type: 'URL',
                        text: 'Visit Support Desk',
                        url: 'https://offcomfrt.in'
                    }
                ]
            }
        ]
    };

    console.log(`\ud83d\udccb Submitting template to WABA: ${wabaId}`);
    console.log(`   Template name: ${template.name}`);
    console.log(`   Category: ${template.category}`);
    console.log(`   Body Parameters:`);
    console.log(`      {{1}} = Customer Name`);
    console.log(`   Button:`);
    console.log(`      URL -> https://offcomfrt.in (static)`);

    const result = await submitTemplate(template);

    if (result) {
        console.log('\n✅ Template submitted! It will be reviewed by Meta before activation.');
        console.log('ℹ️  Check WhatsApp Manager → Message Templates for the approval status.');
        console.log('\nOnce approved, the Support Desk Access console can send this');
        console.log('automatically on every grant (checkbox / policy toggle), or on');
        console.log('demand via "Send intro message" for any selection or segment.');
    } else {
        console.log('\n❌ Template submission failed. Check the error above.');
        console.log('If the name was already used, bump it to support_desk_intro_v2 here');
        console.log('and in SUPPORT_DESK_INTRO_TEMPLATE in src/routes/supportDeskRoutes.js.');
    }
}

run();
