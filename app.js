// ==============================
// SAPIX社会 デイリーチェック v2
// ==============================

// --- 状態管理 ---
let currentUser = null;
let categoriesList = [];
let currentCategory = null;
let unitsList = [];
let currentUnit = null;
let quizData = null;
let activePages = [];
let currentPageIndex = 0;
let currentRegionIndex = 0;
let sessionResults = {};
let answerRevealed = false;
let imageCache = {};
let currentMode = "all";
let pendingAnswers = {};
let idleTimer = null;
const IDLE_TIMEOUT = 10000;

// 閲覧モード
let readingPages = [];
let readingIndex = 0;
let currentReadingSection = null;

// セクション
let currentSection = null;

// クイズ対象セクション（dailystep=オレンジマスク / kakunin・coreplus=回答らんへ解答移植して小問マスク）
const QUIZ_TYPES = new Set(["dailystep", "kakunin", "coreplus"]);
// セクション表示順: 説明文 → デイリーステップ → 授業の確認問題 → コアプラス＋デイリーチェック
const SECTION_ORDER = ["description", "dailystep", "kakunin", "coreplus"];

const SECTION_META = {
  description: { label: "説明文", icon: "📝" },
  dailystep: { label: "デイリーステップ", icon: "📋" },
  kakunin: { label: "授業の確認問題", icon: "✏️" },
  coreplus: { label: "コアプラス＋デイリーチェック", icon: "🔑" },
};
// 旧コードとの互換性
const SECTION_LABELS = Object.fromEntries(
  Object.entries(SECTION_META).map(([k, v]) => [k, v.label])
);

// Google Sheets バックアップ用（v2は別キーで管理）
let SHEETS_API_URL = localStorage.getItem("shakai-v2-sheets-api-url") || "https://script.google.com/macros/s/AKfycbzMudApjWjGc3OkrRA6iwHCTVclVWe3ht2fxDUd6_1uBcHKwcxDOCcGhEiYTqFfDCqZ/exec";

// --- トラッキングデータ ---
function getTracking() {
  const key = `shakai-tracking-v2-${currentUser}`;
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

function setTracking(data) {
  localStorage.setItem(`shakai-tracking-v2-${currentUser}`, JSON.stringify(data));
}

function getRegionTracking(unitId, pageId, regionIdx) {
  const tracking = getTracking();
  const unitData = tracking[unitId] || {};
  return unitData[`${pageId}-${regionIdx}`] || { attempts: 0, correct: 0 };
}

function recordAnswer(unitId, pageId, regionIdx, isCorrect) {
  const tracking = getTracking();
  if (!tracking[unitId]) tracking[unitId] = {};
  const key = `${pageId}-${regionIdx}`;
  if (!tracking[unitId][key]) tracking[unitId][key] = { attempts: 0, correct: 0 };
  tracking[unitId][key].attempts++;
  if (isCorrect) tracking[unitId][key].correct++;
  setTracking(tracking);
  appendEvent({ unitId, key, date: new Date().toISOString(), correct: isCorrect ? 1 : 0 });
  flushSyncQueue();
}

// --- イベントログ（v1 互換のバックアップ方式）---
function eventsKey() { return `shakai-events-v2-${currentUser}`; }
function cursorKey() { return `shakai-cursor-v2-${currentUser}`; }
function migratedKey() { return `shakai-migrated-v2-${currentUser}`; }

function getEvents() {
  try { return JSON.parse(localStorage.getItem(eventsKey())) || []; } catch { return []; }
}
function setEvents(evs) { localStorage.setItem(eventsKey(), JSON.stringify(evs)); }
function getCursor() { return parseInt(localStorage.getItem(cursorKey()) || "0", 10); }
function setCursor(i) { localStorage.setItem(cursorKey(), String(i)); }

function appendEvent(ev) {
  const evs = getEvents();
  evs.push(ev);
  // 過去500件超は古いものから削除（メモリ保護。GAS側には送信済み）
  if (evs.length > 5000) evs.splice(0, evs.length - 5000);
  setEvents(evs);
}

// 既存 tracking → events 1回限りマイグレーション（既存ユーザーのデータを GAS にバックアップ可能化）
function migrateLegacyTrackingToEvents() {
  if (!currentUser) return;
  if (localStorage.getItem(migratedKey()) === "1") return;
  const tracking = getTracking();
  const synthetic = [];
  let ts = new Date("2026-01-01T00:00:00Z").getTime();
  for (const u in tracking) {
    for (const k in tracking[u]) {
      const t = tracking[u][k] || { attempts: 0, correct: 0 };
      for (let i = 0; i < t.attempts; i++) {
        synthetic.push({
          unitId: u, key: k,
          date: new Date(ts).toISOString(),
          correct: i < t.correct ? 1 : 0,
        });
        ts += 1000;
      }
    }
  }
  if (synthetic.length > 0) {
    const existing = getEvents();
    setEvents([...synthetic, ...existing]);
    setCursor(0);  // 全件未送信扱い
  }
  localStorage.setItem(migratedKey(), "1");
}

// Sheets のセル自動変換対策: "1-1" 等のキーは日付として保存されてしまうため
// 送信時は "k:" を付けてテキスト化し、受信時は旧形式（素のキー／日付に化けた値）も復元する
function encodeSyncKey(k) { return "k:" + k; }
function decodeSyncKey(raw) {
  const s = String(raw);
  if (s.startsWith("k:")) return s.slice(2);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || /GMT[+-]\d{4}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) {
      const jst = new Date(d.getTime() + 9 * 3600 * 1000);
      return (jst.getUTCMonth() + 1) + "-" + jst.getUTCDate();
    }
  }
  return s;
}

// オフライン時は失敗を無視し cursor を進めない → 次回送信時に未送信分まとめて送る
async function flushSyncQueue() {
  if (!SHEETS_API_URL || !currentUser) return;
  const evs = getEvents();
  const cur = getCursor();
  if (cur >= evs.length) return;
  const batch = evs.slice(cur);
  try {
    const res = await fetch(SHEETS_API_URL, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },  // GAS は preflight 回避のため text/plain で受ける
      body: JSON.stringify({ user: currentUser, entries: batch.map((ev) => ({ ...ev, key: encodeSyncKey(ev.key) })) }),
    });
    // no-cors fallback: レスポンスが opaque な場合は楽観的にカーソル進行
    if (res.type === "opaque" || res.ok) {
      setCursor(evs.length);
    } else {
      const json = await res.json().catch(() => null);
      if (json && json.status === "ok") setCursor(evs.length);
    }
  } catch (e) {
    console.warn("flushSyncQueue failed (will retry):", e.message);
  }
}

// 起動時自動復元: 未送信分を flush → GAS から全件 GET → イベント再構築でカウンタ更新
async function autoSyncFromSheets() {
  if (!SHEETS_API_URL || !currentUser) return;
  await flushSyncQueue();
  try {
    const url = SHEETS_API_URL + "?user=" + encodeURIComponent(currentUser);
    const res = await fetch(url, { method: "GET", mode: "cors" });
    if (!res.ok) return;
    const json = await res.json();
    if (json.status !== "ok" || !Array.isArray(json.entries)) return;
    // リモートイベント → tracking 再構築
    const remote = {};
    for (const e of json.entries) {
      const k = decodeSyncKey(e.key);
      if (!remote[e.unitId]) remote[e.unitId] = {};
      if (!remote[e.unitId][k]) remote[e.unitId][k] = { attempts: 0, correct: 0 };
      remote[e.unitId][k].attempts++;
      if (e.correct) remote[e.unitId][k].correct++;
    }
    // マージ: キーごとに attempts の多い方を採用（多端末対応）
    const local = getTracking();
    let changed = false;
    for (const u in remote) {
      if (!local[u]) local[u] = {};
      for (const k in remote[u]) {
        const rem = remote[u][k];
        const loc = local[u][k] || { attempts: 0, correct: 0 };
        if (rem.attempts > loc.attempts) {
          local[u][k] = rem;
          changed = true;
        }
      }
    }
    if (changed) {
      setTracking(local);
      if (currentCategory) renderUnits();
    }
  } catch (e) {
    console.warn("autoSyncFromSheets failed:", e.message);
  }
}

// ネットワーク復帰時の自動再送
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") flushSyncQueue();
});
window.addEventListener("online", () => flushSyncQueue());

function getAccuracy(unitId, pageId, regionIdx) {
  const t = getRegionTracking(unitId, pageId, regionIdx);
  if (t.attempts === 0) return null;
  return t.correct / t.attempts;
}

function getUnitStats(unitId) {
  const tracking = getTracking();
  const unitData = tracking[unitId] || {};
  let totalAttempts = 0, totalCorrect = 0, totalQuestions = 0;
  for (const key in unitData) {
    if (key.startsWith("xyz-")) continue; // 授業の確認問題(X/Y/Z)は専用カードで集計するため除外
    totalQuestions++;
    totalAttempts += unitData[key].attempts;
    totalCorrect += unitData[key].correct;
  }
  return { totalQuestions, totalAttempts, totalCorrect };
}

