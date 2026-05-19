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
> **Last updated:** 2026-05-20 — Public leaderboard gains a
> Status column. The 5-col layout is now `# | ชื่อ | BIB |
> สถานะ | Verified At`. The Status cell reads
> `String(r.IsCheating || "").toLowerCase() === "true"` and
> renders `🚨 Cheating` (red) on match, `✅ Clear` (green)
> otherwise. Empty `IsCheating` (never flagged) and explicit
> `"false"` both render as Clear — only the literal string
> `"true"` triggers the cheating badge. The leaderboard polls
> at 5 s (`POLL_RESULTS_MS`), so a fresh WRONG_PERSON fire
> flips the badge within one poll cycle of the scanner's
> markCheating POST landing.
>
> **Last updated:** 2026-05-20 — Drive Scanner now emits
> `photoFileId` + `detectionBoxes` on every `reportViolation`
> POST, and queues a `markCheating(name, isCheating=true)` POST
> after every successful WRONG_PERSON fire. The detection-box
> array is built in `processPhotoWithBytes` after categorization
> but BEFORE OCR (Guardrail 31): one green entry per matched
> face (`"Name: <name>"`), one orange entry per reported unknown
> (`"Not in system"`). In `handleKnownFace`, the WRONG_PERSON
> branch additionally pushes a red chest-region entry derived
> from `getOCRCropBox(box, canvas)` with label `"BIB found: X |
> Registered: Y"` BEFORE calling fireViolation. Each fireViolation
> call attaches a `.slice()` snapshot of the array so later
> mutations don't leak into the already-queued POST. `fireViolation`
> now returns `true` on fire / `false` on dedup-suppressed; the
> WRONG_PERSON path uses the boolean to decide whether to queue
> the markCheating follow-up (skipping the queue on dedup hits
> avoids quota-wasting re-writes — though markCheating itself is
> idempotent). The markCheating POST routes through the same
> `enqueueThrottledPost` serial queue per Guardrail 30 — the
> 150 ms gap is preserved regardless of how many WRONG_PERSON
> fires the scan produces. Documented explicitly: both
> directions of cheating mismatch (Face ≠ Registered BIB AND
> BIB ≠ Registered Face) collapse onto the existing WRONG_PERSON
> path, because `expectedBib = runnerRegistry[name]` is keyed off
> the FACE match — so either direction surfaces as
> `expectedBib !== readBib`. No new violation type is needed.
>
> **Last updated:** 2026-05-20 — Two new POST actions:
> `markCheating` (unauthenticated, scanner-called) and
> `updateRunnerPhoto` (admin-gated). `markCheating` writes
> `"true"` / `"false"` to `Results.IsCheating` for the named
> runner — inserts a minimal row if the runner has no Results
> row yet. Distinct from the `photo_verified` sentinel
> (Guardrail 29 sibling): the sentinel writes Name + BibNumber +
> UpdatedAt without touching IsCheating; `markCheating` writes
> IsCheating without touching the others. The scanner queues a
> `markCheating(name, isCheating=true)` POST through the same
> `enqueueThrottledPost` serial queue after every successful
> WRONG_PERSON fire (Guardrail 30 invariant preserved).
> `updateRunnerPhoto` accepts `{token, name, angle,
> photoBase64, mimeType?}`; angle must be one of
> front/top/bottom/left/right. Trashes the existing Drive file
> for that angle (try-catch isolated per Guardrail 2), uploads
> the new image via `saveBase64Image` into
> `RunnerFaces/<name>/YYYY-MM-DD/`, and rewrites the
> `Photo_<Angle>` cell with the new thumbnail URL.
> Invalidates the runners cache. Admin Runners tab UI for both
> operations lands in Unit 7.
>
> **Last updated:** 2026-05-20 — Admin can now rename a runner
> via a new `renameRunner` POST action, and `editRunnerProfile`
> accepts an optional `email` field. The rename is a cascade
> across Runners.Name (single cell), Results.Name (every
> matching row), Violations.Name (every matching row — the only
> place in the codebase that mutates Violations.Name; renaming
> is conceptually distinct from deletion, which deliberately
> preserves the audit trail), and the Drive folder
> `RunnerFaces/<name>` (DriveApp `.setName(newName)` wrapped in
> a try-catch per Guardrail 2 so Drive failure does not block
> the sheet writes). All three caches are invalidated. Pre-
> existing safeguards: reject if `oldName === newName` or if
> `newName` already exists in Runners (avoids accidentally
> merging two identities). `editRunnerProfile` now accepts
> `email` alongside `bib`; both are independently optional —
> the inline editor on the admin Runners tab posts whichever
> field changed. Email is validated against the existing
> `EMAIL_PATTERN`; empty string clears the cell. Email is
> intentionally NOT propagated to Results — Results carries
> only identity/verification cells.
>
> **Last updated:** 2026-05-20 — Violations sheet gains two
> evidence columns: `PhotoFileId` (Drive file ID of the source
> photo) and `DetectionBoxes` (JSON-stringified array of
> `{x, y, width, height, label, color}` from the scanner's face
> detection pass). Both are appended to the right of existing
> columns per Guardrail 15; new `_migrateViolationsPhotoColumns()`
> helper backfills them with blank defaults on pre-migration
> sheets (run once from the Apps Script editor). The dashboard
> evidence modal — when the admin clicks a violation row — reads
> these two fields, fetches image bytes via `getImageBytes`
> (Guardrail 28; never the thumbnail URL against a canvas),
> draws the photo onto a canvas at native resolution, and
> overlays each detection box with its label. Legacy rows (no
> PhotoFileId) get a "No source photo available" placeholder.
> `handleReportViolation` reads `body.photoFileId || ""` and
> `body.detectionBoxes ? JSON.stringify(body.detectionBoxes) : ""`
> via the existing header-mapped write, so pre-migration sheets
> silently drop the new fields without erroring — same
> tolerance pattern as the ViolationType v5 migration.
>
> **Last updated:** 2026-05-20 — Results schema stripped to the
> 4-column identity-verification shape (`Name | BibNumber |
> UpdatedAt | IsCheating`). The 7 timing columns (`Start_Time`,
> `CP1-4_Time`, `Finish_Time`, `Total_Duration`) are gone — the
> Drive Scanner has no timing role, so the columns were dead
> weight that rendered as `-` everywhere they were displayed.
> New helper `_migrateResultsSchema()` (run once from the Apps
> Script editor) deletes the timing columns and appends
> `IsCheating` with blank defaults; idempotent. `IsCheating` is
> `"true"` when WRONG_PERSON has fired for this runner (set by
> the soon-to-be-added `markCheating` POST action), `"false"` if
> explicitly cleared, or `""` (which renders as ✅ Clear on the
> leaderboard). `_recordPhotoVerification` writes `IsCheating=""`
> on insert and leaves it alone on update — a previously flagged
> runner stays flagged across re-verifications. `handleUpdateRunner`
> is now a deprecation stub: the timing columns it used to edit
> no longer exist, so it returns
> `{status:"error", code:"deprecated", message:"updateRunner is
> no longer supported"}`. The function shell is kept so the
> `doPost` dispatcher still routes the action and any legacy
> client gets a clear response rather than a cryptic
> `schema_error`. Sheet creation now formats columns C:D as
> plain text (`@`) — both `UpdatedAt` (ISO string) and
> `IsCheating` (literal "true"/"false") would otherwise be
> auto-coerced by Sheets.
>
> **Last updated:** 2026-05-19 — Drive Scanner gains a
> **High-Performance Local Mode**. `templates/photo_scanner.html`
> now (a) explicitly pins TF.js to the `webgl` backend before model
> load (`await faceapi.tf.setBackend('webgl'); await faceapi.tf.ready();`,
> with a CPU fallback) so the local GPU does the inference, and
> (b) processes photos concurrently via a semaphore worker pool
> (`SCAN_CONCURRENCY = 4` in flight at all times) instead of the
> prior single-flight prefetch-by-1 sequential loop. All
> `recordCheckpoint` and `reportViolation` POSTs are now funneled
> through a single serial 150 ms-throttled queue
> (`enqueueThrottledPost`) so concurrency does NOT multiply the
> outbound POST burst rate — the per-user Apps Script URL-fetch
> quota guard is preserved exactly. `web_app.py` flips its dev
> server to `threaded=True` so multiple browser tabs / template
> fetches don't serialize through one worker. As a same-day
> follow-up the inline script also monkey-patches
> `HTMLCanvasElement.prototype.getContext` at module-load time to
> default every `'2d'` context to `{ willReadFrequently: true }`,
> silencing Chrome's "Multiple readback operations using
> `getImageData` are faster with the `willReadFrequently`
> attribute set to true" warning and steering both face-api's
> internal scratch canvases AND our OCR preprocess canvases onto
> the CPU-backed-buffer fast path. The patch is a no-op for
> `'webgl'` contexts, so TF.js inference is untouched. Backend,
> Apps Script contracts, sheet schemas, and all model versions
> are unchanged. New Guardrail #30 pins the serial-queue
> invariant.
>
> Same-day follow-up (detection selectivity): `SSD_MIN_CONFIDENCE`
> raised from `0.5` → `0.7` and a new `MIN_FACE_SIZE = 60` px gate
> added in `photo_scanner.html` after operator-reported false
> positives on an advertising banner (`image_2.png`) plus a wave of
> tiny deeply-out-of-focus background detections cluttering the
> `UNREGISTERED` log. Both gates apply BEFORE face matching, OCR,
> and `UNREGISTERED` reporting — they short-circuit downstream cost
> as well as suppressing the noise. The detection result loop now
> reads from a `detections = rawDetections.filter(...)` variable;
> downstream code is unchanged because the filtered array keeps the
> original variable name. Detector choice stays SSD MobileNet
> (Guardrail 27 unchanged); this is a tuning change, not a new
> architectural invariant, so no new Guardrail. Values can be
> dialled down (0.65 / 50 px) if a real foreground runner is ever
> seen falling through both gates.
>
> Same-day revert (concurrency = 1 + crop-before-draw): operator
> reported severe correctness regressions from the HPLM
> `SCAN_CONCURRENCY = 4`. Image 1: face-api hallucinating faces on
> empty space / text. Image 2: violation crops saved to Drive
> showing pure black, wrong body parts (legs instead of face), and
> red "Unknown" UI bounding boxes baked into the saved pixels.
> Root cause is two-fold: (a) `#preview-canvas` is a shared DOM
> element, so concurrent `processPhotoWithBytes` tasks raced on
> `canvas.width = …; drawImage(…)` and read each other's pixels
> mid-detection; (b) `drawDetectionBox` was painted on that canvas
> BEFORE `runOCRForFace` / `cropToDataUrl` read back from it, so
> even at concurrency=1 the UI overlays would be baked into every
> violation crop and the green name label would corrupt the chest
> region Tesseract sees. Fixes: `SCAN_CONCURRENCY` reverted to
> `1`; `processPhotoWithBytes` reordered so categorization is
> followed by ALL crops + OCR on the still-clean canvas, with UI
> overlays painted in a final pass for operator feedback only.
> Semaphore worker pool, `enqueueThrottledPost` queue, WebGL
> backend pin, `willReadFrequently` canvas patch, and Flask
> `threaded=True` all kept — orthogonal to these bugs. New
> Guardrail #31 pins the crop-before-draw invariant. Operator's
> explicit trade: *"make it more accurate, it can be slower."*
>
> Same-day follow-up (OCR recall): operator hit a false `NO_BIB`
> on a tight-portrait photo with a massive, legibly-printed BIB
> "4532". Root cause was the 2026-05-17 audit-era
> `OCR_MIN_CONFIDENCE = 80` — too strict for browser Tesseract,
> which on a 2× upscaled adaptive-threshold crop typically scores
> printed BIBs in the **60s–70s**, never above 80. Lowered to
> `65`; the audit-era false-positive path (sponsor-logo "S2 3X"
> → "23" at conf=75) is now blocked instead by the unchanged
> `BIB_MIN_LEN = 2` plus the 2026-05-19 detection-side gates
> (`SSD_MIN_CONFIDENCE = 0.7`, `MIN_FACE_SIZE = 60`). Also widened
> `getOCRCropBox` factors from `0.5/0.6/1.0/3.0` to
> `0.7/0.5/1.4/3.0` of faceH (wider horizontal padding for off-
> center BIBs on shoulder-strap vests; higher top edge for tight-
> portrait BIBs that hug the chin) and mirrored the change into
> `templates/checkpoint.html` per Guardrail 27 — both files move
> in lockstep. Added a DEBUG-only dashed-blue chest-box overlay
> (`?debug=1`) in the Guardrail #31 post-crop UI pass so the
> operator can visually confirm exactly which region Tesseract
> sees per face. No new Guardrails — tuning only.
>
> Same-day follow-up (violation crops removed entirely): operator
> directed *"เราจะไม่ตัดรูปอีกเเล้ว"* ("we won't crop images
> anymore"). The four `fireViolation` call sites (UNREGISTERED,
> MULTIPLE_BIBS, NO_BIB, WRONG_PERSON) no longer attach an `image`
> field, and the `cropToDataUrl` helper has been deleted from
> `templates/photo_scanner.html`. `reportViolation` payloads now
> carry metadata only (`name` / `bib` / `message` / `violationType`
> / `timestamp`). The backend was already tolerant —
> `apps_script/Code.gs` line ~1007 reads `body.image || ""` and
> skips the Drive upload when empty, leaving the Violations
> sheet's `ImageUrl` column blank for new rows. No backend or
> schema change; existing violation rows keep their saved
> `ImageUrl` values, only new rows are imageless. The DEBUG
> dashed-blue chest-box overlay survives (preview-only, never was
> sent over the wire). Guardrail #31 is partially superseded —
> its "violation crops" clause is now moot since no crops are
> generated; the OCR clean-canvas clause is the only load-bearing
> half. The guardrail body is annotated to reflect this so a
> future reintroduction of image saving still has the design
> wisdom captured.
>
> Same-day follow-up (recall floor lowered further): operator
> reported *"เอา 60px ออก เเละมันยังอ่าน bib ไม่ได้"* ("remove the
> 60px and BIB still can't be read"). Two changes: (a)
> `MIN_FACE_SIZE` disabled — set from `60` to `0`. The size gate
> was filtering out borderline-small faces the operator wanted
> processed; banner hallucinations are now blocked primarily by
> `SSD_MIN_CONFIDENCE = 0.7`. (b) `OCR_MIN_CONFIDENCE` lowered
> further: `65 → 50`. Browser Tesseract on adaptive-threshold
> crops with slight blur or stylized fonts can dip into the 50s;
> 65 was still over-rejecting legibly-printed BIBs. 50 is near the
> floor of useful Tesseract output. Short-graphic false-positive
> defense relies on `BIB_MIN_LEN = 2` (unchanged) and the face
> match. Both knobs are tuning, not architecture — no guardrail
> change.
>
> **Last updated:** 2026-05-18 — Drive Scanner pivots from "timing"
> to "identity verification" and lands a four-bundle audit-fix pass.
> The checkpoint selector (START / CP1-4 / FINISH) is gone; the
> scanner now answers a single question per photo — *who is in this
> photo, and are they wearing the correct BIB?* — and persists each
> unique identification at most once per session. The scanner POSTs
> `recordCheckpoint` with a new `checkpoint_id: "photo_verified"`
> sentinel; `handleRecordCheckpoint` short-circuits to
> `_recordPhotoVerification`, which writes only `BibNumber` +
> `UpdatedAt` (no CP_Time column). All existing CP-aware behavior
> (start / 1-4 / finish) is unchanged. New Guardrail #29 pins the
> sentinel semantics. Same-day audit hardening: `getDrivePhotos`
> gains pagination + a strict mimeType allow-list; scanner OCR gates
> tightened (conf 60→80, BIB_MIN_LEN 1→2); ALL unknown faces per
> photo are now reported (capped at 15); localStorage persistence
> makes interrupted scans resumable; per-POST throttle + image-bytes
> prefetch-by-1 give quota safety and ~2× throughput on large folders.
> Same-day follow-up: admins can now edit a runner's BIB inline from
> the dashboard Runners tab — new `editRunnerProfile` POST endpoint
> (BIB-only; Name remains read-only because it's the primary key +
> foreign-keyed to Results/Violations/Drive folder paths). Public
> leaderboard simplified to match the pivot: timing columns
> (Start/CP1-4/Finish/Total_Duration) dropped from the `🏁 LEADERBOARD`
> table, replaced with a single `Verified At` column sourced from
> `UpdatedAt`; sort is now most-recently-identified first. Admin
> Runners tab intentionally keeps its CP-time columns.
>
> Same-day follow-up (strict `NO_BIB`): the Drive Scanner now fires
> `NO_BIB` on a single-shot basis whenever a known face yields an
> empty/invalid OCR read. Previously the scanner silently fell back
> to the registered BIB and logged a false-positive `✅` identification
> against photos that had no BIB at all (caught while testing against
> the runner-registration photo folders). Now an empty `readBib` (no
> digits, OR failing the `BIB_MIN_LEN` / `OCR_MIN_CONFIDENCE` gate)
> blocks `sendIdentification` entirely and fires a `NO_BIB` violation
> instead, deduplicated per-runner-per-session via key `"name:NO_BIB"`.
> The `MULTIPLE_BIBS` check moved above `sendIdentification` in the
> same pass so multi-BIB photos no longer log a phantom `✅` before
> their violation fires. `OBSCURED_BIB` remains scanner-excluded:
> the static-photo pipeline still doesn't distinguish empty-text
> from bad-text/conf, so both collapse to `NO_BIB`.
>
> Earlier in the v7 cycle (2026-05-17): added GET endpoints
> `getDrivePhotos` + `getImageBytes`, created `templates/photo_scanner.html`
> (`/scan`), retired the `/checkpoint` route (file kept on disk),
> refreshed the dashboard nav with a primary Scanner CTA. Backend
> remains v7; the scanner pivot is frontend + a single
> backend-handler short-circuit.

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

**`Results`** — one row per runner identified by the Drive Scanner.
```
Name | BibNumber | UpdatedAt | IsCheating
```
- `Name` is the foreign key to `Runners.Name`. `BibNumber` is the
  runner's registered BIB at identification time. `UpdatedAt` is
  the ISO timestamp of the most recent identification POST. The
  scanner has no timing role (post-2026-05-18 pivot) so there are
  no CP_Time columns.
- `IsCheating` is `"true"` when WRONG_PERSON has fired for this
  runner this event (set by the `markCheating` POST action — see
  §6.7), `"false"` if an admin explicitly cleared the flag, or
  `""` for never-flagged runners. The public leaderboard renders
  `"true"` as 🚨 Cheating and everything else as ✅ Clear.
- Columns C:D (`UpdatedAt` + `IsCheating`) are forced to plain-text
  format (`@`) on sheet creation — Sheets would otherwise parse the
  ISO timestamp as a Date and coerce literal `"true"`/`"false"`
  strings to boolean cell types (breaking the leaderboard's
  string predicate).
- **Pre-2026-05-20 sheets** carry the old 10-column shape
  (`Name | BibNumber | Start_Time | CP1-4_Time | Finish_Time |
  Total_Duration | UpdatedAt`). Run `_migrateResultsSchema()` once
  from the Apps Script editor to strip the timing columns and
  append `IsCheating` with blank defaults (see §6.6).

**`Violations`** — one row per detected anomaly.
```
ID | Name | BibNumber | Message | ImageUrl | Timestamp
| Verified | VerifiedAt | ViolationType
| PhotoFileId | DetectionBoxes
```
- `ID` format: `"V" + Date.now()` (e.g. `V1714827234567`). Validated by
  `ID_PATTERN = /^V\d{10,}$/`.
- `ViolationType` is one of `NO_BIB`, `WRONG_PERSON`, `UNREGISTERED`,
  `MULTIPLE_BIBS`, `WRONG_ROUTE`, `OBSCURED_BIB`, `OTHER`. Empty
  defaults to `WRONG_PERSON` (matches `DEFAULT_VIOLATION_TYPE`).
- `PhotoFileId` — Drive file ID of the source photo the scanner was
  processing when this violation fired. Used by the dashboard
  evidence modal to fetch the original bytes via `getImageBytes`
  and draw them onto a canvas (Guardrail 28). Empty for legacy
  rows; the modal renders a placeholder in that case.
- `DetectionBoxes` — JSON-stringified array of detection-box entries.
  Each entry: `{x, y, width, height, label, color}`. `color` is
  `"green"` (matched known face), `"red"` (BIB mismatch — also
  used for the chest-region crop when WRONG_PERSON fires), or
  `"orange"` (UNREGISTERED unknown face). Empty for legacy rows.
  Run `_migrateViolationsPhotoColumns()` once after deploying
  the 2026-05-20 evidence pass to append these two columns to
  any pre-migration sheet.

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
| Public leaderboard | `getResults` | **5 s** | `POLL_RESULTS_MS`. Post-2026-05-20 the table renders 5 cols: `# / Name / BibNumber / Status / UpdatedAt`. Status reads `r.IsCheating`: literal `"true"` → 🚨 Cheating; anything else → ✅ Clear. UpdatedAt is formatted via `formatVerifiedAt` as "YYYY-MM-DD HH:MM:SS". Sort by UpdatedAt desc; empty UpdatedAt sorts last. |
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

A **post-race identity-verification** tool. The scanner is NOT a
timing gate — it answers a single question per photo:
*who is in this photo, and are they wearing the correct BIB?* The
checkpoint selector that earlier versions had (START / CP1-4 /
FINISH) is gone — there is no CP. Each unique runner is identified
at most once per scanning session, regardless of how many burst
shots the photographer took. Violations (`WRONG_PERSON`,
`MULTIPLE_BIBS`, `UNREGISTERED`) continue to fire because catching
mismatches is the remaining reason the scanner writes to the
backend at all.

Photographers dump event photos into a shared Drive folder; an
operator opens `/scan`, pastes the folder ID, presses Start. The
browser pulls each photo through Apps Script, runs SSD MobileNet +
Tesseract, and emits POSTs:

- `recordCheckpoint` — with the **`checkpoint_id: "photo_verified"`
  sentinel** (Guardrail 29). The backend short-circuits to
  `_recordPhotoVerification`, which writes the runner's `Name` +
  `BibNumber` + `UpdatedAt` to the Results sheet **without touching
  any CP_Time column**. Fired once per runner per session.
- `reportViolation` — fires when face matches a runner but OCR
  returns a different BIB (`WRONG_PERSON`), when multiple distinct
  BIB blocks appear on one chest (`MULTIPLE_BIBS`), or when no face
  match exists (`UNREGISTERED`). Since 2026-05-20 the payload also
  carries `photoFileId` (Drive ID of the source photo) and
  `detectionBoxes` (JSON-stringified by the backend) so the
  dashboard evidence modal can redraw the original photo with the
  same color-coded overlays the admin would have seen live.
- `markCheating` — queued after every fresh WRONG_PERSON fire
  (skipped on dedup). Writes `Results.IsCheating = "true"` for the
  named runner so the public leaderboard's Status column flips to
  🚨 Cheating on the next 5 s poll. Routes through
  `enqueueThrottledPost` so Guardrail 30's serial-queue invariant
  is preserved (the 150 ms gap applies to markCheating too).

**Two cheating-detection directions, same path.** A `WRONG_PERSON`
fires when the face match identifies runner A in the photo but the
OCR'd BIB belongs to a different registered runner B
(*Face ≠ Registered BIB*). The opposite framing — *BIB ≠ Registered
Face*, where the OCR reads BIB X but the face attached to that BIB
in the Runners sheet isn't the face the scanner sees — manifests
identically in the code: `expectedBib = runnerRegistry[name]` is
keyed off the FACE match's `name`, so either direction of mismatch
collapses to the same `expectedBib !== readBib` predicate. No
separate violation type or trigger is needed. The evidence boxes
make the direction visible to the admin: the green "Name: X" box
sits on the matched face; the red "BIB found: Y | Registered: Z"
box sits over the chest region where the OCR ran.

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
  // 1) Paginated listing — loop on hasMore so a 5000-photo folder
  //    doesn't time out a single Apps Script request.
  offset = 0; allPhotos = []
  loop:
    GET /?action=getDrivePhotos&folderId=<id>&offset=<n>&pageSize=500
      → { data: [{id, name, mimeType, thumbnailUrl}], hasMore,
          nextOffset, skipped }
    allPhotos = allPhotos.concat(data)
    if !hasMore: break
    offset = nextOffset

  // 2) Resume check — if localStorage has saved dedup state for
  //    this folderId (24-hour TTL), prompt the operator. Resume →
  //    rehydrate seenRecords + seenViolations; Discard → clear.
  if loadScanState(folderId):
    decision = await promptResume(...)
    if "resume": seenRecords/seenViolations populated from storage
    else:        clearScanState(folderId)

  // 3) Prefetch-by-1 sequential loop — photo i+1's bytes fetch
  //    starts BEFORE photo i's inference runs, ~2× throughput.
  nextBytesPromise = fetchImageBytes(allPhotos[0])
  for i in 0..allPhotos.length (Stop button aborts the loop):
    bytesPayload = await nextBytesPromise
    nextBytesPromise = fetchImageBytes(allPhotos[i + 1])   ← prefetch
    processPhotoWithBytes(allPhotos[i], bytesPayload):
      decode → <img> → draw to preview canvas at native resolution
      detectAllFaces(canvas, SsdMobilenetv1Options{minConfidence:0.7})
        .withFaceLandmarks().withFaceDescriptors()
      drop detections with box.width<MIN_FACE_SIZE OR box.height<MIN_FACE_SIZE   ← size gate (banner/background noise)

      for each detection:
        match = faceMatcher.findBestMatch(descriptor)
        isKnown = match.label !== "unknown" AND match.distance ≤ FACE_MATCH_DISTANCE
        categorize: knownHits[] or unknownHits[]   ← ALL unknowns kept
                                                     (NO drawing yet — Guardrail #31)
      reportedUnknowns = unknownHits.sort(by area desc).slice(0, MAX_UNKNOWNS_PER_PHOTO)
      ── Build detectionBoxes (after categorization, before OCR) ──
      detectionBoxes = []
      for each knownHit:        push {box, label: "Name: <name>",     color: "green"}
      for each reportedUnknown: push {box, label: "Not in system",    color: "orange"}
      ── OCR runs here, while canvas is still CLEAN ──
      for each knownHit: handleKnownFace(canvas, hit, photo, detectionBoxes)
        → OCR + MULTIPLE_BIBS/NO_BIB/WRONG_PERSON violations
        → on WRONG_PERSON, push {chestBox, label: "BIB found: X | Registered: Y", color: "red"} into detectionBoxes
        → fireViolation snapshots detectionBoxes.slice() into the POST body
        → if WRONG_PERSON fired (not dedup'd), enqueue markCheating(name, true) via enqueueThrottledPost
      for each reportedUnknown:
        fireViolation UNREGISTERED with photoFileId + detectionBoxes.slice()
      ── ONLY NOW: paint UI overlays for operator feedback ──
      for each knownHit:    drawDetectionBox(ctx, hit.box, hit.name,   isViolation=false)
      for each unknownHit:  drawDetectionBox(ctx, u.box,   "Unknown",  isViolation=true)

    ── OCR FIRST (single read per face, NO majority vote) ──
    getOCRCropBox(box, canvas) → {bx, by, bw, bh}
        bx = box.x - 0.7·faceH    ← widened 2026-05-19
        by = box.y + 0.5·faceH    ← higher (was 0.6) to catch chin-level BIBs
        bw = box.width + 1.4·faceH  ← wider (was 1.0) for off-center BIBs
        bh = 3.0·faceH              ← unchanged
        (mirrored in checkpoint.html per Guardrail 27)
    preprocessForOCR(crop):
      grayscale (BT.601) → integral image →
      adaptive threshold (mean − ADAPTIVE_THRESHOLD_C,
                          ADAPTIVE_THRESHOLD_BLOCK² window) →
      nearest-neighbor 2× upscale
    {text, conf} = tesseractWorker.recognize(processed)
    validate: BIB_MIN_LEN ≤ digits ≤ BIB_MAX_LEN AND conf ≥ OCR_MIN_CONFIDENCE (= 65)
    readBib       = digits-only normalized text (or "" if fails validation gate)
    multipleBibs  = RAW text \d{MULTIPLE_BIBS_MIN_BLOCK_LEN,}+ blocks
                    if count ≥ MULTIPLE_BIBS_MIN_BLOCKS, else null

    ── per-known-hit pipeline (violations BEFORE identification) ──
    for each known hit:
      // 1) MULTIPLE_BIBS — fires first because it also makes readBib
      //    empty; running it before NO_BIB keeps the two distinct.
      if multipleBibs:
        fireViolation MULTIPLE_BIBS
          (dedup key "name:MULTIPLE_BIBS:" + multipleBibs.join(","))
        continue

      // 2) NO_BIB — strict single-shot. Empty readBib (no digits OR
      //    failing the length/conf gate) blocks sendIdentification.
      //    NEVER fall back to the registered BIB.
      if readBib == "":
        fireViolation NO_BIB
          (dedup key "name:NO_BIB" — one per runner per session)
        continue

      // 3) Identification — only reached when readBib is valid
      recordKey = name + ":" + readBib
      if seenRecords.has(recordKey):
        log "♻️ Already identified with BIB <readBib> this session"
        continue                          ← same face + same OCR ≡ identical evidence
      seenRecords.add(recordKey)
      POST recordCheckpoint(name,
                            checkpoint_id="photo_verified",
                            scanTimeHHMMSS, registeredBib)
      log "✅ <name> (BIB <registeredBib>)"

      // 4) WRONG_PERSON — OCR'd BIB ≠ registered
      if registered[name] AND readBib !== registered[name]:
        fireViolation WRONG_PERSON
          (dedup key "name:WRONG_PERSON:" + readBib)

    ── UNREGISTERED trigger (ALL unknowns per photo, capped) ──
    unknownHits.sort by area desc
    reportedUnknowns = unknownHits.slice(0, MAX_UNKNOWNS_PER_PHOTO)
    for i in 0..reportedUnknowns.length:
      fireViolation UNREGISTERED with face crop
                    (dedup key "unknown:fileId:i" — per-face-index)
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

**Why `NO_BIB` is single-shot here, but `OBSCURED_BIB` is still
unfired.** A curated still IS the entire evidence pool for that
runner-in-that-photo: if the validation gate fires, the photo has
no usable BIB and the scanner must say so — no
`NO_BIB_AFTER_FAILURES` counter is needed because there are no
further frames to wait for. An earlier revision tried to "silently
reject" the empty case to mirror `checkpoint.html`'s consecutive-
failure semantics, but that produced false-positive `✅`
identifications against runner-registration photos (faces are
known, no BIB visible, scanner fell back to the registered BIB and
logged success). The fix is to fire `NO_BIB` immediately on any
empty `readBib` for a known face, deduplicated per-runner-per-
session via key `"name:NO_BIB"`. `OBSCURED_BIB` stays scanner-
excluded because the scanner doesn't distinguish "empty text"
(`NO_BIB` in `checkpoint.html`) from "text but bad length/conf"
(`OBSCURED_BIB` in `checkpoint.html`); both validation-gate
outcomes collapse to `NO_BIB` in the static-photo pipeline.

**Per-session deduplication.** Burst-mode photography (10 fps shutter
on the same runner) would otherwise emit one record per photo. The
scanner suppresses duplicates with three in-memory `Set` instances:

| Set                       | Element shape                                          | Purpose                                                 |
|---|---|---|
| `seenRecords`             | `"name:readBib"`                                       | One identification per **(name, OCR'd BIB)** pair per session. Same face + same OCR collapses; same face + DIFFERENT OCR re-fires (catches mid-session BIB changes). `readBib` is `""` when OCR failed / hit the silent-reject gate. |
| `seenViolations`          | `"name:type:readBib"` for `WRONG_PERSON`; `"name:MULTIPLE_BIBS:joined-blocks"` for `MULTIPLE_BIBS`; `"name:NO_BIB"` for `NO_BIB` (no payload suffix — no OCR result to vary on); `"unknown:fileId:N"` for `UNREGISTERED` per face index | One violation per distinct piece of evidence per session. Burst shots of identical evidence collapse; distinct misreads of the same runner fire distinct violations. `NO_BIB` collapses to one violation per known-face-per-session because every empty OCR for the same runner is the same evidence (no BIB). UNREGISTERED uses per-face-index so a crowd photo of N unknowns produces N rows (up to `MAX_UNKNOWNS_PER_PHOTO`). |

The earlier `seenUnknownsPerPhoto` set was retired in the 2026-05-18
audit pass — the per-face-index `seenViolations` key
(`"unknown:fileId:N"`) gives the same per-photo capping behavior
without a parallel set. Different photos of the same unknown person
still each fire one `UNREGISTERED` (different `fileId`); the cap on
*within* a single photo is `MAX_UNKNOWNS_PER_PHOTO = 15`, applied at
the iteration level before any dedup keys are computed.

Sets are cleared on every Start press AND on page reload.

**Why the OCR result is part of every dedup key.** A name-only
`seenRecords` would correctly collapse burst shots, but it would
also blindly suppress mid-batch BIB changes: if Kawin reads BIB 1234
in photo 1, the first `WRONG_PERSON` (say, BIB 9999 in photo 5) does
fire — but a yet-another-wrong-BIB read (8888 in photo 7) would be
suppressed by a name-only `seenViolations` key. Folding the OCR
result into both keys keeps burst-shot dedup intact (identical OCR ≡
identical evidence) while letting every distinct misread surface for
admin review. The scanner also early-returns on a `seenRecords` hit:
the OCR has already run, the result is identical to a previously
recorded one, so the violation outcome would be identical too —
re-running the violation check would be redundant.

**There is no backend dedup**: the backend remains stateless across
scanner calls. **But the frontend persists its dedup state to
`localStorage`** under `drive_scanner_v1:<folderId>` with a 24-hour
TTL, so a closed tab / OS sleep / accidental reload doesn't doom
the operator to re-POSTing every already-processed photo. On the
next Start press for the same folder, a banner prompts "Found a
previous scan for this folder · N identifications, M violations …
Resume?" — Resume rehydrates the `Set` instances; Start Fresh
clears the entry. State is saved on every `Set` mutation
(debounced 2 s) and force-flushed on `finishScan("aborted"/"error")`.
A clean `finishScan("done")` clears the entry — no resume needed
on the next run of the same folder.

**Pagination + concurrency + serial-throttled POSTs (High-Performance
Local Mode, 2026-05-19).** `getDrivePhotos` is paged (`offset` /
`pageSize`, default 500, max 1000) so a 5000-photo folder can't blow
the 6-min Apps Script limit on the listing call. The frontend loops
on `hasMore` before scanning starts and reports listing progress.
Inside the scan loop, photos are now processed by a semaphore-style
worker pool that keeps `SCAN_CONCURRENCY` (default 4) photo tasks
in flight at all times. Each task owns its own
fetch → face-api inference → Tesseract OCR → POST pipeline; the
concurrency win comes from overlapping DIFFERENT stages across
photos (one photo on the GPU while another is fetching bytes and a
third is in OCR), not from parallelizing the same stage — the
single WebGL context and single Tesseract worker serialize their
own stages internally. TF.js is explicitly pinned to the `webgl`
backend at `init()` time (with CPU fallback) so the local GPU
actually gets used. This replaces the prior prefetch-by-1
sequential loop — N-way concurrency provides N-way overlapped
fetches naturally. All `recordCheckpoint` and `reportViolation`
POSTs are funneled through `enqueueThrottledPost`, a single serial
queue that sleeps `POST_THROTTLE_MS` (150 ms) AFTER each POST. With
the queue, the actual outbound POST cadence stays ≤ 1 per 150 ms
regardless of how many photo tasks are concurrent — see Guardrail
#30 for why this serial-queue shape is load-bearing.

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
    counter, no `OBSCURED_BIB` firings (single-shot `NO_BIB` IS
    fired — see §4.7; empty and bad-length/conf both collapse to
    `NO_BIB` in the scanner). The static-image and live-video
    tradeoffs go in opposite directions — Tiny + EMA + voting exist
    because the live loop has 30 FPS of noisy detections to lean on,
    while the scanner has exactly one frame per runner per photo. Don't try to factor the two pipelines into shared
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
29. **`checkpoint_id: "photo_verified"` is a SENTINEL, not a
    checkpoint.** `handleRecordCheckpoint` short-circuits to
    `_recordPhotoVerification` for this value; that helper writes
    only `Name` + `BibNumber` + `UpdatedAt` to the Results sheet and
    **never touches a CP_Time column**. Don't fold the sentinel back
    into the generic ternary that maps `start` → `Start_Time` /
    `finish` → `Finish_Time` / `N` → `CPN_Time` — there is no
    `Photo_Verified_Time` column, and creating one would mean the
    scanner becomes a timing gate again, defeating §4.7's purpose.
    The sentinel is also the only non-numeric, non-start/finish cpId
    `handleRecordCheckpoint` accepts; every other unrecognized value
    still throws `schema_error` (defense against accidental
    free-form cpIds from new clients).
30. **`POST_THROTTLE_MS` MUST be enforced by a single serial queue,
    not by a per-task `await sleep` inside `sendIdentification` /
    `fireViolation`.** Since 2026-05-19 the Drive Scanner runs
    `SCAN_CONCURRENCY` photo tasks in parallel. If each task slept
    `POST_THROTTLE_MS` independently, N concurrent tasks would each
    sleep 150 ms in parallel and the actual outbound POST burst
    rate would multiply by N — blowing the per-user Apps Script
    URL-fetch quota guard that the throttle exists to enforce. The
    correct shape is `enqueueThrottledPost(workFn)`, a queue that
    chains promises through a `postQueueTail` so at most one POST
    is in flight at a time with a ≥ 150 ms gap between successive
    POSTs. Don't "simplify" this back into per-call sleeps unless
    `SCAN_CONCURRENCY = 1`. If you bump `SCAN_CONCURRENCY`, verify
    in DevTools Network that consecutive `script.google.com` POSTs
    still stay ≥ 150 ms apart — that's the canary that the queue
    is intact. Note also: the synchronous `if (set.has(k)) return;
    set.add(k);` reserve-then-add idiom inside `fireViolation` (and
    at the `sendIdentification` call site) is also load-bearing
    under concurrency — moving the `.add()` past an `await` would
    let two concurrent tasks both pass the dedup check and
    double-POST. Status note (2026-05-19 revert): with
    `SCAN_CONCURRENCY` back at `1` the queue is effectively redundant
    (one POST in flight anyway), but kept in place so the invariant
    is intact for any future concurrency raise once the shared
    `#preview-canvas` is properly refactored per Guardrail #31.
31. **OCR (`runOCRForFace`) MUST read pixels from `#preview-canvas`
    BEFORE any `drawDetectionBox` / `faceapi.draw.*` overlay is
    painted on it.** Painting UI overlays first lets the green name
    label corrupt the chest region Tesseract reads, dropping OCR
    confidence and producing false `NO_BIB` / `WRONG_PERSON`
    decisions. `processPhotoWithBytes` enforces this by categorizing
    detections without drawing, then running `handleKnownFace`
    (`runOCRForFace` + violation decisions) on the still-clean
    canvas, and ONLY THEN walking `knownHits` / `unknownHits` a
    final time to paint overlays for operator feedback (plus the
    DEBUG dashed-blue chest-box overlay if `?debug=1`). Don't
    "restore" the per-detection drawing for snappier operator
    feedback without first refactoring the working canvas to be
    per-task (then both can coexist — paint immediately on the
    per-task offscreen canvas, compose onto the preview element
    at end-of-photo for display only). Do not move OCR
    (`runOCRForFace`) above the categorization phase if a future
    change ever reintroduces any drawing inside that phase.
    Incident: 2026-05-19 — operator saw pure-black / wrong-body-part
    / red-box violation crops in Drive caused jointly with the
    `SCAN_CONCURRENCY = 4` race; this guardrail pins the half of
    the bug that survives even at concurrency=1. **Historical
    annotation (2026-05-19, same-day):** the violation-crop half of
    this guardrail is now MOOT — the operator subsequently directed
    the scanner to stop attaching `image` to any `fireViolation`
    payload, and the `cropToDataUrl` helper was deleted. No image
    is saved to Drive for new violations, so the "UI baked into
    pixels" failure mode has no remaining attack surface. The OCR
    clean-canvas clause is the only load-bearing half today. If a
    future change reintroduces image saving (a re-added
    `cropToDataUrl` call, or `faceapi.toDataURL` over the preview),
    the full guardrail snaps back into effect — read the original
    body, not just the OCR sentence.

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
    `WRONG_PERSON`, `MULTIPLE_BIBS`, `UNREGISTERED`, `NO_BIB`.
    `NO_BIB` is single-shot in the scanner (one validation-gate
    failure for a known face = one violation; deduplicated per-
    runner-per-session via key `"name:NO_BIB"`) — no consecutive-
    failure counter, because a curated still IS the entire evidence
    pool for that runner-in-that-photo. `OBSCURED_BIB` is NOT
    fired: the scanner doesn't distinguish empty text from
    bad-length/conf, so both collapse to `NO_BIB`.
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

##### 2026-05-18 — Drive Scanner pivots from "timing" to "identity verification"

The post-race scanner is no longer a checkpoint surrogate. The new
mental model: *the scanner answers "who is in this photo, and are
they wearing the correct BIB?" — nothing more.* Concrete changes:

- **`templates/photo_scanner.html`** — CP selector buttons (START /
  CP1-4 / FINISH) removed from markup; `.cp-sel` / `.cp-btn` CSS
  removed; `checkpointId`, `CP_BUTTONS`, `setCP()`, `cpLabel()` all
  deleted; the CP-disable loop in `setScanUI` is gone. The top-bar
  title is renamed `🖼️ IDENTITY VERIFICATION`. Footer note rewritten
  to reflect the new framing.
- **Session-global dedup** — `seenRecords`, `seenViolations`,
  `seenUnknownsPerPhoto` are now `Set` instances (cleaner intent
  than objects-as-maps; `.has()` / `.add()` / `.clear()` at call
  sites). Keys lose their `cpId` component:
  `seenRecords[name]`, `seenViolations[name + ":" + type]`. The
  `seenUnknownsPerPhoto` key is now just `fileId` (still 1
  UNREGISTERED per photo). One identification per runner per
  session, regardless of burst-shot count.
- **Identification log** — successful matches now render as
  `✅ <name> (BIB <bib>)` with the BIB inline next to the name so
  operators can scan-read the log. A green left-border accent on
  plain `.sb-item` rows visually pops these against duplicates /
  skips / violations. The "Recorded:" stats label is renamed
  "Identified:" (counter variable `stats.records` kept).
- **Frontend POST shape** —
  `sendRecordCheckpoint` is renamed `sendIdentification` and now
  hardcodes `checkpoint_id: "photo_verified"`. No other field
  changes; the action is still `recordCheckpoint` so the backend
  routes through the existing handler.
- **Backend `handleRecordCheckpoint`** —
  a 5-line short-circuit at the top of the function detects
  `cpId === "photo_verified"` and delegates to a new helper
  `_recordPhotoVerification(name, bib)`. The helper writes
  `Name` + `BibNumber` + `UpdatedAt` to the Results sheet (insert
  if absent, otherwise in-place update) and invalidates the
  results cache. **It never writes a CP_Time column.** All existing
  cpIds (`start` / `finish` / `1-4`) take the original code path
  unchanged. Guardrail 29 pins the sentinel semantics.

Reversibility: undoing the pivot means restoring the CP selector
markup + state and reverting `sendIdentification` to send the
operator-selected cpId. The backend short-circuit can stay; it's
inert when nothing sends `"photo_verified"`.

**Follow-up (same day): dedup keys now factor in the OCR result.**
The first cut of this pivot keyed `seenRecords` on `name` and
`seenViolations` on `"name:type"`. That correctly suppressed
burst-shot duplicates, but it had a real flaw: if Kawin reads the
correct BIB in one photo and a *different* wrong BIB in two later
photos, the first wrong-BIB read fires `WRONG_PERSON` (good) but the
second one — same name, same type — is suppressed (bad). Two
distinct BIB swaps by the same runner should produce two distinct
violations.

Fix: OCR moved to the top of `handleKnownFace`, so its result is
available before the dedup decision. `seenRecords` keys are now
`"name:readBib"`; `seenViolations` keys are `"name:type:readBib"`
(or `:joined-blocks` for `MULTIPLE_BIBS`). Burst dedup still works —
identical OCR ≡ identical key ≡ skip. A `seenRecords` hit
early-returns the function (no point running the violation check
when the OCR result is already known-deduped). The
`seenUnknownsPerPhoto` set and the `UNREGISTERED` dedup key are
unchanged — per-photo capping already handles distinct unknowns
across photos correctly. The footer `.note` text in the scanner UI
was updated to reflect the new contract ("Burst shots of the exact
same runner AND BIB are skipped…"). No backend change required.
See AI_CONTEXT §4.7 dedup table.

**Audit-driven hardening (same day): four bundles applied.** A
proactive edge-case audit surfaced eight risks ranging from
"6-minute Apps Script timeout on huge folders" to "false
`WRONG_PERSON` from shirt-graphic OCR garbage." All four chosen fix
bundles landed in one pass:

- **Backend hardening — `getDrivePhotos` pagination + strict mime
  allow-list.** Added `offset` / `pageSize` params (default 500, max
  1000), returning `hasMore` + `nextOffset` so the frontend pages
  through. `FileIterator.next()` is used to skip past the offset
  without triggering metadata reads. The mimeType filter is now an
  explicit allow-list (`image/jpeg`, `image/jpg`, `image/png`,
  `image/webp`, `image/gif`) — HEIC, RAW, TIFF, SVG, and video pass
  the old `"image/"` prefix check, then waste 5-15 MB / file of
  bytes-fetching before `loadImage` fails in the browser. They now
  bump `skipped` at list time and the operator sees the count up
  front. New constants: `SCANNER_ALLOWED_MIME_TYPES`,
  `DRIVE_PHOTOS_DEFAULT_PAGE_SIZE`, `DRIVE_PHOTOS_MAX_PAGE_SIZE`.

- **OCR rigor — tightened scanner validation gates.**
  `OCR_MIN_CONFIDENCE` 60 → 80, `BIB_MIN_LEN` 1 → 2 in
  `photo_scanner.html`. The relaxed values inherited from
  `checkpoint.html` are *field-test* defaults tuned for low-light
  live recognition; static curated photos give Tesseract a much
  cleaner target. The old gates admitted reads like "23" (from a
  shirt graphic) with conf 75, firing false `WRONG_PERSON` against
  registered BIB 1234. The tightened gates close that path.

- **Multi-unknown coverage — report ALL unknown faces per photo.**
  The detection loop in `processPhotoWithBytes` no longer tracks
  only the largest unknown; it collects all unknowns into
  `unknownHits[]`, sorts by area desc, slices the top
  `MAX_UNKNOWNS_PER_PHOTO` (15 — initially 5; raised to better cover group shots / pack starts), and fires one `UNREGISTERED` per
  reportedUnknown. Per-face-index dedup key (`"unknown:fileId:N"`)
  ensures the cap is enforced without a parallel set; the retired
  `seenUnknownsPerPhoto` Set was dropped.

- **Scan resilience — localStorage persistence, prefetch, throttle.**
  Three new pieces. (a) `seenRecords` + `seenViolations` are
  persisted to `localStorage.drive_scanner_v1:<folderId>` (24-hour
  TTL) after every mutation (debounced 2 s) and force-flushed on
  abort/error. On next Start for the same folder, a banner asks
  "Found a previous scan… Resume?" — Resume rehydrates the Sets;
  Start Fresh clears the entry. (b) The scan loop now prefetches
  photo i+1's bytes via a new `fetchImageBytes(photo)` helper while
  inference runs on photo i; `processPhoto` was renamed
  `processPhotoWithBytes(photo, payload)` and accepts the pre-fetched
  payload. Roughly doubles throughput. (c) A `sleep(POST_THROTTLE_MS)`
  (150 ms default) fires after every `recordCheckpoint` and
  `reportViolation` POST, keeping large batches under per-user
  Apps Script URL-fetch quota.

No backend schema or guardrail change. New scanner constants are
documented in §6.8.

**Same-day follow-up: inline BIB editing on the admin Runners tab.**
The dashboard's admin runners tab now supports inline editing of a
runner's BIB number, eliminating manual Google Sheet edits when a
runner switches BIBs at check-in.

- **Backend (`Code.gs`):** new POST action `editRunnerProfile` —
  admin-gated handler that updates `Runners.BibNumber` for the row
  whose `Name` matches, and (if a Results row exists) propagates
  the new value to `Results.BibNumber` so the leaderboard doesn't
  surface stale data. Invalidates the runners + results caches.
  Distinct from the existing `updateRunner` action (which targets
  the Results sheet's time columns); both endpoints continue to
  coexist.
- **Intentionally BIB-only.** `Name` is the primary key in Runners
  AND foreign-keyed by `Name` in Results, Violations, and the Drive
  folder path (`RunnerFaces/<name>/`), plus loaded as the
  FaceMatcher labels on `/scan`. A safe rename would be a
  3-sheet + Drive cascade; out of scope. The Name cell stays as
  plain text — only the BIB cell becomes an inline input.
- **Frontend (`dashboard.html`):** new `editingRunner` state variable
  holds the Name of the row currently in edit mode. `renderRunnerRow`
  switches the BIB cell to an `<input class="inline-bib-input">`
  and the actions cell to `💾 Save` / `✖ Cancel` buttons. New
  `data-edit-runner` / `data-save-runner` / `data-cancel-runner`
  delegation handlers on `#admin-body`. New `saveRunnerBib(name,
  buttonEl)` helper handles validation, loading state, and the POST.
  `switchTab` clears `editingRunner` so tab navigation doesn't
  leave an orphan edit state. `renderAdminTab` clears a dangling
  `editingRunner` if the named runner is gone (another admin
  deleted them between polls).
- **No new auth surface.** Reuses `adminPost` and the existing
  admin token flow. No new Flask route, no new template.

`Violations.BibNumber` rows are intentionally NOT rewritten — those
are historical records of what was observed at violation time;
rewriting them would falsify the audit trail.

**Same-day follow-up: public leaderboard trimmed to match the
Identity Verification pivot.** Since `recordCheckpoint` under the
`photo_verified` sentinel writes only `Name` + `BibNumber` +
`UpdatedAt` and never touches a `CP*_Time` column, the leaderboard's
six legacy timing columns (Start / CP1-4 / Finish / Total Duration)
were rendering as "-" forever. Cleanup:

- **`<thead>` cut from 10 columns → 4**: `#` (row number),
  `ชื่อ` (Name), `BIB`, `Verified At`. The old `อันดับ` (Rank)
  header was renamed `#` — without a race time, "rank" no longer
  implies a competitive ordering, just a row position.
- **Sort key changed**: previously partitioned into
  finished/unfinished by `Total_Duration` presence then sorted by
  parsed duration; now a single sort by `UpdatedAt` descending
  (lexicographic on the ISO string — same result as Date parse,
  faster). Rows with empty `UpdatedAt` (registered runners the
  scanner hasn't seen yet) sort last.
- **`#s-fin` stat card repurposed**: label changed from
  "เข้าเส้นชัยแล้ว" (Finished) → "ระบุตัวตนแล้ว" (Identified).
  The counter now sums rows with non-empty `UpdatedAt` instead of
  rows with `Total_Duration`. The element id stays `s-fin` so the
  JS update site doesn't need a rename and `git blame` still points
  readers at this changelog entry.
- **`parseDur` helper removed**: it was used only by the leaderboard
  sort. `normalizeRowTimeCols` + `calcDuration` (backend) are
  untouched — they still power `checkpoint.html` if/when live mode
  is re-enabled.
- **New helper `formatVerifiedAt(iso)`**: ISO → `YYYY-MM-DD
  HH:MM:SS` local time, returns `-` for missing/unparseable input.
  Deliberately avoids `toLocaleString()` to keep the format stable
  across browser locales.

**The admin Runners tab is intentionally NOT simplified.** The
existing `renderRunnerRow` continues to show Start/CP1-4/Finish/
Total Duration columns even though they're empty under the current
scanner-only deployment — admin context still benefits from the
shape if live mode is ever reinstated, and the columns are
cheap-to-render dashes. The Results sheet schema is unchanged; only
the leaderboard's display shape changed.

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
- **Drive Scanner dedup is session-scoped, (name, OCR-result)-keyed,
  not backend-enforced**: the three `seen…` `Set` instances live in
  browser memory. `seenRecords` keys on `"name:readBib"` (one
  identification per (name, OCR'd BIB) pair per session — burst
  shots collapse, but a mid-session BIB change re-fires).
  `seenViolations` keys on `"name:type:readBib"` (or with joined
  blocks for `MULTIPLE_BIBS`). `seenUnknownsPerPhoto` keys on
  `fileId`. **Same face + different OCR is NOT a duplicate** — it
  re-fires identification and re-checks violations, catching BIB
  swaps mid-batch. Reloading the page mid-batch and restarting will
  re-identify runners seen before the reload — the backend writes a
  duplicate row each time. Admins clean those up via the dashboard
  bulk-delete tools. No cross-tab coordination — two operators
  scanning the same folder simultaneously will write duplicate rows.
- **Drive Scanner has no checkpoint concept (post-2026-05-18)**: the
  scanner is identity-verification only, not a timing gate. There's
  no CP selector in the UI. Every successful identification POSTs
  `recordCheckpoint` with the sentinel `checkpoint_id:
  "photo_verified"`; the backend short-circuits to a write that
  touches only `BibNumber` + `UpdatedAt` (no CP_Time column).
  Splitting recognition across CPs is impossible in the scanner; use
  the live `checkpoint.html` (re-route it first — see 2026-05-17
  follow-up) for that.
- **Drive Scanner fires `NO_BIB` single-shot, NOT `OBSCURED_BIB`**:
  the scanner has no `ocrFailureCount` counter — it doesn't need
  one. A curated still IS the entire evidence pool for that
  runner-in-that-photo, so a single failed validation-gate read
  (empty digits OR bad length / conf) immediately fires a `NO_BIB`
  violation for that known face, deduplicated per-runner-per-session
  via key `"name:NO_BIB"`. `sendIdentification` is BLOCKED on empty
  `readBib` — the scanner does NOT fall back to the registered BIB.
  `OBSCURED_BIB` stays scanner-excluded because the scanner doesn't
  distinguish "empty text" from "text but bad length/conf"; both
  collapse to `NO_BIB`. Operators can still re-shoot or manually
  update via the admin UI; the difference now is they see the
  violation instead of a phantom `✅`.
- **Drive Scanner accepts only JPEG / PNG / WebP / GIF (post-audit
  2026-05-18)**: `getDrivePhotos` filters by an explicit allow-list
  in `SCANNER_ALLOWED_MIME_TYPES`. HEIC, RAW (`image/x-canon-cr2`,
  `image/x-sony-arw`, etc.), TIFF, and SVG bump the `skipped`
  counter at list time so the operator sees "150 files skipped"
  immediately — no per-file bytes-fetching wasted on undecodable
  inputs. Photographers on iPhone should export-as-JPEG before
  uploading; the scanner will not pull HEIC bytes.
- **Drive Scanner is resumable across page reloads (post-audit
  2026-05-18)**: dedup state persists to
  `localStorage.drive_scanner_v1:<folderId>` with a 24-hour TTL. An
  interrupted scan (closed tab, OS sleep, browser crash) leaves
  state behind; the next Start press for the same folder pops a
  banner asking whether to resume or start fresh. Successful
  completion clears the entry; aborts force-flush it.
- **Drive Scanner uses pagination + prefetch + throttle for huge
  folders (post-audit 2026-05-18)**: `getDrivePhotos` is paged at
  `pageSize=500` so a 5000-photo folder doesn't hit the 6-min Apps
  Script execution limit on the listing call. The scan loop
  prefetches photo i+1's bytes during photo i's inference (~2×
  throughput). Each `recordCheckpoint` / `reportViolation` POST is
  followed by a 150 ms `POST_THROTTLE_MS` sleep, capping the
  outgoing request rate to ~6/sec for quota safety on per-user
  URL-fetch caps.

### 6.6 One-off setup helpers (Apps Script editor)

Run these from the function dropdown in the Apps Script editor.
All are idempotent.

| Function | Purpose | When to run |
|---|---|---|
| `_setupAdminToken()` | Stores the admin password in `ScriptProperties` | Once at deploy time, or when changing the password |
| `_consolidateDuplicateRootFolders()` | Merges duplicate `RunnerFaces`/`ViolationEvidence` folders into one canonical folder | If a race ever creates duplicates (predates the lock fix) |
| `_migrateHistoricalImages()` | Rewrites every legacy Drive image URL (`Runners.Photo_*`, `Violations.ImageUrl`) to the thumbnail form | Once after deploying v6 (replaces the v3 `_migrateAllImageUrls` helper, which produced now-obsolete embed URLs) |
| `_migrateViolationTypeColumn()` | Adds the `ViolationType` column and back-fills `WRONG_PERSON` | Once after deploying v5 |
| `_migrateResultsSchema()` | Strips the 7 retired timing columns (`Start_Time`, `CP1-4_Time`, `Finish_Time`, `Total_Duration`) from the Results sheet and appends `IsCheating` with blank defaults. Idempotent. | Once after deploying the 2026-05-20 schema strip |
| `_migrateViolationsPhotoColumns()` | Appends `PhotoFileId` and `DetectionBoxes` to the Violations sheet (existing rows get blank cells). Idempotent. | Once after deploying the 2026-05-20 evidence pass |

### 6.7 Endpoints reference

**GET** (`?action=…`)
| Action | Returns | Notes |
|---|---|---|
| `getRunners` | All `Runners` rows | Cached, 12 s TTL |
| `getResults` | All `Results` rows | Cached, 12 s TTL |
| `getViolations` | Top 20 violations (Timestamp desc) | Cached, 12 s TTL |
| `getVerifiedViolations` | Top 20 with `Verified=true` | Cached, 12 s TTL |
| `getDrivePhotos` | `{ folderName, offset, pageSize, count, skipped, hasMore, nextOffset, data: [{id, name, mimeType, thumbnailUrl}] }` | Requires `folderId=<id>`. Optional `pageSize` (default 500, max 1000) + `offset` (default 0) — frontend loops on `hasMore` so a single Apps Script request stays under the 6-min execution limit. **Uncached** — folder contents change as photographers add shots. Image mimeType strictly allow-listed (jpeg/png/webp/gif). Sorted by name within each page. Drive errors mapped to `not_found` / `drive_error`. |
| `getImageBytes` | `{ fileId, mimeType, sizeBytes, base64 }` | Requires `fileId=<id>`. **Uncached** — per-file payload exceeds the 100 KB CacheService per-key cap. Returns the full file bytes so the scanner can decode them into a same-origin `data:` URL for canvas inference (Guardrail 28). |

**POST** (JSON body, `Content-Type: text/plain` to dodge CORS preflight)
| Action | Payload | Notes |
|---|---|---|
| `verifyAdmin` | `{ password }` | Returns success/failure; no token needed |
| `registerRunner` | `{ name, bib, email?, timestamp?, photo_front…right, embeddings }` | Atomic |
| `recordCheckpoint` | `{ name, checkpoint_id, timestamp, bib? }` | `checkpoint_id` is `"start"`, `1`, `2`, `3`, `4`, `"finish"`, OR the sentinel `"photo_verified"` (Drive Scanner identity-verification path; bypasses CP_Time columns — see Guardrail 29). Any other value throws `schema_error`. |
| `reportViolation` | `{ name?, bib?, message?, violationType?, timestamp?, photoFileId?, detectionBoxes? }` | Scanner no longer attaches `image` (2026-05-19 operator decision). Backend still tolerates `image: <base64>` from any legacy client — base64-decoded into Drive when present, `ImageUrl` blank when absent. `photoFileId` (Drive file ID, opaque string) and `detectionBoxes` (array; backend stringifies to JSON) added 2026-05-20 — the dashboard evidence modal consumes them. Pre-migration sheets silently drop the new fields via the header-mapped write. `violationType` defaults to `WRONG_PERSON`. |
| `verifyViolation` | `{ token, id }` | Admin |
| `deleteViolation` | `{ token, id }` | Admin; trashes Drive image |
| `deleteViolationsBatch` | `{ token, ids: [V…] }` | Admin; up to 200 IDs |
| `deleteRunner` | `{ token, name }` | Admin; trashes folder + clears Results |
| `updateRunner` | (none — deprecated 2026-05-20) | **Deprecated**: returns `{status:"error", code:"deprecated", message:"updateRunner is no longer supported"}` for any call. The timing columns it used to edit no longer exist on the Results sheet (see §3.1). Function shell retained so the dispatcher still routes the action. |
| `editRunnerProfile` | `{ token, name, bib?, email? }` | Admin; edits BIB and/or Email on the **Runners** sheet for the runner with the given Name. Both fields are independently optional (frontend posts whichever changed); supplying neither is a `bad_request`. BIB cascades to `Results.BibNumber` if a Results row exists. Empty string clears the corresponding cell. Email validated against `EMAIL_PATTERN` when non-empty; NOT propagated to Results. Invalidates runners cache (and results cache when BIB cascade happens). |
| `renameRunner` | `{ token, oldName, newName }` | Admin; cascade-renames Runners.Name + every matching Results.Name + every matching Violations.Name + the `RunnerFaces/<oldName>` Drive folder (try-catch isolated per Guardrail 2). Rejects with `conflict` if `newName` already exists in Runners. Invalidates all three caches. NOT transactional across sheets — Apps Script crash mid-cascade leaves a partially renamed state; the next rename / manual edit reconciles. |
| `markCheating` | `{ name, isCheating }` | **No admin token** — called by the automated Drive Scanner after WRONG_PERSON fires (Guardrail 29 sibling — distinct write path from `photo_verified`). Writes `"true"` / `"false"` to `Results.IsCheating` for the named runner. Inserts a minimal row if the runner has no Results row yet. Invalidates the results cache. |
| `updateRunnerPhoto` | `{ token, name, angle, photoBase64, mimeType? }` | Admin; trashes the old Drive file for the angle (try-catch isolated, Guardrail 2), uploads the new base64 image via `saveBase64Image`, rewrites the `Photo_<Angle>` cell with the new thumbnail URL. `angle` must be one of `front` / `top` / `bottom` / `left` / `right`. Invalidates the runners cache. |

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

**`getOCRCropBox` geometry (mirrored in `checkpoint.html` per Guardrail 27):**
widened 2026-05-19 to `bx = box.x − 0.7·faceH`, `by = box.y + 0.5·faceH`,
`bw = box.width + 1.4·faceH`, `bh = 3.0·faceH` (was `0.5 / 0.6 / 1.0 / 3.0`).
The slightly higher top edge captures tight-portrait BIBs that hug the chin;
the wider horizontal padding captures off-center BIBs on shoulder-strap race
vests. `preprocessForOCR`'s adaptive threshold rejects the extra skin pixels
uniformly, so widening adds no OCR noise. A DEBUG-only (`?debug=1`)
dashed-blue rectangle in the final UI pass of `processPhotoWithBytes`
visualises this exact region per known face — painted AFTER every
`runOCRForFace` read completes (Guardrail #31 OCR clause; the
violation-crop clause is moot since 2026-05-19 — see Guardrail #31
body for the annotation).

| Constant | Default | Effect |
|---|---|---|
| `SSD_MIN_CONFIDENCE` | `0.7` (was `0.5` pre-2026-05-19) | `SsdMobilenetv1Options.minConfidence` — minimum face-score for a detection to count. Raised from face-api's 0.5 default to filter banner/poster hallucinations that scored 0.50–0.65 on event photos. Real foreground faces score 0.85+, so the bump is safe. Pair with `MIN_FACE_SIZE`. |
| `MIN_FACE_SIZE` | `0` (was `60` for ~hours of 2026-05-19, then DISABLED same day per operator request) | Post-detect size gate. When > 0, detections with `box.width < MIN_FACE_SIZE OR box.height < MIN_FACE_SIZE` are dropped BEFORE face matching, OCR, and `UNREGISTERED` reporting. Currently `0` (no-op pass-through) because operator reported borderline-small faces being filtered out of OCR. Banner / poster hallucinations are now caught primarily by `SSD_MIN_CONFIDENCE = 0.7`. Re-enable to e.g. `60` if `UNREGISTERED` rows from banner art come back in volume. |
| `FACE_MATCH_DISTANCE` | `0.45` | `findBestMatch` threshold — same as live page; lower = stricter |
| `OCR_MIN_CONFIDENCE` | `50` (history: `60` initial → `80` 2026-05-17 audit → `65` 2026-05-19 → `50` 2026-05-19 same-day) | Single-pass Tesseract confidence floor. Each step down was driven by operator-reported false `NO_BIB` on legibly-printed BIBs that browser Tesseract simply doesn't score at the prior floor. `50` is near the floor of useful Tesseract output — reads below this are usually genuinely garbage. Short-graphic false-positive defense (the original reason `80` was tried in the audit) now relies on `BIB_MIN_LEN = 2` (unchanged) and the face-match gate; `SSD_MIN_CONFIDENCE = 0.7` keeps banner art out of the detection pipeline in the first place. If sponsor-logo false `WRONG_PERSON` reads come back, raise to ~60 first; only raise above 65 if you have a real foreground-portrait sample that scores 65+. |
| `BIB_MIN_LEN` / `BIB_MAX_LEN` | `2` / `6` (was `1` / `6` pre-audit) | Accepted BIB length range. Min raised to 2 post-audit to reject single-digit fragments that pass the digit-only filter on garbage reads |
| `ADAPTIVE_THRESHOLD_BLOCK` | `15` | Local-window size for adaptive threshold (mirror of `checkpoint.html`) |
| `ADAPTIVE_THRESHOLD_C` | `10` | Mean offset (mirror of `checkpoint.html`) |
| `OCR_UPSCALE` | `2` | Nearest-neighbor scale factor before OCR (mirror of `checkpoint.html`) |
| `MULTIPLE_BIBS_MIN_BLOCK_LEN` | `2` | Minimum digits per block — same shape check as the live page (Guardrail 26: run on RAW Tesseract text) |
| `MULTIPLE_BIBS_MIN_BLOCKS` | `2` | Minimum distinct candidate blocks to fire `MULTIPLE_BIBS` |
| `MAX_UNKNOWNS_PER_PHOTO` | `15` | Cap on `UNREGISTERED` reports per single photo. Sorted by face area desc — most prominent intruders are reported first when cap kicks in. Raised from 5 to 15 to cover group shots / pack starts where many intruders may legitimately appear in one frame. |
| `LIST_PAGE_SIZE` | `500` | `pageSize` param sent to `getDrivePhotos`. Must be ≤ backend `DRIVE_PHOTOS_MAX_PAGE_SIZE` (1000). |
| `SCAN_CONCURRENCY` | `1` (was `4` for ~hours of 2026-05-19, reverted same day) | Number of photos processed in parallel by the semaphore worker pool inside `startScan`. **Pinned at 1** because `processPhotoWithBytes` writes to the shared `#preview-canvas` DOM element; concurrent `canvas.width = …; ctx.drawImage(…)` produced wrong-coordinate detections, pure-black crops, and "runner's legs instead of face" violation images saved to Drive. The pool is kept in place — at concurrency=1 it degenerates to single-flight sequential processing identical to the pre-HPLM loop. Path back to >1 REQUIRES first replacing `#preview-canvas` with a per-task `document.createElement('canvas')` inside `processPhotoWithBytes` (then `drawImage` the result onto the preview element only at end-of-photo, for display). See Guardrail #31. |
| `POST_THROTTLE_MS` | `150` | Tail gap inside `enqueueThrottledPost`'s serial queue — every `recordCheckpoint` / `reportViolation` POST is followed by this sleep before the next queued POST runs. Quota safety on large batches; guarantees ≥ 150 ms between outbound POSTs even when `SCAN_CONCURRENCY > 1`. **Guardrail 30**: do not move this sleep back into per-task code. |
| `STORAGE_PREFIX` | `"drive_scanner_v1:"` | localStorage key prefix for resumable scan state. Bump the `v1` suffix on incompatible schema changes. |
| `SCAN_STATE_TTL_MS` | `86_400_000` (24h) | After this age, a saved state is dropped on load — event is presumed over. |
| `SCAN_STATE_SAVE_DEBOUNCE_MS` | `2000` | Throttle on localStorage writes — at most one write per ~2 s of scanner activity. |

### 6.9 Configuration knobs (backend, `Code.gs`)

| Constant | Default | Effect |
|---|---|---|
| `CACHE_TTL_SEC` | `12` | Read-through cache TTL |
| `CACHE_MAX_BYTES` | `90 × 1024` | Skip-cache threshold (per-key Apps Script limit is 100 KB) |
| `LOCK_TIMEOUT_MS` | `10000` | `LockService` wait inside `getOrCreateFolder` |
| `BATCH_DELETE_MAX` | `200` | Cap on `deleteViolationsBatch` |
| `DEFAULT_VIOLATION_TYPE` | `"WRONG_PERSON"` | Fallback for empty/legacy rows |
| `DEFAULT_ADMIN_TOKEN` | `"muto67"` | Used only if `ScriptProperties.ADMIN_TOKEN` is unset |
| `DRIVE_PHOTOS_DEFAULT_PAGE_SIZE` | `500` | `getDrivePhotos` page size when caller omits `pageSize` |
| `DRIVE_PHOTOS_MAX_PAGE_SIZE` | `1000` | Hard cap on `getDrivePhotos` page size — keeps a single page well under the 6-min Apps Script execution limit even on slow Drive metadata |
| `SCANNER_ALLOWED_MIME_TYPES` | `{jpeg, jpg, png, webp, gif}` | Strict mimeType allow-list applied by `handleGetDrivePhotos`. Non-matches bump `skipped` at list time. |

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
