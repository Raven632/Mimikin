# Служба распознавания текста на картинках (ocr/server.py). Два этапа: модели качаются и сжимаются при сборке
# (onnx нужен только для сжатия — в итоговый образ не попадает), в итоговом — Python, onnxruntime и модели.
# Без PyTorch и без видеокарты: всё на процессоре, x86 и ARM
FROM python:3.12-slim AS models
RUN pip install --no-cache-dir onnx==1.23.2 onnxruntime==1.30.0
COPY fetch_models.py /tmp/fetch_models.py
RUN python /tmp/fetch_models.py /models

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OCR_MODELS=/models
WORKDIR /app
COPY requirements.txt ./
# Свои модели rapidocr (они в пакете) не нужны: служба берёт закреплённые из /models
RUN pip install --no-cache-dir -r requirements.txt && rm -rf /usr/local/lib/python3.12/site-packages/rapidocr/models/*
COPY --from=models /models /models
COPY manga.py pipeline.py server.py ./
# Без прав root: службе нужно только читать свои файлы
USER nobody
EXPOSE 8000
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)"
CMD ["python", "server.py"]
