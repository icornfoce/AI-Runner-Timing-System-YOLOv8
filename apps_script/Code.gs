// ============================================================
// AI Runner Timing System — Google Apps Script Backend
// ============================================================
// Deploy: Extensions → Apps Script → Deploy → Web app
//   Execute as: Me | Access: Anyone
//
// FIRST-TIME SETUP:
//   In the Apps Script editor, select the function dropdown,
//   pick `_setupAdminToken`, and click Run. This stores the
//   admin password as a Script Property (not in source).
// ============================================================

// ─── CONFIG ─────────────────────────────────────────────────
const RUNNER_FACES_FOLDER = "RunnerFaces";
const VIOLATION_FOLDER = "ViolationEvidence";
const DEFAULT_ADMIN_TOKEN = "muto67"; // used only if ScriptProperty unset

// ─── ADMIN AUTH ─────────────────────────────────────────────
function getAdminToken() {
  const t = PropertiesService.getScriptProperties().getProperty("ADMIN_TOKEN");
  return t || DEFAULT_ADMIN_TOKEN;
}

function requireAdmin(body) {
  if (!body || body.token !== getAdminToken()) {
    throw new Error("Unauthorized");
  }
}

/**
 * Run ONCE from the Apps Script editor to set the admin password.
 * Edit the string and run again to rotate.
 */
function _setupAdminToken() {
  PropertiesService.getScriptProperties().setProperty("ADMIN_TOKEN", "muto67");
}

// ─── RESPONSE HELPER ────────────────────────────────────────
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── SPREADSHEET HELPERS ────────────────────────────────────
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    switch (name) {
      case "Runners":
        sheet.appendRow(["Name", "BibNumber", "Email", "RegisteredAt",
          "Photo_Front", "Photo_Top", "Photo_Bottom", "Photo_Left", "Photo_Right",
          "FolderUrl", "Embeddings"]);
        break;
      case "Results":
        sheet.appendRow(["Name", "BibNumber", "Start_Time", "CP1_Time", "CP2_Time",
          "CP3_Time", "CP4_Time", "Finish_Time", "Total_Duration", "UpdatedAt"]);
        // Force time columns (C-I) to plain text so HH:MM:SS isn't
        // auto-coerced to a Date and round-trips cleanly.
        sheet.getRange("C:I").setNumberFormat("@");
        break;
      case "Violations":
        sheet.appendRow(["ID", "Name", "BibNumber", "Message", "ImageUrl",
          "Timestamp", "Verified", "VerifiedAt"]);
        break;
    }
  }
  return sheet;
}

function sheetToJson(sheet) {
  // Use displayValues so Date-coerced cells return their formatted string.
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    rows.push(obj);
  }
  return rows;
}

function findRowByName(sheet, name) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(name)) return i + 1;
  }
  return -1;
}

function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function getColumnIndex(sheet, colName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.indexOf(colName);
}

// ─── GOOGLE DRIVE HELPERS ───────────────────────────────────
function getOrCreateFolder(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parentFolder.createFolder(name);
}

function getRootFolder(name) {
  return getOrCreateFolder(DriveApp.getRootFolder(), name);
}

function saveBase64Image(folder, filename, base64Data) {
  let raw = base64Data;
  if (raw.indexOf(",") > -1) raw = raw.split(",")[1];
  const decoded = Utilities.base64Decode(raw);
  const blob = Utilities.newBlob(decoded, "image/jpeg", filename);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ─── DURATION CALCULATOR ────────────────────────────────────
// Accepts strings ("HH:MM:SS" or "HH:MM") OR Date objects (Sheets may
// coerce time strings into time-of-day Dates on older sheets).
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

// ─── GET HANDLER ────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || "";
  try {
    switch (action) {
      case "getResults":
        return jsonResponse({ status: "success", data: sheetToJson(getSheet("Results")) });

      case "getRunners":
        return jsonResponse({ status: "success", data: sheetToJson(getSheet("Runners")) });

      case "getViolations": {
        const all = sheetToJson(getSheet("Violations"));
        const sorted = all.sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)));
        return jsonResponse({ status: "success", data: sorted.slice(0, 20) });
      }

      case "getVerifiedViolations": {
        const all = sheetToJson(getSheet("Violations"));
        const verified = all.filter(v => String(v.Verified).toLowerCase() === "true");
        const sorted = verified.sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)));
        return jsonResponse({ status: "success", data: sorted.slice(0, 20) });
      }

      default:
        return jsonResponse({ status: "error", message: "Unknown action: " + action });
    }
  } catch (err) {
    return jsonResponse({ status: "error", message: err.toString() });
  }
}

