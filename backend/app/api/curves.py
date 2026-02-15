import math

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.models.schema import Curve, CurveSample

router = APIRouter()


def _safe_float(v):
    """Return None for NaN / Inf / None so JSON serialization never fails."""
    if v is None:
        return None
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


@router.get("/curves/{file_id}")
def get_curves(file_id: int, db: Session = Depends(get_db)):
    curves = (
        db.query(Curve)
        .filter(Curve.las_file_id == file_id)
        .all()
    )

    if not curves:
        raise HTTPException(status_code=404, detail=f"No curves found for file_id {file_id}.")

    return [
        {
            "id": c.id,
            "name": c.name,
            "unit": c.unit or "",
            "description": c.description or "",
        }
        for c in curves
    ]


@router.get("/samples/{curve_id}")
def get_samples(
    curve_id: int,
    start: float,
    end: float,
    db: Session = Depends(get_db),
):
    """Return depth-value samples for a curve in the given depth range."""
    # Validate curve exists
    curve = db.query(Curve).filter(Curve.id == curve_id).first()
    if not curve:
        raise HTTPException(status_code=404, detail=f"Curve with id {curve_id} not found.")

    if start > end:
        raise HTTPException(status_code=400, detail="'start' must be <= 'end'.")

    samples = (
        db.query(CurveSample)
        .filter(
            CurveSample.curve_id == curve_id,
            CurveSample.depth >= start,
            CurveSample.depth <= end,
        )
        .order_by(CurveSample.depth)
        .all()
    )
    return {
        "curve_name": curve.name,
        "unit": curve.unit or "",
        "count": len(samples),
        "data": [
            {"depth": _safe_float(s.depth), "value": _safe_float(s.value)}
            for s in samples
        ],
    }
