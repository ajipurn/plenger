from flask import request


def requested_host() -> str:
    return request.args.get("host", "localhost")
