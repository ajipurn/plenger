FROM docker.io/library/python:3.12.13-slim-bookworm@sha256:3f9c7f75b916e8279e24136d7a57769aba9e193715be52570417698c52d6eed0
WORKDIR /opt/plenger
COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt
RUN mkdir -p /opt/plenger/project && chmod 0755 /opt/plenger/project
COPY --chmod=0444 qualify.py ./qualify.py
COPY --chmod=0444 worker.py ./worker.py
COPY --chmod=0444 project/agent.py ./project/agent.py
USER 65532:65532
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-I", "/opt/plenger/qualify.py"]
