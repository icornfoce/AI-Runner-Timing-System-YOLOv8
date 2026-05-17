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
> **Last updated:** 2026-05-17 — Backend bumped to **v7**: new
> read-only endpoints `getDrivePhotos` (lists images inside a
> photographer-supplied Drive folder) and `getImageBytes` (streams a
> single Drive image as base64) power a new browser page
> `templates/photo_scanner.html` (`/scan`). The scanner runs the same
> face-api + Tesseract pipeline as `checkpoint.html` but **on static
> photos uploaded to Drive after the race**, with SSD MobileNet
> instead of TinyFaceDetector and no multi-frame state (no EMA, no
> majority voting, no Ghost-BIB counter). Per-session dedup keeps
> burst shots from double-recording. Same-day follow-up: the
> `/checkpoint` Flask route is **commented out** and the dashboard
> nav link replaced with a Photo Scanner CTA, so live-camera mode is
> no longer reachable from the UI. `templates/checkpoint.html` is
> retained on disk (and remains the canonical reference for the
> multi-frame pipeline this doc describes); restoring live mode is a
> one-line uncomment in `web_app.py`.

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
│  GOOGLE APPS SCRIPT  (apps_script/Code.gs — v6)                    │
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
├── web_app.py             ← Flask: serves the active HTML templates (the
│                            /checkpoint route is commented out; see §6.2)
├── requirements.txt       ← legacy deps; in v2 only `flask` is needed
├── yolov8n-face.pt        ← legacy YOLO weights (used by legacy_v1 only)
├── running_results.csv    ← legacy CSV log (gitignored, rarely cleared)
├── .gitignore
│
├── templates/             ← The active product (browser frontend)
│   ├── register.html       ← Runner registration (5-angle face capture)
│   ├── checkpoint.html     ← Real-time recognition (retained-but-unrouted; see §6.2)
│   ├── photo_scanner.html  ← Drive Photo Scanner (post-race batch mode)
│   └── dashboard.html      ← Public leaderboard + Admin portal (login-gated)
│
├── apps_script/
│   └── Code.gs            ← Google Apps Script REST API (v7)
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
| `web_app.py` | Tiny Flask wrapper, 4 active routes (`/`, `/register`, `/scan`, `/admin`-alias) plus a commented-out `/checkpoint`. **Does no AI work.** | Adding/renaming a frontend page |
| `templates/register.html` | Capture 5 face angles, compute averaged 128-d descriptor, single atomic upload | Changing capture UX, embedding format, registration payload |
| `templates/checkpoint.html` | Live detection loop (face-api + Tesseract), per-CP cooldowns, smart OCR, violation reporting. **Retained on disk but no longer routed**; see §6.2. Still the canonical reference for the multi-frame pipeline described in §4.2. | Restoring live mode, or referencing the multi-frame pipeline for new work |
| `templates/photo_scanner.html` | Drive Photo Scanner — post-race batch processing of photographer-uploaded Drive folder. SSD MobileNet, single-pass per face, session-level dedup. | Drive scanner tuning, batch UX, dedup strategy |
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

### 4.2 Checkpoint detection (`checkpoint.html` → `recordCheckpoint`/`reportViolation`)

