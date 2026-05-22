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
//     1) reads Name / BIB / Email + the face photos from e.namedValues
//        (spreadsheet-bound form-submit event) — either ONE multi-file
//        upload question holding all 5 (tried first) OR five separate
//        per-angle questions (fallback); see FORM_FIELD_MAP,
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
//   PHOTOS: the primary shape is ONE multi-file question
//   (FORM_FIELD_MAP.photos) holding all 5 face photos; the five per-angle
//   questions are a fallback used only if that question matches nothing.
//   The single question's files fill the angle slots positionally (upload
//   order) — fine because embeddings average across all angles (§4.7).
// ============================================================

// Each logical field → the form question title(s) that may carry it.
// First match wins (exact case-insensitive first, then substring).
// Add your form's real question titles here if they differ.
const FORM_FIELD_MAP = Object.freeze({
  // Accepts a COMBINED "ชื่อ-นามสกุล (Name-Surname)" question (whole name
  // in one field) as well as a first-name-only field. resolveRunnerName
  // makes sure a combined field isn't ALSO read as the surname (which would
  // double the name) — see that function + the `surname` note below.
  name:         ["ชื่อ-นามสกุล", "ชื่อ-สกุล", "ชื่อ นามสกุล", "ชื่อ-นามสกุล (Name-Surname)", "Name-Surname", "Full Name", "First Name", "Firstname", "Name", "Username", "ชื่อจริง", "ชื่อ", "ชื่อผู้ใช้", "ชื่อนักวิ่ง"],
  surname:      ["Last Name", "Lastname", "Surname", "นามสกุล", "สกุล"],
  bib:          ["BIB", "Bib Number", "BibNumber", "หมายเลข BIB", "เลข BIB", "เบอร์วิ่ง"],
  email:        ["Email", "E-mail", "อีเมล"],

  // PRIMARY shape — ONE multi-file upload question holding ALL 5 face
  // photos. Tried BEFORE the per-angle questions below. Google packs the
  // uploads into a SINGLE response cell as a comma-separated list of Drive
  // URLs; they carry no per-angle label, so they fill front→…→right
  // positionally in upload order (the label is purely nominal downstream —
  // embeddings average across all 5 regardless; see AI_CONTEXT.md
  // §4.7/§4.8). Set this to your form's EXACT question title (substring
  // also matches). Deliberately excludes the bare word "Photo"/"รูป" so it
  // can't substring-collide with a per-angle "Photo Front" title when the
  // fallback shape is in use.
  photos:       ["Face Photos", "Photos of Faces", "5 Photos of Faces", "Upload Photos", "Photos", "5 Photos", "รูปถ่ายใบหน้า 5 รูป", "รูปถ่ายใบหน้า", "รูปใบหน้า", "อัปโหลดรูปใบหน้า", "ใบหน้า"],

  // FALLBACK shape — five SEPARATE per-angle upload questions (the original
  // layout). Used only when `photos` above matches no uploaded files.
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
  // resolveRunnerName handles BOTH a combined "ชื่อ-นามสกุล" question and
  // separate first/surname fields without doubling the name.
  const nameParts = resolveRunnerName(nv);
  const first = nameParts.first;
  const last  = nameParts.last;
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
    logErr("processFormSubmission: name has unsupported characters, skipped: raw='"
      + rawName + "' normalized='" + name + "'");
    return { status: "skipped", reason: "bad_name" };
  }

  let bib = (formFirstValue(nv, FORM_FIELD_MAP.bib) || "").trim();
  if (bib && !BIB_PATTERN.test(bib)) { logInfo("formSubmit: bib invalid, blanked", bib); bib = ""; }

  let email = (formFirstValue(nv, FORM_FIELD_MAP.email) || "").trim();
  if (email && !EMAIL_PATTERN.test(email)) { logInfo("formSubmit: email invalid, blanked", email); email = ""; }

  // ── 2) Per-person folder (LockService-protected, shared on create) ──
  const root = getRootFolder(RUNNER_FACES_FOLDER);
  const personFolder = getOrCreateFolder(root, name);

  // ── 3) Move + share + rename the face photos; build Photo_* URLs ──
  // Two supported form shapes; the single-question shape is tried first.
  //   (a) PRIMARY — ONE multi-file upload question (FORM_FIELD_MAP.photos)
  //       holding all 5 photos. Google packs them into a single response
  //       cell as comma-separated Drive URLs, so extractDriveFileIds pulls
  //       EVERY ID (extractDriveFileId would see only the first). The files
  //       have no per-angle label, so they fill front→top→bottom→left→right
  //       positionally in upload order — the angle name is purely nominal
  //       (embeddings average across all angles; see §4.7/§4.8). A 6th+
  //       file is still moved into the folder (named generically) so
  //       nothing is orphaned in the shared "(File responses)" folder, but
  //       only the first 5 get a Photo_* column (the schema has exactly 5).
  //   (b) FALLBACK — five SEPARATE per-angle questions (original layout),
  //       used only when (a) matched no files.
  const photoUrls = { front: "", top: "", bottom: "", left: "", right: "" };
  const combinedIds = extractDriveFileIds(formFirstValue(nv, FORM_FIELD_MAP.photos));
  if (combinedIds.length > 0) {
    for (let i = 0; i < combinedIds.length; i++) {
      const angle = (i < FORM_PHOTO_ANGLES.length) ? FORM_PHOTO_ANGLES[i] : ("photo" + (i + 1));
      const url = moveAndShareRunnerPhoto_(personFolder, name, angle, combinedIds[i]);
      if (url && i < FORM_PHOTO_ANGLES.length) photoUrls[angle] = url;
    }
    logInfo("formSubmit photos (single multi-file question)", { name: name, count: combinedIds.length });
  } else {
    for (let i = 0; i < FORM_PHOTO_ANGLES.length; i++) {
      const angle = FORM_PHOTO_ANGLES[i];
      const fileId = extractDriveFileId(formFirstValue(nv, FORM_FIELD_MAP["photo_" + angle]));
      if (!fileId) continue;
      photoUrls[angle] = moveAndShareRunnerPhoto_(personFolder, name, angle, fileId);
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
 * Find the first non-empty answer among any candidate question titles AND
 * report which question title (key) it came from. `namedValues` maps title
 * → array of answers. Tries exact (case-insensitive, trimmed) across all
 * keys first, then substring. `excludeKeys` (optional) lists keys to skip —
 * used so a COMBINED "ชื่อ-นามสกุล (Name-Surname)" question that matches
 * both the name and surname candidates isn't read twice (which would double
 * the name; see resolveRunnerName).
 *
 * Returns { value, key }; { value:"", key:null } when nothing matched.
 */
function formFirstMatch(namedValues, candidates, excludeKeys) {
  const NONE = { value: "", key: null };
  if (!namedValues || !candidates) return NONE;
  const keys = Object.keys(namedValues);
  const excluded = {};
  if (excludeKeys) for (let i = 0; i < excludeKeys.length; i++) excluded[String(excludeKeys[i])] = true;
  // pass 0 = exact (case-insensitive, trimmed); pass 1 = substring (handles
  // "Your Name", "BIB number (1-9999)", …). Same precedence as before: ALL
  // candidates scanned exact, THEN all scanned substring.
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < candidates.length; c++) {
      const want = String(candidates[c]).trim().toLowerCase();
      if (!want) continue;
      for (let k = 0; k < keys.length; k++) {
        if (excluded[keys[k]]) continue;
        const hay = String(keys[k]).trim().toLowerCase();
        if (pass === 0 ? (hay === want) : (hay.indexOf(want) > -1)) {
          const v = firstNonEmpty(namedValues[keys[k]]);
          if (v) return { value: v, key: keys[k] };
        }
      }
    }
  }
  return NONE;
}

