// Collections, server half:
//  - DataCat community collections through an anonymous DataCat session (read-only, two paths).
//  - JannyAI's /collections/ pages through the official ctx.browser Hosted Browser consumer.
import { randomUUID } from 'node:crypto';
import { normalizeFeed, normalizeDetail, DATACAT_SLUG_RE } from '../client/core/datacat-normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DATACAT_ORIGIN = 'https://datacat.run';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const FEED_TTL_MS = 5 * 60_000;
const CART_LIMIT = 1000; // DataCat's own cap for cart-items

// tests point DataCat at a mock; only honoured where the host already allows private fetches
function datacatBase() {
    const o = process.env.COLLECTIONS_DATACAT_BASE;
    return o && process.env.CL_ALLOW_PRIVATE_FETCH === 'true' ? o.replace(/\/+$/, '') : DATACAT_ORIGIN;
}

async function readJson(resp) {
    const len = Number(resp.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw httpError(502, 'DataCat answered too much');
    const reader = resp.body?.getReader?.();
    if (!reader) return resp.json();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { try { await reader.cancel(); } catch { /* already gone */ } throw httpError(502, 'DataCat answered too much'); }
        chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

function httpError(statusCode, message) {
    const e = new Error(message);
    e.statusCode = statusCode;
    return e;
}

export function register(router, ctx) {
    const tokenOf = ctx.helpers.sessionSlot('collections-datacat');
    const feedCache = new Map(); // userHandle -> { at, items }
    const minting = new Map();   // userHandle -> the one token request in flight
    const drain = async (resp) => { try { await resp.body?.cancel(); } catch { /* already read or gone */ } };

    const janny = { available: false, reason: '', consumer: null };
    try {
        janny.consumer = ctx.browser.consumer({
            name: 'jannyai', origin: 'https://jannyai.com',
            fetchPrefix: '/collections/', warmPath: '/collections/',
        });
        janny.available = true;
    } catch (e) {
        janny.reason = `JannyAI collections are unavailable (${e.message})`;
        console.warn(`[collections] ${janny.reason}`);
    }

    async function dcFetch(req, pathAndQuery, retry = true) {
        let token = tokenOf.get(req);
        if (!token) {
            const k = req.userHandle || '';
            if (!minting.has(k)) minting.set(k, mintToken(req).finally(() => minting.delete(k)));
            token = await minting.get(k);
        }
        const url = new URL(pathAndQuery, datacatBase() + '/');
        if (url.origin !== new URL(datacatBase()).origin) throw httpError(400, 'bad DataCat path');
        const resp = await ctx.helpers.sameHostFetch(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json', Origin: DATACAT_ORIGIN, Referer: DATACAT_ORIGIN + '/', 'X-Session-Token': token },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (resp.status === 401 && retry) {
            await drain(resp);
            tokenOf.clear(req);
            return dcFetch(req, pathAndQuery, false);
        }
        if (resp.status === 404 || resp.status === 403) { await drain(resp); throw httpError(404, 'This DataCat collection is not available.'); }
        if (!resp.ok) { await drain(resp); throw httpError(502, `DataCat answered ${resp.status}`); }
        return readJson(resp);
    }

    async function mintToken(req) {
        const resp = await ctx.helpers.sameHostFetch(new URL('/api/liberator/identify', datacatBase() + '/'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: DATACAT_ORIGIN, Referer: DATACAT_ORIGIN + '/' },
            body: JSON.stringify({ deviceToken: randomUUID() }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) { await drain(resp); throw httpError(502, `DataCat refused a session (${resp.status})`); }
        const data = await readJson(resp);
        if (!data?.success || typeof data.sessionToken !== 'string') throw httpError(502, 'DataCat gave no session');
        tokenOf.set(req, data.sessionToken);
        return data.sessionToken;
    }

    const send = (req, res, fn) => fn().then(body => res.json(body)).catch(e => {
        const code = e.statusCode || (e.name === 'TimeoutError' ? 504 : 502);
        if (!e.statusCode) ctx.debugLog?.(req, 'DataCat failed:', e.message);
        res.status(code).json({ error: e.statusCode ? e.message : (code === 504 ? 'DataCat took too long to answer' : 'DataCat could not be reached') });
    });

    router.get('/status', (req, res) => {
        res.json({ janny });
    });

    router.get('/datacat/collections', (req, res) => send(req, res, async () => {
        const key = req.userHandle || '';
        const hit = feedCache.get(key);
        // a forced refresh still waits out 20 s, so the button cannot hammer DataCat
        const fresh = req.query.fresh === '1' && (!hit || Date.now() - hit.at > 20_000);
        if (hit && Date.now() - hit.at < FEED_TTL_MS && !fresh) return { items: hit.items };
        const items = normalizeFeed(await dcFetch(req, '/api/community/curations'));
        feedCache.set(key, { at: Date.now(), items });
        return { items };
    }));

    router.get('/datacat/collections/:slug', (req, res) => send(req, res, async () => {
        const slug = String(req.params.slug || '');
        if (!DATACAT_SLUG_RE.test(slug)) throw httpError(400, 'bad collection id');
        const enc = encodeURIComponent(slug);
        const [detail, cart] = await Promise.all([
            dcFetch(req, `/api/community/curations/${enc}`),
            dcFetch(req, `/api/community/curations/${enc}/cart-items?limit=${CART_LIMIT}`),
        ]);
        return normalizeDetail(detail, cart);
    }));
}
