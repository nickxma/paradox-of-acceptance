/**
 * essay-scroll-capture.js
 *
 * Scroll-triggered email capture banner for essay pages.
 * Appears at 50% scroll depth as a fixed bottom bar.
 * - Hides permanently once subscribed (localStorage: poa_subscribed = true)
 * - Dismissed state remembered for 30 days (localStorage: poa_scroll_cap_dismissed_at)
 * - POSTs to /api/subscribe with source: essay_scroll
 * - Fires Plausible Subscribe event with source prop on success
 */
(function () {
  'use strict';

  // Skip if already subscribed
  if (localStorage.getItem('poa_subscribed') === 'true') return;

  // Skip if dismissed within the last 30 days
  var dismissedAt = localStorage.getItem('poa_scroll_cap_dismissed_at');
  if (dismissedAt && (Date.now() - parseInt(dismissedAt, 10)) / 86400000 < 30) return;

  // ─── Build the banner DOM ───────────────────────────────────────────

  var styles = [
    '#poa-scroll-cap{',
      'position:fixed;bottom:0;left:0;right:0;',
      'background:#faf8f4;',
      'border-top:1px solid #e2ddd6;',
      'box-shadow:0 -2px 16px rgba(0,0,0,0.07);',
      'padding:14px 20px;',
      'z-index:9990;',
      'transform:translateY(100%);',
      'transition:transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94);',
      'font-family:Georgia,"Times New Roman",serif;',
    '}',
    '#poa-scroll-cap.poa-sc-visible{transform:translateY(0);}',
    '#poa-scroll-cap.poa-sc-hidden{display:none;}',
    '.poa-sc-inner{',
      'max-width:600px;margin:0 auto;',
      'display:flex;align-items:center;gap:14px;flex-wrap:wrap;',
    '}',
    '.poa-sc-text{flex:1;min-width:180px;}',
    '.poa-sc-headline{',
      'font-size:14px;font-weight:bold;color:#2c2c2c;line-height:1.3;',
    '}',
    '.poa-sc-sub{',
      'font-size:12px;color:#888;margin-top:2px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
    '}',
    '.poa-sc-form{',
      'display:flex;gap:8px;flex:1;min-width:220px;max-width:400px;',
    '}',
    '.poa-sc-input{',
      'flex:1;padding:9px 12px;',
      'border:1px solid #ccc;border-radius:5px;',
      'font-size:14px;font-family:Georgia,"Times New Roman",serif;',
      'background:#fff;color:#2c2c2c;outline:none;',
    '}',
    '.poa-sc-input:focus{border-color:#7d8c6e;}',
    '.poa-sc-btn{',
      'padding:9px 16px;white-space:nowrap;',
      'background:#7d8c6e;color:#fff;border:none;border-radius:5px;',
      'font-size:13px;font-weight:600;cursor:pointer;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'transition:background 0.15s;',
    '}',
    '.poa-sc-btn:hover{background:#5a6b4e;}',
    '.poa-sc-btn:disabled{background:#a4b594;cursor:default;}',
    '.poa-sc-msg{',
      'font-size:12px;margin-top:4px;min-height:16px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'color:#5a6b4e;',
    '}',
    '.poa-sc-msg.error{color:#dc2626;}',
    '.poa-sc-close{',
      'flex-shrink:0;background:none;border:none;cursor:pointer;',
      'color:#aaa;font-size:16px;padding:4px 6px;line-height:1;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'transition:color 0.15s;',
    '}',
    '.poa-sc-close:hover{color:#555;}',
    '@media(max-width:520px){',
      '.poa-sc-inner{flex-direction:column;align-items:stretch;gap:10px;}',
      '.poa-sc-form{flex-direction:column;}',
      '.poa-sc-btn{width:100%;}',
    '}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  var banner = document.createElement('div');
  banner.id = 'poa-scroll-cap';
  banner.innerHTML = [
    '<div class="poa-sc-inner">',
      '<div class="poa-sc-text">',
        '<div class="poa-sc-headline">Enjoying this? Get new essays in your inbox.</div>',
        '<div class="poa-sc-sub">No spam. Just new essays and tools, when they\'re ready.</div>',
      '</div>',
      '<div>',
        '<form class="poa-sc-form" id="poa-sc-form" autocomplete="off">',
          '<input class="poa-sc-input" id="poa-sc-email" type="email" placeholder="you@email.com" required />',
          '<button class="poa-sc-btn" id="poa-sc-btn" type="submit">Subscribe</button>',
        '</form>',
        '<div class="poa-sc-msg" id="poa-sc-msg"></div>',
      '</div>',
      '<button class="poa-sc-close" id="poa-sc-close" aria-label="Dismiss">\u00d7</button>',
    '</div>',
  ].join('');
  document.body.appendChild(banner);

  // ─── Scroll trigger ─────────────────────────────────────────────────

  var triggered = false;

  function checkScroll() {
    if (triggered) return;
    var total = document.documentElement.scrollHeight - window.innerHeight;
    if (total > 0 && window.scrollY / total >= 0.5) {
      triggered = true;
      banner.classList.add('poa-sc-visible');
      window.removeEventListener('scroll', checkScroll);
    }
  }

  window.addEventListener('scroll', checkScroll, { passive: true });

  // ─── Dismiss ────────────────────────────────────────────────────────

  document.getElementById('poa-sc-close').addEventListener('click', function () {
    banner.classList.add('poa-sc-hidden');
    localStorage.setItem('poa_scroll_cap_dismissed_at', Date.now().toString());
  });

  // ─── Subscribe ──────────────────────────────────────────────────────

  document.getElementById('poa-sc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('poa-sc-email').value.trim();
    if (!email) return;

    var btn = document.getElementById('poa-sc-btn');
    var msg = document.getElementById('poa-sc-msg');
    btn.disabled = true;
    btn.textContent = '\u2026';
    msg.textContent = '';
    msg.className = 'poa-sc-msg';

    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, source: 'essay_scroll' }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Subscribe';
        if (!res.ok) {
          msg.textContent = res.data.error || 'Something went wrong. Try again.';
          msg.className = 'poa-sc-msg error';
        } else {
          localStorage.setItem('poa_subscribed', 'true');
          window.plausible && window.plausible('Subscribe', { props: { source: 'essay_scroll' } });
          msg.textContent = "You\u2019re in. Welcome.";
          document.getElementById('poa-sc-email').value = '';
          setTimeout(function () { banner.classList.add('poa-sc-hidden'); }, 2200);
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Subscribe';
        msg.textContent = 'Something went wrong. Try again.';
        msg.className = 'poa-sc-msg error';
      });
  });
})();
