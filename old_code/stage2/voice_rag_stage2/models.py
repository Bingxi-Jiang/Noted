from typing import Optional
from pydantic import BaseModel


class AskRequest(BaseModel):
    session_id: str
    question: str


class NewSessionRequest(BaseModel):
    title: Optional[str] = None


class SummaryRequest(BaseModel):
    session_id: str
