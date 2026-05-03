// ============================================================
// AI Runner Timing System — Google Apps Script Backend (v4)
// ============================================================
// Deploy: Extensions → Apps Script → Deploy → Web app
//   Execute as: Me | Access: Anyone with the link
//
// FIRST-TIME SETUP (run from the editor's function dropdown):
//   1) _setupAdminToken()                  — stores admin password
//   2) _consolidateDuplicateRootFolders()  — merges duplicate Drive folders
//   3) _migrateAllImageUrls()              — rewrites old viewer URLs
// All three are idempotent — re-running is safe.
//
// What's new in v4:
//   • Read-through CacheService for getRunners/getResults/getViolations
//     — typical response is now a single in-memory hit (sub-100 ms).
//   • Writes invalidate the relevant cache keys so admin actions are
//     visible to the dashboard immediately (no 12 s polling lag).
//   • Drive folder cleanup on deleteRunner runs out-of-band via a
//     time-driven trigger so the admin UI returns instantly.
// ============================================================

// ─── CONSTANTS ──────────────────────────────────────────────
const RUNNER_FACES_FOLDER = "RunnerFaces";
const VIOLATION_FOLDER = "ViolationEvidence";
const DEFAULT_ADMIN_TOKEN = "muto67";
const LOCK_TIMEOUT_MS = 10000;

// Cache settings — values must fit under CacheService's 100 KB
// per-key limit, otherwise putCachedJson skips the write and the
// endpoint falls through to the spreadsheet read on every call.
const CACHE_TTL_SEC = 12;
const CACHE_MAX_BYTES = 90 * 1024;
const CACHE_KEYS = Object.freeze({
  RUNNERS: "CACHE_RUNNERS",
  RESULTS: "CACHE_RESULTS",
  VIOLATIONS: "CACHE_VIOLATIONS",
  VIOLATIONS_VERIFIED: "CACHE_VIOLATIONS_VERIFIED",
});

// Async Drive deletion — queue stored in ScriptProperties, drained
// by a self-cleaning trigger so admin requests return immediately.
const DRIVE_DELETE_QUEUE_KEY = "DRIVE_DELETE_QUEUE";
const DRIVE_DELETE_TRIGGER = "_processDriveDeleteQueue";
const DRIVE_DELETE_DELAY_MS = 2000;

const SHEETS = Object.freeze({
  RUNNERS: "Runners",
  RESULTS: "Results",
  VIOLATIONS: "Violations",
});

const SCHEMA = Object.freeze({
  Runners: ["Name", "BibNumber", "Email", "RegisteredAt",
    "Photo_Front", "Photo_Top", "Photo_Bottom", "Photo_Left", "Photo_Right",
    "FolderUrl", "Embeddings"],
  Results: ["Name", "BibNumber", "Start_Time", "CP1_Time", "CP2_Time",
    "CP3_Time", "CP4_Time", "Finish_Time", "Total_Duration", "UpdatedAt"],
  Violations: ["ID", "Name", "BibNumber", "Message", "ImageUrl",
    "Timestamp", "Verified", "VerifiedAt"],
});

const TIME_COLUMNS = Object.freeze(
  ["Start_Time", "CP1_Time", "CP2_Time", "CP3_Time", "CP4_Time", "Finish_Time"]
);

// ─── INPUT VALIDATION PATTERNS ──────────────────────────────
const NAME_PATTERN = /^[a-zA-Z0-9_\-.]{1,50}$/;
const BIB_PATTERN = /^[a-zA-Z0-9]{1,10}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── LOGGING ────────────────────────────────────────────────
function logInfo(msg, data) {
  Logger.log("INFO  " + msg + (data !== undefined ? " — " + safeStringify(data) : ""));
}
function logErr(msg, err) {
  const detail = err && err.stack ? err.stack : String(err);
  Logger.log("ERROR " + msg + " — " + detail);
}
function safeStringify(v) {
  try { return JSON.stringify(v).slice(0, 500); }
  catch (e) { return String(v).slice(0, 500); }
}

