FROM python:3.12-slim AS backend

WORKDIR /app

COPY pyproject.toml .
COPY citysim/ citysim/
COPY data/ data/
COPY run_backend.py .

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["python", "run_backend.py"]


FROM node:22-slim AS frontend

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ .

RUN npm run build

EXPOSE 8080

CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "8080"]
