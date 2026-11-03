"""Offline YOLOX pilot: reviewed session splits, bounded GPU training, box evaluation.

Optional training dependencies and the official YOLOX source are separate from
the serving image. No API client, database or automatic model installation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from pathlib import Path


def records(path: Path):
    data = json.loads(path.read_text())
    result = [r for r in data["records"] if not r.get("excludeReason")]
    hashes = {}
    sessions = {}
    for row in result:
        if not row.get("reviewed") or row.get("boxes") is None:
            raise ValueError("Every included frame must be reviewed before training")
        if row.get("partialLabels", False) and not row["boxes"]:
            raise ValueError("A partially labelled empty frame is not verified background")
        split = row["split"]
        if split not in ("train", "val", "test"):
            raise ValueError("Unknown data split")
        if hashes.setdefault(row["sha256"], split) != split:
            raise ValueError("The same image occurs in different splits")
        if sessions.setdefault((row["source"], row["camera"]), split) != split:
            raise ValueError("A source session occurs in different splits")
        image = path.parent / row["file"]
        if image.resolve().is_relative_to(path.parent.resolve()) is False:
            raise ValueError("Image path escapes the dataset")
        if hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise ValueError("Source image changed after annotation")
    if not all(
        any(r["split"] == split for r in result) for split in ("train", "val", "test")
    ):
        raise ValueError("Separate train, validation and test sessions are required")
    return result


def sample(root, row):
    import cv2
    import numpy as np

    image = cv2.imread(str(root / row["file"]))
    if image is None:
        raise ValueError("Cannot decode annotated frame")
    top = int(row["roiTop"])
    image = image[top:].copy()
    boxes = []
    for x1, y1, x2, y2 in row["boxes"]:
        y1, y2 = max(y1 - top, 0), max(y2 - top, 0)
        if x2 - x1 >= 5 and y2 - y1 >= 5:
            boxes.append([x1, y1, x2, y2])
    return image, np.array(boxes, np.float32).reshape(-1, 4)


def predict_tiled(model, image, classes, threshold=0.3):
    """Evaluate native-size crops instead of shrinking the entire road to 640px."""
    import numpy as np
    from tbcounter.detector import nms, _split

    h, w = image.shape[:2]
    boxes, scores = [], []
    for y1, y2 in _split(0, h, 640, 0.25):
        for x1, x2 in _split(0, w, 640, 0.25):
            detected, confidence = predict(model, image[y1:y2, x1:x2], classes, threshold)
            boxes.extend(detected + np.array([x1, y1, x1, y1]))
            scores.extend(confidence)
    boxes = np.asarray(boxes, np.float32).reshape(-1, 4)
    scores = np.asarray(scores, np.float32)
    keep = nms(boxes, scores, 0.45)
    return boxes[keep], scores[keep]


def tensor_image(image, size=640):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    ratio = min(size / height, size / width)
    canvas = np.full((size, size, 3), 114, np.uint8)
    resized = cv2.resize(image, (int(width * ratio), int(height * ratio)))
    canvas[: resized.shape[0], : resized.shape[1]] = resized
    return np.ascontiguousarray(canvas.transpose(2, 0, 1), dtype=np.float32), ratio


def make_model(checkpoint, classes=1):
    import torch
    from yolox.models import YOLOX, YOLOPAFPN, YOLOXHead

    model = YOLOX(YOLOPAFPN(0.33, 0.5), YOLOXHead(classes, 0.5))
    for module in model.modules():
        if isinstance(module, torch.nn.BatchNorm2d):
            module.eps, module.momentum = 1e-3, 0.03
    model.head.initialize_biases(1e-2)
    with torch.serialization.safe_globals([torch.torch_version.TorchVersion]):
        saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state = saved.get("model", saved)
    if classes == 1:
        for key in list(state):
            if "head.cls_preds." in key and state[key].shape[0] == 80:
                state[key] = state[key][[2, 3, 5, 7]].mean(dim=0, keepdim=True)
    model.load_state_dict(state, strict=True)
    return model


def predict(model, image, classes, threshold=0.3):
    import numpy as np
    import torch
    from tbcounter.detector import nms

    data, ratio = tensor_image(image)
    with torch.inference_mode():
        result = model(torch.from_numpy(data)[None].cuda())[0].float().cpu().numpy()
    scores = result[:, 4] * (
        result[:, 5] if classes == 1 else result[:, [7, 8, 10, 12]].max(1)
    )
    selected = scores >= threshold
    result, scores = result[selected], scores[selected]
    if not len(result):
        return np.zeros((0, 4)), np.zeros(0)
    boxes = (
        np.concatenate(
            [result[:, :2] - result[:, 2:4] / 2, result[:, :2] + result[:, 2:4] / 2], 1
        )
        / ratio
    )
    boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, image.shape[1] - 1)
    boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, image.shape[0] - 1)
    keep = nms(boxes, scores, 0.45)
    return boxes[keep], scores[keep]


def evaluate(model, rows, root, classes=1, tiled=False):
    import numpy as np

    model.eval()
    tp = fp = fn = unverified = 0
    per_image = []
    for row in rows:
        image, truth = sample(root, row)
        boxes, scores = (predict_tiled if tiled else predict)(model, image, classes)
        matched = set()
        good = 0
        for index in scores.argsort()[::-1]:
            box = boxes[index]
            candidates = []
            for n, gt in enumerate(truth):
                if n in matched:
                    continue
                overlap = np.maximum(
                    np.minimum(box[2:], gt[2:]) - np.maximum(box[:2], gt[:2]), 0
                ).prod()
                union = np.prod(box[2:] - box[:2]) + np.prod(gt[2:] - gt[:2]) - overlap
                candidates.append((overlap / max(union, 1), n))
            if candidates and max(candidates)[0] >= 0.5:
                matched.add(max(candidates)[1])
                good += 1
        tp += good
        if row.get("partialLabels", False):
            unverified += len(boxes) - good
        else:
            fp += len(boxes) - good
        fn += len(truth) - good
        per_image.append(
            {
                "id": row["id"],
                "truth": len(truth),
                "detected": len(boxes),
                "truePositive": good,
            }
        )
    precision, recall = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    return {
        "frames": len(rows),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(2 * precision * recall / max(precision + recall, 1e-9), 4),
        "iouThreshold": 0.5,
        "scoreThreshold": 0.3,
        "nativeTiles": tiled,
        "unverifiedPredictionsOnPartialFrames": unverified,
        "completeFrames": sum(not r.get("partialLabels", False) for r in rows),
        "scoring": "Known-positive recall and FP on complete frames; other predictions on partial frames are unscored.",
        "precisionScope": "Partial-label diagnostic only, not whole-scene precision or mAP",
        "images": per_image,
    }


def partial_objectness_loss(original):
    """Do not teach unlabelled vehicles to be background on partial images.

    Pinned YOLOX get_losses calls this BCE for objectness, then classification.
    Classification and every assigned positive retain their original gradients.
    The wrapper has no parameters/buffers, so exported model weights are unchanged.
    """
    import torch

    class PartialBCE(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.original = original
            self.partial = None
            self.anchors = 0
            self.calls = 0

        def set_batch(self, flags, anchors):
            self.partial = tuple(bool(v) for v in flags)
            self.anchors, self.calls = anchors, 0

        def forward(self, prediction, target):
            loss = self.original(prediction, target)
            self.calls += 1
            if self.calls != 1 or self.partial is None:
                return loss
            expected = (len(self.partial) * self.anchors, 1)
            if tuple(loss.shape) != expected:
                raise ValueError(
                    "Unexpected YOLOX loss order/anchor shape; refusing partial-label training"
                )
            partial = torch.tensor(self.partial, device=loss.device)
            partial = partial.repeat_interleave(self.anchors)[:, None]
            keep = ~partial | (target > 0.5)
            return loss * keep.to(loss.dtype)

    return PartialBCE()


def train(args):
    import cv2
    import numpy as np
    import torch

    random.seed(91)
    np.random.seed(91)
    torch.manual_seed(91)
    torch.set_num_threads(4)
    cv2.setNumThreads(1)
    if not torch.cuda.is_available():
        raise RuntimeError("This bounded pilot requires CUDA; no silent CPU fallback")
    torch.cuda.set_per_process_memory_fraction(0.75)
    rows = records(args.annotations)
    training = [r for r in rows if r["split"] == "train"]
    validation = [r for r in rows if r["split"] == "val"]
    root = args.annotations.parent
    args.output.mkdir(parents=True, exist_ok=True)
    model = make_model(args.pretrained).cuda()
    partial_bce = partial_objectness_loss(model.head.bcewithlog_loss)
    model.head.bcewithlog_loss = partial_bce
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(args.unfreeze_backbone or name.startswith("head."))
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=args.lr,
        weight_decay=0.0005,
    )
    scaler = torch.amp.GradScaler("cuda")
    annotation_hash = hashlib.sha256(args.annotations.read_bytes()).hexdigest()
    manifest = {
        "seed": 91,
        "annotationSha256": annotation_hash,
        "trainingFrames": len(training),
        "validationFrames": len(validation),
        "testFrames": sum(r["split"] == "test" for r in rows),
        "steps": args.steps,
        "batch": args.batch,
        "lr": args.lr,
        "frozenBackbone": not args.unfreeze_backbone,
        "classes": ["vehicle"],
        "selection": "partial-label validation F1 at IoU .5, score .3; unverified predictions are reported separately; test never selects weights",
        "gpu": torch.cuda.get_device_name(0),
        "torch": str(torch.__version__),
        "pretrainedSha256": hashlib.sha256(args.pretrained.read_bytes()).hexdigest(),
        "partialTrainingFrames": sum(r.get("partialLabels", False) for r in training),
        "partialPolicy": "Ignore negative objectness on partial frames; keep known positives and all losses on complete frames.",
        "nativeTileEvaluation": args.tile_evaluation,
        "cropRange": [args.crop_min, args.crop_max],
        "negativeAugmentation": "Same native crop scale distribution as positives",
        "positiveFraction": args.positive_fraction,
        "balancedNegativeCameras": args.balanced_negative_cameras,
    }
    (args.output / "run.json").write_text(json.dumps(manifest, indent=2))
    best, history, began = -1, [], time.monotonic()
    cache = {row["id"]: sample(root, row) for row in training}
    positive = [r for r in training if r["boxes"]]
    negative = [r for r in training if not r["boxes"]]
    negative_cameras = [
        [r for r in negative if r["camera"] == camera]
        for camera in sorted({r["camera"] for r in negative})
    ]
    for step in range(1, args.steps + 1):
        model.train()
        model.backbone.eval()
        for module in model.modules():
            if isinstance(module, torch.nn.BatchNorm2d):
                module.eval()
        batch_images, batch_labels = [], []
        batch_rows = []
        for _ in range(args.batch):
            if positive and negative and args.positive_fraction is not None:
                if random.random() < args.positive_fraction:
                    pool = positive
                else:
                    pool = (
                        random.choice(negative_cameras)
                        if args.balanced_negative_cameras else negative
                    )
            else:
                pool = training
            batch_rows.append(random.choice(pool))
        for row in batch_rows:
            original, annotated = cache[row["id"]]
            image, boxes = original.copy(), annotated.copy()
            if random.random() < 0.5:
                image = image[:, ::-1].copy()
                if len(boxes):
                    boxes[:, [0, 2]] = image.shape[1] - boxes[:, [2, 0]]
            image = np.clip(
                image.astype(np.float32) * random.uniform(0.75, 1.25), 0, 255
            ).astype(np.uint8)
            if random.random() < 0.65:
                if len(boxes):
                    selected = random.choice(boxes)
                    cx, cy = (selected[:2] + selected[2:]) / 2
                else:
                    cx = random.uniform(0, image.shape[1])
                    cy = random.uniform(0, image.shape[0])
                side = random.randint(args.crop_min, args.crop_max)
                x0 = max(
                    0,
                    min(
                        image.shape[1] - side, int(cx - side * random.uniform(0.3, 0.7))
                    ),
                )
                y0 = max(0, min(image.shape[0] - side, int(cy - side * 0.5)))
                image = image[y0 : y0 + side, x0 : x0 + side]
                boxes -= np.array([x0, y0, x0, y0])
                boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, image.shape[1])
                boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, image.shape[0])
                boxes = boxes[
                    (boxes[:, 2] - boxes[:, 0] >= 5) & (boxes[:, 3] - boxes[:, 1] >= 5)
                ]
            pixels, ratio = tensor_image(image)
            labels = np.zeros((80, 5), np.float32)
            for i, box in enumerate(boxes[:80] * ratio):
                labels[i, 1:3] = (box[:2] + box[2:]) / 2
                labels[i, 3:5] = box[2:] - box[:2]
            batch_images.append(pixels)
            batch_labels.append(labels)
        images = torch.from_numpy(np.stack(batch_images)).cuda()
        targets = torch.from_numpy(np.stack(batch_labels)).cuda()
        anchors = sum(
            (images.shape[-2] // s) * (images.shape[-1] // s)
            for s in model.head.strides
        )
        partial_bce.set_batch(
            [r.get("partialLabels", False) for r in batch_rows], anchors
        )
        for group in optimizer.param_groups:
            group["lr"] = (
                args.lr * min(step / 50, 1) * (0.15 + 0.85 * (1 - step / args.steps))
            )
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast("cuda", dtype=torch.float16):
            losses = model(images, targets)
            loss = losses["total_loss"]
        if not torch.isfinite(loss):
            raise RuntimeError("Nonfinite training loss")
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        scaler.step(optimizer)
        scaler.update()
        if step % 50 == 0:
            print(
                json.dumps(
                    {
                        "step": step,
                        "loss": round(float(loss.detach()), 4),
                        "seconds": round(time.monotonic() - began, 1),
                        "gpuGiB": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                    }
                ),
                flush=True,
            )
        if step % 100 == 0 or step == args.steps:
            report = evaluate(model, validation, root, tiled=args.tile_evaluation)
            report.update(step=step, seconds=round(time.monotonic() - began, 1))
            history.append(report)
            print(
                json.dumps(
                    {"validation": {k: v for k, v in report.items() if k != "images"}}
                ),
                flush=True,
            )
            if report["f1"] > best:
                best = report["f1"]
                torch.save(
                    {
                        "model": model.state_dict(),
                        "manifest": manifest,
                        "validation": report,
                    },
                    args.output / "best.pt",
                )
            (args.output / "history.json").write_text(json.dumps(history, indent=2))
    torch.save(
        {"model": model.state_dict(), "manifest": manifest}, args.output / "last.pt"
    )


def assess(args):
    import cv2
    import torch

    cv2.setNumThreads(1)
    torch.set_num_threads(4)
    rows = records(args.annotations)
    model = make_model(args.checkpoint, args.classes).cuda().eval()
    report = {
        split: evaluate(
            model,
            [r for r in rows if r["split"] == split],
            args.annotations.parent,
            args.classes,
            args.tile_evaluation,
        )
        for split in ("val", "test")
    }
    args.output.write_text(json.dumps(report, indent=2))
    print(
        json.dumps(
            {
                split: {k: v for k, v in data.items() if k != "images"}
                for split, data in report.items()
            }
        ),
        flush=True,
    )


def export(args):
    import torch

    model = make_model(args.checkpoint).cpu().eval()
    model.head.decode_in_inference = False
    torch.onnx.export(
        model,
        torch.zeros(1, 3, 640, 640),
        args.output,
        input_names=["images"],
        output_names=["output"],
        opset_version=17,
        dynamo=False,
    )
    print(
        json.dumps(
            {
                "file": str(args.output),
                "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                "classes": ["vehicle"],
            }
        ),
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("train")
    p.add_argument("--annotations", type=Path, required=True)
    p.add_argument("--pretrained", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--steps", type=int, default=1200)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=0.0003)
    p.add_argument("--unfreeze-backbone", action="store_true")
    p.add_argument("--positive-fraction", type=float, default=None)
    p.add_argument("--balanced-negative-cameras", action="store_true")
    p.add_argument("--crop-min", type=int, default=200)
    p.add_argument("--crop-max", type=int, default=500)
    p.add_argument("--tile-evaluation", action="store_true")
    p = sub.add_parser("assess")
    p.add_argument("--annotations", type=Path, required=True)
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--classes", type=int, choices=(1, 80), default=1)
    p.add_argument("--tile-evaluation", action="store_true")
    p.add_argument("--output", type=Path, required=True)
    p = sub.add_parser("export")
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train" and (
        not 64 <= args.crop_min <= args.crop_max <= 1536
        or (
            args.positive_fraction is not None
            and not 0 <= args.positive_fraction <= 1
        )
    ):
        parser.error("Invalid crop size or positive sampling fraction")
    {"train": train, "assess": assess, "export": export}[args.command](args)


if __name__ == "__main__":
    main()