// ─── RESPONSE HELPERS ───────────────────────────────────────
function jsonOk(data) {
  const payload = Object.assign({ status: "success" }, data || {});
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonErr(message, code) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: "error",
      code: code || "internal_error",
      message: String(message || "Unknown error"),
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
// Returns a pre-serialized JSON payload directly. Used by the cache
// layer so we don't double-encode.
function rawJson(jsonStr) {
  return ContentService
    .createTextOutput(jsonStr)
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── CACHE HELPERS ──────────────────────────────────────────
function cache() { return CacheService.getScriptCache(); }

function getCached(key) {
  try { return cache().get(key); }
  catch (e) { logErr("cache.get(" + key + ")", e); return null; }
}
function putCached(key, jsonStr) {
  try {
    if (jsonStr.length > CACHE_MAX_BYTES) {
      logInfo("cache skip (too large)", { key: key, bytes: jsonStr.length });
      return;
    }
    cache().put(key, jsonStr, CACHE_TTL_SEC);
  } catch (e) {
    logErr("cache.put(" + key + ")", e);
  }
}
function invalidateCache(keys) {
  if (!keys || !keys.length) return;
  try { cache().removeAll(keys); }
  catch (e) { logErr("cache.removeAll", e); }
}
function invalidateRunners()   { invalidateCache([CACHE_KEYS.RUNNERS]); }
function invalidateResults()   { invalidateCache([CACHE_KEYS.RESULTS]); }
function invalidateViolations() {
  invalidateCache([CACHE_KEYS.VIOLATIONS, CACHE_KEYS.VIOLATIONS_VERIFIED]);
}

/**
 * Read-through cache wrapper for GET endpoints.
 *
 *   1. If `cacheKey` is in cache → return that bytes-for-bytes.
 *   2. Otherwise call `supplier()`, build the standard
 *      {status:"success", data:[…]} envelope, cache & return it.
 *
 * `supplier` returns the array that goes under `data`. It is only
 * invoked on cache miss — the spreadsheet is never touched on a hit.
 */
function cachedJson(cacheKey, supplier) {
  const hit = getCached(cacheKey);
  if (hit !== null) {
    logInfo("cache hit", { key: cacheKey, bytes: hit.length });
    return rawJson(hit);
  }
  const data = supplier();
  const payload = JSON.stringify({ status: "success", data: data });
  putCached(cacheKey, payload);
  logInfo("cache miss → fill", { key: cacheKey, bytes: payload.length });
  return rawJson(payload);
}

// ─── ADMIN AUTH ─────────────────────────────────────────────
function getAdminToken() {
  const t = PropertiesService.getScriptProperties().getProperty("ADMIN_TOKEN");
  return t || DEFAULT_ADMIN_TOKEN;
}
function requireAdmin(body) {
  if (!body || body.token !== getAdminToken()) {
    throw httpError("Unauthorized", "unauthorized");
  }
}

// ─── INPUT VALIDATION ───────────────────────────────────────
function reqStr(v, name, pattern, maxLen) {
  if (v == null || v === "") throw httpError(name + " is required", "bad_request");
  const s = String(v).trim();
  if (maxLen && s.length > maxLen) throw httpError(name + " exceeds " + maxLen + " chars", "bad_request");
  if (pattern && !pattern.test(s)) throw httpError(name + " has invalid format", "bad_request");
  return s;
}
function optStr(v, pattern, maxLen) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  if (maxLen && s.length > maxLen) throw httpError("value exceeds " + maxLen + " chars", "bad_request");
  if (pattern && !pattern.test(s)) throw httpError("invalid format", "bad_request");
  return s;
}
function httpError(msg, code) {
  const e = new Error(msg);
  e.code = code || "bad_request";
  return e;
}

// ─── TIME / DURATION HELPERS ────────────────────────────────
function parseTimeToSeconds(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
  }
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10);
}
function calcDuration(cp1, cp2) {
  const sec1 = parseTimeToSeconds(cp1);
  const sec2 = parseTimeToSeconds(cp2);
  if (sec1 == null || sec2 == null) return "";
  let diff = sec2 - sec1;
  if (diff < 0) diff += 86400;
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return mins + ":" + String(secs).padStart(2, "0");
}
function normalizeTimeStr(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return pad(v.getHours()) + ":" + pad(v.getMinutes()) + ":" + pad(v.getSeconds());
  }
  return String(v);
}
function normalizeRowTimeCols(row, snap) {
  for (let i = 0; i < TIME_COLUMNS.length; i++) {
    const idx = snap.headerIndex(TIME_COLUMNS[i]);
    if (idx >= 0) row[idx] = normalizeTimeStr(row[idx]);
  }
}

