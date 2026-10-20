import os

from flask import Flask, request

app = Flask(__name__)
AVATARS = os.path.realpath("avatars")


@app.post("/avatars")
def upload_avatar():
    user = os.path.basename(request.form["user"])
    with open(os.path.join(AVATARS, user, "avatar.png"), "wb") as handle:
        handle.write(request.files["image"].read())
    return {"saved": user}
