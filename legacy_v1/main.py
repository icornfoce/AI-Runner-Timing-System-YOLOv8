import cv2
import face_recognition
import os
import numpy as np
import time
import urllib.request
import pandas as pd
import easyocr
import requests
from ultralytics import YOLO
from datetime import datetime

# ================= CONFIGURATION =================
CHECKPOINT_ID = 1  # เปลี่ยนเป็น 1 หรือ 2 ตามจุดที่วางคอมพิวเตอร์
LOG_FILE = "running_results.csv"
REGISTRY_FILE = "runners_registry.csv"
VIOLATION_DIR = "violations"
CONFIDENCE_THRESHOLD = 0.5 # ความแม่นยำขั้นต่ำ
SERVER_URL = "https://Bigrock.pythonanywhere.com/api/record"  # ← เปลี่ยน YOUR_USERNAME เป็นชื่อบัญชี PythonAnywhere
# =================================================

def load_registry():
    if os.path.exists(REGISTRY_FILE):
        df = pd.read_csv(REGISTRY_FILE)
        return dict(zip(df['Name'], df['BibNumber'].astype(str)))
    return {}

# Registry จะถูกโหลดใน main() และ reload อัตโนมัติ

if not os.path.exists(VIOLATION_DIR):
    os.makedirs(VIOLATION_DIR)

# Initialize EasyOCR
reader = easyocr.Reader(['en'])

def init_log_file():
    if not os.path.exists(LOG_FILE):
        df = pd.DataFrame(columns=['Name', 'CP1_Time', 'CP2_Time', 'Lap1_Duration', 'Total_Time'])
        df.to_csv(LOG_FILE, index=False)
        print(f"Created new log file: {LOG_FILE}")

def send_to_server(name, checkpoint_id, timestamp):
    """ส่งข้อมูล checkpoint ไปยังเซิร์ฟเวอร์ PythonAnywhere"""
    try:
        response = requests.post(SERVER_URL, json={
            "name": name,
            "checkpoint_id": checkpoint_id,
            "timestamp": timestamp
        }, timeout=5)
        if response.status_code == 200:
            print(f"✅ Sent to server: {name} CP{checkpoint_id} at {timestamp}")
        else:
            print(f"⚠️ Server responded: {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to send (CSV saved locally): {e}")

def send_violation_to_server(name, violation_msg, image_path, timestamp):
    """ส่งข้อมูล violation + รูปภาพไปยังเซิร์ฟเวอร์ PythonAnywhere"""
    try:
        violation_url = SERVER_URL.replace('/api/record', '/api/violation')
        with open(image_path, 'rb') as img_file:
            response = requests.post(
                violation_url,
                data={
                    "name": name,
                    "message": violation_msg,
                    "timestamp": timestamp
                },
                files={"image": (os.path.basename(image_path), img_file, "image/jpeg")},
                timeout=10
            )
        if response.status_code == 200:
            print(f"✅ Violation sent to server: {name}")
        else:
            print(f"⚠️ Violation upload failed: {response.status_code}")
    except Exception as e:
        print(f"❌ Could not send violation: {e}")

def record_checkpoint(name):
    """ฟังก์ชันบันทึกเวลาแยกตาม Checkpoint และคำนวณผลสรุป (ไม่มี Cooldown)"""
    try:
        df = pd.read_csv(LOG_FILE)
        now = datetime.now()
        now_str = now.strftime("%H:%M:%S")
        
        # ค้นหาว่าคนนี้มีชื่อในระบบหรือยัง
        user_row = df[df['Name'] == name]
        
        if user_row.empty:
            # -- ไม่เคยเจอคนนี้มาก่อน --
            if CHECKPOINT_ID == 1:
                new_data = {'Name': name, 'CP1_Time': now_str}
                df = pd.concat([df, pd.DataFrame([new_data])], ignore_index=True)
                print(f"🏁 {name} Passed Checkpoint 1 at {now_str}")
        else:
            # -- เคยเจอคนนี้แล้ว --
            idx = user_row.index[0]
            
            if CHECKPOINT_ID == 1:
                df.at[idx, 'CP1_Time'] = now_str
                print(f"🔄 {name} Updated Checkpoint 1 time: {now_str}")
            
            elif CHECKPOINT_ID == 2:
                # ถ้ามาถึงจุด 2
                cp1_time_str = str(df.at[idx, 'CP1_Time'])
                if cp1_time_str != 'nan':
                    # คำนวณเวลาจากจุด 1 มาจุด 2
                    cp1_dt = datetime.strptime(cp1_time_str, "%H:%M:%S")
                    cp1_dt = cp1_dt.replace(year=now.year, month=now.month, day=now.day)
                    
                    duration = (now - cp1_dt).total_seconds()
                    
                    # บันทึกผล
                    df.at[idx, 'CP2_Time'] = now_str
                    df.at[idx, 'Lap1_Duration'] = f"{int(duration // 60)}:{int(duration % 60):02d}"
                    df.at[idx, 'Total_Time'] = df.at[idx, 'Lap1_Duration']
                    
                    print(f"🏆 {name} FINISHED! Time from CP1: {df.at[idx, 'Total_Time']}")
        
        df.to_csv(LOG_FILE, index=False)
        
        # ส่งข้อมูลไปยังเซิร์ฟเวอร์ Cloud (PythonAnywhere)
        send_to_server(name, CHECKPOINT_ID, now_str)
        
        return True
    except Exception as e:
        print(f"Log Error: {e}")
        return False

