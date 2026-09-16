# Nodes — Link Manager

![Node.js v20](https://img.shields.io/badge/node-%3E%3D20.6.0-green)
![Docker](https://img.shields.io/badge/docker-%22latest%22-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

A professional web app for managing a personal collection of links ("nodes"): add, edit, delete, search, filter, drag-to-reorder, import from other sources, check for broken links, and view statistics. 

The project also includes integrated **Notes** (freeform documentation) and **Tasks** (a to-do list) pages, maintaining a consistent look and feel across all three tools.

> **Upgrading from an older version?** If you have an existing `data/links.json` from before this app used SQLite, no action is needed — the server automatically imports it into a new `links.db` the first time it starts up, and renames the old file to `links.json.bak` (kept, not deleted) once the import succeeds. See [Data storage and backups](#-architecture--api) below for details.

---

## 🚀 Quick Start

### Using Docker (Recommended)
```bash
docker compose up -d --build
```
The app will be available at **http://localhost:3000**.

### Local Development
```bash
npm install && npm start
```
The app will be available at **http://localhost:3000**.

[See Detailed Installation & Configuration](#-installation--configuration)

---

## ✨ Features

### Basic Management
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
- **Duplicate detection** — when adding a link that already exists, the app warns before saving; the **Duplicates** button shows all existing groups in the collection, with per-item removal or a one-click **"Keep oldest, remove N"** to clear an entire group at once
- Toggle between **list or grid view**, and between **comfortable or compact density** (preferences saved in the browser)
- Toggleable **light/dark theme** (preference saved in the browser)

### Import and Export
- **Import bookmarks** exported from Chrome/Firefox/Edge (`.html` file) — Firefox tags are automatically preserved
- **Import a `links.json`** file from another instance of this app (or your own backup)
- Both import methods insert only new links and are capped at `IMPORT_MAX_ITEMS` (default 5000)
- **Export** the full collection as a `.json` file at any time (`GET /api/export`)

### Link Health
- **Automatic dead link checking** — runs in the background at server startup and then periodically (every 24h by default)
- **"Check links" button** to force an immediate check of the whole collection, with a progress indicator and a **Cancel** button
- Each node shows a health badge: **ok**, **broken**, or **unchecked**

### Preview and Statistics
- **Preview on hover** over a node's title — shows Open Graph image, title, and description (cached for 1h)
- **Collection statistics**: total nodes, favorites, tags, and link health, computed via optimized SQL queries

### Robustness and Performance
- **SQLite storage** (via `better-sqlite3`) with WAL mode for concurrent read/write behavior and indexed columns.
- **Automatic daily backup** with rotation (last 14 copies) stored in `data/backups/` using `VACUUM INTO`.
- **Response compression** (gzip/br) for API and static assets.
- **Server-side pagination** available via `GET /api/links?limit=&offset=`.
- **Bulk operations**: `POST /api/links/bulk-delete` and `POST /api/links/bulk-tag`.

### Security
- **SSRF protection**: blocks requests to private, loopback, or link-local addresses during link checking and OG previews.
- **Rate limiting** on link-checking and preview endpoints.
- **Optional shared-token auth** (`AUTH_TOKEN`) for the entire `/api` surface.

---

## 📝 Notes & Tasks Pages

### Notes (`notes.html`)
Adapted for freeform documentation with a title, content field, tags, and favorites.
- **Reading View**: Expanded view with full content, tags, and dates.
- **Export**: Individual notes can be exported as `.txt` client-side.
- **Isolation**: Lives in separate tables within the same `links.db` file.

### Tasks (`tasks.html`)
A streamlined to-do list with title, description, and due date.
- **Automatic Ordering**: Sorts by due date (soonest first).
- **Completion Logic**: Completed tasks are hidden by default to maintain focus.
- **Filters**: Server-side filtering for completed and overdue tasks.

---

## ⚙️ Installation & Configuration

### Detailed Docker Setup
Prerequisite: Docker and Docker Compose installed.
```bash
sudo curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
docker --version
```
Start the application:
```bash
docker compose up -d --build
```
To stop: `docker compose down`. Data is persisted in the `./data/` volume.

### Detailed Local Setup (Development)
Prerequisite: Node.js **20.6+** (required for native environment file support).

```bash
npm install
npm start
```

To use custom settings, copy `.env.example` to `.env` and load it using Node's built-in support:
```bash
cp .env.example .env
node --env-file=.env server.js
```

### Environment Variables
| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | 3000 | Port the server listens on |
| `DATA_DIR` | ./data | Folder where `links.db` and `backups/` are stored |
| `BACKUP_RETENTION` | 14 | Number of daily backups to keep |
| `LINK_CHECK_INTERVAL_HOURS` | 24 | Frequency of automatic dead link checking |
| `IMPORT_MAX_ITEMS` | 5000 | Max items accepted in a single import call |
| `AUTH_TOKEN` | (unset) | Optional token for `/api` requests (`X-Auth-Token` header) |

---

## 🏗️ Architecture & API

### Project Structure
```
link-manager/
├── server.js            # Entry point: middleware, routers, startup
├── lib/                  # Framework-agnostic core modules
│   ├── config.js         # Env vars and constants
│   ├── db.js              # SQLite connection & schema
│   ├── persistence.js    # CRUD logic for links
│   ├── notes-persistence.js # CRUD logic for notes
│   ├── tasks-persistence.js # CRUD logic for tasks
│   ├── ssrf-guard.js      # SSRF protection logic
│   ├── link-check.js      # Link health verification
│   ├── og-preview.js       # OG metadata scraping & cache
│   ├── url-utils.js        # URL normalization & parsing
│   ├── backups.js          # Database snapshots & rotation
│   └── rate-limit.js       # In-memory rate limiter
├── routes/               # Express routers (api endpoints)
│   ├── links.js         # Links API
│   ├── notes.js         # Notes API
│   ├── tasks.js         # Tasks API
│   ├── backups.js       # Backup management
│   └── import.js        # Data import logic
├── public/                # Static frontend (HTML/CSS/JS)
├── test/                  # Automated test suite (node:test)
├── Dockerfile             # Multi-stage build for native modules
└── docker-compose.yml
```

### REST API
The API is divided into **Links**, **Notes**, **Tasks**, and **Shared** endpoints.
- **Links**: `GET /api/links`, `POST /api/links`, `PUT /api/links/:id`, `DELETE /api/links/:id`, etc.
- **Notes**: Similar shape to links, focused on content instead of URLs.
- **Tasks**: Focused on due-dates and completion status.
- **Shared**: `/api/backups` (CRUD for snapshots), `/api/import` (data ingestion), and `/api/health`.

### Data Storage & Backups
All data is stored in a single SQLite database (`data/links.db`) using **WAL mode**.
- **Backups**: Daily snapshots created via `VACUUM INTO`.
- **Restore**: Atomic swap using `ATTACH DATABASE` and transactions.
- **Migration**: Automatic import from `links.json` if the database is missing.

---

## 🛠️ Development & Contributing

We welcome contributions! To keep the project maintainable, please follow these guidelines:

### Development Environment
- **Node.js**: Use version **20.6+** to take advantage of the native `--env-file` flag.
- **Database**: The app uses SQLite; no external database installation is required.

### Coding Standards
- **Backend**: Node.js + Express. Keep business logic in `lib/` to ensure it remains framework-agnostic.
- **Frontend**: Vanilla HTML5, CSS, and JavaScript. Avoid introducing heavy frameworks.
- **Testing**: All new features must include corresponding tests in the `test/` directory.

### Contribution Workflow
1. Fork the repository or create a new feature branch from `main`.
2. Implement your changes.
3. Run the full test suite: `npm test`.
4. Submit a Pull Request with a clear description of the changes and any related issues.

---

## 🚢 Publication & Deployment

This project includes a helper script to automate publication to Git and Docker Hub.

### Using `publish.sh`
```bash
chmod +x publish.sh
./publish.sh
```
**Workflow**:
1. The script will prompt you for the **Git Repository URL**.
2. It will prompt you for the **Docker Image Name** (e.g., `username/link-manager:latest`).
3. It automatically performs: `git init` $\rightarrow$ `add` $\rightarrow$ `commit` $\rightarrow$ `push`.
4. It then performs: `docker build` $\rightarrow$ `docker push`.

---

## 🧪 Testing

The project uses Node's built-in test runner (`node:test`), requiring no external dependencies.

```bash
npm test
```
Tests are isolated; each file spins up the app on an ephemeral port with a temporary `DATA_DIR`, ensuring your real data is never touched.

---

## 🛡️ Security

- **SSRF Protection**: Validates hostnames before fetching previews or checking links to prevent internal network probing.
- **Rate Limiting**: Applied to resource-heavy endpoints (`/api/preview` and `/api/links/check-all`).
- **Auth**: Optional `AUTH_TOKEN` can be set to protect the API.

---

## ❓ Troubleshooting

- **SQLite Lock Issues**: If you encounter database locks, ensure your `data/` directory is **not** hosted on a network-mounted drive (e.g., NFS, SMB), as these often interfere with SQLite's WAL mode locking.
- **Node Version Errors**: If `npm start` fails or environment variables aren't loading, verify you are using Node 20.6+.
- **Docker Permission Denied**: On Linux, if you cannot run docker commands without `sudo`, run: `sudo usermod -aG docker $USER` and restart your session.


