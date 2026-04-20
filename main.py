import cv2
import face_recognition
import os
import numpy as np
import time
import urllib.request
import pandas as pd
from ultralytics import YOLO
from datetime import datetime

# ================= CONFIGURATION =================
CHECKPOINT_ID = 1  # เปลี่ยนเป็น 1 หรือ 2 ตามจุดที่วางคอมพิวเตอร์
LOG_FILE = "running_results.csv"
COOLDOWN_SECONDS = 30 # ป้องกันการบันทึกซ้ำซ้อนในจุดเดิม
# =================================================

def init_log_file():
    if not os.path.exists(LOG_FILE):
        df = pd.DataFrame(columns=['Name', 'CP1_Time', 'CP2_Time', 'Lap1_Duration', 'Total_Time'])
        df.to_csv(LOG_FILE, index=False)
        print(f"Created new log file: {LOG_FILE}")

def record_checkpoint(name):
    """ฟังก์ชันบันทึกเวลาแยกตาม Checkpoint และคำนวณผลสรุป"""
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
                # ถ้าวนกลับมาจุด 1 อีกครั้ง (อาจจะเป็นรอบใหม่) ให้เช็ค Cooldown
                last_time_str = str(df.at[idx, 'CP1_Time'])
                if last_time_str == 'nan' or is_cooldown_over(last_time_str, now):
                    df.at[idx, 'CP1_Time'] = now_str
                    print(f"🔄 {name} Updated Checkpoint 1 time: {now_str}")
            
            elif CHECKPOINT_ID == 2:
                # ถ้ามาถึงจุด 2
                cp1_time_str = str(df.at[idx, 'CP1_Time'])
                if cp1_time_str != 'nan':
                    # คำนวณเวลาจากจุด 1 มาจุด 2
                    cp1_dt = datetime.strptime(cp1_time_str, "%H:%M:%S")
                    # ทำให้เป็นวันที่เดียวกันเพื่อลบกันได้
                    cp1_dt = cp1_dt.replace(year=now.year, month=now.month, day=now.day)
                    
                    duration = (now - cp1_dt).total_seconds()
                    
                    # บันทึกผล
                    df.at[idx, 'CP2_Time'] = now_str
                    df.at[idx, 'Lap1_Duration'] = f"{int(duration // 60)}:{int(duration % 60):02d}"
                    df.at[idx, 'Total_Time'] = df.at[idx, 'Lap1_Duration']
                    
                    print(f"🏆 {name} FINISHED! Time from CP1: {df.at[idx, 'Total_Time']}")
        
        df.to_csv(LOG_FILE, index=False)
        return True
    except Exception as e:
        print(f"Log Error: {e}")
        return False

def is_cooldown_over(last_time_str, now_dt):
    try:
        last_dt = datetime.strptime(last_time_str, "%H:%M:%S")
        last_dt = last_dt.replace(year=now_dt.year, month=now_dt.month, day=now_dt.day)
        return (now_dt - last_dt).total_seconds() > COOLDOWN_SECONDS
    except:
        return True

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
    init_log_file()
    DATA_PATH = "Data"
    known_face_encodings, known_face_names = load_known_faces(DATA_PATH)
    yolo_model = get_yolo_model()
    
    print(f"--- RUNNING SYSTEM START (CHECKPOINT {CHECKPOINT_ID}) ---")
    video_capture = cv2.VideoCapture(0)
    process_this_frame = True
    
    # ดิกชันนารีเก็บเวลาที่เจอล่าสุดในโปรแกรมเพื่อลดการเขียนไฟล์ CSV บ่อยเกินไป
    session_cooldowns = {}

    while True:
        ret, frame = video_capture.read()
        if not ret: break

        small_frame = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
        rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
        rgb_small_frame = np.ascontiguousarray(rgb_small_frame, dtype=np.uint8)

        if process_this_frame:
            results = yolo_model(rgb_small_frame, stream=True, verbose=False)
            face_locations = []
            for r in results:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > 0.6: # เพิ่มความแม่นยำสำหรับการจับเวลา
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
                        if face_distances[best_match_index] <= 0.5: # เข้มงวดขึ้น
                            name = known_face_names[best_match_index]
                            
                            # บันทึกเวลาลง CSV เมื่อเจอคนรู้จัก
                            now = time.time()
                            if name not in session_cooldowns or (now - session_cooldowns[name]) > COOLDOWN_SECONDS:
                                record_checkpoint(name)
                                session_cooldowns[name] = now
                    face_names.append(name)
            else:
                face_names = []

        process_this_frame = not process_this_frame

        # วาดหน้าจอ UI
        cv2.putText(frame, f"CHECKPOINT: {CHECKPOINT_ID}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
        for (top, right, bottom, left), name in zip(face_locations, face_names):
            top, right, bottom, left = top*2, right*2, bottom*2, left*2
            color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
            cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
            
            label = name
            if name != "Unknown":
                # แสดงเวลาล่าสุดของคนนั้นสั้นๆ
                label = f"{name} (PASS!)"
            
            cv2.rectangle(frame, (left, top - 30), (right, top), color, cv2.FILLED)
            cv2.putText(frame, label, (left + 5, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

        cv2.imshow('Runner Timing System', frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break

    video_capture.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
