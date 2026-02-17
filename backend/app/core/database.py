from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from dotenv import load_dotenv

# Load .env file (do not override real environment variables, e.g. CI/prod/tests)
load_dotenv(override=False)

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set. Create backend/.env from .env.example or set env vars in your host.")

# SQLite (tests/dev) doesn't support Postgres pool settings; keep it minimal.
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,        # test connections before using them
        pool_recycle=300,           # recycle connections every 5 min
        pool_size=5,
        max_overflow=10,
    )

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()



