"""
client_sender.py — HTTP client module for sending checkpoint and violation
data from the camera computer to the central server.

Imported by main.py when MODE = "client" in config.py.
All calls are fire-and-forget with short timeouts so they never block
the camera loop for more than a few seconds.
"""
import requests
import base64
import cv2
from datetime import datetime


SERVER_URL = None  # Set from config at startup


def init(server_url):
    """Initialize the sender with the server URL from config."""
    global SERVER_URL
    SERVER_URL = server_url.rstrip('/')
    print(f"📡 Client sender initialized → {SERVER_URL}")


def send_checkpoint(name, checkpoint_id):
    """POST checkpoint record to the central server."""
    if SERVER_URL is None:
        print("❌ client_sender not initialized. Call init() first.")
        return False
    try:
        time_str = datetime.now().strftime("%H:%M:%S")
        resp = requests.post(
            f"{SERVER_URL}/api/report",
            json={
                "name": name,
                "checkpoint_id": checkpoint_id,
                "time": time_str
            },
            timeout=3
        )
        if resp.status_code == 200:
            print(f"📡 Sent checkpoint: {name} CP{checkpoint_id} @ {time_str}")
            return True
        else:
            print(f"⚠️ Server responded {resp.status_code}: {resp.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to send checkpoint: {e}")
        return False


def send_violation(name, expected_bib, detected_bib, checkpoint_id, frame):
    """POST violation data + base64-encoded image to the central server."""
    if SERVER_URL is None:
        print("❌ client_sender not initialized. Call init() first.")
        return False
    try:
        # Encode frame as JPEG → base64 string
        _, buf = cv2.imencode('.jpg', frame)
        img_b64 = base64.b64encode(buf).decode('utf-8')

        resp = requests.post(
            f"{SERVER_URL}/api/report_violation",
            json={
                "name": name,
                "expected_bib": expected_bib if expected_bib else "N/A",
                "detected_bib": detected_bib,
                "checkpoint_id": checkpoint_id,
                "image_b64": img_b64
            },
            timeout=5
        )
        if resp.status_code == 200:
            print(f"📡 Sent violation: {name} Bib {detected_bib}")
            return True
        else:
            print(f"⚠️ Server responded {resp.status_code}: {resp.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Failed to send violation: {e}")
        return False