> ⚠️ **`/checkpoint` is no longer routed** (see §6.2, 2026-05-17
> follow-up). The file remains on disk because it is the canonical
> reference for the multi-frame live pipeline this section describes,
> and because restoring live mode is a one-line uncomment in
> `web_app.py`. Treat this section as documentation of the **retained
> implementation**; the active product is the Drive Scanner (§4.7).

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

  largestUnknownBox = null, largestUnknownArea = 0          ← per-frame intruder tracker

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

    else:                                                    ← intruder candidate
      area = rawBox.width * rawBox.height
      if area > largestUnknownArea: largestUnknownBox = rawBox

    draw rect (using box), label "name (XX%)", BIB consensusBib(name) || expected
    if isKnown:
      draw dashed-red OCR debug rect at getOCRCropBox(box, video)   ← operator visibility

  ── post-loop: UNREGISTERED (Intruder) trigger ──
  if largestUnknownBox:
    consecutiveFrames["unknown"]++
    if consecutiveFrames["unknown"] >= UNREGISTERED_AFTER_FRAMES (15):
      tryFireViolation("unknown:cpId", { violationType:"UNREGISTERED",
                                          image:captureFaceCrop(...) })

  ── per-frame staleness sweep ──
  consecutiveFrames[n] = 0 for n not in currentNames        ← also resets "unknown"
  bboxEMA[n].missingFrames++ for n not in currentNames
  if missingFrames > BBOX_EMA_RESET_FRAMES (10):
    delete bboxEMA[n]; delete ocrVotes[n]; delete ocrConsensus[n]
    delete ocrFailureCount[n]; delete ocrLastFailureKind[n]


runSmartOCR(video, box, name):
  {bx, by, bw, bh} = getOCRCropBox(box, video)              ← shared with overlay
  crop chest region using SMOOTHED box (3×faceH tall, starts at chin)
  preprocessForOCR(crop):
    grayscale (BT.601) → integral image →
    adaptive threshold (mean − ADAPTIVE_THRESHOLD_C, ADAPTIVE_THRESHOLD_BLOCK² window) →
    nearest-neighbor 2× upscale
  result = tesseractWorker.recognize(processed)            ← async, off-thread
  rawText = result.data.text                               ← keep raw for MULTIPLE_BIBS
  conf = result.data.confidence

  ── MULTIPLE_BIBS (Cluttered Chest) trigger ──            ← runs on RAW text first
  blocks = rawText.match(/\d{MULTIPLE_BIBS_MIN_BLOCK_LEN(2),}/g) || []
  if blocks.length >= MULTIPLE_BIBS_MIN_BLOCKS (2):
    if tryFireViolation("name:cpId", { violationType:"MULTIPLE_BIBS" }):
      ocrFailureCount[name] = 0; return
    (else fall through; cooldown blocked it)

  text = digits-only(rawText)

  ── validation gate → Ghost BIB counter ──
  failureKind = !text                                  ? "empty"
              : text.length ∉ [BIB_MIN_LEN, BIB_MAX_LEN] ? "low_quality"
              : conf < OCR_MIN_CONFIDENCE              ? "low_quality"
              : null
  if failureKind:
    ocrFailureCount[name]++
    if ocrFailureCount[name] >= NO_BIB_AFTER_FAILURES (5):
      type = (failureKind=="empty") ? "NO_BIB" : "OBSCURED_BIB"
      tryFireViolation("name:cpId", { violationType:type })
    return
  ocrFailureCount[name] = 0                            ← clear on success

  ── majority vote ──
  buf = ocrVotes[name]; push {text, ts, conf}
  evict entries older than OCR_CACHE_TTL_MS (15s)
  cap buf at OCR_VOTE_BUFFER_SIZE (5)
  if max-tally(buf) < OCR_VOTE_MIN_CONSENSUS (3)    → return  (no consensus yet)

  consensus = majority bib
  ocrConsensus[name] = {bib: consensus, ts: now}

  ── WRONG_PERSON trigger (consensus mismatch) ──
  if registered[name] AND consensus !== registered[name]:
    tryFireViolation("name:cpId", { violationType:"WRONG_PERSON" })


tryFireViolation(cooldownKey, payload):
  if violationCooldowns[cooldownKey] hot (≤ VIOLATION_COOLDOWN_SEC (60)): return false
  violationCooldowns[cooldownKey] = now
  reportViolation(payload)                                 ← options-style payload
  return true
