from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.core.deps import get_db
from app.models.schema import LasFile, Curve, CurveSample

router = APIRouter()


@router.get("/well/{file_id}")
def get_well_metadata(file_id: int, db: Session = Depends(get_db)):
    """Return well metadata: filename, depth range, curve count, curve categories."""
    las = db.query(LasFile).filter(LasFile.id == file_id).first()
    if not las:
        raise HTTPException(status_code=404, detail=f"Well file with id {file_id} not found.")

    curves = (
        db.query(Curve).filter(Curve.las_file_id == file_id).all()
    )

    # Get global depth range across all curves
    depth_row = (
        db.query(
            func.min(CurveSample.depth).label("min_depth"),
            func.max(CurveSample.depth).label("max_depth"),
        )
        .join(Curve, CurveSample.curve_id == Curve.id)
        .filter(Curve.las_file_id == file_id)
        .first()
    )

    min_depth = float(depth_row.min_depth) if depth_row and depth_row.min_depth else 0
    max_depth = float(depth_row.max_depth) if depth_row and depth_row.max_depth else 5000

    # Group curves by a simple category heuristic
    categories: dict[str, list] = {}
    for c in curves:
        name_lower = c.name.lower()
        if "cal" in name_lower:
            cat = "Caliper"
        elif "gr" in name_lower or "gamma" in name_lower:
            cat = "Gamma Ray"
        elif "res" in name_lower or "rt" in name_lower or "ild" in name_lower or "ils" in name_lower:
            cat = "Resistivity"
        elif "rho" in name_lower or "den" in name_lower or "rhob" in name_lower:
            cat = "Density"
        elif "nphi" in name_lower or "neu" in name_lower or "por" in name_lower:
            cat = "Porosity"
        elif "dt" in name_lower or "sonic" in name_lower:
            cat = "Sonic"
        elif "sp" == name_lower:
            cat = "SP"
        elif "dept" in name_lower or "depth" in name_lower:
            cat = "Depth"
        else:
            cat = "Other"

        if cat not in categories:
            categories[cat] = []
        categories[cat].append({
            "id": c.id,
            "name": c.name,
            "unit": c.unit or "",
            "description": c.description or "",
        })

    return {
        "file_id": las.id,
        "filename": las.filename,
        "total_curves": len(curves),
        "min_depth": min_depth,
        "max_depth": max_depth,
        "depth_unit": "F",  # from the LAS data
        "categories": categories,
    }
