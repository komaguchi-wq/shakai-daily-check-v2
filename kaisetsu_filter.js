// 解説（kaisetsu.html）の対象絞り込み — 全アプリ共通（原本: scripts/kaisetsu/js/kaisetsu_filter.js。各アプリ直下へコピーして使う）
// ★2026-09-20 ユーザー要望: 画面上部の問題選択（全ての問題／正答率50%未満／50%未満＆未解答／66%未満／未解答）を
//   選んだ状態で解説を印刷したら対象の小問だけを印刷する。ただし「全体像」「まとめ」「大問の見出し」は省かない。
//
// 使い方:
//   const qs = [{ id, dm, dmLabel, group, label }, ...]   // 正誤表の小問（id=○×キー・dm=大問id・label=小問ラベル）
//   KaisetsuFilter.filterHTML(html, qs, targetIdSet)  → { html, kept, total }   // 印刷用（対象外カードを除いた断片）
//   KaisetsuFilter.markCards(rootEl, qs, targetIdSet)  → { kept, total }        // 画面用（対象外カードを k-off で薄く）
//
// カードの見出し <span class="qid">確認4 (2)①②③</span> を「大問 + 残り」に分け、残りを小問ラベルと照合する。
//   ・大問: dm.id / dm.label（「（」より前）の最長一致。数字の続きは不一致（確認1 と 確認13）
//   ・残り: 「・」区切り（群の引き継ぎ: (2)A・B → (2)A,(2)B）／末尾の ①②③・abc の連続は1つずつ／①〜⑤・(1)〜(3) の範囲／(1)(2) の連結
//   ・照合: 一致／どちらかが前方一致（数字の続きは不可）／小問ラベル末尾一致（Ⅱ 問1 と 1問1）。群だけ（(2) など）は完全一致のみ
//   ・どの小問にも結びつかないカードは「判定不能」として残す（消しすぎより残しすぎを選ぶ）
(function (root) {
  'use strict';
  const DIGIT = /[0-9一二三四五六七八九十〇]/;   // 漢数字も「数字の続き」として扱う（問十 と 問十一）
  const CIRC = '①-⑳';            // ①〜⑳
  const ROMAN = 'Ⅰ-Ⅹⅰ-ⅹ'; // Ⅰ〜Ⅹ ⅰ〜ⅹ
  const ITEM_CLASS = `[A-Za-z${CIRC}${ROMAN}ぁ-ゖァ-ヶ]`; // 1文字の項目（英字・丸数字・ローマ数字・かな）
  const RE_ITEM_END = new RegExp(`^(.+?)(${ITEM_CLASS})$`);
  const RE_RUN_CIRC = new RegExp(`^(.*?)([${CIRC}${ROMAN}]{2,})$`);
  const RE_RUN_LATIN = /^(.*?)([A-Za-z]{2,})$/;
  const RE_RANGE_CIRC = new RegExp(`^(.*?)([${CIRC}])[〜~～]([${CIRC}])$`);
  const RE_RANGE_PAREN = /^(.*?)\((\d+)\)[〜~～]\((\d+)\)$/;
  const RE_PAREN_CHAIN = /^(\(\d+\)){2,}$/;

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, '')
      .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  }
  const isDigit = (c) => !!c && DIGIT.test(c);
  // 短い方が長い方の先頭にあるとき、数字が続いていないか（"(1)"→"(12)" や "問1"→"問12" は不一致）
  function boundaryOK(short, long) {
    const a = short[short.length - 1], b = long[short.length];
    if (!(isDigit(a) && isDigit(b))) return true;
    // 漢数字の直後に算用数字（大問「一」＋小問「1」＝「一 1」）は別の番号なので一致とみなす（kakomon で先行導入・2026-09-23 原本に統合）
    return /[0-9]/.test(a) !== /[0-9]/.test(b);
  }
  function groupOf(p) {
    // 群は「(2)」のような数字括弧だけ（「信濃川(千曲川)」のような地名の括弧は群にしない＝次の「・」項目に引き継がない）
    let m = /^(.*\([0-9０-９]+\))/.exec(p);
    if (m) return m[1];
    m = RE_ITEM_END.exec(p);
    return m ? m[1] : '';
  }
  // 見出しの「残り」を、対応しうる小問ラベルの候補（トークン）に広げる
  function expandRest(rest) {
    if (!rest) return [''];
    const parts = rest.split('・');
    for (let i = 1; i < parts.length; i++) {
      if (!groupOf(parts[i])) {
        const g = groupOf(parts[i - 1]);
        if (g) parts[i] = g + parts[i];
      }
    }
    const out = new Set();
    for (const p of parts) {
      out.add(p);
      let m;
      if ((m = RE_RANGE_CIRC.exec(p))) {
        const a = m[2].charCodeAt(0), b = m[3].charCodeAt(0);
        for (let c = Math.min(a, b); c <= Math.max(a, b); c++) out.add(m[1] + String.fromCharCode(c));
      } else if ((m = RE_RANGE_PAREN.exec(p))) {
        const a = +m[2], b = +m[3];
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(`${m[1]}(${n})`);
      } else if (RE_PAREN_CHAIN.test(p)) {
        (p.match(/\(\d+\)/g) || []).forEach((g) => out.add(g));
      } else if ((m = RE_RUN_CIRC.exec(p))) {
        for (const ch of m[2]) out.add(m[1] + ch);
      } else if ((m = RE_RUN_LATIN.exec(p))) {
        for (const ch of m[2]) out.add(m[1] + ch);
      }
    }
    return [...out];
  }
  // 小問の照合形: 群+ラベル／ラベル（前方・末尾一致あり）／群だけ（完全一致のみ＝「(1)」のカードは (1) の全項目を覆う）
  function formsOf(q) {
    const g = norm(q.group), l = norm(q.label);
    const fs = [];
    // ★2026-09-23: 群が範囲（「1〜8」など）のときは 群+ラベル（"1〜82"）を作らない（「B2 1」が 2〜8 まで前方一致で覆ってしまう）
    const gl = /[〜~～]/.test(g) ? '' : g + l;
    for (const f of [gl, l]) if (f && !fs.some((x) => x.f === f)) fs.push({ f, exact: false });
    if (g && !fs.some((x) => x.f === g)) fs.push({ f: g, exact: true });
    return fs.length ? fs : [{ f: '', exact: false }];
  }
  function rel(t, form) {
    const f = form.f;
    if (t === '' || f === '') return true;
    if (t === f) return true;
    if (form.exact) return false;
    if (f.startsWith(t) && boundaryOK(t, f)) return true;
    if (t.startsWith(f) && boundaryOK(f, t)) return true;
    if (t.length >= 2 && f.endsWith(t)) {
      const prev = f[f.length - t.length - 1];
      if (!(isDigit(t[0]) && isDigit(prev))) return true;
    }
    return false;
  }
  // 大問の索引: [{key, dm}] を key の長い順
  function dmIndex(questions) {
    const keys = new Map();
    for (const q of questions) {
      const dm = q.dm == null ? '' : String(q.dm);
      const add = (k) => { k = norm(k); if (k && !keys.has(k)) keys.set(k, dm); };
      add(dm);
      if (q.dmLabel) { add(q.dmLabel); add(String(q.dmLabel).split(/[（(]/)[0]); }
    }
    return [...keys.entries()].map(([key, dm]) => ({ key, dm })).sort((a, b) => b.key.length - a.key.length);
  }
  // 1カード（qid文字列）が覆う小問idの配列。判定不能（大問が見つからない／どの小問にも当たらない）なら null
  function coveredIds(qidText, questions, index) {
    const full = norm(qidText);
    if (!full) return null;
    // ★2026-09-23: 「B2 1」のように大問IDの直後に半角空白があれば区切りとみなす（数字の続きでも不一致にしない）
    const spaced = String(qidText == null ? '' : qidText).replace(/\s+/g, ' ').trim();
    const spacedN = norm(spaced.replace(/ /g, '\u0001')).replace(/\u0001/g, ' ');
    let hit = null;
    for (const e of index) {
      if (full.startsWith(e.key) && (boundaryOK(e.key, full) || spacedN.startsWith(e.key + ' '))) { hit = e; break; }
    }
    if (!hit) return null;
    const tokens = expandRest(full.slice(hit.key.length));
    const ids = [];
    for (const q of questions) {
      if (String(q.dm == null ? '' : q.dm) !== hit.dm) continue;
      const fs = formsOf(q);
      if (tokens.some((t) => fs.some((f) => rel(t, f)))) ids.push(q.id);
    }
    return ids.length ? ids : null;
  }
  function isQuestionCard(card) {
    return !(card.classList.contains('card-overview') || card.classList.contains('card-summary'));
  }
  // root 内の各カードに対象/対象外を付ける。target が null（全問）なら印は付けない
  function classify(rootEl, questions, targetIds) {
    const index = dmIndex(questions);
    const res = { kept: 0, total: 0, cards: [] };
    rootEl.querySelectorAll('.card').forEach((card) => {
      if (!isQuestionCard(card)) { res.cards.push({ card, keep: true, question: false }); return; }
      res.total++;
      const qid = card.querySelector('.qid');
      const ids = qid ? coveredIds(qid.textContent, questions, index) : null;
      const keep = !targetIds || !ids || ids.some((id) => targetIds.has(id));
      if (keep) res.kept++;
      res.cards.push({ card, keep, question: true, ids });
    });
    return res;
  }
  function markCards(rootEl, questions, targetIds) {
    const res = classify(rootEl, questions, targetIds);
    for (const c of res.cards) {
      c.card.classList.toggle('k-off', !!targetIds && c.question && !c.keep);
      c.card.classList.toggle('k-on', !!targetIds && c.question && c.keep);
    }
    rootEl.querySelectorAll('.daimon').forEach((d) => {
      const any = [...d.querySelectorAll('.card')].some((c) => isQuestionCard(c) && !c.classList.contains('k-off'));
      d.classList.toggle('k-empty', !!targetIds && !any);
    });
    return { kept: res.kept, total: res.total };
  }
  // 印刷用: 対象外の問題カードを除き、対象が1つも残らない大問（見出し・全体像・まとめ・目次行ごと）を外す
  function filterHTML(html, questions, targetIds) {
    const box = document.createElement('div');
    box.innerHTML = html;
    if (!targetIds) return { html, kept: box.querySelectorAll('.card').length, total: box.querySelectorAll('.card').length, filtered: false };
    const res = classify(box, questions, targetIds);
    for (const c of res.cards) if (!c.keep) c.card.remove();
    box.querySelectorAll('.daimon').forEach((d) => {
      if ([...d.querySelectorAll('.card')].some(isQuestionCard)) return;
      const id = d.getAttribute('id');
      if (id) box.querySelectorAll('.toc a[href^="#"]').forEach((a) => {
        if (a.getAttribute('href') !== '#' + id) return;
        const li = a.closest('li'); (li || a).remove();
      });
      d.remove();
    });
    return { html: box.innerHTML, kept: res.kept, total: res.total, filtered: true };
  }
  const api = { norm, expandRest, coveredIds, dmIndex, classify, markCards, filterHTML };
  root.KaisetsuFilter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
