# ZenSpace

Painel zen de produtividade (Pomodoro, sons ambientes, notas, tarefas e Spotify) que funciona como **app instalável** no Android, iPhone/iPad e no navegador (PWA), com dados salvos em **SQLite**.

## Para o usuário final

Nada para configurar: é só abrir o site.

- **Android / Chrome / Edge:** aparece o botão **Instalar**.
- **iPhone / iPad (Safari):** Compartilhar → **Adicionar à Tela de Início** (o app mostra essa dica).
- Funciona **offline** depois da primeira visita.
- Tarefas, notas, nome, tema e fila do Spotify ficam salvos no aparelho e são copiados automaticamente para o servidor.
  Se o servidor estiver fora do ar, o app continua funcionando normalmente só com os dados locais.

## Deploy na Vercel

1. Importe o repositório na Vercel (não precisa de build command; o `vercel.json` já configura tudo).
2. **Banco persistente (recomendado):** crie um banco gratuito no [Turso](https://turso.tech) (SQLite gerenciado) e defina:
   - `TURSO_DATABASE_URL` = `libsql://seu-banco.turso.io`
   - `TURSO_AUTH_TOKEN` = token do banco

   Sem essas variáveis o app usa SQLite em `/tmp` na Vercel: funciona, mas os dados do servidor são temporários
   (a Vercel apaga o `/tmp` entre execuções). Os dados no aparelho do usuário não são perdidos.
3. **Spotify:** o redirect agora usa o domínio atual automaticamente. Cadastre o domínio da Vercel
   (ex.: `https://seu-app.vercel.app/`) em *Redirect URIs* no painel do Spotify Developer.

Verifique o estado do banco em `/api/health`.

## Rodar localmente / Docker

```bash
npm install
npm start          # http://localhost:8080, banco em ./data/zenspace.db
```

```bash
docker compose up -d --build   # banco persistido no volume zenspace-data
```

## Estrutura

| Caminho | Função |
| --- | --- |
| `public/` | Front-end (index.html, manifest, service worker, ícones) servido pela CDN |
| `api/index.js` | Função serverless da Vercel (todas as rotas `/api/*`) |
| `lib/app.js` | App Express: sync de dados, letras via Genius com cache |
| `lib/db.js` | SQLite via libSQL (arquivo local, `/tmp` ou Turso) |
| `local-server.js` | Servidor para uso local e Docker |

## API

- `GET /api/health` — status do servidor e do banco
- `GET /api/space/:id` / `PUT /api/space/:id` — sincronização automática dos dados do app
- `GET /api/lyrics/fallback?artist=&track=` — letras do Genius (cacheadas no SQLite)
