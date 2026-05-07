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
> **Last updated:** 2026-05-07 — CV pipeline overhaul in `checkpoint.html`
> (TinyFaceDetector, bbox EMA, OCR preprocess + voting). Backend still v5.

---

## 1. Project Overview & Architecture

**RunnerTrack AI** is a chip-less, browser-based runner timing system that
identifies runners by face recognition and reads BIB numbers via OCR — no
RFID, no wearable hardware. The system is bilingual UI (Thai labels, English
identifiers) and runs entirely in the browser plus a Google Apps Script
backend.

### High-level architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  BROWSER (all AI runs here)                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ register.html│  │checkpoint.htm│  │ dashboard.html (+admin)  │  │
│  │ • face-api.js│  │ • face-api.js│  │ • polls Apps Script      │  │
│  │ • 5-angle    │  │ • Tesseract  │  │ • leaderboard + alerts   │  │
│  │   capture    │  │ • per-CP     │  │ • admin CRUD + bulk ops  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
└─────────┼─────────────────┼─────────────────────┼──────────────────┘
          │ POST            │ POST/GET            │ GET/POST
          │ registerRunner  │ recordCheckpoint    │ getResults, getRunners,
          │                 │ reportViolation     │ getVerifiedViolations,
          │                 │                     │ verify/delete/update…
          ▼                 ▼                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  GOOGLE APPS SCRIPT  (apps_script/Code.gs — v5)                    │
│  • doGet (cache-fronted reads, 12 s TTL)                           │
│  • doPost (writes; invalidate cache on success)                    │
│  • Drive cleanup on delete (synchronous, try-catch isolated)       │
└────────────────────────────────────────────────────────────────────┘
          │                 │                     │
          ▼                 ▼                     ▼
┌──────────────────────┐  ┌────────────────────────────────────────┐
│ Google Sheets        │  │ Google Drive                           │
│ • Runners            │  │ • RunnerFaces/<name>/<angle>_<ts>.jpg  │
│ • Results            │  │ • ViolationEvidence/violation_<ts>.jpg │
│ • Violations         │  │ (ANYONE_WITH_LINK / VIEW)              │
└──────────────────────┘  └────────────────────────────────────────┘

         (Optional) Flask = static HTML host for the 3 templates.
         Flask does NO AI work and is NOT required if templates are
         hosted on a static site (GitHub Pages, Netlify, etc.).
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
├── web_app.py             ← Flask: serves 3 HTML templates only
├── requirements.txt       ← legacy deps; in v2 only `flask` is needed
├── yolov8n-face.pt        ← legacy YOLO weights (used by legacy_v1 only)
├── running_results.csv    ← legacy CSV log (gitignored, rarely cleared)
├── .gitignore
│
├── templates/             ← The active product (browser frontend)
│   ├── register.html      ← Runner registration (5-angle face capture)
│   ├── checkpoint.html    ← Real-time recognition + checkpoint logging
│   └── dashboard.html     ← Public leaderboard + Admin portal (login-gated)
│
├── apps_script/
│   └── Code.gs            ← Google Apps Script REST API (v5)
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
| `web_app.py` | Tiny Flask wrapper, 4 routes (`/`, `/register`, `/checkpoint`, `/admin`-alias). **Does no AI work.** | Adding/renaming a frontend page |
| `templates/register.html` | Capture 5 face angles, compute averaged 128-d descriptor, single atomic upload | Changing capture UX, embedding format, registration payload |
| `templates/checkpoint.html` | Live detection loop (face-api + Tesseract), per-CP cooldowns, smart OCR, violation reporting | Recognition tuning, OCR strategy, CP buttons |
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
- `Photo_*` cells store Drive embed URLs:
  `https://drive.google.com/uc?export=view&id=<FILE_ID>`
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
├── RunnerFaces/                       ← shared ANYONE_WITH_LINK / VIEW
│   ├── kawin/
│   │   ├── kawin_front_<ts>.jpg
│   │   ├── kawin_top_<ts>.jpg
│   │   ├── kawin_bottom_<ts>.jpg
│   │   ├── kawin_left_<ts>.jpg
│   │   └── kawin_right_<ts>.jpg
│   └── …/
└── ViolationEvidence/                 ← shared ANYONE_WITH_LINK / VIEW
    └── violation_<name>_<ts>.jpg
