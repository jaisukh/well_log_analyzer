# WellLogAI — Subsurface Well-Log Analytics Platform

A full-stack web application for ingesting LAS (Log ASCII Standard) files, visualizing depth-indexed well-log curves, and performing AI-assisted petrophysical interpretation.

## Architecture Overview

```
┌──────────────────────┐       REST API        ┌──────────────────────────┐
│   Frontend (Next.js) │  ◄──────────────────►  │   Backend (FastAPI)      │
│   React 19 + Plotly  │   localhost:3000→8000   │   Python 3.11+           │
└──────────────────────┘                        └─────────┬────────────────┘
                                                          │
                                          ┌───────────────┼───────────────┐
                                          ▼               ▼               ▼
                                    ┌──────────┐   ┌──────────┐   ┌──────────┐
                                    │PostgreSQL │   │ Amazon S3│   │  AI APIs │
                                    │TimescaleDB│   │ (raw LAS)│   │Groq/Gemini│
                                    └──────────┘   └──────────┘   └──────────┘
```

**Frontend:** Next.js 16 (App Router) with React 19, Plotly.js for visualization, Shadcn UI components, Tailwind CSS dark theme.

**Backend:** FastAPI with SQLAlchemy ORM, serving REST APIs. All sensitive credentials (AWS keys, AI API keys, DB credentials) are stored server-side in `.env` — never exposed to the client.

**Infrastructure:** PostgreSQL + TimescaleDB via Docker Compose. Amazon S3 for raw file storage.

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

## Storage Strategy

| Data | Storage | Rationale |
|------|---------|-----------|
| **Original LAS file** | Amazon S3 (`las-files/{filename}`) | Preserves the raw file for re-parsing, audit, or download. S3 provides durable, scalable object storage. |
| **Parsed curve metadata** | PostgreSQL `curves` table | Enables fast lookups, categorization, and joins with sample data. |
| **Curve sample data** | PostgreSQL `curve_samples` hypertable | Optimized for the primary access pattern: "give me values for curve X between depth A and depth B." |

## Features

### 1. File Ingestion & Storage
- Drag-and-drop or file picker for `.las` files
- Original file uploaded to Amazon S3
- LAS file parsed using `lasio` library
- Curve metadata and depth-indexed samples stored in PostgreSQL/TimescaleDB
- NaN/Inf values sanitized to NULL on ingestion
- **Duplicate detection**: SHA-256 content hashing prevents re-processing the same file — returns existing data instantly
- **Previously uploaded files**: Landing page shows all previously uploaded wells for quick re-access
- **Granular upload progress**: Status updates at each stage (uploading, parsing, storing, loading metadata)

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

### 4. Chatbot Interface
- Floating chat panel with conversational interface
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

## Setup & Running

### Prerequisites
- Docker & Docker Compose
- Python 3.11+
- Node.js 18+
- AWS account with S3 bucket
- Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Start Database

```bash
cd infra
docker compose up -d
```

### 2. Configure Environment

```bash
cd backend
cp .env.example .env
# Edit .env with your actual credentials
```

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
│   ├── components/           # UI components (PlotlyChart, shadcn)
│   └── lib/
│       └── api.ts            # Backend API client (configurable URL)
├── infra/
│   ├── docker-compose.yml    # PostgreSQL + TimescaleDB
│   └── postgres-init.sql     # DB initialization (hypertable)
└── README.md
```
