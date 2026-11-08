// The two sources the hub ships with. Each talks to its site the way Σ already does: DataCat through this
// extension's server half, JannyAI through the Hosted Browser (consumer registered by the server half).
import { parseCollectionList, parseCollectionPage, jannyListPath, jannyCollectionPath } from '../core/janny-parse.js';

export function datacatSource(ctx) {
    let feed = null;
    return {
        id: 'datacat',
        label: 'DataCat',
        icon: 'fa-cat',
        providerId: 'datacat',
        owner: 'collections',
        sorts: [
            { value: 'featured', label: 'Featured' },
            { value: 'updated', label: 'Recently updated' },
            { value: 'size', label: 'Most characters' },
        ],
        search: true,
        async list({ page = 1, sort = 'featured', query = '', fresh = false } = {}) {
            if (!feed || fresh || page === 1) feed = (await ctx.server.call(`/datacat/collections${fresh ? '?fresh=1' : ''}`)).items || [];
            let items = feed.slice();
            const q = query.trim().toLowerCase();
            if (q) items = items.filter(c => `${c.title} ${c.description} ${c.curator?.name || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q));
            if (sort === 'updated') items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            else if (sort === 'size') items.sort((a, b) => (b.count || 0) - (a.count || 0));
            const per = 24;
            const totalPages = Math.max(1, Math.ceil(items.length / per));
            return { items: items.slice((page - 1) * per, page * per), hasMore: page < totalPages, totalPages };
        },
        async get(id) {
            const r = await ctx.server.call(`/datacat/collections/${encodeURIComponent(id)}`);
            return { collection: r.collection, members: r.members || [], hasMore: false, total: r.total };
        },
    };
}

export function jannySource(ctx) {
    let status = null;
    const ensure = async () => {
        if (!status) status = (await ctx.server.call('/status')).janny;
        if (!status.available) throw new Error(status.reason || 'JannyAI collections are unavailable');
    };
    const fetchPage = async (p) => {
        await ensure();
        const r = await ctx.browser.fetch('jannyai', p, { headers: { Accept: 'text/html' } });
        if (r.status === 403 || /<title>Just a moment/i.test(r.body || '')) {
            throw new Error('JannyAI is behind Cloudflare and the Hosted Browser did not get through. Check it under Settings > Online > Hosted Browser.');
        }
        if (r.status === 404) throw new Error('This JannyAI collection is not available.');
        if (r.status === 429) throw new Error(`JannyAI is rate limiting requests.${r.retryAfter ? ` Retry-After: ${r.retryAfter}.` : ' Try again later.'}`);
        if (r.status < 200 || r.status >= 300) throw new Error(`JannyAI answered ${r.status || 'nothing'}`);
        return r.body || '';
    };
    return {
        id: 'jannyai',
        label: 'JannyAI',
        icon: 'fa-broom',
        providerId: 'jannyai',
        owner: 'collections',
        sorts: [
            { value: 'new', label: 'Recently updated' },
            { value: 'popular', label: 'Popular' },
        ],
        search: false,
        available() {
            return status && !status.available ? (status.reason || 'unavailable') : true;
        },
        async list({ page = 1, sort = 'new' } = {}) {
            const { items, totalPages } = parseCollectionList(await fetchPage(jannyListPath({ page, sort })));
            return { items, hasMore: page < totalPages, totalPages };
        },
        async get(id) {
            const r = parseCollectionPage(await fetchPage(jannyCollectionPath(id)));
            return {
                collection: { id, ...r.collection }, members: r.members, hasMore: false,
                note: r.sampled ? `JannyAI only shows a random ${r.members.length} characters of a collection this big; refreshing shows a different set.` : '',
            };
        },
        async probe() { status = null; await ensure().catch(() => {}); return status; },
    };
}
