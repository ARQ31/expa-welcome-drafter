/**
 * ============================================================================
 * GOOGLE APPS SCRIPT: Google Drive Direct File Uploader Webhook (SECURED)
 * ============================================================================
 * 
 * PENGAMANAN (Security Token):
 * 1. Di bawah ini terdapat variabel SHARED_SECRET. Nilai default-nya adalah
 *    "expa-sec-token-2026". Anda bisa menggantinya dengan string rahasia Anda sendiri.
 * 2. Masukkan secret yang sama ke kolom "Google Drive Webhook Secret" di Langflow.
 * 3. Webhook akan menolak (HTTP 401 Unauthorized) jika token tidak cocok.
 * ============================================================================
 */

// Ganti token ini dengan secret Anda sendiri jika ingin lebih unik
var SHARED_SECRET = "expa-sec-token-2026";

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return responseJSON({ status: "error", message: "No payload received" });
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return responseJSON({ status: "error", message: "Invalid JSON format" });
    }

    // --- AUTENTIKASI SECRET TOKEN (Cegah Akses Gelap Pihak Ketiga) ---
    var providedToken = data.auth_token || (e.parameter && e.parameter.secret);
    if (e.headers) {
      providedToken = providedToken || e.headers["x-webhook-token"] || e.headers["X-Webhook-Token"];
    }

    if (!providedToken || providedToken !== SHARED_SECRET) {
      return responseJSON({ 
        status: "error", 
        message: "Unauthorized: Invalid or missing secret token" 
      });
    }

    var base64Data = data.base64_data;
    var rawFileName = data.file_name || ("expa_export_" + new Date().getTime() + ".xlsx");
    // Sanitasi nama file untuk mencegah directory traversal
    var fileName = rawFileName.replace(/^.*[\\\/]/, "").replace(/[^a-zA-Z0-9._\-]/g, "_");
    var mimeType = data.mime_type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    var folderId = data.folder_id;

    // Batasi ekstensi: hanya izinkan format spreadsheet (.xlsx, .csv)
    var allowedExtensions = [".xlsx", ".csv"];
    var lowerName = fileName.toLowerCase();
    var isAllowed = allowedExtensions.some(function(ext) { return lowerName.endsWith(ext); });
    if (!isAllowed) {
      return responseJSON({ status: "error", message: "Only .xlsx and .csv files are permitted" });
    }

    if (!base64Data) {
      return responseJSON({ status: "error", message: "base64_data is required" });
    }

    // Decode base64 to binary blob
    var decoded = Utilities.base64Decode(base64Data);
    var blob = Utilities.newBlob(decoded, mimeType, fileName);

    // Tentukan folder penyimpanan di Google Drive
    var folder;
    if (folderId && String(folderId).trim() !== "") {
      var cleanFolderId = String(folderId).trim();
      var match = cleanFolderId.match(/folders\/([a-zA-Z0-9_-]+)/);
      if (match) {
        cleanFolderId = match[1];
      }
      try {
        folder = DriveApp.getFolderById(cleanFolderId);
      } catch (err) {
        folder = DriveApp.getRootFolder();
      }
    } else {
      folder = DriveApp.getRootFolder();
    }

    // Buat file di Google Drive (default: private ke akun pemilik Drive)
    var file = folder.createFile(blob);

    // Hanya buka akses link publik jika diminta secara eksplisit (public_link: true)
    if (data.public_link === true) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    return responseJSON({
      status: "success",
      file_id: file.getId(),
      file_name: file.getName(),
      file_url: file.getUrl(),
      download_url: file.getDownloadUrl()
    });
  } catch (err) {
    return responseJSON({
      status: "error",
      message: err.toString()
    });
  }
}

function doGet(e) {
  return responseJSON({
    status: "ok",
    message: "Google Drive Uploader Webhook is active and protected!"
  });
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