/** Convenience wrapper: just the value of formFirstMatch (no exclusions). */
function formFirstValue(namedValues, candidates) {
  return formFirstMatch(namedValues, candidates, null).value;
}

/**
 * Resolve the runner's name parts from a submission, correctly handling a
 * form that puts the WHOLE name in ONE question ("ชื่อ-นามสกุล
 * (Name-Surname)") as well as a form with separate first/surname fields.
 *
 * A combined field matches BOTH FORM_FIELD_MAP.name and .surname (it holds
 * both "name" and "surname" / "ชื่อ" and "นามสกุล"), so reading them
 * independently used to grab the SAME column twice and double the name
 * ("John Smith John Smith" → "too long"/garbage, the original backfill
 * bug). Fix: resolve the name first, then look up the surname EXCLUDING the
 * name's own column — a combined field yields first=<full name>, last=""
 * (no phantom surname); a genuinely separate surname column is still found.
 */
function resolveRunnerName(nv) {
  const nameMatch = formFirstMatch(nv, FORM_FIELD_MAP.name, null);
  const surnameMatch = formFirstMatch(nv, FORM_FIELD_MAP.surname,
    nameMatch.key ? [nameMatch.key] : null);
  return { first: nameMatch.value, last: surnameMatch.value };
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
 * Extract EVERY Drive file ID from a single Form answer. A multi-file
 * upload question stores all of its uploaded files in ONE response cell as
 * a comma-separated list of Drive URLs
 * ("https://drive.google.com/open?id=ID1, …?id=ID2, …"), so the
 * single-match extractDriveFileId (Code.gs) would only ever see the FIRST
 * file. Returns a de-duplicated, order-preserving array (possibly empty);
 * order matters — it becomes the front→…→right angle assignment upstream.
 *
 * Accepts the raw answer as a string OR an array of strings (joined first),
 * so it is robust to either namedValues representation.
 */
function extractDriveFileIds(answer) {
  if (answer == null) return [];
  const s = Array.isArray(answer) ? answer.join(",") : String(answer);
  // One global pass over the three URL forms extractDriveFileId knows:
  //   ?id=<id> / &id=<id>,  /file/d/<id>,  /d/<id> (lh3 + bare). Ordered so
  //   the longer /file/d/ wins before the looser /d/ at the same position.
  const re = /(?:[?&]id=|\/file\/d\/|\/d\/)([-\w]{25,})/g;
  const ids = [];
  const seen = {};
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
  }
  return ids;
}

