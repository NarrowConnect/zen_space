'use strict';

/**
 * Busca de letras: LRCLib e Genius trabalhando juntos.
 *
 *   1. LRCLib /api/get     — correspondência exata (artista + música + álbum + duração), letra sincronizada
 *   2. LRCLib /api/search  — busca ampla; aceita outra versão (remaster/ao vivo) e devolve a duração dela
 *                            para o app reescalar os tempos
 *   3. Genius (busca)      — descobre o título/artista "oficial" (lida bem com feat., grafias e versões)
 *      → LRCLib de novo    — com os nomes do Genius, muitas vezes aparece a letra sincronizada
 *   4. Texto sem tempo     — LRCLib plainLyrics ou a letra do Genius; o app estima a sincronia
 *                            e o usuário calibra tocando na linha cantada
 *
 * O resultado (inclusive "não encontrado") fica no SQLite e na CDN da Vercel,
 * então cada música é buscada nas fontes externas uma única vez para todos os usuários.
 */

const cheerio = require('cheerio');

const UA = 'ZenSpace/1.0 (lyrics; +https://zen.narrowconnect.com.br)';
const TIMEOUT_MS = 6000;
const DURATION_TOLERANCE_MS = 4000;

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Remove sufixos que atrapalham a busca: "- Remastered 2011", "(feat. X)", "- Ao Vivo"... */
function cleanTrackTitle(title) {
    return String(title || '')
        .replace(/\s*[([](?:feat\.?|ft\.?|with|part\.?|participa[cç][aã]o)[^)\]]*[)\]]/gi, '')
        .replace(/\s+-\s+(?:.*\b(?:remaster(?:ed)?|remix|mix|version|vers[aã]o|edit|live|ao vivo|mono|stereo|radio|acoustic|ac[uú]stico|deluxe|bonus|single)\b.*)$/i, '')
        .replace(/\s*[([](?:.*\b(?:remaster(?:ed)?|version|vers[aã]o|edit|mono|stereo|radio|deluxe|bonus)\b.*)[)\]]/gi, '')
        .trim() || String(title || '').trim();
}

function cacheKeyFor(artist, track) {
    return `v3|${normalizeText(artist)}|${normalizeText(cleanTrackTitle(track))}`;
}

