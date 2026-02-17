import hashlib
import math
import os
import shutil
from typing import Optional, Sequence, Tuple

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session

from app.services.s3_service import upload_file_to_s3
from app.services.las_parser import parse_las_file
from app.core.deps import get_db
from app.models.schema import LasFile, Curve, CurveSample

router = APIRouter()


def _file_hash(path: str) -> str:
    """Compute SHA-256 hash of a file for duplicate detection."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _clean_value(x) -> Optional[float]:
    """Coerce to float and drop NaN/Inf."""
    if x is None:
        return None
    f = float(x)
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _bulk_insert_curve_samples(
    db: Session,
    curve_id: int,
    depth: Sequence[float],
    values: Sequence,
    batch_size: int = 10_000,
) -> None:
    """
    Fast bulk insert for curve_samples.

    - Postgres: uses psycopg2 execute_values for high throughput.
    - Other DBs (e.g. SQLite tests): falls back to SQLAlchemy bulk_insert_mappings.
    """
    dialect = getattr(getattr(db, "bind", None), "dialect", None)
    dialect_name = getattr(dialect, "name", "")

    if dialect_name == "postgresql":
        # Use DBAPI cursor for maximum insert speed
        try:
            from psycopg2.extras import execute_values  # type: ignore
        except Exception:
            execute_values = None  # type: ignore

        if execute_values is not None:
            conn = db.connection().connection  # DBAPI connection (psycopg2)
            with conn.cursor() as cur:
                sql = "INSERT INTO curve_samples (curve_id, depth, value) VALUES %s"
                batch: list[Tuple[int, float, Optional[float]]] = []
                for d, v in zip(depth, values):
                    batch.append((curve_id, float(d), _clean_value(v)))
                    if len(batch) >= batch_size:
                        execute_values(cur, sql, batch, page_size=len(batch))
                        batch.clear()
                if batch:
                    execute_values(cur, sql, batch, page_size=len(batch))
            return

    # Fallback: works across DB backends, slower but OK for tests/small files
    mappings: list[dict] = []
    for d, v in zip(depth, values):
        mappings.append({"curve_id": curve_id, "depth": float(d), "value": _clean_value(v)})
        if len(mappings) >= batch_size:
            db.bulk_insert_mappings(CurveSample, mappings)
            mappings.clear()
    if mappings:
        db.bulk_insert_mappings(CurveSample, mappings)


@router.post("/upload-las")
async def upload_las(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    # ── Validate extension ──
    if not file.filename or not file.filename.lower().endswith(".las"):
        raise HTTPException(status_code=400, detail="Only .las files are supported.")

    # ── Save to temp ──
    temp_path = f"/tmp/{file.filename}"
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save temp file: {e}")

    # ── Duplicate detection by content hash ──
    content_hash = _file_hash(temp_path)
    existing = (
        db.query(LasFile)
        .filter(LasFile.content_hash == content_hash)
        .first()
    )
    if existing:
        os.remove(temp_path)
        return {
            "message": "File already uploaded — loaded existing data.",
            "file_id": existing.id,
            "duplicate": True,
            "curves": [c.name for c in existing.curves],
        }

    # ── Parse LAS (validate before uploading to S3) ──
    try:
        depth, curves_meta, curve_data = parse_las_file(temp_path)
    except Exception as e:
        os.remove(temp_path)
        raise HTTPException(
            status_code=422,
            detail=f"Failed to parse LAS file: {e}. Ensure the file is a valid LAS 2.0 format.",
        )

    if not curves_meta:
        os.remove(temp_path)
        raise HTTPException(status_code=422, detail="LAS file contains no curve data.")

    # ── Upload raw LAS to S3 ──
    try:
        with open(temp_path, "rb") as f:
            s3_key = upload_file_to_s3(f, file.filename)
    except Exception as e:
        os.remove(temp_path)
        raise HTTPException(status_code=502, detail=f"S3 upload failed: {e}")

    # ── Store metadata in DB ──
    las_file = LasFile(
        filename=file.filename,
        s3_key=s3_key,
        content_hash=content_hash,
    )
    db.add(las_file)
    db.commit()
    db.refresh(las_file)

    # ── Store curves + samples ──
    inserted_curves = []

    for curve in curves_meta:
        curve_obj = Curve(
            las_file_id=las_file.id,
            name=curve["name"],
            unit=curve["unit"],
            description=curve["description"],
        )
        db.add(curve_obj)
        db.flush()

        inserted_curves.append(curve_obj.name)

        values = curve_data[curve_obj.name]
        _bulk_insert_curve_samples(db, curve_obj.id, depth, values)

    db.commit()

    # ── Cleanup ──
    try:
        os.remove(temp_path)
    except OSError:
        pass

    return {
        "message": "LAS file uploaded and parsed successfully.",
        "file_id": las_file.id,
        "duplicate": False,
        "curves": inserted_curves,
    }
