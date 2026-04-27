from flask import Flask, render_template, jsonify, send_from_directory
import pandas as pd
import os

app = Flask(__name__)
LOG_FILE = "running_results.csv"
VIOLATION_DIR = "violations"

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/data')
def get_data():
    if not os.path.exists(LOG_FILE):
        return jsonify([])
    
    try:
        df = pd.read_csv(LOG_FILE)
        df = df.fillna("-")
        data = df.to_dict(orient='records')
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route('/api/violations')
def get_violations():
    if not os.path.exists(VIOLATION_DIR):
        return jsonify([])
    
    violations = []
    for filename in os.listdir(VIOLATION_DIR):
        if filename.endswith(".jpg"):
            # ตัวอย่างชื่อไฟล์: John_violation_20240427_231500.jpg
            parts = filename.replace(".jpg", "").split("_violation_")
            name = parts[0]
            timestamp = parts[1] if len(parts) > 1 else "-"
            violations.append({
                "name": name,
                "timestamp": timestamp,
                "image_url": f"/violations/{filename}"
            })
    # เรียงตามเวลาล่าสุด
    violations.sort(key=lambda x: x['timestamp'], reverse=True)
    return jsonify(violations)

@app.route('/violations/<path:filename>')
def serve_violation(filename):
    return send_from_directory(VIOLATION_DIR, filename)

if __name__ == '__main__':
    if not os.path.exists('templates'):
        os.makedirs('templates')
    if not os.path.exists(VIOLATION_DIR):
        os.makedirs(VIOLATION_DIR)
        
    app.run(host='0.0.0.0', port=5000, debug=True)
