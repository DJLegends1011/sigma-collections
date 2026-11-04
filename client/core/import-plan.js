// Pure helpers for "Import all into a playlist": what to import, what is already owned, how to chunk.

// owners rows from /api/provider-links/probe (owners: true) → Map providerId|charId → localCharId
export function ownersMap(rows) {
    const map = new Map();
    for (const r of rows || []) {
        if (!r?.exact) continue;
        for (const key of [r.externalId, r.key]) if (key) map.set(`${r.providerId}|${key}`, r.charId);
    }
    return map;
}

export function planImport(members, owned) {
    const toImport = [];
    const have = [];
    const locked = [];
    const seen = new Set();
    for (const m of members) {
        const k = `${m.providerId}|${m.charId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const local = owned.get(k);
        if (local) have.push(local);
        else if (m.locked) locked.push(m);
        else toImport.push(m);
    }
    return { toImport, have, locked };
}

export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

// a playlist name Σ accepts, from a collection title
export function playlistNameFor(title, sourceLabel) {
    const base = String(title || '').replace(/\s+/g, ' ').trim() || 'Collection';
    return `${base} (${sourceLabel})`.slice(0, 100);
}
