"""
event_helper.py — Event/Session management
แต่ละงานวิ่งจะมีโฟลเดอร์แยกเก็บข้อมูล CSV และรูปภาพ violation
"""
import os
import shutil
import config


def get_active_event():
    """อ่านชื่อ Event ที่เปิดใช้งานอยู่จาก active_event.txt"""
    if os.path.exists(config.ACTIVE_EVENT_FILE):
        with open(config.ACTIVE_EVENT_FILE, 'r', encoding='utf-8') as f:
            name = f.read().strip()
            if name and os.path.isdir(os.path.join(config.EVENTS_DIR, name)):
                return name
    return None


def set_active_event(event_name):
    """ตั้งค่า Event ที่ใช้งาน"""
    with open(config.ACTIVE_EVENT_FILE, 'w', encoding='utf-8') as f:
        f.write(event_name)


def clear_active_event():
    """ล้างค่า Event ที่ใช้งาน (บังคับให้เลือกใหม่)"""
    if os.path.exists(config.ACTIVE_EVENT_FILE):
        os.remove(config.ACTIVE_EVENT_FILE)


def list_events():
    """คืนค่ารายชื่อ Event ทั้งหมด"""
    if not os.path.exists(config.EVENTS_DIR):
        os.makedirs(config.EVENTS_DIR)
        return []
    return sorted([
        d for d in os.listdir(config.EVENTS_DIR)
        if os.path.isdir(os.path.join(config.EVENTS_DIR, d))
    ])


def create_event(event_name):
    """สร้างโฟลเดอร์ Event ใหม่พร้อมโครงสร้างภายใน"""
    event_dir = os.path.join(config.EVENTS_DIR, event_name)
    violations_dir = os.path.join(event_dir, "violations")

    if os.path.exists(event_dir):
        return False  # มีอยู่แล้ว

    os.makedirs(violations_dir, exist_ok=True)
    return True


def get_active_event_paths():
    """
    คืนค่า dict ของ path ทั้งหมดที่ขึ้นกับ Event ปัจจุบัน:
    {
        "log_file": "events/<name>/running_results.csv",
        "violations_log": "events/<name>/violations_log.csv",
        "violations_dir": "events/<name>/violations/"
    }
    คืนค่า None ถ้ายังไม่มี Event ที่เปิดใช้งาน
    """
    event_name = get_active_event()
    if not event_name:
        return None

    event_dir = os.path.join(config.EVENTS_DIR, event_name)
    return {
        "log_file": os.path.join(event_dir, config.LOG_FILE),
        "violations_log": os.path.join(event_dir, config.VIOLATIONS_LOG_FILE),
        "violations_dir": os.path.join(event_dir, config.VIOLATION_DIR),
    }


def delete_event(event_name):
    """ลบโฟลเดอร์ Event ทั้งหมด"""
    event_dir = os.path.join(config.EVENTS_DIR, event_name)
    if os.path.exists(event_dir):
        shutil.rmtree(event_dir)
        return True
    return False


def clear_event_data(event_name):
    """ลบข้อมูลใน Event (CSV + รูป) แต่เก็บโฟลเดอร์ไว้"""
    event_dir = os.path.join(config.EVENTS_DIR, event_name)
    if not os.path.exists(event_dir):
        return False

    # ลบ CSV files
    for csv_file in [config.LOG_FILE, config.VIOLATIONS_LOG_FILE]:
        path = os.path.join(event_dir, csv_file)
        if os.path.exists(path):
            os.remove(path)

    # ลบรูปภาพ violations ทั้งหมด
    violations_dir = os.path.join(event_dir, config.VIOLATION_DIR)
    if os.path.exists(violations_dir):
        shutil.rmtree(violations_dir)
        os.makedirs(violations_dir)

    return True