// 単元カード用: 「解いた問数 / 対象問数」の達成率。
// デイリーチェックは 授業の確認問題(X/Y/Z)＋デイリーステップ のみを分母にし、コアプラスは外す。
// X/Y/Zがある単元では確認問題のマスクregion（X/Y/Zカードに置き換わり解けない分）も分母から外す。
// 対象セクションが無いカテゴリ（Weekly・コアプラス等）は従来通り全問数（totalRegions）。
// 「解いた」= 正誤表に1度でもチェックが入っている（attempts > 0）。
// セクション情報は units.json の sectionRegions / sectionPages / xyzCount（無い単元は全問数へフォールバック）
function getUnitProgress(unit) {
  const sr = unit.sectionRegions || null;
  const xyzN = unit.xyzCount || 0;
  const filtered = !!(sr && ((sr.dailystep || 0) > 0 || xyzN > 0));
  const total = filtered
    ? (sr.dailystep || 0) + (xyzN > 0 ? xyzN : (sr.kakunin || 0))
    : (unit.totalRegions || 0);
  const pageSections = unit.sectionPages || {};
  const unitData = getTracking()[unit.id] || {};
  let attempted = 0;
  for (const key in unitData) {
    const t = unitData[key];
    if (!t || !(t.attempts > 0)) continue;
    if (key.startsWith("xyz-")) {
      // 授業の確認問題(X/Y/Z)。filtered時は分母に入っている場合のみ数える
      if (!filtered) continue; // フォールバック時の分母(totalRegions)はxyzを含まないため除外
      if (xyzN > 0) attempted++;
      continue;
    }
    if (filtered) {
      const sec = pageSections[key.slice(0, key.lastIndexOf("-"))];
      if (!(sec === "dailystep" || (xyzN === 0 && sec === "kakunin"))) continue;
    }
    attempted++;
  }
  return { total, attempted: Math.min(attempted, total) };
}

// --- Google Sheets（手動復元ボタン用ラッパ）---
async function restoreFromSheets() {
  if (!SHEETS_API_URL) { alert("URLが設定されていません"); return; }
  if (!confirm("スプレッドシートから最新データを取得してマージしますか？\n（attempts数が多い側を優先）")) return;
  await autoSyncFromSheets();
  alert("復元しました");
  if (currentCategory) renderUnits();
}

function openSettings() {
  document.getElementById("settings-url").value = SHEETS_API_URL;
  showScreen("screen-settings");
}

function saveSettings() {
  const url = document.getElementById("settings-url").value.trim();
  SHEETS_API_URL = url;
  localStorage.setItem("shakai-v2-sheets-api-url", url);
  alert("保存しました");
}

function closeSettings() {
  renderCategories();
  showScreen("screen-categories");
}

// --- 画面切り替え ---
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ==============================
// ユーザー選択
// ==============================
function selectUser(user) {
  currentUser = user;
  sessionStorage.setItem("shakai-current-user-v2", user);
  try { localStorage.setItem('study-user', user); } catch (e) {}
  document.getElementById("header-user-name").textContent = user;
  migrateLegacyTrackingToEvents();
  loadCategories();
  autoSyncFromSheets();  // バックグラウンドで最新データ取得＋マージ
}

// ==============================
// カテゴリ一覧
// ==============================
async function loadCategories() {
  const res = await fetch("categories.json");
  categoriesList = await res.json();
  renderCategories();
  showScreen("screen-categories");
}

function renderCategories() {
  const list = document.getElementById("category-list");
  list.innerHTML = "";
  categoriesList.forEach(cat => {
    const card = document.createElement("div");
    card.className = "unit-card";
    card.innerHTML = `
      <div class="unit-card-info">
        <div class="unit-card-title">${cat.icon} ${cat.name}</div>
        <div class="unit-card-subtitle">${cat.description}</div>
      </div>`;
    card.addEventListener("click", () => openCategory(cat));
    list.appendChild(card);
  });
}

async function openCategory(cat) {
  // 独立ページを持つカテゴリ（重要年代150問など）はそのページへ遷移
  if (cat.url) { location.href = cat.url; return; }
  currentCategory = cat;
  document.getElementById("units-header-title").textContent = cat.name;
  const res = await fetch(`categories/${cat.id}/units.json`);
  unitsList = await res.json();
  renderUnits();
  showScreen("screen-units");
}

// ==============================
// 単元一覧
// ==============================
function renderUnits() {
  const list = document.getElementById("unit-list");
  list.innerHTML = "";
  unitsList.forEach(unit => {
    const card = document.createElement("div");
    card.className = "unit-card";
    // 解いた問数 / 対象問数（授業の確認問題＋デイリーステップ）の達成率
    const prog = getUnitProgress(unit);
    const accuracy = prog.total > 0
      ? Math.round((prog.attempted / prog.total) * 100) + "%"
      : "---";
    card.innerHTML = `
      <div class="unit-card-info">
        <div class="unit-card-title">${unit.id} ${unit.title}</div>
        <div class="unit-card-subtitle">${unit.subject}</div>
      </div>
      <div class="unit-card-stats">
        <div class="unit-card-accuracy">${accuracy}</div>
        <div class="unit-card-detail">${prog.attempted}/${prog.total}</div>
      </div>`;
    card.addEventListener("click", () => openUnit(unit));
    list.appendChild(card);
  });
}

// ==============================
// 単元詳細
// ==============================
async function openUnit(unit) {
  currentUnit = unit;
  document.getElementById("unit-detail-title").textContent = `${unit.id} ${unit.title}`;
  const res = await fetch(`categories/${currentCategory.id}/units/${unit.id}/quiz-data.json`);
  quizData = await res.json();
  renderUnitDetail();
  showScreen("screen-unit-detail");
}

// セクションごとのページ集合（containsSections も考慮）
function getSectionPages(section) {
  return quizData.pages.filter(p =>
    p.type === section || (p.containsSections && p.containsSections.includes(section)));
}

// セクションの統計情報
// 戻り値: { totalPages, totalRegions, attempted, perfectCount, goodCount(67%以上達成), accuracyAvg }
function getSectionStats(section) {
  const pages = getSectionPages(section);
  let totalRegions = 0, attempted = 0, totalCorrect = 0, totalAttempts = 0;
  let goodCount = 0; // 67%以上の正答率を達成した問数
  pages.forEach(p => {
    p.regions.forEach((_, ri) => {
      totalRegions++;
      const t = getRegionTracking(currentUnit.id, p.id, ri);
      if (t.attempts > 0) {
        attempted++;
        totalAttempts += t.attempts;
        totalCorrect += t.correct;
        if (t.correct / t.attempts >= 0.67) goodCount++;
      }
    });
  });
  return { totalPages: pages.length, totalRegions, attempted, goodCount, totalAttempts, totalCorrect };
}

function renderUnitDetail() {
  backupLegacyTrackingOnce();
  const list = document.getElementById("section-card-list");
  list.innerHTML = "";

  SECTION_ORDER.forEach(sec => {
    // 授業の確認問題: xyzデータがあれば X/Y/Z方式カード（問題/解答タブ + 正誤表）。
    // 無い単元は従来のマスク方式カードのまま（段階移行できるよう両対応）。
    if (sec === "kakunin" && quizData && quizData.xyz
        && Array.isArray(quizData.xyz.daimons) && quizData.xyz.daimons.length > 0) {
      list.appendChild(buildXyzCard());
      return;
    }
    const pages = getSectionPages(sec);
    if (pages.length === 0) return;
    const meta = SECTION_META[sec];
    const stats = getSectionStats(sec);
    const isQuizable = QUIZ_TYPES.has(sec) && stats.totalRegions > 0;
    const progress = stats.totalRegions > 0
      ? Math.round((stats.goodCount / stats.totalRegions) * 100)
      : 0;

    const card = document.createElement("div");
    card.className = "section-card";
    if (!isQuizable) card.classList.add("section-reading-only");

    const badge = isQuizable
      ? ""
      : `<span class="section-card-badge">閲覧のみ</span>`;
    const statsHTML = isQuizable
      ? `<div class="section-card-stats">
           <div class="section-card-stats-main">${stats.goodCount}/${stats.totalRegions}</div>
           <div class="section-card-stats-sub">67%↑ 達成 (${progress}%)</div>
         </div>`
      : `<div class="section-card-stats">
           <div class="section-card-stats-main" style="color:#86868b">${pages.length}p</div>
           <div class="section-card-stats-sub">ページ</div>
         </div>`;

    card.innerHTML = `
      <div class="section-card-icon">${meta.icon}</div>
      <div class="section-card-body">
        <div class="section-card-title">${meta.label}${badge}</div>
        <div class="section-card-meta">${pages.length}ページ${isQuizable ? ` ・ 全${stats.totalRegions}問` : ""}</div>
        <div class="section-card-progress">
          <div class="section-card-progress-fill" style="width: ${progress}%;"></div>
        </div>
      </div>
      ${statsHTML}
    `;

    card.addEventListener("click", () => openSection(sec));
    list.appendChild(card);
  });
}

function openSection(section) {
  currentSection = section;
  const meta = SECTION_META[section];
  document.getElementById("section-detail-title").textContent =
    `${meta.icon} ${meta.label}`;
  renderSectionDetail();
  showScreen("screen-section-detail");
}

