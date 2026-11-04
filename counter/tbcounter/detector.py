"""Vehicle detectors returning pixel-space boxes, confidences and vehicle class names.

* YOLOX (Megvii, Apache-2.0) via ONNX Runtime — default; fits the CPU budget of a Docker VM.
* RF-DETR (Roboflow, Apache-2.0 sizes Nano–Large only) — optional, for hosts with a GPU or a fast CPU.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np

from .evidence import DETECTOR, observation_source

VEHICLE_NAMES = ("car", "motorcycle", "bus", "truck", "vehicle")
YOLOX_COCO = {
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}  # contiguous 80-class COCO indices


@dataclass
class Detections:
    xyxy: np.ndarray  # (N, 4) float32 pixels
    confidence: np.ndarray  # (N,) float32
    labels: list[str]
    sources: list[str] | None = None

    def source_at(self, index: int) -> str:
        return observation_source(
            self.labels[index],
            self.sources[index] if self.sources is not None else None,
        )

    @staticmethod
    def empty() -> "Detections":
        return Detections(np.zeros((0, 4), np.float32), np.zeros((0,), np.float32), [])

    def __len__(self) -> int:
        return len(self.labels)


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> np.ndarray:
    """Class-agnostic NMS: one vehicle must not be counted twice as car and truck."""
    if len(boxes) == 0:
        return np.zeros((0,), np.int64)
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(x2 - x1, 0) * np.maximum(y2 - y1, 0)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(xx2 - xx1, 0) * np.maximum(yy2 - yy1, 0)
        overlap = inter / np.maximum(areas[i] + areas[order[1:]] - inter, 1e-6)
        order = order[1:][overlap <= iou]
    return np.array(keep, np.int64)


def complete_tile_detections(boxes, scores, clipped):
    """Prefer a measured complete body over its contained crop-edge fragment.

    Keep lone edge detections and separate neighbouring cars. A fragment is
    removed only when a non-clipped, larger detection covers at least 80% of it.
    Run before NMS so a high-scoring fragment cannot suppress the complete body.
    """
    keep = []
    for i, box in enumerate(boxes):
        if clipped[i]:
            area = max(0., box[2] - box[0]) * max(0., box[3] - box[1])
            supported = False
            for j, other in enumerate(boxes):
                if clipped[j] or scores[j] < 0.2:
                    continue
                other_area = max(0., other[2] - other[0]) * max(0., other[3] - other[1])
                intersection = max(0., min(box[2], other[2]) - max(box[0], other[0])) * max(
                    0., min(box[3], other[3]) - max(box[1], other[1])
                )
                if area > 0 and other_area >= area * 1.2 and intersection >= area * 0.8:
                    supported = True
                    break
            if supported:
                continue
        keep.append(i)
    return np.asarray(keep, dtype=np.int64)


class YoloxDetector:
    def __init__(
        self,
        path: str,
        threads: int,
        min_score: float = 0.1,
        nms_iou: float = 0.45,
        device: str = "cpu",
    ) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        providers = ["CPUExecutionProvider"]
        if device == "cuda":
            if "CUDAExecutionProvider" not in ort.get_available_providers():
                raise RuntimeError(
                    "CUDA was requested but ONNX Runtime has no CUDA provider"
                )
            ort.preload_dlls(cuda=True, cudnn=True, msvc=False, directory="")
            providers = [
                (
                    "CUDAExecutionProvider",
                    {
                        "gpu_mem_limit": 2 << 30,
                        "cudnn_conv_algo_search": "HEURISTIC",
                        "cudnn_conv_use_max_workspace": "0",
                    },
                ),
                "CPUExecutionProvider",
            ]
        self.session = ort.InferenceSession(path, options, providers=providers)
        if (
            device == "cuda"
            and "CUDAExecutionProvider" not in self.session.get_providers()
        ):
            raise RuntimeError(
                "CUDA provider failed to initialize; refusing a silent CPU fallback"
            )
        self.device = device
        self._inference_lock = threading.Lock()
        self.input = self.session.get_inputs()[0]
        _, _, self.h, self.w = self.input.shape
        self.min_score, self.nms_iou = min_score, nms_iou
        grids, strides = [], []
        for stride in (8, 16, 32):
            hs, ws = self.h // stride, self.w // stride
            xv, yv = np.meshgrid(np.arange(ws), np.arange(hs))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((hs * ws, 1), stride))
        self.grid = np.concatenate(grids).astype(np.float32)
        self.stride = np.concatenate(strides).astype(np.float32)
        self.class_index = np.array(list(YOLOX_COCO), np.int64)
        self.class_names = list(YOLOX_COCO.values())
        self.name = os.path.basename(path).removesuffix(".onnx").replace("_", "-")

    def detect(self, bgr: np.ndarray) -> Detections:
        ih, iw = bgr.shape[:2]
        ratio = min(self.h / ih, self.w / iw)
        resized = cv2.resize(
            bgr, (int(iw * ratio), int(ih * ratio)), interpolation=cv2.INTER_LINEAR
        )
        padded = np.full((self.h, self.w, 3), 114, np.uint8)
        padded[: resized.shape[0], : resized.shape[1]] = resized
        tensor = padded.transpose(2, 0, 1)[None].astype(
            np.float32
        )  # BGR, 0–255, as exported by YOLOX
        with self._inference_lock:
            out = self.session.run(None, {self.input.name: tensor})[0][0]
        scores = out[:, 4:5] * out[:, 5:][:, self.class_index]
        best = scores.max(1)
        keep = best >= self.min_score
        if not keep.any():
            return Detections.empty()
        out, scores, best = out[keep], scores[keep], best[keep]
        centers = (out[:, :2] + self.grid[keep]) * self.stride[keep]
        sizes = np.exp(out[:, 2:4]) * self.stride[keep]
        boxes = np.concatenate([centers - sizes / 2, centers + sizes / 2], 1) / ratio
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, iw - 1)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, ih - 1)
        idx = nms(boxes, best, self.nms_iou)
        labels = [self.class_names[int(i)] for i in scores[idx].argmax(1)]
        return Detections(
            boxes[idx].astype(np.float32),
            best[idx].astype(np.float32),
            labels,
            [DETECTOR] * len(labels),
        )


class RfdetrDetector:
    SIZES = {
        "rfdetr-nano": "RFDETRNano",
        "rfdetr-small": "RFDETRSmall",
        "rfdetr-medium": "RFDETRMedium",
        "rfdetr-large": "RFDETRLarge",
    }  # Apache-2.0 weights only

    def __init__(self, model: str, threads: int, min_score: float = 0.1) -> None:
        import rfdetr
        import torch
        from rfdetr.assets.coco_classes import COCO_CLASSES

        torch.set_num_threads(threads)
        self.model = getattr(rfdetr, self.SIZES[model])()
        self.names = {int(k): v for k, v in COCO_CLASSES.items()}
        self.min_score = min_score
        self.name = model

    def detect(self, bgr: np.ndarray) -> Detections:
        result = self.model.predict(
            cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB),
            threshold=self.min_score,
            include_source_image=False,
        )
        keep = [
            i
            for i, c in enumerate(result.class_id)
            if self.names.get(int(c)) in VEHICLE_NAMES
        ]
        if not keep:
            return Detections.empty()
        boxes = result.xyxy[keep].astype(np.float32)
        conf = result.confidence[keep].astype(np.float32)
        idx = nms(boxes, conf, 0.45)
        return Detections(
            boxes[idx],
            conf[idx],
            [self.names[int(result.class_id[keep][i])] for i in idx],
            [DETECTOR] * len(idx),
        )


def build(model: str, models_dir: str, threads: int, device: str = "cpu"):
    if model.startswith("yolox-"):
        return YoloxDetector(
            os.path.join(models_dir, model.replace("-", "_") + ".onnx"),
            threads,
            device=device,
        )
    return RfdetrDetector(model, threads)


# ---------- tiling: more pixels per vehicle for small/distant traffic ----------
Tile = tuple[int, int, int, int]  # x0, y0, x1, y1 in pixels


def _split(lo: int, hi: int, max_side: int, overlap: float) -> list[tuple[int, int]]:
    length = hi - lo
    n = max(1, int(np.ceil((length - max_side * overlap) / (max_side * (1 - overlap)))))
    if n == 1:
        return [(lo, hi)]
    size = int(np.ceil(length / (n - (n - 1) * overlap)))
    starts = np.linspace(lo, hi - size, n).round().astype(int)
    return [(int(s), int(s) + size) for s in starts]


def grid_tiles(
    width: int, height: int, nx: int = 2, ny: int = 2, overlap: float = 0.15
) -> list[Tile]:
    """Overlapping grid over the whole frame (used for calibration, before a line exists)."""
    tw, th = int(width / (nx - (nx - 1) * overlap)), int(
        height / (ny - (ny - 1) * overlap)
    )
    xs = np.linspace(0, width - tw, nx).round().astype(int)
    ys = np.linspace(0, height - th, ny).round().astype(int)
    return [(int(x), int(y), int(x) + tw, int(y) + th) for y in ys for x in xs]


def wide_tiles(width: int, height: int, overlap: int = 32) -> list[Tile]:
    """Two overlapping halves of the frame: lets tracks start where vehicles approach, well before the line."""
    half = width // 2
    return [
        (0, 0, min(width, half + overlap), height),
        (max(0, half - overlap), 0, width, height),
    ]


def line_tiles(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    width: int,
    height: int,
    margin: float = 0.25,
    max_side: int = 700,
    overlap: float = 0.12,
) -> list[Tile]:
    """Tiles covering the counting line plus a margin for approaching/leaving vehicles (normalised line input)."""
    mx, my = margin * height, margin * height
    left = int(max(min(x1, x2) * width - mx, 0))
    right = int(min(max(x1, x2) * width + mx, width))
    top = int(max(min(y1, y2) * height - my, 0))
    bottom = int(min(max(y1, y2) * height + my, height))
    return [
        (a, c, b, d)
        for c, d in _split(top, bottom, max_side, overlap)
        for a, b in _split(left, right, max_side, overlap)
    ]


class TiledDetector:
    """Runs the detector on tiles and merges the boxes. `secondary` tiles run only every `secondary_every`-th frame:
    they exist to start tracks early, and the tracker bridges the frames in between."""

    def __init__(
        self,
        base,
        tiles: list[Tile],
        nms_iou: float = 0.5,
        secondary: list[Tile] | None = None,
        secondary_every: int = 3,
    ) -> None:
        self.base, self.tiles, self.nms_iou = base, tiles, nms_iou
        self.secondary, self.secondary_every = secondary or [], max(1, secondary_every)
        self.frame = 0
        self.name = getattr(base, "name", "detector")

    def detect(self, bgr: np.ndarray) -> Detections:
        boxes, confs, labels, sources, clipped = [], [], [], [], []
        tiles = self.tiles + (
            self.secondary if self.frame % self.secondary_every == 0 else []
        )
        self.frame += 1
        for x0, y0, x1, y1 in tiles:
            out = self.base.detect(bgr[y0:y1, x0:x1])
            if len(out):
                global_boxes = out.xyxy + np.array([x0, y0, x0, y0], np.float32)
                boxes.append(global_boxes)
                height, width = bgr.shape[:2]
                clipped.extend(
                    (x0 > 0 and b[0] <= x0 + 1)
                    or (y0 > 0 and b[1] <= y0 + 1)
                    or (x1 < width and b[2] >= x1 - 1)
                    or (y1 < height and b[3] >= y1 - 1)
                    for b in global_boxes
                )
                confs.append(out.confidence)
                labels.extend(out.labels)
                sources.extend(out.source_at(i) for i in range(len(out)))
        if not boxes:
            return Detections.empty()
        xyxy, conf = np.concatenate(boxes), np.concatenate(confs)
        complete = complete_tile_detections(xyxy, conf, clipped)
        keep = complete[nms(xyxy[complete], conf[complete], self.nms_iou)]
        return Detections(
            xyxy[keep],
            conf[keep],
            [labels[i] for i in keep],
            [sources[i] for i in keep],
        )