// ─── POST HANDLER ───────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || "";

    switch (action) {

      // ── Verify admin password (no destructive effect) ────
      case "verifyAdmin": {
        const pw = String(body.password || "");
        return jsonResponse({ status: pw === getAdminToken() ? "success" : "error" });
      }

      // ── Register Runner ──────────────────────────────────
      case "registerRunner": {
        const name = body.name;
        const bib = body.bib || "";
        const email = body.email || "";
        const timestamp = body.timestamp || new Date().toISOString();
        if (!name) return jsonResponse({ status: "error", message: "Name is required" });

        const rootFolder = getRootFolder(RUNNER_FACES_FOLDER);
        const personFolder = getOrCreateFolder(rootFolder, name);

        const angles = ["front", "top", "bottom", "left", "right"];
        const photoUrls = {};
        for (const angle of angles) {
          const key = "photo_" + angle;
          if (body[key]) {
            const filename = name + "_" + angle + "_" + Date.now() + ".jpg";
            photoUrls[angle] = saveBase64Image(personFolder, filename, body[key]);
          } else {
            photoUrls[angle] = "";
          }
        }

        // Optional embeddings in same call (atomic registration)
        let embStr = "";
        if (body.embeddings) {
          embStr = typeof body.embeddings === "string"
            ? body.embeddings : JSON.stringify(body.embeddings);
        }

        const sheet = getSheet("Runners");
        const existingRow = findRowByName(sheet, name);
        const rowData = [
          name, bib, email, timestamp,
          photoUrls.front, photoUrls.top, photoUrls.bottom,
          photoUrls.left, photoUrls.right,
          personFolder.getUrl(), embStr,
        ];
        if (existingRow > 0) {
          sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
        } else {
          sheet.appendRow(rowData);
        }

        return jsonResponse({
          status: "success",
          message: "Runner " + name + " registered",
          folderUrl: personFolder.getUrl(),
        });
      }

      // ── Save Embeddings (kept for backward compat) ───────
      case "saveEmbeddings": {
        const name = body.name;
        const embeddings = body.embeddings;
        if (!name || !embeddings) {
          return jsonResponse({ status: "error", message: "Name and embeddings required" });
        }
        const sheet = getSheet("Runners");
        const row = findRowByName(sheet, name);
        if (row < 0) return jsonResponse({ status: "error", message: "Runner not found: " + name });
        const colIdx = getColumnIndex(sheet, "Embeddings");
        if (colIdx < 0) return jsonResponse({ status: "error", message: "Embeddings column not found" });
        const embStr = typeof embeddings === "string" ? embeddings : JSON.stringify(embeddings);
        sheet.getRange(row, colIdx + 1).setValue(embStr);
        return jsonResponse({ status: "success", message: "Embeddings saved for " + name });
      }

      // ── Record Checkpoint ────────────────────────────────
      case "recordCheckpoint": {
        const name = body.name;
        const cpId = body.checkpoint_id;
        const timestamp = body.timestamp;
        const bib = body.bib || "";
        if (!name || cpId === undefined || cpId === null || !timestamp) {
          return jsonResponse({ status: "error", message: "Missing fields" });
        }

        const sheet = getSheet("Results");
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

        let colName;
        if (cpId === "start") colName = "Start_Time";
        else if (cpId === "finish") colName = "Finish_Time";
        else colName = "CP" + cpId + "_Time";

        const colIdx = headers.indexOf(colName);
        if (colIdx < 0) return jsonResponse({ status: "error", message: "Column not found: " + colName });

        let row = findRowByName(sheet, name);
        if (row < 0) {
          const newRow = new Array(headers.length).fill("");
          newRow[0] = name;
          newRow[1] = bib;
          newRow[colIdx] = timestamp;
          newRow[headers.indexOf("UpdatedAt")] = new Date().toISOString();
          sheet.appendRow(newRow);
        } else {
          sheet.getRange(row, colIdx + 1).setValue(timestamp);
          if (bib) sheet.getRange(row, 2).setValue(bib);

          const startCol = headers.indexOf("Start_Time");
          const finishCol = headers.indexOf("Finish_Time");
          const durCol = headers.indexOf("Total_Duration");
          if (startCol >= 0 && finishCol >= 0 && durCol >= 0) {
            const startTime = sheet.getRange(row, startCol + 1).getValue();
            const finishTime = sheet.getRange(row, finishCol + 1).getValue();
            if (startTime && finishTime) {
              sheet.getRange(row, durCol + 1).setValue(calcDuration(startTime, finishTime));
            }
          }
          sheet.getRange(row, headers.indexOf("UpdatedAt") + 1).setValue(new Date().toISOString());
        }

        return jsonResponse({ status: "success", message: name + " " + colName + " recorded" });
      }

      // ── Report Violation ─────────────────────────────────
      case "reportViolation": {
        const name = body.name || "Unknown";
        const bib = body.bib || "";
        const message = body.message || "";
        const timestamp = body.timestamp || new Date().toISOString();
        const imageBase64 = body.image || "";

        let imageUrl = "";
        if (imageBase64) {
          const folder = getRootFolder(VIOLATION_FOLDER);
          const filename = "violation_" + name + "_" + Date.now() + ".jpg";
          imageUrl = saveBase64Image(folder, filename, imageBase64);
        }

        const id = "V" + Date.now();
        getSheet("Violations").appendRow([id, name, bib, message, imageUrl, timestamp, false, ""]);
        return jsonResponse({ status: "success", message: "Violation reported", id: id });
      }

      // ── Verify Violation (admin) ─────────────────────────
      case "verifyViolation": {
        requireAdmin(body);
        const id = body.id;
        if (!id) return jsonResponse({ status: "error", message: "ID required" });

        const sheet = getSheet("Violations");
        const row = findRowById(sheet, id);
        if (row < 0) return jsonResponse({ status: "error", message: "Violation not found" });

        const verifiedCol = getColumnIndex(sheet, "Verified");
        const verifiedAtCol = getColumnIndex(sheet, "VerifiedAt");
        sheet.getRange(row, verifiedCol + 1).setValue(true);
        sheet.getRange(row, verifiedAtCol + 1).setValue(new Date().toISOString());
        return jsonResponse({ status: "success", message: "Violation verified" });
      }

      // ── Delete Violation (admin) ─────────────────────────
      case "deleteViolation": {
        requireAdmin(body);
        const id = body.id;
        if (!id) return jsonResponse({ status: "error", message: "ID required" });
        const sheet = getSheet("Violations");
        const row = findRowById(sheet, id);
        if (row < 0) return jsonResponse({ status: "error", message: "Violation not found" });
        sheet.deleteRow(row);
        return jsonResponse({ status: "success", message: "Violation deleted" });
      }

      // ── Delete Runner (admin) ────────────────────────────
      case "deleteRunner": {
        requireAdmin(body);
        const name = body.name;
        if (!name) return jsonResponse({ status: "error", message: "Name required" });

        const rSheet = getSheet("Runners");
        const rRow = findRowByName(rSheet, name);
        if (rRow > 0) rSheet.deleteRow(rRow);

        const resSheet = getSheet("Results");
        const resRow = findRowByName(resSheet, name);
        if (resRow > 0) resSheet.deleteRow(resRow);

        return jsonResponse({ status: "success", message: "Runner " + name + " deleted" });
      }

      // ── Update Runner (admin) ────────────────────────────
      case "updateRunner": {
        requireAdmin(body);
        const name = body.name;
        if (!name) return jsonResponse({ status: "error", message: "Name required" });

        const sheet = getSheet("Results");
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        let row = findRowByName(sheet, name);
        if (row < 0) {
          const newRow = new Array(headers.length).fill("");
          newRow[0] = name;
          newRow[1] = body.bib || "";
          sheet.appendRow(newRow);
          row = sheet.getLastRow();
        }

        const timeFields = ["Start_Time", "CP1_Time", "CP2_Time", "CP3_Time", "CP4_Time", "Finish_Time"];
        for (const field of timeFields) {
          if (body[field] !== undefined) {
            const col = headers.indexOf(field);
            if (col >= 0) sheet.getRange(row, col + 1).setValue(body[field]);
          }
        }

        const startCol = headers.indexOf("Start_Time");
        const finishCol = headers.indexOf("Finish_Time");
        const durCol = headers.indexOf("Total_Duration");
        if (startCol >= 0 && finishCol >= 0 && durCol >= 0) {
          const s = sheet.getRange(row, startCol + 1).getValue();
          const f = sheet.getRange(row, finishCol + 1).getValue();
          if (s && f) sheet.getRange(row, durCol + 1).setValue(calcDuration(s, f));
        }
        const updCol = headers.indexOf("UpdatedAt");
        if (updCol >= 0) sheet.getRange(row, updCol + 1).setValue(new Date().toISOString());

        return jsonResponse({ status: "success", message: "Runner " + name + " updated" });
      }

      default:
        return jsonResponse({ status: "error", message: "Unknown action: " + action });
    }
  } catch (err) {
    return jsonResponse({ status: "error", message: err.toString() });
  }
}
