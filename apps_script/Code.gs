// ============================================================
// AI Runner Timing System — Google Apps Script Backend
// ============================================================
// Deploy: Extensions → Apps Script → Deploy → Web app
//   Execute as: Me | Access: Anyone
// ============================================================

// ─── CONFIG ─────────────────────────────────────────────────
const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const RUNNER_FACES_FOLDER = "RunnerFaces";
const VIOLATION_FOLDER = "ViolationEvidence";

// ─── CORS HEADERS ───────────────────────────────────────────
function setCorsHeaders(output) {
  return output
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function jsonResponse(data) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
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
        sheet.appendRow(["Name", "BibNumber", "Start_Time", "CP1_Time", "CP2_Time", "CP3_Time", "CP4_Time", "Finish_Time", "Total_Duration", "UpdatedAt"]);
        break;
      case "Violations":
        sheet.appendRow(["ID", "Name", "BibNumber", "Message", "ImageUrl", "Timestamp", "Verified", "VerifiedAt"]);
        break;
    }
  }
  return sheet;
}

function sheetToJson(sheet) {
  const data = sheet.getDataRange().getValues();
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
    if (data[i][0] === name) return i + 1; // 1-indexed row number
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
  const root = DriveApp.getRootFolder();
  return getOrCreateFolder(root, name);
}

