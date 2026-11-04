// DataCat community collections ("curations"), normalized for the hub. Shared by the server half.
const ORIGIN = 'https://datacat.run';

export const DATACAT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,159}$/i;

export function normalizeCuration(c) {
    if (!c || typeof c !== 'object' || !c.slug) return null;
    return {
        id: String(c.slug),
        title: String(c.title || ''),
        description: String(c.description || ''),
        count: Number.isFinite(c.characterCount) ? c.characterCount : null,
        covers: (Array.isArray(c.covers) ? c.covers : []).map(x => x?.avatar).filter(u => typeof u === 'string'),
        curator: c.curator ? {
            name: String(c.curator.displayName || c.curator.username || ''),
            url: c.curator.userUuid ? `${ORIGIN}/user/${encodeURIComponent(c.curator.userUuid)}` : '',
            avatar: typeof c.curator.profileAvatarUrl === 'string' ? c.curator.profileAvatarUrl : '',
        } : null,
        nsfw: c.containsMatureContent === true,
        updatedAt: String(c.updatedAt || c.createdAt || ''),
        tags: (Array.isArray(c.tags) ? c.tags : []).map(t => typeof t === 'string' ? t : t?.name).filter(Boolean).slice(0, 12),
        url: `${ORIGIN}/community/curations/${encodeURIComponent(c.slug)}`,
    };
}

export function normalizeCartItem(m) {
    if (!m || typeof m !== 'object' || !m.characterId) return null;
    const tags = [...(Array.isArray(m.tags) ? m.tags : []), ...(Array.isArray(m.customTags) ? m.customTags : [])]
        .map(t => typeof t === 'string' ? t : t?.name).filter(Boolean)
        .map(t => String(t).replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
    const avatar = m.avatarVariantUrls?.card || m.avatarDisplayUrl || m.avatar || '';
    // the creator turned chats/downloads off on DataCat: respect it, link to the site instead
    const policy = String(m.creator_chat_download_policy || '');
    const locked = m.downloads_disabled === true || policy === 'block' || policy === 'redirect';
    return {
        providerId: 'datacat',
        charId: String(m.characterId),
        importId: String(m.characterId),
        name: String(m.name || ''),
        creator: String(m.creatorName || ''),
        avatar: typeof avatar === 'string' ? avatar : '',
        nsfw: m.isNsfw === true,
        tags: [...new Set(tags)].slice(0, 12),
        tokens: Number.isFinite(m.totalTokens) ? m.totalTokens : null,
        url: `${ORIGIN}/characters/${encodeURIComponent(m.characterId)}`,
        locked,
        lockReason: locked ? 'The creator turned downloads off on DataCat' : '',
    };
}

export function normalizeFeed(body) {
    const list = Array.isArray(body?.curations) ? body.curations : [];
    return list.map(normalizeCuration).filter(Boolean);
}

export function normalizeDetail(detail, cart) {
    const collection = normalizeCuration(detail?.curation) || null;
    const members = (Array.isArray(cart?.list) ? cart.list : []).map(normalizeCartItem).filter(Boolean);
    return { collection, members, total: Number.isFinite(cart?.total) ? cart.total : members.length };
}
