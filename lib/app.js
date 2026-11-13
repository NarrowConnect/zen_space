'use strict';

const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const db = require('./db');
const auth = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FETCH_TIMEOUT_MS = 8000;
const SPACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Só estas chaves do localStorage são sincronizadas (tokens do Spotify ficam só no navegador).
const SYNC_KEYS = new Set(['zen-theme', 'zen-username', 'zen-todos', 'zen-notebook-note', 'spotify-queue']);

/* ------------------------------------------------------------------ utils */

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanGeniusLyrics(rawLyrics) {
    return String(rawLyrics || '')
        .replace(/\r/g, '')
        .replace(/^\d+\s+Contributors[\s\S]*?Lyrics/, '')
        .replace(/^[\s\S]*?(?=\[(?:Verse|Chorus|Intro|Outro|Bridge|Hook|Pre-Chorus|Post-Chorus|Refrain))/i, '')
        .replace(/You might also like/gi, '')
        .replace(/Read More/gi, '')
        .replace(/\bEmbed\b.*$/gi, '')
        .replace(/\[(.+?)\]/g, '\n[$1]\n')
        .replace(/([a-z])([A-Z])/g, '$1\n$2')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function scoreSongHit(hit, artist, track) {
    const normalizedArtist = normalizeText(artist);
    const normalizedTrack = normalizeText(track);
    const hitArtist = normalizeText(hit.result?.primary_artist?.name);
    const hitTrack = normalizeText(hit.result?.title);

    let score = 0;
    if (hitArtist && (hitArtist.includes(normalizedArtist) || normalizedArtist.includes(hitArtist))) score += 3;
    if (hitTrack && (hitTrack.includes(normalizedTrack) || normalizedTrack.includes(hitTrack))) score += 4;
    if (`${hitArtist} ${hitTrack}`.includes(`${normalizedArtist} ${normalizedTrack}`)) score += 2;
    return score;
}

async function fetchWithTimeout(url, accept) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 ZenSpace Lyrics Proxy', Accept: accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response;
}

async function searchGeniusSong(artist, track) {
    const url = `https://genius.com/api/search/song?q=${encodeURIComponent(`${artist} ${track}`)}`;
    const payload = await (await fetchWithTimeout(url, 'application/json,text/plain,*/*')).json();
    const hits = (payload.response?.sections || []).flatMap(section => section.hits || []);
    const songHits = hits
        .filter(hit => hit.type === 'song' && hit.result?.url)
        .sort((a, b) => scoreSongHit(b, artist, track) - scoreSongHit(a, artist, track));
    return songHits[0]?.result || null;
}

async function scrapeLyricsFromGenius(songUrl) {
    const html = await (await fetchWithTimeout(songUrl, 'text/html,application/xhtml+xml')).text();
    const $ = cheerio.load(html);
    const parts = $('[data-lyrics-container="true"]')
        .map((_, element) => $(element).text().trim())
        .get()
        .filter(Boolean);
    return parts.length ? cleanGeniusLyrics(parts.join('\n')) : null;
}

// Envolve handlers async para que nenhum erro derrube o processo.
const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ------------------------------------------------------------------ app */

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);

    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });

    app.use('/api', express.json({ limit: '512kb' }));
    app.use('/api', auth.sessionMiddleware);

    app.get('/api/health', safe(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, db: await db.status() });
    }));

    /* ---- Login com Google ---- */

    // Configuração pública para o front-end + usuário logado (se houver)
    app.get('/api/auth/me', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ user: req.user || null, googleClientId: auth.googleClientId() || null });
    });

    // O botão do Google (ux_mode "redirect") envia um formulário POST para cá
    app.post('/api/auth/google', express.urlencoded({ extended: false, limit: '16kb' }), safe(async (req, res) => {
        // Proteção CSRF do Google: cookie g_csrf_token deve bater com o campo do formulário
        const csrfCookie = req.cookies.g_csrf_token;
        if (!csrfCookie || csrfCookie !== req.body.g_csrf_token) {
            return res.redirect(303, '/?login=erro');
        }
        try {
            const user = await auth.verifyGoogleIdToken(req.body.credential);
            await db.upsertUser(user); // se o banco falhar, o login segue mesmo assim
            auth.setSessionCookie(req, res, user);
            res.redirect(303, '/?login=ok');
        } catch (error) {
            console.warn('[auth] login recusado:', error.message);
            res.redirect(303, '/?login=erro');
        }
    }));

    app.post('/api/auth/logout', (req, res) => {
        auth.clearSessionCookie(req, res);
        res.json({ ok: true });
    });

    /* ---- Sincronização dos dados (todos, notas, tema...) ---- */

    async function sendSpace(res, id) {
        res.setHeader('Cache-Control', 'no-store');
        const space = await db.getSpace(id);
        // Ainda não existe: 200 com data nula (evita erro 404 no console do navegador)
        res.json(space || { data: null, updatedAt: 0 });
    }

    async function storeSpace(req, res, id) {
        res.setHeader('Cache-Control', 'no-store');
        const incoming = req.body?.data;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            return res.status(400).json({ error: 'data object required' });
        }

        const data = {};
        for (const [key, value] of Object.entries(incoming)) {
            if (SYNC_KEYS.has(key) && typeof value === 'string') data[key] = value;
        }

        const updatedAt = Math.min(Number(req.body.updatedAt) || Date.now(), Date.now() + 60000);
        const saved = await db.saveSpace(id, data, updatedAt);
        if (!saved) return res.status(503).json({ error: 'database unavailable' });
        res.json({ ok: true, updatedAt });
    }

    const userSpaceId = user => `user_${user.id}`;

    // Usuário logado: mesmos dados em qualquer aparelho
    app.get('/api/me/space', safe(async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'login required' });
        await sendSpace(res, userSpaceId(req.user));
    }));
    app.put('/api/me/space', safe(async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'login required' });
        await storeSpace(req, res, userSpaceId(req.user));
    }));

    // Sem login: dados do aparelho (id aleatório gerado no navegador)
    app.get('/api/space/:id', safe(async (req, res) => {
        const { id } = req.params;
        if (!SPACE_ID_RE.test(id) || id.startsWith('user_')) return res.status(400).json({ error: 'invalid space id' });
        await sendSpace(res, id);
    }));
    app.put('/api/space/:id', safe(async (req, res) => {
        const { id } = req.params;
        if (!SPACE_ID_RE.test(id) || id.startsWith('user_')) return res.status(400).json({ error: 'invalid space id' });
        await storeSpace(req, res, id);
    }));

    /* ---- Letras via Genius, com cache em SQLite ---- */

    app.get('/api/lyrics/fallback', safe(async (req, res) => {
        const artist = String(req.query.artist || '').trim().slice(0, 200);
        const track = String(req.query.track || '').trim().slice(0, 200);
        if (!artist || !track) return res.status(400).json({ error: 'artist and track are required' });

        const cacheKey = `${normalizeText(artist)}|${normalizeText(track)}`;
        const cached = await db.getCachedLyrics(cacheKey);
        if (cached) {
            res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
            return res.json({ source: cached.source, title: cached.title, artist: cached.artist || artist, lyrics: cached.lyrics, cached: true });
        }

        let song;
        let lyrics;
        try {
            song = await searchGeniusSong(artist, track);
            lyrics = song?.url ? await scrapeLyricsFromGenius(song.url) : null;
        } catch (error) {
            return res.status(502).json({ error: 'failed to fetch genius lyrics', details: error.message });
        }

        if (!lyrics) return res.status(404).json({ error: 'lyrics not found on genius' });

        const result = { source: 'genius', title: song.title, artist: song.primary_artist?.name || artist, lyrics };
        await db.cacheLyrics(cacheKey, result);
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        res.json(result);
    }));

    app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

    /* ---- Arquivos estáticos (usado localmente; na Vercel a CDN serve public/) ---- */

    app.use(express.static(PUBLIC_DIR, {
        maxAge: '1h',
        index: 'index.html',
        setHeaders(res, filePath) {
            // HTML e service worker sempre revalidam para o app atualizar sozinho
            if (/\.(html)$|[\\/]sw\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
        }
    }));
    app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

    // Tratador final: loga e responde JSON, nunca derruba a função.
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        const status = error.status || error.statusCode || 500;
        if (status >= 500) console.error('[app] erro:', error);
        if (res.headersSent) return;
        res.status(status).json({ error: status === 500 ? 'internal error' : error.message });
    });

    return app;
}

module.exports = { createApp };
