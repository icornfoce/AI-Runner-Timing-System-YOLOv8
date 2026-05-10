"""RunnerTrack AI — Web App (hybrid mode).

Serves the browser pages (Register / Checkpoint / Dashboard) AND hosts the
local YOLOv8 + PaddleOCR inference endpoint at POST /analyze. The browser
checkpoint UI fetches /analyze every ~400 ms with a base64 JPEG and merges
the per-detection BIB results with face-api.js identification.

Models load once at import time. First start downloads weights (~25 MB) and
takes ~4-8 s on CPU; the GET /health endpoint reports readiness for the
frontend's init poll.

Run:   python web_app.py
"""
import base64
import logging
import re

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from paddleocr import PaddleOCR
from ultralytics import YOLO


# === Inference / OCR ===
MODEL_PATH = "yolov8n.pt"
YOLO_CONF_THRESHOLD = 0.5
MIN_OCR_ROI_SIZE = 20
MAX_IMAGE_BYTES = 2_000_000  # ~1.5 MB JPEG @ q=0.8 / 1280x720; reject larger payloads


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("runnertrack.ai")


def extract_digits(ocr, roi):
    """Run PaddleOCR on the ROI; return (digits, conf) for the highest-confidence digit run, or ('', 0.0).

    Lifted from checkpoint_camera.py:78-100; return shape extended to carry confidence
    so the JSON response can surface it to the browser.
    """
    if roi is None or roi.size == 0:
        return "", 0.0
    h, w = roi.shape[:2]
    if h < MIN_OCR_ROI_SIZE or w < MIN_OCR_ROI_SIZE:
        return "", 0.0
    try:
        result = ocr.ocr(roi, cls=True)
    except Exception:
        return "", 0.0
    if not result or result[0] is None:
        return "", 0.0
    best_digits = ""
    best_conf = 0.0
    for line in result[0]:
        if not line or len(line) < 2 or not line[1]:
            continue
        text, conf = line[1][0], float(line[1][1])
        digits = re.sub(r"\D", "", text)
        if digits and conf > best_conf:
            best_digits, best_conf = digits, conf
    return best_digits, best_conf


def _decode_image(data_url):
    """Decode a data:image/...;base64,... URL (or bare base64) to a BGR cv2 frame."""
    if not isinstance(data_url, str):
        raise ValueError("image must be a string")
    if "," in data_url and data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    if len(data_url) > MAX_IMAGE_BYTES:
        raise ValueError("image too large")
    try:
        raw = base64.b64decode(data_url, validate=False)
    except Exception as e:
        raise ValueError(f"base64 decode failed: {e}")
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("imdecode returned None (bad JPEG?)")
    return frame


# === Load AI models at import time ===
log.info("Loading YOLO + PaddleOCR (one-shot)...")
YOLO_MODEL = YOLO(MODEL_PATH)
PADDLE_OCR = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
# Warm the PaddleOCR angle-classifier so the first /analyze is not slow.
extract_digits(PADDLE_OCR, np.zeros((40, 40, 3), dtype=np.uint8))
log.info("AI models ready.")


app = Flask(__name__)


# === PUBLIC PAGES ===
@app.route('/')
def dashboard():
    return render_template('dashboard.html')


@app.route('/register')
def register():
    return render_template('register.html')


@app.route('/checkpoint')
def checkpoint():
    return render_template('checkpoint.html')


@app.route('/admin')
def admin():
    return render_template('dashboard.html')


# === LOCAL AI API ===
@app.route('/health', methods=['GET'])
def health():
    """Frontend polls this before opening the camera."""
    return jsonify(ready=True)


@app.route('/analyze', methods=['POST'])
def analyze():
    """Decode base64 frame, run YOLO + PaddleOCR, return one entry per BIB box.

    Response shape: {"detections": [
      {"box": {"x", "y", "w", "h"}, "text": "67", "confidence": 0.95, "label": "BIB"},
      ...
    ]}
    Entries with empty digit text are dropped server-side -- they aren't BIBs.
    """
    payload = request.get_json(silent=True) or {}
    img_b64 = payload.get('image')
    if not img_b64:
        return jsonify(error='missing image'), 400
    try:
        frame = _decode_image(img_b64)
    except Exception as e:
        return jsonify(error=f'decode: {e}'), 400

    try:
        h, w = frame.shape[:2]
        results = YOLO_MODEL(frame, verbose=False, conf=YOLO_CONF_THRESHOLD)
        out = []
        for r in results:
            boxes = getattr(r, 'boxes', None)
            if boxes is None:
                continue
            for b in boxes:
                x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, x2), min(h, y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                roi = frame[y1:y2, x1:x2]
                digits, conf = extract_digits(PADDLE_OCR, roi)
                if not digits:
                    continue
                out.append({
                    "box": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                    "text": digits,
                    "confidence": round(conf, 3),
                    "label": "BIB",
                })
        return jsonify(detections=out)
    except Exception:
        log.exception("inference error")
        return jsonify(error='inference failed'), 500


if __name__ == '__main__':
    # debug=False: the reloader would re-import this module on save and pay
    # the YOLO+PaddleOCR cold-load (~4-8 s) every time. Keep it off.
    app.run(host='0.0.0.0', port=5000, debug=False)
