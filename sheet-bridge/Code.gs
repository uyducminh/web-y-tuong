/**
 * Google Sheet bridge for the SME MVP worker.
 *
 * Setup: Extensions → Apps Script, paste this file, then Project Settings → Script properties:
 *   SHEET_TOKEN = <same secret as the worker's SHEET_TOKEN>
 * Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone. Put the /exec URL in SHEET_URL.
 *
 * Request (POST, JSON):
 *   { token, action: 'append', row: { thoi_gian, ten, sdt, ... } }
 *   { token, action: 'update', siteId, patch: { trang_thai, goi, so_tien, link_ban_giao } }
 * Response: { ok: true } or { ok: false, error }
 */
var SHEET_NAME = 'leads';
var HEADERS = ['thoi_gian', 'ten', 'sdt', 'nhu_cau', 'link_demo', 'link_lead', 'trang_thai', 'siteId', 'goi', 'so_tien', 'link_ban_giao'];

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); } catch (err) { return reply_({ ok: false, error: 'bad json' }); }
  var secret = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN');
  if (!secret || !body || typeof body.token !== 'string' || !safeEqual_(body.token, secret)) return reply_({ ok: false, error: 'bad token' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var header = ensureHeader_(sheet);
    if (body.action === 'append' && body.row && typeof body.row === 'object') {
      header = addColumns_(sheet, header, Object.keys(body.row));
      var values = header.map(function (h) { return cell_(body.row[h]); });
      var r = sheet.getLastRow() + 1;
      var range = sheet.getRange(r, 1, 1, header.length);
      range.setNumberFormat('@'); // keep leading zeros in phone numbers
      range.setValues([values]);
      return reply_({ ok: true });
    }
    if (body.action === 'update' && typeof body.siteId === 'string' && body.patch && typeof body.patch === 'object') {
      var idCol = header.indexOf('siteId') + 1;
      if (idCol === 0) return reply_({ ok: false, error: 'no siteId column' });
      var last = sheet.getLastRow();
      if (last < 2) return reply_({ ok: false, error: 'not found' });
      var ids = sheet.getRange(2, idCol, last - 1, 1).getValues();
      for (var i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === body.siteId) {
          header = addColumns_(sheet, header, Object.keys(body.patch));
          Object.keys(body.patch).forEach(function (k) {
            var c = sheet.getRange(i + 2, header.indexOf(k) + 1);
            c.setNumberFormat('@');
            c.setValue(cell_(body.patch[k]));
          });
          return reply_({ ok: true });
        }
      }
      return reply_({ ok: false, error: 'not found' });
    }
    return reply_({ ok: false, error: 'bad action' });
  } finally {
    lock.releaseLock();
  }
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

/** Writes the header row on first use; returns the current header (humans may have added columns). */
function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return HEADERS.slice();
  }
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function addColumns_(sheet, header, keys) {
  keys.forEach(function (k) {
    if (header.indexOf(k) === -1) {
      header.push(k);
      sheet.getRange(1, header.length).setValue(k);
    }
  });
  return header;
}

/** Plain text; neutralise spreadsheet formulas from user-supplied text. */
function cell_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
