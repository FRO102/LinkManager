# Nós — Gestor de Links

Aplicação web para gerir uma coleção pessoal de links ("nós"): adicionar, editar, apagar, pesquisar, filtrar por tag/favorito e ordenar. Frontend em HTML5/CSS/JS puro, backend em Node.js + Express, dados persistidos em JSON num volume Docker.

## Arrancar com Docker (recomendado)

Pré-requisito: Docker e Docker Compose instalados.

```bash
docker compose up -d --build
```

A aplicação fica disponível em **http://localhost:3000**.

Para parar:

```bash
docker compose down
```

Os dados ficam guardados na pasta `./data/links.json` no teu computador (mapeada como volume), por isso sobrevivem a reinícios e rebuilds do container.

## Arrancar sem Docker (desenvolvimento)

Pré-requisito: Node.js 18+.

```bash
npm install
npm start
```

Aplicação disponível em http://localhost:3000.

## Funcionalidades

- **Adicionar** nó (título, URL, notas, etiquetas, favorito)
- **Editar** qualquer campo de um nó existente
- **Apagar** com confirmação
- **Pesquisar** por título, URL, notas ou etiqueta
- **Filtrar** por etiqueta (clicando nos chips) ou por favoritos (na ordenação)
- **Ordenar** por mais recente, mais antigo, título A-Z/Z-A ou favoritos primeiro
- **Copiar URL** com um clique
- Alternar entre **vista em lista ou grelha** (preferência guardada no browser)
- **Tema claro/escuro** alternável (preferência guardada no browser)
- **Exportar** a coleção como ficheiro `.json`
- Atalho de teclado `/` para focar a pesquisa
- Validação de URL (normaliza automaticamente para `https://` se não indicares protocolo)

## Configuração

Variáveis de ambiente (já definidas no `docker-compose.yml`):

| Variável   | Default | Descrição                          |
|------------|---------|-------------------------------------|
| `PORT`     | 3000    | Porta onde o servidor escuta        |
| `DATA_DIR` | ./data  | Pasta onde `links.json` é guardado  |

Para mudar a porta externa, edita `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"   # acede em localhost:8080
```

## Estrutura do projeto

```
link-manager/
├── server.js           # Backend Express + API REST
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── data/                # Persistência (links.json) — volume Docker
└── public/              # Frontend estático
    ├── index.html
    ├── style.css
    └── app.js
```

## API REST

| Método | Rota              | Descrição                          |
|--------|-------------------|--------------------------------------|
| GET    | `/api/links`      | Lista links (aceita `?q=`, `?tag=`, `?favorite=true`) |
| GET    | `/api/links/:id`  | Obtém um link                       |
| POST   | `/api/links`      | Cria link                           |
| PUT    | `/api/links/:id`  | Edita link                          |
| DELETE | `/api/links/:id`  | Apaga link                          |
| GET    | `/api/tags`       | Lista todas as tags usadas          |
| GET    | `/api/health`     | Health check                        |

## Backup dos dados

Os teus links ficam em `data/links.json` — é um ficheiro JSON simples, fácil de copiar ou versionar como backup.
