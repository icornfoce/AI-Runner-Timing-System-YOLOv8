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
//   • Drive folder/file cleanup on deleteRunner / deleteViolation is
//     synchronous and isolated in try-catch — a Drive API failure is
//     logged but never blocks the sheet row deletion.
//
// What's new in v5:
//   • Violations now carry a ViolationType (NO_BIB, WRONG_PERSON, …);
//     reportViolation validates the value against a fixed whitelist.
//   • New deleteViolationsBatch endpoint deletes many rows + Drive files
//     in one request, sorted bottom-up to avoid index shift, with each
//     Drive trash isolated in try-catch. Cache is invalidated once.
//   • _migrateViolationTypeColumn() helper backfills the new column on
//     existing sheets (idempotent; safe to re-run).
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
  // ViolationType lives at the end so existing sheets keep their column
  // order; new fields are added on the right by _migrateViolationTypeColumn.
  Violations: ["ID", "Name", "BibNumber", "Message", "ImageUrl",
    "Timestamp", "Verified", "VerifiedAt", "ViolationType"],
});

const TIME_COLUMNS = Object.freeze(
  ["Start_Time", "CP1_Time", "CP2_Time", "CP3_Time", "CP4_Time", "Finish_Time"]
);

// ─── VIOLATION TYPES ────────────────────────────────────────
// Whitelist for the ViolationType column. The frontend filter dropdown
// is built from this same list so adding a type is a one-line change.
//   NO_BIB         — face detected but no BIB number visible
//   WRONG_PERSON   — BIB digits don't match the registered runner
//   UNREGISTERED   — face has no match in the runner database
//   MULTIPLE_BIBS  — more than one BIB candidate read from one runner
//   WRONG_ROUTE    — runner reached a checkpoint out of order
//   OBSCURED_BIB   — BIB partially covered / unreadable for OCR
//   OTHER          — manual / catch-all for staff-entered notes
const VIOLATION_TYPES = Object.freeze([
  "NO_BIB", "WRONG_PERSON", "UNREGISTERED",
  "MULTIPLE_BIBS", "WRONG_ROUTE", "OBSCURED_BIB", "OTHER",
]);
const VIOLATION_TYPE_SET = (function () {
  const m = {};
  for (let i = 0; i < VIOLATION_TYPES.length; i++) m[VIOLATION_TYPES[i]] = true;
  return Object.freeze(m);
})();
const DEFAULT_VIOLATION_TYPE = "WRONG_PERSON";
const BATCH_DELETE_MAX = 200;

