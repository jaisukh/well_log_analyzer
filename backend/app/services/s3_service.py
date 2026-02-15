import boto3
from app.core.config import (
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    S3_BUCKET_NAME,
)

s3_client = boto3.client(
    "s3",
    region_name=AWS_REGION,
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
)


def upload_file_to_s3(file_obj, filename: str) -> str:
    """
    Upload LAS file to S3 and return the S3 object key
    """

    s3_key = f"las-files/{filename}"

    s3_client.upload_fileobj(
        file_obj,
        S3_BUCKET_NAME,
        s3_key
    )

    return s3_key
