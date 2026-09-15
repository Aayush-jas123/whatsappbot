const { dbAdapter } = require('../src/database/db');

async function testTodaySales() {
    // 9 Sep 2026 00:00:00 IST is 8 Sep 2026 18:30:00 UTC
    const rows = await dbAdapter.query(`
        SELECT order_id, status, items_json, order_total, created_at 
        FROM store_shoppers 
        WHERE created_at >= '2026-09-08 18:30:00' AND items_json IS NOT NULL
        ORDER BY created_at ASC
    `);
    console.log('Today (9 Sep 2026 IST) orders count:', rows.length);
    const skuMap = {};
    for (const r of rows) {
        try {
            const items = JSON.parse(r.items_json);
            for (const it of items) {
                const name = it.name || it.title;
                const qty = parseInt(it.quantity, 10) || 1;
                const price = parseFloat(it.price) || 0;
                skuMap[name] = skuMap[name] || { name, sku: it.sku, variant: it.variant_title, qty: 0, revenue: 0, orders: 0 };
                skuMap[name].qty += qty;
                skuMap[name].revenue += price * qty;
                skuMap[name].orders += 1;
            }
        } catch (e) {}
    }
    console.log('Today SKU Breakdown:');
    console.log(JSON.stringify(skuMap, null, 2));

    // Also check this week (from Monday 7 Sep 2026 00:00:00 IST = 6 Sep 2026 18:30:00 UTC)
    const weekRows = await dbAdapter.query(`
        SELECT COUNT(*) as count, SUM(order_total) as total
        FROM store_shoppers 
        WHERE created_at >= '2026-09-06 18:30:00'
    `);
    console.log('This week total orders:', weekRows[0]);

    process.exit(0);
}

testTodaySales().catch(e => {
    console.error(e);
    process.exit(1);
});