// ─── SPREADSHEET HELPERS ────────────────────────────────────
function getSheet(name) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      const headers = SCHEMA[name];
      if (headers) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        if (name === SHEETS.RESULTS) {
          sheet.getRange("C:I").setNumberFormat("@");
        }
      }
    }
    return sheet;
  } catch (e) {
    logErr("getSheet(" + name + ")", e);
    throw httpError("Spreadsheet access failed: " + e.message, "spreadsheet_error");
  }
}

// Single-read snapshot — much cheaper than re-querying for every lookup.
// Row finders use Array.findIndex on the in-memory copy (no per-cell
// API calls), then return the 1-indexed sheet row.
function readWholeSheet(sheet) {
  const all = sheet.getDataRange().getValues();
  return {
    headers: all[0] || [],
    values: all.slice(1),
    headerIndex: function (col) {
      for (let i = 0; i < this.headers.length; i++) {
        if (this.headers[i] === col) return i;
      }
      return -1;
    },
    findRowByName: function (name) {
      const target = String(name);
      const i = this.values.findIndex(function (row) { return String(row[0]) === target; });
      return i >= 0 ? i + 2 : -1; // +1 header, +1 1-indexed
    },
    findRowById: function (id) {
      const target = String(id);
      const i = this.values.findIndex(function (row) { return String(row[0]) === target; });
      return i >= 0 ? i + 2 : -1;
    },
  };
}

// JSON projection for read-only endpoints. getDisplayValues so any
// Date-typed cells round-trip as their formatted string.
function readSheetAsJson(sheet) {
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const rows = new Array(data.length - 1);
  for (let i = 1; i < data.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = data[i][j];
    rows[i - 1] = obj;
  }
  return rows;
}

// ─── DRIVE HELPERS ──────────────────────────────────────────
const DRIVE_EMBED_URL = function (id) {
  return "https://drive.google.com/uc?export=view&id=" + id;
};

function getOrCreateFolder(parentFolder, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const it = parentFolder.getFoldersByName(name);
    let folder;
    if (it.hasNext()) {
      folder = it.next();
      if (it.hasNext()) {
        logInfo("Duplicate folder detected; using first. Run _consolidateDuplicateRootFolders().",
          { parent: parentFolder.getName(), name: name, id: folder.getId() });
      }
    } else {
      folder = parentFolder.createFolder(name);
      try {
        folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (e) {
        logErr("setSharing failed for new folder '" + name + "'", e);
      }
    }
    return folder;
  } finally {
    lock.releaseLock();
  }
}

function getRootFolder(name) {
  return getOrCreateFolder(DriveApp.getRootFolder(), name);
}

function saveBase64Image(folder, filename, base64Data) {
  if (!base64Data || typeof base64Data !== "string") {
    throw httpError("Image data missing", "bad_request");
  }
  let raw = base64Data;
  const commaIdx = raw.indexOf(",");
  if (commaIdx > -1) raw = raw.substring(commaIdx + 1);
  let decoded;
  try {
    decoded = Utilities.base64Decode(raw);
  } catch (e) {
    throw httpError("Image data is not valid base64", "bad_request");
  }
  let file;
  try {
    const blob = Utilities.newBlob(decoded, "image/jpeg", filename);
    file = folder.createFile(blob);
  } catch (e) {
    logErr("Drive createFile failed for " + filename, e);
    throw httpError("Failed to upload image: " + e.message, "drive_error");
  }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    logErr("setSharing failed for file " + filename, e);
  }
  return DRIVE_EMBED_URL(file.getId());
}

