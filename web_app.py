"""
RunnerTrack AI — Web App (v2)
Serves the new browser-based pages: Register, Checkpoint, Dashboard.
All AI processing happens client-side (face-api.js / Tesseract.js).
Backend = Google Apps Script + Google Sheets.
"""
from flask import Flask, render_template

app = Flask(__name__)

# ── PUBLIC PAGES ──
@app.route('/')
def dashboard():
    return render_template('dashboard.html')

@app.route('/register')
def register():
    return render_template('register.html')

# Live recognition page retired 2026-05-17 in favor of the Drive Photo
# Scanner (/scan). templates/checkpoint.html is kept on disk so live
# mode can be reinstated by re-enabling this route, but the dashboard
# no longer advertises it.
# @app.route('/checkpoint')
# def checkpoint():
#     return render_template('checkpoint.html')

@app.route('/scan')
def scan():
    return render_template('photo_scanner.html')

# Backward-compatible aliases
@app.route('/admin')
def admin():
    return render_template('dashboard.html')

if __name__ == '__main__':
    app.run(debug=True, port=5000)
