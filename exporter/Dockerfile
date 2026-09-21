FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY exporter/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY exporter/*.py ./
CMD ["python", "export.py"]
