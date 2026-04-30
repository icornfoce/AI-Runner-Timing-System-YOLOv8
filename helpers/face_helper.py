import cv2
import face_recognition
import os
import numpy as np
import urllib.request
from ultralytics import YOLO


def load_known_faces(data_path):
    """โหลดรูปใบหน้าทั้งหมดจาก data_path สร้าง face encoding 128 มิติ"""
    print("Loading known faces database...")
    known_face_encodings = []
    known_face_names = []
    if not os.path.exists(data_path):
        return np.array([]), []
    for person_name in os.listdir(data_path):
        person_dir = os.path.join(data_path, person_name)
        if not os.path.isdir(person_dir):
            continue
        for image_name in os.listdir(person_dir):
            if image_name.lower().endswith(('.png', '.jpg', '.jpeg')):
                image_path = os.path.join(person_dir, image_name)
                try:
                    bgr_image = cv2.imread(image_path)
                    if bgr_image is None:
                        continue
                    image = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2RGB)
                    image = np.ascontiguousarray(image, dtype=np.uint8)
                    encodings = face_recognition.face_encodings(image)
                    if len(encodings) > 0:
                        known_face_encodings.append(encodings[0])
                        known_face_names.append(person_name)
                except Exception as e:
                    print(f"Error loading {image_name}: {e}")
    print(f"Loaded {len(known_face_encodings)} face(s) from {data_path}")
    return np.array(known_face_encodings), known_face_names


def get_yolo_model(model_path, model_url):
    """โหลด YOLOv8 model ดาวน์โหลดอัตโนมัติจาก HuggingFace ถ้ายังไม่มี"""
    if not os.path.exists(model_path):
        print("Downloading YOLOv8 Face Detection Model...")
        urllib.request.urlretrieve(model_url, model_path)
    return YOLO(model_path)
