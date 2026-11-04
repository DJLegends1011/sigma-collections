// The Collections view: pick a source, browse its collections, open one, preview / import its members,
// or import the whole collection into a playlist.
import CoreAPI from '/modules/core-api.js';
import { cleanCollection, cleanMember } from './core/sources.js';
import { ownersMap, planImport, chunk, playlistNameFor, collectionKey } from './core/import-plan.js';

const MEMBER_BATCH = 60;
const PROBE_CHUNK = 500;

export function mountView(el, ctx, registry) {
    const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));
    const toast = (msg, type = 'info') => CoreAPI.showToast?.(msg, type);

    const st = {
        sourceId: ctx.settings.get('lastSource') || '',
        sort: '',
        query: '',
        page: 1,
        totalPages: 1,
        items: [],
        listLoading: false,
        listError: '',
        detail: null,      // { source, id, collection, members, page, hasMore, shown, loading, error }
        owned: new Map(),  // providerId|charId -> local char id
        job: null,         // { total, done, failed, cancelled, label }
        token: 0,
    };

    el.innerHTML = `<div class="coll" data-coll-root></div>`;
    const root = el.querySelector('[data-coll-root]');

    const sources = () => registry.list();
    const source = () => registry.get(st.sourceId) || sources()[0] || null;
    const showNsfw = () => ctx.settings.get('showNsfw') !== false;

    // ---------- data ----------
    async function loadList({ fresh = false } = {}) {
        const s = source();
        if (!s) return paint();
        st.sourceId = s.id;
        if (!st.sort || !s.sorts.some(x => x.value === st.sort)) st.sort = s.sorts[0]?.value || '';
        const my = ++st.token;
        st.listLoading = true;
        st.listError = '';
        paint();
        try {
            const r = await s.list({ page: st.page, sort: st.sort, query: st.query, fresh });
            if (my !== st.token) return;
            st.items = (r?.items || []).map(cleanCollection).filter(Boolean);
            st.totalPages = Number.isFinite(r?.totalPages) ? r.totalPages : (r?.hasMore ? st.page + 1 : st.page);
            st.listedPage = st.page;
        } catch (e) {
            if (my !== st.token) return;
            st.items = [];
            st.listError = e?.message || String(e);
        } finally {
            // a superseded load still lets go of the flag, or the pager stays disabled for good
            st.listLoading = false;
        }
        paint();
    }

    async function openCollection(sourceId, id, seed = null) {
        const s = registry.get(sourceId);
        if (!s) return toast(`No collection source "${sourceId}"`, 'error');
        const my = ++st.token;
        st.detail = { source: s, id, collection: seed, members: [], page: 1, hasMore: false, shown: MEMBER_BATCH, loading: true, error: '' };
        paint();
        el.scrollTop = 0;
        try {
            const r = await s.get(id, { page: 1 });
            if (my !== st.token || st.detail?.id !== id) return;
            const fresh = cleanCollection({ id, ...(r.collection || {}) }) || {};
            const merged = { ...(seed || {}) };
            // the collection's own page may say less than its list card did: keep the card's covers, url, count
            for (const [k, v] of Object.entries(fresh)) {
                const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
                if (!empty || !(k in merged)) merged[k] = v;
            }
            merged.count = [r.total, fresh.count, seed?.count].find(Number.isFinite) ?? null;
            Object.assign(st.detail, {
                collection: merged,
                members: (r.members || []).map(m => cleanMember(m, s.providerId)).filter(Boolean),
                hasMore: !!r.hasMore,
                note: typeof r.note === 'string' ? r.note.slice(0, 300) : '',
                loading: false,
            });
            await probeOwned(st.detail.members);
        } catch (e) {
            if (my !== st.token) return;
            st.detail.loading = false;
            st.detail.error = e?.message || String(e);
        }
        paint();
    }

    async function loadMoreMembers() {
        const d = st.detail;
        if (!d || d.loading || !d.hasMore) return false;
        d.loading = true;
        paint();
        try {
            const r = await d.source.get(d.id, { page: d.page + 1 });
            const more = (r.members || []).map(m => cleanMember(m, d.source.providerId)).filter(Boolean);
            const known = new Set(d.members.map(m => `${m.providerId}|${m.charId}`));
            const fresh = more.filter(m => !known.has(`${m.providerId}|${m.charId}`));
            d.members.push(...fresh);
            d.page += 1;
            d.hasMore = !!r.hasMore && fresh.length > 0;
            await probeOwned(fresh);
        } catch (e) {
            toast(e?.message || String(e), 'error');
            d.hasMore = false;
        }
        d.loading = false;
        paint();
        return true;
    }

    // which members are already in the library, by their provider link
    async function probeOwned(members) {
        const byProvider = new Map();
        for (const m of members) {
            if (!byProvider.has(m.providerId)) byProvider.set(m.providerId, []);
            byProvider.get(m.providerId).push(m.charId);
        }
        for (const [provider, keys] of byProvider) {
            for (const part of chunk(keys, PROBE_CHUNK)) {
                try {
                    const resp = await CoreAPI.apiRequest('/provider-links/probe', 'POST', { providers: [provider], keys: part, owners: true });
                    const body = await CoreAPI.readAnswer(resp);
                    for (const [k, v] of ownersMap(body?.owners)) st.owned.set(k, v);
                } catch { /* badges are a hint; a failed probe just shows none */ }
            }
        }
    }

    // ---------- actions ----------
    function providerFor(m) {
        const p = CoreAPI.getProvider?.(m.providerId);
        const off = (CoreAPI.getSetting?.('disabledProviders') || []).includes(m.providerId);
        return p && !off ? p : null;
    }

    async function preview(m) {
        if (m.locked) { if (m.url) window.open(m.url, '_blank', 'noopener'); return; }
        const p = providerFor(m);
        if (!p || !p.supportsInAppPreview) {
            if (m.url) window.open(m.url, '_blank', 'noopener');
            if (!p) toast(`Turn on the ${m.providerId} site under Settings > Online to preview in the app; opened it on the site instead.`, 'info');
            return;
        }
        try {
            const obj = await p.buildPreviewObject({ name: m.name, data: {} }, { id: m.charId, fullPath: m.importId });
            if (!obj) throw new Error('not found on the site');
            p.browseView?.injectModals?.();
            p.openPreview(obj);
        } catch (e) {
            toast(`Could not preview "${m.name}": ${e?.message || e}`, 'error');
        }
    }

    async function importOne(m, { quiet = false } = {}) {
        if (m.locked) throw new Error(m.lockReason);
        if (!providerFor(m)) throw new Error(`the ${m.providerId} site is switched off under Settings > Online`);
        const r = await ctx.commands.run('character.import', { provider: m.providerId, id: m.importId });
        if (!r?.success) throw new Error(r?.error || 'import failed');
        if (r.id) st.owned.set(`${m.providerId}|${m.charId}`, r.id);
        if (!quiet) toast(r.alreadyPresent ? `"${m.name}" is already in your library` : `Imported "${m.name}"`, r.alreadyPresent ? 'info' : 'success');
        return r;
    }

    // one playlist per collection: remembered by collection, so two collections that share a title never
    // share a playlist, and a playlist of the user's own with that name is never touched
    async function ensurePlaylist(key, title, sourceLabel, description) {
        const doc = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/playlists'));
        const lists = doc?.playlists || {}; // keyed by id; the entries carry no id of their own
        const memo = (await ctx.storage.load().catch(() => null)) || {};
        const known = memo.playlists?.[key];
        if (known && lists[known]) return { id: known, name: lists[known].name };
        const taken = new Set(Object.values(lists).map(p => String(p?.name || '').trim().toLowerCase()));
        let n = 1;
        let name = playlistNameFor(title, sourceLabel, n);
        while (taken.has(name.toLowerCase()) && n < 50) name = playlistNameFor(title, sourceLabel, ++n);
        const made = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/playlists', 'POST', { name, description, icon: 'fa-solid fa-layer-group' }));
        const id = made?.id || Object.entries((await CoreAPI.readAnswer(await CoreAPI.apiRequest('/playlists')))?.playlists || {}).find(([, p]) => p?.name === name)?.[0];
        if (!id) throw new Error('the playlist was not created');
        memo.playlists = { ...(memo.playlists || {}), [key]: id };
        await ctx.storage.save(memo).catch(() => {});
        return { id, name };
    }

    async function importAll() {
        const d = st.detail;
        if (!d || st.job) return;
        // every page first, so the playlist holds the whole collection
        const job = st.job = { total: 0, done: 0, failed: 0, cancelled: false, label: 'Reading the whole collection…', detail: d };
        paint();
        while (d.hasMore && !job.cancelled) await loadMoreMembers();
        if (job.cancelled || st.job !== job) { if (st.job === job) st.job = null; return paint(); }
        // what the reader sees is what comes in: hidden NSFW members stay out
        const shown = showNsfw() ? d.members : d.members.filter(m => !m.nsfw);
        const hiddenNsfw = d.members.length - shown.length;
        const { toImport: wanted, have, locked } = planImport(shown, st.owned);
        // each member goes through its own site's importer; one whose site is off is skipped, by name
        const offSites = [...new Set(wanted.filter(m => !providerFor(m)).map(m => m.providerId))];
        const toImport = wanted.filter(m => providerFor(m));
        if (!toImport.length && !have.length) {
            st.job = null;
            paint();
            const why = offSites.length ? `turn on ${offSites.join(', ')} under Settings > Online first` : locked.length ? 'every creator in this collection turned downloads off' : 'there are no characters to import';
            return toast(`Nothing to import: ${why}.`, 'info');
        }
        const extra = [
            locked.length ? `${locked.length} whose creators turned downloads off are skipped.` : '',
            offSites.length ? `${wanted.length - toImport.length} from ${offSites.join(', ')} are skipped (that site is off under Settings > Online).` : '',
            hiddenNsfw ? `${hiddenNsfw} NSFW ${hiddenNsfw === 1 ? 'one is' : 'ones are'} hidden and left out.` : '',
            d.note || '',
        ].filter(Boolean).join(' ');
        const ok = await CoreAPI.showConfirm?.({
            title: 'Import collection',
            message: `Import ${toImport.length} new character${toImport.length === 1 ? '' : 's'} (${have.length} already in your library) and put all ${toImport.length + have.length} in this collection's playlist?${extra ? ` ${extra}` : ''}`,
            confirmLabel: 'Import all',
            cancelLabel: 'Cancel',
        });
        if (ok !== true || job.cancelled) { if (st.job === job) st.job = null; return paint(); }
        const ids = [...have];
        Object.assign(job, { total: toImport.length, done: 0, label: 'Importing…' });
        paint();
        for (const m of toImport) {
            if (job.cancelled) break;
            try {
                const r = await importOne(m, { quiet: true });
                if (r.id) ids.push(r.id);
            } catch { job.failed += 1; }
            job.done += 1;
            paintJob();
        }
        if (job.disposed) return;
        try {
            if (ids.length) {
                const pl = await ensurePlaylist(collectionKey(d.source.id, d.id), d.collection?.title, d.source.label, `${d.source.label} collection: ${d.collection?.url || d.id}`);
                for (const part of chunk([...new Set(ids)], 5000)) {
                    await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/playlists/${encodeURIComponent(pl.id)}/members/apply`, 'POST', { add: part }));
                }
                toast(`${job.cancelled ? 'Stopped. ' : ''}${ids.length} character${ids.length === 1 ? '' : 's'} in "${pl.name}"${job.failed ? `, ${job.failed} failed` : ''}.`, job.failed ? 'warning' : 'success');
            } else {
                toast(`${job.cancelled ? 'Stopped. ' : ''}Nothing came in${job.failed ? `: ${job.failed} failed` : ''}.`, 'warning');
            }
        } catch (e) {
            toast(`The playlist could not be filled: ${e?.message || e}`, 'error');
        }
        if (st.job === job) st.job = null;
        paint();
    }

    // ---------- paint ----------
    function paint() {
        root.innerHTML = st.detail ? detailHtml() : listHtml();
        for (const sel of root.querySelectorAll('select')) CoreAPI.initCustomSelect?.(sel);
    }

    // the progress box only: a full repaint per member would wipe whatever the reader is typing
    function paintJob() {
        const box = root.querySelector('[data-coll-job]');
        if (box) box.outerHTML = jobHtml();
    }

    function headerHtml() {
        const s = source();
        const tabs = sources().map(x => {
            let why;
            try { why = x.available(); } catch (e) { why = e?.message || 'unavailable'; }
            return `<button type="button" class="coll-tab${x.id === s?.id ? ' is-on' : ''}" data-act="source" data-id="${esc(x.id)}" ${why !== true ? `title="${esc(why)}"` : ''}>
                <i class="fa-solid ${esc(x.icon)}" aria-hidden="true"></i> ${esc(x.label)}</button>`;
        }).join('');
        const sorts = s?.sorts?.length ? `<select class="glass-select coll-sort" data-act="sort" aria-label="Sort">${s.sorts.map(o => `<option value="${esc(o.value)}"${o.value === st.sort ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : '';
        const search = s?.search ? `<form class="coll-search" data-act="search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" class="glass-input" name="q" value="${esc(st.query)}" placeholder="Filter collections" autocomplete="off"></form>` : '';
        return `<header class="coll-head">
            <h2 class="coll-title"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> Collections</h2>
            <div class="coll-tabs" role="tablist">${tabs}</div>
            <div class="coll-bar">${search}${sorts}
                <label class="coll-switch"><input type="checkbox" class="cl-switch-input" data-act="nsfw"${showNsfw() ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span><span>Show NSFW</span></label>
                <button type="button" class="cl-btn coll-icon-btn" data-act="refresh" title="Refresh"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button>
            </div>
        </header>`;
    }

    function coversHtml(covers) {
        if (!covers?.length) return '<div class="coll-covers is-empty"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></div>';
        return `<div class="coll-covers">${covers.slice(0, 5).map(u => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`;
    }

    function listHtml() {
        const s = source();
        if (!s) return `${headerHtml()}<p class="coll-dim">No collection sources yet.</p>`;
        let body;
        if (st.listLoading && !st.items.length) body = '<div class="coll-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading collections…</div>';
        else if (st.listError) body = `<div class="coll-card coll-error"><p>${esc(st.listError)}</p><button type="button" class="cl-btn" data-act="refresh">Try again</button></div>`;
        else {
            const items = st.items.filter(c => showNsfw() || !c.nsfw);
            body = items.length ? `<div class="coll-grid">${items.map(c => `
                <button type="button" class="coll-card coll-item" data-act="open" data-id="${esc(c.id)}">
                    ${coversHtml(c.covers)}
                    <span class="coll-item-title">${esc(c.title)}</span>
                    <span class="coll-item-meta">
                        ${c.count != null ? `<span><i class="fa-solid fa-user" aria-hidden="true"></i> ${esc(c.count)}</span>` : ''}
                        ${c.curator?.name ? `<span>by ${esc(c.curator.name)}</span>` : ''}
                        ${c.nsfw ? '<span class="coll-pill is-nsfw">NSFW</span>' : ''}
                    </span>
                    ${c.description && c.description !== c.title ? `<span class="coll-item-desc">${esc(c.description)}</span>` : ''}
                </button>`).join('')}</div>` : '<p class="coll-dim">Nothing here.</p>';
        }
        const pager = st.totalPages > 1 ? `<nav class="coll-pager">
            <button type="button" class="cl-btn" data-act="page" data-dir="-1"${st.page <= 1 || st.listLoading ? ' disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <span>Page ${esc(st.page)} of ${esc(st.totalPages)}</span>
            <button type="button" class="cl-btn" data-act="page" data-dir="1"${st.page >= st.totalPages || st.listLoading ? ' disabled' : ''}><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
        </nav>` : '';
        return `${headerHtml()}${body}${pager}`;
    }

    function jobHtml() {
        const j = st.job;
        if (!j) return '';
        const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
        return `<div class="coll-card coll-job" data-coll-job>
            <div class="coll-job-row"><span>${esc(j.label)} ${j.total ? `${esc(j.done)} / ${esc(j.total)}` : ''}${j.failed ? ` · ${esc(j.failed)} failed` : ''}</span>
            <button type="button" class="cl-btn" data-act="cancel"${j.cancelled ? ' disabled' : ''}>${j.cancelled ? 'Stopping…' : 'Stop'}</button></div>
            <div class="coll-progress"><span style="width:${pct}%"></span></div>
        </div>`;
    }

    function memberHtml(m) {
        const owned = st.owned.has(`${m.providerId}|${m.charId}`);
        const key = esc(`${m.providerId}|${m.charId}`);
        if (m.locked && !owned) {
            return `<div class="coll-card coll-member is-locked" title="${esc(m.lockReason)}">
            <button type="button" class="coll-member-pic" data-act="preview" data-key="${key}" title="Open on the site">
                ${m.avatar ? `<img src="${esc(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-user" aria-hidden="true"></i>'}
                <span class="coll-pill is-locked"><i class="fa-solid fa-lock" aria-hidden="true"></i> Downloads off</span>
            </button>
            <div class="coll-member-body">
                <span class="coll-member-name" title="${esc(m.name)}">${esc(m.name)}</span>
                <span class="coll-item-meta">${m.creator ? `<span>${esc(m.creator)}</span>` : ''}${m.nsfw ? '<span class="coll-pill is-nsfw">NSFW</span>' : ''}</span>
                <div class="coll-member-acts">
                    ${m.url ? `<a class="cl-btn" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open on site</a>` : ''}
                </div>
            </div>
        </div>`;
        }
        return `<div class="coll-card coll-member${m.nsfw ? ' is-nsfw' : ''}">
            <button type="button" class="coll-member-pic" data-act="preview" data-key="${esc(`${m.providerId}|${m.charId}`)}" title="Preview">
                ${m.avatar ? `<img src="${esc(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="fa-solid fa-user" aria-hidden="true"></i>'}
                ${owned ? '<span class="coll-pill is-owned"><i class="fa-solid fa-check" aria-hidden="true"></i> In Library</span>' : ''}
            </button>
            <div class="coll-member-body">
                <span class="coll-member-name" title="${esc(m.name)}">${esc(m.name)}</span>
                <span class="coll-item-meta">${m.creator ? `<span>${esc(m.creator)}</span>` : ''}${m.tokens ? `<span>${esc(m.tokens)} tok</span>` : ''}${m.nsfw ? '<span class="coll-pill is-nsfw">NSFW</span>' : ''}</span>
                <div class="coll-member-acts">
                    <button type="button" class="cl-btn" data-act="preview" data-key="${esc(`${m.providerId}|${m.charId}`)}"><i class="fa-solid fa-eye" aria-hidden="true"></i> Preview</button>
                    <button type="button" class="cl-btn${owned ? '' : ' cl-btn-primary'}" data-act="import" data-key="${key}"${owned || importing.has(`${m.providerId}|${m.charId}`) || st.job ? ' disabled' : ''}><i class="fa-solid fa-download" aria-hidden="true"></i> ${owned ? 'Imported' : importing.has(`${m.providerId}|${m.charId}`) ? 'Importing…' : 'Import'}</button>
                </div>
            </div>
        </div>`;
    }

    function detailHtml() {
        const d = st.detail;
        const c = d.collection || {};
        const visible = d.members.filter(m => showNsfw() || !m.nsfw);
        const ownedCount = d.members.filter(m => st.owned.has(`${m.providerId}|${m.charId}`)).length;
        const head = `<header class="coll-head">
            <button type="button" class="cl-btn coll-back" data-act="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${esc(d.source.label)} collections</button>
            <div class="coll-detail-head">
                ${coversHtml(c.covers)}
                <div class="coll-detail-text">
                    <h2 class="coll-title">${esc(c.title || 'Collection')}</h2>
                    <span class="coll-item-meta">
                        ${c.curator?.name ? `<span>by ${c.curator.url ? `<a href="${esc(c.curator.url)}" target="_blank" rel="noopener noreferrer">${esc(c.curator.name)}</a>` : esc(c.curator.name)}</span>` : ''}
                        ${c.count != null ? `<span>${esc(c.count)} characters</span>` : ''}
                        <span>${esc(ownedCount)} in your library</span>
                        ${c.updatedAt ? `<span>updated ${esc(String(c.updatedAt).slice(0, 10))}</span>` : ''}
                    </span>
                    ${c.description && c.description !== c.title ? `<p class="coll-detail-desc">${esc(c.description)}</p>` : ''}
                </div>
            </div>
            <div class="coll-bar">
                <button type="button" class="cl-btn cl-btn-primary" data-act="import-all"${st.job || d.loading ? ' disabled' : ''}><i class="fa-solid fa-list-check" aria-hidden="true"></i> Import all into a playlist</button>
                ${c.url ? `<a class="cl-btn" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open on ${esc(d.source.label)}</a>` : ''}
                <label class="coll-switch"><input type="checkbox" class="cl-switch-input" data-act="nsfw"${showNsfw() ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span><span>Show NSFW</span></label>
            </div>
            ${d.note ? `<p class="coll-card coll-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${esc(d.note)}</p>` : ''}
            ${jobHtml()}
        </header>`;
        if (d.error) return `${head}<div class="coll-card coll-error"><p>${esc(d.error)}</p><button type="button" class="cl-btn" data-act="reopen">Try again</button></div>`;
        if (d.loading && !d.members.length) return `${head}<div class="coll-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading characters…</div>`;
        const shown = visible.slice(0, d.shown);
        const more = visible.length > d.shown || d.hasMore;
        return `${head}<div class="coll-members">${shown.map(memberHtml).join('') || '<p class="coll-dim">No characters to show.</p>'}</div>
            ${more ? `<div class="coll-more"><button type="button" class="cl-btn" data-act="more"${d.loading ? ' disabled' : ''}>${d.loading ? 'Loading…' : 'Show more'}</button></div>` : ''}`;
    }

    // ---------- events ----------
    const importing = new Set(); // member keys with a single import in flight
    const memberByKey = (key) => st.detail?.members.find(m => `${m.providerId}|${m.charId}` === key) || null;

    root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b || !root.contains(b) || b.tagName === 'SELECT' || b.tagName === 'FORM' || b.type === 'checkbox') return;
        const act = b.dataset.act;
        // an import-all in flight owns the view until it ends or is stopped
        if (st.job && ['source', 'refresh', 'page', 'open', 'back', 'reopen'].includes(act)) {
            return toast('Stop the collection import first, or let it finish.', 'info');
        }
        if (act === 'source') {
            st.sourceId = b.dataset.id;
            ctx.settings.set('lastSource', st.sourceId);
            Object.assign(st, { page: 1, query: '', sort: '', items: [], detail: null });
            return loadList();
        }
        if (act === 'refresh') return st.detail ? openCollection(st.detail.source.id, st.detail.id, st.detail.collection) : loadList({ fresh: true });
        if (act === 'page') { st.page = Math.max(1, Math.min(st.totalPages, st.page + Number(b.dataset.dir))); el.scrollTop = 0; return loadList(); }
        if (act === 'open') {
            const seed = st.items.find(c => c.id === b.dataset.id) || null;
            return openCollection(source().id, b.dataset.id, seed);
        }
        if (act === 'back') { st.token++; st.detail = null; return st.items.length && st.listedPage === st.page ? paint() : loadList(); }
        if (act === 'reopen') return openCollection(st.detail.source.id, st.detail.id, st.detail.collection);
        if (act === 'more') {
            const d = st.detail;
            const visible = d.members.filter(m => showNsfw() || !m.nsfw).length;
            if (d.shown < visible) { d.shown += MEMBER_BATCH; return paint(); }
            d.shown += MEMBER_BATCH;
            return loadMoreMembers();
        }
        if (act === 'preview') { const m = memberByKey(b.dataset.key); if (m) return preview(m); return; }
        if (act === 'import') {
            const m = memberByKey(b.dataset.key);
            if (!m || importing.has(b.dataset.key)) return;
            importing.add(b.dataset.key);
            paint();
            try { await importOne(m); } catch (e) { toast(`Could not import "${m.name}": ${e?.message || e}`, 'error'); }
            importing.delete(b.dataset.key);
            return paint();
        }
        if (act === 'import-all') return importAll();
        if (act === 'cancel' && st.job) { st.job.cancelled = true; return paintJob(); }
    });

    root.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.matches?.('[data-act="sort"]')) { st.sort = t.value; st.page = 1; return loadList(); }
        if (t.matches?.('[data-act="nsfw"]')) { ctx.settings.set('showNsfw', !!t.checked); return paint(); }
    });

    root.addEventListener('submit', (ev) => {
        const f = ev.target.closest?.('[data-act="search"]');
        if (!f) return;
        ev.preventDefault();
        st.query = String(f.querySelector('input[name="q"]')?.value || '');
        st.page = 1;
        loadList();
    });

    const offSources = registry.onChange(() => { if (!st.detail) paint(); });
    let entered = false;

    return {
        enter() {
            if (!entered) { entered = true; if (!st.items.length && !st.detail) loadList(); }
        },
        leave() { /* state is kept for the next visit */ },
        refresh() { return st.detail ? openCollection(st.detail.source.id, st.detail.id, st.detail.collection) : loadList({ fresh: true }); },
        openTarget({ source: sid, id } = {}) {
            if (sid && registry.get(sid)) { st.sourceId = sid; Object.assign(st, { page: 1, query: '', sort: '', items: [] }); }
            const s = registry.get(st.sourceId) || source();
            if (!s) return paint();
            if (id) return openCollection(s.id, id);
            st.detail = null;
            return loadList();
        },
        dispose() {
            if (st.job) { st.job.cancelled = true; st.job.disposed = true; }
            st.token++;
            offSources();
        },
        _state: st,
    };
}
