/**
 * course-gate.js
 * Email gate for The Honest Meditator course sessions.
 *
 * Usage: include at the end of <body> on any session page.
 * Depends on: #poa-course-gate, #poa-gate-form, #poa-gate-email, #poa-gate-btn, #poa-gate-msg
 * and the `poa-gated` class added to <html> by the inline head script.
 */
(function () {
  'use strict';

  var gate = document.getElementById('poa-course-gate');
  if (!gate) return;

  var form = document.getElementById('poa-gate-form');
  var emailInput = document.getElementById('poa-gate-email');
  var btn = document.getElementById('poa-gate-btn');
  var msg = document.getElementById('poa-gate-msg');

  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var email = emailInput.value.trim();
    if (!email) return;

    btn.disabled = true;
    btn.textContent = '...';
    msg.textContent = '';
    msg.className = 'poa-gate-msg';

    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Subscribe failed: ' + res.status);
        return res.json();
      })
      .then(function () {
        localStorage.setItem('poa_subscribed', 'true');
        localStorage.setItem('poa_course_unlocked', 'true');
        window.plausible && window.plausible('Subscribe');
        window.plausible && window.plausible('CourseUnlock');
        document.documentElement.classList.remove('poa-gated');
        gate.style.display = 'none';
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Unlock course';
        msg.textContent = 'Something went wrong. Please try again.';
        msg.className = 'poa-gate-msg poa-gate-msg--error';
      });
  });
})();