```

- Folder creation is wrapped in a **`LockService` lock** to prevent
  duplicates from concurrent registrations.
- All files are served via the embed URL form
  `https://drive.google.com/uc?export=view&id=<id>` — this is what makes
  `<img src>` work without OAuth in the public dashboard.

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

### 4.2 Checkpoint detection (`checkpoint.html` → `recordCheckpoint`/`reportViolation`)

The pipeline has two **independent triggers**:

- **`recordCheckpoint`** is gated by FACE recognition only — N consecutive
  matches above the FACE_MATCH_DISTANCE threshold + per-CP cooldown.
- **`reportViolation`** is gated by FACE recognition AND OCR consensus —
  consensus BIB must disagree with the registered BIB AND a separate
  per-CP violation cooldown must be elapsed.

```
init():
  load face-api models           (TinyFaceDetector + Landmark68 + Recognition)
  GET /?action=getRunners
    → build FaceMatcher(labels, FACE_MATCH_DISTANCE = 0.45)
    → runnerRegistry[name] = bibNumber
  getUserMedia(VIDEO_WIDTH × VIDEO_HEIGHT = 1280×720)
    NotAllowedError surfaced as friendly Thai message
  Tesseract.createWorker("eng") + setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode:   '7'        // single text line
  })
  start requestAnimationFrame(processLoop)

processLoop (every frame):
  detectorOptions = TinyFaceDetectorOptions({
    inputSize: FACE_DETECTOR_INPUT_SIZE (320),
    scoreThreshold: FACE_DETECTOR_SCORE_THRESHOLD (0.5)
  })
  detectAllFaces(video, detectorOptions).withFaceLandmarks().withFaceDescriptors()

  for each detection:
    match = faceMatcher.findBestMatch(descriptor)
    isKnown = match.label !== "unknown" AND match.distance <= FACE_MATCH_DISTANCE
    box = isKnown ? smoothBox(name, rawBox) : rawBox      ← EMA: α=0.35

    if isKnown:
      consecutiveFrames[name]++

      ── recordCheckpoint trigger (face-only) ──
      if consecutiveFrames[name] >= RECORD_AFTER_FRAMES (5)
         AND now - cooldowns["name:cpId"] > COOLDOWN_SEC (30):
           cooldowns["name:cpId"] = now
           POST recordCheckpoint

      ── OCR trigger ──
      if consecutiveFrames[name] >= OCR_AFTER_FRAMES (10) AND !ocrBusy:
           runSmartOCR(video, box, name)   ← uses SMOOTHED box

    draw rect (using box), label "name (XX%)", BIB consensusBib(name) || expected

  ── per-frame staleness sweep ──
  consecutiveFrames[n] = 0 for n not in currentNames
  bboxEMA[n].missingFrames++ for n not in currentNames
  if missingFrames > BBOX_EMA_RESET_FRAMES (10):
    delete bboxEMA[n]; delete ocrVotes[n]


runSmartOCR(video, box, name):
  crop chest region using SMOOTHED box (below face: 2.5×faceH tall)
  preprocessForOCR(crop):
    grayscale (BT.601) → integral image →
    adaptive threshold (mean − ADAPTIVE_THRESHOLD_C, ADAPTIVE_THRESHOLD_BLOCK² window) →
    nearest-neighbor 2× upscale
  result = tesseractWorker.recognize(processed)            ← async, off-thread
  text = digits-only(result.data.text)
  conf = result.data.confidence

  ── validation gate (silent reject on fail) ──
  if !text                                          → return
  if text.length < BIB_MIN_LEN (2)
     OR text.length > BIB_MAX_LEN (5)               → return
  if conf < OCR_MIN_CONFIDENCE (70)                 → return

  ── majority vote ──
  buf = ocrVotes[name]; push {text, ts, conf}
  evict entries older than OCR_CACHE_TTL_MS (15s)
  cap buf at OCR_VOTE_BUFFER_SIZE (5)
  if max-tally(buf) < OCR_VOTE_MIN_CONSENSUS (3)    → return  (no consensus yet)

  consensus = majority bib
  ocrConsensus[name] = {bib: consensus, ts: now}

  ── violation trigger (consensus mismatch + cooldown) ──
  if registered[name] AND consensus !== registered[name]:
    if now - violationCooldowns["name:cpId"] > VIOLATION_COOLDOWN_SEC (60):
      violationCooldowns["name:cpId"] = now
      reportViolation(name, expected=registered[name], found=consensus,
                      violationType="WRONG_PERSON")
```

