import cv2
import os
from datetime import datetime


def save_violation_image(frame, name, violation_dir):
    """บันทึกภาพหลักฐาน violation พร้อม timestamp คืนค่า filepath"""
    if not os.path.exists(violation_dir):
        os.makedirs(violation_dir)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{name}_violation_{timestamp}.jpg"
    filepath = os.path.join(violation_dir, filename)
    cv2.imwrite(filepath, frame)
    return filepath


def get_bib_crop(frame, top, right, bottom, left):
    """Crop พื้นที่ใต้ใบหน้าเพื่อหา Bib Number คืนค่า cropped image หรือ None"""
    face_height = bottom - top
    bib_top = bottom
    bib_bottom = min(frame.shape[0], bottom + int(face_height * 2.5))
    bib_left = max(0, left - int(face_height * 0.5))
    bib_right = min(frame.shape[1], right + int(face_height * 0.5))

    bib_crop = frame[bib_top:bib_bottom, bib_left:bib_right]
    if bib_crop.size > 0:
        return bib_crop
    return None