async function getJson(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/* ------------------------------------------------------------------ LRCLib */

function pickLrclibResult(results, { artist, track, durationMs }) {
    const wantedArtist = normalizeText(artist);
    const wantedTrack = normalizeText(cleanTrackTitle(track));

    const scored = (Array.isArray(results) ? results : [])
        .filter(item => !item.instrumental && (item.syncedLyrics || item.plainLyrics))
        .map(item => {
            const itemArtist = normalizeText(item.artistName);
            const itemTrack = normalizeText(cleanTrackTitle(item.trackName));
            let score = 0;
            if (itemTrack === wantedTrack) score += 6;
            else if (itemTrack.includes(wantedTrack) || wantedTrack.includes(itemTrack)) score += 3;
            if (itemArtist === wantedArtist) score += 4;
            else if (itemArtist.includes(wantedArtist) || wantedArtist.includes(itemArtist)) score += 2;
            if (item.syncedLyrics) score += 3;
            if (durationMs && item.duration) {
                const diff = Math.abs(item.duration * 1000 - durationMs);
                if (diff <= 2000) score += 4;
                else if (diff <= DURATION_TOLERANCE_MS) score += 2;
                else if (diff > 30000) score -= 3; // outra versão: ainda serve, o app reescala os tempos
            }
            return { item, score };
        })
        .filter(entry => entry.score >= 5)
        .sort((a, b) => b.score - a.score);

    return scored[0]?.item || null;
}

function fromLrclib(item, source) {
    if (!item) return null;
    const durationMs = item.duration ? Math.round(item.duration * 1000) : 0;
    if (item.syncedLyrics) return { synced: true, lyrics: item.syncedLyrics, source, durationMs };
    if (item.plainLyrics) return { synced: false, lyrics: item.plainLyrics, source, durationMs };
    return null;
}

async function fromLrclibGet({ artist, track, album, durationMs }) {
    if (!durationMs) return null; // /api/get exige duração para casar a versão certa
    const params = new URLSearchParams({
        artist_name: artist,
        track_name: cleanTrackTitle(track),
        duration: String(Math.round(durationMs / 1000))
    });
    if (album) params.set('album_name', album);
    const item = await getJson(`https://lrclib.net/api/get?${params}`);
    return item?.instrumental ? null : fromLrclib(item, 'lrclib');
}

async function fromLrclibSearch(query) {
    const params = new URLSearchParams({ artist_name: query.artist, track_name: cleanTrackTitle(query.track) });
    let results = await getJson(`https://lrclib.net/api/search?${params}`);
    let best = pickLrclibResult(results, query);
    if (!best) {
        // busca livre ajuda quando o artista está grafado diferente
        results = await getJson(`https://lrclib.net/api/search?q=${encodeURIComponent(`${query.artist} ${cleanTrackTitle(query.track)}`)}`);
        best = pickLrclibResult(results, query);
    }
    return fromLrclib(best, 'lrclib');
}

/* ------------------------------------------------------------------ Genius */

function cleanGeniusLyrics(rawLyrics) {
    return String(rawLyrics || '')
        .replace(/\r/g, '')
        .replace(/^\d+\s+Contributors[\s\S]*?Lyrics/, '')
        .replace(/^[\s\S]*?(?=\[(?:Verse|Chorus|Intro|Outro|Bridge|Hook|Pre-Chorus|Post-Chorus|Refrain|Verso|Refr[aã]o|Ponte))/i, '')
        .replace(/You might also like/gi, '')
        .replace(/Read More/gi, '')
        .replace(/\bEmbed\b.*$/gi, '')
        .replace(/\[(.+?)\]/g, '\n[$1]\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Busca no Genius e devolve o título/artista "oficial" + URL da letra. */
async function geniusSearch({ artist, track }) {
    const title = cleanTrackTitle(track);
    const payload = await getJson(`https://genius.com/api/search/song?q=${encodeURIComponent(`${artist} ${title}`)}`);
    const hits = (payload?.response?.sections || []).flatMap(section => section.hits || [])
        .filter(hit => hit.type === 'song' && hit.result?.url);

    const wantedArtist = normalizeText(artist);
    const wantedTrack = normalizeText(title);
    const best = hits
        .map(hit => {
            const hitArtist = normalizeText(hit.result.primary_artist?.name);
            const hitTrack = normalizeText(cleanTrackTitle(hit.result.title));
            let score = 0;
            if (hitArtist && (hitArtist.includes(wantedArtist) || wantedArtist.includes(hitArtist))) score += 3;
            if (hitTrack && (hitTrack.includes(wantedTrack) || wantedTrack.includes(hitTrack))) score += 4;
            if (/\b(traduc|translation|tradução|romaniz)/i.test(hit.result.title || '')) score -= 5; // evita traduções
            return { hit, score };
        })
        .filter(entry => entry.score >= 4) // evita letra de outra música
        .sort((a, b) => b.score - a.score)[0]?.hit;
    if (!best) return null;
    return {
        url: best.result.url,
        title: cleanTrackTitle(best.result.title),
        artist: best.result.primary_artist?.name || artist
    };
}

async function geniusLyrics(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;

    const $ = cheerio.load(await response.text());
    $('[data-lyrics-container="true"] br').replaceWith('\n'); // preserva quebras de linha
    $('[data-exclude-from-selection="true"]').remove();       // remove cabeçalhos/anúncios
    const text = $('[data-lyrics-container="true"]').map((_, el) => $(el).text()).get().join('\n');
    const lyrics = cleanGeniusLyrics(text);
    return lyrics ? { synced: false, lyrics, source: 'genius' } : null;
}

/* ------------------------------------------------------------------ cascata */

async function attempt(label, fn) {
    try {
        return { value: await fn(), failed: false };
    } catch (error) {
        console.warn(`[lyrics] ${label} falhou:`, error.message);
        return { value: null, failed: true };
    }
}

async function findLyrics(query) {
    let hadError = false;
    let plain = null;
    const consider = ({ value, failed }) => {
        hadError = hadError || failed;
        if (value && !value.synced && !plain) plain = value;
        return value?.synced ? value : null;
    };

    // 1-2) LRCLib direto
    const exact = consider(await attempt('lrclib get', () => fromLrclibGet(query)));
    if (exact) return exact;
    const searched = consider(await attempt('lrclib search', () => fromLrclibSearch(query)));
    if (searched) return searched;

    // 3) Genius descobre o nome oficial → pergunta de novo ao LRCLib
    const geniusHit = await attempt('genius search', () => geniusSearch(query));
    hadError = hadError || geniusHit.failed;
    const canonical = geniusHit.value;
    if (canonical) {
        const sameName = normalizeText(canonical.title) === normalizeText(cleanTrackTitle(query.track))
            && normalizeText(canonical.artist) === normalizeText(query.artist);
        if (!sameName) {
            const viaGenius = consider(await attempt('lrclib via genius', () => fromLrclibSearch({
                ...query, artist: canonical.artist, track: canonical.title
            })));
            if (viaGenius) return { ...viaGenius, matchedVia: 'genius' };
        }
    }

    // 4) Texto sem tempo: LRCLib primeiro (já veio), senão a letra do Genius
    if (plain) return plain;
    if (canonical?.url) {
        const text = await attempt('genius lyrics', () => geniusLyrics(canonical.url));
        hadError = hadError || text.failed;
        if (text.value) return text.value;
    }

    // "Não encontrado" só é definitivo se nenhuma fonte deu erro (senão tentamos de novo depois)
    return { notFound: true, transient: hadError };
}

module.exports = { findLyrics, cacheKeyFor, cleanTrackTitle, normalizeText };