// ─── ASYNC DRIVE DELETION QUEUE ─────────────────────────────
// Apps Script has no true async, but a one-shot time-based trigger
// runs in a separate execution. We push the runner name to a
// ScriptProperties-backed queue and schedule the trigger to drain it.
// The original request returns immediately; cleanup happens ~2 s later.
function queueDriveDelete(personName) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    // Couldn't queue — fall through to inline cleanup so we don't lose work.
    try { trashRunnerFolder(personName); }
    catch (e) { logErr("inline trashRunnerFolder fallback", e); }
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(DRIVE_DELETE_QUEUE_KEY) || "[]";
    let queue;
    try { queue = JSON.parse(raw); } catch (e) { queue = []; }
    if (!Array.isArray(queue)) queue = [];
    if (queue.indexOf(personName) < 0) queue.push(personName);
    props.setProperty(DRIVE_DELETE_QUEUE_KEY, JSON.stringify(queue));

    // Avoid stacking multiple triggers (max 20 per script).
    const existing = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === DRIVE_DELETE_TRIGGER;
    });
    if (!existing) {
      ScriptApp.newTrigger(DRIVE_DELETE_TRIGGER).timeBased().after(DRIVE_DELETE_DELAY_MS).create();
      logInfo("scheduled drive delete trigger", { name: personName });
    }
  } catch (e) {
    logErr("queueDriveDelete", e);
  } finally {
    lock.releaseLock();
  }
}

/** Trigger entrypoint — drains the queue, then deletes itself. */
function _processDriveDeleteQueue() {
  // Loop so any entries enqueued WHILE we were processing get picked up
  // before the trigger self-deletes (avoids losing late additions).
  while (true) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      // Couldn't grab the lock — leave the trigger in place so the next
      // tick (or re-scheduling) handles it.
      return;
    }
    let batch;
    try {
      const props = PropertiesService.getScriptProperties();
      const raw = props.getProperty(DRIVE_DELETE_QUEUE_KEY) || "[]";
      try { batch = JSON.parse(raw); } catch (e) { batch = []; }
      if (!Array.isArray(batch)) batch = [];
      if (!batch.length) {
        // Queue empty → safe to retire this trigger.
        deleteDriveDeleteTriggers();
        return;
      }
      props.setProperty(DRIVE_DELETE_QUEUE_KEY, "[]");
    } finally {
      lock.releaseLock();
    }
    // Process outside the lock so concurrent admin actions aren't blocked.
    for (let i = 0; i < batch.length; i++) {
      try { trashRunnerFolder(batch[i]); }
      catch (e) { logErr("trashRunnerFolder(" + batch[i] + ")", e); }
    }
  }
}

function deleteDriveDeleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === DRIVE_DELETE_TRIGGER) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function trashRunnerFolder(personName) {
  const root = DriveApp.getRootFolder();
  const runnerRoots = root.getFoldersByName(RUNNER_FACES_FOLDER);
  let trashed = 0;
  while (runnerRoots.hasNext()) {
    const rf = runnerRoots.next();
    const personFolders = rf.getFoldersByName(personName);
    while (personFolders.hasNext()) {
      const pf = personFolders.next();
      pf.setTrashed(true);
      trashed++;
    }
  }
  logInfo("trashRunnerFolder", { name: personName, trashed: trashed });
}

