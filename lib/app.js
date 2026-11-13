'use strict';

const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const lyricsService = require('./lyrics');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LYRICS_NOT_FOUND_TTL_MS = 1000 * 60 * 60 * 24; // tenta de novo músicas sem letra após 1 dia
const SPACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Só estas chaves do localStorage são sincronizadas (tokens do Spotify ficam só no navegador).
const SYNC_KEYS = new Set(['zen-theme', 'zen-username', 'zen-todos', 'zen-notebook-note', 'spotify-queue']);

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

    // Configuração pública para o front-end (client IDs) + usuário logado (se houver)
    app.get('/api/auth/me', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            user: req.user || null,
            googleClientId: auth.googleClientId() || null,
            // Client IDs são públicos (PKCE no navegador): nenhum client secret é necessário
            spotifyClientId: (process.env.SPOTIFY_CLIENT_ID || '').trim() || null
        });
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

    /* ---- Letras: LRCLib (sincronizada) → Genius (texto), com cache SQLite + CDN ---- */

    const lyricsInFlight = new Map(); // junta pedidos simultâneos da mesma música

    app.get('/api/lyrics', safe(async (req, res) => {
        const artist = String(req.query.artist || '').trim().slice(0, 200);
        const track = String(req.query.track || '').trim().slice(0, 300);
        const album = String(req.query.album || '').trim().slice(0, 300);
        const durationMs = Math.max(0, Math.min(Number(req.query.duration) || 0, 60 * 60 * 1000));
        if (!artist || !track) return res.status(400).json({ error: 'artist and track are required' });

        const key = lyricsService.cacheKeyFor(artist, track);
        let result = await db.getCachedLyrics(key, LYRICS_NOT_FOUND_TTL_MS);
        let cached = Boolean(result);

        if (!result) {
            if (!lyricsInFlight.has(key)) {
                lyricsInFlight.set(key, lyricsService.findLyrics({ artist, track, album, durationMs })
                    .finally(() => lyricsInFlight.delete(key)));
            }
            result = await lyricsInFlight.get(key);
            if (!result.transient) await db.cacheLyrics(key, result);
        }

        // CDN da Vercel guarda a resposta: próximos usuários recebem em milissegundos
        if (result.transient) {
            res.setHeader('Cache-Control', 'no-store');
        } else if (result.notFound) {
            res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=21600');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000');
        }

        if (result.notFound) return res.json({ found: false, cached });
        res.json({
            found: true,
            synced: result.synced,
            source: result.source,
            lyrics: result.lyrics,
            durationMs: result.durationMs || 0, // duração da versão encontrada (para reescalar os tempos)
            matchedVia: result.matchedVia || null,
            cached
        });
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
