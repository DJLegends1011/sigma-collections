// The source registry: pure, no DOM, no host. A source is how one site's collections are listed and opened.
// Shape (what collections.register-source takes):
//   { id, label, icon?, providerId?, sorts?: [{ value, label }], search?: boolean,
//     list({ page, sort, query }) -> { items: CollectionItem[], hasMore, totalPages? },
//     get(collectionId, { page }) -> { collection: CollectionItem, members: Member[], hasMore, note? (shown above the members) },
//     available?() -> true | string (a reason it cannot run right now) }
// CollectionItem: { id, title, description?, curator?: { name, url?, avatar? }, count?, covers?: string[],
//                   nsfw?, updatedAt?, url? }
// Member: { providerId, charId, importId?, name, creator?, avatar?, nsfw?, tags?: string[], url?, tokens?,
//          locked?: boolean (the creator opted out: no preview/import, the site link only), lockReason? }

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function validateSource(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('a source is an object');
    if (!SOURCE_ID_RE.test(String(spec.id || ''))) throw new Error(`source id must match ${SOURCE_ID_RE}`);
    if (typeof spec.label !== 'string' || !spec.label.trim()) throw new Error(`source ${spec.id}: label is required`);
    if (typeof spec.list !== 'function') throw new Error(`source ${spec.id}: list() is required`);
    if (typeof spec.get !== 'function') throw new Error(`source ${spec.id}: get() is required`);
    if (spec.available !== undefined && typeof spec.available !== 'function') throw new Error(`source ${spec.id}: available must be a function`);
    if (spec.sorts !== undefined && !(Array.isArray(spec.sorts) && spec.sorts.every(s => s && typeof s.value === 'string' && typeof s.label === 'string'))) {
        throw new Error(`source ${spec.id}: sorts is [{ value, label }]`);
    }
    return Object.freeze({
        id: spec.id,
        label: spec.label.trim().slice(0, 40),
        icon: typeof spec.icon === 'string' && /^fa-[a-z0-9-]+$/.test(spec.icon) ? spec.icon : 'fa-layer-group',
        providerId: typeof spec.providerId === 'string' ? spec.providerId : null,
        sorts: Object.freeze((spec.sorts || []).map(s => Object.freeze({ value: s.value, label: s.label }))),
        search: spec.search === true,
        owner: typeof spec.owner === 'string' ? spec.owner : null,
        list: spec.list,
        get: spec.get,
        available: spec.available || (() => true),
    });
}

export function createRegistry() {
    const sources = new Map();
    const listeners = new Set();
    const tell = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener's fault stays its own */ } } };
    return {
        add(spec) {
            const s = validateSource(spec);
            const had = sources.get(s.id);
            // a source belongs to whoever registered it first: no one else replaces it
            if (had && had.owner !== s.owner) throw new Error(`source "${s.id}" is already registered by ${had.owner || 'another extension'}`);
            sources.set(s.id, s);
            tell();
            return s.id;
        },
        remove(id, { protect = null } = {}) {
            const s = sources.get(id);
            if (!s) return false;
            if (protect && s.owner === protect) throw new Error(`source "${id}" is built in and cannot be removed`);
            sources.delete(id);
            tell();
            return true;
        },
        removeOwnedBy(owner) {
            let n = 0;
            for (const [id, s] of sources) if (s.owner === owner) { sources.delete(id); n++; }
            if (n) tell();
            return n;
        },
        get: (id) => sources.get(id) || null,
        list: () => [...sources.values()],
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
}

// a member as the hub keeps it: every field a string or a small array, nothing a source can smuggle markup in through
export function cleanMember(m, fallbackProvider = null) {
    if (!m || typeof m !== 'object') return null;
    const charId = String(m.charId ?? '').trim();
    const providerId = String(m.providerId ?? fallbackProvider ?? '').trim();
    if (!charId || !providerId) return null;
    return {
        providerId,
        charId,
        importId: String(m.importId ?? charId),
        name: String(m.name ?? '').trim() || 'Unknown',
        creator: m.creator ? String(m.creator) : '',
        avatar: safeUrl(m.avatar),
        nsfw: m.nsfw === true,
        tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 12) : [],
        url: safeUrl(m.url),
        tokens: Number.isFinite(m.tokens) ? m.tokens : null,
        locked: m.locked === true,
        lockReason: m.locked === true ? String(m.lockReason || 'This character cannot be imported') : '',
    };
}

export function cleanCollection(c) {
    if (!c || typeof c !== 'object') return null;
    const id = String(c.id ?? '').trim();
    if (!id) return null;
    const curator = c.curator && typeof c.curator === 'object'
        ? { name: String(c.curator.name ?? ''), url: safeUrl(c.curator.url), avatar: safeUrl(c.curator.avatar) }
        : null;
    return {
        id,
        title: String(c.title ?? '').trim() || 'Untitled collection',
        description: String(c.description ?? '').trim(),
        curator,
        count: Number.isFinite(c.count) ? c.count : null,
        covers: Array.isArray(c.covers) ? c.covers.map(safeUrl).filter(Boolean).slice(0, 5) : [],
        nsfw: c.nsfw === true,
        updatedAt: c.updatedAt ? String(c.updatedAt) : '',
        url: safeUrl(c.url),
    };
}

// only http(s) urls survive; anything else (javascript:, data:) is dropped
export function safeUrl(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
        const p = new URL(u);
        return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : '';
    } catch { return ''; }
}
