# Nós — Gestor de Links

Aplicação web para gerir uma coleção pessoal de links ("nós"): adicionar, editar, apagar, pesquisar, filtrar, reordenar por arrastar, importar de outras fontes, verificar links quebrados e consultar estatísticas. Frontend em HTML5/CSS/JS puro, backend em Node.js + Express, dados persistidos em JSON num volume Docker com backup automático.

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

Os dados ficam guardados na pasta `./data/` no teu computador (mapeada como volume), por isso sobrevivem a reinícios e rebuilds do container.

## Arrancar sem Docker (desenvolvimento)

Pré-requisito: Node.js 18+ (usa `fetch` nativo — sem dependências extra para verificação de links ou previews).

```bash
npm install
npm start
```

Aplicação disponível em http://localhost:3000.

## Funcionalidades

### Gestão básica
- **Adicionar** nó (título, URL, notas, etiquetas, favorito)
- **Editar** qualquer campo de um nó existente
- **Apagar** com confirmação
- **Pesquisar** por título, URL, notas ou etiqueta
- **Filtrar** por etiqueta (seleção múltipla, modo "qualquer uma" ou "todas") ou por favoritos
- **Ordenar** por mais recente, mais antigo, título A-Z/Z-A, favoritos primeiro, ou **ordem manual**
- **Copiar URL** com um clique
- Validação de URL (normaliza automaticamente para `https://` se não indicares protocolo)

### Organização
- **Arrastar para reordenar** — escolhe "Ordem manual" no menu de ordenar e arrasta os nós pela pega (⠿) para a posição desejada
- **Deteção de duplicados** — ao adicionar um link já existente (mesmo com `www.` ou barra final diferentes), a app avisa antes de guardar; o botão **Duplicados** mostra todos os grupos já existentes na coleção, com opção de remover
- Alternar entre **vista em lista ou grelha**, e entre **densidade confortável ou compacta** (preferências guardadas no browser)
- **Tema claro/escuro** alternável (preferência guardada no browser)

### Importação e exportação
- **Importar bookmarks** exportados do Chrome/Firefox/Edge (ficheiro `.html`) — etiquetas do Firefox são preservadas automaticamente
- **Importar `links.json`** de outra instância desta app (ou o teu próprio backup)
- Ambos os métodos de importação ignoram automaticamente links que já existem na coleção
- **Exportar** a coleção completa como ficheiro `.json` a qualquer momento

### Saúde dos links
- **Verificação automática de links mortos** — corre em segundo plano ao arrancar o servidor e depois periodicamente (24h por padrão, configurável)
- **Botão "Verificar links"** para forçar uma verificação imediata de toda a coleção, com indicador de progresso
- Cada nó mostra um selo de estado: **ok** (acessível), **quebrado** (não respondeu) ou **por verificar** — clicável para verificar individualmente

### Preview e estatísticas
- **Preview ao passar o rato** sobre o título de um nó — mostra imagem, título e descrição Open Graph do site (com cache de 1h no servidor)
- **Estatísticas da coleção**: total de nós, favoritos, etiquetas, saúde dos links, etiquetas mais usadas e domínios mais guardados

### Robustez
- **Backup automático diário** dos dados, com rotação (mantém as últimas 14 cópias por padrão) — guardado em `data/backups/`
- **Paginação transparente**: a lista carrega os primeiros 40 nós e vai buscar mais automaticamente ao aproximares-te do fim da página, sem numeração de páginas visível
- Atalho de teclado `/` para focar a pesquisa

## Configuração

Variáveis de ambiente (já definidas no `docker-compose.yml`, algumas comentadas por serem opcionais):

| Variável                     | Default | Descrição                                          |
|-------------------------------|---------|-----------------------------------------------------|
| `PORT`                        | 3000    | Porta onde o servidor escuta                        |
| `DATA_DIR`                    | ./data  | Pasta onde `links.json` e `backups/` são guardados  |
| `BACKUP_RETENTION`             | 14      | Número de backups diários a manter antes de rodar   |
| `LINK_CHECK_INTERVAL_HOURS`    | 24      | Frequência da verificação automática de links mortos |

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
├── data/
│   ├── links.json      # Persistência principal
│   └── backups/        # Backups automáticos rotativos
└── public/              # Frontend estático
    ├── index.html
    ├── style.css
    └── app.js
```

## API REST

| Método | Rota                              | Descrição                                             |
|--------|-------------------------------------|--------------------------------------------------------|
| GET    | `/api/links`                       | Lista links (`?q=`, `?tag=`, `?favorite=true`)         |
| GET    | `/api/links/:id`                   | Obtém um link                                          |
| POST   | `/api/links`                       | Cria link                                              |
| PUT    | `/api/links/:id`                   | Edita link                                             |
| DELETE | `/api/links/:id`                   | Apaga link                                             |
| PUT    | `/api/links/reorder`               | Reordena links (recebe `orderedIds: [...]`)            |
| GET    | `/api/links/check-duplicate`       | Verifica se uma URL já existe (`?url=`)                |
| GET    | `/api/duplicates`                  | Lista todos os grupos de duplicados na coleção         |
| POST   | `/api/links/:id/check`             | Verifica se um link individual está acessível          |
| POST   | `/api/links/check-all`             | Verifica todos os links (corre em lotes)               |
| GET    | `/api/links/check-status`          | Indica se há uma verificação em curso                  |
| GET    | `/api/preview?url=`                | Devolve dados Open Graph (título, descrição, imagem)   |
| POST   | `/api/import/bookmarks`            | Importa bookmarks HTML (`{html, defaultTags}`)         |
| POST   | `/api/import/json`                 | Importa links de um JSON (`{items, defaultTags}`)      |
| GET    | `/api/backups`                     | Lista backups disponíveis                              |
| POST   | `/api/backups`                     | Cria um backup imediato                                |
| POST   | `/api/backups/:file/restore`       | Restaura um backup específico                          |
| GET    | `/api/stats`                       | Estatísticas da coleção                                |
| GET    | `/api/tags`                        | Lista todas as tags usadas                             |
| GET    | `/api/health`                      | Health check                                           |

## Backup dos dados

Além do backup automático diário em `data/backups/`, os teus links ficam sempre em `data/links.json` — um ficheiro JSON simples, fácil de copiar ou versionar manualmente. Podes também usar o botão **Exportar .json** na interface a qualquer momento.