function renderSectionDetail() {
  // モードボタンの有効/無効
  const isQuizable = QUIZ_TYPES.has(currentSection);
  const pages = getSectionPages(currentSection);
  const stats = getSectionStats(currentSection);

  // モード行の表示: 非クイズ(説明文等)はクイズ系を隠し「順番に読む」だけ表示
  document.querySelectorAll('.mode-row').forEach(row => {
    const m = row.dataset.modeRow;
    row.classList.toggle('hidden', m !== 'reading' && !isQuizable);
  });

  // 「順番に読む」とその印刷は常に有効（ページがあれば）
  const readingOk = pages.length > 0;
  document.querySelector('[data-section-mode="reading"]').disabled = !readingOk;
  document.querySelector('[data-print-mode="reading"]').disabled = !readingOk;

  // クイズ系モード件数
  let countUnanswered = 0, countBelow50 = 0, countBelow67 = 0, countBelow99 = 0, totalAll = 0;
  pages.forEach(page => {
    page.regions.forEach((_, ri) => {
      totalAll++;
      const acc = getAccuracy(currentUnit.id, page.id, ri);
      if (acc === null) countUnanswered++;
      if (acc !== null && acc <= 0.5) countBelow50++;
      if (acc !== null && acc <= 0.67) countBelow67++;
      if (acc !== null && acc < 1.0) countBelow99++;
    });
  });
  const setBtn = (mode, count) => {
    const btn = document.querySelector(`[data-section-mode="${mode}"]`);
    const pbtn = document.querySelector(`[data-print-mode="${mode}"]`);
    if (btn) {
      const baseLabel = btn.textContent.replace(/\s*\(.*\)$/, "");
      btn.textContent = `${baseLabel} (${count}問)`;
      btn.disabled = !isQuizable || count === 0;
    }
    if (pbtn) pbtn.disabled = !isQuizable || count === 0;
  };
  setBtn("continue", countUnanswered);
  setBtn("all", totalAll);
  setBtn("below50", countBelow50);
  setBtn("below67", countBelow67);
  setBtn("below99", countBelow99);
  setBtn("unanswered", countUnanswered);

  // ページ一覧
  const list = document.getElementById("section-page-list");
  list.innerHTML = "";
  pages.forEach((page) => {
    const card = document.createElement("div");
    card.className = "page-card";
    const regionCount = page.regions.length;
    let attempted = 0, correctCount = 0;
    page.regions.forEach((_, ri) => {
      const t = getRegionTracking(currentUnit.id, page.id, ri);
      if (t.attempts > 0) {
        attempted++;
        if (t.correct / t.attempts >= 1) correctCount++;
      }
    });
    let badge = "";
    if (regionCount === 0) {
      badge = `<span class="badge badge-new">閲覧</span>`;
    } else if (attempted === 0) {
      badge = `<span class="badge badge-new">未回答</span>`;
    } else if (correctCount === regionCount) {
      badge = `<span class="badge badge-perfect">全問正解</span>`;
    } else {
      badge = `<span class="badge badge-in-progress">${Math.round(correctCount/regionCount*100)}%</span>`;
    }
    const label = getPageLabel(page);
    const imgPath = unitImagesBase() + (page.imageMasked || page.image);
    card.innerHTML = `
      <div class="page-card-thumb"><img src="${imgPath}" loading="lazy" alt="${label}"></div>
      <div class="page-card-title">${label}</div>
      <div class="page-card-info">${regionCount > 0 ? regionCount + "問" : "閲覧"}</div>
      ${badge}`;
    card.addEventListener("click", () => {
      if (regionCount > 0 && isQuizable) {
        currentMode = "all";
        activePages = pages.filter(p => p.regions.length > 0);
        const idx = activePages.indexOf(page);
        if (idx >= 0) startQuiz(idx);
      } else {
        // 閲覧モード
        readingPages = pages;
        readingIndex = pages.indexOf(page);
        currentReadingSection = currentSection;
        showScreen("screen-reading");
        renderReading();
      }
    });
    list.appendChild(card);
  });

  // 正答率テーブル（クイズ可セクションのみ表示）
  const accWrapper = document.getElementById("section-accuracy-wrapper");
  if (!isQuizable || stats.totalRegions === 0) {
    accWrapper.innerHTML = `<p style="color:#86868b;font-size:13px;">このセクションは閲覧のみです</p>`;
  } else {
    let rows = "";
    let qNum = 0;
    pages.forEach(page => {
      page.regions.forEach((_, ri) => {
        qNum++;
        const t = getRegionTracking(currentUnit.id, page.id, ri);
        let accText, accClass;
        if (t.attempts === 0) { accText = "未回答"; accClass = "acc-none"; }
        else {
          const pct = Math.round((t.correct / t.attempts) * 100);
          accText = `${t.correct}/${t.attempts} (${pct}%)`;
          if (pct === 100) accClass = "acc-perfect";
          else if (pct >= 67) accClass = "acc-good";
          else if (pct > 0) accClass = "acc-bad";
          else accClass = "acc-zero";
        }
        rows += `<tr><td>${qNum}</td><td>${getPageLabel(page)}</td><td class="${accClass}">${accText}</td></tr>`;
      });
    });
    accWrapper.innerHTML = `<table class="accuracy-table"><thead><tr><th>#</th><th>ページ</th><th>正答率</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}

function getPageLabel(page) {
  const sec = SECTION_LABELS[page.type] || page.type;
  return `${sec} p${page.id}`;
}

// ==============================
// 閲覧モード
// ==============================
function startReading(section) {
  readingPages = getSectionPages(section);
  if (readingPages.length === 0) return;
  currentReadingSection = section;
  readingIndex = 0;
  showScreen("screen-reading");
  renderReading();
}

function renderReading() {
  const page = readingPages[readingIndex];
  document.getElementById("reading-title").textContent =
    `${SECTION_LABELS[currentReadingSection]} (${currentUnit.id} ${currentUnit.title})`;
  document.getElementById("reading-page-info").textContent = `p${page.id}`;
  document.getElementById("reading-indicator").textContent =
    `${readingIndex + 1} / ${readingPages.length}`;
  document.getElementById("btn-reading-prev").disabled = readingIndex === 0;
  document.getElementById("btn-reading-next").disabled = readingIndex === readingPages.length - 1;
  const img = document.getElementById("reading-image");
  img.src = unitImagesBase() + page.image;
  const hasExpl = Array.isArray(page.explanationImages) && page.explanationImages.length > 0;
  document.getElementById("btn-explain-reading").classList.toggle("hidden", !hasExpl);
}

function openExplanationReading() {
  const page = readingPages[readingIndex];
  if (!page || !Array.isArray(page.explanationImages) || page.explanationImages.length === 0) return;
  explainImages = page.explanationImages;
  explainIndex = 0;
  document.getElementById("explain-overlay").classList.remove("hidden");
  renderExplanation();
}

// ==============================
// クイズモード
// ==============================
function isTargetForMode(pageId, regionIdx, mode) {
  if (mode === "all") return true;
  const acc = getAccuracy(currentUnit.id, pageId, regionIdx);
  if (mode === "continue" || mode === "unanswered") return acc === null;
  if (mode === "below50") return acc !== null && acc <= 0.5;
  if (mode === "below67") return acc !== null && acc <= 0.67;
  if (mode === "below99") return acc !== null && acc < 1.0;
  return true;
}

function isTargetRegion(pageId, regionIdx) {
  return isTargetForMode(pageId, regionIdx, currentMode);
}

function startWithMode(mode) {
  if (mode === "reading") {
    startReading(currentSection);
    return;
  }
  currentMode = mode;
  // currentSection の pages のうち regions があるもの
  const allPages = getSectionPages(currentSection).filter(p => p.regions.length > 0);
  if (allPages.length === 0) return;
  if (mode === "all") {
    activePages = allPages; sessionResults = {}; startQuiz(0);
  } else if (mode === "continue") {
    activePages = allPages; sessionResults = {};
    let foundPage = 0, foundRegion = 0, found = false;
    for (let pi = 0; pi < activePages.length && !found; pi++) {
      for (let ri = 0; ri < activePages[pi].regions.length; ri++) {
        if (getAccuracy(currentUnit.id, activePages[pi].id, ri) === null) {
          foundPage = pi; foundRegion = ri; found = true; break;
        }
      }
    }
    currentRegionIndex = foundRegion;
    startQuiz(foundPage);
  } else if (mode === "unanswered") {
    activePages = allPages.filter(p =>
      p.regions.some((_, ri) => getAccuracy(currentUnit.id, p.id, ri) === null));
    sessionResults = {};
    if (activePages.length > 0) startQuiz(0);
  } else {
    const threshold = mode === "below50" ? 0.5 : mode === "below67" ? 0.67 : 0.99;
    activePages = allPages.filter(p =>
      p.regions.some((_, ri) => {
        const a = getAccuracy(currentUnit.id, p.id, ri);
        return a !== null && a <= threshold;
      }));
    sessionResults = {};
    if (activePages.length > 0) startQuiz(0);
  }
}

function startQuiz(pageIdx) {
  currentPageIndex = pageIdx;
  if (currentRegionIndex === undefined || currentRegionIndex === 0) {
    currentRegionIndex = findFirstUnansweredInSession(activePages[pageIdx]);
  }
  answerRevealed = false;
  showScreen("screen-quiz");
  renderQuiz();
}

function isAnswered(key) {
  return sessionResults[key] || pendingAnswers[key];
}

function findFirstUnansweredInSession(page) {
  for (let i = 0; i < page.regions.length; i++) {
    if (!isAnswered(`${page.id}-${i}`) && isTargetRegion(page.id, i)) return i;
  }
  return 0;
}

function findNextUnansweredInSession(page, fromIndex) {
  for (let i = fromIndex + 1; i < page.regions.length; i++) {
    if (!isAnswered(`${page.id}-${i}`) && isTargetRegion(page.id, i)) return i;
  }
  for (let i = 0; i < fromIndex; i++) {
    if (!isAnswered(`${page.id}-${i}`) && isTargetRegion(page.id, i)) return i;
  }
  return -1;
}

async function renderQuiz() {
  const page = activePages[currentPageIndex];
  const canvas = document.getElementById("quiz-canvas");
  const ctx = canvas.getContext("2d");
  document.getElementById("quiz-title").textContent = getPageLabel(page);
  document.getElementById("quiz-page-info").textContent =
    `${currentRegionIndex + 1} / ${page.regions.length}問`;
  document.getElementById("page-indicator").textContent =
    `p${currentPageIndex + 1} / ${activePages.length}ページ`;
  document.getElementById("btn-prev-page").disabled = currentPageIndex === 0;
  document.getElementById("btn-next-page").disabled = currentPageIndex === activePages.length - 1;

  const targetCount = page.regions.filter((_, i) => isTargetRegion(page.id, i)).length;
  const answeredCount = page.regions.filter((_, i) =>
    isAnswered(`${page.id}-${i}`) && isTargetRegion(page.id, i)).length;
  document.getElementById("progress-fill").style.width =
    targetCount > 0 ? `${(answeredCount / targetCount) * 100}%` : "0%";

  const imgBase = unitImagesBase();
  const origImg = await loadImage(imgBase + page.image);
  const maskImg = await loadImage(imgBase + page.imageMasked);

  canvas.width = page.width;
  canvas.height = page.height;
  const wrapper = document.getElementById("canvas-wrapper");
  const scaleW = (wrapper.clientWidth - 8) / page.width;
  const scaleH = (wrapper.clientHeight - 8) / page.height;
  const scale = Math.min(scaleW, scaleH);
  canvas.style.width = Math.floor(page.width * scale) + "px";
  canvas.style.height = Math.floor(page.height * scale) + "px";

  ctx.drawImage(maskImg, 0, 0);

  page.regions.forEach((region, i) => {
    const key = `${page.id}-${i}`;
    const target = isTargetRegion(page.id, i);
    const committed = sessionResults[key];
    const pending = pendingAnswers[key];
    if (committed || pending || !target) {
      const pad = 4;
      const sx = Math.max(0, region.x - pad);
      const sy = Math.max(0, region.y - pad);
      const sw = Math.min(page.width - sx, region.w + pad * 2);
      const sh = Math.min(page.height - sy, region.h + pad * 2);
      ctx.drawImage(origImg, sx, sy, sw, sh, sx, sy, sw, sh);
      enhanceOrangeRegion(ctx, sx, sy, sw, sh);
      if (committed) drawResultMark(ctx, region, committed);
      else if (pending) drawPendingMark(ctx, region, pending);
    }
  });

  if (currentRegionIndex < page.regions.length) {
    const region = page.regions[currentRegionIndex];
    const key = `${page.id}-${currentRegionIndex}`;
    if (!isAnswered(key)) {
      const lw = markLineWidth(ctx);
      const pad = 6 + lw / 2;
      ctx.strokeStyle = "#e8a040";
      ctx.lineWidth = lw;
      ctx.strokeRect(region.x - pad, region.y - pad, region.w + pad * 2, region.h + pad * 2);
    }
  }

  updateControlVisibility();
}

// 画像は300DPI(横4000px超)で画面では約1/4に縮小されるため、線幅は画像幅に比例させる
function markLineWidth(ctx) {
  return Math.max(8, Math.round(ctx.canvas.width * 0.004));
}

function drawResultMark(ctx, region, result) {
  const lw = markLineWidth(ctx);
  const pad = 4 + lw / 2;
  ctx.strokeStyle = result === "correct" ? "rgba(52,199,89,0.85)" : "rgba(255,59,48,0.85)";
  ctx.lineWidth = lw;
  ctx.strokeRect(region.x - pad, region.y - pad, region.w + pad * 2, region.h + pad * 2);
}

function drawPendingMark(ctx, region, result) {
  const lw = markLineWidth(ctx);
  const pad = 4 + lw / 2;
  ctx.strokeStyle = result === "correct" ? "rgba(52,199,89,0.85)" : "rgba(255,59,48,0.85)";
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 2.5, lw * 1.5]);
  ctx.strokeRect(region.x - pad, region.y - pad, region.w + pad * 2, region.h + pad * 2);
  ctx.setLineDash([]);
}

function updateControlVisibility() {
  const page = activePages[currentPageIndex];
  const key = `${page.id}-${currentRegionIndex}`;
  const revealRow = document.getElementById("reveal-row");
  const judgeRow = document.getElementById("judge-row");
  revealRow.classList.add("hidden");
  judgeRow.classList.add("hidden");
  if (!isTargetRegion(page.id, currentRegionIndex)) revealRow.classList.remove("hidden");
  else if (pendingAnswers[key]) { judgeRow.classList.remove("hidden"); updatePendingVisual(); }
  else if (sessionResults[key]) revealRow.classList.remove("hidden");
  else if (answerRevealed) { judgeRow.classList.remove("hidden"); updatePendingVisual(); }
  else revealRow.classList.remove("hidden");

  // 解説ボタン: 当該ページに解説画像があれば両rowで表示
  const hasExpl = Array.isArray(page.explanationImages) && page.explanationImages.length > 0;
  document.getElementById("btn-explain-reveal").classList.toggle("hidden", !hasExpl);
  document.getElementById("btn-explain-judge").classList.toggle("hidden", !hasExpl);
}

// ==============================
// 解説オーバーレイ
// ==============================
let explainImages = [];
let explainIndex = 0;

function openExplanation() {
  const page = activePages[currentPageIndex];
  if (!page || !Array.isArray(page.explanationImages) || page.explanationImages.length === 0) return;
  explainImages = page.explanationImages;
  explainIndex = 0;
  document.getElementById("explain-overlay").classList.remove("hidden");
  renderExplanation();
}

function renderExplanation() {
  const base = unitImagesBase();
  const img = document.getElementById("explain-img");
  img.style.transform = "";
  img.src = base + explainImages[explainIndex];
  document.getElementById("explain-viewport").scrollTop = 0;
  const multi = explainImages.length > 1;
  document.getElementById("explain-nav").classList.toggle("hidden", !multi);
  document.getElementById("explain-indicator").textContent =
    multi ? `${explainIndex + 1} / ${explainImages.length}枚` : "";
  document.getElementById("explain-page-indicator").textContent =
    `${explainIndex + 1} / ${explainImages.length}`;
  document.getElementById("explain-prev").disabled = explainIndex === 0;
  document.getElementById("explain-next").disabled = explainIndex === explainImages.length - 1;
}

function closeExplanation() {
  document.getElementById("explain-overlay").classList.add("hidden");
}

function enhanceOrangeRegion(ctx, sx, sy, sw, sh) {
  const imageData = ctx.getImageData(sx, sy, sw, sh);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    if (r > g && g > b && (r - b) > 15) {
      d[i]   = Math.min(255, Math.round(r * 1.6 - (g + b) * 0.15));
      d[i+1] = Math.min(255, Math.round(g * 0.6));
      d[i+2] = Math.min(255, Math.round(b * 0.4));
    }
  }
  ctx.putImageData(imageData, sx, sy);
}

async function revealAnswer() {
  resetIdleTimer();
  const page = activePages[currentPageIndex];
  const region = page.regions[currentRegionIndex];
  const canvas = document.getElementById("quiz-canvas");
  const ctx = canvas.getContext("2d");
  const origImg = await loadImage(unitImagesBase() + page.image);
  const pad = 4;
  const sx = Math.max(0, region.x - pad);
  const sy = Math.max(0, region.y - pad);
  const sw = Math.min(page.width - sx, region.w + pad * 2);
  const sh = Math.min(page.height - sy, region.h + pad * 2);
  ctx.drawImage(origImg, sx, sy, sw, sh, sx, sy, sw, sh);
  enhanceOrangeRegion(ctx, sx, sy, sw, sh);
  const lw = markLineWidth(ctx);
  ctx.strokeStyle = "#e8a040";
  ctx.lineWidth = lw;
  ctx.strokeRect(sx - 2 - lw / 2, sy - 2 - lw / 2, sw + 4 + lw, sh + 4 + lw);
  answerRevealed = true;
  updateControlVisibility();
}

// 仮選択
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (Object.keys(pendingAnswers).length > 0)
    idleTimer = setTimeout(commitAllPending, IDLE_TIMEOUT);
}

function commitAllPending() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const keys = Object.keys(pendingAnswers);
  if (keys.length === 0) return;
  for (const key of keys) {
    const result = pendingAnswers[key];
    sessionResults[key] = result;
    const lastDash = key.lastIndexOf('-');
    const pageId = parseInt(key.substring(0, lastDash));
    const regionIndex = parseInt(key.substring(lastDash + 1));
    recordAnswer(currentUnit.id, pageId, regionIndex, result === "correct");
  }
  pendingAnswers = {};
  updatePendingVisual();
  renderQuiz();
}

function updatePendingVisual() {
  const page = activePages[currentPageIndex];
  const key = `${page.id}-${currentRegionIndex}`;
  const pending = pendingAnswers[key];
  const btnC = document.getElementById("btn-correct");
  const btnI = document.getElementById("btn-incorrect");
  if (pending) {
    const isCorrect = pending === "correct";
    btnC.classList.toggle("pending", isCorrect);
    btnI.classList.toggle("pending", !isCorrect);
    btnC.classList.toggle("pending-dim", !isCorrect);
    btnI.classList.toggle("pending-dim", isCorrect);
  } else {
    btnC.classList.remove("pending", "pending-dim");
    btnI.classList.remove("pending", "pending-dim");
  }
}

function judgeAnswer(isCorrect) {
  const page = activePages[currentPageIndex];
  const key = `${page.id}-${currentRegionIndex}`;
  pendingAnswers[key] = isCorrect ? "correct" : "wrong";
  updatePendingVisual();
  resetIdleTimer();
  answerRevealed = false;
  const nextIdx = findNextUnansweredInSession(page, currentRegionIndex);
  if (nextIdx !== -1) {
    currentRegionIndex = nextIdx;
    renderQuiz();
  } else {
    if (currentPageIndex < activePages.length - 1) {
      currentPageIndex++;
      currentRegionIndex = findFirstUnansweredInSession(activePages[currentPageIndex]);
      renderQuiz();
    } else {
      commitAllPending();
      showResults();
    }
  }
}

function showResults() {
  commitAllPending();
  let correct = 0, answered = 0;
  // 全アクティブページの集計
  activePages.forEach(page => {
    page.regions.forEach((_, i) => {
      if (!isTargetRegion(page.id, i)) return;
      const key = `${page.id}-${i}`;
      if (sessionResults[key]) {
        answered++;
        if (sessionResults[key] === "correct") correct++;
      }
    });
  });
  const percent = answered > 0 ? Math.round((correct / answered) * 100) : 0;
  document.getElementById("score-correct").textContent = correct;
  document.getElementById("score-total").textContent = answered;
  document.getElementById("score-percent").textContent = percent + "%";
  let emoji = "📚";
  if (percent === 100) emoji = "🎉";
  else if (percent >= 80) emoji = "👍";
  else if (percent >= 50) emoji = "💪";
  document.getElementById("score-emoji").textContent = emoji;
  const hasWrong = activePages.some(p => p.regions.some((_, i) =>
    sessionResults[`${p.id}-${i}`] === "wrong" && isTargetRegion(p.id, i)));
  document.getElementById("btn-retry-wrong").disabled = !hasWrong;
  showScreen("screen-results");
}

// 印刷
async function printCurrentPage() {
  if (!activePages || activePages.length === 0) return;
  const page = activePages[currentPageIndex];
  if (!page) return;
  const isFiltered = ["below50", "below67", "below99"].includes(currentMode);
  const origPath = unitImagesBase() + page.image;
  const maskPath = unitImagesBase() + page.imageMasked;
  let baseImage;
  try {
    baseImage = isFiltered
      ? await renderFilteredPrintCanvas(page, origPath, maskPath)
      : await loadImage(maskPath);
  } catch (e) { alert("画像の読み込みに失敗しました"); return; }
  const crop = getVisibleSourceRegion(baseImage.width, baseImage.height);
  const cc = document.createElement("canvas");
  cc.width = crop.w; cc.height = crop.h;
  cc.getContext("2d").drawImage(baseImage, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  const dataURL = cc.toDataURL("image/png");
  const pageSize = crop.h > crop.w ? "A4 portrait" : "B4 landscape";
  openPrintIframe(`${currentUnit.title} - ${getPageLabel(page)}`, pageSize, dataURL);
}

// ===== プリントオーバーレイ方式（iPad対応・同期 print()）=====
// iOS Safari の「自動プリント禁止」警告と hidden iframe 起因の白紙印刷を回避。
// 1. オーバーレイで画像を表示
// 2. ユーザーが「プリント」ボタンタップ → そのハンドラ内で window.print() を同期呼び出し
// 3. @media print でオーバーレイの画像のみ印刷、他要素は非表示
function _dataURLtoBlobURL(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = (head.match(/data:([^;]+)/) || [, "image/png"])[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

let _printActiveBlobURLs = [];

function _resetPrintOverlay() {
  const body = document.getElementById("print-overlay-body");
  if (body) body.innerHTML = "";
  _printActiveBlobURLs.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  _printActiveBlobURLs = [];
}

function _closePrintOverlay() {
  const ov = document.getElementById("print-overlay");
  if (ov) ov.classList.remove("active");
  _resetPrintOverlay();
}

// 印刷用紙の向きと「1画像=1ページ」用の高さ上限を、先頭画像の向きから決める。
// ★高さ上限は vh(画面基準)ではなく物理mmで指定する。vh だと iOS Safari の印刷で
//   画面px→紙mm 換算が端末ごとに狂い、特定iPadで「次ページが前ページに食い込む」
//   ドリフトが出る(算数アプリで実際に発生→mm化で解消)。
function _setPrintPageGeometry(img) {
  const portrait = !!(img && img.naturalHeight > img.naturalWidth);
  const pageSize = portrait ? "A4 portrait" : "B4 landscape";
  // 印刷可能高(mm)=用紙高-余白10mm。A4縦=297-10=287→285、B4横=257-10=247→245(安全側)。
  const maxH = portrait ? 285 : 245;
  let style = document.getElementById("dynamic-print-page");
  if (!style) {
    style = document.createElement("style");
    style.id = "dynamic-print-page";
    document.head.appendChild(style);
  }
  style.textContent =
    `@page { size: ${pageSize}; margin: 5mm; }\n` +
    `@media print { #print-overlay-body .pg img { max-height: ${maxH}mm !important; } }`;
}

function _openPrintOverlay(titleText, dataURLs) {
  const ov = document.getElementById("print-overlay");
  const body = document.getElementById("print-overlay-body");
  if (!ov || !body) return;
  _resetPrintOverlay();
  const urls = Array.isArray(dataURLs) ? dataURLs : [dataURLs];
  _printActiveBlobURLs = urls.map(_dataURLtoBlobURL);
  body.innerHTML = _printActiveBlobURLs
    .map(u => `<div class="pg"><img class="pi" src="${u}"></div>`).join("");
  // 画像 decode 完了したら自動 print()
  const imgs = Array.from(body.querySelectorAll("img.pi"));
  const waits = imgs.map(im => im.decode
    ? im.decode().catch(() => {})
    : new Promise(r => { im.onload = r; im.onerror = r; if (im.complete) r(); }));
  Promise.all(waits).then(() => {
    _setPrintPageGeometry(imgs[0]);  // 向き判定は先頭画像の実寸で
    requestAnimationFrame(() => {
      try { window.print(); } catch (e) { console.warn("print err", e); }
    });
  });
}

function openPrintIframe(titleText, _pageSize, dataURL) {
  _openPrintOverlay(titleText, [dataURL]);
}

async function renderFilteredPrintCanvas(page, origPath, maskPath, mode = currentMode) {
  const off = document.createElement("canvas");
  off.width = page.width; off.height = page.height;
  const oCtx = off.getContext("2d");
  const origImg = await loadImage(origPath);
  const maskImg = await loadImage(maskPath);
  oCtx.drawImage(maskImg, 0, 0);
  for (let i = 0; i < page.regions.length; i++) {
    if (isTargetForMode(page.id, i, mode)) continue;
    const r = page.regions[i];
    const pad = 4;
    oCtx.drawImage(origImg, r.x - pad, r.y - pad, r.w + pad*2, r.h + pad*2,
                            r.x - pad, r.y - pad, r.w + pad*2, r.h + pad*2);
  }
  oCtx.strokeStyle = "#ff8c00"; oCtx.lineWidth = 5;
  for (let i = 0; i < page.regions.length; i++) {
    if (!isTargetForMode(page.id, i, mode)) continue;
    const r = page.regions[i];
    oCtx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
  }
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = off.toDataURL("image/png");
  });
}

