// node --test test/*.test.mjs   (from the extension folder; finds the Σ checkout beside it, or SIGMA_DIR)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCollectionList, parseCollectionPage, jannyListPath, jannyCollectionPath, decodeEntities, JANNY_PAGE_SIZE } from '../client/core/janny-parse.js';
import { normalizeFeed, normalizeDetail } from '../client/core/datacat-normalize.js';
import { createRegistry, validateSource, cleanMember, cleanCollection, safeUrl } from '../client/core/sources.js';
import { ownersMap, planImport, chunk, playlistNameFor } from '../client/core/import-plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');

// ---------- JannyAI pages ----------
test('janny: the collection list page', () => {
    const { items, totalPages } = parseCollectionList(fx('janny-list.html'));
    assert.equal(items.length, 20);
    assert.equal(totalPages, 46, 'pager hrefs carry &#38; entities');
    for (const c of items) {
        assert.match(c.id, /^[0-9a-f-]{36}_/);
        assert.ok(c.title && !/characters\)/.test(c.title), 'the count is split off the title');
        assert.ok(Number.isInteger(c.count));
        assert.ok(c.url.startsWith('https://jannyai.com/collections/'));
    }
    const phoenix = items.find(c => /phoenix/.test(c.id));
    assert.ok(phoenix, 'a slug holding &#x27; is not cut at the entity\'s #');
    assert.equal(phoenix.id, "a0ec9071-326f-41ff-bc77-8ce8d0437fda_icedphoenix's-bots-1-f");
    assert.equal(phoenix.title, "IcedPhoenix's Bots");
    assert.ok(items.every(c => c.covers.every(u => u.startsWith('https://'))));
    assert.ok(items[0].curator?.name);
});

test('janny: one collection page', () => {
    const r = parseCollectionPage(fx('janny-collection.html'));
    assert.equal(r.collection.title, 'Favoritas');
    assert.equal(r.collection.curator.name, 'Asterios');
    assert.equal(r.members.length, 3);
    assert.equal(r.hasMore, false);
    const m = r.members[0];
    assert.equal(m.providerId, 'jannyai');
    assert.match(m.charId, /^[0-9a-f-]{36}$/);
    assert.ok(m.importId.startsWith(`${m.charId}_character-`));
    assert.equal(m.nsfw, true);
    assert.ok(m.tags.includes('Female'), 'emoji stripped off tags');
    assert.ok(m.tokens > 0);
    assert.ok(m.avatar.startsWith('https://image.jannyai.com/'));
});

test('janny: a full page of 250 is a sample, with no more pages', () => {
    const card = (i) => `<a data-astro-prefetch="hover" href="/characters/00000000-0000-4000-8000-${String(i).padStart(12, '0')}_character-c${i}" class="x"><h5>C${i}</h5></a>`;
    const html = `<h1>Big <span>by</span></h1>${Array.from({ length: JANNY_PAGE_SIZE }, (_, i) => card(i)).join('')}`;
    const r = parseCollectionPage(html);
    assert.equal(r.members.length, 250);
    assert.equal(r.hasMore, false, 'JannyAI ignores ?page= on a collection');
    assert.equal(r.sampled, true);
    assert.equal(parseCollectionPage(fx('janny-collection.html')).sampled, false);
});

