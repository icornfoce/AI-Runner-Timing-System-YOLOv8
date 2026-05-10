"""RunnerTrack AI — Web App (hybrid mode).

Serves the browser pages (Register / Checkpoint / Dashboard) AND hosts the
local YOLOv8 + EasyOCR inference endpoint at POST /analyze. The browser
checkpoint UI fetches /analyze every ~400 ms with a base64 JPEG and merges
the per-detection BIB results with face-api.js identification.

Models load once at import time. First start downloads weights (~100 MB:
YOLOv8n ~6 MB + EasyOCR detection ~64 MB + recognition ~30 MB) and takes
~4-8 s on CPU; the GET /health endpoint reports readiness for the
frontend's init poll. (PaddleOCR was used previously; swapped for EasyOCR
because paddlepaddle has no wheel for Python 3.14 yet.)

Run:   python web_app.py
"""
import base64
import logging
import re

import cv2
import easyocr
import numpy as np
from flask import Flask, jsonify, render_template, request
from ultralytics import YOLO


# === Inference / OCR ===
MODEL_PATH = "yolov8n.pt"
YOLO_CONF_THRESHOLD = 0.5
MIN_OCR_ROI_SIZE = 20
MAX_IMAGE_BYTES = 2_000_000  # ~1.5 MB JPEG @ q=0.8 / 1280x720; reject larger payloads


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("runnertrack.ai")


def extract_digits(reader, roi):
    """Run EasyOCR on the ROI; return (digits, conf) for the highest-confidence digit run, or ('', 0.0).

    Mirrored in checkpoint_camera.py (single-string return there). `allowlist`
    constrains the recognizer to digits at the model level; the regex below
    is defense-in-depth in case EasyOCR ever returns a punctuation glyph.
    """
    if roi is None or roi.size == 0:
        return "", 0.0
    h, w = roi.shape[:2]
    if h < MIN_OCR_ROI_SIZE or w < MIN_OCR_ROI_SIZE:
        return "", 0.0
    try:
        # detail=1 returns [(bbox, text, confidence), ...]; bbox is unused here.
        result = reader.readtext(roi, allowlist="0123456789", detail=1)
    except Exception:
        return "", 0.0
    if not result:
        return "", 0.0
    best_digits = ""
    best_conf = 0.0
    for entry in result:
        if not entry or len(entry) < 3:
            continue
        text, conf = str(entry[1]), float(entry[2])
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
log.info("Loading YOLO + EasyOCR (one-shot)...")
YOLO_MODEL = YOLO(MODEL_PATH)
# gpu=False keeps behavior deterministic on operator laptops without CUDA.
# Flip to True (or omit) once a CUDA-enabled torch is verified on the host.
OCR_READER = easyocr.Reader(["en"], gpu=False)
# Warm the recognition path so the first /analyze isn't slow.
extract_digits(OCR_READER, np.zeros((40, 40, 3), dtype=np.uint8))
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


@app.route('/favicon.ico')
def favicon():
    """Browser asks for /favicon.ico on every page load; return 204 to
    silence the 404 in DevTools rather than ship a real icon."""
    return ('', 204)


# === LOCAL AI API ===
@app.route('/health', methods=['GET'])
def health():
    """Frontend polls this before opening the camera."""
    return jsonify(ready=True)


@app.route('/analyze', methods=['POST'])
def analyze():
    """Decode base64 frame, run YOLO + EasyOCR, return one entry per BIB box.

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
                digits, conf = extract_digits(OCR_READER, roi)
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
    # the YOLO+EasyOCR cold-load (~4-8 s) every time. Keep it off.
    app.run(host='0.0.0.0', port=5000, debug=False)
