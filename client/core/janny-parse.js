// JannyAI's collection pages, read as text: the list (/collections/?sort=&page=) and one collection
// (/collections/<uuid>_<slug>?page=). Pure string work so the server-free tests and the page agree.

const ORIGIN = 'https://jannyai.com';
// a collection page lists at most this many characters, a random sample of a bigger collection, with no paging
// (?page= is ignored: the same 250, reshuffled), so the site itself shows no more than this
export const JANNY_PAGE_SIZE = 250;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// an href's slug, entities decoded, any query or fragment cut (an entity like &#x27; carries a #, so decode first)
const cutQuery = (raw) => decodeEntities(raw).split(/[?#]/)[0];
const stripComments = (h) => String(h || '').replace(/<!--[\s\S]*?-->/g, '');
const text = (h) => decodeEntities(String(h || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const abs = (u) => {
    const v = decodeEntities(String(u || '').trim());
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    return v.startsWith('/') ? ORIGIN + v : '';
};
const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
    return m ? m[1] : '';
};

// "Favoritas  (2671 characters)" → { title, count }
function splitTitle(raw) {
    const t = text(raw);
    const m = /\(\s*(\d[\d,]*)\s*characters?\s*\)\s*$/i.exec(t);
    return m ? { title: t.slice(0, m.index).trim(), count: parseInt(m[1].replace(/,/g, ''), 10) } : { title: t, count: null };
}

// cut a page into the blocks that each start where the start pattern matches
function blocks(html, startRe) {
    const out = [];
    const starts = [];
    const re = new RegExp(startRe.source, 'g' + startRe.flags.replace('g', ''));
    let m;
    while ((m = re.exec(html))) starts.push(m.index);
    for (let i = 0; i < starts.length; i++) out.push(html.slice(starts[i], starts[i + 1] ?? html.length));
    return out;
}

export function parseCollectionList(html) {
    const h = stripComments(html);
    const items = [];
    const seen = new Set();
    for (const card of blocks(h, /<div class="relative inline-flex flex-col rounded-lg/)) {
        const link = new RegExp(`<a[^>]*href="/collections/(${UUID})_([^"]*)"[^>]*>([\\s\\S]*?)</a>`, 'i').exec(card);
        if (!link) continue;
        const [, id, slugRaw, inner] = link;
        const slug = cutQuery(slugRaw);
        if (seen.has(id)) continue;
        seen.add(id);
        const { title, count } = splitTitle(inner);
        const updated = /Last updated:\s*([0-9/]+)/i.exec(text(card));
        const descM = /<p class="mt-4[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card);
        const covers = [...card.matchAll(/<img[^>]*class="h-14 w-14[^"]*"[^>]*>/gi)].map(m => abs(attr(m[0], 'src'))).filter(Boolean).slice(0, 5);
        const cur = /<a[^>]*href="\/collectors\/([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(card);
        const curAvatar = /<img[^>]*class="h-6 w-6 rounded-full"[^>]*>/i.exec(card);
        const views = /<strong>\s*([\d,]+)\s*<\/strong>\s*views/i.exec(card);
        items.push({
            id: `${id}_${slug}`,
            title,
            description: descM ? text(descM[1]) : '',
            count,
            covers,
            curator: cur ? { name: text(cur[2]), url: abs(`/collectors/${encodeURIComponent(decodeEntities(cur[1]).trim())}`), avatar: curAvatar ? abs(attr(curAvatar[0], 'src')) : '' } : null,
            updatedAt: updated ? updated[1] : '',
            views: views ? parseInt(views[1].replace(/,/g, ''), 10) : null,
            url: `${ORIGIN}/collections/${id}_${encodeURIComponent(slug)}`,
        });
    }
    // the pager's highest page number
    let totalPages = 1;
    for (const m of h.matchAll(/href="(\/collections\/?\?[^"]*)"/g)) {
        const pm = /[?&]page=(\d+)/.exec(decodeEntities(m[1]));
        if (pm) totalPages = Math.max(totalPages, parseInt(pm[1], 10));
    }
    return { items, totalPages };
}

export function parseCollectionPage(html) {
    const h = stripComments(html);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h);
    let title = '';
    let curator = null;
    if (h1) {
        const before = h1[1].split(/<span/i)[0];
        title = text(before);
        const cur = /<a[^>]*href="\/collectors\/([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(h1[1]);
        const av = /<img[^>]*src="([^"]*)"/i.exec(h1[1]);
        if (cur) curator = { name: text(cur[2]), url: abs(`/collectors/${encodeURIComponent(decodeEntities(cur[1]).trim())}`), avatar: av ? abs(av[1]) : '' };
    }
    const updated = /Last updated:\s*([0-9/]+)/i.exec(text(h.slice(h1?.index ?? 0, (h1?.index ?? 0) + 4000)));
    const descM = /<div class="markdown[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(h);
    const members = [];
    const seen = new Set();
    for (const card of blocks(h, new RegExp(`<a[^>]*href="/characters/${UUID}_`, 'i'))) {
        const head = new RegExp(`^<a[^>]*href="/characters/(${UUID})_([^"]*)"`, 'i').exec(card);
        if (!head) continue;
        const [, id, slugRaw] = head;
        if (seen.has(id)) continue;
        seen.add(id);
        const body = card.split(/<\/a>/i)[0];
        const img = /<img[^>]*src="(https:\/\/image\.jannyai\.com\/[^"]*)"[^>]*>/i.exec(body);
        const alt = img ? decodeEntities(attr(img[0], 'alt')).replace(/^Avatar of\s+/i, '') : '';
        const h5 = /<h5[^>]*>([\s\S]*?)<\/h5>/i.exec(body);
        const tok = /Token:\s*(\d+)\s*\/\s*(\d+)/i.exec(body);
        const tags = [...body.matchAll(/<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/gi)].map(m => text(m[1]));
        const slug = cutQuery(slugRaw);
        members.push({
            providerId: 'jannyai',
            charId: id,
            importId: `${id}_${slug}`,
            name: (h5 ? text(h5[1]) : '') || alt || slug.replace(/^character-/, '').replace(/-/g, ' '),
            avatar: img ? img[1] : '',
            nsfw: tags.some(t => /\bNSFW\b/i.test(t)),
            tags: tags.map(t => t.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean),
            tokens: tok ? parseInt(tok[2], 10) : null,
            url: `${ORIGIN}/characters/${id}_${encodeURIComponent(slug)}`,
        });
    }
    return {
        collection: { title, curator, description: descM ? text(descM[1]) : '', updatedAt: updated ? updated[1] : '' },
        members,
        hasMore: false,
        sampled: members.length >= JANNY_PAGE_SIZE,
    };
}

// the path the hosted browser fetches: inside /collections/, the slug percent-encoded
export function jannyListPath({ page = 1, sort = 'new' } = {}) {
    const q = new URLSearchParams();
    if (sort && sort !== 'new') q.set('sort', sort);
    if (page > 1) q.set('page', String(page));
    const qs = q.toString();
    return `/collections/${qs ? `?${qs}` : ''}`;
}

export function jannyCollectionPath(collectionId, { page = 1 } = {}) {
    const m = new RegExp(`^(${UUID})_(.*)$`, 'i').exec(String(collectionId || ''));
    if (!m) throw new Error('a JannyAI collection id is <uuid>_<slug>');
    return `/collections/${m[1]}_${encodeURIComponent(m[2])}${page > 1 ? `?page=${page}` : ''}`;
}
