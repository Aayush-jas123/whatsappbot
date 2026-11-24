// Offline logic test for the shared Zoho item resolver (stock linkage).
// The Zoho catalog is served from an in-memory fixture with the real API's
// filter semantics — no network, no accounting writes.
// Run: node test/testZohoItemResolver.js   (npm run test:zohoitems)

const zohoService = require('../src/services/zohoService');
const {
    createItemResolver,
    parseItemName,
    nameKey,
    skuHitAgrees,
    isChargeLineName,
} = require('../src/services/zohoItemResolver');

// ------------------------------------------------------------
// Fixture catalog: the spellings actually found in the live org
// ------------------------------------------------------------
const CATALOG = [
    // VEST - 001 ( Pack of 2 ) components: white uses the parenthesised
    // spell, black was entered as "SIZE / Colour" — the mismatch that made
    // every pack sale deduct only the white vest.
    { item_id: '1001', name: 'VEST - 001 ( W ) - M', sku: '' },
    { item_id: '1002', name: 'VEST - 001 ( W ) - L', sku: '' },
    { item_id: '1003', name: 'VEST 001 - M / Black', sku: '' },
    { item_id: '1004', name: 'VEST 001 - L / Black', sku: '' },
    // Same style re-entered once more, this time without the slash
    { item_id: '1005', name: 'VEST 001 - S / Black', sku: '' },
    { item_id: '1006', name: 'VEST 001 - S  Black', sku: '' },
    // Raglans: spaces inside the parentheses on one, none on the other, and
    // junk numeric SKUs that belong to a DIFFERENT colourway than the name
    { item_id: '1007', name: 'RAGLAN 001 ( G ) - M', sku: '' },
    { item_id: '1008', name: 'RAGLAN 001(G)-XL', sku: '' },
    { item_id: '1009', name: 'RAGLAN 001 ( B ) - L', sku: '7' },
    { item_id: '1010', name: 'RAGLAN 001 ( B ) - M', sku: '6' },
    { item_id: '1011', name: 'RAGLAN 001 ( W ) - M', sku: '0' },
    // Grey raglan L / S were never added to the catalog at all
    // POLOs carry real SKUs, incl. a dash in the style number
    { item_id: '1012', name: 'POLO- 001 ( BLACK ) - M', sku: 'BP001-M' },
    // Hand-typed spacing weirdness: no search for "POLO" will ever return it
    { item_id: '1013', name: 'P O L O 001 ( BLACK ) - XL', sku: 'BP001-XL' },
];

let apiCalls = [];
zohoService.searchItem = async (filters = {}) => {
    apiCalls.push(filters);
    let rows = CATALOG;
    if (filters.sku) rows = rows.filter(i => String(i.sku || '') === String(filters.sku));
    if (filters.name) {
        const want = String(filters.name).toLowerCase();
        rows = rows.filter(i => String(i.name || '').toLowerCase() === want);
    }
    if (filters.name_contains) {
        const want = String(filters.name_contains).toLowerCase();
        rows = rows.filter(i => String(i.name || '').toLowerCase().includes(want));
    }
    const page = parseInt(filters.page || 1, 10);
    const per = parseInt(filters.per_page || 200, 10);
    return rows.slice((page - 1) * per, page * per);
};
zohoService.getItemByName = async (name) => {
    const rows = await zohoService.searchItem({ name });
    return rows.find(i => i.name === name) || null;
};

let warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

