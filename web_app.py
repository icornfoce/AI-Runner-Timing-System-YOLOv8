from flask import Flask, render_template, jsonify, send_from_directory, request, session
import pandas as pd
import os
import secrets
from datetime import datetime
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.secret_key = secrets.token_hex(16)

LOG_FILE = "/home/Bigrock/mysite/running_results.csv"
VIOLATION_DIR = "/home/Bigrock/mysite/violations"
VIOLATION_LOG = "/home/Bigrock/mysite/violations_log.csv"
REGISTRY_FILE = "/home/Bigrock/mysite/runners_registry.csv"
ADMIN_PASSWORD = "muto67"

def init_log_file():
    if not os.path.exists(LOG_FILE):
        df = pd.DataFrame(columns=['Name', 'CP1_Time', 'CP2_Time', 'Lap1_Duration', 'Total_Time'])
        df.to_csv(LOG_FILE, index=False)

def init_violation_log():
    if not os.path.exists(VIOLATION_LOG):
        df = pd.DataFrame(columns=['timestamp', 'name', 'message', 'image_filename', 'verified'])
        df.to_csv(VIOLATION_LOG, index=False)

def init_registry():
    if not os.path.exists(REGISTRY_FILE):
        df = pd.DataFrame(columns=['Name', 'BibNumber'])
        df.to_csv(REGISTRY_FILE, index=False)

def is_admin():
    return session.get("is_admin", False)

def calc_duration(cp1, cp2):
    try:
        t1 = datetime.strptime(cp1, "%H:%M:%S")
        t2 = datetime.strptime(cp2, "%H:%M:%S")
        d = (t2 - t1).total_seconds()
        if d < 0: d += 86400
        return f"{int(d // 60)}:{int(d % 60):02d}"
    except:
        return ""

# ===================== PUBLIC ROUTES =====================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin_page():
    return render_template('admin.html')

