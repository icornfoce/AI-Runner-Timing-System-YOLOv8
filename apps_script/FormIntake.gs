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
//   sharing — it runs without the required authorization scope. Confirm
//   it stuck: editor → Triggers (clock icon) → exactly one
//   handleFormSubmit "On form submit" row; check Executions for errors.)
//   The trigger only fires on NEW submissions — it does NOT process rows
//   submitted before it was installed.
//
//   _backfillExistingResponses([sheetName])  one-shot: process responses
//   the trigger missed (rows that predate it). Reads the responses tab
//   (default "Form Responses 1"), skips runners already in Runners.
//
// NAMES — the Name key accepts a first name AND an optional surname
//   (FORM_FIELD_MAP.name + .surname), combined into one key by
//   normalizeName: spaces collapsed, trimmed, capped 50, with case +
//   script PRESERVED. Thai works ("สมชาย ใจดี") and English keeps its
//   spaces ("John Smith"). The backend NAME_PATTERN (Code.gs) allows
//   a-z A-Z 0-9, the Thai block, spaces, and _-. ; emoji / other
//   scripts are rejected. A name whose raw length > 50 (a pasted
//   paragraph) is skipped as junk. See §3.1 + §4.8.
//
// CONFIG — edit FORM_FIELD_MAP below so the candidate titles match your
//   form's EXACT question wording. Matching is case-insensitive +
//   trimmed, with a substring fallback, but exact titles are safest.
// ============================================================

// Each logical field → the form question title(s) that may carry it.
// First match wins (exact case-insensitive first, then substring).
// Add your form's real question titles here if they differ.
const FORM_FIELD_MAP = Object.freeze({
  name:         ["First Name", "Firstname", "Name", "Username", "ชื่อจริง", "ชื่อ", "ชื่อผู้ใช้", "ชื่อนักวิ่ง"],
  surname:      ["Last Name", "Lastname", "Surname", "นามสกุล", "สกุล"],
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
    processFormSubmission(e.namedValues);
  } catch (err) {
    logErr("handleFormSubmit fatal", err);
  }
}

/**
 * Core intake logic, shared by the live trigger (handleFormSubmit) and
 * the one-shot _backfillExistingResponses. Builds the runner key from
 * the name (+ optional surname) fields, creates the per-person folder,
 * moves/shares/renames the angle photos, and upserts the Runners row.
 *
 * Returns { status: "inserted" | "updated" | "skipped", ... } so the
 * backfill can tally results.
 *
 * @param {Object} nv  namedValues-shaped map: { "Question title": ["answer", …] }.
 */
