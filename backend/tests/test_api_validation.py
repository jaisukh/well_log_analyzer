def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "healthy"


def test_upload_rejects_non_las(client):
    # Extension validation happens before any parsing/S3/DB writes
    res = client.post(
        "/api/upload-las",
        files={"file": ("not_a_las.txt", b"hello", "text/plain")},
    )
    assert res.status_code == 400
    assert "Only .las files" in res.json()["detail"]


def test_interpret_requires_curve_ids(client):
    res = client.post(
        "/api/interpret",
        json={
            "file_id": 1,
            "depth_start": 0.0,
            "depth_end": 10.0,
            "curve_ids": [],
        },
    )
    assert res.status_code == 400
    assert "curve_id" in res.json()["detail"]


def test_well_metadata_not_found(client):
    res = client.get("/api/well/999999")
    assert res.status_code == 404


def test_samples_curve_not_found(client):
    res = client.get("/api/samples/999999?start=0&end=10")
    assert res.status_code == 404


def test_samples_start_must_be_lte_end(client, app):
    # Need a valid curve to reach the start/end validation (curve existence is checked first)
    from app.models.schema import LasFile, Curve
    from app.core.deps import get_db as real_get_db

    # Use the overridden get_db dependency to obtain a session
    override_get_db = app.dependency_overrides[real_get_db]
    db = next(override_get_db())
    try:
        las = LasFile(filename="t.las", s3_key="s3://dummy", content_hash="x")
        db.add(las)
        db.commit()
        db.refresh(las)

        curve = Curve(las_file_id=las.id, name="GR", unit="API", description="")
        db.add(curve)
        db.commit()
        db.refresh(curve)
    finally:
        db.close()

    res = client.get(f"/api/samples/{curve.id}?start=10&end=0")
    assert res.status_code == 400
    assert "start" in res.json()["detail"]

