'use strict';

/**
 * Camada SQLite do ZenSpace (via libSQL).
 *
 * - Local:   arquivo SQLite em ./data/zenspace.db (ou SQLITE_PATH).
 * - Vercel:  se TURSO_DATABASE_URL estiver definido, usa o Turso (SQLite gerenciado,
 *            persistente). Sem ele, usa /tmp/zenspace.db, que funciona mas é
 *            efêmero (zera quando a função "esfria" ou escala).
 *
 * Qualquer falha de banco é tratada como "banco indisponível": as rotas continuam
 * respondendo e o front-end segue funcionando só com o localStorage.
 */

const fs = require('fs');
const path = require('path');

const IS_VERCEL = Boolean(process.env.VERCEL);

function resolveConfig() {
    const remoteUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || process.env.DATABASE_URL;
    if (remoteUrl && /^(libsql|https?|wss?):\/\//.test(remoteUrl)) {
        return {
            url: remoteUrl,
            authToken: process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN,
            kind: 'remote'
        };
    }

    const filePath = process.env.SQLITE_PATH
        || (IS_VERCEL ? '/tmp/zenspace.db' : path.join(__dirname, '..', 'data', 'zenspace.db'));

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) {
        // diretório já existe ou não é gravável; o createClient vai reportar
    }

    return { url: `file:${filePath}`, kind: IS_VERCEL ? 'ephemeral-file' : 'file' };
}

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        picture TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS lyrics_v3 (
        cache_key TEXT PRIMARY KEY,
        found INTEGER NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
    )`,
    'DROP TABLE IF EXISTS lyrics',
    'DROP TABLE IF EXISTS lyrics_cache'
];

let clientPromise = null;
let lastError = null;
let dbKind = null;

async function connect() {
    const { createClient } = require('@libsql/client');
    const config = resolveConfig();
    const client = createClient({ url: config.url, authToken: config.authToken });

    if (config.kind !== 'remote') {
        // WAL melhora concorrência em arquivo local; ignoramos se não suportado.
        await client.execute('PRAGMA journal_mode = WAL').catch(() => {});
        await client.execute('PRAGMA busy_timeout = 3000').catch(() => {});
    }

    await client.batch(SCHEMA, 'write');
    dbKind = config.kind;
    lastError = null;
    return client;
}

/** Retorna o cliente ou null se o banco estiver indisponível (nunca lança). */
async function getDb() {
    if (!clientPromise) {
        clientPromise = connect().catch(error => {
            lastError = error;
            clientPromise = null; // tenta de novo na próxima requisição
            console.warn('[db] SQLite indisponível:', error.message);
            return null;
        });
    }
    return clientPromise;
}

/** Executa uma query; em caso de erro devolve `fallback` em vez de lançar. */
async function safeExecute(stmt, fallback = null) {
    const db = await getDb();
    if (!db) return fallback;
    try {
        return await db.execute(stmt);
    } catch (error) {
        lastError = error;
        console.warn('[db] query falhou:', error.message);
        return fallback;
    }
}

async function getSpace(id) {
    const result = await safeExecute({ sql: 'SELECT data, updated_at FROM spaces WHERE id = ?', args: [id] });
    const row = result?.rows?.[0];
    if (!row) return null;
    try {
        return { data: JSON.parse(row.data), updatedAt: Number(row.updated_at) };
    } catch (_) {
        return null;
    }
}

async function saveSpace(id, data, updatedAt) {
    const result = await safeExecute({
        sql: `INSERT INTO spaces (id, data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
              WHERE excluded.updated_at >= spaces.updated_at`,
        args: [id, JSON.stringify(data), updatedAt]
    });
    return Boolean(result);
}

async function upsertUser(user) {
    const now = Date.now();
    await safeExecute({
        sql: `INSERT INTO users (id, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
                  picture = excluded.picture, last_login_at = excluded.last_login_at`,
        args: [user.id, user.email, user.name, user.picture, now, now]
    });
}

/** Letra em cache. "Não encontrado" expira depois de `notFoundTtlMs` para tentar de novo. */
async function getCachedLyrics(key, notFoundTtlMs) {
    const result = await safeExecute({
        sql: 'SELECT found, payload, created_at FROM lyrics_v3 WHERE cache_key = ?',
        args: [key]
    });
    const row = result?.rows?.[0];
    if (!row) return null;
    if (!Number(row.found)) {
        return Date.now() - Number(row.created_at) > notFoundTtlMs ? null : { notFound: true };
    }
    try { return JSON.parse(row.payload); } catch (_) { return null; }
}

async function cacheLyrics(key, result) {
    await safeExecute({
        sql: 'INSERT OR REPLACE INTO lyrics_v3 (cache_key, found, payload, created_at) VALUES (?, ?, ?, ?)',
        args: [key, result.notFound ? 0 : 1, result.notFound ? null : JSON.stringify(result), Date.now()]
    });
}

async function status() {
    const db = await getDb();
    return {
        available: Boolean(db),
        kind: dbKind || resolveConfig().kind,
        persistent: dbKind === 'remote' || dbKind === 'file',
        error: db ? null : (lastError?.message || null)
    };
}

module.exports = { getDb, getSpace, saveSpace, upsertUser, getCachedLyrics, cacheLyrics, status };
