FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY sim/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY sim/*.py ./
COPY db/schema.sql ./
CMD ["python", "simulate.py"]
