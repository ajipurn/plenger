import os
import pickle
import subprocess

import requests
import zmq

CACHE = os.path.realpath("cache")


def evaluate_remote(url):
    return eval(requests.get(url, timeout=30).text)


def load_remote_model(url):
    return pickle.loads(requests.get(url, timeout=30).content)


def mirror_artifacts(url):
    for item in requests.get(url, timeout=30).json()["files"]:
        with open(os.path.join(CACHE, item["path"]), "wb") as handle:
            handle.write(b"")


def run_remote_job(url):
    job = requests.get(url, timeout=30).json()
    subprocess.run(job["command"], shell=True)


def cache_latest(url):
    data = requests.get(url, timeout=30).json()
    with open(os.path.join(CACHE, "latest.json"), "w") as handle:
        handle.write(str(data))
    return data


class Pipe:
    def __init__(self, port):
        self.socket = zmq.Context().socket(zmq.PULL)
        self.socket.bind(f"tcp://*:{port}")

    def recv_bytes(self):
        return self.socket.recv()

    def recv_object(self):
        return pickle.loads(self.recv_bytes())
