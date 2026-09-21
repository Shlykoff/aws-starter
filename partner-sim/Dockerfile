# syntax=docker/dockerfile:1
#
# The build context is the REPOSITORY ROOT (docker-compose.yml says `context: ..`), so that
# contracts/xsd/ can be copied in below as this application's own copy of the schemas.
# Built by hand:   docker build -f partner-sim/Dockerfile -t partner-sim .   (run from the root)

# A slim Debian-based image, pinned to an exact Python version. lxml comes as a ready-made
# wheel, so no compiler and no libxml2 headers are needed in the image.
FROM python:3.13.15-slim-trixie AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

WORKDIR /app

# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY partner-sim/requirements.txt ./
RUN pip install -r requirements.txt

# The schemas this recipient validates against: its own copy, taken at build time. It is
# read from disk at start-up (SCHEMA_DIR); nothing is ever fetched from a URL.
COPY contracts/xsd/ /app/schemas/
# The code, and with it the database schema: app/migrations/*.sql. The application refuses to
# start if that folder is empty, so a build that forgot it fails at once, not silently.
COPY partner-sim/app/ /app/app/

# A user with no login shell and no home. It owns /data (the database) and nothing else:
# the code and the schemas stay owned by root, so the running process cannot change them.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && mkdir /data \
 && chown app:app /data

# PARTNER_API_KEY, UI_USER and UI_PASSWORD are deliberately NOT set here: an image with a
# default key would ship a published secret. The application refuses to start without them.
ENV SCHEMA_DIR=/app/schemas \
    DB_PATH=/data/partner.db


# --- Tests: `docker compose --profile tests run --rm tests` ---------------------------------
# Not the default stage, so pytest and ruff never end up in the image that runs the service.
FROM base AS test
# The compose file makes this container's filesystem read-only, except /tmp: ruff's cache goes there.
ENV RUFF_CACHE_DIR=/tmp/ruff-cache
COPY partner-sim/requirements-dev.txt partner-sim/pyproject.toml ./
RUN pip install -r requirements-dev.txt
COPY partner-sim/tests/ /app/tests/
USER app
CMD ["pytest"]


# --- The service (the last stage, so a plain `docker build` produces this one) ---------------
FROM base AS runtime
VOLUME /data
USER app
EXPOSE 8080

# python is already in the image, and curl is not. urlopen raises on any status other than 2xx.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]

# --factory: uvicorn calls create_app_from_env(), which reads the environment, checks it, and
# exits with a clear message if something is missing.
CMD ["uvicorn", "--factory", "app.main:create_app_from_env", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
