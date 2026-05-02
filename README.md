# 🏃‍♂️ AI Runner Timing System

ระบบจับเวลาวิ่งอัตโนมัติด้วย AI ที่ทำงาน **100% บนเว็บเบราว์เซอร์** — ตรวจจับใบหน้า, ระบุตัวตนนักวิ่ง, อ่านหมายเลข BIB ด้วย OCR และบันทึกเวลาแบบ Real-time ไม่ต้องใช้ชิป RFID หรืออุปกรณ์ติดตัวใดๆ

---

## ✨ Features

- **🧠 AI Face Recognition** — จดจำใบหน้านักวิ่งด้วย face-api.js (SSD MobileNet + FaceRecognitionNet)
- **🔢 Bib OCR** — อ่านหมายเลขวิ่งจากเสื้อด้วย Tesseract.js แบบ Smart (ทำงานเมื่อจำเป็นเท่านั้น)
- **⏱️ Multi-Checkpoint** — รองรับ CP1 (สตาร์ท) และ CP2 (เส้นชัย) คำนวณเวลาอัตโนมัติ
- **🚨 Violation Detection** — ตรวจจับ BIB ไม่ตรง, สวม BIB คนอื่น, นักวิ่งไม่ลงทะเบียน
- **📺 Live Dashboard** — ตารางอันดับ + แจ้งเตือนกรรมการแบบ Real-time
- **🔐 Admin Portal** — จัดการนักวิ่ง, ยืนยัน/ลบ violation, แก้ไขเวลา
- **☁️ Cloud Backend** — Google Apps Script + Google Sheets + Google Drive

---

## 🛠️ Tech Stack

| Component | Technology |
|---|---|
| Face Detection & Recognition | [face-api.js](https://github.com/justadudewhohacks/face-api.js) |
| Bib OCR | [Tesseract.js](https://github.com/naptha/tesseract.js) |
| Camera | HTML5 `getUserMedia` API |
| Backend / Database | Google Apps Script + Google Sheets |
| Photo Storage | Google Drive |
| Real-time Updates | Polling via `fetch()` |
| Fonts | Bebas Neue + DM Sans + JetBrains Mono |

---

## 📁 Project Structure

```
AI-Runner-Timing-System-YOLOv8/
├── templates/
│   ├── register.html       📋 ลงทะเบียนนักวิ่ง (ถ่ายหน้า 5 มุม)
│   ├── checkpoint.html      📷 จุด Checkpoint (ตรวจจับ + จับเวลา)
│   └── dashboard.html       📺 Dashboard + Admin Portal
├── apps_script/
│   └── Code.gs              ☁️ Google Apps Script Backend
├── legacy_v1/               📦 ระบบเดิม (Python/OpenCV) สำรองไว้
│   ├── main.py
│   ├── web_app.py
│   ├── config.py
│   └── capture_faces.py
└── Data/                    🖼️ ฐานข้อมูลรูปหน้า (legacy)
```

---

## 🚀 Getting Started

### 1. Deploy Google Apps Script

1. สร้าง Google Sheets ใหม่
2. ไปที่ **Extensions → Apps Script**
3. คัดลอกเนื้อหาจาก `apps_script/Code.gs` ไปวาง
4. กด **Deploy → New Deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. คัดลอก URL ที่ได้

### 2. อัปเดต API URL

แก้ไขค่า `API_URL` หรือ `API` ในไฟล์ทั้ง 3:
- `templates/register.html` → บรรทัด `const API_URL = "..."`
- `templates/checkpoint.html` → บรรทัด `const API = "..."`
- `templates/dashboard.html` → บรรทัด `const API = "..."`

### 3. เปิดใช้งาน

เปิดไฟล์ HTML ตรงในเบราว์เซอร์ หรือ host บน GitHub Pages / static server:

```bash
# ตัวเลือก: ใช้ Live Server
npx serve templates/
```

---

## 📖 How to Use

### Step 1: ลงทะเบียนนักวิ่ง

เปิด **`register.html`** → กรอกชื่อ + BIB → ถ่ายหน้า 5 มุม → Submit

| มุม | คำอธิบาย |
|---|---|
| 😐 Front | หน้าตรง |
| 🙇 Top | ก้มหน้าเล็กน้อย |
| 🙄 Bottom | เงยหน้าเล็กน้อย |
| 👈 Left | หันซ้าย |
| 👉 Right | หันขวา |

### Step 2: ตั้งจุด Checkpoint

เปิด **`checkpoint.html`** → เลือก CP1 หรือ CP2 → ระบบจะเริ่มตรวจจับอัตโนมัติ

- **CP1** = จุดสตาร์ท (บันทึกเวลาเริ่ม)
- **CP2** = เส้นชัย (บันทึกเวลาจบ + คำนวณ Duration)

### Step 3: ดูผลแบบ Real-time

เปิด **`dashboard.html`** → ดูตารางอันดับ + การแจ้งเตือน violation

- 📊 Leaderboard อัปเดตทุก 1 วินาที
- 🚨 Violation alerts อัปเดตทุก 2 วินาที (เฉพาะที่ Admin ยืนยันแล้ว)

### Step 4: จัดการระบบ (Admin)

ที่หน้า Dashboard กด **🔐 Admin** → ใส่รหัส → จัดการข้อมูลทั้งหมด

---

## ⚙️ Configuration

| ค่า | ตำแหน่ง | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|---|
| `COOLDOWN_SEC` | checkpoint.html | `30` | ป้องกันบันทึกซ้ำ (วินาที) |
| `ADMIN_PW` | dashboard.html | `muto67` | รหัสผ่าน Admin |
| Face Distance | checkpoint.html | `0.5` | เกณฑ์จำหน้า (ยิ่งน้อย = ยิ่งเข้มงวด) |
| Smart OCR | checkpoint.html | `10 frames` | เรียก OCR หลังเจอหน้าต่อเนื่อง 10 เฟรม |

---

## 🧪 Google Sheets Structure

ระบบจะสร้าง 3 Sheets อัตโนมัติ:

**Runners** — ข้อมูลนักวิ่ง
```
Name | BibNumber | Email | RegisteredAt | Photo_Front | ... | FolderUrl | Embeddings
```

**Results** — ผลเวลาวิ่ง
```
Name | BibNumber | CP1_Time | CP2_Time | Lap1_Duration | UpdatedAt
```

**Violations** — ประวัติความผิดปกติ
```
ID | Name | BibNumber | Message | ImageUrl | Timestamp | Verified | VerifiedAt
```

---

## 📦 Legacy System

ระบบเดิม (Python + OpenCV + YOLOv8) ถูกเก็บไว้ใน `legacy_v1/` สำหรับใช้งาน Offline เมื่อไม่มีอินเทอร์เน็ต — ดูรายละเอียดใน `legacy_v1/main.py`

---

## 📄 License

MIT License
