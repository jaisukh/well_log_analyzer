from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.models.schema import LasFile
from app.services.interpretation_service import get_interpretation

router = APIRouter()


class InterpretationRequest(BaseModel):
    file_id: int
    depth_start: float
    depth_end: float
    curve_ids: list[int]


@router.post("/interpret")
def interpret(
    body: InterpretationRequest,
    db: Session = Depends(get_db),
):
    # Validate inputs
    if not body.curve_ids:
        raise HTTPException(status_code=400, detail="At least one curve_id is required.")

    if body.depth_start > body.depth_end:
        raise HTTPException(status_code=400, detail="depth_start must be <= depth_end.")

    las = db.query(LasFile).filter(LasFile.id == body.file_id).first()
    if not las:
        raise HTTPException(status_code=404, detail=f"Well file with id {body.file_id} not found.")

    try:
        result = get_interpretation(
            db,
            file_id=body.file_id,
            depth_start=body.depth_start,
            depth_end=body.depth_end,
            curve_ids=body.curve_ids,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Interpretation failed: {str(e)}")
