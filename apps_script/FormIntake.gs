// ============================================================
// AI Runner Timing System — Google Form Intake (onFormSubmit)
// ============================================================
// Companion to Code.gs. This file MUST live in the SAME Apps Script
// project that is bound to the "AI_Runner_Database" spreadsheet, so it
// shares Code.gs's globals:
//   RUNNER_FACES_FOLDER, getRootFolder, getOrCreateFolder, getSheet,
//   SHEETS, SCHEMA, readWholeSheet, DRIVE_THUMBNAIL_URL, NAME_PATTERN,
//   BIB_PATTERN, EMAIL_PATTERN, extractDriveFileId, invalidateRunners,
//   logInfo, logErr.
//
// WHY THIS EXISTS
//   A plain Google Form dumps every file upload into a single shared
//   "<FormTitle> (File responses)" folder — it can't split per person.
//   This onFormSubmit trigger does the per-person organization the
//   FolderUrl column in the Runners schema implies. On every submission
//   it:
//     1) reads Name / BIB / Email + the 5 angle photo uploads from
//        e.namedValues (spreadsheet-bound form-submit event),
//     2) creates (or reuses) RunnerFaces/<name>/ — the per-person
//        folder, shared ANYONE_WITH_LINK/VIEW (getOrCreateFolder),
//     3) moves each uploaded photo into that folder, shares it (so the
//        lh3 Photo_* URL renders — Guardrail 11), renames it
//        <name>_<angle>_<ts>.jpg,
//     4) upserts the runner's row in the Runners tab with the Photo_*
//        URLs + FolderUrl (Embeddings left BLANK — see warning),
//     5) invalidates the runners cache.
//
//   ⚠️ EMBEDDINGS ARE NOT COMPUTED HERE — and must NOT be faked.
//   Face embeddings (128 floats) require face-api.js running in a
//   browser; Apps Script cannot produce them (Guardrail 16: no
//   server-side AI). A form-registered runner therefore has an EMPTY
//   Embeddings cell and is NOT recognizable by the Drive Scanner until
//   embeddings are added (re-enroll the same name via register.html,
//   which upserts the row in place and fills Embeddings; this trigger
//   preserves an existing Embeddings cell on update). See AI_CONTEXT.md
//   §4.8, §6.5, and Guardrail 33.
//
// SETUP — run ONCE from the editor's function dropdown:
//   _setupFormTrigger()   installs the onFormSubmit INSTALLABLE trigger.
//   (A simple trigger named onFormSubmit can't move Drive files / set
//   sharing — it runs without the required authorization scope.)
//
// CONFIG — edit FORM_FIELD_MAP below so the candidate titles match your
//   form's EXACT question wording. Matching is case-insensitive +
//   trimmed, with a substring fallback, but exact titles are safest.
// ============================================================

// Each logical field → the form question title(s) that may carry it.
// First match wins (exact case-insensitive first, then substring).
// Add your form's real question titles here if they differ.
const FORM_FIELD_MAP = Object.freeze({
  name:         ["Name", "Username", "ชื่อ", "ชื่อผู้ใช้", "ชื่อนักวิ่ง"],
  bib:          ["BIB", "Bib Number", "BibNumber", "หมายเลข BIB", "เลข BIB", "เบอร์วิ่ง"],
  email:        ["Email", "E-mail", "อีเมล"],
  photo_front:  ["Front", "Photo Front", "รูปหน้าตรง", "หน้าตรง"],
  photo_top:    ["Top", "Photo Top", "รูปมุมบน", "มุมบน", "เงยหน้า"],
  photo_bottom: ["Bottom", "Photo Bottom", "รูปมุมล่าง", "มุมล่าง", "ก้มหน้า"],
  photo_left:   ["Left", "Photo Left", "รูปด้านซ้าย", "ด้านซ้าย", "หันซ้าย"],
  photo_right:  ["Right", "Photo Right", "รูปด้านขวา", "ด้านขวา", "หันขวา"],
});

const FORM_PHOTO_ANGLES = Object.freeze(["front", "top", "bottom", "left", "right"]);

/**
 * Installable onFormSubmit handler (bound to the spreadsheet via
 * _setupFormTrigger). The event object is the spreadsheet form-submit
 * event: e.namedValues is { "Question title": ["answer", ...] }.
 *
 * Never throws — a thrown error inside a trigger only lands in the
 * execution log and the operator never sees it, so every failure is
 * logged and swallowed so one bad submission can't poison the trigger.
 */
