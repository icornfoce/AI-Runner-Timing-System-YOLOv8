from flask import Flask, render_template, jsonify
import pandas as pd
import os

app = Flask(__name__)
LOG_FILE = "running_results.csv"

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/data')
def get_data():
    if not os.path.exists(LOG_FILE):
        return jsonify([])
    
    try:
        df = pd.read_csv(LOG_FILE)
        # เคลียร์ค่า NaN เพื่อให้ส่งเป็น JSON ได้
        df = df.fillna("-")
        data = df.to_dict(orient='records')
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)})

if __name__ == '__main__':
    # สร้างโฟลเดอร์ templates ถ้ายังไม่มี
    if not os.path.exists('templates'):
        os.makedirs('templates')
    app.run(host='0.0.0.0', port=5000, debug=True)