function processFormSubmission(nv) {
  // ── 1) Identity fields ──
  // Name key = first name (+ optional surname), normalized into the
  // Runners.Name key (case + script preserved): "John Smith" stays
  // "John Smith", "สมชาย ใจดี" stays "สมชาย ใจดี", "Egg" → "Egg". The
  // key is used everywhere (folder name, FaceMatcher label, foreign
  // keys, dashboard display) as an opaque string, so Thai + spaces are
  // fine — the backend NAME_PATTERN (widened 2026-05-22) accepts the
  // Thai block + spaces. This replaced the old slugify-to-ASCII rule,
  // which dropped Thai names and forced "first_last" underscores.
  const first = formFirstValue(nv, FORM_FIELD_MAP.name);
  const last  = formFirstValue(nv, FORM_FIELD_MAP.surname);
  const rawName = [first, last].filter(p => p && String(p).trim()).join(" ").replace(/\s+/g, " ").trim();
  if (!rawName) {
    logErr("processFormSubmission: no Name question matched FORM_FIELD_MAP.name", Object.keys(nv));
    return { status: "skipped", reason: "no_name" };
  }
  if (rawName.length > 50) {
    // A real first+last name is well under 50 chars. Anything longer is
    // junk (e.g. a pasted paragraph) — skip rather than truncate it into
    // a garbage 50-char key + folder. (Checked BEFORE the 50-cap so a
    // paste can't slip through truncated.)
    logErr("processFormSubmission: name too long to be a real name, skipped", rawName.slice(0, 80));
    return { status: "skipped", reason: "name_too_long" };
  }
  const name = normalizeName([first, last]);   // Thai + spaces preserved
  if (!NAME_PATTERN.test(name)) {
    // Survives only ASCII/Thai/space/_-. — emoji or other scripts fail.
    logErr("processFormSubmission: name has unsupported characters, skipped",
      { raw: rawName, normalized: name });
    return { status: "skipped", reason: "bad_name" };
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
  let status;
  if (rowIdx > 0) {
    const embCol = snap.headerIndex("Embeddings");
    if (embCol >= 0) {
      const existingEmb = snap.values[rowIdx - 2][embCol];
      if (existingEmb) rowData[rowData.length - 1] = existingEmb;   // keep prior embeddings
    }
    sheet.getRange(rowIdx, 1, 1, rowData.length).setValues([rowData]);
    logInfo("formSubmit intake (update)", { name: name, bib: bib });
    status = "updated";
  } else {
    sheet.appendRow(rowData);
    logInfo("formSubmit intake (insert)", { name: name, bib: bib });
    status = "inserted";
  }

  invalidateRunners();
  return { status: status, name: name };
}

/**
 * Build the Runners.Name key from one or more name parts ("John",
 * "Smith") / ("สมชาย", "ใจดี"): join with a space, collapse runs of
 * whitespace to one, trim, cap at 50. Case + script are PRESERVED, so
 * Thai works ("สมชาย ใจดี") and English keeps its spaces ("John Smith").
 * Validity (allowed charset) is then checked by the caller against
 * NAME_PATTERN — emoji / other scripts are rejected there. The name is
 * an opaque string everywhere downstream (folder, FaceMatcher label,
 * foreign keys, display), so this is safe; see §3.1 + §4.8.
 *
 * NOTE: unlike register.html (which lowercases ASCII names), this keeps
 * the case as typed for nicer display — so an English runner created via
 * the form ("John Smith") and the SAME person re-entered lowercase via
 * register.html ("john smith") would be two distinct keys. Pick one
 * entry path per runner, or keep casing consistent.
 */
function normalizeName(parts) {
  return (Array.isArray(parts) ? parts : [parts])
    .filter(function (p) { return p != null && String(p).trim() !== ""; })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50)
    .trim();
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

/**
 * One-shot: process Form Responses rows the trigger never saw — e.g.
 * submissions made BEFORE the trigger was installed/authorized. The
 * trigger only fires on NEW submissions; it does not reach back over
 * history. This reads the responses tab, rebuilds a namedValues map per
 * row from the header (question-title) row, and runs the same
 * processFormSubmission. Idempotent: a row whose runner already exists
 * in Runners is skipped, so it never re-moves photos already filed.
 * Run from the editor's function dropdown after fixing the trigger.
 *
 * @param {string=} sheetName  Form-responses tab name. OPTIONAL — if
 *   omitted the responses tab is auto-detected (works with localized
 *   names like "การตอบกลับของแบบฟอร์ม 1"). Pass the exact tab name to
 *   override. On failure the error lists every available tab name.
 */
function _backfillExistingResponses(sheetName) {
  const ss = SpreadsheetApp.getActive();
  let sheet;
  if (sheetName) {
    sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('No sheet named "' + sheetName + '". Available tabs: ' + listSheetNames_(ss));
  } else {
    sheet = findResponsesSheet_(ss);
    if (!sheet) {
      throw new Error('Could not auto-detect the form responses tab — pass its exact name, e.g. '
        + '_backfillExistingResponses("การตอบกลับของแบบฟอร์ม 1"). Available tabs: ' + listSheetNames_(ss));
    }
  }
  Logger.log("Backfilling from responses tab: \"" + sheet.getName() + "\"");

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) { Logger.log("No responses to backfill."); return; }
  const headers = data[0];

  // Snapshot existing Runners keys so we skip already-filed runners
  // without re-moving their photos.
  const rsnap = readWholeSheet(getSheet(SHEETS.RUNNERS));
  const existing = {};
  for (let i = 0; i < rsnap.values.length; i++) existing[String(rsnap.values[i][0])] = true;

  let inserted = 0, updated = 0, skipped = 0;
  for (let r = 1; r < data.length; r++) {
    // Rebuild the namedValues shape the trigger would have produced:
    // { "Question title": ["cell value"] }.
    const nv = {};
    for (let c = 0; c < headers.length; c++) nv[headers[c]] = [data[r][c]];

    // Pre-skip if this runner already exists (don't touch their photos).
    const key = normalizeName([
      formFirstValue(nv, FORM_FIELD_MAP.name),
      formFirstValue(nv, FORM_FIELD_MAP.surname),
    ]);
    if (key && existing[key]) { skipped++; continue; }

    try {
      const res = processFormSubmission(nv);
      if (res.status === "inserted") { inserted++; existing[res.name] = true; }
      else if (res.status === "updated") { updated++; }
      else skipped++;
    } catch (e) {
      logErr("_backfillExistingResponses row " + (r + 1), e);
      skipped++;
    }
  }
  Logger.log("Backfill done — inserted: " + inserted + ", updated: " + updated + ", skipped: " + skipped);
}

/**
 * Locate the form-responses tab without relying on its (localized) name.
 * Strategy: prefer the conventional "Form Responses 1"; otherwise sniff
 * each non-app sheet's header row for a column that matches
 * FORM_FIELD_MAP.name — preferring one that ALSO has a photo column.
 * Returns the Sheet or null. Used by _backfillExistingResponses when no
 * explicit tab name is passed.
 */
function findResponsesSheet_(ss) {
  const conventional = ss.getSheetByName("Form Responses 1");
  if (conventional) return conventional;

  const appSheets = {};
  appSheets[SHEETS.RUNNERS] = true;
  appSheets[SHEETS.RESULTS] = true;
  appSheets[SHEETS.VIOLATIONS] = true;

  const sheets = ss.getSheets();
  let nameOnlyMatch = null;
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    if (appSheets[sh.getName()]) continue;
    const lastCol = sh.getLastColumn();
    if (lastCol < 1) continue;
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    // Probe shaped like namedValues so we can reuse formFirstValue's
    // exact-then-substring title matching against the header titles.
    const probe = {};
    for (let c = 0; c < headers.length; c++) probe[String(headers[c])] = [String(headers[c])];
    const hasName = formFirstValue(probe, FORM_FIELD_MAP.name) !== "";
    if (!hasName) continue;
    const hasPhoto = FORM_PHOTO_ANGLES.some(function (a) {
      return formFirstValue(probe, FORM_FIELD_MAP["photo_" + a]) !== "";
    });
    if (hasPhoto) return sh;                 // strongest signal — done
    if (!nameOnlyMatch) nameOnlyMatch = sh;  // fall back to name-only
  }
  return nameOnlyMatch;
}

/** Quoted, comma-separated list of every tab name (for error messages). */
function listSheetNames_(ss) {
  return ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; }).join(", ");
}
