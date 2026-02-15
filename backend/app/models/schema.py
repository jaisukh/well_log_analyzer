from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base


class LasFile(Base):
    __tablename__ = "las_files"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    s3_key = Column(String, nullable=False)
    content_hash = Column(String, nullable=True, index=True)

    uploaded_at = Column(DateTime(timezone=True), server_default=func.now())

    curves = relationship("Curve", back_populates="las_file")


class Curve(Base):
    __tablename__ = "curves"

    id = Column(Integer, primary_key=True, index=True)

    las_file_id = Column(Integer, ForeignKey("las_files.id"))

    name = Column(String, nullable=False)       # GR, RHOB, etc.
    unit = Column(String, nullable=True)        # API, g/cc
    description = Column(String, nullable=True)

    las_file = relationship("LasFile", back_populates="curves")
    samples = relationship("CurveSample", back_populates="curve")


class CurveSample(Base):
    __tablename__ = "curve_samples"

    id = Column(Integer, primary_key=True)

    curve_id = Column(Integer, ForeignKey("curves.id"))

    depth = Column(Float, nullable=False)
    value = Column(Float, nullable=True)

    curve = relationship("Curve", back_populates="samples")

