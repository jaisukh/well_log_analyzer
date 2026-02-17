# WellLogAI — Subsurface Well-Log Analytics Platform

A full-stack web application for ingesting LAS (Log ASCII Standard) files, visualizing depth-indexed well-log curves, and performing AI-assisted petrophysical interpretation.

**Live demo:** [welllogai.online](https://www.welllogai.online)

---

## 🏗️ Architecture Overview

```mermaid
graph TB
    Browser[Web Browser]
    
    subgraph Frontend
        NextJS[Next.js 16 + React 19]
        Plotly[Plotly.js Visualization]
        UI[Shadcn UI + Tailwind]
    end
    
    subgraph Backend
        API[FastAPI Python 3.11+]
        ORM[SQLAlchemy ORM]
    end
    
    subgraph Data
        PG[(PostgreSQL)]
        TS[(TimescaleDB)]
        S3[Amazon S3]
    end
    
    subgraph AI
        Groq[Groq API]
        Gemini[Gemini API]
        Rules[Rule Engine]
    end
    
    Browser -->|HTTPS| NextJS
    NextJS -->|REST API| API
    NextJS --> Plotly
    NextJS --> UI
    
    API --> ORM
    API --> PG
    API --> TS
    API --> S3
    API --> Groq
    API --> Gemini
    Groq --> Rules
    
    PG -.-> TS

    style NextJS fill:#3b82f6,stroke:#1e40af,color:#fff
    style Plotly fill:#3b82f6,stroke:#1e40af,color:#fff
    style UI fill:#3b82f6,stroke:#1e40af,color:#fff
    style API fill:#8b5cf6,stroke:#6d28d9,color:#fff
    style ORM fill:#8b5cf6,stroke:#6d28d9,color:#fff
    style PG fill:#10b981,stroke:#059669,color:#fff
    style TS fill:#10b981,stroke:#059669,color:#fff
    style S3 fill:#10b981,stroke:#059669,color:#fff
    style Groq fill:#f59e0b,stroke:#d97706,color:#fff
    style Gemini fill:#f59e0b,stroke:#d97706,color:#fff
    style Rules fill:#f59e0b,stroke:#d97706,color:#fff
```

### 📋 Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **⚛️ Frontend** | Next.js 16 (App Router) + React 19 | Server-side rendering, routing, React components |
| | Plotly.js | Interactive depth-indexed well-log visualization |
| | Shadcn UI + Tailwind CSS | Component library with custom dark theme |
| **⚡ Backend** | FastAPI (Python 3.11+) | High-performance async REST API |
| | SQLAlchemy ORM | Database abstraction and query building |
| **💾 Data** | PostgreSQL + TimescaleDB | Relational metadata + hypertable-optimized time-series |
| | Amazon S3 | Durable object storage for raw LAS files |
| **🤖 AI** | Groq (Llama 3.3 70B) | Primary AI interpretation engine |
| | Google Gemini (2.0 Flash) | Fallback AI provider |
| | Rule-based Engine | Analytical fallback (trend detection, anomaly detection) |

### 🔒 Security Model

All sensitive credentials are stored **server-side only** in `.env`:
- AWS Access Keys
- AI API Keys (Groq/Gemini)
- Database Credentials
- Never exposed to client

### 🔄 Data Flow

1. **Upload** → User uploads LAS file through React frontend
2. **Storage** → File stored in S3, SHA-256 hash computed for duplicate detection
3. **Parsing** → Backend parses LAS with `lasio`, extracts curve metadata
4. **Database** → Metadata → PostgreSQL, depth-indexed samples → TimescaleDB hypertable
5. **Visualization** → Plotly.js renders multi-track depth curves with independent scaling
6. **Analysis** → AI APIs provide petrophysical interpretation on selected curves/depth range

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload-las` | Upload and parse a LAS file (stores to S3 + DB) |
| GET | `/api/well/{file_id}` | Well metadata, curve categories, depth range |
| GET | `/api/curves/{file_id}` | List all curves for a file |
| GET | `/api/samples/{curve_id}?start=&end=` | Depth-value samples for a curve in range |
| POST | `/api/interpret` | AI-assisted interpretation of selected curves |
| POST | `/api/chat` | Chatbot for data-driven well questions |
| GET | `/api/files` | List all previously uploaded wells |
| GET | `/api/health` | Health check endpoint |

---

## Database Choice: PostgreSQL + TimescaleDB

### Why PostgreSQL?

PostgreSQL was chosen as the primary database for several reasons:

1. **Relational integrity:** Well-log data has a clear hierarchical structure — a LAS file contains multiple curves, and each curve contains thousands of depth-indexed samples. PostgreSQL's foreign key constraints (`las_files → curves → curve_samples`) enforce referential integrity and prevent orphaned records.

2. **Rich query capabilities:** The application requires range queries (depth filtering with `WHERE depth >= ? AND depth <= ?`), aggregate functions (`MIN`, `MAX`, `AVG`, `COUNT` for curve statistics), and joins (curve metadata with sample data). PostgreSQL excels at all of these with its mature query optimizer.

3. **Mature ecosystem:** SQLAlchemy ORM provides clean Python integration. PostgreSQL has battle-tested tooling, backup solutions, and monitoring.

### Why TimescaleDB Extension?

TimescaleDB extends PostgreSQL specifically for ordered, append-heavy data — which describes well-log samples perfectly:

1. **Hypertable optimization:** The `curve_samples` table (which can contain 100K+ rows per file) is converted into a TimescaleDB hypertable partitioned by depth. This provides automatic chunk-based partitioning, dramatically improving range query performance for depth-based filtering.

2. **Compression:** TimescaleDB's native compression reduces storage for large sample datasets without application-level changes.

3. **No application changes needed:** TimescaleDB is a PostgreSQL extension, not a separate database. The same SQLAlchemy models, queries, and connection strings work unchanged. This gives time-series-like performance with zero code complexity.

### Why Not Alternatives?

| Alternative | Why Not |
|-------------|---------|
| **MongoDB** | Well-log data is highly structured and relational (file → curves → samples). Document stores add complexity for range queries and aggregations across curves. |
| **InfluxDB** | Designed for time-series with timestamps, not depth-indexed geophysical data. Lacks relational features (joins, foreign keys). |
| **SQLite** | Not suitable for concurrent access in a multi-user web application. No extension support for hypertables. |
| **Raw files / Parquet** | No indexing, no range query optimization, no transactional guarantees. |

### Schema Design

```
las_files (1)──────►(N) curves (1)──────►(N) curve_samples
  id                      id                    id
  filename                las_file_id           curve_id
  s3_key                  name (GR, RHOB...)    depth (float, indexed)
  content_hash            unit (API, g/cc...)    value (float, nullable)
  uploaded_at             description
```

- **`las_files`**: Metadata for each uploaded file. `s3_key` links to the original file in S3. `content_hash` (SHA-256) enables duplicate detection — re-uploading the same file returns existing data instead of duplicating it.
- **`curves`**: One row per curve mnemonic per file. Stores name, unit, and description.
- **`curve_samples`**: The bulk data table — one row per (curve, depth) pair. Configured as a TimescaleDB hypertable partitioned on `depth` for optimized range queries. `NULL` values represent missing/invalid readings (NaN/Inf from the LAS file are sanitized on ingestion).

---

## Storage Strategy

| Data | Storage | Rationale |
|------|---------|-----------|
| **Original LAS file** | Amazon S3 (`las-files/{filename}`) | Preserves the raw file for re-parsing, audit, or download. S3 provides durable, scalable object storage. |
| **Parsed curve metadata** | PostgreSQL `curves` table | Enables fast lookups, categorization, and joins with sample data. |
| **Curve sample data** | PostgreSQL `curve_samples` hypertable | Optimized for the primary access pattern: "give me values for curve X between depth A and depth B." |

---

## Features

### 1. File Ingestion & Storage
- Drag-and-drop or file picker for `.las` files
- Original file uploaded to Amazon S3
- LAS file parsed using `lasio` library
- Curve metadata and depth-indexed samples stored in PostgreSQL/TimescaleDB
- NaN/Inf values sanitized to NULL on ingestion
- **Duplicate detection**: SHA-256 content hashing prevents re-processing the same file — returns existing data instantly
- **Previously uploaded files**: Landing page shows recent wells in a horizontal carousel for quick re-access
- **Granular upload progress**: Status updates at each stage (uploading, parsing, storing, loading metadata)
- **Landing page**: "How it works" animated pipeline (upload → parse & store → visualize → AI interpret); WellLogAI logo links back to home from the dashboard

### 2. Visualization
- **Multi-track layout**: Each curve gets its own x-axis with independent scaling (industry-standard well-log display)
- Interactive Plotly.js charts with curves plotted against depth (y-axis, reversed)
- Visual track separators between curves for clear delineation
- Curve selection via categorized sidebar with checkboxes
- Depth range control via numeric inputs and a dual-handle slider
- Built-in zoom (scroll wheel + toolbar), pan, hover tooltips, and reset
- **Performance**: Debounced depth changes (400ms), parallel curve fetching, request cancellation to prevent stale data

### 3. AI-Assisted Interpretation
- User selects curves and depth range, then clicks "Run Analysis"
- Backend fetches actual curve data (up to 100 sampled points per curve) within the specified range
- Sends real depth-value pairs + statistics to AI for analysis
- **AI Providers (priority order):**
  1. Groq (Llama 3.3 70B) — free, fast inference
  2. Google Gemini (2.0 Flash) — fallback
  3. Rule-based analytical engine — always available, performs trend detection, anomaly detection (z-score), zone segmentation, cross-curve analysis (neutron-density crossovers, resistivity separation, GR lithology classification)
- Results displayed with per-curve statistics (min/mean/max) and formatted interpretation text
- **Export**: Download interpretation results as a formatted text report

### 4. Chatbot Interface (Jarvis)
- **Jarvis** — AI assistant available as an Analysis | Chat tab in the right panel (no floating overlay)
- **Context-aware**: Sends current selection context (selected curves, depth range) to AI so answers focus on what the user is viewing
- Sends well context (all curve names, units, statistics) to AI
- Quick-query buttons for common questions
- Supports data-driven questions about the uploaded well data

### 5. Error Handling & Robustness
- Proper HTTP status codes (400, 404, 422, 502) instead of generic 200 + error objects
- Malformed LAS file detection with clear user-facing error messages
- Input validation on all endpoints (depth range, curve IDs)
- Upload error display with dismissible alert
- Configurable API URL via `NEXT_PUBLIC_API_URL` environment variable
- Health check endpoint (`/api/health`) for monitoring
- **Session persistence**: Dashboard URL includes `?file_id=` so refreshing keeps the same well; selected curves are restored from session storage

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | Next.js (App Router) | 16 |
| UI Components | Shadcn UI + Radix | Latest |
| Charting | Plotly.js + react-plotly.js | Latest |
| Styling | Tailwind CSS | v4 |
| Backend | FastAPI | Latest |
| ORM | SQLAlchemy | Latest |
| Database | PostgreSQL + TimescaleDB | PG 15 |
| File Storage | Amazon S3 (boto3) | Latest |
| LAS Parsing | lasio | Latest |
| AI (Primary) | Groq API (Llama 3.3 70B) | Latest |
| AI (Fallback) | Google Gemini API | 2.0 Flash |

---

## Setup & Running

### Prerequisites
- Docker & Docker Compose
- Python 3.11+
- Node.js 18+
- AWS account with S3 bucket
- Groq or Gemini API key (at least one for AI features; Groq free at [console.groq.com](https://console.groq.com))

### 1. Start Database

```bash
cd infra
docker compose up -d
```

### 2. Configure Environment

**Backend** — copy the example and fill in your values:

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string. For local Docker: `postgresql://welllog:welllogpass@localhost:5432/welllog_ai` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME` | S3 credentials and bucket for storing raw LAS files |
| `GROQ_API_KEY` | Optional. Free at [console.groq.com](https://console.groq.com) — enables AI interpretation & chat |
| `GEMINI_API_KEY` | Optional. Fallback for AI if Groq is not set. At least one of Groq or Gemini is needed for AI features |

**Frontend** (optional) — only if your backend runs at a different URL (e.g. production):

- Create `frontend/.env.local` with `NEXT_PUBLIC_API_URL=https://your-backend-url`

If unset, the frontend uses `http://localhost:8000`.

### 3. Start Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. (Optional) Sample LAS file

Use any `.las` well-log file to try the app. If you don't have one, search for "LAS file sample" or use public well-log datasets from state geological surveys or open data portals.

---

## Deployment

The recommended production setup is **Vercel (frontend)** + **Railway (backend + database)**.

### Backend & database (Railway)

1. Create a project at [railway.app](https://railway.app) and **Provision PostgreSQL**. Copy the `DATABASE_URL` (use the **public** connection URL, not the internal `postgres.railway.internal` one).
2. **New** → **GitHub Repo** → select this repo. Set **Root Directory** to `backend`.
3. **Variables**: add `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`, `GROQ_API_KEY` (and/or `GEMINI_API_KEY`).
4. **Settings** → set **Start Command** to: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. **Settings** → **Networking** → **Generate Domain**. Copy the backend URL (e.g. `https://your-app.up.railway.app`).

### Frontend (Vercel)

1. At [vercel.com](https://vercel.com), **Add New** → **Project** → import this repo.
2. Set **Root Directory** to `frontend`.
3. **Environment Variables** → add `NEXT_PUBLIC_API_URL` = your Railway backend URL (**no trailing slash**). Redeploy so the value is baked into the build.
4. Deploy and copy your Vercel URL (e.g. `https://your-app.vercel.app`).

### CORS

In `backend/app/main.py`, add your frontend origin(s) to `allow_origins`:

```python
allow_origins=[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://your-app.vercel.app",
    "https://www.yourdomain.com",   # custom domain
    "https://yourdomain.com",       # if you use both www and non-www
],
```

Commit and push so Railway redeploys. Without this, the browser will block API requests from your frontend (CORS error).

### Custom domain (Vercel)

1. **Vercel** → Project → **Settings** → **Domains** → add your domain (e.g. `www.yourdomain.com` or `yourdomain.com`).
2. Add the **CNAME** (for subdomains) or **A** record (for root) at your DNS provider as shown by Vercel. Wait for DNS to propagate; Vercel will issue SSL automatically.
3. Add the same origin(s) to `allow_origins` in `backend/app/main.py` (e.g. `https://www.yourdomain.com`) and redeploy the backend.

**Note:** `NEXT_PUBLIC_API_URL` is fixed at **build time**. If you change it in Vercel, you must **redeploy** the frontend for the change to take effect.

### Recovering from a database reset (e.g. Railway volume wipe)

If you wiped or recreated the Postgres volume, all tables and data are gone. The backend recreates tables automatically on **startup** only.

1. **Railway** → **Postgres** service: copy the current **public** `DATABASE_URL` (it may have changed after a reset).
2. **Railway** → **Backend** service → **Variables**: set `DATABASE_URL` to that value (update if it changed).
3. **Redeploy or restart the backend** (Deployments → ⋮ → **Redeploy**, or trigger a new deploy from GitHub). On startup, the app runs `Base.metadata.create_all` and recreates `las_files`, `curves`, and `curve_samples`. Uploads will work again; existing data will not return.

---

## Testing

Backend tests use `pytest` with a temporary SQLite database (no S3 calls, no real Postgres required).

```bash
cd backend
pip install -r requirements.txt
pytest -q
```

---

## Future Work (Production Hardening)

the next improvements would be:

- **Authentication & authorization**: protect endpoints (JWT/OAuth), multi-user isolation.
- **Rate limiting & abuse protection**: per-IP/user limits for upload, chat, and interpretation (return HTTP 429).
- **Background ingestion**: accept upload immediately, parse/insert asynchronously with job status + progress UI.
- **Database migrations**: replace `Base.metadata.create_all` with Alembic migrations for safe schema evolution.
- **Observability**: structured logging, request tracing, error monitoring (e.g., Sentry), metrics.
- **Performance**: server-side downsampling/decimation for plotting very large curves; caching for common ranges.
- **Security**: tighter CORS in production, file size limits, malware scanning for uploaded files.
- **Test coverage**: mocked S3 integration tests, end-to-end (E2E) UI tests, CI pipeline to run tests on PRs.

## Project Structure

```
well_log/
├── backend/
│   ├── app/
│   │   ├── api/              # REST endpoint handlers
│   │   │   ├── upload.py     # POST /api/upload-las (with duplicate detection)
│   │   │   ├── well.py       # GET /api/well/{id}
│   │   │   ├── curves.py     # GET /api/curves, /api/samples
│   │   │   ├── interpretation.py  # POST /api/interpret
│   │   │   ├── chat.py       # POST /api/chat (context-aware)
│   │   │   └── files.py      # GET /api/files (list uploads)
│   │   ├── core/             # Config, database, dependencies
│   │   ├── models/           # SQLAlchemy models (schema.py)
│   │   ├── services/         # Business logic
│   │   │   ├── las_parser.py         # LAS file parsing
│   │   │   ├── s3_service.py         # S3 upload
│   │   │   ├── interpretation_service.py  # AI + rule-based analysis
│   │   │   └── chat_service.py       # Chatbot logic
│   │   └── main.py           # FastAPI app entry point
│   ├── requirements.txt
│   └── .env
├── frontend/
│   ├── app/
│   │   ├── page.tsx          # Main dashboard (upload, viz, AI panel)
│   │   ├── layout.tsx        # Root layout
│   │   └── globals.css       # Dark theme styles
│   ├── components/           # PlotlyChart, PipelineAnimation (landing), shadcn UI
│   └── lib/
│       └── api.ts            # Backend API client (configurable URL)
├── infra/
│   ├── docker-compose.yml    # PostgreSQL + TimescaleDB
│   └── postgres-init.sql     # DB initialization (hypertable)
└── README.md
```

---