let failures = 0;
function check(name, cond, detail = '') {
    realWarn(`${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
    if (!cond) failures++;
}
async function linked(resolver, line) {
    apiCalls = [];
    warnings = [];
    return await resolver.resolveLine(line);
}

async function main() {
    const resolver = createItemResolver();

    realWarn('\n— name parsing (the three catalog spellings) —');
    check('paren spell  → BLACK/M',
        JSON.stringify(parseItemName('VEST - 001 ( BLACK ) - M')) === JSON.stringify({ base: 'VEST - 001', color: 'BLACK', size: 'M' }),
        JSON.stringify(parseItemName('VEST - 001 ( BLACK ) - M')));
    check('slash spell  → BLACK/M',
        JSON.stringify(parseItemName('VEST 001 - M / Black')) === JSON.stringify({ base: 'VEST 001', color: 'BLACK', size: 'M' }),
        JSON.stringify(parseItemName('VEST 001 - M / Black')));
    check('space spell  → BLACK/M', nameKey('VEST 001 - S  Black') === nameKey('VEST 001 ( BLACK ) - S'),
        `${nameKey('VEST 001 - S  Black')} vs ${nameKey('VEST 001 ( BLACK ) - S')}`);
    check('letter colourway ( G ) ≡ GREY', nameKey('RAGLAN 001 ( G ) - M') === nameKey('RAGLAN 001 ( GREY ) - M'));
    check('dashes are not part of the style', nameKey('VEST - 001 ( W ) - M') === nameKey('VEST 001 ( W ) - M'));
    check('plain names are never read as colourways',
        parseItemName('HOODIE 001 - LIMITED EDITION BLACK').color === '',
        JSON.stringify(parseItemName('HOODIE 001 - LIMITED EDITION BLACK')));

    realWarn('\n— the vest pack: both colours must count —');
    const white = await linked(resolver, { name: 'VEST - 001 ( W ) - M', sku: 'VEST - 001 ( W )' });
    check('white component links', white.item?.name === 'VEST - 001 ( W ) - M', JSON.stringify(white));
    const black = await linked(resolver, { name: 'VEST 001 ( BLACK ) - M', sku: 'VEST 001 ( BLACK )' });
    check('black component links to "VEST 001 - M / Black"', black.item?.name === 'VEST 001 - M / Black', JSON.stringify(black));
    check('black component links via name, not SKU', black.via === 'name', black.via);

    const dup = await linked(resolver, { name: 'VEST 001 ( BLACK ) - S', sku: '' });
    check('duplicate spellings resolve to one item', dup.item?.name === 'VEST 001 - S / Black', JSON.stringify(dup));
    check('duplicate is reported, not silently chosen', warnings.some(w => /items match/.test(w)), warnings.join(' | '));

    realWarn('\n— spacing variants —');
    const tight = await linked(resolver, { name: 'RAGLAN 001 ( G ) - XL', sku: '' });
    check('"RAGLAN 001 ( G ) - XL" → "RAGLAN 001(G)-XL"', tight.item?.name === 'RAGLAN 001(G)-XL', JSON.stringify(tight));
    const loose = await linked(resolver, { name: 'RAGLAN 001(G) - M', sku: '' });
    check('"RAGLAN 001(G) - M" → "RAGLAN 001 ( G ) - M"', loose.item?.name === 'RAGLAN 001 ( G ) - M', JSON.stringify(loose));

    realWarn('\n— junk Shopify SKUs must not move the wrong stock —');
    const conflictColor = await linked(resolver, { name: 'RAGLAN 001 ( G ) - L', sku: '7' });
    check('grey raglan + sku "7" (= black item) refused',
        !conflictColor.item && conflictColor.via === 'sku-conflict', JSON.stringify(conflictColor));
    check('the colliding item is named in the warning', conflictColor.conflict?.name === 'RAGLAN 001 ( B ) - L', JSON.stringify(conflictColor.conflict));
    const conflictSize = await linked(resolver, { name: 'RAGLAN 001 ( W ) - S', sku: '0' });
    check('size S + sku "0" (= "RAGLAN 001 ( W ) - M") refused',
        !conflictSize.item && conflictSize.via === 'sku-conflict', JSON.stringify(conflictSize));
    const missing = await linked(resolver, { name: 'RAGLAN 001 ( G ) - S', sku: '' });
    check('catalog gap stays an honest miss', !missing.item && missing.via === 'miss', JSON.stringify(missing));

    realWarn('\n— a trustworthy SKU still works —');
    const bySku = await linked(resolver, { name: 'POLO 001 ( BLACK ) - XL', sku: 'BP001-XL' });
    check('name that cannot be searched, SKU agrees → linked', bySku.item?.item_id === '1013' && bySku.via === 'sku', JSON.stringify(bySku));
    const polo = await linked(resolver, { name: 'POLO 001 ( BLACK ) - M', sku: 'BP001-M' });
    check('"POLO 001" vs catalog "POLO- 001" links by name', polo.item?.item_id === '1012' && polo.via === 'name', JSON.stringify(polo));

    realWarn('\n— charge lines cost no API calls —');
    for (const nm of ['Shipping', 'Rounding Adjustment', 'COD Charges']) {
        const r = await linked(resolver, { name: nm, sku: '' });
        check(`"${nm}" skipped (${apiCalls.length} calls)`, r.via === 'charge-line' && apiCalls.length === 0, JSON.stringify(r));
    }
    check('a product is never treated as a charge line', !isChargeLineName('POLO- 001 ( BLACK ) - M'));

    realWarn('\n— skuHitAgrees (the guard itself) —');
    const blackItem = { name: 'RAGLAN 001 ( B ) - L' };
    check('same style+size, different colour → distrust', !skuHitAgrees('RAGLAN 001 ( G ) - L', blackItem));
    check('same style+colour, different size → distrust', !skuHitAgrees('RAGLAN 001 ( B ) - XL', blackItem));
    check('same style, name without colour/size → trust', skuHitAgrees('RAGLAN 001', blackItem));
    check('different style → distrust', !skuHitAgrees('VEST 001 ( BLACK ) - L', blackItem));

    realWarn('\n— caching —');
    apiCalls = [];
    await resolver.resolveLine({ name: 'VEST - 001 ( W ) - L', sku: '' });
    const firstRun = apiCalls.length;
    await resolver.resolveLine({ name: 'VEST - 001 ( W ) - L', sku: '' });
    check(`repeat lookup costs nothing (${firstRun} calls, then 0 more)`,
        firstRun > 0 && apiCalls.length === firstRun, `${apiCalls.length} total`);

    realWarn(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' check(s) failed' : 'all checks passed'}\n`);
    process.exit(failures ? 1 : 0);
}

main().catch(err => { console.warn = realWarn; console.error('Fatal:', err); process.exit(1); });