**Per-CP cooldown keys** use `"<name>:<cpId>"` — this lets a runner
trigger each station once even if they double back through the camera
view. Record cooldowns and violation cooldowns live in **separate
buckets** so reporting a violation does not suppress a legitimate
timing record (or vice versa).

**Smart OCR** crops a region **below** the face (height ≈ 2.5×face
height, width ≈ face width + 0.6×face height on each side, clamped to
video dimensions) — the assumption is the BIB is on the chest of the
shirt. The crop is taken from the **EMA-smoothed** box; using the raw
detection box made the crop jitter and tanked Tesseract confidence.

**Preprocessing runs on the main thread** (not in a Web Worker) because
the typical 200×150 px crop costs <1 ms via integral image, while a
worker round-trip would add postMessage / structured-clone overhead
larger than the work itself. **Tesseract itself runs in its own Web
Worker** (Tesseract.js v5 default), so the actual recognition step
never blocks the render loop.

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
- `isLoadingAdmin` mutex prevents an admin poll from clobbering an
  in-progress bulk delete.

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
  `extractDriveFileId` (handles both `uc?export=view&id=…` and legacy
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
8. **CDN versions are pinned.** `face-api.js@0.22.2` and
   `tesseract.js@5` and the model weights URL must stay pinned. `@master`
   was tried once and silently broke face matching.
9. **Admin token is not in source.** It lives in
   `PropertiesService.ScriptProperties`. If you must change the default,
   edit `_setupAdminToken()` and re-run it from the editor — never hard-
   code in a frontend file.
10. **Time format = `HH:MM:SS` plain text** in `Results` columns C–I.
    The schema setup forces `setNumberFormat("@")` on first creation —
    do not remove this. If Sheets converts `13:01` to a Date, the
    leaderboard breaks.
11. **`ANYONE_WITH_LINK / VIEW` sharing is intentional.** The dashboard
    renders Drive images in `<img src>` from any browser — without
    public sharing the embed URLs return 401 and the alerts show broken
    images. Restricting sharing requires re-architecting image
    delivery (e.g. base64-inline or a proxy endpoint).
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
16. **Don't introduce server-side AI.** All face/OCR work runs in the
    browser by design (zero compute cost on the backend, scales to N
    open laptops for free). Apps Script is for storage and validation,
    not inference.
17. **`legacy_v1/` is frozen.** Do not refactor it as part of v2 work.
    It only changes when the user explicitly asks for offline-mode
    fixes.
18. **The EMA-smoothed bbox MUST be passed to `runSmartOCR`.** Cropping
    from the raw detection box reintroduces frame-to-frame jitter and
    Tesseract confidence collapses. `processLoop` builds `box =
    smoothBox(name, rawBox)` once per detection and uses it for both
    the overlay and the OCR crop — preserve that contract.
19. **OCR preprocessing is `grayscale → adaptive threshold → 2×
    nearest-neighbor`, in that order, on the main thread.** Don't swap
    in bilinear upscale (introduces gray pixels Tesseract mistreats).
    Don't move it to a Web Worker (the postMessage round-trip is
    larger than the work). Don't drop the threshold step (gray text on
    gray jersey is the dominant failure mode without it).
