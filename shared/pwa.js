/* pwa.js — Service worker registration, offline banner, and "Read offline" button
 * Include on essay pages and the essay index.
 */
(function() {
  'use strict';

  // ─── Service worker registration ─────────────────────────────────────────

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function() {
      // Non-fatal: site works fine online without SW
    });
  }

  // ─── Offline indicator banner ─────────────────────────────────────────────

  var bannerEl = null;

  function ensureBanner() {
    if (bannerEl) return bannerEl;
    bannerEl = document.createElement('div');
    bannerEl.id = 'pwa-offline-banner';
    bannerEl.setAttribute('role', 'status');
    bannerEl.setAttribute('aria-live', 'polite');
    bannerEl.textContent = 'You are offline \u2014 showing cached version';
    bannerEl.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:#2c2c2c', 'color:#e8e3dc',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
      'font-size:13px', 'text-align:center', 'padding:10px 16px',
      'z-index:9000', 'display:none', 'letter-spacing:0.01em',
    ].join(';');
    document.body.appendChild(bannerEl);
    return bannerEl;
  }

  function updateBanner() {
    var b = ensureBanner();
    b.style.display = navigator.onLine ? 'none' : 'block';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateBanner);
  } else {
    updateBanner();
  }
  window.addEventListener('online', updateBanner);
  window.addEventListener('offline', updateBanner);

  // ─── "Read offline" button (essay pages only) ─────────────────────────────

  var ESSAY_CACHE = 'essays-v1';
  var ESSAY_LIMIT = 20;

  function injectReadOfflineButton() {
    if (!location.pathname.startsWith('/mindfulness-essays/')) return;
    if (location.pathname === '/mindfulness-essays/' || location.pathname === '/mindfulness-essays') return;

    if (!('serviceWorker' in navigator) || !('caches' in window)) return;

    var meta = document.querySelector('header .meta, .meta');
    if (!meta) return;
    if (document.getElementById('read-offline-btn')) return;

    // Style separator
    var sep = document.createElement('span');
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '\u00b7';
    meta.appendChild(sep);

    // Button
    var btn = document.createElement('button');
    btn.id = 'read-offline-btn';
    btn.type = 'button';
    btn.textContent = 'Read offline';
    btn.style.cssText = [
      'font-family:inherit', 'font-size:inherit', 'color:inherit',
      'background:none', 'border:none', 'cursor:pointer',
      'padding:0', 'text-decoration:underline', 'text-decoration-style:dotted',
      'opacity:0.75',
    ].join(';');
    meta.appendChild(btn);

    // Restore persisted state
    var storageKey = 'pwa_cached:' + location.pathname;
    if (localStorage.getItem(storageKey) === '1') {
      setCached(btn);
    }

    btn.addEventListener('click', function() {
      if (btn.dataset.state === 'cached' || btn.disabled) return;
      btn.dataset.state = 'saving';
      btn.textContent = 'Saving\u2026';
      btn.disabled = true;

      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.postMessage({ type: 'CACHE_ESSAY', url: location.href });
        cacheImages();
      } else {
        cacheDirectly(btn, storageKey);
      }
    });

    navigator.serviceWorker.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'ESSAY_CACHED' && e.data.url === location.href) {
        if (e.data.ok) {
          localStorage.setItem(storageKey, '1');
          setCached(btn);
        } else {
          resetButton(btn);
        }
      }
    });
  }

  function setCached(btn) {
    btn.dataset.state = 'cached';
    btn.textContent = 'Saved offline \u2713';
    btn.disabled = false;
    btn.style.textDecoration = 'none';
    btn.style.opacity = '1';
    btn.title = 'This essay is available offline';
  }

  function resetButton(btn) {
    btn.dataset.state = '';
    btn.textContent = 'Read offline';
    btn.disabled = false;
  }

  function cacheDirectly(btn, storageKey) {
    caches.open(ESSAY_CACHE).then(function(cache) {
      return fetch(location.href).then(function(res) {
        if (!res.ok) throw new Error('bad response');
        return cache.put(location.href, res).then(function() {
          return cache.keys().then(function(keys) {
            if (keys.length > ESSAY_LIMIT) {
              var old = keys.slice(0, keys.length - ESSAY_LIMIT);
              return Promise.all(old.map(function(k) { return cache.delete(k); }));
            }
          });
        });
      });
    }).then(function() {
      localStorage.setItem(storageKey, '1');
      setCached(btn);
      cacheImages();
    }).catch(function() {
      resetButton(btn);
    });
  }

  function cacheImages() {
    if (!('caches' in window)) return;
    var imgs = document.querySelectorAll('article img[src]');
    if (!imgs.length) return;
    caches.open(ESSAY_CACHE).then(function(cache) {
      imgs.forEach(function(img) {
        if (img.src && img.src.startsWith(location.origin)) {
          cache.add(img.src).catch(function() {});
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectReadOfflineButton);
  } else {
    injectReadOfflineButton();
  }
})();