function saveBase64Image(folder, filename, base64Data) {
  // Strip data URL prefix if present
  let raw = base64Data;
  if (raw.indexOf(",") > -1) {
    raw = raw.split(",")[1];
  }
  const decoded = Utilities.base64Decode(raw);
  const blob = Utilities.newBlob(decoded, "image/jpeg", filename);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ─── DURATION CALCULATOR ────────────────────────────────────
function calcDuration(cp1, cp2) {
  try {
    if (!cp1 || !cp2) return "";
    const parts1 = String(cp1).split(":");
    const parts2 = String(cp2).split(":");
    const sec1 = parseInt(parts1[0]) * 3600 + parseInt(parts1[1]) * 60 + parseInt(parts1[2]);
    const sec2 = parseInt(parts2[0]) * 3600 + parseInt(parts2[1]) * 60 + parseInt(parts2[2]);
    let diff = sec2 - sec1;
    if (diff < 0) diff += 86400;
    const mins = Math.floor(diff / 60);
    const secs = diff % 60;
    return mins + ":" + String(secs).padStart(2, "0");
  } catch (e) {
    return "";
  }
}

// ─── GET HANDLER ────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || "";

  try {
    switch (action) {
      case "getResults": {
        const sheet = getSheet("Results");
        return jsonResponse({ status: "success", data: sheetToJson(sheet) });
      }

      case "getRunners": {
        const sheet = getSheet("Runners");
        return jsonResponse({ status: "success", data: sheetToJson(sheet) });
      }

      case "getViolations": {
        const sheet = getSheet("Violations");
        const all = sheetToJson(sheet);
        // Return last 20, sorted by timestamp descending
        const sorted = all.sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)));
        return jsonResponse({ status: "success", data: sorted.slice(0, 20) });
      }

      case "getVerifiedViolations": {
        const sheet = getSheet("Violations");
        const all = sheetToJson(sheet);
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

      // ── Register Runner ──────────────────────────────────
      case "registerRunner": {
        const name = body.name;
        const bib = body.bib || "";
        const email = body.email || "";
        const timestamp = body.timestamp || new Date().toISOString();

        if (!name) return jsonResponse({ status: "error", message: "Name is required" });

        // Create Drive folder
        const rootFolder = getRootFolder(RUNNER_FACES_FOLDER);
        const personFolder = getOrCreateFolder(rootFolder, name);

        // Save 5 photos
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

        // Write to Runners sheet
        const sheet = getSheet("Runners");
        const existingRow = findRowByName(sheet, name);

        const rowData = [
          name, bib, email, timestamp,
          photoUrls.front, photoUrls.top, photoUrls.bottom,
          photoUrls.left, photoUrls.right,
          personFolder.getUrl(), ""  // Embeddings empty, set later
        ];

        if (existingRow > 0) {
          // Update existing runner
          sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
        } else {
          sheet.appendRow(rowData);
        }

        return jsonResponse({
          status: "success",
          message: "Runner " + name + " registered",
          folderUrl: personFolder.getUrl()
        });
      }

      // ── Save Embeddings ──────────────────────────────────
      case "saveEmbeddings": {
        const name = body.name;
        const embeddings = body.embeddings; // JSON string of float array

        if (!name || !embeddings) {
          return jsonResponse({ status: "error", message: "Name and embeddings required" });
        }

        const sheet = getSheet("Runners");
        const row = findRowByName(sheet, name);
        if (row < 0) {
          return jsonResponse({ status: "error", message: "Runner not found: " + name });
        }

        const colIdx = getColumnIndex(sheet, "Embeddings");
        if (colIdx < 0) {
          return jsonResponse({ status: "error", message: "Embeddings column not found" });
        }

        const embStr = typeof embeddings === "string" ? embeddings : JSON.stringify(embeddings);
        sheet.getRange(row, colIdx + 1).setValue(embStr);

        return jsonResponse({ status: "success", message: "Embeddings saved for " + name });
      }

      // ── Record Checkpoint ────────────────────────────────
      case "recordCheckpoint": {
        const name = body.name;
        const cpId = body.checkpoint_id; // 'start', 1, 2, 3, 4, 'finish'
        const timestamp = body.timestamp;
        const bib = body.bib || "";

        if (!name || cpId === undefined || !timestamp) {
          return jsonResponse({ status: "error", message: "Missing fields" });
        }

        const sheet = getSheet("Results");
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        
        // Map checkpoint_id to column name
        let colName;
        if (cpId === 'start') colName = 'Start_Time';
        else if (cpId === 'finish') colName = 'Finish_Time';
        else colName = 'CP' + cpId + '_Time';
        
        const colIdx = headers.indexOf(colName);
        if (colIdx < 0) return jsonResponse({ status: "error", message: "Column not found: " + colName });

        let row = findRowByName(sheet, name);

        if (row < 0) {
          // New runner entry — create empty row
          const newRow = new Array(headers.length).fill("");
          newRow[0] = name;  // Name
          newRow[1] = bib;   // BibNumber
          newRow[colIdx] = timestamp;
          newRow[headers.indexOf('UpdatedAt')] = new Date().toISOString();
          sheet.appendRow(newRow);
        } else {
          sheet.getRange(row, colIdx + 1).setValue(timestamp);
          if (bib) sheet.getRange(row, 2).setValue(bib);
          
          // Calculate Total_Duration (Start → Finish)
          const startCol = headers.indexOf('Start_Time');
          const finishCol = headers.indexOf('Finish_Time');
          const durCol = headers.indexOf('Total_Duration');
          if (startCol >= 0 && finishCol >= 0 && durCol >= 0) {
            const startTime = String(sheet.getRange(row, startCol + 1).getValue());
            const finishTime = String(sheet.getRange(row, finishCol + 1).getValue());
            if (startTime && finishTime && startTime !== '' && finishTime !== '') {
              sheet.getRange(row, durCol + 1).setValue(calcDuration(startTime, finishTime));
            }
          }
          sheet.getRange(row, headers.indexOf('UpdatedAt') + 1).setValue(new Date().toISOString());
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
        const sheet = getSheet("Violations");
        sheet.appendRow([id, name, bib, message, imageUrl, timestamp, false, ""]);

        return jsonResponse({ status: "success", message: "Violation reported", id: id });
      }

      // ── Verify Violation ─────────────────────────────────
      case "verifyViolation": {
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

      // ── Delete Violation ─────────────────────────────────
      case "deleteViolation": {
        const id = body.id;
        if (!id) return jsonResponse({ status: "error", message: "ID required" });

        const sheet = getSheet("Violations");
        const row = findRowById(sheet, id);
        if (row < 0) return jsonResponse({ status: "error", message: "Violation not found" });

        sheet.deleteRow(row);
        return jsonResponse({ status: "success", message: "Violation deleted" });
      }

      // ── Delete Runner ────────────────────────────────────
      case "deleteRunner": {
        const name = body.name;
        if (!name) return jsonResponse({ status: "error", message: "Name required" });

        // Delete from Runners sheet
        const rSheet = getSheet("Runners");
        const rRow = findRowByName(rSheet, name);
        if (rRow > 0) rSheet.deleteRow(rRow);

        // Also delete from Results sheet
        const resSheet = getSheet("Results");
        const resRow = findRowByName(resSheet, name);
        if (resRow > 0) resSheet.deleteRow(resRow);

        return jsonResponse({ status: "success", message: "Runner " + name + " deleted" });
      }

      // ── Update Runner (edit CP times) ────────────────────
      case "updateRunner": {
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

        // Update any provided time columns
        const timeFields = ['Start_Time', 'CP1_Time', 'CP2_Time', 'CP3_Time', 'CP4_Time', 'Finish_Time'];
        for (const field of timeFields) {
          if (body[field] !== undefined) {
            const col = headers.indexOf(field);
            if (col >= 0) sheet.getRange(row, col + 1).setValue(body[field]);
          }
        }

        // Recalculate Total_Duration
        const startCol = headers.indexOf('Start_Time');
        const finishCol = headers.indexOf('Finish_Time');
        const durCol = headers.indexOf('Total_Duration');
        if (startCol >= 0 && finishCol >= 0 && durCol >= 0) {
          const s = String(sheet.getRange(row, startCol + 1).getValue());
          const f = String(sheet.getRange(row, finishCol + 1).getValue());
          if (s && f && s !== '' && f !== '') {
            sheet.getRange(row, durCol + 1).setValue(calcDuration(s, f));
          }
        }
        const updCol = headers.indexOf('UpdatedAt');
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

// ─── OPTIONS HANDLER (CORS PREFLIGHT) ───────────────────────
function doOptions(e) {
  return ContentService
    .createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    .setHeader("Access-Control-Allow-Headers", "Content-Type")
    .setHeader("Access-Control-Max-Age", "86400");
}