```

**Per-CP cooldown keys** use `"<name>:<cpId>"` (or `"unknown:<cpId>"`
for `UNREGISTERED`) — this lets a runner trigger each station once even
if they double back through the camera view. Record cooldowns and
violation cooldowns live in **separate buckets** so reporting a
violation does not suppress a legitimate timing record (or vice versa).
Within the violation bucket, all five violation types — `WRONG_PERSON`,
`NO_BIB`, `OBSCURED_BIB`, `MULTIPLE_BIBS`, `UNREGISTERED` — share the
same per-runner+CP key, so the 60 s spam-prevention budget cannot be
bypassed by stacking different types on the same runner. The shared
gate lives in `tryFireViolation(cooldownKey, payload)`; every trigger
site goes through it.

**Smart OCR** crops a region anchored to the smoothed face box, computed
by `getOCRCropBox(box, video)` — the **single source of truth** for crop
geometry, used by both `runSmartOCR` and the dashed-red OCR debug overlay
in `processLoop`. Current factors (post-field-test tuning):

- `bx = box.x − 0.5·faceH`         (lateral pad)
- `by = box.y + 0.6·faceH`         (start at chin level — catches BIBs
                                     held by hand near neck)
- `bw = box.width + 1.0·faceH`     (~2× face width)
- `bh = 3.0·faceH`                 (extends well below the chest)

The crop is taken from the **EMA-smoothed** box; using the raw detection
box made the crop jitter and tanked Tesseract confidence.

The OCR debug overlay (dashed red rectangle labeled `OCR`) is drawn on
the overlay canvas for known runners only — it lets the field operator
see exactly where Tesseract will look, so they can correct how a runner
holds the BIB. Skipped for `Unknown` (we never OCR them).

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

### 4.7 Drive Photo Scanner (`photo_scanner.html` → `recordCheckpoint`/`reportViolation`)

A **batch, post-race** processing mode that complements the live
`checkpoint.html` loop. Photographers dump event photos into a shared
Drive folder; an operator opens `/scan`, pastes the folder ID, picks a
checkpoint, and presses Start. The browser pulls each photo through
Apps Script, runs SSD MobileNet + Tesseract, and emits the same
`recordCheckpoint` / `reportViolation` POSTs the live page emits.

```
init():
  load face-api (ssdMobilenetv1 + Landmark68 + Recognition)
  GET /?action=getRunners
    → build FaceMatcher(labels, FACE_MATCH_DISTANCE = 0.45)
    → runnerRegistry[name] = bibNumber
  Tesseract.createWorker("eng") + setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode:   '7'
  })

startScan():
  GET /?action=getDrivePhotos&folderId=<id>
    → [{ id, name, mimeType, thumbnailUrl }, ...]
  for each photo, sequentially (Stop button aborts the loop):
    GET /?action=getImageBytes&fileId=<id>
      → { base64, mimeType }                ← un-tainted same-origin path
    decode → <img> → draw to preview canvas at native resolution
    detectAllFaces(canvas, SsdMobilenetv1Options{minConfidence:0.5})
      .withFaceLandmarks().withFaceDescriptors()

    for each detection:
      match = faceMatcher.findBestMatch(descriptor)
      isKnown = match.label !== "unknown" AND match.distance ≤ FACE_MATCH_DISTANCE
      draw rectangle (green/red) on preview canvas
      categorize: knownHits[] or largestUnknown

    ── recordCheckpoint trigger (face-only, dedup-gated) ──
    for each known hit:
      if !seenRecords["name:cpId"]:
        seenRecords["name:cpId"] = true
        POST recordCheckpoint(name, cpId, scanTimeHHMMSS, bib)
      run single-pass OCR on chest crop (getOCRCropBox)

    ── OCR (single read per face, NO majority vote) ──
    preprocessForOCR(crop):
      grayscale (BT.601) → integral image →
      adaptive threshold (mean − ADAPTIVE_THRESHOLD_C,
                          ADAPTIVE_THRESHOLD_BLOCK² window) →
      nearest-neighbor 2× upscale
    {text, conf} = tesseractWorker.recognize(processed)

    if RAW text has ≥MULTIPLE_BIBS_MIN_BLOCKS blocks of length
       ≥MULTIPLE_BIBS_MIN_BLOCK_LEN:
      fireViolation MULTIPLE_BIBS (dedup key "name:cpId:MULTIPLE_BIBS")
      continue

    digitsOnly = text.replace(/[^0-9]/g, "")
    if !digitsOnly OR length ∉ [BIB_MIN_LEN, BIB_MAX_LEN] OR conf < OCR_MIN_CONFIDENCE:
      silent reject (NO Ghost-BIB counter — no multi-frame state)
    else if registered[name] AND digitsOnly !== registered[name]:
      fireViolation WRONG_PERSON (dedup key "name:cpId:WRONG_PERSON")

    ── UNREGISTERED trigger (largest unknown per photo) ──
    if largestUnknown exists AND !seenUnknownsPerPhoto["fileId:unknown"]:
      seenUnknownsPerPhoto["fileId:unknown"] = true
      fireViolation UNREGISTERED with face crop
                    (dedup key "unknown:fileId:UNREGISTERED")
