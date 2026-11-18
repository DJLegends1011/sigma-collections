# Collections for Project Σ

Browse curated character collections from **JannyAI** and **DataCat**, plus any provider extension that registers a source. Each collection's characters open in their own site's preview, import the usual way, and a whole collection can go into a **playlist** in one go.

## What it does

- **Collections view** (⋮ menu > Collections on a phone, the app menu on desktop). Pick a site, sort, and filter.
  - DataCat: Featured, Recently updated, Most characters, with a text filter.
  - JannyAI: Recently updated, Popular, paged like the site.
- **A collection** shows its curator, description, covers and every character, with an **In Library** badge on the ones you already have (matched by the site link Σ keeps on the character).
- **Preview** opens Σ's own preview window for that site. **Import** brings the character in through that site's importer, just like the Online tab.
- **Import all into a playlist** reads the whole collection, skips what you already own, imports the rest one by one (with a progress bar and **Stop**), then puts every character in the collection's own playlist, named `<collection> (<site>)`.
  - Running it again later reuses that same playlist and only brings in what's new.
  - A playlist of yours that happens to have the same name is never touched; the new one gets a `#2`.
  - With **Show NSFW** off, hidden NSFW characters are left out of the import too.
  - Characters whose site is switched off under Settings > Online are skipped by name.
- **Creator opt-outs are respected.** DataCat characters whose creators turned downloads off show **Downloads off** and only link to the site. They are never imported.
- **Show NSFW** hides collections and characters flagged NSFW when it's switched off. JannyAI's collection list carries no NSFW flag, so there it only applies to the characters inside a collection.

## What it needs

- **DataCat:** nothing. The server half opens an anonymous DataCat session, like Σ's own DataCat provider does, and only reads the community collections. To preview or import DataCat characters, turn the DataCat site on under **Settings > Online** (it's off by default in Σ).
- **JannyAI:** the **Hosted Browser** (Settings > Online > Hosted Browser), the same one Σ's JannyAI provider uses for character pages. JannyAI's collection pages are behind Cloudflare too.

**JannyAI's 250 limit:** a JannyAI collection page lists at most 250 characters. For a bigger collection, that's a random 250 that changes on every visit, and the site has no way to page past it. The view says so, and Import all brings in the 250 it got. Running it again later can add more of them to the same playlist.

## What it reads, writes and sends

- **Reads:** public collection lists, collection pages and member metadata from JannyAI and DataCat; local provider-link ownership, provider availability/settings and playlists to show badges, preview members and avoid duplicate imports.
- **Writes locally:** Collections' per-user NSFW/source preferences and collection-to-playlist mapping in its own settings/storage. On your import action, Σ's provider importer writes characters to your library, and Collections creates/reuses its own playlist and adds members. Browsing alone does not import characters or change playlists.
- **Sends:** the server opens an anonymous session at `https://datacat.run/api/liberator/identify` with a random device token, then sends that session token when reading `/api/community/curations` and collection detail/cart-items there. The Hosted Browser sends collection-page requests (including its site cookies/Cloudflare clearance) only under `https://jannyai.com/collections/`. Cover/avatar images load from the image URLs supplied by those sites; preview/import uses the selected site's native Σ provider. No chats, prompts or local character contents are sent by Collections. Third-party sources you register use their own transports.

## How the JannyAI part works

Requires **Project Σ 1.1.3 / extension API 2.7**. The server registers `ctx.browser.consumer({ name: 'jannyai', origin: 'https://jannyai.com', fetchPrefix: '/collections/', warmPath: '/collections/' })`; the client calls `ctx.browser.fetch('jannyai', path, { headers: { Accept: 'text/html' } })`. The host scopes that bare name to `collections:jannyai`. No internal browser module is loaded.

Σ's guards keep fetches on that origin under `/collections/` (including normalized `../` escape checks), and the consumer is available only while the server half is running and the requesting account has Collections enabled. The managed browser remains owner-only on shared servers. Cloudflare failures and rate limits are shown as errors, with Retry-After when supplied; requests are not automatically retried. If consumer registration fails, JannyAI is marked unavailable while DataCat keeps working.

Preview still has a guarded, undocumented dependency on `window.ProviderRegistry`: there is no public command that awaits a provider's character-view initialization. A cold preview rebuilds the native Online pane DOM, resetting the previous provider's search/scroll on its next Online visit, and fires one initial browse request. Warm previews skip activation. If the user switches to Online during activation, Collections does not deactivate the now-visible native view.

## For extension developers: add your own source

The API is Σ commands, plus one event for load order:

```js
// in your extension's client init(ctx)
const spec = {
    id: 'charavault',                 // [a-z0-9-], unique
    label: 'CharaVault',
    icon: 'fa-vault',                 // a Font Awesome solid name
    providerId: 'charavault',         // the Σ provider that previews/imports members
    sorts: [{ value: 'new', label: 'Newest' }],
    search: false,                    // true shows a filter box and passes { query }
    async list({ page, sort, query }) {
        return { items: [{ id, title, description, curator: { name, url, avatar }, count, covers: [url], nsfw, updatedAt, url }], hasMore, totalPages };
    },
    async get(collectionId, { page }) {
        return { collection: { title, ... }, members: [{ providerId, charId, importId, name, creator, avatar, nsfw, tags, tokens, url, locked, lockReason }], hasMore };
    },
};
const add = () => ctx.commands.run('collections.register-source', spec);
try { await add(); } catch { ctx.events.on('ext:collections:ready', add); }   // the hub may load after you
```

- `importId` is what `character.import { provider, id }` takes for your provider. It defaults to `charId`.
- A source id belongs to whoever registered it first. You can't replace or remove another extension's source, or the built-in DataCat and JannyAI ones.
- Unregister your source in your own `dispose()`.
- Everything a source returns is cleaned before it's shown: text is escaped, and only `http(s)` URLs survive.
- Other commands: `collections.unregister-source { id }`, `collections.list-sources`, `collections.open { source, id? }`.

## Tests

```
node --test test/collections.test.mjs
```

The tests cover the JannyAI parsers (against saved real pages), DataCat normalizing and opt-outs, the source registry, the import plan, and an in-Σ run. That run uses a mock DataCat, checks the JannyAI consumer's path lock against the host's real guard, the commands, and the view with a hostile third-party source. They need a Project Σ checkout beside this folder, or `SIGMA_DIR`.
