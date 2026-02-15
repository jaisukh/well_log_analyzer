from typing import Optional, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db
from app.services.chat_service import chat

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    file_id: Optional[int] = None
    # Selection context: what the user is currently viewing
    selected_curve_names: Optional[List[str]] = None
    depth_start: Optional[float] = None
    depth_end: Optional[float] = None


@router.post("/chat")
def chat_endpoint(
    body: ChatRequest,
    db: Session = Depends(get_db),
):
    reply = chat(
        db,
        message=body.message,
        file_id=body.file_id,
        selected_curve_names=body.selected_curve_names,
        depth_start=body.depth_start,
        depth_end=body.depth_end,
    )
    return {"reply": reply}
