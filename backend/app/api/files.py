"""
GET /api/files — List all previously uploaded LAS files.
Enables users to switch between wells without re-uploading.
Deduplicates by filename, keeping only the most recent upload.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.core.deps import get_db
from app.models.schema import LasFile, Curve

router = APIRouter()


@router.get("/files")
def list_files(db: Session = Depends(get_db)):
    """Return deduplicated uploaded LAS files with curve counts.
    
    Groups by filename so duplicate uploads only appear once,
    using the most recent upload's id.
    """
    # Subquery: for each filename, get the latest file_id
    latest_sub = (
        db.query(
            LasFile.filename,
            func.max(LasFile.id).label("latest_id"),
        )
        .group_by(LasFile.filename)
        .subquery()
    )

    # Main query: join back to get full metadata + curve count
    rows = (
        db.query(
            LasFile.id,
            LasFile.filename,
            LasFile.uploaded_at,
            func.count(Curve.id).label("curve_count"),
        )
        .join(latest_sub, LasFile.id == latest_sub.c.latest_id)
        .outerjoin(Curve, Curve.las_file_id == LasFile.id)
        .group_by(LasFile.id, LasFile.filename, LasFile.uploaded_at)
        .order_by(LasFile.uploaded_at.desc())
        .all()
    )

    return [
        {
            "file_id": r.id,
            "filename": r.filename,
            "uploaded_at": r.uploaded_at.isoformat() if r.uploaded_at else None,
            "curve_count": r.curve_count,
        }
        for r in rows
    ]
