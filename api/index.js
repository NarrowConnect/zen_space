'use strict';

// Função serverless da Vercel: todas as rotas /api/* chegam aqui (ver vercel.json).
const { createApp } = require('../lib/app');

module.exports = createApp();
