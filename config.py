# ================= CONFIGURATION =================
# ตั้งค่าทั้งหมดของระบบจับเวลาวิ่งอัตโนมัติ
# =================================================

# --- Checkpoint ---
CHECKPOINT_ID = 1  # เปลี่ยนเป็น 1 หรือ 2 ตามจุดที่วางคอมพิวเตอร์
CAMERA_INDEX = 0    # เปลี่ยนเป็น 1, 2 ถ้ากล้องตัวแรกไม่ทำงาน

# --- File Paths ---
LOG_FILE = "running_results.csv"
REGISTRY_FILE = "runners_registry.csv"
VIOLATIONS_LOG_FILE = "violations_log.csv"
VIOLATION_DIR = "violations"
DATA_PATH = "Data"

# --- Event/Session Management ---
EVENTS_DIR = "events"                # โฟลเดอร์รากที่เก็บข้อมูลทุก Event
ACTIVE_EVENT_FILE = "active_event.txt"  # ไฟล์เก็บชื่อ Event ที่ใช้งานอยู่

# --- Cooldowns ---
COOLDOWN_SECONDS = 30           # ป้องกันการบันทึกซ้ำซ้อนในจุดเดิม
VIOLATION_COOLDOWN_SECONDS = 60 # ป้องกันการบันทึกภาพ violation ซ้ำซ้อน

# --- AI Thresholds ---
YOLO_CONFIDENCE = 0.6           # ความแม่นยำขั้นต่ำสำหรับ YOLOv8
FACE_DISTANCE_THRESHOLD = 0.5   # ความเข้มงวดในการจับคู่ใบหน้า (ยิ่งน้อยยิ่งเข้มงวด)
FRAME_RESIZE_FACTOR = 0.5       # ย่อภาพสำหรับ AI processing

# --- Registry ---
REGISTRY_RELOAD_INTERVAL = 10   # โหลด registry ใหม่ทุกกี่วินาที

# --- YOLO Model ---
YOLO_MODEL_PATH = "yolov8n-face.pt"
YOLO_MODEL_URL = "https://huggingface.co/arnabdhar/YOLOv8-Face-Detection/resolve/main/model.pt"

# --- Web App ---
JUDGE_PIN = "1234"
FLASK_SECRET_KEY = "bibguard-secret-key-change-in-production"

# --- Client-Server Architecture ---
SERVER_URL = "http://localhost:5000"  # เปลี่ยนเป็น IP ของ Server จริง เช่น "http://192.168.1.100:5000"
MODE = "standalone"  # "client" = กล้องส่งข้อมูลไป Server | "standalone" = ทำงานในเครื่องเดียว
