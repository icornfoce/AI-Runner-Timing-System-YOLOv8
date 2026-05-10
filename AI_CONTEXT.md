# AI_CONTEXT.md — RunnerTrack AI System Memory

> **Purpose of this file**
> This document is the canonical, authoritative reference for any AI agent
> (Claude / Cursor / Copilot / etc.) working on this repository. It is the
> first thing that should be read at the start of every session. It is
> maintained by AI agents themselves: any task, feature, or bug fix that
> changes architecture, data flow, schemas, public endpoints, polling
> cadence, caching, or guardrails MUST update this file in the same change
> set.
>
> **Last updated:** 2026-05-10 — **Hybrid architecture**: browser
> checkpoint UI restored as primary; YOLOv8 + EasyOCR exposed via a
> local Flask `/analyze` endpoint inside `web_app.py`. (Same day,
> later: PaddleOCR was swapped for EasyOCR after `paddlepaddle` proved
> unavailable on Python 3.14; same hybrid architecture, same
> `extract_digits` contract.) Tesseract.js is
> fully removed. `templates/checkpoint.html` un-deprecated and
> refactored to fetch the local server every ~400 ms with a base64
> JPEG; per-detection BIB boxes are paired spatially with face-api
> faces and feed the existing castVote/cooldown/POST machinery. The
> standalone `checkpoint_camera.py` script is preserved as an
> alternative path. Backend stays at v6. Guardrails 8/19/20/24/26
> rewritten or removed to reflect the Tesseract→PaddleOCR cutover;
> Guardrail 16 still says edge AI is fine (the local Flask AI
> qualifies). Earlier the same day: edge-node migration v0
> (now superseded by hybrid); backend v5→v6 (single thumbnail URL
> contract; YYYY-MM-DD subfolders; `_migrateHistoricalImages()`
> replaces `_migrateAllImageUrls`).

---

## 1. Project Overview & Architecture