function handleFormSubmit(e) {
  try {
    if (!e || !e.namedValues) {
      logErr("handleFormSubmit: missing event / namedValues", e);
      return;
    }
    const nv = e.namedValues;

    // ── 1) Identity fields ──
    let name = formFirstValue(nv, FORM_FIELD_MAP.name);
    if (!name) {
      logErr("handleFormSubmit: no Name question matched FORM_FIELD_MAP.name", Object.keys(nv));
      return;
    }
    // Lowercase = same rule register.html enforces on submit, so the
    // form path and the browser path produce the same primary key.
    name = String(name).trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) {
      logErr("handleFormSubmit: name fails NAME_PATTERN (a-z0-9_-. , no spaces, ≤50)", name);
      return;
    }

    let bib = (formFirstValue(nv, FORM_FIELD_MAP.bib) || "").trim();
    if (bib && !BIB_PATTERN.test(bib)) { logInfo("formSubmit: bib invalid, blanked", bib); bib = ""; }

    let email = (formFirstValue(nv, FORM_FIELD_MAP.email) || "").trim();
    if (email && !EMAIL_PATTERN.test(email)) { logInfo("formSubmit: email invalid, blanked", email); email = ""; }

    // ── 2) Per-person folder (LockService-protected, shared on create) ──
    const root = getRootFolder(RUNNER_FACES_FOLDER);
    const personFolder = getOrCreateFolder(root, name);

    // ── 3) Move + share + rename each angle photo; build Photo_* URLs ──
    const photoUrls = { front: "", top: "", bottom: "", left: "", right: "" };
    for (let i = 0; i < FORM_PHOTO_ANGLES.length; i++) {
      const angle = FORM_PHOTO_ANGLES[i];
      const answer = formFirstValue(nv, FORM_FIELD_MAP["photo_" + angle]);
      const fileId = extractDriveFileId(answer);   // handles drive.google.com/open?id=…
      if (!fileId) continue;
      try {
        const file = DriveApp.getFileById(fileId);
        file.moveTo(personFolder);                 // out of "(File responses)" into RunnerFaces/<name>/
        file.setName(name + "_" + angle + "_" + Date.now() + ".jpg");
        try {
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        } catch (se) {
          logErr("formSubmit setSharing " + angle, se);   // non-fatal — URL may still render if folder is shared
        }
        photoUrls[angle] = DRIVE_THUMBNAIL_URL(fileId, 800);
      } catch (fe) {
        // Per-photo isolation (Guardrail 2 spirit) — a single bad file
        // never blocks the rest of the photos or the sheet write.
        logErr("formSubmit move/share photo " + angle + " (" + fileId + ")", fe);
      }
    }

    // ── 4) Upsert the Runners row. Embeddings stays BLANK on insert;
    //        on update, an existing Embeddings cell is preserved so a
    //        prior browser enrollment isn't wiped (Guardrail 33). ──
    const sheet = getSheet(SHEETS.RUNNERS);
    const snap = readWholeSheet(sheet);
    const rowIdx = snap.findRowByName(name);
    const rowData = [
      name, bib, email, new Date().toISOString(),
      photoUrls.front, photoUrls.top, photoUrls.bottom,
      photoUrls.left, photoUrls.right,
      personFolder.getUrl(), "",   // Embeddings — intentionally empty (no server-side AI)
    ];
    if (rowIdx > 0) {
      const embCol = snap.headerIndex("Embeddings");
      if (embCol >= 0) {
        const existingEmb = snap.values[rowIdx - 2][embCol];
        if (existingEmb) rowData[rowData.length - 1] = existingEmb;   // keep prior embeddings
      }
      sheet.getRange(rowIdx, 1, 1, rowData.length).setValues([rowData]);
      logInfo("formSubmit intake (update)", { name: name, bib: bib });
    } else {
      sheet.appendRow(rowData);
      logInfo("formSubmit intake (insert)", { name: name, bib: bib });
    }

    invalidateRunners();
  } catch (err) {
    logErr("handleFormSubmit fatal", err);
  }
}

/**
 * Find the first non-empty answer among any candidate question titles.
 * `namedValues` maps title → array of answers. Tries exact
 * (case-insensitive, trimmed) across all keys first, then substring.
 */
function formFirstValue(namedValues, candidates) {
  if (!namedValues || !candidates) return "";
  const keys = Object.keys(namedValues);
  // Pass 1: exact, case-insensitive, trimmed.
  for (let c = 0; c < candidates.length; c++) {
    const want = String(candidates[c]).trim().toLowerCase();
    for (let k = 0; k < keys.length; k++) {
      if (String(keys[k]).trim().toLowerCase() === want) {
        const v = firstNonEmpty(namedValues[keys[k]]);
        if (v) return v;
      }
    }
  }
  // Pass 2: substring (handles "Your Name", "BIB number (1-9999)", …).
  for (let c = 0; c < candidates.length; c++) {
    const want = String(candidates[c]).trim().toLowerCase();
    for (let k = 0; k < keys.length; k++) {
      if (String(keys[k]).trim().toLowerCase().indexOf(want) > -1) {
        const v = firstNonEmpty(namedValues[keys[k]]);
        if (v) return v;
      }
    }
  }
  return "";
}

/** First trimmed non-empty entry of a namedValues answer array. */
function firstNonEmpty(arr) {
  if (arr == null) return "";
  if (!Array.isArray(arr)) return String(arr).trim();
  for (let i = 0; i < arr.length; i++) {
    const s = String(arr[i]).trim();
    if (s) return s;
  }
  return "";
}

/**
 * One-time setup: install the onFormSubmit INSTALLABLE trigger on the
 * bound spreadsheet. Idempotent — removes any prior handleFormSubmit
 * trigger first, so re-running never stacks duplicates. Run once from
 * the editor's function dropdown (it will prompt for Drive/Sheets
 * authorization the first time).
 */
function _setupFormTrigger() {
  const ss = SpreadsheetApp.getActive();
  if (!ss) throw new Error("No bound spreadsheet — open the script from the AI_Runner_Database sheet.");
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "handleFormSubmit") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger("handleFormSubmit")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();
  Logger.log("Installed handleFormSubmit onFormSubmit trigger (removed " + removed + " old).");
}
