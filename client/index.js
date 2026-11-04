// Collections: a hub for curated character collections across sites.
//
// API for other extensions (Σ-native: commands + an event):
//   ctx.commands.run('collections.register-source', spec)   -> the source id (see client/core/sources.js for spec)
//   ctx.commands.run('collections.unregister-source', { id }) -> boolean
//   ctx.commands.run('collections.list-sources')              -> [{ id, label, icon, providerId }]
//   ctx.commands.run('collections.open', { source, id? })     -> opens the view (on a collection when id is given)
//   ctx.events.on('ext:collections:ready', ...)                -> fired when the hub is up (register then, if you loaded first)
// window.__SIGMA_COLLECTIONS__ mirrors the read-only parts for console use; the commands are the API.
import { createRegistry } from './core/sources.js';
import { datacatSource, jannySource } from './sources/builtin.js';
import { mountView } from './view.js';

const VIEW = 'ext:collections/collections';
let registry = null;
let view = null;

export default {
    init(ctx) {
        registry = createRegistry();
        registry.add(datacatSource(ctx));
        registry.add(jannySource(ctx));

        // a caller's own word for owner is namespaced, so no one can pass as the hub and replace a built-in source
        ctx.commands.register('register-source', (spec) => registry.add({ ...(spec || {}), owner: `ext:${String(spec?.owner || 'unknown').slice(0, 60)}` }), { title: 'Collections: register a collection source' });
        ctx.commands.register('unregister-source', ({ id } = {}) => registry.remove(String(id || ''), { protect: 'collections' }), { title: 'Collections: remove a collection source' });
        ctx.commands.register('list-sources', () => registry.list().map(s => ({ id: s.id, label: s.label, icon: s.icon, providerId: s.providerId })), { title: 'Collections: list sources' });

        let pendingOpen = null;
        ctx.commands.register('open', async ({ source, id } = {}) => {
            pendingOpen = { source: source ? String(source) : null, id: id ? String(id) : null };
            await ctx.commands.run('view.switch', { view: VIEW });
            if (view) { view.openTarget(pendingOpen); pendingOpen = null; }
            return true;
        }, { title: 'Open Collections' });

        ctx.ui.contribute('app.action', {
            id: 'collections',
            label: 'Collections',
            icon: 'fa-layer-group',
            when: ({ view: v } = {}) => v !== VIEW,
            run: () => ctx.commands.run('view.switch', { view: VIEW }),
        });

        ctx.ui.contribute('shell.view', {
            id: 'collections',
            label: 'Collections',
            icon: 'fa-layer-group',
            render(el) {
                view = mountView(el, ctx, registry);
                if (pendingOpen) { view.openTarget(pendingOpen); pendingOpen = null; }
            },
            enter: () => view?.enter(),
            leave: () => view?.leave(),
            refresh: () => view?.refresh(),
        });

        window.__SIGMA_COLLECTIONS__ = Object.freeze({
            apiVersion: 1,
            sources: () => registry.list().map(s => ({ id: s.id, label: s.label, providerId: s.providerId })),
            commands: Object.freeze(['collections.register-source', 'collections.unregister-source', 'collections.list-sources', 'collections.open']),
        });

        ctx.events.emit('ready', { apiVersion: 1 });
    },

    dispose() {
        view?.dispose();
        view = null;
        delete window.__SIGMA_COLLECTIONS__;
        registry = null;
    },
};
