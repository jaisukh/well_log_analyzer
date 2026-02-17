import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture(scope="session")
def test_db_url() -> str:
    # Use a file-based SQLite DB so multiple connections share state.
    # (In-memory SQLite requires a StaticPool and careful wiring.)
    fd, path = tempfile.mkstemp(prefix="welllogai_test_", suffix=".db")
    os.close(fd)
    return f"sqlite+pysqlite:///{path}"


@pytest.fixture(scope="session")
def app(test_db_url):
    # Ensure our DATABASE_URL wins over any local backend/.env file.
    os.environ["DATABASE_URL"] = test_db_url

    # Ensure `backend/` is on sys.path so `import app.*` works regardless of where pytest is invoked.
    backend_dir = Path(__file__).resolve().parents[1]
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    # Import after env is set.
    from app.main import app as fastapi_app  # noqa
    from app.core.deps import get_db
    from app.core.database import Base

    engine = create_engine(
        test_db_url,
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    fastapi_app.dependency_overrides[get_db] = override_get_db
    return fastapi_app


@pytest.fixture()
def client(app):
    return TestClient(app)