def load_known_faces(data_path):
    print("Loading known faces database...")
    known_face_encodings = []
    known_face_names = []
    if not os.path.exists(data_path):
        return np.array([]), []
    for person_name in os.listdir(data_path):
        person_dir = os.path.join(data_path, person_name)
        if not os.path.isdir(person_dir): continue
        for image_name in os.listdir(person_dir):
            if image_name.lower().endswith(('.png', '.jpg', '.jpeg')):
                image_path = os.path.join(person_dir, image_name)
                try:
                    bgr_image = cv2.imread(image_path)
                    if bgr_image is None: continue
                    image = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2RGB)
                    image = np.ascontiguousarray(image, dtype=np.uint8)
                    encodings = face_recognition.face_encodings(image)
                    if len(encodings) > 0:
                        known_face_encodings.append(encodings[0])
                        known_face_names.append(person_name)
                except Exception as e: print(f"Error loading {image_name}: {e}")
    return np.array(known_face_encodings), known_face_names

def get_yolo_model():
    MODEL_PATH = "yolov8n-face.pt"
    if not os.path.exists(MODEL_PATH):
        print("Downloading YOLOv8 Face Detection Model...")
        urllib.request.urlretrieve("https://huggingface.co/arnabdhar/YOLOv8-Face-Detection/resolve/main/model.pt", MODEL_PATH)
    return YOLO(MODEL_PATH)

