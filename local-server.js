'use strict';

// Carrega o .env local se existir (Node 20.12+). Na Vercel as variáveis vêm do painel.
try { process.loadEnvFile(); } catch (_) { /* sem .env: usa o ambiente */ }

// Servidor para rodar localmente / Docker. Na Vercel quem atende é api/index.js.
const { createApp } = require('./lib/app');

process.on('unhandledRejection', reason => console.error('[process] promise rejeitada:', reason));
process.on('uncaughtException', error => console.error('[process] exceção não tratada:', error));

const port = Number(process.env.PORT || 8080);
createApp().listen(port, () => {
    console.log(`ZenSpace server listening on http://localhost:${port}`);
});
