# syntax=docker/dockerfile:1
FROM python:3.12-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libvulkan1 \
        mesa-vulkan-drivers \
        vulkan-tools \
        libgomp1 \
        ca-certificates \
        curl \
        unzip \
        passwd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend/app /app/app
COPY backend/scripts/fetch_models.sh /app/scripts/fetch_models.sh
RUN chmod +x /app/scripts/fetch_models.sh \
    && /app/scripts/fetch_models.sh /app/models

COPY frontend /app/frontend

RUN useradd --system --uid 10001 --gid root --shell /usr/sbin/nologin rve \
    && mkdir -p /data /tmp/.cache \
    && chown -R rve:root /data /app /tmp/.cache

USER rve

ENV DATA_DIR=/data \
    MODEL_DIR=/app/models \
    FRONTEND_DIR=/app/frontend \
    MAX_ACTIVE_JOBS=1 \
    MAX_QUEUE=25 \
    MAX_UPLOAD_MB=1024 \
    MIN_FREE_GB=3 \
    RETENTION_HOURS=72 \
    RIFE_THREADS=4 \
    LOG_LEVEL=INFO

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

STOPSIGNAL SIGTERM

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--limit-concurrency", "128", "--timeout-keep-alive", "5"]