def main():
    global RUNNER_REGISTRY
    init_log_file()
    DATA_PATH = "Data"
    known_face_encodings, known_face_names = load_known_faces(DATA_PATH)
    yolo_model = get_yolo_model()
    
    # โหลด Registry ครั้งแรก
    RUNNER_REGISTRY = load_registry()
    last_registry_reload = time.time()
    REGISTRY_RELOAD_INTERVAL = 10  # โหลดใหม่ทุก 10 วินาที
    print(f"📋 Loaded Registry: {RUNNER_REGISTRY}")
    
    print(f"--- RUNNING SYSTEM START (CHECKPOINT {CHECKPOINT_ID}) ---")
    video_capture = cv2.VideoCapture(0)
    process_this_frame = True
    
    # FPS counter
    prev_time = time.time()
    fps = 0.0
    
    # OCR optimization: run every 5 frames + cache
    ocr_frame_counter = 0
    ocr_cache = {}  # name → last OCR result (ocr_bib)
    
    # Cooldown tracking
    runner_cooldown = {}

    while True:
        ret, frame = video_capture.read()
        if not ret: break
        
        # FPS calculation
        current_time = time.time()
        fps = 1.0 / max(current_time - prev_time, 0.001)
        prev_time = current_time
        
        # Auto-reload registry ทุก 10 วินาที
        if time.time() - last_registry_reload > REGISTRY_RELOAD_INTERVAL:
            RUNNER_REGISTRY = load_registry()
            last_registry_reload = time.time()
            print(f"🔄 Registry reloaded: {RUNNER_REGISTRY}")

        # ลดขนาดภาพเป็น 40% เพื่อเพิ่มความเร็ว
        small_frame = cv2.resize(frame, (0, 0), fx=0.4, fy=0.4)
        rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
        rgb_small_frame = np.ascontiguousarray(rgb_small_frame, dtype=np.uint8)

        if process_this_frame:
            ocr_frame_counter += 1
            
            # ใช้ imgsz=320 เพื่อเร่งความเร็ว YOLO inference
            results = yolo_model(rgb_small_frame, verbose=False, imgsz=320)
            face_locations = []
            for r in results:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > 0.6:
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        h, w = rgb_small_frame.shape[:2]
                        face_locations.append((max(0, int(y1)), min(w, int(x2)), min(h, int(y2)), max(0, int(x1))))

            face_names = []
            if len(face_locations) > 0:
                face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)
                for face_encoding in face_encodings:
                    name = "Unknown"
                    if len(known_face_encodings) > 0:
                        face_distances = face_recognition.face_distance(known_face_encodings, face_encoding)
                        best_match_index = np.argmin(face_distances)
                        if face_distances[best_match_index] <= 0.5:
                            name = known_face_names[best_match_index]
                            
                            # Add a 3-second cooldown to prevent file locking and server spam
                            current_time_sec = time.time()
                            if name not in runner_cooldown or (current_time_sec - runner_cooldown[name] > 3):
                                record_checkpoint(name)
                                runner_cooldown[name] = current_time_sec
                    face_names.append(name)
            else:
                face_names = []

        process_this_frame = not process_this_frame

        # วาดหน้าจอ UI
        cv2.putText(frame, f"CHECKPOINT: {CHECKPOINT_ID}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
        
        # FPS display (มุมบนขวา)
        fps_text = f"FPS: {fps:.1f}"
        text_size = cv2.getTextSize(fps_text, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)[0]
        cv2.putText(frame, fps_text, (frame.shape[1] - text_size[0] - 10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        
        # Scale factor สำหรับแปลงพิกัดจาก small_frame กลับเป็น frame
        scale = 1.0 / 0.4  # = 2.5
        
        for (top, right, bottom, left), name in zip(face_locations, face_names):
            top = int(top * scale)
            right = int(right * scale)
            bottom = int(bottom * scale)
            left = int(left * scale)
            
            # --- BIB DETECTION & VERIFICATION ---
            detected_bib = "N/A"
            ocr_bib = None
            status_color = (0, 255, 0) # เขียว = ปกติ
            
            if name != "Unknown":
                expected_bib = RUNNER_REGISTRY.get(name, None)
                
                # OCR ทุก 5 เฟรม เพื่อลด load
                run_ocr_now = (ocr_frame_counter % 5 == 0)
                
                if run_ocr_now:
                    face_height = bottom - top
                    bib_top = bottom
                    bib_bottom = min(frame.shape[0], bottom + int(face_height * 2.5))
                    bib_left = max(0, left - int(face_height * 0.5))
                    bib_right = min(frame.shape[1], right + int(face_height * 0.5))
                    
                    bib_crop = frame[bib_top:bib_bottom, bib_left:bib_right]
                    
                    if bib_crop.size > 0:
                        ocr_results = reader.readtext(bib_crop)
                        for (bbox, text, prob) in ocr_results:
                            if text.isdigit():
                                ocr_bib = text
                                break
                    # Cache ผล OCR
                    ocr_cache[name] = ocr_bib
                else:
                    # ใช้ผล OCR จาก cache
                    ocr_bib = ocr_cache.get(name, None)
                
                # ถ้า OCR อ่านได้ ใช้ค่าจาก OCR
                if ocr_bib is not None:
                    detected_bib = ocr_bib
                    
                    bib_to_owner = {v: k for k, v in RUNNER_REGISTRY.items()}
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
                        status_color = (0, 0, 255)
                        print(f"⚠️ VIOLATION: {name} - {violation_msg}")
                        
                        # บันทึกหลักฐานในเครื่อง
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        filename = f"{VIOLATION_DIR}/{name}_violation_{timestamp}.jpg"
                        cv2.imwrite(filename, frame)
                        
                        # ส่ง violation ไปยังเซิร์ฟเวอร์ Cloud
                        send_violation_to_server(name, violation_msg, filename, timestamp)
                elif expected_bib is not None:
                    detected_bib = expected_bib
            
            # วาดกรอบและป้ายชื่อ
            cv2.rectangle(frame, (left, top), (right, bottom), status_color, 2)
            
            label = f"{name} | Bib: {detected_bib}"
            if status_color == (0, 0, 255):
                label += " (MISMATCH!)"
            
            cv2.rectangle(frame, (left, top - 30), (right, top), status_color, cv2.FILLED)
            cv2.putText(frame, label, (left + 5, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        cv2.imshow('Runner Timing System', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break

    video_capture.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
