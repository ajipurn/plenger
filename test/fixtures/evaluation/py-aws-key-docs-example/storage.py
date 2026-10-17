import boto3

# The documented example key, as in the AWS guides; the real key comes from the environment.
EXAMPLE_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"

s3 = boto3.client("s3")
