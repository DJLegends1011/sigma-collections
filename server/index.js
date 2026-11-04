// Collections, server half:
//  - DataCat community collections through an anonymous DataCat session (read-only, two paths).
//  - JannyAI's /collections/ pages through the Hosted Browser: registers its own browser consumer with
//    the host's browser service (an internal door until Σ gives extensions one; see README).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeFeed, normalizeDetail, DATACAT_SLUG_RE } from '../client/core/datacat-normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DATACAT_ORIGIN = 'https://datacat.run';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const FEED_TTL_MS = 5 * 60_000;
const CART_LIMIT = 1000; // DataCat's own cap for cart-items

export const JANNY_CONSUMER = 'jannyai-collections';
export const janny = { available: false, reason: 'not registered yet' };

// tests point DataCat at a mock; only honoured where the host already allows private fetches
function datacatBase() {
    const o = process.env.COLLECTIONS_DATACAT_BASE;
    return o && process.env.CL_ALLOW_PRIVATE_FETCH === 'true' ? o.replace(/\/+$/, '') : DATACAT_ORIGIN;
}

// the Σ checkout this extension runs in: walk up from here, then the working directory
export function findSigmaRoot(start = path.dirname(fileURLToPath(import.meta.url))) {
    const probe = (dir) => fs.existsSync(path.join(dir, 'server', 'services', 'browser-service.js')) && fs.existsSync(path.join(dir, 'package.json'));
    for (let dir = start, i = 0; i < 8; i++) {
        if (probe(dir)) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    const env = process.env.SIGMA_DIR;
    if (env && probe(env)) return env;
    if (probe(process.cwd())) return process.cwd();
    return null;
}

export async function registerJannyConsumer() {
    try {
        const root = findSigmaRoot();
        if (!root) throw new Error('could not find the Project Σ install');
        const mod = await import(pathToFileURL(path.join(root, 'server', 'services', 'browser-service.js')).href);
        if (typeof mod.registerBrowserConsumer !== 'function') throw new Error('this Σ version has no registerBrowserConsumer');
        mod.registerBrowserConsumer({ id: JANNY_CONSUMER, origin: 'https://jannyai.com', fetchPrefix: '/collections/', warmPath: '/collections/' });
        janny.available = true;
        janny.reason = '';
    } catch (e) {
        janny.available = false;
        janny.reason = `JannyAI collections are unavailable in this Σ version (${e.message})`;
    }
    return janny;
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

    registerJannyConsumer().then(st => { if (!st.available) console.warn(`[collections] ${st.reason}`); });

    async function dcFetch(req, pathAndQuery, retry = true) {
        let token = tokenOf.get(req);
        if (!token) token = await mintToken(req);
        const url = new URL(pathAndQuery, datacatBase() + '/');
        if (url.origin !== new URL(datacatBase()).origin) throw httpError(400, 'bad DataCat path');
        const resp = await ctx.helpers.sameHostFetch(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json', Origin: DATACAT_ORIGIN, Referer: DATACAT_ORIGIN + '/', 'X-Session-Token': token },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if ((resp.status === 401 || resp.status === 403) && retry) {
            tokenOf.clear(req);
            return dcFetch(req, pathAndQuery, false);
        }
        if (resp.status === 404) throw httpError(404, 'This DataCat collection is not available.');
        if (!resp.ok) throw httpError(502, `DataCat answered ${resp.status}`);
        return readJson(resp);
    }

    async function mintToken(req) {
        const resp = await ctx.helpers.sameHostFetch(new URL('/api/liberator/identify', datacatBase() + '/'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: DATACAT_ORIGIN, Referer: DATACAT_ORIGIN + '/' },
            body: JSON.stringify({ deviceToken: randomUUID() }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resp.ok) throw httpError(502, `DataCat refused a session (${resp.status})`);
        const data = await readJson(resp);
        if (!data?.success || typeof data.sessionToken !== 'string') throw httpError(502, 'DataCat gave no session');
        tokenOf.set(req, data.sessionToken);
        return data.sessionToken;
    }

    const send = (res, fn) => fn().then(body => res.json(body)).catch(e => {
        const code = e.statusCode || (e.name === 'TimeoutError' ? 504 : 502);
        res.status(code).json({ error: e.statusCode ? e.message : `DataCat could not be reached (${e.message})` });
    });

    router.get('/status', (req, res) => {
        res.json({ janny: { available: janny.available, reason: janny.reason, consumer: JANNY_CONSUMER } });
    });

    router.get('/datacat/collections', (req, res) => send(res, async () => {
        const key = req.userHandle || '';
        const hit = feedCache.get(key);
        if (hit && Date.now() - hit.at < FEED_TTL_MS && req.query.fresh !== '1') return { items: hit.items };
        const items = normalizeFeed(await dcFetch(req, '/api/community/curations'));
        feedCache.set(key, { at: Date.now(), items });
        return { items };
    }));

    router.get('/datacat/collections/:slug', (req, res) => send(res, async () => {
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
