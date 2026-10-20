from flask import request

HOSTS = {"db": "db.internal", "cache": "cache.internal"}


def requested_host() -> str:
    return HOSTS.get(request.args.get("host", ""), "localhost")
