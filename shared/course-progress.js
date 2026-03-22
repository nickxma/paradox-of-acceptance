/**
 * course-progress.js
 * localStorage-based progress tracking for The Honest Meditator course.
 *
 * Session pages: injects "Mark as complete" button after article.
 * Landing page: injects progress bar, session list, updates hero CTA, adds reset link.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'poa_course_progress';
  var TOTAL = 6;
  var SESSIONS = [
    { n: 1, title: 'What You Were Actually Promised',     href: '/courses/the-honest-meditator/session-1/' },
    { n: 2, title: 'The Acceptance Paradox',              href: '/courses/the-honest-meditator/session-2/' },
    { n: 3, title: 'Dosage \u2014 When Is Enough Enough?', href: '/courses/the-honest-meditator/session-3/' },
    { n: 4, title: 'The Signal You Are About to Dissolve', href: '/courses/the-honest-meditator/session-4/' },
    { n: 5, title: 'Later-Stage Failure Modes',           href: '/courses/the-honest-meditator/session-5/' },
    { n: 6, title: 'Practicing Honestly',                 href: '/courses/the-honest-meditator/session-6/' }
  ];

  // ── Storage helpers ──────────────────────────────────────────────────────────

  function getCompleted() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function markComplete(n) {
    var arr = getCompleted();
    if (arr.indexOf(n) === -1) {
      arr.push(n);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    }
  }

  function resetProgress() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ── Route detection ───────────────────────────────────────────────────────────

  var path = window.location.pathname;
  var sessionMatch = path.match(/\/session-(\d+)\//);

  if (sessionMatch) {
    domReady(function () { initSessionPage(parseInt(sessionMatch[1], 10)); });
  } else if (/\/the-honest-meditator\/?$/.test(path)) {
    domReady(initLandingPage);
  }

  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // ── Session page ─────────────────────────────────────────────────────────────

  function initSessionPage(n) {
    var footer = document.querySelector('footer');
    if (!footer) return;

    var wrap = document.createElement('div');
    wrap.id = 'session-complete-wrap';
    wrap.style.cssText =
      'border-top:1px solid #e2ddd6;padding-top:36px;margin-top:48px;text-align:center;padding-bottom:8px;';

    renderCompleteBlock(wrap, n);

    footer.parentNode.insertBefore(wrap, footer);
  }

  function renderCompleteBlock(wrap, n) {
    var completed = getCompleted();
    var isComplete = completed.indexOf(n) !== -1;

    wrap.innerHTML = '';

    if (isComplete) {
      var doneP = document.createElement('p');
      doneP.style.cssText =
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'font-size:14px;color:#7d8c6e;letter-spacing:0.02em;margin-bottom:0;';
      doneP.textContent = '\u2713\u00a0 Session ' + n + ' complete';
      wrap.appendChild(doneP);

      if (n < TOTAL) {
        var nextS = SESSIONS[n]; // SESSIONS is 0-indexed; index n = session n+1
        var nextP = document.createElement('p');
        nextP.style.cssText =
          'margin-top:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
          'font-size:14px;margin-bottom:0;';
        var nextA = document.createElement('a');
        nextA.href = nextS.href;
        nextA.textContent = 'Continue to Session ' + (n + 1) + ' \u2192';
        nextA.style.cssText = 'color:#7d8c6e;text-decoration:none;';
        nextA.addEventListener('mouseenter', function () { nextA.style.textDecoration = 'underline'; });
        nextA.addEventListener('mouseleave', function () { nextA.style.textDecoration = 'none'; });
        nextP.appendChild(nextA);
        wrap.appendChild(nextP);
      }
    } else {
      var btn = document.createElement('button');
      btn.textContent = 'Mark as complete';
      btn.style.cssText =
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'font-size:14px;font-weight:600;letter-spacing:0.02em;' +
        'padding:12px 28px;background:#7d8c6e;color:#fff;' +
        'border:none;border-radius:4px;cursor:pointer;transition:background 0.18s ease;';
      btn.addEventListener('mouseenter', function () { btn.style.background = '#5a6b4e'; });
      btn.addEventListener('mouseleave', function () { btn.style.background = '#7d8c6e'; });
      btn.addEventListener('click', function () {
        markComplete(n);
        renderCompleteBlock(wrap, n);
      });
      wrap.appendChild(btn);
    }
  }

  // ── Landing page ─────────────────────────────────────────────────────────────

  function initLandingPage() {
    var completed = getCompleted();

    insertSessionList(completed);
    insertProgressBar(completed);
    updateHeroCTA(completed);
    insertResetLink(completed);
  }

  function insertProgressBar(completed) {
    if (completed.length === 0) return;

    var header = document.querySelector('header');
    if (!header) return;

    var pct = Math.round((completed.length / TOTAL) * 100);
    var bar = document.createElement('div');
    bar.id = 'poa-progress-bar';
    bar.style.cssText = 'margin-bottom:36px;';
    bar.innerHTML =
      '<p style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;' +
      'font-size:13px;color:#555;margin-bottom:8px;letter-spacing:0.01em;">' +
      completed.length + ' of ' + TOTAL + ' sessions complete' +
      '</p>' +
      '<div style="height:6px;background:#e2ddd6;border-radius:3px;overflow:hidden;">' +
      '<div style="height:100%;width:' + pct + '%;background:#7d8c6e;border-radius:3px;"></div>' +
      '</div>';

    header.parentNode.insertBefore(bar, header.nextSibling);
  }

  function insertSessionList(completed) {
    var ctaWrap = document.querySelector('.cta-wrap');
    if (!ctaWrap) return;

    // Find next uncompleted session number
    var nextNum = null;
    for (var i = 0; i < TOTAL; i++) {
      if (completed.indexOf(SESSIONS[i].n) === -1) {
        nextNum = SESSIONS[i].n;
        break;
      }
    }

    var section = document.createElement('section');
    section.id = 'poa-sessions-section';
    section.style.cssText = 'margin-bottom:36px;';

    var heading = document.createElement('h2');
    heading.textContent = 'Sessions';
    section.appendChild(heading);

    var ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;padding:0;margin:0;';

    SESSIONS.forEach(function (s) {
      var isDone = completed.indexOf(s.n) !== -1;
      var isCurrent = s.n === nextNum;

      var li = document.createElement('li');
      li.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;' +
        'padding:13px 0;border-bottom:1px solid #e2ddd6;gap:16px;';

      // Left: session indicator + title
      var left = document.createElement('span');
      left.style.cssText =
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'font-size:15px;color:#2c2c2c;display:flex;align-items:baseline;gap:10px;';

      var badge = document.createElement('span');
      badge.style.cssText =
        'font-size:11px;font-weight:600;letter-spacing:0.1em;color:#7d8c6e;' +
        'min-width:22px;flex-shrink:0;';
      badge.textContent = isDone ? '\u2713' : String(s.n);

      var titleA = document.createElement('a');
      titleA.href = s.href;
      titleA.textContent = s.title;
      titleA.style.cssText = 'color:inherit;text-decoration:none;';
      titleA.addEventListener('mouseenter', function () { titleA.style.textDecoration = 'underline'; });
      titleA.addEventListener('mouseleave', function () { titleA.style.textDecoration = 'none'; });

      left.appendChild(badge);
      left.appendChild(titleA);

      // Right: CTA
      var right = document.createElement('span');
      right.style.cssText =
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'font-size:13px;white-space:nowrap;flex-shrink:0;';

      if (isDone) {
        right.style.color = '#7d8c6e';
        right.textContent = 'Complete';
      } else if (isCurrent) {
        var contA = document.createElement('a');
        contA.href = s.href;
        contA.textContent = '\u2192 Continue';
        contA.style.cssText = 'color:#7d8c6e;text-decoration:none;font-weight:600;';
        contA.addEventListener('mouseenter', function () { contA.style.textDecoration = 'underline'; });
        contA.addEventListener('mouseleave', function () { contA.style.textDecoration = 'none'; });
        right.appendChild(contA);
      } else {
        var startA = document.createElement('a');
        startA.href = s.href;
        startA.textContent = 'Start';
        startA.style.cssText = 'color:#7d8c6e;text-decoration:none;';
        startA.addEventListener('mouseenter', function () { startA.style.textDecoration = 'underline'; });
        startA.addEventListener('mouseleave', function () { startA.style.textDecoration = 'none'; });
        right.appendChild(startA);
      }

      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });

    section.appendChild(ul);
    ctaWrap.parentNode.insertBefore(section, ctaWrap);
  }

  function updateHeroCTA(completed) {
    if (completed.length === 0) return;

    var ctaBtn = document.querySelector('.cta-btn');
    if (!ctaBtn) return;

    // Find first uncompleted session
    var nextS = null;
    for (var i = 0; i < TOTAL; i++) {
      if (completed.indexOf(SESSIONS[i].n) === -1) {
        nextS = SESSIONS[i];
        break;
      }
    }

    if (nextS) {
      ctaBtn.textContent = 'Continue where you left off \u2192 Session ' + nextS.n;
      ctaBtn.href = nextS.href;
    } else {
      ctaBtn.textContent = 'All sessions complete \u2014 Review from the start';
      ctaBtn.href = SESSIONS[0].href;
    }
  }

  function insertResetLink(completed) {
    if (completed.length === 0) return;

    var footer = document.querySelector('footer');
    if (!footer) return;

    var resetP = document.createElement('p');
    resetP.style.cssText =
      'margin-top:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:12px;';

    var resetA = document.createElement('a');
    resetA.href = '#';
    resetA.textContent = 'Reset progress';
    resetA.style.cssText = 'color:#888;text-decoration:none;';
    resetA.addEventListener('mouseenter', function () { resetA.style.textDecoration = 'underline'; });
    resetA.addEventListener('mouseleave', function () { resetA.style.textDecoration = 'none'; });
    resetA.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.confirm('Reset all course progress? This cannot be undone.')) {
        resetProgress();
        window.location.reload();
      }
    });

    resetP.appendChild(resetA);
    footer.appendChild(resetP);
  }
})();
