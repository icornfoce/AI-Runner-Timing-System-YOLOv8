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
from helpers.event_helper import (
    get_active_event, set_active_event, clear_active_event,
    list_events, create_event, get_active_event_paths,
    delete_event, clear_event_data
)

app = Flask(__name__)
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


# ===================== API — Event Management =====================

@app.route('/api/events')
def api_list_events():
    """คืนค่ารายชื่อ Event ทั้งหมด"""
    return jsonify(list_events())


@app.route('/api/events/active')
def api_active_event():
    """คืนค่า Event ที่เปิดใช้งานอยู่"""
    active = get_active_event()
    return jsonify({"active_event": active})


@app.route('/api/events/create', methods=['POST'])
def api_create_event():
    """สร้าง Event ใหม่ + ตั้งเป็น active"""
    data = request.get_json()
    name = data.get('name', '').strip()
    if not name:
        return jsonify({"error": "Event name is required"}), 400

    # Sanitize: replace spaces with underscores, remove special chars
    safe_name = "".join(c if c.isalnum() or c in ('_', '-') else '_' for c in name)

    if not create_event(safe_name):
        return jsonify({"error": f"Event '{safe_name}' already exists"}), 409

    set_active_event(safe_name)
    # Initialize CSV files for new event
    paths = get_active_event_paths()
    init_log_file(paths)

    socketio.emit('event_changed', {'event': safe_name})
    print(f"📁 Created & activated event: {safe_name}")
    return jsonify({"success": True, "event": safe_name})


@app.route('/api/events/select', methods=['POST'])
def api_select_event():
    """เลือก Event ที่มีอยู่แล้ว"""
    data = request.get_json()
    name = data.get('name', '').strip()
    if not name:
        return jsonify({"error": "Event name is required"}), 400

    events = list_events()
    if name not in events:
        return jsonify({"error": f"Event '{name}' not found"}), 404

    set_active_event(name)
    # Ensure CSV files exist
    paths = get_active_event_paths()
    init_log_file(paths)

    socketio.emit('event_changed', {'event': name})
    print(f"📁 Activated event: {name}")
    return jsonify({"success": True, "event": name})


@app.route('/api/events/clear', methods=['POST'])
def api_clear_event():
    """ลบข้อมูลใน Event (PIN protected)"""
    data = request.get_json()
    pin = data.get('pin', '')
    target = data.get('target', 'current')

    if pin != config.JUDGE_PIN:
        return jsonify({"error": "Wrong PIN"}), 403

    active = get_active_event()
    if not active:
        return jsonify({"error": "No active event"}), 400

    if target == "current":
        # ลบข้อมูลแต่เก็บโฟลเดอร์
        clear_event_data(active)
        # สร้าง CSV ใหม่
        paths = get_active_event_paths()
        init_log_file(paths)
        socketio.emit('event_changed', {'event': active})
        print(f"🗑️ Cleared data for event: {active}")
        return jsonify({"success": True, "message": f"Data cleared for '{active}'"})

    elif target == "all":
        # ลบโฟลเดอร์ทั้งหมด
        delete_event(active)
        clear_active_event()
        socketio.emit('event_changed', {'event': None})
        print(f"🗑️ Deleted entire event: {active}")
        return jsonify({"success": True, "message": f"Event '{active}' deleted"})

    return jsonify({"error": "Invalid target. Use 'current' or 'all'"}), 400


# ===================== API — Dashboard Data =====================

@app.route('/api/data')
def get_data():
    paths = get_active_event_paths()
    if not paths:
        return jsonify([])

    log_file = paths["log_file"]
    if not os.path.exists(log_file):
        return jsonify([])

    try:
        df = pd.read_csv(log_file)
        df = df.fillna("-")
        return jsonify(df.to_dict(orient='records'))
    except Exception as e:
        return jsonify({"error": str(e)})


@app.route('/api/violations')
def api_get_violations():
    """อ่านจาก violations_log.csv ของ active event"""
    violations = get_all_violations()
    return jsonify(violations)


@app.route('/api/violations/<timestamp>/status', methods=['POST'])
def api_update_violation_status(timestamp):
    if not session.get('judge_authenticated'):
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    new_status = data.get('status', '')
    if new_status not in ('confirmed', 'dismissed'):
        return jsonify({"error": "Invalid status"}), 400

    success = update_violation_status(timestamp, new_status)
    if success:
        socketio.emit('violation_updated', {'timestamp': timestamp, 'status': new_status})
        return jsonify({"success": True})
    return jsonify({"error": "Violation not found"}), 404


@app.route('/violations/<path:filename>')
def serve_violation(filename):
    """Serve violation image จาก active event"""
    paths = get_active_event_paths()
    if paths:
        return send_from_directory(paths["violations_dir"], filename)
    return send_from_directory(config.VIOLATION_DIR, filename)


# ===================== API — Client Reporting =====================

@app.route('/api/report', methods=['POST'])
def api_report_checkpoint():
    try:
        data = request.get_json()
        name = data.get('name')
        checkpoint_id = data.get('checkpoint_id')

        if not name or checkpoint_id is None:
            return jsonify({"error": "Missing 'name' or 'checkpoint_id'"}), 400

        init_log_file()
        success = record_checkpoint(name, checkpoint_id)

        if success:
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
    try:
        data = request.get_json()
        name = data.get('name')
        expected_bib = data.get('expected_bib', 'N/A')
        detected_bib = data.get('detected_bib')
        checkpoint_id = data.get('checkpoint_id', config.CHECKPOINT_ID)
        image_b64 = data.get('image_b64')

        if not name or not detected_bib:
            return jsonify({"error": "Missing required fields"}), 400

        # Resolve violations dir from active event
        paths = get_active_event_paths()
        viol_dir = paths["violations_dir"] if paths else config.VIOLATION_DIR

        image_path = ""
        if image_b64:
            img_bytes = base64.b64decode(image_b64)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

            if frame is not None:
                os.makedirs(viol_dir, exist_ok=True)
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"{name}_violation_{timestamp}.jpg"
                image_path = os.path.join(viol_dir, filename)
                cv2.imwrite(image_path, frame)

        violation_data = log_violation(name, expected_bib, detected_bib, checkpoint_id, image_path)

        if violation_data:
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


# ===================== UTILITIES =====================

def get_local_ip():
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
    os.makedirs(config.EVENTS_DIR, exist_ok=True)

    local_ip = get_local_ip()
    print("=" * 50)
    print(f"🌐 Server running on:")
    print(f"   Local:   http://localhost:5000")
    print(f"   Network: http://{local_ip}:5000")
    print(f"")
    print(f"   Dashboard:  http://{local_ip}:5000/")
    print(f"   Judge Panel: http://{local_ip}:5000/judge")
    print("=" * 50)

    socketio.run(app, host='0.0.0.0', port=5000, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
