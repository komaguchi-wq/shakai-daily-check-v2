/**
 * SAPIX社会デイリーチェック v2 用 Google Apps Script バックアップエンドポイント
 *
 * 使い方:
 *   1. https://script.google.com/ で新規プロジェクト作成（v1とは別プロジェクト推奨）
 *   2. このファイル全体をコピペ
 *   3. SHEET_ID にバックアップ用スプレッドシートのIDを入れる（無ければ自動作成）
 *   4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー: 全員
 *   5. 発行されたURLをアプリの設定画面に貼り付け
 *
 * プロトコル（v2）:
 *   POST { user, entries: [{ unitId, key, date, correct }, ...] }
 *     → 各 entry を 1行ずつシートに追記。各ユーザーごとに別シートを使用。
 *   GET ?user=xxx
 *     → { status: "ok", entries: [{ unitId, key, date, correct }, ...] }
 */

// ★ 任意: 既存のスプレッドシートを使う場合はIDを入れる（空ならスクリプト初回起動時に自動作成）
const SHEET_ID = "";

function getOrCreateSpreadsheet() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("SHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create("社会デイリーチェック v2 バックアップ");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function getOrCreateUserSheet(user) {
  const ss = getOrCreateSpreadsheet();
  const name = `events_${user}`;
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(["unitId", "key", "date", "correct"]);
  }
  return sheet;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const user = String(body.user || "").trim();
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!user || entries.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ status: "ok", added: 0 }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const sheet = getOrCreateUserSheet(user);
    const rows = entries.map(ev => [
      String(ev.unitId || ""),
      String(ev.key || ""),
      String(ev.date || ""),
      ev.correct ? 1 : 0,
    ]);
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "ok", added: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    const user = String((e.parameter && e.parameter.user) || "").trim();
    if (!user) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "user required" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const sheet = getOrCreateUserSheet(user);
    const lastRow = sheet.getLastRow();
    const entries = [];
    if (lastRow > 1) {
      const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      for (const row of values) {
        entries.push({
          unitId: row[0],
          key: row[1],
          date: row[2] instanceof Date ? row[2].toISOString() : String(row[2]),
          correct: row[3] ? 1 : 0,
        });
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "ok", entries }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
