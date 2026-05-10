"""RunnerTrack AI — Local Edge Checkpoint Node (v0).

YOLOv8 (placeholder COCO weights) + EasyOCR digit extraction, run from a
local webcam. Standalone alternative to the hybrid pipeline (web_app.py
+ templates/checkpoint.html). Apps Script v6 backend is unchanged.

v0 ships only the detect -> crop -> OCR -> draw -> display loop. Face
recognition, backend POST, OCR consensus voting, and per-CP cooldowns are
deferred to v0.1+. See AI_CONTEXT.md sections 4.2 and 6.5 for scope.

Run:   python checkpoint_camera.py
Quit:  press 'q' in the video window.
"""

import re

import cv2
import easyocr
from ultralytics import YOLO


# === Models / camera ===
MODEL_PATH = "yolov8n.pt"
CAMERA_INDEX = 0
WINDOW_NAME = "RunnerTrack — Edge Node v0"

# === Inference / OCR ===
YOLO_CONF_THRESHOLD = 0.5
MIN_OCR_ROI_SIZE = 20

# === UI ===
QUIT_KEY = "q"
LABEL_FONT = cv2.FONT_HERSHEY_SIMPLEX
LABEL_FONT_SCALE = 0.6
LABEL_FONT_THICKNESS = 1
BBOX_THICKNESS = 2
BBOX_COLOR = (0, 255, 0)
LABEL_TEXT_COLOR = (255, 255, 255)
LABEL_PAD = 4


def init_models():
    """Load YOLO + EasyOCR. First run downloads weights (~100 MB total)."""
    print("Loading models (first run downloads weights, ~100 MB)...")
    yolo = YOLO(MODEL_PATH)
    # gpu=False for predictability on operator laptops without CUDA.
    ocr = easyocr.Reader(["en"], gpu=False)
    return yolo, ocr


def init_camera(index=CAMERA_INDEX):
    """Open the webcam at `index`; raise if it fails to open."""
    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera index {index}")
    return cap


def detect(yolo, frame, conf_threshold=YOLO_CONF_THRESHOLD):
    """Run YOLO inference; return [{box, conf, cls, name}, ...]."""
    results = yolo(frame, verbose=False, conf=conf_threshold)
    detections = []
    for r in results:
        boxes = getattr(r, "boxes", None)
        if boxes is None:
            continue
        for b in boxes:
            x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
            cls = int(b.cls[0])
            detections.append({
                "box": (x1, y1, x2, y2),
                "conf": float(b.conf[0]),
                "cls": cls,
                "name": yolo.names.get(cls, str(cls)),
            })
    return detections


def extract_digits(reader, roi):
    """Run EasyOCR on the ROI and return the highest-confidence digit run, or ''."""
    if roi is None or roi.size == 0:
        return ""
    h, w = roi.shape[:2]
    if h < MIN_OCR_ROI_SIZE or w < MIN_OCR_ROI_SIZE:
        return ""
    try:
        # detail=1 returns [(bbox, text, confidence), ...]; allowlist constrains
        # the recognizer to digits at the model level.
        result = reader.readtext(roi, allowlist="0123456789", detail=1)
    except Exception:
        return ""
    if not result:
        return ""
    best_digits = ""
    best_conf = 0.0
    for entry in result:
        if not entry or len(entry) < 3:
            continue
        text, conf = str(entry[1]), float(entry[2])
        digits = re.sub(r"\D", "", text)        # defense-in-depth even with allowlist
        if digits and conf > best_conf:
            best_digits, best_conf = digits, conf
    return best_digits


def draw_yolo_label(frame, box, label, conf, color=BBOX_COLOR):
    """Draw bbox + filled YOLO-style label tab anchored to the top-left of the bbox."""
    x1, y1, x2, y2 = box
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, BBOX_THICKNESS)

    text = f"{label} {conf:.2f}"
    (text_w, text_h), baseline = cv2.getTextSize(
        text, LABEL_FONT, LABEL_FONT_SCALE, LABEL_FONT_THICKNESS
    )
    tab_h = text_h + baseline + LABEL_PAD
    tab_w = text_w + LABEL_PAD * 2

    # Default: tab sits above the bbox. If it would clip the frame top, flip
    # it down so it sits inside the bbox top-left instead.
    above_top = y1 - tab_h
    if above_top >= 0:
        tab_x1, tab_y1 = x1, above_top
        text_y = y1 - baseline - LABEL_PAD // 2
    else:
        tab_x1, tab_y1 = x1, y1
        text_y = y1 + text_h + LABEL_PAD // 2
    tab_x2 = tab_x1 + tab_w
    tab_y2 = tab_y1 + tab_h

    cv2.rectangle(frame, (tab_x1, tab_y1), (tab_x2, tab_y2), color, -1)
    cv2.putText(
        frame,
        text,
        (tab_x1 + LABEL_PAD, text_y),
        LABEL_FONT,
        LABEL_FONT_SCALE,
        LABEL_TEXT_COLOR,
        LABEL_FONT_THICKNESS,
        cv2.LINE_AA,
    )


def process_frame(yolo, ocr, frame):
    """Detect, crop, OCR, and annotate every detection on `frame` in-place."""
    h, w = frame.shape[:2]
    for d in detect(yolo, frame):
        x1, y1, x2, y2 = d["box"]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        roi = frame[y1:y2, x1:x2]
        digits = extract_digits(ocr, roi)
        label = f"BIB: {digits}" if digits else d["name"].upper()
        draw_yolo_label(frame, (x1, y1, x2, y2), label, d["conf"])
    return frame


def main():
    yolo, ocr = init_models()
    cap = init_camera()
    print(f"Edge node ready. Press '{QUIT_KEY}' in the video window to quit.")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("Camera read failed; stopping.")
                break
            process_frame(yolo, ocr, frame)
            cv2.imshow(WINDOW_NAME, frame)
            if cv2.waitKey(1) & 0xFF == ord(QUIT_KEY):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