```

**Why two endpoints instead of one inline base64 payload.** The Drive
thumbnail URL (`drive.google.com/thumbnail?id=…&sz=w800`)
302-redirects to `lh3.googleusercontent.com`, which does **not** send
`Access-Control-Allow-Origin` headers. An `<img crossOrigin=anonymous>`
either fails outright or taints the canvas — and a tainted canvas
blocks `getImageData()`, which both face-api (descriptor read-out)
and Tesseract (pixel input) require. The scanner therefore fetches
image bytes via Apps Script (`getImageBytes` returns base64 over the
same-origin API channel) and decodes them into a `data:` URL, which
is same-origin by definition and never taints the canvas. The
thumbnail URL stays in the v6 contract for display-only consumers
(dashboard, future preview features).

**Why SSD MobileNet, not TinyFaceDetector.** Static event photos are
usually 4K+ resolution with multiple runners across the frame; SSD
produces tighter, higher-recall boxes than Tiny on that target. The
scanner's per-photo wall time (~3–8 s) is bounded by network +
base64 decode, not by detection, so the 5× FPS advantage Tiny has on
720p video doesn't apply here.

**Why no EMA / no majority vote / no Ghost-BIB counter.** All three
require multi-frame state. The scanner sees each runner exactly once
per photo (and one photo is one frame for that runner) — there's
nothing to smooth, vote, or count. A single OCR read passes or fails
the validation gate; the photographer's selects are already curated
for clarity, so single-frame false positives are rare in practice.
For the same reason, the scanner doesn't fire `NO_BIB` or
`OBSCURED_BIB`: those types only exist in `checkpoint.html` to
escalate after `NO_BIB_AFTER_FAILURES` consecutive validation-gate
silent rejects.

**Per-session deduplication.** Burst-mode photography (10 fps shutter
on the same runner) would otherwise emit one record per photo. The
scanner suppresses duplicates with three in-memory sets:

| Key                                       | Purpose                                        |
|---|---|
| `seenRecords["name:cpId"]`                | One `recordCheckpoint` per runner per CP per session  |
| `seenViolations["name:cpId:type"]`        | One violation per type per runner per CP per session  |
| `seenUnknownsPerPhoto["fileId:unknown"]`  | Cap `UNREGISTERED` at ≤1 per photo (matches live)     |

Sets reset on page reload OR when Start is pressed for a fresh batch.
**There is no backend dedup**: the backend remains stateless across
scanner calls. A duplicate that slips through (e.g. operator re-runs
the same folder after a reload) writes a duplicate row — admins
clean it up via the dashboard's bulk-delete tools.

**Timestamps are scan-time, not capture-time.** `recordCheckpoint`
receives `new Date().toTimeString().split(" ")[0]` (HH:MM:SS at the
moment of the POST), not the photo's EXIF capture time. EXIF parsing
is not implemented; if/when it is, write the scanner to fall back to
scan-time when EXIF is missing (some screenshots and edited images
strip it). For most workflows, relative ordering is what matters and
scan-time is sufficient.

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
23. **Recurring polls MUST use `AbortController`, not a mutex or queue.**
    Each poller (`fetchResults`, `fetchViolations`, `loadAdminData`)
    aborts its own in-flight fetch before starting a new one and drops
    late-arriving stale responses via an `ac === xxxAbort` identity
    check after the await. Reasoning: a mutex coalesces by **dropping
    the new fetch on the floor** — under an Apps Script cold start that
    leaves the UI stale for 30 + s. A queue introduces tail latency.
    Abort-and-restart gives the freshest data with no pile-up.
24. **`getOCRCropBox` is the single source of truth for chest crop
    geometry.** Both `runSmartOCR` and the dashed-red OCR debug overlay
    in `processLoop` call it. If either path computes the crop inline,
    the operator's visible rectangle drifts away from where Tesseract
    actually looks — defeating the purpose of the debug overlay. Keep
    the helper as the only place crop factors live.
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
26. **The `MULTIPLE_BIBS` check runs on RAW Tesseract text BEFORE
    digit-only normalization.** Once
    `text=String(rawText).replace(/[^0-9]/g,"")` is applied, the
    whitespace separating distinct BIB blocks is gone and `\d{2,}`
    matches one giant concatenated number instead of two distinct ones.
    Keep the regex anchored to `\d{MULTIPLE_BIBS_MIN_BLOCK_LEN,}`
    against `result.data.text`, not the normalized form.
27. **The Drive scanner's CV pipeline deliberately diverges from
    `checkpoint.html`.** SSD MobileNet (not TinyFaceDetector),
    single-pass OCR (no majority vote), no bbox EMA, no Ghost-BIB
    counter, no `NO_BIB` / `OBSCURED_BIB` firings. The static-image
    and live-video tradeoffs go in opposite directions — Tiny + EMA +
    voting exist because the live loop has 30 FPS of noisy detections
    to lean on, while the scanner has exactly one frame per runner
    per photo. Don't try to factor the two pipelines into shared
    helpers without re-deriving the validation thresholds for both
    targets. `getOCRCropBox` and `preprocessForOCR` ARE intentionally
    duplicated across `checkpoint.html` and `photo_scanner.html` —
    they share geometry and preprocessing because those are the
    Tesseract-tuned constants Guardrail 19 + 24 protect.
28. **The Drive scanner MUST fetch image bytes via `getImageBytes`,
    not via `<img crossOrigin=anonymous>` against the thumbnail URL.**
    `drive.google.com/thumbnail?id=…&sz=w800` 302-redirects to
    `lh3.googleusercontent.com`, which does NOT return
    `Access-Control-Allow-Origin` headers. An `<img crossOrigin>`
    against the redirect target either errors out or taints the
    canvas — and a tainted canvas blocks `getImageData()`, which
    both face-api descriptor read-out AND Tesseract pixel input
    require. The base64-over-Apps-Script → `data:` URL path is the
    only safe route. The thumbnail URL stays in the v6 contract for
    display-only consumers (dashboard `<img src>`) — those don't
    touch canvas pixels.

---

## 6. Current State (as of the last update)

### 6.1 Active version

- **`Code.gs` is at v7.** Header comment block in `Code.gs` is the
  authoritative changelog for the backend.
- `templates/photo_scanner.html` (the Drive Photo Scanner) is new in
  v7. The other three templates (`register.html`, `checkpoint.html`,
  `dashboard.html`) are unchanged from their v5/v6 baselines.

### 6.2 Recent changes

#### 2026-05-17 — v7: Drive Photo Scanner workflow

Adds a **post-race batch processing mode** so photographers can dump
event photos into a shared Drive folder and have the same recognition
pipeline that runs at the live checkpoint reprocess them after the
race. Backend `Code.gs` bumped v6 → v7; one new HTML template;
`web_app.py` gains a `/scan` route.

- **Two new GET endpoints in `Code.gs`** (both uncached — folder
  contents are dynamic, and per-image payloads exceed the 100 KB
  CacheService per-key limit anyway):
  - `getDrivePhotos?folderId=<id>` — lists every image file inside the
    folder via `DriveApp.getFolderById(id).getFiles()`, filtering by
    `mimeType.startsWith("image/")`. Returns `{folderName, count,
    data: [{id, name, mimeType, thumbnailUrl}]}` with thumbnail URLs
    in the v6 contract (`drive.google.com/thumbnail?id=…&sz=w800`).
    Photos are sorted lexicographically so burst sequences land in
    capture order. The whole iteration is try-catch isolated; a
    single corrupt / permission-denied file is logged and skipped
    without aborting the batch.
  - `getImageBytes?fileId=<id>` — streams a single Drive image as
    base64. Required because the thumbnail URL 302-redirects to
    `lh3.googleusercontent.com`, which does NOT send CORS headers —
    an `<img crossOrigin>` either errors out or taints the canvas
    (`getImageData()` then fails for face-api / Tesseract). Returns
    `{fileId, mimeType, sizeBytes, base64}`. Frontend wraps it in a
    `data:` URL, which is same-origin by definition and never taints.

- **New `templates/photo_scanner.html` (`/scan`)** — the scanner UI.
  Folder ID input + CP selector + Start/Stop, with a live preview
  canvas that renders each photo at native resolution with green/red
  detection rectangles drawn over recognized faces. Sidebar log
  shows per-photo events (✅ recorded / 🔴 violation / ♻️ dup
  suppressed / ⏭️ skipped / ❌ error). Pipeline:
  - **`ssdMobilenetv1`** instead of TinyFaceDetector — better recall
    on multi-runner 4K photos; the 5× FPS hit doesn't matter when
    per-photo wall time is bounded by network + base64 decode.
  - **No EMA, no majority vote, no Ghost-BIB counter** — none of
    these apply when each runner is seen exactly once per photo.
  - **Same `getOCRCropBox` geometry and `preprocessForOCR` pipeline**
    (grayscale → adaptive threshold → 2× NN upscale) as
    `checkpoint.html`, intentionally duplicated to keep the
    Tesseract-tuned constants Guardrail 19 + 24 protect identical
    between live and scanner targets.
  - **Three dedup sets** in JS state (`seenRecords`,
    `seenViolations`, `seenUnknownsPerPhoto`) suppress duplicates
    from burst photography within one scan session; reset on every
    Start press.
  - **Reuses the existing `recordCheckpoint` / `reportViolation` POST
    contracts** unchanged — the backend doesn't care whether the
    source is a live camera or a Drive scan. Violation types fired:
    `WRONG_PERSON`, `MULTIPLE_BIBS`, `UNREGISTERED`. `NO_BIB` /
    `OBSCURED_BIB` are NOT fired (they require the consecutive-
    failure counter the live page maintains).
  - **Timestamps are scan-time HH:MM:SS, not photo capture time** —
    no EXIF parsing is implemented. Acceptable because relative
    ordering is what the leaderboard needs, and most use cases for
    the scanner are post-race verification rather than time-of-day
    scoring.

- **Two new guardrails (#27, #28)** — pinned the scanner's
  deliberate divergence from `checkpoint.html` (different CV
  pipeline, on purpose) and the CORS reason `getImageBytes` exists.

- **`web_app.py`** gains `/scan` → `photo_scanner.html`. No other
  routes touched.

##### 2026-05-17 (same-day follow-up) — `/checkpoint` route retired, dashboard nav refreshed

Live-camera mode is no longer reachable from the UI; the Drive
Scanner replaces it as the daily-action page. Surgical change set:

- **`web_app.py`** — the `@app.route('/checkpoint')` handler is
  **commented out** (not deleted) with a dated header noting why and
  how to reverse. `templates/checkpoint.html` stays on disk — the
  file remains the canonical reference for the multi-frame pipeline
  documented in §4.2, and re-enabling live mode is one uncomment
  away.
- **`templates/dashboard.html`** — the nav `<a href="/checkpoint">`
  is removed; a new `<a href="/scan" class="nav-btn primary">` is
  added in its place. The Register / Scanner / Admin nav controls
  now share a unified `.nav-btn` class (consistent padding, border,
  hover); the Scanner gets a `.primary` modifier (brand gradient,
  subtle shadow) so it visually reads as the primary CTA. Replaces
  the previous `.nav-link` (tiny anchor) + `.btn-admin` (chunky
  button) mismatch. The `#btn-admin-toggle` ID is preserved so the
  existing post-login hide logic still works.
