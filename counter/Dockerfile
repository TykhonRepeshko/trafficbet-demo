# TrafficBet automatic vehicle counter (CPU).
FROM python:3.12-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLCONFIGDIR=/tmp/matplotlib RF_HOME=/app/models/rfdetr MODELS_DIR=/app/models \
    OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 OMP_NUM_THREADS=1 OMP_THREAD_LIMIT=1 NUMEXPR_NUM_THREADS=1

# Tesseract reads the camera's burned-in timestamp (capture-time anchor).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && pip install --no-deps trackers==2.6.1

# Optional NVIDIA image; CPU remains portable and requires no GPU drivers.
ARG WITH_CUDA=0
RUN if [ "$WITH_CUDA" = "1" ]; then \
      pip uninstall -y onnxruntime \
      && pip install onnxruntime-gpu==1.31.1 \
        nvidia-cublas==13.8.2.12 nvidia-cuda-nvrtc==13.4.92 \
        nvidia-cuda-runtime==13.4.92 nvidia-cudnn-cu13==9.27.0.42 \
        nvidia-cufft==12.4.0.43 nvidia-curand==10.4.4.72 \
        nvidia-nvjitlink==13.4.92; \
    fi

# Detector weights are baked in and verified; the worker never downloads at runtime.
# YOLOX (Megvii, Apache-2.0) ONNX exports from the official 0.1.1rc0 release.
RUN mkdir -p /app/models && python - <<'PY'
import hashlib, urllib.request
models = {
    "yolox_tiny.onnx": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    "yolox_nano.onnx": "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d",
    "yolox_s.onnx": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
    "yolox_m.onnx": "21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f",
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
