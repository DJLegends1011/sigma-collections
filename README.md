# Collections for Project Σ

Browse curated character collections from **JannyAI** and **DataCat**, plus any provider extension that registers a source. Each collection's characters open in their own site's preview, import the usual way, and a whole collection can go into a **playlist** in one go.

## What it does

- **Collections view** (⋮ menu > Collections on a phone, the app menu on desktop). Pick a site, sort, and filter.
  - DataCat: Featured, Recently updated, Most characters, with a text filter.
  - JannyAI: Recently updated, Popular, paged like the site.
- **A collection** shows its curator, description, covers and every character, with an **In Library** badge on the ones you already have (matched by the site link Σ keeps on the character).
- **Preview** opens Σ's own preview window for that site. **Import** brings the character in through that site's importer, just like the Online tab.
- **Import all into a playlist** reads the whole collection, skips what you already own, imports the rest one by one (with a progress bar and **Stop**), then puts every character in a playlist named `<collection> (<site>)`. If that playlist already exists, the characters are added to it.
- **Creator opt-outs are respected.** DataCat characters whose creators turned downloads off show **Downloads off** and only link to the site. They are never imported.
- **Show NSFW** hides collections and characters flagged NSFW when it's switched off.

## What it needs

- **DataCat:** nothing. The server half opens an anonymous DataCat session, like Σ's own DataCat provider does, and only reads the community collections. To preview or import DataCat characters, turn the DataCat site on under **Settings > Online** (it's off by default in Σ).
- **JannyAI:** the **Hosted Browser** (Settings > Online > Hosted Browser), the same one Σ's JannyAI provider uses for character pages. JannyAI's collection pages are behind Cloudflare too.

**JannyAI's 250 limit:** a JannyAI collection page lists at most 250 characters. For a bigger collection, that's a random 250 that changes on every visit, and the site has no way to page past it. The view says so, and Import all brings in the 250 it got. Running it again later can add more of them to the same playlist.

## How the JannyAI part works (and why it might break)

Σ's Hosted Browser only lets each registered "consumer" fetch under one path on one site. The built-in `jannyai` consumer is locked to `/characters/`, and extensions have no official way to register their own yet (`browser-service.js` says extension consumers are coming "later").

Until then, this extension's server half loads Σ's internal `server/services/browser-service.js` and registers a `jannyai-collections` consumer for `https://jannyai.com/collections/`. Σ's own guards still apply: only GET/POST, the path must stay under `/collections/` (`../` escapes are refused), and on a multi-user server the managed browser stays owner-only.

If a Σ update moves that internal function, only the JannyAI source switches off ("unavailable in this Σ version"). DataCat keeps working. A feature request for an official door has been filed with the Σ developer.

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
- Everything a source returns is cleaned before it's shown: text is escaped, and only `http(s)` URLs survive.
- Other commands: `collections.unregister-source { id }`, `collections.list-sources`, `collections.open { source, id? }`.
- `window.__SIGMA_COLLECTIONS__` is a read-only mirror for the console. The commands are the API.

## Tests

```
node --test test/collections.test.mjs
```

The tests cover the JannyAI parsers (against saved real pages), DataCat normalizing and opt-outs, the source registry, the import plan, and an in-Σ run. That run uses a mock DataCat, checks the JannyAI consumer's path lock against the host's real guard, the commands, and the view with a hostile third-party source. They need a Project Σ checkout beside this folder, or `SIGMA_DIR`.