// ─── GET HANDLER (cache-fronted) ────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";
  try {
    switch (action) {
      case "getResults":
        return cachedJson(CACHE_KEYS.RESULTS, function () {
          return readSheetAsJson(getSheet(SHEETS.RESULTS));
        });

      case "getRunners":
        return cachedJson(CACHE_KEYS.RUNNERS, function () {
          return readSheetAsJson(getSheet(SHEETS.RUNNERS));
        });

      case "getViolations":
        return cachedJson(CACHE_KEYS.VIOLATIONS, function () {
          const all = readSheetAsJson(getSheet(SHEETS.VIOLATIONS));
          all.sort(function (a, b) { return String(b.Timestamp).localeCompare(String(a.Timestamp)); });
          return all.slice(0, 20);
        });

      case "getVerifiedViolations":
        return cachedJson(CACHE_KEYS.VIOLATIONS_VERIFIED, function () {
          const all = readSheetAsJson(getSheet(SHEETS.VIOLATIONS));
          const verified = all.filter(function (v) {
            return String(v.Verified).toLowerCase() === "true";
          });
          verified.sort(function (a, b) { return String(b.Timestamp).localeCompare(String(a.Timestamp)); });
          return verified.slice(0, 20);
        });

      default:
        return jsonErr("Unknown action: " + action, "bad_request");
    }
  } catch (err) {
    logErr("doGet[" + action + "]", err);
    return jsonErr(err.message, err.code);
  }
}

// ─── POST HANDLER ───────────────────────────────────────────
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    logErr("doPost — JSON parse", err);
    return jsonErr("Body is not valid JSON", "bad_request");
  }
  const action = body.action || "";
  try {
    switch (action) {
      case "verifyAdmin": {
        const ok = String(body.password || "") === getAdminToken();
        return ok ? jsonOk({}) : jsonErr("Invalid password", "unauthorized");
      }
      case "registerRunner":   return handleRegisterRunner(body);
      case "recordCheckpoint": return handleRecordCheckpoint(body);
      case "reportViolation":  return handleReportViolation(body);
      case "verifyViolation":  return handleVerifyViolation(body);
      case "deleteViolation":  return handleDeleteViolation(body);
      case "deleteRunner":     return handleDeleteRunner(body);
      case "updateRunner":     return handleUpdateRunner(body);
      default:
        return jsonErr("Unknown action: " + action, "bad_request");
    }
  } catch (err) {
    logErr("doPost[" + action + "]", err);
    return jsonErr(err.message, err.code);
  }
}

// ─── ACTION HANDLERS ────────────────────────────────────────

function handleRegisterRunner(body) {
  const name = reqStr(body.name, "name", NAME_PATTERN, 50);
  const bib = optStr(body.bib, BIB_PATTERN, 10);
  const email = optStr(body.email, null, 200);
  if (email && !EMAIL_PATTERN.test(email)) throw httpError("email has invalid format", "bad_request");
  const timestamp = optStr(body.timestamp, null, 50) || new Date().toISOString();

  const root = getRootFolder(RUNNER_FACES_FOLDER);
  const personFolder = getOrCreateFolder(root, name);

  const angles = ["front", "top", "bottom", "left", "right"];
  const photoUrls = { front: "", top: "", bottom: "", left: "", right: "" };
  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    const key = "photo_" + angle;
    if (body[key]) {
      const filename = name + "_" + angle + "_" + Date.now() + ".jpg";
      photoUrls[angle] = saveBase64Image(personFolder, filename, body[key]);
    }
  }

  let embStr = "";
  if (body.embeddings) {
    embStr = typeof body.embeddings === "string"
      ? body.embeddings
      : JSON.stringify(body.embeddings);
  }

  const sheet = getSheet(SHEETS.RUNNERS);
  const snap = readWholeSheet(sheet);
  const rowIdx = snap.findRowByName(name);
  const rowData = [
    name, bib, email, timestamp,
    photoUrls.front, photoUrls.top, photoUrls.bottom,
    photoUrls.left, photoUrls.right,
    personFolder.getUrl(), embStr,
  ];
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }

  invalidateRunners();
  logInfo("registerRunner", { name: name, bib: bib });
  return jsonOk({ message: "Runner " + name + " registered", folderUrl: personFolder.getUrl() });
}

