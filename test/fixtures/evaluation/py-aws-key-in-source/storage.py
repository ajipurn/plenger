import boto3

AWS_ACCESS_KEY_ID = "AKIAZ7Q3W9R2T5Y8U1P4"

s3 = boto3.client("s3", aws_access_key_id=AWS_ACCESS_KEY_ID)
