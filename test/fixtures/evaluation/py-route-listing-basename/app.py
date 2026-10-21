import os

from flask import Flask, jsonify, request

app = Flask(__name__)
UPLOADS_DIR = os.path.realpath("uploads")


@app.get("/uploads/list")
def list_uploads():
    folder = os.path.basename(request.args.get("folder", ""))
    return jsonify(sorted(os.listdir(os.path.join(UPLOADS_DIR, folder))))