// 閲覧ページ（説明文・表紙など）の印刷
async function printReadingPage() {
  const page = readingPages[readingIndex];
  if (!page) return;
  const imgPath = unitImagesBase() + page.image;
  let baseImage;
  try { baseImage = await loadImage(imgPath); }
  catch (e) { alert("画像の読み込みに失敗しました"); return; }
  const cc = document.createElement("canvas");
  cc.width = baseImage.width; cc.height = baseImage.height;
  cc.getContext("2d").drawImage(baseImage, 0, 0);
  const pageSize = baseImage.width > baseImage.height ? "B4 landscape" : "A4 portrait";
  openPrintIframe(`${currentUnit.title} - ${getPageLabel(page)}`, pageSize, cc.toDataURL("image/jpeg", 0.92));
}

// セクションの対象ページを一括印刷（モード別）
async function bulkPrint(mode) {
  const allPages = getSectionPages(currentSection);
  let targetPages, kind;
  if (mode === "reading") {
    targetPages = allPages;          // 全ページ（解答表示の image）
    kind = "image";
  } else {
    // 対象region（このモード）を1つ以上持つページ
    targetPages = allPages.filter(p => p.regions.length > 0 &&
      p.regions.some((_, ri) => isTargetForMode(p.id, ri, mode)));
    kind = ["below50", "below67", "below99"].includes(mode) ? "filtered" : "masked";
  }
  if (targetPages.length === 0) { alert("対象ページがありません"); return; }

  const base = unitImagesBase();
  const dataURLs = [];
  for (const page of targetPages) {
    let img;
    if (kind === "image") {
      img = await loadImage(base + page.image);
    } else if (kind === "filtered") {
      img = await renderFilteredPrintCanvas(page, base + page.image, base + page.imageMasked, mode);
    } else {
      img = await loadImage(base + (page.imageMasked || page.image));
    }
    const cc = document.createElement("canvas");
    cc.width = img.width; cc.height = img.height;
    cc.getContext("2d").drawImage(img, 0, 0);
    dataURLs.push(cc.toDataURL("image/jpeg", 0.92));
  }
  const p0 = targetPages[0];
  const pageSize = p0.width > p0.height ? "B4 landscape" : "A4 portrait";
  const meta = SECTION_META[currentSection];
  openPrintIframeMulti(`${currentUnit.title} - ${meta.label}（${targetPages.length}枚）`, pageSize, dataURLs);
}

