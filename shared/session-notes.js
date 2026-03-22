/**
 * session-notes.js
 * Private per-user notes for course sessions.
 *
 * Session pages: injects collapsible notes panel below session content.
 * Landing page:  adds a pencil icon next to sessions that have notes.
 *
 * Storage strategy:
 *   - localStorage is always written (instant, offline-safe).
 *   - If the user has a Supabase auth session, notes are also synced to the API
 *     so they persist across devices. Server content takes precedence on load.
 *
 * Usage: include at end of <body> on session pages and the course landing page.
 * Depends on: Supabase JS SDK loaded as `supabase` global (optional — degrades
 *             gracefully to localStorage-only if not present).
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://jyxwnfgcqgiqxjdlypvr.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5eHduZmdjcWdpcXhqZGx5cHZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODkxNTYsImV4cCI6MjA4ODg2NTE1Nn0.4NFTioFSjRZVRqOB9kXToi_UueNrvxBj-vy6uRtCtrE';
  var MAX_CHARS = 2000;
  var NOTE_PREFIX = 'poa_note_';

  // ── Route detection ──────────────────────────────────────────────────────────

  var path = window.location.pathname;
  var sessionMatch = path.match(/\/courses\/([\w-]+)\/session-(\d+)\//);
  var isLandingPage = /\/courses\/([\w-]+)\/?$/.test(path) && !sessionMatch;

  function getSessionId() {
    if (!sessionMatch) return null;
    return sessionMatch[1] + '-' + sessionMatch[2]; // e.g., "the-honest-meditator-1"
  }

  // ── Supabase auth ────────────────────────────────────────────────────────────

  function getSupabaseSession(cb) {
    try {
      if (typeof supabase === 'undefined') { cb(null); return; }
      var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      sb.auth.getSession().then(function (res) {
        var session = res && res.data && res.data.session;
        cb(session || null);
      }).catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }

  // ── localStorage ─────────────────────────────────────────────────────────────

  function getLocalNote(sessionId) {
    try { return localStorage.getItem(NOTE_PREFIX + sessionId) || ''; } catch (e) { return ''; }
  }

  function setLocalNote(sessionId, content) {
    try {
      if (content) {
        localStorage.setItem(NOTE_PREFIX + sessionId, content);
      } else {
        localStorage.removeItem(NOTE_PREFIX + sessionId);
      }
    } catch (e) {}
  }

  function getLocalNoteSessions() {
    var sessions = new Set();
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(NOTE_PREFIX) === 0) {
          var id = key.slice(NOTE_PREFIX.length);
          if (localStorage.getItem(key)) sessions.add(id);
        }
      }
    } catch (e) {}
    return sessions;
  }

  // ── API helpers ──────────────────────────────────────────────────────────────

  function apiGetNote(sessionId, token, cb) {
    fetch('/api/sessions/' + sessionId + '/notes', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cb(d && d.content != null ? d.content : null); })
      .catch(function () { cb(null); });
  }

  function apiSaveNote(sessionId, content, token, cb) {
    fetch('/api/sessions/' + sessionId + '/notes', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ content: content })
    }).then(function (r) { cb(r.ok); })
      .catch(function () { cb(false); });
  }

  function apiGetBulkNotes(token, cb) {
    fetch('/api/sessions/notes', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cb(d && d.sessions ? d.sessions : null); })
      .catch(function () { cb(null); });
  }

  // ── Session page ─────────────────────────────────────────────────────────────

  function initSessionPage(sessionId) {
    var localContent = getLocalNote(sessionId);
    getSupabaseSession(function (session) {
      if (session) {
        apiGetNote(sessionId, session.access_token, function (serverContent) {
          // Server is source of truth for signed-in users
          var content = serverContent != null ? serverContent : localContent;
          if (serverContent != null) setLocalNote(sessionId, content);
          injectNotesPanel(sessionId, content, session);
        });
      } else {
        injectNotesPanel(sessionId, localContent, null);
      }
    });
  }

  function injectNotesPanel(sessionId, initialContent, session) {
    // Insert before the "Mark as complete" block, or before footer as fallback
    var target = document.getElementById('session-complete-wrap') || document.querySelector('footer');
    if (!target) return;

    var hasNote = initialContent && initialContent.length > 0;

    var panel = document.createElement('div');
    panel.id = 'poa-session-notes';
    panel.style.cssText = 'padding-bottom:8px;margin-bottom:0;';

    // Collapsible wrapper
    var details = document.createElement('details');
    details.style.cssText = 'border:1px solid #e2ddd6;border-radius:4px;overflow:hidden;';
    if (hasNote) details.setAttribute('open', '');

    // Summary / header
    var summary = document.createElement('summary');
    summary.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;cursor:pointer;' +
      'padding:16px 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:14px;font-weight:600;color:#2c2c2c;list-style:none;user-select:none;' +
      'background:#f0ede6;';
    summary.innerHTML = ''; // clear any browser-injected content

    var summaryLeft = document.createElement('span');
    summaryLeft.style.cssText = 'display:flex;align-items:center;gap:8px;';

    var pencilSpan = document.createElement('span');
    pencilSpan.setAttribute('aria-hidden', 'true');
    pencilSpan.textContent = '\u270f\ufe0e'; // ✏︎
    pencilSpan.style.cssText = 'font-size:13px;color:#7d8c6e;';

    var labelSpan = document.createElement('span');
    labelSpan.textContent = 'Session notes';

    summaryLeft.appendChild(pencilSpan);
    summaryLeft.appendChild(labelSpan);

    var toggleIcon = document.createElement('span');
    toggleIcon.setAttribute('aria-hidden', 'true');
    toggleIcon.textContent = '+';
    toggleIcon.style.cssText =
      'font-size:18px;color:#7d8c6e;transition:transform 0.2s ease;flex-shrink:0;';
    if (hasNote) toggleIcon.style.transform = 'rotate(45deg)';

    summary.appendChild(summaryLeft);
    summary.appendChild(toggleIcon);

    details.addEventListener('toggle', function () {
      toggleIcon.style.transform = details.open ? 'rotate(45deg)' : '';
    });

    // Body
    var body = document.createElement('div');
    body.style.cssText = 'padding:20px 20px 24px;';

    var textarea = document.createElement('textarea');
    textarea.value = initialContent || '';
    textarea.placeholder = 'Write your notes for this session\u2026';
    textarea.setAttribute('maxlength', String(MAX_CHARS));
    textarea.style.cssText =
      'width:100%;min-height:120px;resize:vertical;' +
      'font-family:Georgia,"Times New Roman",serif;font-size:16px;line-height:1.7;' +
      'color:#2c2c2c;background:#faf8f4;' +
      'border:1px solid #e2ddd6;border-radius:3px;padding:12px 14px;' +
      'outline:none;box-sizing:border-box;display:block;';
    textarea.addEventListener('focus', function () { textarea.style.borderColor = '#7d8c6e'; });
    textarea.addEventListener('blur', function () { textarea.style.borderColor = '#e2ddd6'; });

    var footerBar = document.createElement('div');
    footerBar.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;margin-top:8px;';

    var charCount = document.createElement('span');
    charCount.style.cssText =
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:12px;color:#888;';

    var savedIndicator = document.createElement('span');
    savedIndicator.style.cssText =
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:12px;color:#7d8c6e;opacity:0;transition:opacity 0.3s ease;';
    savedIndicator.textContent = 'Saved';

    footerBar.appendChild(charCount);
    footerBar.appendChild(savedIndicator);
    body.appendChild(textarea);
    body.appendChild(footerBar);

    details.appendChild(summary);
    details.appendChild(body);
    panel.appendChild(details);

    target.parentNode.insertBefore(panel, target);

    // ── Character count ──
    function updateCharCount() {
      var len = textarea.value.length;
      charCount.textContent = len + '\u00a0/\u00a0' + MAX_CHARS;
      charCount.style.color = len >= MAX_CHARS ? '#c0392b' : '#888';
    }
    updateCharCount();

    // ── Save logic ──
    var saveTimer = null;
    var fadeTimer = null;

    function showSaved() {
      savedIndicator.style.opacity = '1';
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () { savedIndicator.style.opacity = '0'; }, 2000);
    }

    function saveNote() {
      var content = textarea.value;
      if (content.length > MAX_CHARS) return;
      setLocalNote(sessionId, content);
      if (session) {
        apiSaveNote(sessionId, content, session.access_token, function (ok) {
          if (ok) showSaved();
        });
      } else {
        showSaved();
      }
    }

    textarea.addEventListener('input', function () {
      updateCharCount();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNote, 1000);
    });

    // Also save immediately on blur (after clearing the debounce timer)
    textarea.addEventListener('blur', function () {
      clearTimeout(saveTimer);
      saveNote();
    });
  }

  // ── Landing page: pencil icons ───────────────────────────────────────────────

  function initLandingPage() {
    getSupabaseSession(function (session) {
      if (session) {
        apiGetBulkNotes(session.access_token, function (serverSessions) {
          if (serverSessions) {
            addPencilIcons(new Set(serverSessions));
          } else {
            addPencilIcons(getLocalNoteSessions());
          }
        });
      } else {
        addPencilIcons(getLocalNoteSessions());
      }
    });
  }

  function addPencilIcons(sessionSet) {
    if (!sessionSet || sessionSet.size === 0) return;

    // course-progress.js renders #poa-sessions-section with anchor links.
    // Each link href contains "/session-N/". We match the session_id from it.
    var section = document.getElementById('poa-sessions-section');
    if (!section) return;

    var links = section.querySelectorAll('a[href*="/session-"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var m = link.getAttribute('href').match(/\/courses\/([\w-]+)\/session-(\d+)\//);
      if (!m) continue;
      var sid = m[1] + '-' + m[2];
      if (!sessionSet.has(sid)) continue;

      var icon = document.createElement('span');
      icon.setAttribute('aria-label', 'You have notes for this session');
      icon.setAttribute('title', 'You have notes for this session');
      icon.textContent = '\u270f\ufe0e'; // ✏︎
      icon.style.cssText =
        'font-size:11px;color:#7d8c6e;margin-left:5px;opacity:0.75;flex-shrink:0;';
      // Insert after the link text within the left column span
      link.parentNode.appendChild(icon);
    }
  }

  // ── DOM ready helper ─────────────────────────────────────────────────────────

  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  if (sessionMatch) {
    var sid = getSessionId();
    if (sid) domReady(function () { initSessionPage(sid); });
  } else if (isLandingPage) {
    domReady(initLandingPage);
  }
})();