/**
 * Move ONE uploaded photo out of the Form's shared "(File responses)"
 * folder into RunnerFaces/<name>/, rename it <name>_<angle>_<ts>.jpg, and
 * share it ANYONE_WITH_LINK/VIEW so its lh3 Photo_* URL renders
 * (Guardrail 11). Returns the thumbnail URL, or "" on any failure.
 *
 * Per-photo isolation (Guardrail 2 spirit): a single bad file is logged
 * and swallowed so it never blocks the other photos or the sheet write.
 * Shared by both the single-question and per-angle intake paths.
 */
function moveAndShareRunnerPhoto_(personFolder, name, angle, fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    file.moveTo(personFolder);                 // out of "(File responses)"
    file.setName(name + "_" + angle + "_" + Date.now() + ".jpg");
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (se) {
      logErr("formSubmit setSharing " + angle, se);   // non-fatal if folder is shared
    }
    return DRIVE_THUMBNAIL_URL(fileId, 800);
  } catch (fe) {
    logErr("formSubmit move/share photo " + angle + " (" + fileId + ")", fe);
    return "";
  }
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
    const rn = resolveRunnerName(nv);
    const key = normalizeName([rn.first, rn.last]);
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
    const hasPhoto = formFirstValue(probe, FORM_FIELD_MAP.photos) !== ""
      || FORM_PHOTO_ANGLES.some(function (a) {
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

/**
 * True iff `name` is exactly two identical halves split by one space
 * ("John Smith John Smith") — the artifact of the pre-2026-05-22
 * combined-"Name-Surname" doubling bug.
 */
function isDoubledName_(name) {
  if (!name || name.length % 2 === 0) return false;   // "<p> <p>" has odd length
  const half = (name.length - 1) / 2;
  if (name.charAt(half) !== " ") return false;
  const a = name.slice(0, half), b = name.slice(half + 1);
  return a.length > 0 && a === b;
}

/**
 * One-shot cleanup for the doubled-name rows created BEFORE the 2026-05-22
 * combined-"Name-Surname" fix (see AI_CONTEXT.md). Finds Runners rows whose
 * Name is exactly "X X" (two identical halves) and, when commit===true,
 * trashes that runner's RunnerFaces/<name> folder and deletes the row.
 *
 * ⚠️ RUN ORDER MATTERS:
 *   1) deploy the fix, 2) run _backfillExistingResponses() FIRST — it
 *   recreates each runner under the CORRECT single name and MOVES the photos
 *   out of the doubled folder by file ID, leaving it empty — 3) THEN run
 *   this. Running it before the re-backfill would trash folders that still
 *   hold the only copy of the photos.
 *
 * DRY RUN by default: _cleanupDoubledRunnerNames() only LOGS what it would
 * remove. Review that list, then delete for real with
 * _cleanupDoubledRunnerNames(true).
 */
function _cleanupDoubledRunnerNames(commit) {
  const sheet = getSheet(SHEETS.RUNNERS);
  const snap = readWholeSheet(sheet);
  const hits = [];
  for (let i = 0; i < snap.values.length; i++) {
    const name = String(snap.values[i][0] || "").trim();
    if (isDoubledName_(name)) hits.push({ rowNum: i + 2, name: name });   // +2: header + 1-based
  }
  if (!hits.length) { Logger.log("No doubled-name rows found — nothing to clean."); return; }

  Logger.log((commit ? "DELETING " : "[DRY RUN] would delete ") + hits.length + " doubled-name row(s):");
  for (let i = 0; i < hits.length; i++) Logger.log("  • " + hits[i].name);
  if (!commit) {
    Logger.log("Dry run only. After confirming the list (and AFTER running "
      + "_backfillExistingResponses so the photos have moved out), delete for real with: "
      + "_cleanupDoubledRunnerNames(true)");
    return;
  }

  // Trash folders (best-effort) first, then delete rows BOTTOM-UP so the
  // row indices don't shift mid-loop.
  const root = getRootFolder(RUNNER_FACES_FOLDER);
  for (let i = 0; i < hits.length; i++) {
    try {
      const it = root.getFoldersByName(hits[i].name);
      while (it.hasNext()) it.next().setTrashed(true);
    } catch (e) { logErr("cleanup trash folder " + hits[i].name, e); }
  }
  hits.sort(function (a, b) { return b.rowNum - a.rowNum; });
  for (let i = 0; i < hits.length; i++) sheet.deleteRow(hits[i].rowNum);
  invalidateRunners();
  Logger.log("Cleanup done — removed " + hits.length + " doubled-name row(s) + their folders.");
}

/**
 * One-shot: trash EMPTY doubled-name folders directly under RunnerFaces —
 * the "ธนาภา ปิ่นทอง ธนาภา ปิ่นทอง" artifacts left by the pre-2026-05-22
 * doubling bug. A folder is trashed ONLY when its name isDoubledName_ AND it
 * is EMPTY (no files, no subfolders) — a doubled folder that still holds the
 * only copy of someone's photos is KEPT, so this can never delete a photo.
 * (To empty such a folder first, run _backfillExistingResponses: it moves
 * the photos by file ID into the correct single-name folder.)
 *
 * DRY RUN by default — _cleanupEmptyDoubledFolders() only LOGS what it would
 * remove + what it kept. Delete for real with
 * _cleanupEmptyDoubledFolders(true).
 */
function _cleanupEmptyDoubledFolders(commit) {
  const root = getRootFolder(RUNNER_FACES_FOLDER);
  const folders = root.getFolders();
  const toTrash = [];
  let doubledSeen = 0, keptNonEmpty = 0;
  while (folders.hasNext()) {
    const f = folders.next();
    const nm = String(f.getName()).trim();
    if (!isDoubledName_(nm)) continue;
    doubledSeen++;
    const isEmpty = !f.getFiles().hasNext() && !f.getFolders().hasNext();
    if (isEmpty) {
      toTrash.push(f);
      Logger.log((commit ? "TRASH " : "[dry run] would trash ") + "empty doubled folder: " + nm);
    } else {
      keptNonEmpty++;
      Logger.log("KEEP (still has photos): " + nm + "  ← run _backfillExistingResponses to move them out first");
    }
  }
  if (!doubledSeen) { Logger.log("No doubled-name folders found under RunnerFaces — nothing to clean."); return; }
  if (!commit) {
    Logger.log("[DRY RUN] " + toTrash.length + " empty doubled folder(s) would be trashed; "
      + keptNonEmpty + " non-empty kept. To delete for real run: _cleanupEmptyDoubledFolders(true)");
    return;
  }
  let trashed = 0;
  for (let i = 0; i < toTrash.length; i++) {
    try { toTrash[i].setTrashed(true); trashed++; }
    catch (e) { logErr("trash folder " + toTrash[i].getName(), e); }
  }
  Logger.log("Done — trashed " + trashed + " empty doubled folder(s); kept " + keptNonEmpty + " that still have photos.");
}

/**
 * No-arg wrapper so the editor's Run button (which can't pass arguments) can
 * DELETE for real. Run the dry-run _cleanupEmptyDoubledFolders() first to
 * preview, then select THIS function and Run to actually trash the empty
 * doubled folders.
 */
function _cleanupEmptyDoubledFoldersCommit() {
  _cleanupEmptyDoubledFolders(true);
}