function handleRecordCheckpoint(body) {
  const name = reqStr(body.name, "name", NAME_PATTERN, 50);
  const cpId = body.checkpoint_id;
  if (cpId == null) throw httpError("checkpoint_id is required", "bad_request");
  const timestamp = reqStr(body.timestamp, "timestamp", TIME_PATTERN, 8);
  const bib = optStr(body.bib, BIB_PATTERN, 10);

  const colName = cpId === "start" ? "Start_Time"
    : cpId === "finish" ? "Finish_Time"
    : "CP" + cpId + "_Time";

  const sheet = getSheet(SHEETS.RESULTS);
  const snap = readWholeSheet(sheet);
  const colIdx = snap.headerIndex(colName);
  if (colIdx < 0) throw httpError("Column not found: " + colName, "schema_error");
  const startCol = snap.headerIndex("Start_Time");
  const finishCol = snap.headerIndex("Finish_Time");
  const durCol = snap.headerIndex("Total_Duration");
  const updCol = snap.headerIndex("UpdatedAt");
  const bibCol = snap.headerIndex("BibNumber");

  const rowIdx = snap.findRowByName(name);

  if (rowIdx < 0) {
    const newRow = new Array(snap.headers.length).fill("");
    newRow[0] = name;
    if (bibCol >= 0) newRow[bibCol] = bib;
    newRow[colIdx] = timestamp;
    if (updCol >= 0) newRow[updCol] = new Date().toISOString();
    sheet.appendRow(newRow);
    logInfo("recordCheckpoint (new)", { name: name, cp: colName });
  } else {
    const range = sheet.getRange(rowIdx, 1, 1, snap.headers.length);
    const row = range.getValues()[0];
    row[colIdx] = timestamp;
    if (bib && bibCol >= 0) row[bibCol] = bib;
    if (durCol >= 0 && row[startCol] && row[finishCol]) {
      row[durCol] = calcDuration(row[startCol], row[finishCol]);
    }
    if (updCol >= 0) row[updCol] = new Date().toISOString();
    normalizeRowTimeCols(row, snap);
    range.setValues([row]);
    logInfo("recordCheckpoint (update)", { name: name, cp: colName });
  }

  invalidateResults();
  return jsonOk({ message: name + " " + colName + " recorded" });
}

function handleReportViolation(body) {
  const name = optStr(body.name, NAME_PATTERN, 50) || "Unknown";
  const bib = optStr(body.bib, BIB_PATTERN, 10);
  const message = optStr(body.message, null, 500);
  const timestamp = optStr(body.timestamp, null, 50) || new Date().toISOString();
  const imageBase64 = body.image || "";

  let imageUrl = "";
  if (imageBase64) {
    const folder = getRootFolder(VIOLATION_FOLDER);
    const filename = "violation_" + name + "_" + Date.now() + ".jpg";
    imageUrl = saveBase64Image(folder, filename, imageBase64);
  }

  const id = "V" + Date.now();
  getSheet(SHEETS.VIOLATIONS).appendRow([id, name, bib, message, imageUrl, timestamp, false, ""]);

  invalidateViolations();
  logInfo("reportViolation", { id: id, name: name });
  return jsonOk({ id: id, message: "Violation reported" });
}

function handleVerifyViolation(body) {
  requireAdmin(body);
  const id = reqStr(body.id, "id", null, 30);
  const sheet = getSheet(SHEETS.VIOLATIONS);
  const snap = readWholeSheet(sheet);
  const rowIdx = snap.findRowById(id);
  if (rowIdx < 0) throw httpError("Violation not found", "not_found");

  const verifiedCol = snap.headerIndex("Verified");
  const verifiedAtCol = snap.headerIndex("VerifiedAt");
  if (verifiedCol < 0 || verifiedAtCol < 0) throw httpError("Schema missing Verified columns", "schema_error");

  if (verifiedAtCol === verifiedCol + 1) {
    sheet.getRange(rowIdx, verifiedCol + 1, 1, 2).setValues([[true, new Date().toISOString()]]);
  } else {
    sheet.getRange(rowIdx, verifiedCol + 1).setValue(true);
    sheet.getRange(rowIdx, verifiedAtCol + 1).setValue(new Date().toISOString());
  }

  invalidateViolations();
  logInfo("verifyViolation", { id: id });
  return jsonOk({ message: "Violation verified" });
}

