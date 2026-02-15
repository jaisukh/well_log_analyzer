import hashlib
import math
import os
import shutil

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

    def _clean(x):
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f

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
        samples = [
            CurveSample(
                curve_id=curve_obj.id,
                depth=float(d),
                value=_clean(v),
            )
            for d, v in zip(depth, values)
        ]
        db.bulk_save_objects(samples)

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
