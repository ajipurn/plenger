FROM debian:bookworm-slim
ARG PHP_BRANCH=8.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      php${PHP_BRANCH}-cli php${PHP_BRANCH}-redis \
 && rm -rf /var/lib/apt/lists/*
CMD ["php", "/app/worker.php"]
