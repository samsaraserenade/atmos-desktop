# Atmos portfolio server: the API and the collectors, standard library only.
# Used by compose.yaml; see "Running with Docker" in README.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ATMOS_PORTFOLIO_HOST=0.0.0.0 \
    ATMOS_PORTFOLIO_PORT=8787 \
    ATMOS_PORTFOLIO_DB=/data/portfolio.sqlite3 \
    ATMOS_PORTFOLIO_SOURCES=/config/sources.json

RUN install -d -o 10001 -g 10001 -m 0700 /data

WORKDIR /app
COPY server.py collectors.py ./

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=4)"]

CMD ["python", "/app/server.py", "serve"]
