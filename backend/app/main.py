from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.database import engine, Base


from app.api.upload import router as upload_router
from app.api.curves import router as curves_router
from app.api.interpretation import router as interpretation_router
from app.api.chat import router as chat_router
from app.api.well import router as well_router
from app.api.files import router as files_router

app = FastAPI(
    title="WellLogAI Backend",
    version="1.0.0",
    description="Full-stack subsurface well-log data analysis platform with AI interpretation",
)

Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload_router, prefix="/api")
app.include_router(curves_router, prefix="/api")
app.include_router(interpretation_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(well_router, prefix="/api")
app.include_router(files_router, prefix="/api")


@app.get("/")
def root():
    return {"status": "ok", "message": "WellLogAI Backend running"}


@app.get("/api/health")
def health_check():
    """Health check endpoint for monitoring."""
    return {"status": "healthy", "version": "1.0.0"}
