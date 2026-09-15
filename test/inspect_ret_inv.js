const { dbAdapter } = require('../src/database/db');

async function run() {
    console.log('--- Checking tables ---');
    const tables = await dbAdapter.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('All public tables:', tables.map(t => t.table_name));

    console.log('\n--- Checking returns columns & sample ---');
    const retCols = await dbAdapter.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'returns'");
    console.log('returns columns:', retCols.map(c => c.column_name));
    const retSample = await dbAdapter.query("SELECT * FROM returns ORDER BY id DESC LIMIT 2");
    console.log('returns sample (2):', JSON.stringify(retSample, null, 2));

    console.log('\n--- Checking exchanges columns & sample ---');
    const exCols = await dbAdapter.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'exchanges'");
    console.log('exchanges columns:', exCols.map(c => c.column_name));
    const exSample = await dbAdapter.query("SELECT * FROM exchanges ORDER BY id DESC LIMIT 2");
    console.log('exchanges sample (2):', JSON.stringify(exSample, null, 2));

    console.log('\n--- Checking manual_inventory columns & sample ---');
    const invCols = await dbAdapter.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'manual_inventory'");
    console.log('manual_inventory columns:', invCols.map(c => c.column_name));
    const invSample = await dbAdapter.query("SELECT * FROM manual_inventory ORDER BY id ASC LIMIT 3");
    console.log('manual_inventory sample (3):', JSON.stringify(invSample, null, 2));

    console.log('\n--- Checking ai_learned_replies columns ---');
    const sopCols = await dbAdapter.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ai_learned_replies'");
    console.log('ai_learned_replies columns:', sopCols.map(c => c.column_name));
    const sopSample = await dbAdapter.query("SELECT * FROM ai_learned_replies LIMIT 3");
    console.log('ai_learned_replies sample (3):', JSON.stringify(sopSample, null, 2));

    console.log('\n--- Checking returns & exchanges count in DB ---');
    const retCount = await dbAdapter.query("SELECT COUNT(*) as count FROM returns");
    const exCount = await dbAdapter.query("SELECT COUNT(*) as count FROM exchanges");
    console.log('returns count:', retCount[0]?.count, 'exchanges count:', exCount[0]?.count);

    console.log('\n--- Checking support_tickets for return/exchange mentions ---');
    const retTickets = await dbAdapter.query("SELECT ticket_number, message, ai_scenario, status FROM support_tickets WHERE message ILIKE '%return%' OR message ILIKE '%exchange%' LIMIT 3");
    console.log('return/exchange tickets sample:', JSON.stringify(retTickets, null, 2));

    process.exit(0);
}

run().catch(err => {
    console.error('Inspection error:', err);
    process.exit(1);
});
