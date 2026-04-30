from flask import Flask, render_template, jsonify, request, session, redirect, url_for, send_from_directory
from flask_socketio import SocketIO, emit
import pandas as pd
import os
import base64
import socket as net_socket
import numpy as np
import cv2
from datetime import datetime

import config
from helpers.csv_helper import (
    init_log_file, record_checkpoint, log_violation,
    get_all_violations, update_violation_status
)

app = Flask(__name__)
# Bug 3 fix: use fixed secret key from config so sessions survive restarts
app.secret_key = config.FLASK_SECRET_KEY
socketio = SocketIO(app, cors_allowed_origins="*")


# ===================== PAGES =====================

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/judge', methods=['GET', 'POST'])
def judge():
    if request.method == 'POST':
        pin = request.form.get('pin', '')
        if pin == config.JUDGE_PIN:
            session['judge_authenticated'] = True
            return redirect(url_for('judge'))
        else:
            return render_template('judge.html', authenticated=False, error="PIN ไม่ถูกต้อง")

    if session.get('judge_authenticated'):
        return render_template('judge.html', authenticated=True, error=None)
    return render_template('judge.html', authenticated=False, error=None)


@app.route('/judge/logout')
def judge_logout():
    session.pop('judge_authenticated', None)
    return redirect(url_for('judge'))


# ===================== API — Dashboard =====================

@app.route('/api/data')
def get_data():
    if not os.path.exists(config.LOG_FILE):
        return jsonify([])

    try:
        df = pd.read_csv(config.LOG_FILE)
        df = df.fillna("-")
        data = df.to_dict(orient='records')
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)})


@app.route('/api/violations')
def api_get_violations():
    """อ่านจาก violations_log.csv"""
    violations = get_all_violations()
    return jsonify(violations)


@app.route('/api/violations/<timestamp>/status', methods=['POST'])
def api_update_violation_status(timestamp):
    """POST endpoint สำหรับ Judge confirm/dismiss violation"""
    if not session.get('judge_authenticated'):
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    new_status = data.get('status', '')
    if new_status not in ('confirmed', 'dismissed'):
        return jsonify({"error": "Invalid status. Use 'confirmed' or 'dismissed'"}), 400

    success = update_violation_status(timestamp, new_status)
    if success:
        socketio.emit('violation_updated', {
            'timestamp': timestamp,
            'status': new_status
        })
        return jsonify({"success": True})
    return jsonify({"error": "Violation not found"}), 404


@app.route('/violations/<path:filename>')
def serve_violation(filename):
    return send_from_directory(config.VIOLATION_DIR, filename)


# ===================== API — Client Reporting =====================
# These endpoints receive data from remote camera clients (main.py in "client" mode)

@app.route('/api/report', methods=['POST'])
def api_report_checkpoint():
    """รับข้อมูล checkpoint จากกล้อง client → บันทึกลง CSV → emit update via SocketIO"""
    try:
        data = request.get_json()
        name = data.get('name')
        checkpoint_id = data.get('checkpoint_id')

        if not name or checkpoint_id is None:
            return jsonify({"error": "Missing 'name' or 'checkpoint_id'"}), 400

        # Initialize log file if needed
        init_log_file()
        success = record_checkpoint(name, checkpoint_id)

        if success:
            # Emit real-time update to all dashboard viewers
            socketio.emit('checkpoint_update', {
                'name': name,
                'checkpoint_id': checkpoint_id,
                'time': data.get('time', '')
            })
            print(f"📥 Received checkpoint: {name} CP{checkpoint_id}")
            return jsonify({"success": True})
        return jsonify({"error": "Failed to record checkpoint"}), 500
    except Exception as e:
        print(f"❌ Report checkpoint error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/report_violation', methods=['POST'])
def api_report_violation():
    """รับข้อมูล violation + รูปภาพ base64 จากกล้อง client → decode + save → emit alert"""
    try:
        data = request.get_json()
        name = data.get('name')
        expected_bib = data.get('expected_bib', 'N/A')
        detected_bib = data.get('detected_bib')
        checkpoint_id = data.get('checkpoint_id', config.CHECKPOINT_ID)
        image_b64 = data.get('image_b64')

        if not name or not detected_bib:
            return jsonify({"error": "Missing required fields"}), 400

        # Issue 5 fix: imports moved to top of file
        # Decode and save image
        image_path = ""
        if image_b64:
            img_bytes = base64.b64decode(image_b64)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

            if frame is not None:
                if not os.path.exists(config.VIOLATION_DIR):
                    os.makedirs(config.VIOLATION_DIR)
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"{name}_violation_{timestamp}.jpg"
                image_path = os.path.join(config.VIOLATION_DIR, filename)
                cv2.imwrite(image_path, frame)

        # Log to violations_log.csv
        violation_data = log_violation(name, expected_bib, detected_bib, checkpoint_id, image_path)

        if violation_data:
            # Emit real-time alert to all dashboard viewers
            socketio.emit('new_violation', violation_data)
            print(f"📥 Received violation: {name} Bib {detected_bib}")
            return jsonify({"success": True})
        return jsonify({"error": "Failed to log violation"}), 500
    except Exception as e:
        print(f"❌ Report violation error: {e}")
        return jsonify({"error": str(e)}), 500


# ===================== SOCKET.IO =====================

@socketio.on('connect')
def handle_connect():
    print("🔌 Client connected to Socket.IO")


# Issue 8 fix: removed dead emit_new_violation() function — socketio.emit() is called directly


# ===================== UTILITIES =====================

def get_local_ip():
    """ดึง IP ของเครื่องในเครือข่าย LAN"""
    try:
        s = net_socket.socket(net_socket.AF_INET, net_socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"


# ===================== MAIN =====================

if __name__ == '__main__':
    if not os.path.exists('templates'):
        os.makedirs('templates')
    if not os.path.exists(config.VIOLATION_DIR):
        os.makedirs(config.VIOLATION_DIR)

    # Initialize log file on server startup
    init_log_file()

    local_ip = get_local_ip()
    print("=" * 50)
    print(f"🌐 Server running on:")
    print(f"   Local:   http://localhost:5000")
    print(f"   Network: http://{local_ip}:5000")
    print(f"")
    print(f"   Dashboard:  http://{local_ip}:5000/")
    print(f"   Judge Panel: http://{local_ip}:5000/judge")
    print("=" * 50)

    # Issue 7 fix: disable reloader to prevent duplicate SocketIO events
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
