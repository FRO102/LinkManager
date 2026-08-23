# Nodes — Link Manager

A web app for managing a personal collection of links ("nodes"): add, edit, delete, search, filter, drag-to-reorder, import from other sources, check for broken links, and view statistics. Frontend in plain HTML5/CSS/JS, backend in Node.js + Express, data persisted as JSON in a Docker volume with automatic backups.

## Start with Docker (recommended)

Prerequisite: Docker and Docker Compose installed.
sudo curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
docker --version

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:3000**.

To stop it:

```bash
docker compose down
```

Data is stored in the `./data/` folder on your machine (mapped as a volume), so it survives restarts and rebuilds of the container.

## Start without Docker (development)

Prerequisite: Node.js 18+ (uses native `fetch` — no extra dependencies for link checking or previews).

```bash
npm install
npm start
```

App available at http://localhost:3000.

## Features

### Basic management
- **Add** a node (title, URL, notes, tags, favorite)
- **Edit** any field of an existing node
- **Delete** with confirmation
- **Search** by title, URL, notes, or tag
- **Filter** by tag (multi-select, "any" or "all" mode) or by favorites
- **Sort** by most recent, oldest, title A-Z/Z-A, favorites first, or **manual order**
- **Copy URL** with one click
- URL validation (automatically normalizes to `https://` if no protocol is given)

### Organization
- **Drag to reorder** — choose "Manual order" in the sort menu and drag nodes by their handle (⠿) to the desired position
- **Duplicate detection** — when adding a link that already exists (even with a different `www.` or trailing slash), the app warns before saving; the **Duplicates** button shows all existing groups in the collection, with an option to remove
- Toggle between **list or grid view**, and between **comfortable or compact density** (preferences saved in the browser)
- Toggleable **light/dark theme** (preference saved in the browser)

### Import and export
- **Import bookmarks** exported from Chrome/Firefox/Edge (`.html` file) — Firefox tags are automatically preserved
- **Import a `links.json`** file from another instance of this app (or your own backup)
- Both import methods automatically skip links that already exist in the collection
- **Export** the full collection as a `.json` file at any time

### Link health
- **Automatic dead link checking** — runs in the background at server startup and then periodically (every 24h by default, configurable)
- **"Check links" button** to force an immediate check of the whole collection, with a progress indicator
- Each node shows a health badge: **ok** (reachable), **broken** (didn't respond), or **unchecked** — clickable to check individually

### Preview and statistics
- **Preview on hover** over a node's title — shows the Open Graph image, title, and description of the site (cached for 1h on the server)
- **Collection statistics**: total nodes, favorites, tags, and link health (ok/broken)

### Robustness
- **Automatic daily backup** of the data, with rotation (keeps the last 14 copies by default) — stored in `data/backups/`
- **Transparent pagination**: the list loads the first 40 nodes and automatically fetches more as you approach the end of the page, with no visible page numbers
- Keyboard shortcut `/` to focus the search box

## Configuration

Environment variables (already set in `docker-compose.yml`, some commented out since they're optional):

| Variable                     | Default | Description                                          |
|-------------------------------|---------|--------------------------------------------------------|
| `PORT`                        | 3000    | Port the server listens on                             |
| `DATA_DIR`                    | ./data  | Folder where `links.json` and `backups/` are stored    |
| `BACKUP_RETENTION`             | 14      | Number of daily backups to keep before rotating        |
| `LINK_CHECK_INTERVAL_HOURS`    | 24      | How often automatic dead link checking runs            |

To change the external port, edit `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"   # access at localhost:8080
```

## Project structure

```
link-manager/
├── server.js           # Express backend + REST API
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── data/
│   ├── links.json      # Main persistence file
│   └── backups/        # Rotating automatic backups
└── public/              # Static frontend
    ├── index.html
    ├── style.css
    └── app.js
```

## REST API

| Method | Route                              | Description                                             |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/links`                       | List links (`?q=`, `?tag=`, `?favorite=true`)              |
| GET    | `/api/links/:id`                   | Get a single link                                          |
| POST   | `/api/links`                       | Create a link                                               |
| PUT    | `/api/links/:id`                   | Edit a link                                                 |
| DELETE | `/api/links/:id`                   | Delete a link                                               |
| PUT    | `/api/links/reorder`               | Reorder links (receives `orderedIds: [...]`)                |
| GET    | `/api/links/check-duplicate`       | Check whether a URL already exists (`?url=`)                |
| GET    | `/api/duplicates`                  | List all duplicate groups in the collection                 |
| POST   | `/api/links/:id/check`             | Check whether a single link is reachable                    |
| POST   | `/api/links/check-all`             | Check all links (runs in batches)                            |
| GET    | `/api/links/check-status`          | Whether a check is currently in progress                    |
| GET    | `/api/preview?url=`                | Returns Open Graph data (title, description, image)         |
| POST   | `/api/import/bookmarks`            | Import HTML bookmarks (`{html, defaultTags}`)                |
| POST   | `/api/import/json`                 | Import links from JSON (`{items, defaultTags}`)              |
| GET    | `/api/backups`                     | List available backups                                       |
| POST   | `/api/backups`                     | Create an immediate backup                                   |
| POST   | `/api/backups/:file/restore`       | Restore a specific backup                                     |
| GET    | `/api/stats`                       | Collection statistics                                        |
| GET    | `/api/tags`                        | List all tags in use                                          |
| GET    | `/api/health`                      | Health check                                                  |

## Data backup

Besides the automatic daily backup in `data/backups/`, your links always live in `data/links.json` — a plain JSON file, easy to copy or version manually. You can also use the **Export .json** button in the UI at any time.