function openPrintIframeMulti(titleText, _pageSize, dataURLs) {
  _openPrintOverlay(titleText, dataURLs);
}

function getVisibleSourceRegion(srcW, srcH) {
  const canvas = document.getElementById("quiz-canvas");
  const wrapper = document.getElementById("canvas-wrapper");
  if (!canvas || !wrapper) return { x: 0, y: 0, w: srcW, h: srcH };
  const cssW = canvas.offsetWidth || canvas.width;
  const cssH = canvas.offsetHeight || canvas.height;
  const scaleX = srcW / cssW;
  const scaleY = srcH / cssH;
  const cr = canvas.getBoundingClientRect();
  const wr = wrapper.getBoundingClientRect();
  const visL = Math.max(cr.left, wr.left);
  const visT = Math.max(cr.top, wr.top);
  const visR = Math.min(cr.right, wr.right);
  const visB = Math.min(cr.bottom, wr.bottom);
  if (visR <= visL || visB <= visT) return { x: 0, y: 0, w: srcW, h: srcH };
  return {
    x: Math.max(0, Math.round((visL - cr.left) * scaleX)),
    y: Math.max(0, Math.round((visT - cr.top) * scaleY)),
    w: Math.min(srcW, Math.round((visR - visL) * scaleX)),
    h: Math.min(srcH, Math.round((visB - visT) * scaleY)),
  };
}

