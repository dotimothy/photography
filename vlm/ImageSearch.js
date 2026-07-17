/** Build-time metadata search with explicit, on-demand VLM recommendations. */

const DEFAULT_SITE_ROOT = new URL('../', import.meta.url);

export const PORTFOLIO_GALLERIES = ['astronomy', 'food', 'landscape', 'planes', 'wildlife'];

const RECOMMENDATION_SYSTEM_PROMPT =
    'You rank photography search recommendations. Judge only the supplied image, search request, and verified metadata. ' +
    'Do not invent identity, location, or camera settings. Return JSON only.';

function encodeName(name) {
    return String(name).split('/').map(encodeURIComponent).join('/');
}

function portfolioRootUrl(baseUrl = DEFAULT_SITE_ROOT) {
    const root = new URL(baseUrl);
    const marker = '/portfolios/';
    const markerAt = root.pathname.indexOf(marker);
    if (markerAt !== -1) root.pathname = root.pathname.slice(0, markerAt + 1);
    else {
        root.pathname = root.pathname.replace(/[^/]*$/, '');
        if (root.pathname.endsWith('/vlm/')) root.pathname = root.pathname.slice(0, -4);
    }
    root.search = '';
    root.hash = '';
    return root;
}

function hydrateInventoryRecord(record, root) {
    const filename = record.filename ?? (/\.[a-z0-9]+$/i.test(record.name) ? record.name : `${record.name}.jpg`);
    return {
        ...record,
        filename,
        metadata: record.metadata ?? {},
        source: record.source ?? 'metadata',
        thumbUrl: new URL(`portfolios/${record.gallery}/thumbs/480/${encodeName(filename)}`, root).href,
        fullUrl: new URL(`portfolios/${record.gallery}/fulls/${encodeName(filename)}`, root).href,
    };
}

export async function loadPortfolioInventory(baseUrl = DEFAULT_SITE_ROOT) {
    const base = portfolioRootUrl(baseUrl);
    const inventories = await Promise.all(PORTFOLIO_GALLERIES.map(async gallery => {
        const metaUrl = new URL(`portfolios/${gallery}/metadata/metadata.json`, base);
        const response = await fetch(metaUrl);
        if (!response.ok) throw new Error(`${gallery} metadata: HTTP ${response.status}`);
        const metadata = await response.json();
        return (metadata.image_order ?? []).map(name => {
            const filename = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.jpg`;
            return {
                id: `${gallery}/${name}`,
                gallery,
                name,
                filename,
                metadata: metadata[name] ?? {},
                thumbUrl: new URL(`portfolios/${gallery}/thumbs/480/${encodeName(filename)}`, base).href,
                fullUrl: new URL(`portfolios/${gallery}/fulls/${encodeName(filename)}`, base).href,
            };
        });
    }));
    return inventories.flat();
}

/** Load the metadata-only index emitted by the site build.
 * Falls back to the per-gallery metadata files for local development and old builds.
 */
export async function loadBuildSearchIndex(baseUrl = DEFAULT_SITE_ROOT) {
    const root = portfolioRootUrl(baseUrl);
    try {
        const response = await fetch(new URL('assets/search-index.json', root));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.records)) throw new Error('Invalid metadata index');
        return payload.records.map(record => hydrateInventoryRecord(record, root));
    } catch (_) {
        return loadPortfolioInventory(root);
    }
}

/** Return the complete metadata baseline. No model or browser database is touched. */
export async function loadSearchRecords(baseUrl = DEFAULT_SITE_ROOT) {
    const records = await loadBuildSearchIndex(baseUrl);
    return { records, inventory: records };
}

function parseJsonObject(text) {
    const raw = String(text ?? '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(fenced.slice(start, end + 1)); } catch (_) { /* use fallback below */ }
    }
    return null;
}

export function parseVLMRecommendation(text) {
    const raw = String(text ?? '').trim();
    const data = parseJsonObject(raw);
    const rawScore = Number(data?.score);
    return {
        score: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0,
        reason: String(data?.reason ?? raw.replace(/```/g, '')).trim().slice(0, 240),
        parseFallback: !data,
    };
}

function metadataText(metadata = {}) {
    return Object.entries(metadata)
        .filter(([key, value]) => !key.startsWith('__') && value != null && typeof value !== 'object')
        .map(([key, value]) => `${key} ${value}`)
        .join(' ');
}

export function normalizeSearchText(text) {
    return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9./]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenScore(haystack, token) {
    if (!token) return 0;
    if (haystack.includes(` ${token} `) || haystack.startsWith(`${token} `) || haystack.endsWith(` ${token}`) || haystack === token) return 3;
    if (token.length >= 4 && haystack.includes(token)) return 1;
    return 0;
}

export function rankImageRecords(records, query, { gallery = null, limit = 48 } = {}) {
    const normalized = normalizeSearchText(query);
    const tokens = [...new Set(normalized.split(' ').filter(Boolean))];
    if (!tokens.length) return [];
    return records
        .filter(record => !gallery || record.gallery === gallery)
        .map(record => {
            const strong = normalizeSearchText([...(record.subjects ?? []), ...(record.scene ?? []), ...(record.tags ?? []), ...(record.visibleText ?? [])].join(' '));
            const medium = normalizeSearchText([record.caption, ...(record.colors ?? []), ...(record.mood ?? []), ...(record.composition ?? [])].join(' '));
            const weak = normalizeSearchText([record.gallery, record.name, metadataText(record.metadata)].join(' '));
            let score = strong.includes(normalized) ? 18 : medium.includes(normalized) ? 12 : weak.includes(normalized) ? 8 : 0;
            let matched = 0;
            for (const token of tokens) {
                const value = tokenScore(strong, token) * 4 + tokenScore(medium, token) * 2 + tokenScore(weak, token);
                if (value) matched++;
                score += value;
            }
            if (matched === tokens.length) score += 6;
            return { record, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.record.gallery.localeCompare(b.record.gallery) || a.record.name.localeCompare(b.record.name))
        .slice(0, limit);
}

function blobToDataUrl(blob, maxDim = 512) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const scale = Math.min(1, maxDim / img.naturalWidth, maxDim / img.naturalHeight);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            } catch (error) { reject(error); }
            finally { URL.revokeObjectURL(objectUrl); }
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image decode failed')); };
        img.src = objectUrl;
    });
}

