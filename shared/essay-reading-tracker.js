/**
 * essay-reading-tracker.js
 *
 * On every mindfulness essay page:
 *   1. Injects a fixed scroll-progress bar at the top of the viewport.
 *   2. Tracks 30 consecutive seconds of visible time on the page.
 *   3. After 30 s, silently POSTs to /api/essays/:slug/read-progress.
 *   4. Reads response for streak milestone and shows an in-app toast if
 *      the user has hit 7 or 30 days.
 *
 * Auth:
 *   - If Supabase is available and the user is logged in, sends Bearer JWT.
 *   - Otherwise uses a stable session_id from localStorage (anonymous tracking).
 *
 * Usage: include this script at the bottom of any essay page.
 * No configuration needed — slug is derived from window.location.pathname.
 */
(function () {
  'use strict';

  var API_BASE = 'https://paradoxofacceptance.xyz';
  var SUPABASE_URL = 'https://jyxwnfgcqgiqxjdlypvr.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5eHduZmdjcWdpcXhqZGx5cHZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODkxNTYsImV4cCI6MjA4ODg2NTE1Nn0.4NFTioFSjRZVRqOB9kXToi_UueNrvxBj-vy6uRtCtrE';
  var READ_THRESHOLD_MS = 30000; // 30 seconds
  var SESSION_KEY = 'poa_session_id';

  // ── Derive essay slug from URL ────────────────────────────────────────────

  var path = window.location.pathname;
  var slugMatch = path.match(/\/mindfulness-essays\/([^/]+)\//);
  if (!slugMatch) return; // not an essay page
  var essaySlug = slugMatch[1];

  // ── Scroll progress bar ───────────────────────────────────────────────────
  // Only inject if the page doesn't already have its own scroll progress bar.

  var progressBar = document.getElementById('progress-bar') || (function () {
    var el = document.createElement('div');
    el.id = 'poa-read-progress';
    el.style.cssText =
      'position:fixed;top:0;left:0;height:3px;width:0%;' +
      'background:#7d8c6e;z-index:9999;transition:width 0.1s linear;' +
      'pointer-events:none;';
    document.body.appendChild(el);
    return el;
  })();

  function updateScrollBar() {
    var total = document.documentElement.scrollHeight - window.innerHeight;
    if (total <= 0) return;
    var pct = Math.min(100, (window.scrollY / total) * 100);
    progressBar.style.width = pct + '%';
  }

  // Only hook scroll if we created our own bar (existing bar manages itself)
  if (progressBar.id === 'poa-read-progress') {
    window.addEventListener('scroll', updateScrollBar, { passive: true });
    window.addEventListener('resize', updateScrollBar, { passive: true });
    updateScrollBar();
  }

  // ── Session ID for anonymous tracking ────────────────────────────────────

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  // ── Supabase auth token (best-effort) ────────────────────────────────────

  function getSupabaseToken(cb) {
    try {
      if (typeof supabase === 'undefined') { cb(null); return; }
      var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      sb.auth.getSession().then(function (res) {
        var token = res && res.data && res.data.session && res.data.session.access_token;
        cb(token || null);
      }).catch(function () { cb(null); });
    } catch (e) {
      cb(null);
    }
  }

  // ── Toast notification ────────────────────────────────────────────────────

  function showMilestoneToast(days) {
    var toast = document.createElement('div');
    toast.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);' +
      'background:#2c2c2c;color:#faf8f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:14px;line-height:1.5;padding:14px 22px;border-radius:8px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.25);z-index:99999;' +
      'opacity:0;transition:opacity 0.3s ease,transform 0.3s ease;max-width:320px;text-align:center;';

    var emoji = days >= 30 ? '🌿' : '🔥';
    toast.innerHTML =
      '<strong>' + emoji + ' ' + days + '-day streak</strong><br>' +
      '<span style="color:#a4b594;">' +
      (days >= 30
        ? 'A month of daily reading. That\'s real practice.'
        : 'A week of daily reading. Keep going.') +
      '</span>';

    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
    });

    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(function () { toast.parentNode && toast.parentNode.removeChild(toast); }, 400);
    }, 5000);
  }

  // ── Report the read ───────────────────────────────────────────────────────

  var readFired = false;
  var startTime = null;
  var accumulatedMs = 0;
  var tickerId = null;

  function fireRead(durationSecs) {
    if (readFired) return;
    readFired = true;

    getSupabaseToken(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
      } else {
        headers['X-Session-Id'] = getSessionId();
      }

      fetch(API_BASE + '/api/essays/' + essaySlug + '/read-progress', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ read_duration_seconds: durationSecs }),
        keepalive: true,
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.streak && data.streak.milestone) {
            showMilestoneToast(data.streak.milestone);
          }
          // Also fire analytics event
          window.plausible && window.plausible('EssayRead', { props: { slug: essaySlug } });
        })
        .catch(function () {});
    });
  }

  // ── Visibility tracking (accumulate visible time) ─────────────────────────

  function tick() {
    if (startTime === null) return;
    accumulatedMs += Date.now() - startTime;
    startTime = Date.now();
    if (accumulatedMs >= READ_THRESHOLD_MS) {
      clearInterval(tickerId);
      fireRead(Math.round(accumulatedMs / 1000));
    }
  }

  function startTimer() {
    if (readFired) return;
    if (startTime !== null) return; // already running
    startTime = Date.now();
    tickerId = setInterval(tick, 1000);
  }

  function pauseTimer() {
    if (startTime !== null) {
      accumulatedMs += Date.now() - startTime;
      startTime = null;
    }
    clearInterval(tickerId);
    tickerId = null;
  }

  // Start/pause based on page visibility
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      pauseTimer();
    } else if (!readFired) {
      startTimer();
    }
  });

  // Start immediately if page is visible
  if (!document.hidden) startTimer();
})();
