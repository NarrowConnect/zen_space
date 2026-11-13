# ZenSpace

Painel zen de produtividade (Pomodoro, sons ambientes, notas, tarefas e Spotify) que funciona como **app instalável** no Android, iPhone/iPad e no navegador (PWA), com dados salvos em **SQLite**.

## Para o usuário final

Nada para configurar: é só abrir o site.

- **Android / Chrome / Edge:** aparece o botão **Instalar**.
- **iPhone / iPad (Safari):** Compartilhar → **Adicionar à Tela de Início** (o app mostra essa dica).
- Funciona **offline** depois da primeira visita.
- **Login com Google (opcional):** com login, tarefas, notas, nome, tema e fila do Spotify ficam iguais em
  todos os aparelhos. Sem login, tudo funciona e os dados ficam salvos só naquele aparelho.
- Os dados ficam salvos no aparelho e são copiados automaticamente para o servidor.
  Se o servidor estiver fora do ar, o app continua funcionando normalmente só com os dados locais.

## Variáveis de ambiente

Veja [`.env.example`](.env.example). Localmente, copie para `.env` (o `npm start` lê sozinho);
na Vercel, cadastre em *Settings → Environment Variables*.

| Variável | Obrigatória | Para quê |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | para o login | ID do cliente OAuth do Google |
| `SPOTIFY_CLIENT_ID` | não | Client ID do app no Spotify (sem ele usa o padrão do código) |
| `SESSION_SECRET` | em produção | Assina o cookie de sessão (`openssl rand -hex 32`) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | recomendado na Vercel | SQLite persistente |
| `SQLITE_PATH`, `PORT` | não | Só local/Docker |

Nenhum *client secret* é necessário: o Google é validado com as chaves públicas do Google e o Spotify usa PKCE.

## Login com Google

No [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → *Criar credenciais* →
*ID do cliente OAuth* → *Aplicativo da Web*:

- **Origens JavaScript autorizadas:** `https://zen.narrowconnect.com.br`, `https://www.zen.narrowconnect.com.br`
- **URIs de redirecionamento autorizados:** `https://zen.narrowconnect.com.br/api/auth/google`,
  `https://www.zen.narrowconnect.com.br/api/auth/google`

Para testar localmente, acrescente `http://localhost:8080` e `http://localhost:8080/api/auth/google`.

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
| `lib/auth.js` | Login Google: valida o token e cria a sessão em cookie |
| `local-server.js` | Servidor para uso local e Docker |

## API

- `GET /api/health` — status do servidor e do banco
- `GET /api/auth/me` — usuário logado + client id público do Google
- `POST /api/auth/google` — recebe o login do botão do Google; `POST /api/auth/logout` — sai
- `GET|PUT /api/me/space` — dados da conta logada (todos os aparelhos)
- `GET|PUT /api/space/:id` — dados do aparelho quando não há login
- `GET /api/lyrics?artist=&track=&album=&duration=` — letras em cascata: LRCLib exato → LRCLib busca → Genius,
  com cache no SQLite (inclusive "sem letra") e na CDN da Vercel
