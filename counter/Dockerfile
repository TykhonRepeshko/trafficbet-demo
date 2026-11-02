# TrafficBet automatic vehicle counter (CPU).
FROM python:3.12-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLCONFIGDIR=/tmp/matplotlib RF_HOME=/app/models/rfdetr MODELS_DIR=/app/models

# Tesseract reads the camera's burned-in timestamp (capture-time anchor).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && pip install --no-deps trackers==2.6.1

# Detector weights are baked in and verified; the worker never downloads at runtime.
# YOLOX (Megvii, Apache-2.0) ONNX exports from the official 0.1.1rc0 release.
RUN mkdir -p /app/models && python - <<'PY'
import hashlib, urllib.request
models = {
    "yolox_tiny.onnx": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    "yolox_nano.onnx": "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d",
}
for name, digest in models.items():
    url = f"https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/{name}"
    data = urllib.request.urlopen(url, timeout=300).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f"checksum mismatch for {name}")
    open(f"/app/models/{name}", "wb").write(data)
PY

# Optional RF-DETR backend (Apache-2.0 sizes only) for GPU / fast-CPU hosts:
#   docker build --build-arg WITH_RFDETR=1 --build-arg RFDETR_SIZE=RFDETRSmall ...
ARG WITH_RFDETR=0
ARG RFDETR_SIZE=RFDETRSmall
RUN if [ "$WITH_RFDETR" = "1" ]; then \
      pip install torch==2.15.0 torchvision==0.29.2 --index-url https://download.pytorch.org/whl/cpu \
      && pip install rfdetr==1.11.2 \
      && pip uninstall -y opencv-python 2>/dev/null; pip install --force-reinstall --no-deps opencv-python-headless==4.14.0.94 \
      && python -c "import rfdetr; getattr(rfdetr, '${RFDETR_SIZE}')()"; \
    fi

COPY tbcounter ./tbcounter
COPY tests ./tests
COPY dev ./dev
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin counter
USER 10001:10001
CMD ["python", "-m", "tbcounter"]
