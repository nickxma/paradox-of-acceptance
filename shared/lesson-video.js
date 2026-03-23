/**
 * lesson-video.js
 * Video embed player for PoA course lessons.
 *
 * Supports YouTube (youtube-nocookie.com) and Vimeo (dnt=1) for privacy.
 * Privacy-friendly: shows thumbnail card first; loads iframe only on click.
 * Tracks 90% completion via POST /api/lessons/:id/video-watched.
 *
 * Config source: <div id="lesson-video-config"> with data attributes:
 *   data-lesson-id       DB lesson UUID (for video-watched API)
 *   data-video-url       YouTube or Vimeo URL
 *   data-video-position  top | bottom | inline
 *   data-video-duration  Video duration in minutes (optional)
 *
 * For inline position, place <div id="lesson-video-inline"></div> in the
 * article at the desired location (or use the ::video:: text token).
 *
 * Include at end of <body> on session pages.
 */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────

  var configEl = document.getElementById('lesson-video-config');
  if (!configEl) return;

  var lessonId     = configEl.getAttribute('data-lesson-id')    || '';
  var videoUrl     = configEl.getAttribute('data-video-url')    || '';
  var position     = configEl.getAttribute('data-video-position') || 'top';
  var durationMin  = parseInt(configEl.getAttribute('data-video-duration') || '0', 10);

  if (!videoUrl) return;

  var videoInfo = parseVideoUrl(videoUrl);
  if (!videoInfo) return;

  var watchedFired = false;

  // ── URL parsing ──────────────────────────────────────────────────────────────

  function parseVideoUrl(url) {
    // YouTube: watch?v=, youtu.be, embed/
    var ytMatch = url.match(
      /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (ytMatch) return { platform: 'youtube', id: ytMatch[1] };

    // Vimeo: vimeo.com/:id or player.vimeo.com/video/:id
    var vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeoMatch) return { platform: 'vimeo', id: vimeoMatch[1] };

    return null;
  }

  // ── Thumbnail card ───────────────────────────────────────────────────────────

  function buildCard() {
    var card = document.createElement('div');
    card.className = 'lesson-video-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Watch video');
    card.style.cssText =
      'position:relative;width:100%;aspect-ratio:16/9;' +
      'background:#1a1a1a;border-radius:4px;overflow:hidden;' +
      'cursor:pointer;margin:0 0 40px;';

    // Fallback for browsers without aspect-ratio: padding-bottom trick
    // We wrap in a sizer div for older browser support
    var sizer = document.createElement('div');
    sizer.style.cssText =
      'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;' +
      'border-radius:4px;margin:0 0 40px;';
    card.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'background:#1a1a1a;cursor:pointer;';
    card.style.removeProperty('aspect-ratio');
    card.style.removeProperty('margin');
    card.style.removeProperty('border-radius');

    // Thumbnail image
    var thumb = document.createElement('img');
    thumb.alt = '';
    thumb.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'object-fit:cover;opacity:0.88;transition:opacity 0.2s;';

    if (videoInfo.platform === 'youtube') {
      thumb.src = 'https://img.youtube.com/vi/' + videoInfo.id + '/maxresdefault.jpg';
      // Fallback if maxresdefault not available (videos < 720p)
      thumb.onerror = function () {
        thumb.src = 'https://img.youtube.com/vi/' + videoInfo.id + '/hqdefault.jpg';
        thumb.onerror = null;
      };
    } else if (videoInfo.platform === 'vimeo') {
      // Fetch Vimeo thumbnail async (oEmbed — no auth required)
      fetch('https://vimeo.com/api/oembed.json?url=https://vimeo.com/' + videoInfo.id)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.thumbnail_url) {
            // Use larger size by replacing dimensions in the URL
            thumb.src = d.thumbnail_url.replace(/_\d+x\d+\./, '_640x360.');
          }
        })
        .catch(function () {});
    }

    card.appendChild(thumb);

    // Platform badge (top-left)
    var platformLabel = videoInfo.platform === 'youtube' ? 'YouTube' : 'Vimeo';
    var badge = document.createElement('span');
    badge.style.cssText =
      'position:absolute;top:12px;left:12px;' +
      'background:rgba(0,0,0,0.65);color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:11px;letter-spacing:0.04em;font-weight:500;' +
      'padding:3px 8px;border-radius:3px;';
    badge.textContent = platformLabel;
    card.appendChild(badge);

    // Duration badge (bottom-right)
    if (durationMin > 0) {
      var durBadge = document.createElement('span');
      durBadge.style.cssText =
        'position:absolute;bottom:12px;right:12px;' +
        'background:rgba(0,0,0,0.65);color:#fff;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
        'font-size:11px;letter-spacing:0.01em;' +
        'padding:3px 8px;border-radius:3px;';
      durBadge.textContent = durationMin + ' min';
      card.appendChild(durBadge);
    }

    // Play button
    var playWrap = document.createElement('div');
    playWrap.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    var playCircle = document.createElement('div');
    playCircle.style.cssText =
      'width:68px;height:68px;background:rgba(0,0,0,0.72);' +
      'border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'transition:transform 0.15s ease,background 0.15s ease;';
    playCircle.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">' +
      '<path d="M8 5v14l11-7z"/></svg>';
    playWrap.appendChild(playCircle);
    card.appendChild(playWrap);

    // Watch Video label
    var watchLabel = document.createElement('span');
    watchLabel.style.cssText =
      'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:12px;font-weight:500;letter-spacing:0.04em;' +
      'color:rgba(255,255,255,0.75);white-space:nowrap;pointer-events:none;';
    watchLabel.textContent = 'Watch Video';
    card.appendChild(watchLabel);

    // Hover effects
    card.addEventListener('mouseenter', function () {
      thumb.style.opacity = '0.7';
      playCircle.style.transform = 'scale(1.1)';
      playCircle.style.background = 'rgba(0,0,0,0.88)';
    });
    card.addEventListener('mouseleave', function () {
      thumb.style.opacity = '0.88';
      playCircle.style.transform = '';
      playCircle.style.background = 'rgba(0,0,0,0.72)';
    });

    // Click / keyboard activation
    card.addEventListener('click', function () { activatePlayer(sizer); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activatePlayer(sizer);
      }
    });

    sizer.appendChild(card);
    return sizer;
  }

  // ── Player activation ────────────────────────────────────────────────────────

  function activatePlayer(sizer) {
    if (videoInfo.platform === 'youtube') {
      initYouTubePlayer(sizer);
    } else {
      loadIframePlayer(sizer);
    }
  }

  // YouTube: uses IFrame Player API for accurate progress tracking
  function initYouTubePlayer(sizer) {
    buildIframeWrapper(sizer, ''); // placeholder div for YT API to target

    var containerId = 'lesson-yt-container-' + Date.now();
    var container = document.createElement('div');
    container.id = containerId;
    container.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    sizer.appendChild(container);

    var playerVars = { autoplay: 1, rel: 0, modestbranding: 1 };

    if (window.YT && window.YT.Player) {
      createYTPlayer(containerId, playerVars);
    } else {
      // Queue init until API ready; preserve existing callback if any
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') prev();
        createYTPlayer(containerId, playerVars);
      };
      if (!document.getElementById('yt-iframe-api')) {
        var tag = document.createElement('script');
        tag.id = 'yt-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    }
  }

  function createYTPlayer(containerId, playerVars) {
    /* global YT */
    new YT.Player(containerId, {
      videoId: videoInfo.id,
      playerVars: playerVars,
      events: {
        onStateChange: function (e) {
          if (e.data === YT.PlayerState.PLAYING) {
            startYTTracking(e.target);
          }
        }
      }
    });
  }

  function startYTTracking(player) {
    var timer = setInterval(function () {
      if (watchedFired) { clearInterval(timer); return; }
      try {
        var dur = player.getDuration();
        var cur = player.getCurrentTime();
        if (dur > 0 && cur / dur >= 0.9) {
          watchedFired = true;
          clearInterval(timer);
          postWatched(Math.round((cur / dur) * 100));
        }
      } catch (e) { /* player not ready yet */ }
    }, 2000);
  }

  // Vimeo and direct iframe load
  function loadIframePlayer(sizer) {
    var embedUrl;
    if (videoInfo.platform === 'vimeo') {
      embedUrl = 'https://player.vimeo.com/video/' + videoInfo.id +
                 '?autoplay=1&dnt=1&transparent=0';
    } else {
      // Fallback for any non-YT-API path
      embedUrl = 'https://www.youtube-nocookie.com/embed/' + videoInfo.id +
                 '?autoplay=1&rel=0';
    }

    var wrapper = buildIframeWrapper(sizer, embedUrl);

    if (videoInfo.platform === 'vimeo') {
      setupVimeoTracking(wrapper.querySelector('iframe'));
    }
  }

  function buildIframeWrapper(sizer, src) {
    // Clear existing card content from sizer
    sizer.innerHTML = '';

    var wrapper = document.createElement('div');
    wrapper.style.cssText =
      'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:4px;';

    if (src) {
      var iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('title', 'Course video');
      wrapper.appendChild(iframe);
    }

    sizer.style.cssText = 'margin:0 0 40px;';
    sizer.appendChild(wrapper);
    return wrapper;
  }

  // ── Vimeo progress tracking (postMessage) ────────────────────────────────────

  function setupVimeoTracking(iframe) {
    if (!iframe) return;

    var duration = 0;

    function sendVimeo(msg) {
      try {
        iframe.contentWindow.postMessage(JSON.stringify(msg), 'https://player.vimeo.com');
      } catch (e) {}
    }

    iframe.addEventListener('load', function () {
      sendVimeo({ method: 'addEventListener', value: 'timeupdate' });
      sendVimeo({ method: 'getDuration' });
    });

    window.addEventListener('message', function onMsg(e) {
      if (e.origin !== 'https://player.vimeo.com') return;

      var data;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch (err) { return; }

      if (data.event === 'ready') {
        sendVimeo({ method: 'addEventListener', value: 'timeupdate' });
        sendVimeo({ method: 'getDuration' });
      }

      if (data.method === 'getDuration' && data.value) {
        duration = data.value;
      }

      if (data.event === 'timeupdate' && data.data) {
        if (!duration && data.data.duration) duration = data.data.duration;
        var cur = data.data.seconds || 0;
        if (duration > 0 && !watchedFired && cur / duration >= 0.9) {
          watchedFired = true;
          window.removeEventListener('message', onMsg);
          postWatched(Math.round((cur / duration) * 100));
        }
      }
    });
  }

  // ── Progress API call ────────────────────────────────────────────────────────

  function postWatched(percentWatched) {
    if (!lessonId) return;
    try {
      fetch('/api/lessons/' + lessonId + '/video-watched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percentWatched: percentWatched })
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Duration in header ───────────────────────────────────────────────────────

  function updateDurationDisplay() {
    if (!durationMin) return;
    var el = document.querySelector('.duration');
    if (!el) return;
    // Append video duration if not already present
    if (el.textContent.indexOf('video') === -1) {
      el.textContent = el.textContent.replace(/\s*$/, '') +
        ' · ' + durationMin + '-min video';
    }
  }

  // ── Positioning ──────────────────────────────────────────────────────────────

  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  domReady(function () {
    updateDurationDisplay();
    insertVideo();
  });

  function insertVideo() {
    var card = buildCard();
    var article = document.querySelector('article');

    if (position === 'top') {
      if (!article) return;
      article.insertBefore(card, article.firstChild);

    } else if (position === 'bottom') {
      if (!article) return;
      // Insert before .session-summary if present, else at end
      var summary = article.querySelector('.session-summary');
      if (summary) {
        article.insertBefore(card, summary);
      } else {
        article.appendChild(card);
      }

    } else if (position === 'inline') {
      // Try explicit placeholder first
      var placeholder = document.getElementById('lesson-video-inline');
      if (placeholder) {
        placeholder.parentNode.replaceChild(card, placeholder);
        return;
      }
      // Fall back to ::video:: text token
      if (article) {
        var found = replaceVideoToken(article, card);
        if (!found) {
          // No marker found — default to top
          article.insertBefore(card, article.firstChild);
        }
      }
    }
  }

  // Walk text nodes looking for ::video:: token; replace with card
  function replaceVideoToken(root, card) {
    var nodes = [];
    collectTextNodes(root, nodes);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var idx = node.nodeValue.indexOf('::video::');
      if (idx === -1) continue;

      var before = node.nodeValue.substring(0, idx);
      var after  = node.nodeValue.substring(idx + '::video::'.length);
      var parent = node.parentNode;

      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(card, node);
      if (after)  parent.insertBefore(document.createTextNode(after),  node);
      parent.removeChild(node);
      return true;
    }
    return false;
  }

  function collectTextNodes(node, out) {
    if (node.nodeType === 3) {
      out.push(node);
    } else {
      for (var i = 0; i < node.childNodes.length; i++) {
        collectTextNodes(node.childNodes[i], out);
      }
    }
  }

})();