test('janny: hostile markup cannot stall the parser', () => {
    const cases = {
        'unclosed <a': '<a '.repeat(200_000),
        'unclosed comments': '<!--'.repeat(150_000),
        'unclosed li/span in a card': `<a href="/characters/00000000-0000-4000-8000-000000000000_x">${'<li><span>'.repeat(60_000)}`,
        'endless card starts': '<div class="relative inline-flex flex-col rounded-lg"><a href="/collections/'.repeat(8_000),
    };
    for (const [name, html] of Object.entries(cases)) {
        const t = performance.now();
        parseCollectionPage(html);
        parseCollectionList(html);
        const ms = performance.now() - t;
        assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`);
    }
});

test('janny: paths stay inside /collections/', () => {
    assert.equal(jannyListPath(), '/collections/');
    assert.equal(jannyListPath({ page: 3, sort: 'popular' }), '/collections/?sort=popular&page=3');
    assert.equal(jannyCollectionPath("a0ec9071-326f-41ff-bc77-8ce8d0437fda_icedphoenix's bots/../x", { page: 2 }),
        "/collections/a0ec9071-326f-41ff-bc77-8ce8d0437fda_icedphoenix's%20bots%2F..%2Fx?page=2", 'a slash in the slug cannot climb out');
    assert.throws(() => jannyCollectionPath('../characters/x'));
    assert.equal(decodeEntities('a&#38;b&#x27;c&amp;d'), "a&b'c&d");
});

// ---------- DataCat ----------
test('datacat: feed and detail normalize', () => {
    const items = normalizeFeed(JSON.parse(fx('datacat-feed.json')));
    assert.equal(items.length, 2);
    assert.match(items[0].id, /^curation-/);
    assert.ok(items[0].covers.length > 0);
    assert.ok(items[0].url.startsWith('https://datacat.run/community/curations/'));
    const d = normalizeDetail(JSON.parse(fx('datacat-detail.json')), JSON.parse(fx('datacat-cart.json')));
    assert.equal(d.members.length, 3);
    assert.equal(d.total, 10);
    assert.equal(d.members[0].providerId, 'datacat');
    assert.equal(d.members[0].importId, d.members[0].charId);
    assert.ok(d.collection.title);
    assert.equal(d.members[0].locked, true, 'a creator who redirected downloads is locked');
    const open = normalizeDetail({}, { list: [{ characterId: 'x', name: 'Open', creator_chat_download_policy: 'allow', downloads_disabled: false }] });
    assert.equal(open.members[0].locked, false);
    const blocked = normalizeDetail({}, { list: [{ characterId: 'y', name: 'B', downloads_disabled: true }] });
    assert.equal(blocked.members[0].locked, true);
});

// ---------- registry + helpers ----------
test('registry: validates and cleans', () => {
    const reg = createRegistry();
    let told = 0;
    reg.onChange(() => told++);
    assert.throws(() => reg.add({ id: 'Bad Id', label: 'x', list() {}, get() {} }));
    assert.throws(() => reg.add({ id: 'ok', label: 'x', list() {} }), /get/);
    reg.add({ id: 'ok', label: 'OK', icon: 'javascript:alert(1)', list() {}, get() {}, owner: 'me' });
    assert.equal(reg.get('ok').icon, 'fa-layer-group', 'an icon that is not fa-* falls back');
    assert.equal(told, 1);
    assert.throws(() => reg.add({ id: 'ok', label: 'Mine now', list() {}, get() {}, owner: 'other' }), /already registered/);
    reg.add({ id: 'ok', label: 'OK 2', list() {}, get() {}, owner: 'me' });
    assert.equal(reg.get('ok').label, 'OK 2', 'the owner may replace its own source');
    reg.add({ id: 'core', label: 'Core', list() {}, get() {}, owner: 'collections' });
    assert.throws(() => reg.remove('core', { protect: 'collections' }), /built in/);
    assert.equal(reg.remove('core'), true);
    assert.equal(reg.removeOwnedBy('me'), 1);
    assert.equal(reg.list().length, 0);
    assert.equal(validateSource({ id: 'a', label: ' A ', list() {}, get() {}, sorts: [{ value: 'x', label: 'X' }] }).label, 'A');

    assert.equal(safeUrl('javascript:alert(1)'), '');
    assert.equal(safeUrl('data:text/html,x'), '');
    const m = cleanMember({ charId: 'c1', name: '<b>x</b>', avatar: 'javascript:1', url: 'https://a.b/c' }, 'p');
    assert.equal(m.providerId, 'p');
    assert.equal(m.avatar, '');
    assert.equal(m.name, '<b>x</b>', 'kept as text; the view escapes it');
    assert.equal(cleanMember({ name: 'no id' }, 'p'), null);
    assert.equal(cleanCollection({ id: 'x', covers: ['https://ok/1.png', 'javascript:x'] }).covers.length, 1);
});

test('import plan: owned members are not imported again', () => {
    const owned = ownersMap([
        { key: 'a', charId: 'L1', providerId: 'jannyai', externalId: 'a', exact: true },
        { key: 'b', charId: 'L2', providerId: 'jannyai', externalId: 'b', exact: false },
    ]);
    const members = [{ providerId: 'jannyai', charId: 'a' }, { providerId: 'jannyai', charId: 'b' }, { providerId: 'jannyai', charId: 'a' }, { providerId: 'jannyai', charId: 'c', locked: true }];
    const p = planImport(members, owned);
    assert.deepEqual(p.have, ['L1']);
    assert.deepEqual(p.locked.map(m => m.charId), ['c'], 'locked members are never imported');
    assert.deepEqual(p.toImport.map(m => m.charId), ['b'], 'a loose match is not ownership; duplicates fold');
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.equal(playlistNameFor('  Fav  ', 'JannyAI'), 'Fav (JannyAI)');
    assert.equal(playlistNameFor('Fav', 'JannyAI', 2), 'Fav (JannyAI) #2');
    const long = playlistNameFor('x'.repeat(300), 'JannyAI', 3);
    assert.ok(long.length <= 100);
    assert.ok(long.endsWith(' (JannyAI) #3'), 'the title is cut, never the suffix');
});

// ---------- in Σ ----------
const kitPath = [process.env.SIGMA_DIR && path.join(process.env.SIGMA_DIR, 'tools/extension-kit/index.mjs'),
    path.resolve(extDir, '../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    path.resolve(extDir, '../../../../../ProjectSigma-main/tools/extension-kit/index.mjs')].filter(Boolean).find(p => fs.existsSync(p));
if (kitPath && !process.env.SIGMA_DIR) process.env.SIGMA_DIR = path.resolve(path.dirname(kitPath), '../..');

// a mock DataCat
const upstream = { identify: 0, feed: 0, detail: 0, cart: 0, reject: 0, last: null };
const mock = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    upstream.last = { path: u.pathname, token: req.headers['x-session-token'] };
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && u.pathname === '/api/liberator/identify') { upstream.identify++; return json(200, { success: true, sessionToken: `tok${upstream.identify}` }); }
    if (upstream.reject > 0) { upstream.reject--; return json(401, { success: false }); }
    if (!req.headers['x-session-token']) return json(401, { success: false });
    if (u.pathname === '/api/community/curations') { upstream.feed++; return json(200, JSON.parse(fx('datacat-feed.json'))); }
    const m = /^\/api\/community\/curations\/([^/]+)(\/cart-items)?$/.exec(u.pathname);
    if (m && m[1] === 'missing') return json(404, { success: false, error: 'NOT_FOUND' });
    if (m && m[2]) { upstream.cart++; assert.equal(u.searchParams.get('limit'), '1000'); return json(200, JSON.parse(fx('datacat-cart.json'))); }
    if (m) { upstream.detail++; return json(200, JSON.parse(fx('datacat-detail.json'))); }
    json(404, {});
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
process.env.CL_ALLOW_PRIVATE_FETCH = 'true';
process.env.COLLECTIONS_DATACAT_BASE = `http://127.0.0.1:${mock.address().port}`;
after(() => mock.close());

test('in Σ: server routes, JannyAI consumer, commands and the view', { skip: !kitPath && 'no Σ checkout' }, async (t) => {
    const { startSigma } = await import(pathToFileURL(kitPath).href);
    const sigma = await startSigma({ extensions: [extDir], prefix: 'collections' });
    let page;
    try {
        await sigma.session.enable('collections', true);
        const ext = sigma.session.ext('collections');

        // the JannyAI consumer is registered with the host's browser service, locked to /collections/
        const status = await ext('/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.janny.available, true, status.body.janny.reason);
        const esc = await sigma.session.api('/provider-services/browser/fetch', 'POST', { consumer: 'jannyai-collections', path: '/collections/../characters/x', endpoint: 'http://127.0.0.1:1' });
        assert.equal(esc.status, 403, 'a ../ out of /collections/ is refused by the host');
        const out = await sigma.session.api('/provider-services/browser/fetch', 'POST', { consumer: 'jannyai-collections', path: '/characters/x', endpoint: 'http://127.0.0.1:1' });
        assert.equal(out.status, 400);

        // DataCat through the server half
        const feed = await ext('/datacat/collections');
        assert.equal(feed.status, 200, JSON.stringify(feed.body));
        assert.equal(feed.body.items.length, 2);
        assert.equal(upstream.identify, 1);
        await ext('/datacat/collections');
        assert.equal(upstream.feed, 1, 'the feed is cached');
        await ext('/datacat/collections?fresh=1');
        assert.equal(upstream.feed, 1, 'a forced refresh within 20 s still reads the cache');
        const slug = feed.body.items[0].id;
        upstream.reject = 1;
        const det = await ext(`/datacat/collections/${encodeURIComponent(slug)}`);
        assert.equal(det.status, 200, JSON.stringify(det.body));
        assert.equal(upstream.identify, 2, 'a refused token is replaced, and once only for the two parallel reads');
        assert.equal(det.body.members.length, 3);
        assert.equal((await ext('/datacat/collections/bad%20slug')).status, 400);
        assert.equal((await ext('/datacat/collections/missing')).status, 404);

        // the page: commands, a registered source, the view
        page = await sigma.session.page();
        await page.boot();
        const sources = await page.registry.runCommand('collections.list-sources');
        assert.deepEqual(sources.map(s => s.id).sort(), ['datacat', 'jannyai']);

        const calls = [];
        await page.registry.runCommand('collections.register-source', {
            id: 'mock', label: 'Mock <i>', providerId: 'mockprov', sorts: [{ value: 'a', label: 'A' }],
            async list(args) { calls.push(['list', args]); return { items: [{ id: 'c1', title: '<img src=x onerror=alert(1)>Evil', count: 2, covers: ['javascript:alert(1)'] }], hasMore: false }; },
            async get(id) { calls.push(['get', id]); return { collection: { title: 'Evil' }, members: [{ charId: 'm1', name: '<script>x</script>Mia', nsfw: true }, { charId: 'm2', name: 'Bo' }], hasMore: false }; },
        });
        assert.ok((await page.registry.runCommand('collections.list-sources')).some(s => s.id === 'mock'));
        assert.equal(globalThis.window.__SIGMA_COLLECTIONS__.apiVersion, 1);

        const views = page.host.getViews().map(v => v.name || v);
        assert.ok(views.some(v => String(v).includes('collections')), `view registered: ${JSON.stringify(views)}`);
        const el = page.dom.createElement('div');
        await page.host.enterView('ext:collections/collections', el, { first: true });
        const waitFor = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail(`timed out: ${what}`); };
        // switch to the mock source
        await waitFor(() => el.innerHTML.includes('data-act="source"'), 'tabs');
        el.querySelector('[data-act="source"][data-id="mock"]').click();
        await waitFor(() => el.innerHTML.includes('Evil'), 'mock list');
        assert.ok(!el.innerHTML.includes('<img src=x'), 'titles are escaped');
        assert.ok(!el.innerHTML.includes('javascript:'), 'unsafe cover urls are dropped');
        assert.ok(el.innerHTML.includes('Mock &lt;i&gt;'));
        await t.test('NSFW defaults to hidden and only an explicit opt-in reveals members', async () => {
            assert.equal(el.querySelector('[data-act="nsfw"]').checked, false, 'fresh installs default to SFW');
            assert.match(el.innerHTML, /Show NSFW in Collections/, 'the preference is clearly Collections-only');
            el.querySelector('[data-act="open"]').click();
            await waitFor(() => el.innerHTML.includes('Bo'), 'members');
            assert.ok(!el.innerHTML.includes('Mia'), 'NSFW members are hidden by default');
            const enableNsfw = el.querySelector('[data-act="nsfw"]');
            enableNsfw.checked = true;
            enableNsfw.dispatchEvent({ type: 'change', bubbles: true });
            await waitFor(() => el.innerHTML.includes('Mia'), 'explicit NSFW opt-in');
        });

        assert.ok(!el.innerHTML.includes('<script>'), 'member names are escaped');
        assert.ok(el.innerHTML.includes('Import all into a playlist'));
        assert.deepEqual(calls.map(c => c[0]), ['list', 'get']);

        // NSFW off hides the NSFW member
        const sw = el.querySelector('[data-act="nsfw"]');
        sw.checked = false;
        sw.dispatchEvent({ type: 'change', bubbles: true });
        await waitFor(() => !el.innerHTML.includes('Mia'), 'nsfw hidden');
        assert.ok(el.innerHTML.includes('Bo'));

        await t.test('cold preview awaits native activation and keeps Close, Import and backdrop wired once', async () => {
            // A cold provider must finish its normal view activation before openPreview.
            // Model JannyAI's init-owned modal controls; run the real registry lifecycle.
            const providers = await import(pathToFileURL(path.join(process.env.SIGMA_DIR, 'app/modules/providers/provider-registry.js')).href);
            const { BrowseView } = await import(pathToFileURL(path.join(process.env.SIGMA_DIR, 'app/modules/providers/browse-view.js')).href);
            const shell = page.dom.createElement('div');
            shell.innerHTML = '<div id="onlineCharactersPane"></div><div id="onlineCharactersFilter"></div>';
            document.body.appendChild(shell);
            const modal = page.dom.createElement('div');
            let initialized = 0, opened = 0, imported = 0, closed = 0;
            let releaseActivation;
            class ColdView extends BrowseView {
                async activate(...args) {
                    await new Promise(resolve => { releaseActivation = resolve; });
                    super.activate(...args);
                }
                renderView() { return '<div id="mockGrid"></div>'; }
                renderFilterBar() { return ''; }
                injectModals() {
                    if (this._modalsInjected) return;
                    this._modalsInjected = true;
                    modal.innerHTML = '<button data-close>Close</button><button data-import>Import</button>';
                    document.body.appendChild(modal);
                }
                init() {
                    super.init();
                    initialized++;
                    modal.querySelector('[data-close]').addEventListener('click', () => { closed++; modal.hidden = true; });
                    modal.querySelector('[data-import]').addEventListener('click', () => imported++);
                    modal.addEventListener('click', (ev) => { if (ev.target === modal) { closed++; modal.hidden = true; } });
                }
                // The mini-DOM has no scrolling/layout; neither is needed for this regression.
                _attachScrollListener() {}
                creatorDownloadEnabled() { return false; }
            }
            const browseView = new ColdView({ id: 'mockprov' });
            const provider = {
                id: 'mockprov', name: 'Mock', browseView, supportsInAppPreview: true,
                async buildPreviewObject() { return { id: 'm2', name: 'Bo' }; },
                openPreview() { opened++; modal.hidden = false; },
            };
            globalThis.window.PROVIDER_MANIFEST.mockprov = { id: 'mockprov', name: 'Mock' };
            providers.registerProvider(provider);
            globalThis.window.ProviderRegistry = providers;
            const previewButton = () => el.querySelector('[data-act="preview"][data-key="mockprov|m2"]');
            previewButton().click();
            previewButton().click();
            await waitFor(() => releaseActivation, 'provider activation started');
            assert.equal(opened, 0, 'preview waits for asynchronous provider activation');
            releaseActivation();
            await waitFor(() => opened === 1, 'cold preview');
            assert.equal(initialized, 1, 'cold preview initializes the owning provider');
            modal.querySelector('[data-import]').click();
            modal.querySelector('[data-close]').click();
            assert.equal(imported, 1, 'Import is wired by provider init');
            assert.equal(closed, 1, 'Close is wired by provider init');
            previewButton().click();
            await waitFor(() => opened === 2, 'warm preview');
            modal.click();
            assert.equal(closed, 2, 'backdrop is wired');
            modal.querySelector('[data-import]').click();
            assert.equal(imported, 2, 'no duplicate Import listeners on repeat preview');
            assert.equal(initialized, 1, 'warm preview does not repeat init');
            assert.ok(el.innerHTML.includes('Bo'), 'Collections detail is retained behind the preview');
            assert.ok(!page.log.commands.some(([name]) => name === 'view.switch'), 'preview stays on Collections, so Close returns to it');
        });

        await t.test('bulk import excludes hidden NSFW members', async () => {
            // Bulk import uses the same SFW filter as the detail.
            const importedMembers = [];
            const local = await sigma.session.importCard({ name: 'Collections SFW bulk fixture' });
            page.registry.defineCommand('character.import', async (args) => {
                importedMembers.push(args.id);
                return { success: true, id: local.id };
            });
            el.querySelector('[data-act="import-all"]').click();
            await waitFor(() => page.log.confirms.some(c => c.title === 'Import collection'), 'bulk confirmation');
            const confirm = page.log.confirms.find(c => c.title === 'Import collection');
            assert.match(confirm.message, /1 new character/);
            assert.match(confirm.message, /1 NSFW one is hidden and left out/);
            await waitFor(() => importedMembers.length > 0 && !el.querySelector('[data-coll-job]'), 'SFW bulk import finished');
            assert.deepEqual(importedMembers, ['m2'], 'hidden NSFW member is not imported');
        });

        await t.test('saved NSFW opt-in is preserved on remount', async () => {
            // Explicit saved opt-in survives a remount; no migration resets it to the new default.
            const optIn = el.querySelector('[data-act="nsfw"]');
            optIn.checked = true;
            optIn.dispatchEvent({ type: 'change', bubbles: true });
            await new Promise(r => setTimeout(r, 900));
            const { mountView } = await import('../client/view.js');
            const saved = await sigma.session.api('/settings');
            assert.equal(saved.body['ext:collections:showNsfw'], true);
            const remountRegistry = createRegistry();
            remountRegistry.add({ id: 'saved', label: 'Saved', list() { return { items: [] }; }, get() {} });
            const remountEl = page.dom.createElement('div');
            const remounted = mountView(remountEl, {
                CoreAPI: page.CoreAPI,
                settings: { get: (key) => saved.body[`ext:collections:${key}`] },
            }, remountRegistry);
            await remounted.openTarget();
            assert.equal(remountEl.querySelector('[data-act="nsfw"]').checked, true);
            remounted.dispose();
        });

        // a source cannot take over or remove a built-in one
        // (the host's command guard logs a throwing extension command and answers nothing)
        await Promise.resolve(page.registry.runCommand('collections.register-source', { id: 'datacat', label: 'Fake', owner: 'collections', list() {}, get() {} })).catch(() => {});
        await Promise.resolve(page.registry.runCommand('collections.unregister-source', { id: 'jannyai' })).catch(() => {});
        const after = await page.registry.runCommand('collections.list-sources');
        assert.equal(after.find(s => s.id === 'datacat')?.label, 'DataCat', 'the built-in DataCat source was not replaced');
        assert.ok(after.some(s => s.id === 'jannyai'), 'the built-in JannyAI source was not removed');
        assert.equal(await page.registry.runCommand('collections.unregister-source', { id: 'mock' }), true);
        // ctx.settings.set saves about half a second later; let it land before the server goes
        await new Promise(r => setTimeout(r, 900));
    } finally {
        page?.close();
        await sigma.close();
    }
});