20. **Tesseract worker config is part of the contract.** `tessedit_char_whitelist
    = '0123456789'` and `tessedit_pageseg_mode = '7'` are set once at
    init and assumed by the validation gate. Do not change these
    without re-deriving the BIB length and confidence thresholds.
21. **Violations require majority consensus, not a single read.** The
    `castVote` → consensus gate exists because single-frame OCR
    misreads were generating false-positive `WRONG_PERSON` reports.
    Don't bypass it (e.g., by calling `reportViolation` directly from
    `runSmartOCR` on the first read).
22. **Recording vs violation triggers are independent.** `recordCheckpoint`
    is gated on **face** consecutive frames + record cooldown only — it
    must NOT depend on OCR consensus, because operators want timing
    records even when the BIB is unreadable. Conversely, the violation
    gate must NOT trigger record writes.

---

## 6. Current State (as of the last update)

### 6.1 Active version

- **`Code.gs` is at v5.** Header comment block in `Code.gs` is the
  authoritative changelog for the backend.
- Frontend templates align with v5 (ViolationType + bulk delete UI).

### 6.2 Recent changes (2026-05-07): CV pipeline overhaul in `checkpoint.html`

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
  only, length 2–5, confidence ≥ 70) are dropped without UI feedback.
  This is intentional — corrupt votes would derail consensus. Drop
  `OCR_MIN_CONFIDENCE` if low-light footage starves the vote buffer.
- **Violation requires ≥3-of-5 consensus**: a single wrong-BIB read
  no longer fires a `WRONG_PERSON` violation. The runner's chest must
  be readable for at least 3 frames inside a 15-second window.
- **EMA persists across brief detection misses**: a 1–10 frame gap in
  detection keeps the smoothed box around so the next match snaps
  back without re-warming up. Past 10 frames the EMA and vote buffer
  are dropped together.
- **Sample data** in `Data/` (legacy face DB) and `events/test/` is
  retained for reference; both directories are gitignored.

### 6.6 One-off setup helpers (Apps Script editor)

Run these from the function dropdown in the Apps Script editor.
All are idempotent.

| Function | Purpose | When to run |
|---|---|---|
| `_setupAdminToken()` | Stores the admin password in `ScriptProperties` | Once at deploy time, or when changing the password |
| `_consolidateDuplicateRootFolders()` | Merges duplicate `RunnerFaces`/`ViolationEvidence` folders into one canonical folder | If a race ever creates duplicates (predates the lock fix) |
| `_migrateAllImageUrls()` | Rewrites legacy `/file/d/<id>/view` URLs to the embed form | Once after the v3 image-URL change |
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

#### `checkpoint.html` — OCR pipeline
| Constant | Default | Effect |
|---|---|---|
| `OCR_AFTER_FRAMES` | `10` | Consecutive recognitions before triggering Tesseract |
| `OCR_CACHE_TTL_MS` | `15000` | Vote-buffer + consensus expiry |
| `ADAPTIVE_THRESHOLD_BLOCK` | `15` | Local-window size for adaptive threshold (odd; 11–19 typical) |
| `ADAPTIVE_THRESHOLD_C` | `10` | Mean offset; higher = more aggressive thresholding |
| `OCR_UPSCALE` | `2` | Nearest-neighbor scale factor before OCR |
| `OCR_MIN_CONFIDENCE` | `70` | Tesseract overall-confidence floor |
| `BIB_MIN_LEN` / `BIB_MAX_LEN` | `2` / `5` | Accepted BIB length range |
| `OCR_VOTE_BUFFER_SIZE` | `5` | Rolling buffer of recent valid reads |
| `OCR_VOTE_MIN_CONSENSUS` | `3` | Reads-in-agreement required for consensus |

#### `dashboard.html`
| Constant | Default | Effect |
|---|---|---|
| `POLL_RESULTS_MS` | `5000` | Leaderboard refresh |
| `POLL_VIOLATIONS_MS` | `10000` | Public alerts refresh |
| `POLL_ADMIN_MS` | `15000` | Admin tables refresh |
| `DISMISSED_MAX` | `500` | FIFO cap on dismissed-alert memory |

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