// ─── INPUT VALIDATION PATTERNS ──────────────────────────────
const NAME_PATTERN = /^[a-zA-Z0-9_\-.]{1,50}$/;
const BIB_PATTERN = /^[a-zA-Z0-9]{1,10}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_PATTERN = /^V\d{10,}$/;

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
function isEmpty(v) {
  return v == null || v === "";
}
function reqStr(v, name, pattern, maxLen) {
  if (isEmpty(v)) throw httpError(name + " is required", "bad_request");
  const s = String(v).trim();
  if (maxLen && s.length > maxLen) throw httpError(name + " exceeds " + maxLen + " chars", "bad_request");
  if (pattern && !pattern.test(s)) throw httpError(name + " has invalid format", "bad_request");
  return s;
}
function optStr(v, pattern, maxLen) {
  if (isEmpty(v)) return "";
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

// Accepts undefined/empty (returns DEFAULT_VIOLATION_TYPE), otherwise must
// be one of VIOLATION_TYPES. Case-insensitive on input; stored as upper.
function normalizeViolationType(v) {
  if (isEmpty(v)) return DEFAULT_VIOLATION_TYPE;
  const s = String(v).trim().toUpperCase();
  if (!VIOLATION_TYPE_SET[s]) {
    throw httpError("Unknown violationType: " + s, "bad_request");
  }
  return s;
}

// ─── TIME / DURATION HELPERS ────────────────────────────────
function parseTimeToSeconds(v) {
  if (isEmpty(v)) return null;
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
  if (isEmpty(v)) return "";
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

// Convenience wrapper around readWholeSheet + findRowByName — returns
// both the snapshot and the resolved row index so callers don't duplicate
// the snap+lookup pattern when they only need the row.
function getRowByName(sheet, name) {
  const snap = readWholeSheet(sheet);
  return { snap: snap, rowIdx: snap.findRowByName(name) };
}

// JSON projection for read-only endpoints. getDisplayValues so any
// Date-typed cells round-trip as their formatted string.
function readSheetAsJson(sheet) {
  const data = sheet.getDataRange().getDisplayValues();
  if (!data || data.length <= 1) return [];
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

// ─── SYNCHRONOUS DRIVE CLEANUP ──────────────────────────────
// Called inline from deleteRunner / deleteViolation. The callers wrap
// these in try-catch so a Drive failure (e.g. file already trashed by
// a manual cleanup) never blocks the sheet row deletion.

/**
 * Move every "RunnerFaces/<personName>" folder to Trash.
 * Iterates all RunnerFaces roots (in case duplicates were created
 * before the lock fix) and trashes any matching subfolder.
 */
function trashRunnerFolder(personName) {
  const root = DriveApp.getRootFolder();
  const runnerRoots = root.getFoldersByName(RUNNER_FACES_FOLDER);
  let trashed = 0;
  while (runnerRoots.hasNext()) {
    const rf = runnerRoots.next();
    const personFolders = rf.getFoldersByName(personName);
    while (personFolders.hasNext()) {
      personFolders.next().setTrashed(true);
      trashed++;
    }
  }
  logInfo("trashRunnerFolder", { name: personName, trashed: trashed });
  return trashed;
}

/**
 * Pull a Drive file ID out of any URL shape this codebase may have
 * written: the embed form (uc?export=view&id=…) used by v3+, or the
 * legacy viewer form (file/d/…/view) used before the migration.
 */
function extractDriveFileId(url) {
  if (!url) return null;
  const s = String(url);
  const fromQuery = s.match(/[?&]id=([-\w]{25,})/);
  if (fromQuery) return fromQuery[1];
  const fromPath = s.match(/\/file\/d\/([-\w]{25,})/);
  return fromPath ? fromPath[1] : null;
}

/** Move a Drive file to Trash by its ID, swallowing not-found errors. */
function trashDriveFile(fileId) {
  if (!fileId) return false;
  DriveApp.getFileById(fileId).setTrashed(true);
  return true;
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
      case "deleteViolationsBatch": return handleDeleteViolationsBatch(body);
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

  // Build a single column-name → index map so we don't re-scan headers
  // five times below. Missing columns are -1.
  const cols = {};
  for (let i = 0; i < snap.headers.length; i++) cols[snap.headers[i]] = i;
  const colIdx = cols[colName];
  if (colIdx == null || colIdx < 0) throw httpError("Column not found: " + colName, "schema_error");
  const startCol = cols.Start_Time, finishCol = cols.Finish_Time;
  const durCol = cols.Total_Duration, updCol = cols.UpdatedAt, bibCol = cols.BibNumber;

  const rowIdx = snap.findRowByName(name);

  if (rowIdx < 0) {
    const newRow = new Array(snap.headers.length).fill("");
    newRow[0] = name;
    if (bibCol != null && bibCol >= 0) newRow[bibCol] = bib;
    newRow[colIdx] = timestamp;
    if (updCol != null && updCol >= 0) newRow[updCol] = new Date().toISOString();
    sheet.appendRow(newRow);
    logInfo("recordCheckpoint (new)", { name: name, cp: colName });
  } else {
    // Reuse the snapshot row instead of round-tripping a second
    // getValues() — the data is already in memory from readWholeSheet.
    const row = snap.values[rowIdx - 2].slice();
    row[colIdx] = timestamp;
    if (bib && bibCol != null && bibCol >= 0) row[bibCol] = bib;
    if (durCol != null && durCol >= 0 && startCol != null && finishCol != null
        && row[startCol] && row[finishCol]) {
      row[durCol] = calcDuration(row[startCol], row[finishCol]);
    }
    if (updCol != null && updCol >= 0) row[updCol] = new Date().toISOString();
    normalizeRowTimeCols(row, snap);
    sheet.getRange(rowIdx, 1, 1, snap.headers.length).setValues([row]);
    logInfo("recordCheckpoint (update)", { name: name, cp: colName });
  }

  invalidateResults();
  return jsonOk({ message: name + " " + colName + " recorded" });
}

function handleReportViolation(body) {
  const name = optStr(body.name, NAME_PATTERN, 50) || "Unknown";
  const bib = optStr(body.bib, BIB_PATTERN, 10);
  const message = optStr(body.message, null, 500);
  const violationType = normalizeViolationType(body.violationType);
  const timestamp = optStr(body.timestamp, null, 50) || new Date().toISOString();
  const imageBase64 = body.image || "";

  let imageUrl = "";
  if (imageBase64) {
    const folder = getRootFolder(VIOLATION_FOLDER);
    const filename = "violation_" + name + "_" + Date.now() + ".jpg";
    imageUrl = saveBase64Image(folder, filename, imageBase64);
  }

  const id = "V" + Date.now();
  // Header-mapped write so legacy sheets (no ViolationType column) still
  // accept the row — the field is silently dropped until the migration
  // helper adds the column. New sheets created by getSheet() include it.
  const sheet = getSheet(SHEETS.VIOLATIONS);
  const snap = readWholeSheet(sheet);
  const row = new Array(snap.headers.length).fill("");
  const fields = {
    ID: id, Name: name, BibNumber: bib, Message: message,
    ImageUrl: imageUrl, Timestamp: timestamp,
    Verified: false, VerifiedAt: "", ViolationType: violationType,
  };
  for (const key in fields) {
    const idx = snap.headerIndex(key);
    if (idx >= 0) row[idx] = fields[key];
  }
  sheet.appendRow(row);

  invalidateViolations();
  logInfo("reportViolation", { id: id, name: name, type: violationType });
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

  // Pull the image URL out of the in-memory snapshot before we delete
  // the row, so we can trash the Drive file in the same request.
  const imageUrlCol = snap.headerIndex("ImageUrl");
  // snap.values is 0-indexed from the row AFTER the header; rowIdx is
  // the 1-indexed sheet row, with row 1 = header.
  const imageUrl = imageUrlCol >= 0
    ? String(snap.values[rowIdx - 2][imageUrlCol] || "")
    : "";

  // Synchronous Drive cleanup. Isolated try-catch so a missing/already-
  // trashed file never blocks the sheet row deletion.
  if (imageUrl) {
    try {
      const fileId = extractDriveFileId(imageUrl);
      if (fileId) {
        trashDriveFile(fileId);
        logInfo("trashed violation image", { id: id, fileId: fileId });
      }
    } catch (e) {
      logErr("trashDriveFile failed for violation " + id + " (continuing)", e);
    }
  }

  sheet.deleteRow(rowIdx);

  invalidateViolations();
  logInfo("deleteViolation", { id: id });
  return jsonOk({ message: "Violation deleted" });
}

/**
 * Bulk delete: accepts an array of violation IDs, trashes each Drive
 * file in an isolated try-catch, then deletes the sheet rows from the
 * BOTTOM up so earlier deletions don't shift later row indexes. Cache
 * is invalidated once at the end. The whole operation is one read of
 * the sheet, N deleteRow calls, and one removeAll on the cache.
 */
function handleDeleteViolationsBatch(body) {
  requireAdmin(body);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError("ids must be a non-empty array", "bad_request");
  }
  if (ids.length > BATCH_DELETE_MAX) {
    throw httpError("Too many IDs (max " + BATCH_DELETE_MAX + ")", "bad_request");
  }

  const sheet = getSheet(SHEETS.VIOLATIONS);
  const snap = readWholeSheet(sheet);
  const imageUrlCol = snap.headerIndex("ImageUrl");

  // Resolve every ID against the snapshot once so we don't rescan the
  // sheet inside the deletion loop.
  const targets = [];
  const notFound = [];
  const seenIds = {};
  for (let i = 0; i < ids.length; i++) {
    const id = reqStr(ids[i], "ids[" + i + "]", ID_PATTERN, 30);
    if (seenIds[id]) continue;
    seenIds[id] = true;
    const rowIdx = snap.findRowById(id);
    if (rowIdx < 0) { notFound.push(id); continue; }
    const imageUrl = imageUrlCol >= 0
      ? String(snap.values[rowIdx - 2][imageUrlCol] || "")
      : "";
    targets.push({ id: id, rowIdx: rowIdx, imageUrl: imageUrl });
  }

  // Trash Drive files first — order doesn't matter, and a failure on
  // one file must not block the rest. Each call is wrapped so a 404 /
  // permission error is logged but never aborts the batch.
  let driveTrashed = 0;
  for (let i = 0; i < targets.length; i++) {
    if (!targets[i].imageUrl) continue;
    try {
      const fileId = extractDriveFileId(targets[i].imageUrl);
      if (fileId) {
        trashDriveFile(fileId);
        driveTrashed++;
      }
    } catch (e) {
      logErr("trashDriveFile failed for " + targets[i].id + " (continuing)", e);
    }
  }

  // Delete rows bottom-up so earlier deletions don't shift later indexes.
  targets.sort(function (a, b) { return b.rowIdx - a.rowIdx; });
  for (let i = 0; i < targets.length; i++) {
    sheet.deleteRow(targets[i].rowIdx);
  }

  invalidateViolations();
  logInfo("deleteViolationsBatch", {
    requested: ids.length,
    deleted: targets.length,
    notFound: notFound.length,
    driveTrashed: driveTrashed,
  });
  return jsonOk({
    deleted: targets.length,
    notFound: notFound,
    message: "Deleted " + targets.length + " violation(s)",
  });
}

function handleDeleteRunner(body) {
  requireAdmin(body);
  const name = reqStr(body.name, "name", NAME_PATTERN, 50);

  // Synchronous Drive cleanup. Isolated try-catch — if Drive throws
  // (e.g. folder already trashed manually, or org policy denies the
  // operation), we log it and continue so the sheet rows still go.
  try {
    trashRunnerFolder(name);
  } catch (e) {
    logErr("trashRunnerFolder failed for " + name + " (continuing)", e);
  }

  // Both sheets: in-memory findIndex, delete on hit, no further loop.
  // Each sheet's read+delete is isolated so a Results-sheet failure
  // can't leave the Runners row orphaned (and vice versa).
  const sheetsToClear = [SHEETS.RUNNERS, SHEETS.RESULTS];
  for (let i = 0; i < sheetsToClear.length; i++) {
    const sheetName = sheetsToClear[i];
    try {
      const sheet = getSheet(sheetName);
      const found = getRowByName(sheet, name);
      if (found.rowIdx > 0) sheet.deleteRow(found.rowIdx);
    } catch (e) {
      logErr("deleteRunner: " + sheetName + " cleanup failed for " + name, e);
    }
  }

  invalidateRunners();
  invalidateResults();

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

/**
 * Adds the ViolationType column to the Violations sheet if missing,
 * and backfills existing rows with DEFAULT_VIOLATION_TYPE. Idempotent —
 * re-running on an already-migrated sheet is a no-op.
 *
 * Run once after deploying v5: editor → function dropdown →
 * _migrateViolationTypeColumn → Run.
 */
function _migrateViolationTypeColumn() {
  const sheet = getSheet(SHEETS.VIOLATIONS);
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];

  let typeCol = headers.indexOf("ViolationType");
  if (typeCol < 0) {
    typeCol = lastCol; // append at the end
    sheet.getRange(1, typeCol + 1).setValue("ViolationType");
    Logger.log("Added ViolationType column at index " + (typeCol + 1));
  } else {
    Logger.log("ViolationType column already at index " + (typeCol + 1));
  }

  if (lastRow < 2) {
    invalidateViolations();
    Logger.log("No data rows to backfill.");
    return;
  }

  const range = sheet.getRange(2, typeCol + 1, lastRow - 1, 1);
  const values = range.getValues();
  let backfilled = 0;
  for (let i = 0; i < values.length; i++) {
    const cur = String(values[i][0] || "").trim();
    if (cur === "") {
      values[i][0] = DEFAULT_VIOLATION_TYPE;
      backfilled++;
    } else if (!VIOLATION_TYPE_SET[cur.toUpperCase()]) {
      Logger.log("Row " + (i + 2) + " has unknown ViolationType '" + cur + "' — leaving as-is");
    }
  }
  if (backfilled) {
    range.setValues(values);
    invalidateViolations();
  }
  Logger.log("Backfilled " + backfilled + " row(s) with default '" + DEFAULT_VIOLATION_TYPE + "'");
}