**RunnerTrack AI** is a chip-less runner timing system that identifies
runners by face recognition and reads BIB numbers via OCR — no RFID, no
wearable hardware. The system is bilingual UI (Thai labels, English
identifiers). All AI runs at the edge (operator's machine); the
Google Apps Script backend handles only storage and validation.

As of 2026-05-10 the **checkpoint** role uses a hybrid architecture:
the browser UI in `templates/checkpoint.html` runs face recognition and
the operator overlay, while the heavy YOLOv8 + EasyOCR inference is
offloaded to a local Flask `/analyze` endpoint hosted alongside the
templates inside `web_app.py`. Same machine, same Flask process, same
origin (port 5000) — no CORS. The standalone `checkpoint_camera.py`
remains as an alternative path; it is no longer the primary loop.

### High-level architecture

```
┌────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ register.html      │  │ checkpoint.html      │  │ dashboard.html       │
│ (browser)          │  │ (browser, primary)   │  │ (browser; +admin)    │
│ • face-api.js      │  │ • face-api.js        │  │ • polls Apps Script  │
│ • 5-angle capture  │  │ • POST /analyze      │  │ • leaderboard+alerts │
│ • avg 128-d desc   │  │   (~400 ms cadence)  │  │ • CRUD + bulk ops    │
│                    │  │ • spatial pair → vote│  │                      │
└──────────┬─────────┘  └────────┬─────────────┘  └──────────┬───────────┘
           │ POST                │ POST /analyze              │ GET/POST
           │ registerRunner      │ (same-origin, JSON)        │ getResults,
           │                     ▼                            │ getRunners,
           │            ┌─────────────────────────────┐       │ getVerifiedViolations,
           │            │ web_app.py (Flask, :5000)   │       │ verify/delete/update…
           │            │ • /, /register, /checkpoint │       │
           │            │ • /dashboard, /admin        │       │
           │            │ • POST /analyze ← YOLOv8 +  │       │
           │            │   EasyOCR (per-detection)   │       │
           │            │ • GET  /health              │       │
           │            └─────────────────────────────┘       │
           │                                                  │
           │ recordCheckpoint, reportViolation                │
           ▼                                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  GOOGLE APPS SCRIPT  (apps_script/Code.gs — v6)                    │
│  • doGet (cache-fronted reads, 12 s TTL)                           │
│  • doPost (writes; invalidate cache on success)                    │
│  • Drive cleanup on delete (synchronous, try-catch isolated)       │
└────────────────────────────────────────────────────────────────────┘
          │                                                  │
          ▼                                                  ▼
┌──────────────────────┐  ┌────────────────────────────────────────┐
│ Google Sheets        │  │ Google Drive                           │
│ • Runners            │  │ • RunnerFaces/<name>/<date>/<file>.jpg │
│ • Results            │  │ • ViolationEvidence/<date>/<file>.jpg  │
│ • Violations         │  │ (ANYONE_WITH_LINK / VIEW; thumbnail)   │
└──────────────────────┘  └────────────────────────────────────────┘

         Alternative: `python checkpoint_camera.py` runs the same AI
         in a headless cv2 window (no browser, no /analyze HTTP).
         Useful for kiosk-style deployments without a display server.
```

### Why this architecture

- **Zero hardware**: No RFID chips. The runner's face IS the identifier.
- **Zero install for operators**: Open a URL on any laptop with a webcam.
- **Cheap to operate**: Apps Script + Sheets + Drive is free at this scale.
- **Offline-capable backup**: `legacy_v1/` keeps a Python/OpenCV/YOLOv8
  implementation for events without internet.

---

## 2. File Structure & Responsibilities

```
AI-Runner-Timing-System-YOLOv8/
├── AI_CONTEXT.md          ← THIS FILE (system memory for AI agents)
├── README.md              ← human-facing project intro (Thai/English)
├── checkpoint_camera.py   ← Standalone alternative (YOLOv8 + EasyOCR,
│                            headless cv2 loop). Not in primary loop.
├── requirements.txt       ← all hybrid deps incl. flask, ultralytics,
│                            easyocr (which pulls torch), opencv-python
├── web_app.py             ← Flask host: serves templates AND the local
│                            POST /analyze endpoint (YOLOv8 + EasyOCR);
│                            also exposes GET /health for the frontend
│                            ready-poll. Loads models once at import.
├── yolov8n-face.pt        ← legacy YOLO weights (used by legacy_v1 only)
├── running_results.csv    ← legacy CSV log (gitignored, rarely cleared)
├── .gitignore
│
├── templates/             ← Browser frontend (all three active)
│   ├── register.html      ← Runner registration (5-angle face capture)
│   ├── checkpoint.html    ← Primary checkpoint UI; face-api.js +
│   │                        fetch /analyze (~400 ms cadence)
│   └── dashboard.html     ← Public leaderboard + Admin portal (login-gated)
│
├── apps_script/
│   └── Code.gs            ← Google Apps Script REST API (v6)
│
├── legacy_v1/             ← Python/OpenCV/YOLOv8 fallback (offline mode)
│   ├── main.py            ← standalone capture loop
│   ├── web_app.py         ← legacy Flask + REST + judge UI
│   ├── config.py          ← legacy thresholds / paths
│   ├── capture_faces.py   ← legacy enrollment script
│   ├── index.html         ← legacy public dashboard
│   └── admin.html         ← legacy admin UI
│
├── Data/                  ← legacy face-image database (gitignored)
├── events/                ← legacy per-event CSVs (gitignored)
└── helpers/               ← (empty in v2; reserved)
```

### File responsibilities at a glance

| File | Role | Touch this when… |
|---|---|---|
| `web_app.py` | Flask host: serves templates AND `POST /analyze` (YOLOv8 + EasyOCR) and `GET /health`. Loads models at import; first start ~4-8 s. **Primary AI host as of 2026-05-10.** | Detection model swap, OCR tuning, route changes, request validation |
| `checkpoint_camera.py` | Headless cv2 alternative (same models, no HTTP). Independent of the primary loop. | Kiosk-mode tweaks, drawing/cv2-window changes |
| `templates/register.html` | Capture 5 face angles, compute averaged 128-d descriptor, single atomic upload | Changing capture UX, embedding format, registration payload |
| `templates/checkpoint.html` | **Primary checkpoint UI.** face-api.js for identity; throttled `fetch('/analyze')` for BIB OCR; spatial face↔BIB pairing; existing castVote / cooldowns / GAS POST contract preserved | OCR cadence, pairing geometry, drawing, violation triggers |
| `templates/dashboard.html` | Public leaderboard, alerts, admin portal (auth, CRUD, bulk delete, type filter) | UI/UX, admin actions, polling, type taxonomy |
| `apps_script/Code.gs` | Backend REST + Sheets/Drive I/O + cache + migrations | Schema, endpoints, validation, cleanup logic |
| `legacy_v1/*` | Offline fallback. **Independent codebase.** | Only when explicitly fixing legacy mode |

---

## 3. Data Models & Storage

### 3.1 Google Sheets (3 tabs auto-created on first call)

**`Runners`** — one row per registered runner.
```
Name | BibNumber | Email | RegisteredAt
| Photo_Front | Photo_Top | Photo_Bottom | Photo_Left | Photo_Right
| FolderUrl | Embeddings
```
- `Name` is the **primary key** (case-sensitive, A-Z 0-9 _ - ., max 50 chars).
- `Photo_*` cells store Drive thumbnail URLs (v6+):
  `https://drive.google.com/thumbnail?id=<FILE_ID>&sz=w800`. Pre-v6
  rows may still carry the embed form (`uc?export=view&id=…`); run
  `_migrateHistoricalImages()` once to normalize them.
- `FolderUrl` is the runner's Drive folder.
- `Embeddings` is a JSON-stringified array of 128 floats (averaged across
  the 5 angles by the frontend).

**`Results`** — one row per runner who has crossed any timing point.
```
Name | BibNumber | Start_Time | CP1_Time | CP2_Time | CP3_Time | CP4_Time
| Finish_Time | Total_Duration | UpdatedAt
```
- All time columns are **plain text** `HH:MM:SS` (column C–I forced to
  `@` format on first creation to stop Sheets from converting to Date).
- `Total_Duration` is auto-computed as `Finish - Start` formatted `M:SS`
  whenever both Start and Finish are present.

**`Violations`** — one row per detected anomaly.
```
ID | Name | BibNumber | Message | ImageUrl | Timestamp
| Verified | VerifiedAt | ViolationType
```
- `ID` format: `"V" + Date.now()` (e.g. `V1714827234567`). Validated by
  `ID_PATTERN = /^V\d{10,}$/`.
- `ViolationType` is one of `NO_BIB`, `WRONG_PERSON`, `UNREGISTERED`,
  `MULTIPLE_BIBS`, `WRONG_ROUTE`, `OBSCURED_BIB`, `OTHER`. Empty
  defaults to `WRONG_PERSON` (matches `DEFAULT_VIOLATION_TYPE`).

### 3.2 Google Drive

```
My Drive/
├── RunnerFaces/                            ← shared ANYONE_WITH_LINK / VIEW
│   ├── kawin/
│   │   ├── 2026-05-10/                     ← YYYY-MM-DD subfolder (v6+)
│   │   │   ├── kawin_front_<ts>.jpg
│   │   │   ├── kawin_top_<ts>.jpg
│   │   │   ├── kawin_bottom_<ts>.jpg
│   │   │   ├── kawin_left_<ts>.jpg
│   │   │   └── kawin_right_<ts>.jpg
│   │   └── 2026-05-09/  …
│   └── …/
└── ViolationEvidence/                      ← shared ANYONE_WITH_LINK / VIEW
    ├── 2026-05-10/                         ← YYYY-MM-DD subfolder (v6+)
    │   └── violation_<name>_<ts>.jpg
    └── 2026-05-09/  …
```

- Folder creation is wrapped in a **`LockService` lock** to prevent
  duplicates from concurrent registrations / concurrent saves on the
  same date subfolder.
- **Single URL contract (v6+)**: every Drive image URL written by
  this backend uses the thumbnail form,
  `https://drive.google.com/thumbnail?id=<id>&sz=w800`. Both
  `Runners.Photo_*` and `Violations.ImageUrl` follow this contract.
  The embed form (`uc?export=view`) was retired because cookie-less
  `<img src>` requests bounce to a Google login page under strict
  third-party cookie defaults; thumbnail serves a public bitmap with
  no cookie dance and works for every consumer.
- Legacy rows (pre-v6) carry the embed form or the older
  `/file/d/<id>/view` viewer form. Run `_migrateHistoricalImages()`
  (see §6.6) once after deploying v6 to rewrite them to thumbnail.
  The Drive files themselves are never moved — only the URL stored
  in the sheet changes.
- `ANYONE_WITH_LINK / VIEW` sharing on the file is required for
  thumbnail to render — same as it was for embed.
- **Date-organized subfolders apply to NEW uploads only.** Files
  saved before v6 stay in the parent folder
  (`RunnerFaces/<name>/<file>` or `ViolationEvidence/<file>`); only
  uploads from v6 onward land in the date subfolder. The historical
  migration does not relocate them.
- The deletion path (`deleteViolation` → `extractDriveFileId`) is
  format-agnostic: its `/[?&]id=([-\w]{25,})/` and
  `/\/file\/d\/([-\w]{25,})/` regexes match the file ID inside any
  URL form (thumbnail, embed, legacy viewer).

### 3.3 Where the data lives in code

| Concept | Source-of-truth column / location |
|---|---|
| Runner identity | `Runners.Name` |
| Face descriptor | `Runners.Embeddings` (128-float JSON) |
| Race times | `Results.<Start/CP1-4/Finish>_Time` |
| Live alerts (dashboard) | `Violations` filtered by `Verified=true` |
| Admin queue | `Violations` (all rows, sorted by Timestamp desc, top 20) |

---

## 4. Critical Workflows

### 4.1 Registration (`register.html` → `registerRunner`)

1. Operator types `name` (lowercase enforced on submit), `bib`, optional `email`.
2. `face-api.js` (SSD MobileNet + Landmark68 + RecognitionNet) loads from
   the **pinned CDN tag `@0.22.2`**.
3. Operator captures 5 angles (front / top / bottom / left / right). Each
   capture runs `detectSingleFace().withFaceLandmarks().withFaceDescriptor()`
   and stores `{ dataUrl, descriptor }` in `capturedData`.
4. On submit, the 5 descriptors are **averaged into one 128-float vector**.
5. **Single atomic POST** carries all 5 base64 JPEGs + the averaged
   embedding — there is no partial-state path where a runner exists in the
   sheet without embeddings.
6. Backend creates `RunnerFaces/<name>/`, uploads JPEGs, writes the
   `Runners` row (or updates in place if `name` already exists),
   invalidates the runners cache.

### 4.2 Checkpoint detection (hybrid, primary)

The project ships TWO checkpoint pipelines:

- **§4.2.1 — Hybrid (browser + local Flask AI)**: primary path as of
  2026-05-10. `templates/checkpoint.html` runs face-api.js for runner
  identity and posts every ~400 ms to `web_app.py`'s `/analyze` endpoint
  (YOLOv8 + EasyOCR). The browser pairs each server-returned BIB box
  with a face by spatial proximity (chest region) and feeds the
  existing castVote / cooldown / GAS POST machinery from those
  results. Full-featured: face recognition, OCR consensus voting,
  per-CP cooldowns, five autonomous violation triggers (`NO_BIB`,
  `OBSCURED_BIB`, `WRONG_PERSON`, `MULTIPLE_BIBS`, `UNREGISTERED`).
- **§4.2.2 — Standalone Python** (`checkpoint_camera.py`): same AI
  models in a headless cv2 loop. No HTTP, no browser, no GAS POST —
  used for kiosk-style deployments. Independent of the primary loop.

The hybrid path is the default; operators run `pip install -r
requirements.txt && python web_app.py` and open `/checkpoint`. The
local server loads YOLO+EasyOCR once at import (~4-8 s on CPU; first run
also downloads ~100 MB of EasyOCR weights);
the frontend polls `GET /health` before opening the camera. If the
local server goes down mid-event, `recordCheckpoint` keeps firing
(face-only path), the UI shows an "AI offline" banner, and OCR-driven
violations naturally pause until the server returns.

#### 4.2.1 Hybrid pipeline (`templates/checkpoint.html` + `web_app.py`)

```
Browser (templates/checkpoint.html)         Local server (web_app.py, :5000)
─────────────────────────────────────       ─────────────────────────────────
init():
  load face-api models @0.22.2
  GET /?action=getRunners → FaceMatcher
  await waitForAIServer(/health, 30 s)      GET /health → {"ready": true}
  start requestAnimationFrame(processLoop)

processLoop (every rAF, ~60 fps):           POST /analyze (every ~400 ms)
  detectAllFaces().landmarks().descriptors  ────────────────────────────────►
  if (now - lastAnalyzeAt > 400 ms          {"image": "<base64 jpeg>"}
      && !analyzeBusy):
    analyzeFrame()                          → cv2.imdecode → YOLO_MODEL
                                              → per-box: clamp, crop,
                                                extract_digits(OCR_READER)
                                              → drop empty-digit entries
                                            ◄────────────────────────────────
                                            {"detections": [
                                              {"box":{x,y,w,h},
                                               "text":"67",
                                               "confidence":0.92,
                                               "label":"BIB"}, …
                                            ]}

  isNewCycle = lastAnalyzeAid !== processedAnalyzeId
  for each face:
    castFaceVote, smoothBox, recordCP gate (face-only, GR 22)
    if isNewCycle and consecutiveFrames[name] >= 3:
      consumeAnalyzeForFace(box, name):
        pairFaceToBib(box, lastDetections)   ← chest-region geometry
                                              (lateral ±0.5·faceH,
                                               vertical 0.6-3.0·faceH)
        all.length ≥ 2 (≥2 digits each) → MULTIPLE_BIBS
        primary == null                  → NO_BIB candidate (Ghost BIB)
        text fails len/conf gate         → OBSCURED_BIB candidate
        success                          → castVote(name, text, conf)
                                            consensus mismatch → WRONG_PERSON
  if isNewCycle: processedAnalyzeId = lastAnalyzeAid
  draw face boxes + drawDetectionTab(d) for d in lastDetections
  if serverStatus === "down": draw "AI offline" banner
```

**Cadence and throughput**: 400 ms server cadence is held by an
`analyzeBusy` flag — if inference takes longer than the interval, the
next fetch is skipped (no stacking). YOLOv8n + EasyOCR English on
CPU is ~80-120 ms/frame and ~150-300 ms per OCR ROI, so 2-3 BIBs in
view sit near the budget. Raise `ANALYZE_INTERVAL_MS` before
downgrading models if the HUD shows `analyzeBusy: true` continuously.

**EasyOCR confidence is 0-1** (Tesseract was 0-100); `PADDLE_MIN_CONF
= 0.6` is the floor and is checked against EasyOCR's `confidence`
field. (The constant name predates the Paddle→EasyOCR swap; it's kept
to avoid touching the frontend cosmetically.) The majority-vote gate
(3-of-5 over a 15 s window) is unchanged and still the primary
protection against single-frame misreads (Guardrail 21).

**Face↔BIB pairing**: `pairFaceToBib(faceBox, detections)` computes the
chest region from the smoothed face box (Guardrail 18) using factors
`PAIR_LATERAL_FACTOR=0.5`, `PAIR_TOP_FACTOR=0.6`,
`PAIR_BOTTOM_FACTOR=3.0`. Detections whose center sits inside this
region pair with the face; the nearest-to-face-center is `primary` and
feeds the vote, while `all` drives the `MULTIPLE_BIBS` count.

#### 4.2.2 Standalone Python (`checkpoint_camera.py`, v0)

```
init_models():
  YOLO(MODEL_PATH = "yolov8n.pt")         # COCO 80-class placeholder
  easyocr.Reader(["en"], gpu=False)
  print "Loading models..." banner before init (first run downloads ~100 MB)

init_camera(CAMERA_INDEX = 0):
  cv2.VideoCapture(0); raise RuntimeError if not isOpened()

main loop:
  ok, frame = cap.read()       # break on read failure
  process_frame(yolo, ocr, frame)
  cv2.imshow(WINDOW_NAME, frame)
  if cv2.waitKey(1) & 0xFF == ord("q"): break
  finally: cap.release(); cv2.destroyAllWindows()

process_frame:
  for d in detect(yolo, frame, conf=YOLO_CONF_THRESHOLD = 0.5):
    clamp box to frame bounds; skip degenerate boxes
    roi = frame[y1:y2, x1:x2]
    digits = extract_digits(ocr, roi)
    label = f"BIB: {digits}" if digits else d.name.upper()
    draw_yolo_label(frame, box, label, d.conf)

extract_digits(reader, roi):
  skip if roi.size == 0 or shape < MIN_OCR_ROI_SIZE (20 px) on either axis
  result = reader.readtext(roi, allowlist="0123456789", detail=1)
                                          # try/except — swallow degenerate-ROI failures
  best_digits, best_conf = "", 0
  for entry in result:                    # entry = (bbox, text, confidence)
    text, conf = str(entry[1]), float(entry[2])
    digits = re.sub(r"\D", "", text)      # defense-in-depth even with allowlist
    if digits and conf > best_conf: best_digits, best_conf = digits, conf
  return best_digits

draw_yolo_label:
  cv2.rectangle(box, BBOX_COLOR=(0,255,0), BBOX_THICKNESS=2)
  text = f"{label} {conf:.2f}"
  (tw, th), bl = cv2.getTextSize(text, FONT_HERSHEY_SIMPLEX, 0.6, 1)
  tab anchored above bbox top-left; flips inside the bbox if it would
    clip the frame's top edge
  filled rect (color), then cv2.putText in white (LINE_AA)
```

**v0 limitations** (deliberate; deferred to v0.1+):

- **No backend POST.** The script does not call `recordCheckpoint` or
  `reportViolation`. Local display only. `requests` is in
  `requirements.txt` already so v0.1 can wire it in without new deps.
- **No face recognition.** YOLOv8 with COCO weights detects generic
  classes (person, car, etc.); there's no notion of which runner is in
  frame. Future v0.1 needs `face_recognition` or `facenet-pytorch`.
- **No OCR consensus voting.** Every EasyOCR read is treated as
  authoritative for the label; there's no per-runner buffer or
  3-of-5 majority gate. The browser pipeline's Guardrail 21 is still
  the desired contract — port it forward in v0.1.
- **No cooldowns.** Browser pipeline's `cooldowns` (record, 30 s) and
  `violationCooldowns` (60 s) buckets aren't replicated yet.
- **No CLI flags.** `MODEL_PATH`, `CAMERA_INDEX`, etc. are constants at
  the top of the file; edit and re-run. v0.1 should add `--cp`,
  `--api-url`, `--camera-index`, `--debug`.
- **`yolov8n.pt` is a placeholder.** It's the standard COCO 80-class
  Ultralytics model. Until BIB-fine-tuned weights drop in via
  `MODEL_PATH`, OCR runs on every detection's ROI; only digit-bearing
  crops yield non-empty BIBs.

**Per-CP cooldown keys** (preserved across pipelines) use
`"<name>:<cpId>"` (or `"unknown:<cpId>"` for `UNREGISTERED`) — a runner
trips each station once even if they double back through the camera
view. Record cooldowns and violation cooldowns live in **separate
buckets** so reporting a violation does not suppress a legitimate
timing record (or vice versa). Within the violation bucket, all five
violation types — `WRONG_PERSON`, `NO_BIB`, `OBSCURED_BIB`,
`MULTIPLE_BIBS`, `UNREGISTERED` — share the same per-runner+CP key,
so the 60 s spam-prevention budget cannot be bypassed by stacking
different types on the same runner. The shared gate lives in
`tryFireViolation(cooldownKey, payload)`; every trigger site goes
through it.

### 4.3 Dashboard polling (`dashboard.html`)

| Source | Endpoint | Cadence | Notes |
|---|---|---|---|
| Public leaderboard | `getResults` | **5 s** | `POLL_RESULTS_MS` |
| Public alerts | `getVerifiedViolations` | **10 s** | `POLL_VIOLATIONS_MS`; only `Verified=true` |
| Admin tab | `getRunners`, `getViolations`, `getResults` (parallel) | **15 s** | `POLL_ADMIN_MS`; only when admin panel is active |

- `setLiveStatus(false)` flips the green "Live" dot to red after **2
  consecutive failures** of either public poller.
- `dismissed` (in-tab) caps at **500 entries**, evicted FIFO via
  `dismissedQueue`.
- **AbortController abort-and-restart**: each poller (`fetchResults`,
  `fetchViolations`, `loadAdminData`) holds its own `AbortController`
  in `resultsAbort` / `violationsAbort` / `adminAbort`. When a new tick
  fires while the previous fetch is still in flight, the old controller
  is aborted before the new fetch begins — the freshest data always
  wins. For `loadAdminData`, a single `signal` is shared across all
  three parallel fetches (`Promise.all` of `getRunners`/`getViolations`/
  `getResults`) so one `abort()` cancels the trio. After every `await`,
  an `ac === xxxAbort` identity check drops late-arriving stale
  responses (a fetch that finished after a newer one started). This
  replaces the previous mutex-coalescing approach in `loadAdminData`,
  which dropped fresh polls and left tables stale.
- **Admin loading strip** (`#admin-loading`, Thai text + small spinner)
  shows during in-flight admin fetches. `isLoadingAdmin` is repurposed
  from a mutex to a UI flag toggled by `setAdminLoading(bool)`. The
  strip is a sibling of `#admin-body`, not a child — `renderAdminTab`
  replaces `#admin-body.innerHTML` on every call, which would wipe a
  child element.
- **Alert rendering uses `DocumentFragment`**: new violation cards are
  appended to a fragment, which is then prepended to `#alert-grid` in a
  single DOM operation. Replaces the previous per-card
  `grid.prepend(card)` (layout thrash when several violations arrived
  in the same tick). Side benefit: batch order is now newest-on-top
  (was reversed under the per-card pattern).

### 4.4 Caching strategy (Apps Script v4+)

```
GET endpoint:
  1. cache().get(key)         ← 12 s TTL
     hit  → rawJson(hit)      ← bytes-for-bytes return, sub-100 ms
     miss → supplier() → JSON.stringify → cache().put(key, …, 12) → return

WRITE endpoint:
  1. mutate sheet
  2. invalidate corresponding cache key(s)
     • invalidateRunners()   for register/delete/update runner
     • invalidateResults()   for recordCheckpoint, deleteRunner, updateRunner
     • invalidateViolations() for report/verify/delete violation(s)
```

- `CACHE_MAX_BYTES = 90 KB` — values larger than this are skipped (the
  put is dropped, the next call falls through to the sheet read). The
  Apps Script per-key limit is 100 KB.
- `getViolations` only caches the **top 20** rows (sorted by Timestamp
  desc) so the size stays well under the cap even with hundreds of
  rows in the sheet.

### 4.5 Synchronous Drive cleanup on delete

Both `deleteRunner` and `deleteViolation` (and `deleteViolationsBatch`)
trash the relevant Drive resource **inline, in the same request**:

- **`deleteRunner`** → calls `trashRunnerFolder(name)` which iterates
  every `RunnerFaces` root (defensive against duplicates) and trashes
  any subfolder whose name matches.
- **`deleteViolation`** → reads `ImageUrl` from the in-memory snapshot
  *before* deleting the row, extracts the file ID via
  `extractDriveFileId` (matches any URL with an `id=` query param —
  current `thumbnail?id=…`, embed `uc?export=view&id=…`, or legacy
  `/file/d/…/view`), then trashes that file.
- **`deleteViolationsBatch`** → resolves all targets up front, trashes
  Drive files in any order (each in its own try-catch), then deletes
  sheet rows **bottom-up** to avoid index shift.

Every Drive operation is wrapped in try-catch so a 404 / permission
error logs and is swallowed — sheet deletion always proceeds.

### 4.6 Admin auth

- Password lives in `PropertiesService.ScriptProperties.ADMIN_TOKEN`
  (set once via the editor by running `_setupAdminToken()`).
- Default fallback if the property is missing is `muto67`.
- Frontend flow: `verifyAdmin` → on success, password is stored in
  `sessionStorage.adminToken` and **sent as `body.token` with every
  destructive POST**. Logout clears sessionStorage and reloads.

---

## 5. Strict Guardrails — DO NOT BREAK

These rules encode prior decisions / incidents. Any change here must be
explicit, justified, and accompanied by an update to this file.

1. **Cache invalidation is non-negotiable.** Every write handler MUST call
   the matching `invalidate*()` helper before returning. Skipping this
   leaves stale data in CacheService for up to 12 seconds — this was the
   primary motivator for v4.
2. **Drive operations must be try-catch isolated** inside delete paths.
   A missing file or a sharing-policy error MUST NOT block sheet row
   deletion. The `try { trash… } catch (e) { logErr(…); }` pattern
   already in `handleDeleteRunner` / `handleDeleteViolation` is the
   template.
3. **Bottom-up row deletion for batches.** Apps Script `deleteRow(idx)`
   shifts every row below it up by 1. `handleDeleteViolationsBatch`
   sorts targets by `rowIdx` descending — preserve this.
4. **Polling intervals must stay ≥ 1 second.** Apps Script has a daily
   execution-time quota (~6 hours/day for consumer accounts) and every
   open dashboard tab burns it. Current values (5/10/15 s) are tuned for
   live race conditions; do not lower without measuring quota impact.
5. **Per-CP cooldown keys are `name:cpId`, not just `name`.** Using only
   `name` was the original bug — a runner finishing CP1 would block CP2
   for 30 seconds.
6. **Embedding format = exactly 128 floats, JSON-stringified.** The
   frontend tolerates a legacy nested-array shape (`[[…]]`) for backward
   compatibility — keep that fallback in `init()` of `checkpoint.html`.
7. **HTML escape every interpolation.** OCR-extracted text and any
   user-supplied field (Name, Message, BibNumber, ImageUrl) MUST go
   through `esc()` / `attr()` before being concatenated into
   `innerHTML`. Rendering raw values is the most likely XSS path here.
8. **CDN versions are pinned.** `face-api.js@0.22.2` and the model weights
   URL must stay pinned. `@master` was tried once and silently broke face
   matching. Tesseract.js was retired in the 2026-05-10 hybrid migration —
   no longer pinned because it's no longer loaded.
9. **Admin token is not in source.** It lives in
   `PropertiesService.ScriptProperties`. If you must change the default,
   edit `_setupAdminToken()` and re-run it from the editor — never hard-
   code in a frontend file.
10. **Time format = `HH:MM:SS` plain text** in `Results` columns C–I.
    The schema setup forces `setNumberFormat("@")` on first creation —
    do not remove this. If Sheets converts `13:01` to a Date, the
    leaderboard breaks.
11. **`ANYONE_WITH_LINK / VIEW` sharing + thumbnail URL form are
    both load-bearing.** The dashboard renders Drive images in
    `<img src>` from any browser. Without public sharing the URLs
    return 401 (or worse, redirect to a login page) and the alerts
    show broken images; restricting sharing requires re-architecting
    image delivery (e.g. base64-inline or a proxy endpoint). And
    even with sharing correct, the embed form (`uc?export=view`)
    breaks `<img src>` under strict third-party cookie defaults —
    the cookie-less request bounces to a Google login page. v6
    standardized every URL on the thumbnail form
    (`drive.google.com/thumbnail?id=…&sz=w800`) for both
    `Runners.Photo_*` and `Violations.ImageUrl`. Don't reintroduce
    the embed form, and don't drop the public sharing.
12. **Violation ID format is `V<unix-ms>`.** `ID_PATTERN = /^V\d{10,}$/`
    enforces it on writes. Do not change this format without writing a
    migration helper similar to `_migrateViolationTypeColumn`.
13. **`registerRunner` is one atomic POST.** Do not split it into
    photo-upload + embedding-upload. The atomic shape is what guarantees
    a runner row never exists with empty embeddings.
14. **`getOrCreateFolder` is `LockService`-protected.** Removing the
    lock reintroduces the duplicate-folder race that
    `_consolidateDuplicateRootFolders()` exists to clean up.
15. **Schema additions go on the right.** When adding a column to any
    sheet, append to the end of the `SCHEMA[<name>]` array AND ship a
    one-shot migration helper (template:
    `_migrateViolationTypeColumn`). Existing sheets must not be
    rewritten just by deploying new code.
16. **AI runs at the edge, never in Apps Script.** "Edge" means the
    operator's machine — face-api.js in the browser AND YOLOv8 +
    EasyOCR in the local Flask process (`web_app.py`) hosted on the
    same machine. The hybrid arrangement is fine: same machine, no
    cloud inference. Apps Script remains storage + validation only.
    Do not introduce server-side inference *in Apps Script*: the GAS
    execution-time quota (~6 h/day on consumer accounts) makes it
    economically unviable, and the architecture intentionally scales
    to N operator machines for free.
17. **`legacy_v1/` is frozen.** Do not refactor it as part of v2 work.
    It only changes when the user explicitly asks for offline-mode
    fixes.
18. **The EMA-smoothed bbox MUST drive face↔BIB pairing.** Pairing
    against the raw detection box reintroduces frame-to-frame jitter
    and the chest-region rectangle drifts off the BIB. `processLoop`
    builds `box = smoothBox(name, rawBox)` once per detection and
    passes that to `pairFaceToBib` (and to the on-canvas overlay) —
    preserve that contract.
19. *(retired 2026-05-10)* Was: "OCR preprocessing is grayscale →
    adaptive threshold → 2× nearest-neighbor on the main thread." The
    server-side OCR engine has its own preprocessing pipeline; the
    hybrid migration deleted `preprocessForOCR` from `checkpoint.html`.
    No replacement rule needed — the server is the OCR contract.
20. **The OCR engine's recognizer config is part of the contract.**
    Currently `easyocr.Reader(["en"], gpu=False)` + `readtext(roi,
    allowlist="0123456789", detail=1)` in both `web_app.py` and
    `checkpoint_camera.py`. The `allowlist` constrains the recognizer
    to digits at the model level; `gpu=False` is set explicitly for
    predictability on operator laptops without CUDA. Do not change
    these without re-deriving the `BIB_MIN_LEN` / `BIB_MAX_LEN` /
    `PADDLE_MIN_CONF` validation gate. (PaddleOCR `use_angle_cls=True,
    lang="en"` was the prior config — replaced 2026-05-10 because
    `paddlepaddle` has no Python 3.14 wheel.)
21. **Violations require majority consensus, not a single read.** The
    `castVote` → consensus gate exists because single-frame OCR
    misreads were generating false-positive `WRONG_PERSON` reports.
    The vote source is now the `/analyze` response (one `castVote`
    call per fetch, gated by `isNewCycle` in `processLoop`). Don't
    bypass the consensus gate (e.g., by firing `reportViolation`
    directly from `consumeAnalyzeForFace` on the first detection).
22. **Recording vs violation triggers are independent.** `recordCheckpoint`
    is gated on **face** consecutive frames + record cooldown only — it
    must NOT depend on OCR consensus, because operators want timing
    records even when the BIB is unreadable. Conversely, the violation
    gate must NOT trigger record writes.
23. **Recurring polls MUST use `AbortController`, not a mutex or queue.**
    Each poller (`fetchResults`, `fetchViolations`, `loadAdminData`)
    aborts its own in-flight fetch before starting a new one and drops
    late-arriving stale responses via an `ac === xxxAbort` identity
    check after the await. Reasoning: a mutex coalesces by **dropping
    the new fetch on the floor** — under an Apps Script cold start that
    leaves the UI stale for 30 + s. A queue introduces tail latency.
    Abort-and-restart gives the freshest data with no pile-up.
24. **Server-returned BIB box is the source of truth for OCR text;
    chest-region geometry is only the pairing rule.** YOLO on the
    server decides where the BIB actually is. The browser's
    chest-region (`PAIR_LATERAL_FACTOR`, `PAIR_TOP_FACTOR`,
    `PAIR_BOTTOM_FACTOR`) is used solely by `pairFaceToBib` to decide
    which detection belongs to which face — it must NOT be used to
    pre-crop the frame before sending to `/analyze` (the server needs
    the full frame to find BIBs that drift outside one face's chest
    region). The on-canvas tab is drawn at the server-returned box,
    not at the chest rect.
25. **All violation types share the same per-runner+CP cooldown
    bucket.** `WRONG_PERSON`, `NO_BIB`, `OBSCURED_BIB`, and
    `MULTIPLE_BIBS` all key on `"name:cpId"`; `UNREGISTERED` keys on
    `"unknown:cpId"`. Once any violation fires for a key, no further
    violation of any type fires on that key for `VIOLATION_COOLDOWN_SEC`
    (60 s). The single gate is `tryFireViolation(cooldownKey, payload)`
    — every trigger site MUST go through it. Don't introduce per-type
    cooldowns without revisiting the spam-prevention budget; a runner
    whose BIB OCR fails AND whose face matches a wrong registered
    runner would otherwise fire two violations on the same frame.
26. **`MULTIPLE_BIBS` fires on multi-detection clustering, not raw
    OCR text.** In hybrid mode each "block" is one server-returned
    detection. `pairFaceToBib` returns `all` (every in-region
    detection); `consumeAnalyzeForFace` filters that to entries with
    `text.length >= MULTIPLE_BIBS_MIN_BLOCK_LEN` and fires when the
    count is ≥ `MULTIPLE_BIBS_MIN_BLOCKS`. Don't collapse the multi-
    detection signal into a single concatenated text field — YOLO
    multi-box is more reliable than splitting whitespace in OCR
    output (which the previous Tesseract pipeline had to do).

---

## 6. Current State (as of the last update)

### 6.1 Active version

- **Backend `Code.gs` is at v6.** Header comment block in `Code.gs`
  is the authoritative changelog for the backend.
- **Hybrid checkpoint pipeline is primary** as of 2026-05-10.
  `web_app.py` hosts both the templates and `POST /analyze` (YOLOv8 +
  EasyOCR) on port 5000. `templates/checkpoint.html` runs face-api.js
  in the browser and posts frames at ~400 ms cadence.
- **`checkpoint_camera.py` (v0)** remains as the headless cv2
  alternative — same models, no HTTP, no GAS POST.
- Frontend templates align with v5 (ViolationType + bulk delete UI).
  v6 is backend-only — no frontend payload, schema, or endpoint
  shape changed; the dashboard simply receives URLs that all render.

### 6.2 Recent changes

#### 2026-05-10 (later) — Tune cadence/timeout for EasyOCR; favicon 204

Field test after the EasyOCR swap surfaced `AbortError: signal is aborted without reason` spam in DevTools when the runner stood in front of the camera. Root cause: `ANALYZE_TIMEOUT_MS = 1500` was tuned for PaddleOCR; EasyOCR with COCO `yolov8n.pt` often gets a large `person`-class box and runs OCR on a giant crop, pushing single-call latency past 2 s.

- `ANALYZE_TIMEOUT_MS`: 1500 → **8000**
- `ANALYZE_INTERVAL_MS`: 400 → **1000** (matches realistic CPU throughput; prevents the rAF loop from issuing a new fetch before the in-flight one returns)
- `analyzeFrame` now distinguishes `AbortError` (timeout — server may still be processing; do **not** flip the UI to "AI offline") from genuine network/HTTP errors (which still flag offline). The next successful `/analyze` clears state.
- Added `GET /favicon.ico` returning 204 in `web_app.py` to silence the `/favicon.ico` 404 in the console.

No behavior change to the consensus vote, the violation triggers, or the GAS POST contract.

#### 2026-05-10 (later) — PaddleOCR → EasyOCR (Python 3.14 fix)

Operator runs Python 3.14 where `paddlepaddle` does not yet publish a
wheel. `pip install -r requirements.txt` failed and `from paddleocr
import PaddleOCR` raised `ModuleNotFoundError` at server boot. Swapped
the OCR engine to EasyOCR (PyTorch-backed; Python 3.14 wheels available)
in **both** `web_app.py` and `checkpoint_camera.py`.

**API delta**: `PaddleOCR(use_angle_cls=True, lang="en", show_log=False)`
→ `easyocr.Reader(["en"], gpu=False)`. `ocr.ocr(roi, cls=True)` →
`reader.readtext(roi, allowlist="0123456789", detail=1)`. Result shape:
PaddleOCR `[[(text, conf), ...]]` → EasyOCR `[(bbox, text, conf), ...]`.
The `extract_digits` return contract — `(digits, conf)` in `web_app.py`,
bare `digits` in `checkpoint_camera.py` — is unchanged, as is the
JSON shape returned by `POST /analyze`. The frontend
(`templates/checkpoint.html`), the face↔BIB pairing, the consensus
vote, and the GAS POST contract are all untouched.

**`gpu=False` is explicit.** Most operator laptops have no CUDA, and
EasyOCR's auto-detect emits a warning if GPU is requested but
unavailable. Flip to `gpu=True` (or omit) once a CUDA torch is verified.

**First-run weight footprint** is larger: PaddleOCR ~25 MB → EasyOCR
~100 MB (detection ~64 MB + recognition ~30 MB). The frontend
`waitForAIServer(30000, 500)` poll covers the cold load on most
laptops; on slower disks bump the timeout in `checkpoint.html` if the
init screen times out.

**`requirements.txt`** dropped `paddleocr` and `paddlepaddle` (and the
CPU/GPU comment block); added `easyocr`. EasyOCR pulls `torch` and
`torchvision` transitively, so they are not listed explicitly.

**Guardrail 20** rewritten to reference EasyOCR's `Reader` + `readtext`
+ `allowlist` config; the prior PaddleOCR config preserved as the
"prior config" footnote.

#### 2026-05-10 — Hybrid checkpoint: browser UI + local Flask AI

The checkpoint role swaps back to the browser as the operator UI,
but YOLOv8 + PaddleOCR move from a standalone Python loop to a
Flask `/analyze` endpoint hosted alongside the templates inside
`web_app.py`. Tesseract.js is fully removed.

**What changed (this commit):**
- `web_app.py` rewritten: loads YOLO + PaddleOCR once at import,
  exposes `POST /analyze` (base64 JPEG → per-detection BIB JSON) and
  `GET /health`. `debug=False` so the reloader does not pay the
  cold-load on every save.
- `templates/checkpoint.html` refactored: Tesseract.js script tag,
  worker, `preprocessForOCR`, `getOCRCropBox`, and `runSmartOCR`
  removed. Added `analyzeFrame`, `pairFaceToBib`, `drawDetectionTab`,
  `consumeAnalyzeForFace`, and `maybeFireGhostBib`. `processLoop`
  now throttles a `/analyze` fetch at `ANALYZE_INTERVAL_MS = 400`,
  consumes results once per response (`isNewCycle` gate, Guardrail 21),
  pairs faces to BIBs spatially, and feeds the existing castVote /
  cooldown / GAS POST machinery. New `serverStatus` HUD field +
  permanent "AI offline" banner when `/analyze` is unreachable.
- `requirements.txt` adds `flask`. `flask-cors` is NOT added — the
  browser fetches the same origin that served the page.
- Guardrails 8, 16, 18, 21, 24, 26 rewritten to match hybrid
  semantics; Guardrails 19 and 20 retired (Tesseract preprocessing
  and worker config no longer apply).

**Why:**
- **Operator UI.** The browser checkpoint had a polished init flow,
  sidebar log, debug HUD, init progress, and CP selector that users
  invested in. The headless cv2 window of `checkpoint_camera.py` was
  not a viable replacement for live race operations.
- **OCR accuracy.** PaddleOCR with `use_angle_cls=True` is more
  resilient than Tesseract.js to runner-held BIBs and rotated text.
- **No CDN AI.** Tesseract.js was a 4 MB CDN dep loaded into every
  operator's browser; with PaddleOCR running locally this is gone.
- **Single AI surface.** Both the headless script and the hybrid
  endpoint share `extract_digits` semantics; future fine-tuned weights
  drop into both via `MODEL_PATH = "yolov8n.pt"`.

**Edge node hosts:** the same machine that runs `web_app.py` is the
operator's laptop — no separate "AI box". The hybrid keeps the "AI at
the edge" property of Guardrail 16. If the local server crashes,
`recordCheckpoint` keeps firing on face-only matches; OCR-driven
violations pause until restart.

**Run:** `pip install -r requirements.txt && python web_app.py`,
then open `http://localhost:5000/checkpoint`. First start downloads
YOLO weights (~6 MB) + PaddleOCR detection / recognition / angle-cls
models (~10-15 MB).

#### 2026-05-10 — Edge-node migration v0 (superseded by hybrid)

(Earlier on 2026-05-10.) Standalone `checkpoint_camera.py` introduced
as the would-be primary path. The hybrid migration above re-establishes
the browser as primary; `checkpoint_camera.py` remains as the headless
alternative. Original v0 scope description preserved below for
historical context.

Major architecture shift. The checkpoint role moves from
`templates/checkpoint.html` (browser, face-api.js + Tesseract.js) to a
new top-level Python script `checkpoint_camera.py` running locally on
the operator's machine. v6 backend is unchanged.

**Why this shift:**
- **OCR accuracy.** PaddleOCR (with `use_angle_cls=True`) is more
  resilient to runner-held BIBs and rotated text than Tesseract.js.
- **Future room.** YOLOv8 (`ultralytics`) is fine-tuneable. The repo
  ships v0 with `yolov8n.pt` (the COCO 80-class model) as a placeholder;
  the user will swap in BIB-trained weights when they're ready.
- **Edge consolidation.** Bringing detection + OCR onto one Python
  process removes the browser's CDN dependency on face-api.js and
  Tesseract.js (Guardrail 8), and gives a single tunable code path
  for future cooldown / consensus / POST work.

**v0 scope (deliberately thin):**
- `init_models` — YOLO + PaddleOCR
- `init_camera(0)` — `cv2.VideoCapture`
- `detect` — returns list of `{box, conf, cls, name}` dicts
- `extract_digits` — runs PaddleOCR on the cropped ROI, strips to
  digits via regex, returns the highest-confidence digit run
- `draw_yolo_label` — bbox + filled label tab anchored top-left of the
  bbox, sized via `cv2.getTextSize`, with a flip-into-bbox fallback
  when the tab would clip the frame top
- `process_frame` — orchestrates detect → crop → OCR → draw
- `main` — model + camera init, frame loop, `'q'` to quit, `try/finally`
  cleanup

**Out of v0 scope (deferred to v0.1+):**
- Backend POST (`recordCheckpoint`, `reportViolation`). `requests` is
  in `requirements.txt` already so v0.1 wires in without new deps.
- Face recognition / runner identity. Without it, v0 has no `name` to
  send the backend even if POST were wired.
- OCR consensus voting (Guardrail 21 from the browser pipeline).
- Per-CP cooldowns (Guardrail 5).
- CLI flags. v0 uses module-level constants; edit + re-run.

**What's NOT touched:**
- `templates/checkpoint.html` stays in the repo as a deprecated
  rollback path — the v6 backend continues to accept POSTs from it.
- `web_app.py` stays. It still serves register/dashboard/checkpoint
  HTML. Flask is dropped from `requirements.txt`; users `pip install
  flask` if they need the wrapper.
- `legacy_v1/` — frozen per Guardrail 17.
- `apps_script/Code.gs` — backend stays at v6 (no schema or endpoint
  changes; the edge node hasn't started POSTing yet).

**Guardrail update:** Guardrail 16 was "Don't introduce server-side
AI. All face/OCR work runs in the browser by design." It's been
rewritten to make clear that the prohibition is on Apps Script AI,
not on edge-side Python. Edge AI was always fine; the browser was
just the only previous edge.

**Run:** `pip install -r requirements.txt && python checkpoint_camera.py`.
First run downloads `yolov8n.pt` (~6 MB) + PaddleOCR detection /
recognition / angle-classifier models (~10–15 MB).

#### 2026-05-10 — v6: Single thumbnail URL contract + dated subfolders

Backend `Code.gs` bumped from v5 to v6. Two intertwined changes plus a
historical migration helper.

- **All Drive image URLs are now thumbnail form.** Runner photos
  (`Runners.Photo_Front` … `Photo_Right`) used to be written in the
  embed form (`uc?export=view&id=<id>`); they now share the same
  thumbnail form (`thumbnail?id=<id>&sz=w800`) that violation evidence
  has used since 2026-05-09. Reason: the embed form returns broken
  `<img>` images in browsers with strict third-party cookie defaults
  (image opens fine in a new tab, but a cookie-less `<img src>` gets
  bounced to a Google login page). Thumbnail serves a public bitmap
  with no cookie dance — works for both runner photos and violation
  evidence. Net result: every dashboard `<img>` consumer is
  cookie-default-safe.

  Code change: `handleRegisterRunner` swaps `DRIVE_EMBED_URL` →
  `DRIVE_THUMBNAIL_URL`, and the `DRIVE_EMBED_URL` constant is
  removed (no remaining call sites). `extractDriveFileId` is
  unchanged — its `[?&]id=` and `/file/d/` regexes already match
  every URL form this app has ever written, so cleanup paths and
  the historical migration cope with rows from older deploys.

- **New uploads land in a `YYYY-MM-DD` subfolder.**
  `saveBase64Image(folder, filename, base64Data)` now saves to
  `<folder>/<YYYY-MM-DD>/<filename>` instead of `<folder>/<filename>`.
  Folder layout becomes `RunnerFaces/<name>/<date>/<files>` and
  `ViolationEvidence/<date>/<files>`. Reason: an event with hundreds
  of violations dumps every JPEG into a single Drive root, which is
  unbrowseable. Date subfolders keep the Drive view manageable. The
  date subfolder is created lazily on first save of the day —
  `getOrCreateFolder` is `LockService`-protected so concurrent
  registrations on the same day share one subfolder rather than
  racing to create duplicates. New helper `getDateStringYMD(date)`
  returns `Utilities.formatDate(d, Session.getScriptTimeZone(),
  "yyyy-MM-dd")`. Existing files are NOT relocated — they remain
  in the parent folder; only new uploads land in date subfolders.

- **`_migrateHistoricalImages()` rewrites every legacy URL.** Replaces
  the v3 helper `_migrateAllImageUrls` (which produced embed URLs and
  is now obsolete). Iterates `Runners.Photo_*` and
  `Violations.ImageUrl`, extracts the file ID via
  `extractDriveFileId`, rewrites the URL with `DRIVE_THUMBNAIL_URL`.
  Skips rows already in thumbnail form so it is idempotent. Single
  read + single write per sheet; invalidates the matching cache key.
  Logs three counters per sheet (`rewrote`, `already thumbnail`,
  `unparseable`) so a re-run on a clean sheet shows everything in
  the "already thumbnail" bucket.

  **Run once after deploying v6** from the Apps Script editor:
  function dropdown → `_migrateHistoricalImages` → Run. Without
  this run, runner photos and any pre-2026-05-09 violation rows
  continue to render with their old (broken) URLs in the dashboard.

#### 2026-05-09 — Violation `ImageUrl` switched to Drive thumbnail format

Backend-only change in `Code.gs`. `Violations.ImageUrl` now writes
`https://drive.google.com/thumbnail?id=<id>&sz=w800` (was the embed
form `uc?export=view&id=<id>`). Runner photos (`Photo_*`) are
unchanged and still write the embed form.

**Why:** the embed form started returning broken `<img>` images on
the public dashboard in browsers with strict third-party cookie
defaults — the image opens fine in a new tab, confirming the file is
shared correctly, but the cookie-less `<img>` request gets bounced to
a Google login page. The thumbnail endpoint serves a public bitmap
with no cookie dance, so `<img>` works again.

**Refactor shape:** `saveBase64Image` now returns the raw file ID
(was the embed URL). `registerRunner` wraps with `DRIVE_EMBED_URL(...)`
to preserve byte-identical sheet writes. `handleReportViolation`
wraps with the new helper `DRIVE_THUMBNAIL_URL(id, size)`, which sits
next to `DRIVE_EMBED_URL` in the Drive helpers section.

**Existing rows are NOT migrated** by this change. Violations recorded
before this commit still carry the embed URL and will continue to show
broken on the dashboard. A one-shot helper modeled on
`_migrateAllImageUrls()` would be required to back-fix the historical
backlog — not added in this change set.

`extractDriveFileId` already matches both URL forms via its
`/[?&]id=([-\w]{25,})/` regex, so the `deleteViolation` /
`deleteViolationsBatch` paths are unaffected. Backend version remains
v5 (no schema or endpoint change).

#### 2026-05-09 — Audit-driven hardening in `checkpoint.html`

Frontend-only correctness / observability sweep prompted by a full-system
audit. Backend `Code.gs` still v5; only its file-header comment bumped
from `(v4)` to `(v5)` to reflect reality (the v5 changelog block was
already present at lines 22–29).

- **`ocrConsensus[n]` cleared on EMA reset.** When a runner has been
  missing for `BBOX_EMA_RESET_FRAMES` (10) consecutive frames, the
  staleness sweep now drops `ocrConsensus[n]` alongside `ocrVotes`,
  `ocrFailureCount`, and `ocrLastFailureKind`. Previously the cached
  consensus was only released by its own 15 s TTL inside
  `consensusBib()` — a runner returning within ~12 s would briefly see
  the previous lap's consensus painted on the overlay even though every
  other piece of per-runner state had already been wiped.
- **`setStatus()` interpolations escaped.** Both `type` and `text` now
  pass through the existing `esc()` helper before being concatenated
  into `innerHTML`. Closes a Guardrail 7 compliance gap. No production
  call site sent untrusted input here, so behavior is unchanged for
  every observed input.
- **`?debug=1` URL flag.** Append `?debug=1` to the checkpoint URL to
  enable: (a) `console.log("[debug] OCR", …)` after every Tesseract
  recognize, (b) `console.log("[debug] vote", …)` after every
  `castVote`, and (c) a small overlay HUD (top-left of the canvas)
  showing tracked-runner count, total OCR-vote-buffer entries, active
  violation cooldowns, and `ocrBusy` state. The HUD draws via canvas
  API only — no `innerHTML`, no XSS path. No production paths branch on
  `DEBUG`; it strictly adds observability.

#### 2026-05-08 — Advanced violation triggers in `checkpoint.html`

Frontend-only change; backend `Code.gs` still v5. The pipeline now fires
four additional violation types autonomously alongside the existing
`WRONG_PERSON` consensus mismatch:

- **Ghost BIB → `NO_BIB` / `OBSCURED_BIB`**: per-runner counter
  `ocrFailureCount[name]` increments on every silent-reject from the
  validation gate (digits-only / length / confidence). At
  `NO_BIB_AFTER_FAILURES` (5) consecutive failures, `tryFireViolation`
  fires `NO_BIB` (empty text — no digits at all) or `OBSCURED_BIB`
  (text but bad length / conf). The counter resets on any successful
  OCR vote, on a successful `MULTIPLE_BIBS` fire, and when EMA is
  dropped (10 missing frames).
- **Intruder → `UNREGISTERED`**: `processLoop` tracks the largest-area
  unknown face per frame in `largestUnknownBox`. After the detection
  for-loop, `consecutiveFrames["unknown"]` increments; at
  `UNREGISTERED_AFTER_FRAMES` (15) `tryFireViolation` fires with a
  face-cropped image (`captureFaceCrop`, 50 % padding around the face
  box). The per-frame staleness sweep already resets the counter when
  no unknown is in view — strict reset matches the known-runner warmup
  behavior.
- **Cluttered Chest → `MULTIPLE_BIBS`**: regex
  `\d{MULTIPLE_BIBS_MIN_BLOCK_LEN(2),}` runs against the **raw**
  Tesseract text **before** digit-only normalization. ≥
  `MULTIPLE_BIBS_MIN_BLOCKS` (2) matches → fire, list all blocks in
  `message`, leave `bib` empty (Apps Script `BIB_PATTERN` rejects
  commas, see Guardrail 26). If the cooldown blocks the fire, the
  pipeline falls through to normal validation rather than dropping the
  frame entirely.

Supporting refactors:

- `reportViolation(name, expected, found, video)` →
  `reportViolation({ name, bib, message, violationType, image })`. All
  five trigger sites build their own message and image and pass a
  uniform options object.
- New helpers: `captureFullFrame(video)`,
  `captureFaceCrop(video, box)`, and the cooldown gate
  `tryFireViolation(cooldownKey, payload)`.
- All violation types share the same per-runner+CP cooldown bucket
  (Guardrail 25); `tryFireViolation` is the single gate.

#### 2026-05-07 — CV pipeline overhaul in `checkpoint.html`

Frontend-only change; backend `Code.gs` is still v5. Goal was higher real-
world accuracy and FPS without blocking the main thread.

- **Detector swap**: `ssdMobilenetv1` → **`tinyFaceDetector`**
  (`inputSize=320`, `scoreThreshold=0.5`). ~5× FPS uplift in practice. To
  revert: load `ssdMobilenetv1` and pass no detector options to
  `detectAllFaces`.
- **Match distance tightened**: `0.5` → **`0.45`**. Trades more
  "Unknown" labels for fewer cross-runner false matches.
- **Video stream upgraded**: `640×480` → **`1280×720`**. TinyFaceDetector
  internally rescales to its `inputSize` for inference, so this only
  affects the operator preview and the OCR crop quality.
- **EMA bbox stabilization**: per-runner exponential moving average
  (`BBOX_EMA_ALPHA=0.35`, ~3-frame half-life) on `(x, y, width, height)`.
  Smoothed box drives both the overlay rectangle AND the chest crop —
  this is the single biggest contributor to OCR accuracy at higher FPS.
  EMA expires after `BBOX_EMA_RESET_FRAMES=10` consecutive missing frames
  (drops the vote buffer at the same time, so a returning runner starts
  clean).
- **OCR preprocessing pipeline**: cropped chest → grayscale (BT.601) →
  integral-image adaptive threshold (`block=15`, `C=10`) → nearest-
  neighbor 2× upscale. <1 ms total on the main thread; no Web Worker
  needed.
- **Tesseract config**: `tessedit_char_whitelist = '0123456789'` +
  `tessedit_pageseg_mode = '7'` (single text line) at worker init.
- **OCR validation gate**: silently rejects reads that fail any of
  digits-only / `length ∈ [2, 5]` / `confidence ≥ 70`.
- **Multi-frame majority vote**: `OCR_VOTE_BUFFER_SIZE=5`,
  `OCR_VOTE_MIN_CONSENSUS=3` per runner; entries older than
  `OCR_CACHE_TTL_MS=15s` evict on every call. Consensus result cached in
  `ocrConsensus[name]` for the display path.
- **Two-bucket cooldowns**: `cooldowns` (record, 30 s) and
  `violationCooldowns` (violation, 60 s) are separate so reporting a
  violation can't suppress a legitimate timing record (or vice versa).

### 6.3 Backend features in v5 (still current)

- **`ViolationType` column** on the Violations sheet, with a fixed
  whitelist of 7 values (`NO_BIB`, `WRONG_PERSON`, `UNREGISTERED`,
  `MULTIPLE_BIBS`, `WRONG_ROUTE`, `OBSCURED_BIB`, `OTHER`).
- **`reportViolation`** now accepts and validates `violationType`,
  defaulting to `WRONG_PERSON` when missing.
- **`deleteViolationsBatch` endpoint** — bulk delete up to
  `BATCH_DELETE_MAX = 200` IDs in a single request:
  - dedupes IDs
  - reads sheet once
  - trashes Drive files in any order (each isolated)
  - deletes sheet rows bottom-up
  - invalidates the Violations cache once
- **Type filter dropdown + bulk-delete toolbar** in the admin Violations
  tab. Filter state and selection persist across re-renders.
- **`_migrateViolationTypeColumn()`** one-shot helper for back-filling
  existing sheets.

### 6.4 Carried over from v4

- **Read-through CacheService** for all 4 GET actions (12 s TTL).
- **Synchronous Drive cleanup** in delete paths.

### 6.5 Known behaviors (not bugs)

- **Cache lag**: A write made directly in the sheet UI (not via the API)
  won't be visible to the dashboard for up to 12 seconds, because the
  cache key isn't invalidated. Workaround: edit via the admin UI.
- **Live dot turning red**: Requires **2 consecutive failures** of
  either `getResults` or `getVerifiedViolations`. A single transient
  network blip won't flip it.
- **Dismissed cap**: An admin who never reloads the dashboard will see
  dismissed-violation memory cap at 500 entries (FIFO). Reload clears
  it.
- **Camera released on `pagehide`**: The OS camera indicator goes off
  when navigating away from `/checkpoint` or `/register`. Re-entering
  the page restarts the camera.
- **Camera resolution = 1280×720**. TinyFaceDetector internally
  rescales to `inputSize=320` for inference; the 720p preview is for
  the operator and the OCR crop. Some devices may negotiate a lower
  resolution if 720p isn't supported by the webcam.
- **`OCR_CACHE_TTL_MS` = 15 s** governs both the consensus expiry
  AND the vote-buffer eviction. A drifting OCR self-corrects within
  this window. Do not lengthen.
- **`FACE_MATCH_DISTANCE` = 0.45** is the recognition threshold.
  Lower = stricter (fewer false matches, more "Unknown" labels).
  Tuning this requires re-validating with real-event footage.
- **Silent OCR rejects**: reads failing the validation gate (digits-
  only, length 1–6, confidence ≥ 60 — current field-test values; nominal
  is 2–5 / 70) are dropped without UI feedback. This is intentional —
  corrupt votes would derail consensus. The values are inline-flagged
  in `checkpoint.html` as `FIELD-TEST` and expected to revert post-
  validation.
- **OCR debug overlay**: a dashed red rectangle labeled `OCR` is drawn
  on the overlay canvas for known runners only. It shows exactly where
  Tesseract will crop, so the field operator can adjust how a runner
  holds the BIB. The rectangle and the actual crop are guaranteed
  identical because both call `getOCRCropBox(box, video)`.
- **`?debug=1` URL flag** (checkpoint only): appending `?debug=1` to
  the checkpoint URL enables verbose console logs (`[debug] OCR` after
  every Tesseract recognize; `[debug] vote` after every `castVote`)
  and a small overlay HUD in the top-left of the canvas showing
  tracked-runner count, total vote-buffer entries, active violation
  cooldowns, and `ocrBusy` state. Strictly observational — no
  production logic branches on `DEBUG`. HUD drawn via canvas API, so
  no XSS surface.
- **Admin loading strip**: while admin polls are in flight, a small
  Thai-text strip with `กำลังโหลดข้อมูล...` appears above the admin
  table. Driven by `setAdminLoading(bool)` from inside `loadAdminData`.
- **Polls cancel-and-restart, not coalesce**: if a 15 s admin poll
  fires while the previous fetch is still in flight (e.g. during an
  Apps Script cold start), the in-flight `Promise.all` is aborted and
  a new triplet starts. Apparent in DevTools → Network as
  `(canceled)` rows.
- **Violation requires ≥3-of-5 consensus**: a single wrong-BIB read
  no longer fires a `WRONG_PERSON` violation. The runner's chest must
  be readable for at least 3 frames inside a 15-second window.
- **EMA persists across brief detection misses**: a 1–10 frame gap in
  detection keeps the smoothed box around so the next match snaps
  back without re-warming up. Past 10 frames the EMA, vote buffer,
  cached consensus, and Ghost-BIB counters are dropped together.
- **Sample data** in `Data/` (legacy face DB) and `events/test/` is
  retained for reference; both directories are gitignored.
- **Drive uploads land in `YYYY-MM-DD` subfolders (v6+).** Layout is
  `RunnerFaces/<name>/<date>/<files>` and
  `ViolationEvidence/<date>/<files>`. The date is computed in the
  script's timezone via `Session.getScriptTimeZone()`. Files saved
  before v6 stay in the parent folder; `_migrateHistoricalImages`
  rewrites their URLs but does not relocate the underlying files.
  A fresh deploy that has never run before v6 will see all uploads
  go straight into the dated layout.
- **Edge node v0 has no backend POST, no face recognition, no
  consensus voting, no cooldowns.** `checkpoint_camera.py` is a thin
  detect → OCR → display loop. It runs EasyOCR on every detection
  every frame — expect display lag at high detection counts. Future
  v0.1 will port the browser pipeline's consensus voting (Guardrail
  21) and cooldown buckets (Guardrails 5, 25) into Python.
- **`yolov8n.pt` is the default COCO model (80 classes — person,
  car, etc.).** It does not natively detect BIBs. Until BIB-fine-tuned
  weights are dropped in via `MODEL_PATH`, OCR runs on every
  detection's ROI and only digit-bearing crops yield non-empty BIBs;
  the rest of the time the label tab shows the COCO class name as
  a fallback (e.g., `PERSON 0.92`).
- **Browser checkpoint pipeline is deprecated as of 2026-05-10 but
  preserved as a rollback path.** `templates/checkpoint.html` and the
  `/checkpoint` route in `web_app.py` still work. The v6 backend
  continues to accept POSTs from it unchanged. Operators run
  `pip install flask && python web_app.py`, open `/checkpoint`, and
  the prior face-api.js + Tesseract.js pipeline runs as before.
- **Multiple unknowns in frame**: the `UNREGISTERED` trigger captures
  only the **largest-area** face for the snapshot. Other unknowns are
  ignored for that fire — they'll be picked up on the next cooldown
  window if they remain.
- **Intruder counter is single-bucket**: `consecutiveFrames["unknown"]`
  treats all unknowns as one identity. Two different unknowns walking
  through together are counted as continuous presence; the counter
  fires once, resets to 0 on fire, and the 60 s cooldown rate-limits
  any subsequent fires.
- **Ghost BIB counter is reset on success**: a single passing OCR vote
  OR a successful `MULTIPLE_BIBS` fire clears `ocrFailureCount[name]`.
  Failures are also dropped with the EMA after `BBOX_EMA_RESET_FRAMES`
  (10) consecutive missing frames.
- **Multiple BIBs may fall through to validation**: when the cooldown
  blocks `tryFireViolation`, the pipeline still digit-normalizes the
  text and tries to vote one of the bibs as a normal read. Better to
  attempt a single read than drop the frame entirely.

### 6.6 One-off setup helpers (Apps Script editor)

Run these from the function dropdown in the Apps Script editor.
All are idempotent.

| Function | Purpose | When to run |
|---|---|---|
| `_setupAdminToken()` | Stores the admin password in `ScriptProperties` | Once at deploy time, or when changing the password |
| `_consolidateDuplicateRootFolders()` | Merges duplicate `RunnerFaces`/`ViolationEvidence` folders into one canonical folder | If a race ever creates duplicates (predates the lock fix) |
| `_migrateHistoricalImages()` | Rewrites every legacy Drive image URL (`Runners.Photo_*`, `Violations.ImageUrl`) to the thumbnail form | Once after deploying v6 (replaces the v3 `_migrateAllImageUrls` helper, which produced now-obsolete embed URLs) |
| `_migrateViolationTypeColumn()` | Adds the `ViolationType` column and back-fills `WRONG_PERSON` | Once after deploying v5 |

### 6.7 Endpoints reference

**GET** (`?action=…`)
| Action | Returns |
|---|---|
| `getRunners` | All `Runners` rows |
| `getResults` | All `Results` rows |
| `getViolations` | Top 20 violations (Timestamp desc) |
| `getVerifiedViolations` | Top 20 with `Verified=true` |

**POST** (JSON body, `Content-Type: text/plain` to dodge CORS preflight)
| Action | Payload | Notes |
|---|---|---|
| `verifyAdmin` | `{ password }` | Returns success/failure; no token needed |
| `registerRunner` | `{ name, bib, email?, timestamp?, photo_front…right, embeddings }` | Atomic |
| `recordCheckpoint` | `{ name, checkpoint_id, timestamp, bib? }` | `checkpoint_id` is `"start"`, `1`, `2`, `3`, `4`, or `"finish"` |
| `reportViolation` | `{ name?, bib?, message?, violationType?, timestamp?, image? }` | `image` is base64; `violationType` defaults to `WRONG_PERSON` |
| `verifyViolation` | `{ token, id }` | Admin |
| `deleteViolation` | `{ token, id }` | Admin; trashes Drive image |
| `deleteViolationsBatch` | `{ token, ids: [V…] }` | Admin; up to 200 IDs |
| `deleteRunner` | `{ token, name }` | Admin; trashes folder + clears Results |
| `updateRunner` | `{ token, name, Start_Time?, CP1_Time?, …, Finish_Time? }` | Admin; recomputes `Total_Duration` |

All responses are
`{ status: "success", … }` or `{ status: "error", code, message }`.

### 6.8 Configuration knobs (frontend)

#### Common
| Constant | File | Default | Effect |
|---|---|---|---|
| `API` / `API_URL` | all 3 templates | (deploy URL) | Points all 3 pages at the Apps Script web app |
| `MODEL_URL` | register, checkpoint | `…@0.22.2/weights/` | face-api weight CDN, **pinned** |

#### `checkpoint.html` — video & detection
| Constant | Default | Effect |
|---|---|---|
| `VIDEO_WIDTH` × `VIDEO_HEIGHT` | `1280 × 720` | `getUserMedia` ideal; operator preview + OCR crop quality |
| `FACE_DETECTOR_INPUT_SIZE` | `320` | TinyFaceDetector inference size; 224=faster, 416=more accurate |
| `FACE_DETECTOR_SCORE_THRESHOLD` | `0.5` | TinyFaceDetector minimum face-score |
| `FACE_MATCH_DISTANCE` | `0.45` | `findBestMatch` threshold (lower = stricter) |

#### `checkpoint.html` — bbox EMA
| Constant | Default | Effect |
|---|---|---|
| `BBOX_EMA_ALPHA` | `0.35` | Smoothing weight on new sample (low = smoother but laggier) |
| `BBOX_EMA_RESET_FRAMES` | `10` | Drop EMA + vote buffer after this many missing frames |

#### `checkpoint.html` — recording / cooldowns
| Constant | Default | Effect |
|---|---|---|
| `RECORD_AFTER_FRAMES` | `5` | Consecutive recognitions before logging a checkpoint |
| `COOLDOWN_SEC` | `30` | Per-CP per-runner record cooldown |
| `VIOLATION_COOLDOWN_SEC` | `60` | Per-CP per-runner violation cooldown (separate bucket) |

#### `checkpoint.html` — OCR pipeline (hybrid)
| Constant | Default | Effect |
|---|---|---|
| `ANALYZE_URL` | `"/analyze"` | Local Flask AI endpoint (same origin as page) |
| `ANALYZE_HEALTH_URL` | `"/health"` | Frontend ready-poll target |
| `ANALYZE_INTERVAL_MS` | `1000` | Throttle between `/analyze` POSTs (~1 fps server-side; tuned for EasyOCR on CPU) |
| `ANALYZE_TIMEOUT_MS` | `8000` | AbortController bound; covers a single slow inference. Timeouts no longer flip the UI to "AI offline" — only genuine network/HTTP errors do. |
| `JPEG_QUALITY` | `0.8` | Capture-canvas JPEG quality for `/analyze` payload |
| `OCR_CACHE_TTL_MS` | `15000` | Vote-buffer + consensus expiry |
| `PAIR_LATERAL_FACTOR` | `0.5` | Chest region lateral pad (×faceH) |
| `PAIR_TOP_FACTOR` | `0.6` | Chest region top offset (×faceH below face top) |
| `PAIR_BOTTOM_FACTOR` | `3.0` | Chest region bottom offset (×faceH below face bottom) |
| `PADDLE_MIN_CONF` | `0.6` | OCR confidence floor (0–1) for `primary` detection. Name predates the Paddle→EasyOCR swap; the value is checked against EasyOCR's `confidence` field. |
| `BIB_MIN_LEN` / `BIB_MAX_LEN` | `1` / `6` (field-test; nominal `2` / `5`) | Accepted BIB length range |
| `OCR_VOTE_BUFFER_SIZE` | `5` | Rolling buffer of recent valid reads |
| `OCR_VOTE_MIN_CONSENSUS` | `3` | Reads-in-agreement required for consensus |

#### `checkpoint.html` — advanced violation triggers
| Constant | Default | Effect |
|---|---|---|
| `NO_BIB_AFTER_FAILURES` | `5` | Consecutive analyze-cycles without a paired in-region BIB before firing `NO_BIB` (empty) or `OBSCURED_BIB` (paired but failed length/conf) |
| `UNREGISTERED_AFTER_FRAMES` | `15` | Consecutive frames an unrecognized face must stay visible before firing `UNREGISTERED` |
| `MULTIPLE_BIBS_MIN_BLOCK_LEN` | `2` | Minimum digits per server detection to count as a candidate BIB |
| `MULTIPLE_BIBS_MIN_BLOCKS` | `2` | Minimum candidate detections inside one chest region to fire `MULTIPLE_BIBS` |

#### `dashboard.html`
| Constant | Default | Effect |
|---|---|---|
| `POLL_RESULTS_MS` | `5000` | Leaderboard refresh |
| `POLL_VIOLATIONS_MS` | `10000` | Public alerts refresh |
| `POLL_ADMIN_MS` | `15000` | Admin tables refresh |
| `DISMISSED_MAX` | `500` | FIFO cap on dismissed-alert memory |

#### `checkpoint_camera.py` — edge node (v0)
| Constant | Default | Effect |
|---|---|---|
| `MODEL_PATH` | `"yolov8n.pt"` | YOLO weights; ultralytics auto-downloads on first run. Replace with BIB-fine-tuned `.pt` when available. |
| `CAMERA_INDEX` | `0` | `cv2.VideoCapture` index |
| `WINDOW_NAME` | `"RunnerTrack — Edge Node v0"` | OpenCV display window title |
| `YOLO_CONF_THRESHOLD` | `0.5` | Per-detection score floor (matches `legacy_v1/main.py`) |
| `MIN_OCR_ROI_SIZE` | `20` | Skip OCR on ROIs smaller than this on either axis (EasyOCR / PaddleOCR both crash on degenerate inputs) |
| `QUIT_KEY` | `"q"` | Key that exits the loop |
| `BBOX_THICKNESS` | `2` | bbox stroke width |
| `BBOX_COLOR` | `(0, 255, 0)` (BGR green) | bbox + label-tab fill color |
| `LABEL_TEXT_COLOR` | `(255, 255, 255)` (BGR white) | label text color inside the tab |
| `LABEL_FONT_SCALE` | `0.6` | `cv2.putText` scale (drives `cv2.getTextSize`) |
| `LABEL_PAD` | `4` | inner padding around label text inside the tab |

### 6.9 Configuration knobs (backend, `Code.gs`)

| Constant | Default | Effect |
|---|---|---|
| `CACHE_TTL_SEC` | `12` | Read-through cache TTL |
| `CACHE_MAX_BYTES` | `90 × 1024` | Skip-cache threshold (per-key Apps Script limit is 100 KB) |
| `LOCK_TIMEOUT_MS` | `10000` | `LockService` wait inside `getOrCreateFolder` |
| `BATCH_DELETE_MAX` | `200` | Cap on `deleteViolationsBatch` |
| `DEFAULT_VIOLATION_TYPE` | `"WRONG_PERSON"` | Fallback for empty/legacy rows |
| `DEFAULT_ADMIN_TOKEN` | `"muto67"` | Used only if `ScriptProperties.ADMIN_TOKEN` is unset |

---

## 7. The "Continuous Update" Directive (operational rule)

**This rule is binding on every AI agent acting in this workspace.**

At the **end of every task** — feature implementation, bug fix, refactor,
schema change, dependency bump, or deploy-procedure tweak — the agent
MUST update `AI_CONTEXT.md` in the same change set so it reflects the
new reality. Concretely:

1. **Before finishing a task**, ask: did this change…
   - introduce, rename, or remove an endpoint? → §6.7
   - change a sheet schema, column order, or default? → §3.1, §6.3
   - change a Drive folder layout or sharing setting? → §3.2, §5
   - change a polling cadence, cache TTL, or any tuning constant? → §6.8, §6.9
   - change the recognition / OCR / cooldown logic? → §4.2, §6.8
   - change the admin auth flow? → §4.6
   - establish a new "do not break" rule? → §5
   - close out a known behavior or introduce a new one? → §6.5
2. If yes to any of the above, **edit the relevant section of this
   file** before declaring the task done.
3. Bump the `Last updated:` line at the top.
4. If the change is large enough that other agents would benefit from
   knowing the *why*, add a "Recent changes (YYYY-MM-DD)" subsection
   immediately after §6.1 (rename/renumber existing subsections — keep
   §6.2 as the most recent change so readers find it first).
5. **Do not** create a separate changelog or planning doc — this file is
   the changelog. Multiple parallel docs drift apart.
6. Commit the `AI_CONTEXT.md` change in the same commit as the code
   change it documents. Reviewers should be able to see "what changed"
   and "what the new contract is" together.

If a change doesn't touch any of the above (e.g. a typo fix, a CSS
nudge, a new test), no update is required — but a quick scan of §5
and §6 is still cheap insurance against drift.