function handleDeleteViolation(body) {
  requireAdmin(body);
  const id = reqStr(body.id, "id", null, 30);
  const sheet = getSheet(SHEETS.VIOLATIONS);
  // Single getValues() then findIndex — no per-cell API lookups.
  const snap = readWholeSheet(sheet);
  const rowIdx = snap.findRowById(id);
  if (rowIdx < 0) throw httpError("Violation not found", "not_found");
  sheet.deleteRow(rowIdx);

  invalidateViolations();
  logInfo("deleteViolation", { id: id });
  return jsonOk({ message: "Violation deleted" });
}

function handleDeleteRunner(body) {
  requireAdmin(body);
  const name = reqStr(body.name, "name", NAME_PATTERN, 50);

  // Both sheets: in-memory findIndex, delete on hit, no further loop.
  const rSheet = getSheet(SHEETS.RUNNERS);
  const rRow = readWholeSheet(rSheet).findRowByName(name);
  if (rRow > 0) rSheet.deleteRow(rRow);

  const resSheet = getSheet(SHEETS.RESULTS);
  const resRow = readWholeSheet(resSheet).findRowByName(name);
  if (resRow > 0) resSheet.deleteRow(resRow);

  invalidateRunners();
  invalidateResults();

  // Drive cleanup runs out-of-band so the admin sees an instant response.
  // The folder is moved to trash by a one-shot trigger ~2 s later.
  queueDriveDelete(name);

  logInfo("deleteRunner", { name: name });
  return jsonOk({ message: "Runner " + name + " deleted" });
}

function handleUpdateRunner(body) {
  requireAdmin(body);
  const name = reqStr(body.name, "name", NAME_PATTERN, 50);

  const sheet = getSheet(SHEETS.RESULTS);
  const snap = readWholeSheet(sheet);
  let rowIdx = snap.findRowByName(name);

  if (rowIdx < 0) {
    const newRow = new Array(snap.headers.length).fill("");
    newRow[0] = name;
    const bibCol = snap.headerIndex("BibNumber");
    if (bibCol >= 0) newRow[bibCol] = optStr(body.bib, BIB_PATTERN, 10);
    sheet.appendRow(newRow);
    rowIdx = sheet.getLastRow();
  }

  const range = sheet.getRange(rowIdx, 1, 1, snap.headers.length);
  const row = range.getValues()[0];

  for (let i = 0; i < TIME_COLUMNS.length; i++) {
    const f = TIME_COLUMNS[i];
    if (body[f] !== undefined) {
      const v = optStr(body[f], TIME_PATTERN, 8);
      const c = snap.headerIndex(f);
      if (c >= 0) row[c] = v;
    }
  }

  const startCol = snap.headerIndex("Start_Time");
  const finishCol = snap.headerIndex("Finish_Time");
  const durCol = snap.headerIndex("Total_Duration");
  if (startCol >= 0 && finishCol >= 0 && durCol >= 0 && row[startCol] && row[finishCol]) {
    row[durCol] = calcDuration(row[startCol], row[finishCol]);
  }
  const updCol = snap.headerIndex("UpdatedAt");
  if (updCol >= 0) row[updCol] = new Date().toISOString();

  normalizeRowTimeCols(row, snap);
  range.setValues([row]);

  invalidateResults();
  logInfo("updateRunner", { name: name });
  return jsonOk({ message: "Runner " + name + " updated" });
}

// ============================================================
// ONE-OFF ADMIN HELPERS — run from the editor's function dropdown.
// All idempotent: safe to re-run.
// ============================================================

/** Stores the admin password. Edit the literal below before running. */
function _setupAdminToken() {
  const pw = "muto67";
  PropertiesService.getScriptProperties().setProperty("ADMIN_TOKEN", pw);
  Logger.log("Admin token set.");
}

