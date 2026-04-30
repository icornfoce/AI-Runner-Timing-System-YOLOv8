import cv2
import face_recognition
import numpy as np
import time
import os
import easyocr

import config
from helpers.csv_helper import init_log_file, record_checkpoint, log_violation
from helpers.registry_helper import load_registry, get_bib_to_owner
from helpers.image_helper import save_violation_image, get_bib_crop
from helpers.face_helper import load_known_faces, get_yolo_model

# Client mode: import sender for remote reporting
if config.MODE == "client":
    import client_sender


def main():
    # --- Initialization ---
    print(f"🔧 Running in {config.MODE.upper()} mode")

    if config.MODE == "client":
        client_sender.init(config.SERVER_URL)
    else:
        init_log_file()

    known_face_encodings, known_face_names = load_known_faces(config.DATA_PATH)
    yolo_model = get_yolo_model(config.YOLO_MODEL_PATH, config.YOLO_MODEL_URL)

    # EasyOCR initialized inside main(), not at module level
    print("Initializing EasyOCR...")
    reader = easyocr.Reader(['en'])

    if not os.path.exists(config.VIOLATION_DIR):
        os.makedirs(config.VIOLATION_DIR)

    # โหลด Registry ครั้งแรก + Bug 1 fix: compute bib_to_owner once on reload
    runner_registry = load_registry(config.REGISTRY_FILE)
    bib_to_owner = get_bib_to_owner(runner_registry)
    last_registry_reload = time.time()
    print(f"📋 Loaded Registry: {runner_registry}")

    print(f"--- RUNNING SYSTEM START (CHECKPOINT {config.CHECKPOINT_ID}) ---")

    # Issue 9: Use config.CAMERA_INDEX + check if webcam opened
    video_capture = cv2.VideoCapture(config.CAMERA_INDEX)
    if not video_capture.isOpened():
        print(f"❌ Cannot open webcam (index={config.CAMERA_INDEX}). Check camera connection or change CAMERA_INDEX in config.py")
        return

    process_this_frame = True

    # Cooldown dictionaries
    session_cooldowns = {}    # ป้องกันบันทึก checkpoint ซ้ำ
    violation_cooldowns = {}  # ป้องกัน violation image spam

    # Initialize before the if block to prevent UnboundLocalError
    face_locations = []
    face_names = []

    # FPS counter
    fps = 0.0
    fps_start_time = cv2.getTickCount()
    fps_frame_count = 0

    while True:
        ret, frame = video_capture.read()
        if not ret:
            break

        # Auto-reload registry + Bug 1 fix: recompute bib_to_owner on reload
        if time.time() - last_registry_reload > config.REGISTRY_RELOAD_INTERVAL:
            runner_registry = load_registry(config.REGISTRY_FILE)
            bib_to_owner = get_bib_to_owner(runner_registry)
            last_registry_reload = time.time()

        small_frame = cv2.resize(frame, (0, 0),
                                 fx=config.FRAME_RESIZE_FACTOR,
                                 fy=config.FRAME_RESIZE_FACTOR)
        rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
        rgb_small_frame = np.ascontiguousarray(rgb_small_frame, dtype=np.uint8)

        if process_this_frame:
            # --- YOLOv8 Face Detection ---
            results = yolo_model(rgb_small_frame, stream=True, verbose=False)
            face_locations = []
            for r in results:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > config.YOLO_CONFIDENCE:
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        h, w = rgb_small_frame.shape[:2]
                        face_locations.append((
                            max(0, int(y1)), min(w, int(x2)),
                            min(h, int(y2)), max(0, int(x1))
                        ))

            # --- Face Recognition ---
            face_names = []
            if len(face_locations) > 0:
                face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)
                for face_encoding in face_encodings:
                    name = "Unknown"
                    if len(known_face_encodings) > 0:
                        face_distances = face_recognition.face_distance(known_face_encodings, face_encoding)
                        best_match_index = np.argmin(face_distances)
                        if face_distances[best_match_index] <= config.FACE_DISTANCE_THRESHOLD:
                            name = known_face_names[best_match_index]

                            # บันทึกเวลาเมื่อเจอคนรู้จัก
                            now = time.time()
                            if name not in session_cooldowns or (now - session_cooldowns[name]) > config.COOLDOWN_SECONDS:
                                # Bug 2 fix: wrap sender in try/except
                                if config.MODE == "client":
                                    try:
                                        client_sender.send_checkpoint(name, config.CHECKPOINT_ID)
                                    except Exception as e:
                                        print(f"⚠️ Could not reach server: {e}")
                                else:
                                    record_checkpoint(name, config.CHECKPOINT_ID)
                                session_cooldowns[name] = now
                    face_names.append(name)
            # Issue 6 fix: removed redundant `else: face_names = []` (dead code)

        process_this_frame = not process_this_frame

        # --- UI Rendering ---
        # Bug 4 fix: use float scale to prevent bounding box misalignment
        scale = 1.0 / config.FRAME_RESIZE_FACTOR

        cv2.putText(frame, f"CHECKPOINT: {config.CHECKPOINT_ID}",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)

        for (top, right, bottom, left), name in zip(face_locations, face_names):
            # Scale back to original resolution (cast per-coordinate)
            top = int(top * scale)
            right = int(right * scale)
            bottom = int(bottom * scale)
            left = int(left * scale)

            # --- BIB DETECTION & VERIFICATION ---
            detected_bib = "N/A"
            ocr_bib = None
            status_color = (0, 255, 0)  # เขียว = ปกติ

            if name != "Unknown":
                expected_bib = runner_registry.get(name, None)

                # Crop พื้นที่ใต้ใบหน้าเพื่อหา Bib
                bib_crop = get_bib_crop(frame, top, right, bottom, left)

                if bib_crop is not None:
                    ocr_results = reader.readtext(bib_crop)
                    for (bbox, text, prob) in ocr_results:
                        if text.isdigit():
                            ocr_bib = text
                            break

                # ถ้า OCR อ่านได้ ใช้ค่าจาก OCR
                if ocr_bib is not None:
                    detected_bib = ocr_bib

                    # Bug 1 fix: use pre-computed bib_to_owner instead of calling every frame
                    bib_owner = bib_to_owner.get(ocr_bib, None)

                    is_violation = False
                    violation_msg = ""

                    if expected_bib is not None and ocr_bib != expected_bib:
                        is_violation = True
                        violation_msg = f"Expected Bib {expected_bib}, Found {ocr_bib}"
                    elif expected_bib is None and bib_owner is not None and bib_owner != name:
                        is_violation = True
                        violation_msg = f"NOT REGISTERED! Wearing Bib {ocr_bib} (belongs to {bib_owner})"
                    elif expected_bib is None and bib_owner is None:
                        is_violation = True
                        violation_msg = f"UNREGISTERED runner with unknown Bib {ocr_bib}"

                    if is_violation:
                        status_color = (0, 0, 255)  # แดง = ผิดปกติ
                        print(f"⚠️ VIOLATION: {name} - {violation_msg}")

                        # Violation cooldown ป้องกันบันทึกภาพซ้ำ
                        now = time.time()
                        if name not in violation_cooldowns or \
                           (now - violation_cooldowns[name]) > config.VIOLATION_COOLDOWN_SECONDS:
                            # Bug 2 fix: wrap sender in try/except
                            if config.MODE == "client":
                                try:
                                    client_sender.send_violation(
                                        name, expected_bib, ocr_bib,
                                        config.CHECKPOINT_ID, frame
                                    )
                                except Exception as e:
                                    print(f"⚠️ Could not send violation to server: {e}")
                            else:
                                image_path = save_violation_image(frame, name, config.VIOLATION_DIR)
                                log_violation(name, expected_bib, ocr_bib,
                                              config.CHECKPOINT_ID, image_path)
                            violation_cooldowns[name] = now

                elif expected_bib is not None:
                    detected_bib = expected_bib

            # วาดกรอบและป้ายชื่อ
            cv2.rectangle(frame, (left, top), (right, bottom), status_color, 2)

            label = f"{name} | Bib: {detected_bib}"
            if status_color == (0, 0, 255):
                label += " (MISMATCH!)"

            cv2.rectangle(frame, (left, top - 30), (right, top), status_color, cv2.FILLED)
            cv2.putText(frame, label, (left + 5, top - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        # FPS counter
        fps_frame_count += 1
        if fps_frame_count >= 10:
            fps_end_time = cv2.getTickCount()
            time_elapsed = (fps_end_time - fps_start_time) / cv2.getTickFrequency()
            fps = fps_frame_count / time_elapsed
            fps_start_time = fps_end_time
            fps_frame_count = 0

        mode_label = "CLIENT" if config.MODE == "client" else "LOCAL"
        cv2.putText(frame, f"FPS: {fps:.1f} | {mode_label}",
                    (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

        cv2.imshow('Runner Timing System', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    video_capture.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