function queryManager(manager, imageSrc, prompt, signal) {
    return new Promise((resolve, reject) => {
        manager.query(imageSrc, prompt, [], {
            signal,
            systemPrompt: RECOMMENDATION_SYSTEM_PROMPT,
            onDone: text => signal?.aborted ? reject(new DOMException('Aborted', 'AbortError')) : resolve(text),
            onError: message => signal?.aborted
                ? reject(new DOMException('Aborted', 'AbortError'))
                : reject(new Error(message)),
        });
    });
}

function recommendationPrompt(query, record) {
    const metadata = metadataText(record.metadata).slice(0, 2200) || 'No additional metadata';
    return `The user searched for: "${String(query).slice(0, 300)}"

This image was shortlisted by deterministic metadata search.
Gallery: ${record.gallery}
File: ${record.name}
Verified metadata: ${metadata}

Inspect the image and rate how strongly it satisfies the user's request. Return exactly:
{"score":0-100,"reason":"one concise factual reason"}
Use a high score only when the visible image clearly matches. Do not guess facts not shown or present in metadata.`;
}

/**
 * Visually rerank a small metadata shortlist. This is explicit, ephemeral, and
 * never writes an index or analyzes photos outside the supplied candidates.
 */
export async function recommendImageRecords(manager, query, rankedCandidates, {
    limit = 6,
    signal = null,
    onProgress = () => {},
} = {}) {
    if (!manager?.isReady) throw new Error('The selected VLM is not ready.');
    const candidates = (rankedCandidates ?? []).slice(0, Math.max(1, limit));
    const recommendations = [];

    for (let index = 0; index < candidates.length; index++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const candidate = candidates[index];
        const record = candidate.record ?? candidate;
        onProgress({ stage: 'loading', record, completed: index, total: candidates.length });
        try {
            const response = await fetch(record.thumbUrl, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const imageSrc = await blobToDataUrl(await response.blob());
            onProgress({ stage: 'analyzing', record, completed: index, total: candidates.length });
            const assessment = parseVLMRecommendation(await queryManager(
                manager,
                imageSrc,
                recommendationPrompt(query, record),
                signal,
            ));
            recommendations.push({
                record,
                score: assessment.score,
                reason: assessment.reason,
                metadataScore: Number(candidate.score) || 0,
            });
            onProgress({ stage: 'complete', record, completed: index + 1, total: candidates.length });
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            onProgress({ stage: 'error', record, completed: index + 1, total: candidates.length, error });
        }
    }

    return recommendations.sort((a, b) =>
        b.score - a.score || b.metadataScore - a.metadataScore || a.record.id.localeCompare(b.record.id));
}
