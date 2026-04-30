import os
import pandas as pd
from datetime import datetime
import config
from helpers.event_helper import get_active_event_paths


def _resolve_paths(event_paths=None):
    """Resolve file paths — ใช้ event_paths ที่ส่งมา หรือดึงจาก active event"""
    if event_paths:
        return event_paths
    paths = get_active_event_paths()
    if paths:
        return paths
    # Fallback: ถ้าไม่มี active event ใช้ path เดิม (backward compatibility)
    return {
        "log_file": config.LOG_FILE,
        "violations_log": config.VIOLATIONS_LOG_FILE,
        "violations_dir": config.VIOLATION_DIR,
    }


def init_log_file(event_paths=None):
    """สร้างไฟล์ running_results.csv ถ้ายังไม่มี"""
    paths = _resolve_paths(event_paths)
    log_file = paths["log_file"]

    # สร้างโฟลเดอร์ parent ถ้ายังไม่มี
    os.makedirs(os.path.dirname(log_file), exist_ok=True) if os.path.dirname(log_file) else None

    if not os.path.exists(log_file):
        df = pd.DataFrame(columns=['Name', 'CP1_Time', 'CP2_Time', 'Lap1_Duration', 'Total_Time'])
        df.to_csv(log_file, index=False)
        print(f"Created new log file: {log_file}")


def is_cooldown_over(last_time_str, now_dt):
    """ตรวจสอบว่าเวลาล่าสุดผ่าน cooldown แล้วหรือยัง"""
    try:
        last_dt = datetime.strptime(str(last_time_str), "%H:%M:%S")
        last_dt = last_dt.replace(year=now_dt.year, month=now_dt.month, day=now_dt.day)
        return (now_dt - last_dt).total_seconds() > config.COOLDOWN_SECONDS
    except:
        return True


def record_checkpoint(name, checkpoint_id, event_paths=None):
    """ฟังก์ชันบันทึกเวลาแยกตาม Checkpoint และคำนวณผลสรุป"""
    paths = _resolve_paths(event_paths)
    log_file = paths["log_file"]

    try:
        init_log_file(event_paths)
        df = pd.read_csv(log_file)
        now = datetime.now()
        now_str = now.strftime("%H:%M:%S")

        # ค้นหาว่าคนนี้มีชื่อในระบบหรือยัง
        user_row = df[df['Name'] == name]

        if user_row.empty:
            if checkpoint_id == 1:
                new_data = {'Name': name, 'CP1_Time': now_str}
                df = pd.concat([df, pd.DataFrame([new_data])], ignore_index=True)
                print(f"🏁 {name} Passed Checkpoint 1 at {now_str}")
        else:
            idx = user_row.index[0]

            if checkpoint_id == 1:
                last_time_str = str(df.at[idx, 'CP1_Time'])
                if last_time_str == 'nan' or is_cooldown_over(last_time_str, now):
                    df.at[idx, 'CP1_Time'] = now_str
                    print(f"🔄 {name} Updated Checkpoint 1 time: {now_str}")

            elif checkpoint_id == 2:
                cp1_time_str = str(df.at[idx, 'CP1_Time'])
                if cp1_time_str != 'nan':
                    cp1_dt = datetime.strptime(cp1_time_str, "%H:%M:%S")
                    cp1_dt = cp1_dt.replace(year=now.year, month=now.month, day=now.day)

                    duration = (now - cp1_dt).total_seconds()

                    df.at[idx, 'CP2_Time'] = now_str
                    df.at[idx, 'Lap1_Duration'] = f"{int(duration // 60)}:{int(duration % 60):02d}"
                    df.at[idx, 'Total_Time'] = df.at[idx, 'Lap1_Duration']

                    print(f"🏆 {name} FINISHED! Time from CP1: {df.at[idx, 'Total_Time']}")

        df.to_csv(log_file, index=False)
        return True
    except Exception as e:
        print(f"Log Error: {e}")
        return False


# ================= VIOLATIONS LOG =================

VIOLATIONS_COLUMNS = [
    'Name', 'Expected_Bib', 'Detected_Bib', 'Timestamp',
    'Checkpoint_ID', 'Image_Path', 'Status'
]


def _ensure_violations_log(event_paths=None):
    """สร้างไฟล์ violations_log.csv ถ้ายังไม่มี"""
    paths = _resolve_paths(event_paths)
    vlog = paths["violations_log"]
    os.makedirs(os.path.dirname(vlog), exist_ok=True) if os.path.dirname(vlog) else None
    if not os.path.exists(vlog):
        df = pd.DataFrame(columns=VIOLATIONS_COLUMNS)
        df.to_csv(vlog, index=False)


def log_violation(name, expected_bib, detected_bib, checkpoint_id, image_path, event_paths=None):
    """บันทึก violation ลงไฟล์ violations_log.csv"""
    paths = _resolve_paths(event_paths)
    _ensure_violations_log(event_paths)
    try:
        df = pd.read_csv(paths["violations_log"])
        new_row = {
            'Name': name,
            'Expected_Bib': expected_bib if expected_bib else 'N/A',
            'Detected_Bib': detected_bib,
            'Timestamp': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            'Checkpoint_ID': checkpoint_id,
            'Image_Path': image_path,
            'Status': 'pending'
        }
        df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
        df.to_csv(paths["violations_log"], index=False)
        return new_row
    except Exception as e:
        print(f"Violation Log Error: {e}")
        return None


def get_all_violations(event_paths=None):
    """อ่าน violation ทั้งหมดจาก violations_log.csv"""
    paths = _resolve_paths(event_paths)
    _ensure_violations_log(event_paths)
    try:
        df = pd.read_csv(paths["violations_log"])
        df = df.fillna("-")
        return df.to_dict(orient='records')
    except Exception as e:
        print(f"Read Violations Error: {e}")
        return []


def update_violation_status(timestamp, status, event_paths=None):
    """อัพเดทสถานะ violation (confirm/dismiss) สำหรับ Judge Panel"""
    paths = _resolve_paths(event_paths)
    _ensure_violations_log(event_paths)
    try:
        df = pd.read_csv(paths["violations_log"])
        mask = df['Timestamp'] == timestamp
        if mask.any():
            df.loc[mask, 'Status'] = status
            df.to_csv(paths["violations_log"], index=False)
            return True
        return False
    except Exception as e:
        print(f"Update Violation Error: {e}")
        return False