- **`templates/register.html`** and **`templates/photo_scanner.html`**
  — both had nav links pointing at `/checkpoint` left over from the
  earlier layout. Re-pointed to `/scan` and `/register` respectively
  so no nav link 404s.

Reversibility: uncomment the route in `web_app.py`, add the link
back to `dashboard.html` (any class works — `.nav-btn` keeps it
consistent), and live mode is back. The backend never knew about
`/checkpoint` (it's a frontend-only route).

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
  when navigating away from `/register` (and, if you re-enable the
  route, `/checkpoint`). Re-entering the page restarts the camera.
  `/scan` has no camera — it processes Drive images, not webcam
  frames.
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
- **Drive Scanner timestamps are scan-time, not capture-time**: the
  scanner's `recordCheckpoint` POSTs use `new Date()` at the moment
  the POST is built. EXIF capture time is NOT extracted — adding it
  would need a base64-EXIF parser and fallback logic for stripped
  metadata. For most workflows the relative ordering across photos
  is what the leaderboard needs, so scan-time is fine.
- **Drive Scanner dedup is session-scoped, not backend-enforced**:
  the three `seen…` sets live in browser memory. If the operator
  reloads the page mid-batch and restarts, runners detected before
  the reload will record again (the backend writes a duplicate row).
  Admins clean those up via the dashboard bulk-delete tools. No
  cross-tab coordination — two operators scanning the same folder
  simultaneously will write duplicate rows.
- **Drive Scanner can't change CP mid-batch**: the CP buttons disable
  themselves while a scan is running. Splitting one folder across
  multiple CPs requires running the scan once per CP (or organizing
  Drive folders per checkpoint, which is the recommended layout).
- **Drive Scanner does NOT fire `NO_BIB` or `OBSCURED_BIB`**: those
  violations require the `ocrFailureCount` consecutive-failure
  counter that `checkpoint.html` maintains across many frames of the
  same runner. The scanner sees each runner exactly once per photo,
  so a single failed OCR can't escalate. A photo where the BIB is
  unreadable simply produces no record / no violation for that
  runner. Operators should re-shoot or manually update via the
  admin UI.
- **Drive Scanner skips images larger than ~6 MB per Apps Script
  response cap**: `getImageBytes` returns base64 in a JSON envelope.
  The Apps Script doGet response limit is ~50 MB, but in practice
  network-decode latency for >10 MB images makes the scanner crawl.
  No hard cap is enforced in code; operators with massive RAW files
  should pre-export to JPEG/HEIC.

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
| Action | Returns | Notes |
|---|---|---|
| `getRunners` | All `Runners` rows | Cached, 12 s TTL |
| `getResults` | All `Results` rows | Cached, 12 s TTL |
| `getViolations` | Top 20 violations (Timestamp desc) | Cached, 12 s TTL |
| `getVerifiedViolations` | Top 20 with `Verified=true` | Cached, 12 s TTL |
| `getDrivePhotos` | `{ folderName, count, data: [{id, name, mimeType, thumbnailUrl}] }` | Requires `folderId=<id>`. **Uncached** — folder contents change as photographers add shots. Image files only (filtered by mimeType). Sorted by name. Drive errors mapped to `not_found` / `drive_error`. |
| `getImageBytes` | `{ fileId, mimeType, sizeBytes, base64 }` | Requires `fileId=<id>`. **Uncached** — per-file payload exceeds the 100 KB CacheService per-key cap. Returns the full file bytes so the scanner can decode them into a same-origin `data:` URL for canvas inference (Guardrail 28). |

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
| `OCR_MIN_CONFIDENCE` | `60` (field-test; nominal `70`) | Tesseract overall-confidence floor |
| `BIB_MIN_LEN` / `BIB_MAX_LEN` | `1` / `6` (field-test; nominal `2` / `5`) | Accepted BIB length range |
| `OCR_VOTE_BUFFER_SIZE` | `5` | Rolling buffer of recent valid reads |
| `OCR_VOTE_MIN_CONSENSUS` | `3` | Reads-in-agreement required for consensus |

#### `checkpoint.html` — advanced violation triggers
| Constant | Default | Effect |
|---|---|---|
| `NO_BIB_AFTER_FAILURES` | `5` | Consecutive validation-gate failures before firing `NO_BIB` (empty OCR) or `OBSCURED_BIB` (text but bad length / conf) |
| `UNREGISTERED_AFTER_FRAMES` | `15` | Consecutive frames an unrecognized face must stay visible before firing `UNREGISTERED` |
| `MULTIPLE_BIBS_MIN_BLOCK_LEN` | `2` | Minimum digits per block for a Tesseract chunk to count as a candidate BIB |
| `MULTIPLE_BIBS_MIN_BLOCKS` | `2` | Minimum distinct candidate blocks in a single frame to fire `MULTIPLE_BIBS` |

#### `dashboard.html`
| Constant | Default | Effect |
|---|---|---|
| `POLL_RESULTS_MS` | `5000` | Leaderboard refresh |
| `POLL_VIOLATIONS_MS` | `10000` | Public alerts refresh |
| `POLL_ADMIN_MS` | `15000` | Admin tables refresh |
| `DISMISSED_MAX` | `500` | FIFO cap on dismissed-alert memory |

#### `photo_scanner.html` — Drive scanner
| Constant | Default | Effect |
|---|---|---|
| `SSD_MIN_CONFIDENCE` | `0.5` | `SsdMobilenetv1Options.minConfidence` — minimum face-score for a detection to count |
| `FACE_MATCH_DISTANCE` | `0.45` | `findBestMatch` threshold — same as live page; lower = stricter |
| `OCR_MIN_CONFIDENCE` | `60` | Single-pass Tesseract confidence floor (no field-test override here — static high-res photos give clean reads) |
| `BIB_MIN_LEN` / `BIB_MAX_LEN` | `1` / `6` | Accepted BIB length range for the validation gate |
| `ADAPTIVE_THRESHOLD_BLOCK` | `15` | Local-window size for adaptive threshold (mirror of `checkpoint.html`) |
| `ADAPTIVE_THRESHOLD_C` | `10` | Mean offset (mirror of `checkpoint.html`) |
| `OCR_UPSCALE` | `2` | Nearest-neighbor scale factor before OCR (mirror of `checkpoint.html`) |
| `MULTIPLE_BIBS_MIN_BLOCK_LEN` | `2` | Minimum digits per block — same shape check as the live page (Guardrail 26: run on RAW Tesseract text) |
| `MULTIPLE_BIBS_MIN_BLOCKS` | `2` | Minimum distinct candidate blocks to fire `MULTIPLE_BIBS` |

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
