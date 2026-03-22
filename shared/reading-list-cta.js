/**
 * reading-list-cta.js
 *
 * On every mindfulness essay page:
 *   1. Fetches /api/reading-lists and checks if this essay appears in any list.
 *   2. If it does, injects a "Part of {list name} — continue reading" card at the
 *      bottom of the article (before the subscribe modal / scripts).
 *   3. When the essay-reading-tracker fires a completion (80% scroll), marks
 *      this essay as completed in the list's localStorage progress record.
 *
 * Usage: include at the bottom of any mindfulness essay page.
 * No configuration needed — slug and list membership are derived automatically.
 */
(function () {
  'use strict';

  var API_BASE = 'https://paradoxofacceptance.xyz';
  var LIST_PAGE = '/reading-lists/list/';
  var LISTS_PAGE = '/reading-lists/';

  // ─── Derive essay slug from URL ────────────────────────────────────────────

  var path = window.location.pathname;
  var slugMatch = path.match(/\/mindfulness-essays\/([^/]+)\//);
  if (!slugMatch) return;
  var essaySlug = slugMatch[1];

  // ─── Progress helpers ──────────────────────────────────────────────────────

  function getCompleted(listSlug) {
    try {
      var data = JSON.parse(localStorage.getItem('poa_list_' + listSlug) || 'null');
      return (data && Array.isArray(data.completedSlugs)) ? data.completedSlugs : [];
    } catch (e) { return []; }
  }

  function markComplete(listSlug, slug) {
    var completed = getCompleted(listSlug);
    if (completed.indexOf(slug) === -1) {
      completed.push(slug);
      try {
        localStorage.setItem('poa_list_' + listSlug, JSON.stringify({ completedSlugs: completed }));
      } catch (e) {}
    }
  }

  // ─── Completion tracking ───────────────────────────────────────────────────
  // Hook into the 80% scroll threshold (same as plausible EssayRead event)
  // to mark this essay complete in any lists it belongs to.

  var markedLists = [];
  var scrollListenerAdded = false;

  function markAllListsComplete() {
    markedLists.forEach(function (listSlug) {
      markComplete(listSlug, essaySlug);
    });
    // Dispatch event so an open reading list page can update its UI
    try {
      window.dispatchEvent(new CustomEvent('poa:essayRead', { detail: { slug: essaySlug } }));
      if (window.opener) {
        window.opener.dispatchEvent(new CustomEvent('poa:essayRead', { detail: { slug: essaySlug } }));
      }
    } catch (e) {}
  }

  function addScrollCompletion() {
    if (scrollListenerAdded) return;
    scrollListenerAdded = true;
    var fired = false;
    window.addEventListener('scroll', function () {
      if (fired) return;
      var total = document.body.scrollHeight - window.innerHeight;
      if (total > 0 && window.scrollY / total >= 0.8) {
        fired = true;
        markAllListsComplete();
      }
    }, { passive: true });
  }

  // ─── Inject CTA card ───────────────────────────────────────────────────────

  function injectCTA(matchingLists) {
    if (matchingLists.length === 0) return;

    // Mark these lists so scroll completion tracks them
    matchingLists.forEach(function (l) { markedLists.push(l.slug); });
    addScrollCompletion();

    // Build the CTA block
    var primary = matchingLists[0];
    var completed = getCompleted(primary.slug);
    var total = primary.item_count;
    var pct = total > 0 ? Math.min(Math.round(completed.length / total * 100), 100) : 0;

    // Find the next essay in this list that hasn't been completed
    var nextEssay = null;
    if (primary.essays) {
      for (var i = 0; i < primary.essays.length; i++) {
        var e = primary.essays[i];
        if (e.slug !== essaySlug && completed.indexOf(e.slug) === -1) {
          nextEssay = e;
          break;
        }
      }
    }

    var ctaHtml =
      '<div id="poa-reading-list-cta" style="' +
        'margin: 48px 0 32px;' +
        'padding: 24px 28px;' +
        'border: 1px solid #e2ddd6;' +
        'border-radius: 8px;' +
        'background: #faf8f4;' +
        'font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Helvetica, Arial, sans-serif;' +
      '">' +
        '<div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#a4b594;margin-bottom:10px;">Part of a reading list</div>' +
        '<a href="' + LIST_PAGE + '?slug=' + encodeURIComponent(primary.slug) + '" style="' +
          'display:block;font-family:Georgia,\'Times New Roman\',serif;font-size:20px;color:#2c2c2c;' +
          'margin-bottom:6px;line-height:1.3;text-decoration:none;' +
        '">' + esc(primary.title) + '</a>' +
        (primary.description ? '<div style="font-size:13px;color:#888;line-height:1.6;margin-bottom:14px;">' + esc(primary.description) + '</div>' : '') +

        // Progress bar
        (total > 1 ? (
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
            '<div style="flex:1;max-width:200px;height:3px;background:#e2ddd6;border-radius:2px;overflow:hidden;">' +
              '<div style="height:100%;background:#7d8c6e;border-radius:2px;width:' + pct + '%;transition:width 0.3s;"></div>' +
            '</div>' +
            '<span style="font-size:12px;color:#aaa;">' +
              (pct === 0 ? 'Not started' : pct === 100 ? 'Complete' : pct + '% read') +
            '</span>' +
          '</div>'
        ) : '') +

        // Next essay or back link
        '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">' +
          (nextEssay
            ? '<a href="' + esc(nextEssay.path) + '" style="' +
                'display:inline-flex;align-items:center;gap:6px;' +
                'font-size:13px;font-weight:500;color:#7d8c6e;text-decoration:none;' +
              '">Continue reading: ' + esc(nextEssay.title) + ' \u2192</a>'
            : '<a href="' + LIST_PAGE + '?slug=' + encodeURIComponent(primary.slug) + '" style="' +
                'display:inline-flex;align-items:center;gap:6px;' +
                'font-size:13px;font-weight:500;color:#7d8c6e;text-decoration:none;' +
              '">View the full list \u2192</a>') +
          '<a href="' + LISTS_PAGE + '" style="font-size:12px;color:#bbb;text-decoration:none;">All reading lists</a>' +
        '</div>' +
      '</div>';

    // Inject before the subscribe modal or before </body>
    var modal = document.getElementById('poa-subscribe-modal');
    if (modal) {
      modal.insertAdjacentHTML('beforebegin', ctaHtml);
    } else {
      document.body.insertAdjacentHTML('beforeend', ctaHtml);
    }
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Fetch and match ───────────────────────────────────────────────────────

  fetch(API_BASE + '/api/reading-lists')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.reading_lists) return;

      // Find lists that contain this essay — we need full detail for next-essay logic.
      // To avoid N+1, filter server-side lists that preview this essay or fetch detail only
      // for matching slugs found in preview_essays. Since preview_essays only has first-3,
      // we must check each list's full data. We do this lazily: fetch full detail only for
      // lists that *could* contain this essay (all of them, since preview is truncated).
      // In practice, there are very few lists so this is fine.

      var lists = data.reading_lists;
      if (lists.length === 0) return;

      // Fetch each list's full detail to see if this essay is in it
      Promise.all(lists.map(function (list) {
        return fetch(API_BASE + '/api/reading-lists/' + encodeURIComponent(list.slug))
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })).then(function (details) {
        var matching = [];
        details.forEach(function (detail) {
          if (!detail || !detail.reading_list) return;
          var rl = detail.reading_list;
          var inList = rl.essays.some(function (e) { return e.slug === essaySlug; });
          if (inList) matching.push(rl);
        });
        injectCTA(matching);
      });
    })
    .catch(function () {});

})();