function loadImage(src) {
  if (imageCache[src]) return Promise.resolve(imageCache[src]);
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 画像repo分離(絶対URL)時もcanvasが汚染されないように（GitHub PagesはACAO:*を返す）
    if (/^https?:/.test(src)) img.crossOrigin = "anonymous";
    img.onload = () => { imageCache[src] = img; resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}

// 単元画像のベースURL。quizData.imageBase（画像repo分離時の絶対URL）があればそちらを使う
function unitImagesBase() {
  if (quizData && quizData.imageBase) return quizData.imageBase;
  return "categories/" + currentCategory.id + "/units/" + currentUnit.id + "/images/";
}

// ==============================
// イベントリスナー
// ==============================
function setupEventListeners() {
  document.querySelectorAll(".btn-user").forEach(btn =>
    btn.addEventListener("click", () => selectUser(btn.dataset.user)));
  document.getElementById("btn-switch-user").addEventListener("click", () => {
    currentUser = null;
    sessionStorage.removeItem("shakai-current-user-v2");
    try { localStorage.removeItem('study-user'); } catch (e) {}
    showScreen("screen-user");
  });
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  document.getElementById("btn-restore").addEventListener("click", restoreFromSheets);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  // ※ プリントは _openPrintOverlay 内で画像 decode 後に自動 window.print() 呼び出し

  document.getElementById("btn-back-categories").addEventListener("click", () => {
    renderCategories(); showScreen("screen-categories");
  });
  document.getElementById("btn-back-units").addEventListener("click", () => {
    renderUnits(); showScreen("screen-units");
  });

  // セクション詳細から戻る
  document.getElementById("btn-back-section").addEventListener("click", () => {
    renderUnitDetail();
    showScreen("screen-unit-detail");
  });

  // 閲覧モード（ページめくり）
  document.getElementById("btn-back-reading").addEventListener("click", () => {
    if (currentSection) {
      renderSectionDetail();
      showScreen("screen-section-detail");
    } else {
      showScreen("screen-unit-detail");
    }
  });
  document.getElementById("btn-reading-prev").addEventListener("click", () => {
    if (readingIndex > 0) { readingIndex--; renderReading(); }
  });
  document.getElementById("btn-reading-next").addEventListener("click", () => {
    if (readingIndex < readingPages.length - 1) { readingIndex++; renderReading(); }
  });
  document.getElementById("btn-explain-reading").addEventListener("click", openExplanationReading);

  // セクション詳細のモード選択（reading + quiz modes）
  document.querySelectorAll("[data-section-mode]").forEach(btn =>
    btn.addEventListener("click", () => startWithMode(btn.dataset.sectionMode)));
  // セクション詳細の一括印刷
  document.querySelectorAll("[data-print-mode]").forEach(btn =>
    btn.addEventListener("click", () => bulkPrint(btn.dataset.printMode)));
  document.getElementById("reading-print-btn").addEventListener("click", printReadingPage);
  document.getElementById("btn-reveal").addEventListener("click", revealAnswer);
  document.getElementById("btn-correct").addEventListener("click", () => judgeAnswer(true));
  document.getElementById("btn-incorrect").addEventListener("click", () => judgeAnswer(false));
  document.getElementById("btn-explain-reveal").addEventListener("click", openExplanation);
  document.getElementById("btn-explain-judge").addEventListener("click", openExplanation);
  document.getElementById("explain-close").addEventListener("click", closeExplanation);
  document.getElementById("explain-prev").addEventListener("click", () => {
    if (explainIndex > 0) { explainIndex--; renderExplanation(); }
  });
  document.getElementById("explain-next").addEventListener("click", () => {
    if (explainIndex < explainImages.length - 1) { explainIndex++; renderExplanation(); }
  });
  document.getElementById("explain-overlay").addEventListener("click", (e) => {
    if (e.target.id === "explain-overlay") closeExplanation();
  });
  document.getElementById("btn-undo").addEventListener("click", () => {
    const pendingKeys = Object.keys(pendingAnswers);
    if (pendingKeys.length > 0) {
      const lastKey = pendingKeys[pendingKeys.length - 1];
      const dashIdx = lastKey.lastIndexOf("-");
      const targetPageId = lastKey.slice(0, dashIdx);
      const targetRegionIdx = parseInt(lastKey.slice(dashIdx + 1), 10);
      const targetPageIdx = activePages.findIndex(p => String(p.id) === targetPageId);
      if (targetPageIdx !== -1) {
        currentPageIndex = targetPageIdx;
        currentRegionIndex = targetRegionIdx;
      }
      delete pendingAnswers[lastKey];
      answerRevealed = false;
      updatePendingVisual();
      resetIdleTimer();
      renderQuiz();
      return;
    }
    if (currentRegionIndex > 0) {
      currentRegionIndex--;
      answerRevealed = false;
      renderQuiz();
    }
  });
  document.getElementById("btn-prev-page").addEventListener("click", () => {
    resetIdleTimer();
    if (currentPageIndex > 0) {
      currentPageIndex--;
      currentRegionIndex = findFirstUnansweredInSession(activePages[currentPageIndex]);
      answerRevealed = false;
      renderQuiz();
    }
  });
  document.getElementById("btn-next-page").addEventListener("click", () => {
    resetIdleTimer();
    if (currentPageIndex < activePages.length - 1) {
      currentPageIndex++;
      currentRegionIndex = findFirstUnansweredInSession(activePages[currentPageIndex]);
      answerRevealed = false;
      renderQuiz();
    }
  });
  document.getElementById("btn-back-detail").addEventListener("click", () => {
    commitAllPending();
    answerRevealed = false;
    if (currentSection) {
      renderSectionDetail();
      showScreen("screen-section-detail");
    } else {
      renderUnitDetail();
      showScreen("screen-unit-detail");
    }
  });
  document.getElementById("print-btn").addEventListener("click", printCurrentPage);

  document.addEventListener("visibilitychange", () => { if (document.hidden) { commitAllPending(); commitXyz(); } });
  window.addEventListener("beforeunload", () => { commitAllPending(); commitXyz(); });

  document.getElementById("btn-results").addEventListener("click", showResults);
  document.getElementById("btn-retry-wrong").addEventListener("click", () => {
    activePages.forEach(page => {
      page.regions.forEach((_, i) => {
        const key = `${page.id}-${i}`;
        if (sessionResults[key] === "wrong") delete sessionResults[key];
      });
    });
    currentPageIndex = 0;
    currentRegionIndex = findFirstUnansweredInSession(activePages[0]);
    answerRevealed = false;
    showScreen("screen-quiz");
    renderQuiz();
  });
  document.getElementById("btn-back-unit-detail").addEventListener("click", () => {
    if (currentSection) {
      renderSectionDetail();
      showScreen("screen-section-detail");
    } else {
      renderUnitDetail();
      showScreen("screen-unit-detail");
    }
  });
  document.getElementById("btn-back-from-results").addEventListener("click", () => {
    showScreen("screen-quiz"); renderQuiz();
  });
  document.getElementById("quiz-canvas").addEventListener("click", () => {
    const page = activePages[currentPageIndex];
    if (!answerRevealed && isTargetRegion(page.id, currentRegionIndex)) revealAnswer();
  });

  // 授業の確認問題（X/Y/Z方式: 問題/解答タブ + 正誤表）
  document.getElementById("btn-back-wsmode").addEventListener("click", () => {
    renderUnitDetail();
    showScreen("screen-unit-detail");
  });
  document.querySelectorAll("[data-ws-mode]").forEach(btn =>
    btn.addEventListener("click", () => startWsMode(btn.dataset.wsMode)));
  document.querySelectorAll("[data-ws-print]").forEach(btn =>
    btn.addEventListener("click", () => printWsMode(btn.dataset.wsPrint)));
  document.getElementById("btn-back-wsmondai").addEventListener("click", () => {
    commitXyz();
    renderWsMode();
    showScreen("screen-wsmode");
  });
  document.getElementById("wsm-tab-q").addEventListener("click", () => setWsTab(false));
  document.getElementById("wsm-tab-a").addEventListener("click", () => setWsTab(true));
  document.getElementById("wsm-print-btn").addEventListener("click", wsmPrint);
  // 正誤表の縦幅トグル（まとめて入力したいとき広げる）
  const wsmToggle = document.getElementById("wsm-table-toggle");
  if (wsmToggle) wsmToggle.addEventListener("click", () => {
    const t = document.getElementById("wsm-table");
    const expanded = t.classList.toggle("expanded");
    const chev = wsmToggle.querySelector(".wsm-table-chev");
    if (chev) chev.textContent = expanded ? "△ 閉じる" : "▽ 広げる";
  });
}

// ==============================
// 授業の確認問題 X/Y/Z方式（問題/解答タブ + 正誤表 + 印刷）
// （理科v2のデイリーサポート方式を移植。マスク検出を使わず、問題/解答ページ画像＋
//   大問/小問構造だけで成立。正誤は子が自己採点で ○/✕ 登録）
// ==============================
let wsmShowingAnswer = false;
let pendingXyz = {};       // {subId: "correct"|"wrong"} 仮選択
let xyzIdleTimer = null;
let wsmFilter = "all";     // all | below50 | below67 | below99 | unanswered
let wsmFilteredIds = null; // Set of target 小問id（all のとき null）

const WS_MODE_LABELS = {
  all: "全問", below50: "正答率50%以下", below67: "正答率67%以下",
  below99: "正答率99%以下", unanswered: "未回答",
};
const WS_MODE_BASE = {
  all: "全問を解く", below50: "正答率 50% 以下を解く", below67: "正答率 67% 以下を解く",
  below99: "正答率 99% 以下を解く", unanswered: "未回答問題を解く",
};

// 旧マスク方式の確認問題の正誤履歴を「消さずに退避」: 初回1度だけ tracking 全体をバックアップキーへ複製
function backupLegacyTrackingOnce() {
  if (!currentUser) return;
  const flag = `shakai-kakunin-legacy-backup-done-${currentUser}`;
  if (localStorage.getItem(flag) === "1") return;
  const src = localStorage.getItem(`shakai-tracking-v2-${currentUser}`);
  if (src) localStorage.setItem(`shakai-tracking-v2-legacy-backup-${currentUser}`, src);
  localStorage.setItem(flag, "1");
}

function getXyzTracking(unitId, subId) {
  const t = getTracking()[unitId] || {};
  return t[`xyz-${subId}`] || { attempts: 0, correct: 0 };
}

function recordXyzAnswer(unitId, subId, isCorrect) {
  const tracking = getTracking();
  if (!tracking[unitId]) tracking[unitId] = {};
  const key = `xyz-${subId}`;
  if (!tracking[unitId][key]) tracking[unitId][key] = { attempts: 0, correct: 0 };
  tracking[unitId][key].attempts++;
  if (isCorrect) tracking[unitId][key].correct++;
  setTracking(tracking);
  appendEvent({ unitId, key, date: new Date().toISOString(), correct: isCorrect ? 1 : 0 });
  flushSyncQueue();
}

// 各小問が指定モードの対象か
function xyzSubMatchesMode(subId, mode) {
  const t = getXyzTracking(currentUnit.id, subId);
  const pct = t.attempts ? Math.round(t.correct / t.attempts * 100) : null;
  if (mode === "unanswered") return t.attempts === 0;
  if (mode === "below50") return pct === null || pct <= 50;
  if (mode === "below67") return pct === null || pct <= 67;
  if (mode === "below99") return pct === null || pct <= 99;
  return true; // all
}

function computeWsFilterIds(mode) {
  if (mode === "all") return null;
  const ids = new Set();
  quizData.xyz.daimons.forEach(dm => dm.questions.forEach(q => {
    if (xyzSubMatchesMode(q.id, mode)) ids.add(q.id);
  }));
  return ids;
}

// 単元詳細の「授業の確認問題」カード（xyzデータがある単元用）
function buildXyzCard() {
  const xyz = quizData.xyz;
  let good = 0, total = 0;
  xyz.daimons.forEach(dm => dm.questions.forEach(q => {
    total++;
    const t = getXyzTracking(currentUnit.id, q.id);
    if (t.attempts > 0 && t.correct / t.attempts >= 0.67) good++;
  }));
  const progress = total > 0 ? Math.round(good / total * 100) : 0;
  const card = document.createElement("div");
  card.className = "section-card";
  card.innerHTML = `
    <div class="section-card-icon">✏️</div>
    <div class="section-card-body">
      <div class="section-card-title">${xyz.label || "授業の確認問題"}</div>
      <div class="section-card-meta">問題${xyz.questionPages.length}ページ ・ 全${total}問</div>
      <div class="section-card-progress">
        <div class="section-card-progress-fill" style="width: ${progress}%;"></div>
      </div>
    </div>
    <div class="section-card-stats">
      <div class="section-card-stats-main">${good}/${total}</div>
      <div class="section-card-stats-sub">67%↑ 達成 (${progress}%)</div>
    </div>`;
  card.addEventListener("click", openWsMode);
  return card;
}

function wsTitle() {
  return (quizData && quizData.xyz && quizData.xyz.label) || "授業の確認問題";
}

// ----- モード選択画面 -----
function openWsMode() {
  commitXyz();
  renderWsMode();
  showScreen("screen-wsmode");
}

function renderWsMode() {
  const xyz = quizData.xyz;
  document.getElementById("wsmode-title").textContent = `${currentUnit.id} ${wsTitle()}`;
  const counts = { all: 0, below50: 0, below67: 0, below99: 0, unanswered: 0 };
  xyz.daimons.forEach(dm => dm.questions.forEach(q => {
    for (const m of Object.keys(counts)) if (xyzSubMatchesMode(q.id, m)) counts[m]++;
  }));
  for (const mode of Object.keys(WS_MODE_BASE)) {
    const btn = document.querySelector(`[data-ws-mode="${mode}"]`);
    const pbtn = document.querySelector(`[data-ws-print="${mode}"]`);
    if (btn) { btn.textContent = `${WS_MODE_BASE[mode]} (${counts[mode]}問)`; btn.disabled = counts[mode] === 0; }
    if (pbtn) pbtn.disabled = counts[mode] === 0;
  }
}

// ----- 問題画面（タブ + 正誤表 + ページ）-----
function startWsMode(mode) {
  wsmFilter = mode;
  wsmFilteredIds = computeWsFilterIds(mode);
  wsmShowingAnswer = false;
  pendingXyz = {};
  document.getElementById("wsmondai-title").textContent = `${currentUnit.id} ${wsTitle()}`;
  renderXyzTable();
  renderWsPages();
  updateWsTabUI();
  showScreen("screen-wsmondai");
  document.getElementById("wsm-pages").scrollTop = 0;
}

function renderXyzTable() {
  const xyz = quizData.xyz;
  const el = document.getElementById("wsm-table");
  if (!xyz) { el.innerHTML = ""; return; }
  const prevScroll = el.scrollTop;
  const renderChip = (q, groupLabel) => {
    const t = getXyzTracking(currentUnit.id, q.id);
    const pend = pendingXyz[q.id];
    let tint = "";
    if (t.attempts > 0) {
      const acc = t.correct / t.attempts;
      tint = acc >= 0.999 ? "sub-perfect" : acc >= 0.5 ? "sub-mid" : "sub-low";
    }
    const dim = wsmFilteredIds && !wsmFilteredIds.has(q.id) ? "ws-dim" : "";
    const idEsc = q.id.replace(/'/g, "\\'");
    const cnt = t.attempts > 0 ? `${t.correct}/${t.attempts}` : "";
    // group ラベルは行頭に1つだけ出すので、チップは小問内のサブ部分のみ表示
    const sub = (groupLabel && q.label.startsWith(groupLabel)) ? q.label.slice(groupLabel.length) : q.label;
    const labelHtml = sub ? `<span class="wsm-sub-label">${sub}</span>` : "";
    return `<span class="wsm-sub ${tint} ${dim}" data-qid="${q.id}">
      ${labelHtml}
      <button class="wsm-qc-btn ok ${pend === "correct" ? "selected" : ""}" onclick="markXyz('${idEsc}', true)">○</button>
      <button class="wsm-qc-btn ng ${pend === "wrong" ? "selected" : ""}" onclick="markXyz('${idEsc}', false)">✕</button>
      <span class="wsm-sub-count">${cnt}</span>
    </span>`;
  };
  el.innerHTML = xyz.daimons.map(dm => {
    // 小問(group)ごとに行を分ける（連続する同groupをまとめ、各小問の集合を独立行に）
    const groups = [];
    dm.questions.forEach(q => {
      const g = q.group != null ? q.group : "";
      const last = groups[groups.length - 1];
      if (last && last.g === g) last.items.push(q);
      else groups.push({ g, items: [q] });
    });
    const rowsHtml = groups.map(gr => {
      const chips = gr.items.map(q => renderChip(q, gr.g)).join("");
      const prefix = gr.g ? `<span class="wsm-group-label">${gr.g}</span>` : "";
      return `<div class="wsm-sub-row">${prefix}${chips}</div>`;
    }).join("");
    return `<div class="wsm-daimon">
      <div class="wsm-daimon-head">${dm.id}</div>
      ${rowsHtml}
    </div>`;
  }).join("");
  el.scrollTop = prevScroll;
}

function markXyz(subId, isCorrect) {
  pendingXyz[subId] = isCorrect ? "correct" : "wrong";
  renderXyzTable();
  resetXyzIdle();
}

function resetXyzIdle() {
  if (xyzIdleTimer) clearTimeout(xyzIdleTimer);
  if (Object.keys(pendingXyz).length > 0) xyzIdleTimer = setTimeout(commitXyz, IDLE_TIMEOUT);
}

function commitXyz() {
  if (xyzIdleTimer) { clearTimeout(xyzIdleTimer); xyzIdleTimer = null; }
  const ids = Object.keys(pendingXyz);
  if (ids.length === 0) return;
  for (const id of ids) {
    recordXyzAnswer(currentUnit.id, id, pendingXyz[id] === "correct");
    delete pendingXyz[id];
  }
  const scr = document.getElementById("screen-wsmondai");
  if (scr && scr.classList.contains("active")) renderXyzTable();
}

function renderWsPages() {
  const xyz = quizData.xyz;
  const base = unitImagesBase();
  const el = document.getElementById("wsm-pages-inner");
  const q = xyz.questionPages.map((p, i) =>
    `<div class="wsm-page" data-pt="q" data-idx="${i}">
       <div class="wsm-page-label">問題 ${i + 1} / ${xyz.questionPages.length}</div>
       <div class="wsm-target-banner" style="display:none"></div>
       <img src="${base}${p}" loading="lazy" alt="問題${i + 1}">
     </div>`).join("");
  const a = xyz.answerPages.map((p, i) =>
    `<div class="wsm-page" data-pt="a" style="display:none">
       <div class="wsm-page-label">解答 ${i + 1} / ${xyz.answerPages.length}</div>
       <img src="${base}${p}" loading="lazy" alt="解答${i + 1}"></div>`).join("");
  el.innerHTML = q + a;
  applyWsTabVisibility();
  updateWsTargetBanners();
}

function wsTargetTextForPage(idx, idsSet) {
  if (!idsSet) return "";
  const parts = [];
  quizData.xyz.daimons.forEach(dm => {
    if (dm.qpage !== idx) return;
    const subs = dm.questions.filter(q => idsSet.has(q.id));
    if (!subs.length) return;
    parts.push(`${dm.id}-${subs.map(q => q.label).join(",")}`);
  });
  return parts.length ? "対象 " + parts.join("　/　") : "";
}

function updateWsTargetBanners() {
  document.querySelectorAll('#wsm-pages .wsm-page[data-pt="q"]').forEach(pageEl => {
    const idx = parseInt(pageEl.dataset.idx);
    const banner = pageEl.querySelector(".wsm-target-banner");
    if (!banner) return;
    const txt = wsTargetTextForPage(idx, wsmFilteredIds);
    if (txt) { banner.textContent = txt; banner.style.display = ""; }
    else { banner.style.display = "none"; banner.textContent = ""; }
  });
}

function applyWsTabVisibility() {
  document.querySelectorAll('#wsm-pages .wsm-page[data-pt="q"]').forEach(e => e.style.display = wsmShowingAnswer ? "none" : "");
  document.querySelectorAll('#wsm-pages .wsm-page[data-pt="a"]').forEach(e => e.style.display = wsmShowingAnswer ? "" : "none");
}

function updateWsTabUI() {
  document.getElementById("wsm-tab-q").classList.toggle("active", !wsmShowingAnswer);
  document.getElementById("wsm-tab-a").classList.toggle("active", wsmShowingAnswer);
}

function setWsTab(showAnswer) {
  if (wsmShowingAnswer === showAnswer) return;
  wsmShowingAnswer = showAnswer;
  applyWsTabVisibility();
  updateWsTabUI();
  document.getElementById("wsm-pages").scrollTop = 0;
}

// 対象問題テキストを赤文字でページ上部に焼き込む（印刷用）。必ず1行（収まらなければ縮小）。
function drawWsTargetText(ctx, text, W, H) {
  if (!text) return;
  let fontSize = Math.round(W * 0.012);
  const minFont = Math.round(W * 0.007);
  const maxTextW = W * 0.94;
  ctx.font = `bold ${fontSize}px sans-serif`;
  while (ctx.measureText(text).width > maxTextW && fontSize > minFont) {
    fontSize -= 2;
    ctx.font = `bold ${fontSize}px sans-serif`;
  }
  const padding = fontSize * 0.45;
  const boxH = fontSize * 1.25 + padding * 2;
  const boxW = Math.min(W * 0.96, ctx.measureText(text).width + padding * 2);
  const x = W * 0.02, y = H * 0.006;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 2;
  ctx.strokeRect(x, y, boxW, boxH);
  ctx.fillStyle = "#ff3b30"; ctx.textBaseline = "top";
  ctx.fillText(text, x + padding, y + padding);
}

// モード別に問題ページを印刷（対象小問を赤文字で焼き込む）
async function printWsMode(mode) {
  commitXyz();
  const xyz = quizData.xyz;
  if (!xyz) return;
  const ids = computeWsFilterIds(mode);
  const base = unitImagesBase();
  const dataURLs = [];
  for (let i = 0; i < xyz.questionPages.length; i++) {
    let img;
    try { img = await loadImage(base + xyz.questionPages[i]); } catch (e) { continue; }
    const cc = document.createElement("canvas");
    cc.width = img.width; cc.height = img.height;
    const ctx = cc.getContext("2d");
    ctx.drawImage(img, 0, 0);
    if (ids) drawWsTargetText(ctx, wsTargetTextForPage(i, ids), cc.width, cc.height);
    dataURLs.push(cc.toDataURL("image/jpeg", 0.92));
  }
  if (dataURLs.length === 0) { alert("画像の読み込みに失敗しました"); return; }
  _openPrintOverlay(`${currentUnit.id} ${wsTitle()}（${WS_MODE_LABELS[mode]}）`, dataURLs);
}

// 問題画面ヘッダーの印刷: 表示中タブを印刷（問題タブは現フィルタの赤文字付き）
async function wsmPrint() {
  commitXyz();
  const xyz = quizData.xyz;
  if (!xyz) return;
  if (!wsmShowingAnswer) { return printWsMode(wsmFilter || "all"); }
  const base = unitImagesBase();
  const dataURLs = [];
  for (const p of xyz.answerPages) {
    let img;
    try { img = await loadImage(base + p); } catch (e) { continue; }
    const cc = document.createElement("canvas");
    cc.width = img.width; cc.height = img.height;
    cc.getContext("2d").drawImage(img, 0, 0);
    dataURLs.push(cc.toDataURL("image/jpeg", 0.92));
  }
  if (dataURLs.length === 0) { alert("画像の読み込みに失敗しました"); return; }
  _openPrintOverlay(`${currentUnit.id} ${wsTitle()}（解答）`, dataURLs);
}

// ==============================
// 起動
// ==============================
function init() {
  setupEventListeners();
  const savedUser = localStorage.getItem('study-user') || sessionStorage.getItem("shakai-current-user-v2");
  if (savedUser === 'さと' || savedUser === 'ぱぱ') selectUser(savedUser);
}

init();

// ==============================
// Pinch-zoom for canvas-wrapper / reading-wrapper
// ==============================
function attachPinchZoom(wrapperId, contentSelector) {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  let scale = 1, minScale = 1, maxScale = 4;
  let startDist = 0, startScale = 1;
  let isPinching = false;
  let baseWidth = 0;
  let panStartX = 0, panStartY = 0;
  let panScrollL = 0, panScrollT = 0;
  let isPanning = false;

  function getContent() {
    return wrapper.querySelector(contentSelector);
  }

  function getBaseWidth() {
    const cvs = getContent();
    if (!cvs) return 0;
    if (scale === 1) baseWidth = cvs.getBoundingClientRect().width;
    return baseWidth;
  }

  function applyZoom(midXClient, midYClient) {
    const cvs = getContent();
    if (!cvs) return;
    const bw = getBaseWidth() || wrapper.clientWidth;
    const newW = bw * scale;
    const prevScrollLeft = wrapper.scrollLeft;
    const prevScrollTop = wrapper.scrollTop;
    const wRect = wrapper.getBoundingClientRect();
    const canvasX = prevScrollLeft + midXClient - wRect.left;
    const canvasY = prevScrollTop + midYClient - wRect.top;
    const ratioX = canvasX / (cvs.offsetWidth || 1);
    const ratioY = canvasY / (cvs.offsetHeight || 1);
    cvs.style.width = newW + 'px';
    cvs.style.maxWidth = 'none';
    cvs.style.maxHeight = 'none';
    cvs.style.height = 'auto';
    const newCanvasX = ratioX * cvs.offsetWidth;
    const newCanvasY = ratioY * cvs.offsetHeight;
    wrapper.scrollLeft = newCanvasX - (midXClient - wRect.left);
    wrapper.scrollTop = newCanvasY - (midYClient - wRect.top);
  }

  function resetZoom() {
    const cvs = getContent();
    if (!cvs) return;
    scale = 1;
    const wW = wrapper.clientWidth - 8;
    const wH = wrapper.clientHeight - 8;
    const cW = cvs.naturalWidth || cvs.width || 1;
    const cH = cvs.naturalHeight || cvs.height || 1;
    const fitScale = Math.min(wW / cW, wH / cH);
    const fitW = Math.floor(cW * fitScale);
    cvs.style.width = fitW + 'px';
    cvs.style.maxWidth = 'none';
    cvs.style.maxHeight = 'none';
    cvs.style.height = 'auto';
    baseWidth = fitW;
  }

  function getDist(t1, t2) {
    const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  wrapper.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      isPinching = true; isPanning = false;
      startDist = getDist(e.touches[0], e.touches[1]);
      startScale = scale;
      if (scale === 1) getBaseWidth();
    } else if (e.touches.length === 1) {
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panScrollL = wrapper.scrollLeft;
      panScrollT = wrapper.scrollTop;
    }
  }, { passive: true });

  wrapper.addEventListener('touchmove', e => {
    if (isPinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = getDist(e.touches[0], e.touches[1]);
      scale = Math.min(maxScale, Math.max(minScale, startScale * (dist / startDist)));
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      applyZoom(midX, midY);
    } else if (isPanning && e.touches.length === 1) {
      e.preventDefault();
      const dx = panStartX - e.touches[0].clientX;
      const dy = panStartY - e.touches[0].clientY;
      wrapper.scrollLeft = panScrollL + dx;
      wrapper.scrollTop = panScrollT + dy;
    }
  }, { passive: false });

  wrapper.addEventListener('touchend', e => {
    if (isPinching && e.touches.length < 2) {
      isPinching = false;
      if (scale <= 1.05) resetZoom();
    }
    if (e.touches.length === 0) isPanning = false;
  }, { passive: true });

  let lastTap = 0;
  wrapper.addEventListener('touchend', e => {
    if (e.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTap < 300 && scale > 1) {
      resetZoom();
      wrapper.scrollTop = 0;
    }
    lastTap = now;
  }, { passive: true });

  // ページ切替・画像変更時にリセット
  const cvs = getContent();
  if (cvs) {
    const observer = new MutationObserver(() => { if (scale > 1) resetZoom(); });
    observer.observe(cvs, { attributes: true, attributeFilter: ['width', 'height', 'src'] });
  }
}

attachPinchZoom('canvas-wrapper', '#quiz-canvas');
attachPinchZoom('reading-wrapper', '#reading-image');
attachPinchZoom('explain-viewport', '#explain-img');
attachPinchZoom('wsm-pages', '#wsm-pages-inner');
