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

# Live Checkpoint — real-time cheating-detection station (NO timing).
# Restored 2026-05-22 (see AI_CONTEXT §4.2/§6.2). Identifies runners by
# face, verifies the BIB, and flags WRONG_PERSON — including a stranger
# wearing a registered runner's BIB — via reportViolation + markCheating,
# with live per-type violation counters. Coexists with the Drive Scanner
# (/scan); both share the identity-verification backend contract.
@app.route('/checkpoint')
def checkpoint():
    return render_template('checkpoint.html')

@app.route('/scan')
def scan():
    return render_template('photo_scanner.html')

# Backward-compatible aliases
@app.route('/admin')
def admin():
    return render_template('dashboard.html')

if __name__ == '__main__':
    # High-Performance Local Mode: threaded=True lets the Flask dev
    # server handle template requests from multiple browser tabs /
    # concurrent fetches without head-of-line blocking. Safe here
    # because every route in this file is a pure render_template
    # with zero shared mutable server-side state — all AI work runs
    # in the browser.
    app.run(debug=True, port=5000, threaded=True)
