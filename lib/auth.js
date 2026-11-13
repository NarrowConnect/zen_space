'use strict';

/**
 * Login com Google (Google Identity Services) sem dependências extras.
 *
 * Fluxo: o botão do Google envia (POST) um ID token para /api/auth/google.
 * O servidor valida a assinatura RS256 com as chaves públicas do Google, confere
 * emissor/audiência/expiração e cria uma sessão em cookie httpOnly assinado (HMAC).
 */

const crypto = require('crypto');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SESSION_COOKIE = 'zen_session';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 dias

let jwksCache = { keys: null, expiresAt: 0 };
let warnedAboutSecret = false;

function googleClientId() {
    return (process.env.GOOGLE_CLIENT_ID || '').trim();
}

// Sem SESSION_SECRET usa um segredo aleatório por processo: continua seguro,
// mas os usuários são deslogados a cada reinício/cold start. Em produção, defina-o.
const FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');

function sessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (secret && secret.length >= 32) return secret;
    if (!warnedAboutSecret) {
        console.warn('[auth] SESSION_SECRET ausente ou curto (<32 chars): sessões não sobrevivem a reinícios.');
        warnedAboutSecret = true;
    }
    return FALLBACK_SECRET;
}

const b64url = input => Buffer.from(input).toString('base64url');
const fromB64url = input => Buffer.from(input, 'base64url');

/* ---------------------------------------------------------- Google ID token */

async function getGoogleKeys(forceRefresh = false) {
    if (!forceRefresh && jwksCache.keys && Date.now() < jwksCache.expiresAt) return jwksCache.keys;

    const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`google certs ${response.status}`);
    const { keys } = await response.json();

    const maxAge = Number((response.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    jwksCache = { keys, expiresAt: Date.now() + maxAge * 1000 };
    return keys;
}

async function verifyGoogleIdToken(idToken) {
    const clientId = googleClientId();
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID não configurado');

    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('token malformado');
    const [rawHeader, rawPayload, rawSignature] = parts;

    const header = JSON.parse(fromB64url(rawHeader).toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) throw new Error('algoritmo inválido');

    let keys = await getGoogleKeys();
    let jwk = keys.find(key => key.kid === header.kid);
    if (!jwk) {
        keys = await getGoogleKeys(true); // o Google rotaciona as chaves
        jwk = keys.find(key => key.kid === header.kid);
    }
    if (!jwk) throw new Error('chave de assinatura desconhecida');

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${rawHeader}.${rawPayload}`), publicKey, fromB64url(rawSignature));
    if (!valid) throw new Error('assinatura inválida');

    const payload = JSON.parse(fromB64url(rawPayload).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error('emissor inválido');
    if (payload.aud !== clientId) throw new Error('audiência inválida');
    if (!payload.exp || payload.exp < now - 60) throw new Error('token expirado');
    if (!payload.sub) throw new Error('token sem usuário');
    if (payload.email && payload.email_verified === false) throw new Error('e-mail não verificado');

    return {
        id: String(payload.sub),
        email: payload.email || null,
        name: payload.name || payload.given_name || null,
        picture: payload.picture || null
    };
}

/* ---------------------------------------------------------------- sessão */

function signSession(user) {
    const payload = b64url(JSON.stringify({
        sub: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S
    }));
    const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function readSession(token) {
    try {
        const [payload, signature] = String(token || '').split('.');
        if (!payload || !signature) return null;
        const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
        const given = fromB64url(signature);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        const data = JSON.parse(fromB64url(payload).toString('utf8'));
        if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
        return { id: data.sub, email: data.email, name: data.name, picture: data.picture };
    } catch (_) {
        return null;
    }
}

function parseCookies(header) {
    const cookies = {};
    String(header || '').split(';').forEach(part => {
        const index = part.indexOf('=');
        if (index > 0) {
            const key = part.slice(0, index).trim();
            try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { /* ignora */ }
        }
    });
    return cookies;
}

function cookieOptions(req, maxAge) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return [`Path=/`, `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : ''].filter(Boolean).join('; ');
}

function setSessionCookie(req, res, user) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=${signSession(user)}; ${cookieOptions(req, SESSION_MAX_AGE_S)}`);
}

function clearSessionCookie(req, res) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(req, 0)}`);
}

/** Middleware: preenche req.user se houver sessão válida (nunca bloqueia). */
function sessionMiddleware(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    req.user = readSession(req.cookies[SESSION_COOKIE]);
    next();
}

module.exports = {
    googleClientId,
    verifyGoogleIdToken,
    setSessionCookie,
    clearSessionCookie,
    sessionMiddleware
};
