FROM docker.io/library/python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
# Shared libraries that common scientific wheels (FAISS, scikit-learn) link against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/plenger
# The project's declared dependencies, written into the build context by the host.
COPY project-requirements.txt ./project-requirements.txt
# Wheels only: no source distribution runs its own setup during the build.
RUN python -m pip install --no-cache-dir --only-binary=:all: -r project-requirements.txt \
 && python -m pip list --format=json > /opt/plenger/resolved.json \
 && chmod 0444 /opt/plenger/resolved.json
# Create the directory first: --chmod would otherwise apply 0444 to it and block traversal.
RUN mkdir -p /opt/plenger/adapters && chmod 0755 /opt/plenger/adapters
COPY --chmod=0444 preflight.py ./preflight.py
COPY --chmod=0444 worker.py ./worker.py
COPY --chmod=0444 adapters/llmfy_0_6_0.py ./adapters/llmfy_0_6_0.py
USER 65532:65532
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-I", "/opt/plenger/worker.py"]
