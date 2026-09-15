const { dbAdapter } = require('../src/database/db');

async function inspect() {
    console.log('--- Inspecting product titles and colors in store_shoppers ---');
    const rows = await dbAdapter.query(
        "SELECT items_json FROM store_shoppers WHERE items_json IS NOT NULL ORDER BY id DESC LIMIT 500"
    );
    const titles = new Set();
    const compoundVariants = new Set();

    for (const r of rows) {
        try {
            const items = JSON.parse(r.items_json);
            for (const it of items) {
                if (it.title) titles.add(it.title);
                if (it.variant_title && (it.variant_title.includes('/') || it.variant_title.includes('-'))) {
                    compoundVariants.add(it.variant_title);
                }
            }
        } catch (e) {}
    }
    console.log('Distinct product titles (first 40):', Array.from(titles).slice(0, 40));
    console.log('Compound variant titles:', Array.from(compoundVariants));

    process.exit(0);

    console.log('--- Inspecting items_json samples from store_shoppers ---');
    const shopperSamples = await dbAdapter.query(
        "SELECT order_id, items_json FROM store_shoppers WHERE items_json IS NOT NULL ORDER BY id DESC LIMIT 5"
    );
    for (const row of shopperSamples) {
        console.log(`Order ${row.order_id}:`, row.items_json);
    }

    console.log('--- Inspecting orders table items / line_items ---');
    const orderCols = await dbAdapter.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders'"
    );
    console.log('orders columns:', orderCols.map(c => c.column_name));

    const orderSamples = await dbAdapter.query("SELECT * FROM orders ORDER BY id DESC LIMIT 2");
    console.log('orders sample:', JSON.stringify(orderSamples, null, 2));

    process.exit(0);
}

inspect().catch(err => {
    console.error(err);
    process.exit(1);
});