@app.route('/api/data')
def get_data():
    if not os.path.exists(LOG_FILE):
        return jsonify([])
    try:
        df = pd.read_csv(LOG_FILE)
        df = df.fillna("-")
        return jsonify(df.to_dict(orient='records'))
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route('/api/record', methods=['POST'])
def receive_record():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "No JSON data"}), 400
        name = data.get("name")
        checkpoint_id = data.get("checkpoint_id")
        timestamp = data.get("timestamp")
        if not all([name, checkpoint_id, timestamp]):
            return jsonify({"status": "error", "message": "Missing fields"}), 400
        init_log_file()
        df = pd.read_csv(LOG_FILE)
        user_row = df[df['Name'] == name]
        if checkpoint_id == 1:
            if user_row.empty:
                df = pd.concat([df, pd.DataFrame([{'Name': name, 'CP1_Time': timestamp}])], ignore_index=True)
            else:
                df.at[user_row.index[0], 'CP1_Time'] = timestamp
        elif checkpoint_id == 2:
            if user_row.empty:
                df = pd.concat([df, pd.DataFrame([{'Name': name, 'CP2_Time': timestamp}])], ignore_index=True)
            else:
                idx = user_row.index[0]
                cp1 = str(df.at[idx, 'CP1_Time'])
                df.at[idx, 'CP2_Time'] = timestamp
                if cp1 != 'nan' and cp1 != '-':
                    ds = calc_duration(cp1, timestamp)
                    if ds:
                        df.at[idx, 'Lap1_Duration'] = ds
                        df.at[idx, 'Total_Time'] = ds
        df.to_csv(LOG_FILE, index=False)
        return jsonify({"status": "success", "message": f"{name} CP{checkpoint_id} recorded"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/violation', methods=['POST'])
def receive_violation():
    try:
        name = request.form.get("name")
        message = request.form.get("message")
        timestamp = request.form.get("timestamp")
        image = request.files.get("image")
        if not all([name, message, timestamp]):
            return jsonify({"status": "error", "message": "Missing fields"}), 400
        if not os.path.exists(VIOLATION_DIR):
            os.makedirs(VIOLATION_DIR)
        image_filename = ""
        if image:
            image_filename = secure_filename(f"{name}_violation_{timestamp}.jpg")
            image.save(os.path.join(VIOLATION_DIR, image_filename))
        init_violation_log()
        df = pd.read_csv(VIOLATION_LOG)
        df = pd.concat([df, pd.DataFrame([{
            'timestamp': timestamp, 'name': name,
            'message': message, 'image_filename': image_filename,
            'verified': False
        }])], ignore_index=True)
        df.to_csv(VIOLATION_LOG, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/violations')
def get_violations():
    if not os.path.exists(VIOLATION_LOG):
        return jsonify([])
    try:
        df = pd.read_csv(VIOLATION_LOG).fillna("")
        df = df.sort_values('timestamp', ascending=False).head(20)
        violations = []
        for _, row in df.iterrows():
            violations.append({
                "name": str(row['name']),
                "message": str(row['message']),
                "timestamp": str(row['timestamp']),
                "image_url": f"/violations/{row['image_filename']}" if row['image_filename'] else "",
                "verified": str(row.get('verified', 'False')) == 'True'
            })
        return jsonify(violations)
    except:
        return jsonify([])

@app.route('/violations/<path:filename>')
def serve_violation(filename):
    return send_from_directory(VIOLATION_DIR, filename)

# ===================== ADMIN AUTH =====================

@app.route('/admin/login', methods=['POST'])
def admin_login():
    data = request.get_json()
    if data and data.get("password") == ADMIN_PASSWORD:
        session["is_admin"] = True
        return jsonify({"status": "ok"})
    return jsonify({"status": "error", "message": "รหัสผ่านไม่ถูกต้อง"}), 401

@app.route('/admin/logout', methods=['POST'])
def admin_logout():
    session.clear()
    return jsonify({"status": "ok"})

@app.route('/admin/check')
def admin_check():
    return jsonify({"logged_in": is_admin()})

# ===================== ADMIN DATA MANAGEMENT =====================

@app.route('/admin/runners')
def admin_runners():
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    init_log_file()
    init_registry()
    df_results = pd.read_csv(LOG_FILE).fillna("-")
    df_reg = pd.read_csv(REGISTRY_FILE)
    reg_dict = dict(zip(df_reg['Name'], df_reg['BibNumber'].astype(str)))
    records = df_results.to_dict(orient='records')
    for r in records:
        r['Bib'] = reg_dict.get(r['Name'], '-')
    return jsonify(records)

@app.route('/admin/runner/<name>', methods=['PUT'])
def admin_update_runner(name):
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        data = request.get_json()
        init_log_file()
        df = pd.read_csv(LOG_FILE)
        user_row = df[df['Name'] == name]
        if user_row.empty:
            return jsonify({"status": "error", "message": "Runner not found"}), 404
        idx = user_row.index[0]
        for field in ['CP1_Time', 'CP2_Time', 'Lap1_Duration', 'Total_Time']:
            if field in data:
                df.at[idx, field] = data[field]
        # Auto-recalculate duration if both CP times present
        cp1 = str(df.at[idx, 'CP1_Time'])
        cp2 = str(df.at[idx, 'CP2_Time'])
        if cp1 not in ('nan', '-', '') and cp2 not in ('nan', '-', ''):
            ds = calc_duration(cp1, cp2)
            if ds:
                df.at[idx, 'Lap1_Duration'] = ds
                df.at[idx, 'Total_Time'] = ds
        df.to_csv(LOG_FILE, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/admin/runner/<name>', methods=['DELETE'])
def admin_delete_runner(name):
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        init_log_file()
        df = pd.read_csv(LOG_FILE)
        df = df[df['Name'] != name]
        df.to_csv(LOG_FILE, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/admin/runner', methods=['POST'])
def admin_add_runner():
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        data = request.get_json()
        name = data.get("name")
        bib = data.get("bib")
        if not name:
            return jsonify({"status": "error", "message": "Name required"}), 400
        init_registry()
        df = pd.read_csv(REGISTRY_FILE)
        # Remove existing entry if any
        df = df[df['Name'] != name]
        df = pd.concat([df, pd.DataFrame([{'Name': name, 'BibNumber': bib or ''}])], ignore_index=True)
        df.to_csv(REGISTRY_FILE, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/admin/violation/<filename>', methods=['DELETE'])
def admin_delete_violation(filename):
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        # Delete image file
        img_path = os.path.join(VIOLATION_DIR, filename)
        if os.path.exists(img_path):
            os.remove(img_path)
        # Remove from CSV log
        if os.path.exists(VIOLATION_LOG):
            df = pd.read_csv(VIOLATION_LOG)
            df = df[df['image_filename'] != filename]
            df.to_csv(VIOLATION_LOG, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/admin/violation/<filename>/verify', methods=['PUT'])
def admin_verify_violation(filename):
    if not is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        if os.path.exists(VIOLATION_LOG):
            df = pd.read_csv(VIOLATION_LOG)
            mask = df['image_filename'] == filename
            if mask.any():
                df.loc[mask, 'verified'] = True
                df.to_csv(VIOLATION_LOG, index=False)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    os.makedirs('templates', exist_ok=True)
    os.makedirs(VIOLATION_DIR, exist_ok=True)
    init_log_file()
    init_violation_log()
    init_registry()
    app.run(host='0.0.0.0', port=5000, debug=True)