/**
 * Folds duplicate top-level Drive folders (e.g. multiple "RunnerFaces"
 * created by races before the lock fix) into a single canonical folder.
 */
function _consolidateDuplicateRootFolders() {
  const targets = [RUNNER_FACES_FOLDER, VIOLATION_FOLDER];
  for (let t = 0; t < targets.length; t++) {
    const name = targets[t];
    try {
      const root = DriveApp.getRootFolder();
      const matches = [];
      const it = root.getFoldersByName(name);
      while (it.hasNext()) matches.push(it.next());

      if (matches.length === 0) {
        Logger.log("[" + name + "] no folder found.");
        continue;
      }
      if (matches.length === 1) {
        Logger.log("[" + name + "] 1 folder; ensuring sharing.");
        try { matches[0].setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
        catch (e) { logErr("setSharing failed for " + name, e); }
        continue;
      }

      matches.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
      const canonical = matches[0];
      Logger.log("[" + name + "] " + matches.length + " duplicates found, canonical=" + canonical.getId());
      try { canonical.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
      catch (e) { logErr("setSharing failed for canonical " + name, e); }

      for (let i = 1; i < matches.length; i++) {
        const dup = matches[i];
        _mergeFolderInto(dup, canonical);
        dup.setTrashed(true);
        Logger.log("  trashed duplicate " + dup.getId());
      }
    } catch (err) {
      logErr("_consolidateDuplicateRootFolders[" + name + "]", err);
    }
  }
}

function _mergeFolderInto(src, dst) {
  const files = src.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    try { f.moveTo(dst); }
    catch (e) { logErr("moveTo failed for file " + f.getId(), e); }
  }
  const subs = src.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    const subName = sub.getName();
    const existing = dst.getFoldersByName(subName);
    if (existing.hasNext()) {
      _mergeFolderInto(sub, existing.next());
      sub.setTrashed(true);
    } else {
      try { sub.moveTo(dst); }
      catch (e) { logErr("moveTo failed for subfolder " + sub.getId(), e); }
    }
  }
}

/**
 * Rewrites old viewer-style URLs (.../file/d/ID/view) into embed URLs
 * across Violations.ImageUrl and Runners.Photo_* columns. Single
 * batched read + write per sheet. Invalidates caches at the end.
 */
function _migrateAllImageUrls() {
  const targets = [
    { sheet: SHEETS.VIOLATIONS, cols: ["ImageUrl"], invalidate: invalidateViolations },
    { sheet: SHEETS.RUNNERS, cols: ["Photo_Front", "Photo_Top", "Photo_Bottom", "Photo_Left", "Photo_Right"], invalidate: invalidateRunners },
  ];
  let total = 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const sheet = ss.getSheetByName(target.sheet);
    if (!sheet) continue;
    try {
      const range = sheet.getDataRange();
      const data = range.getValues();
      if (data.length <= 1) continue;
      const headers = data[0];
      const colIdx = target.cols
        .map(function (c) { return headers.indexOf(c); })
        .filter(function (i) { return i >= 0; });
      if (!colIdx.length) continue;

      let changed = 0;
      for (let r = 1; r < data.length; r++) {
        for (let k = 0; k < colIdx.length; k++) {
          const c = colIdx[k];
          const url = String(data[r][c] || "");
          if (!url || url.indexOf("uc?export=view") >= 0) continue;
          const m = url.match(/[-\w]{25,}/);
          if (m) {
            data[r][c] = "https://drive.google.com/uc?export=view&id=" + m[0];
            changed++;
          }
        }
      }
      if (changed) {
        sheet.getRange(2, 1, data.length - 1, headers.length).setValues(data.slice(1));
        target.invalidate();
        total += changed;
      }
      Logger.log("[" + target.sheet + "] rewrote " + changed + " URL(s)");
    } catch (err) {
      logErr("_migrateAllImageUrls[" + target.sheet + "]", err);
    }
  }
  Logger.log("Total URLs migrated: " + total);
}
