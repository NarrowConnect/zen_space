'use strict';

// Servidor para rodar localmente / Docker. Na Vercel quem atende é api/index.js.
const { createApp } = require('./lib/app');

process.on('unhandledRejection', reason => console.error('[process] promise rejeitada:', reason));
process.on('uncaughtException', error => console.error('[process] exceção não tratada:', error));

const port = Number(process.env.PORT || 8080);
createApp().listen(port, () => {
    console.log(`ZenSpace server listening on http://localhost:${port}`);
});
