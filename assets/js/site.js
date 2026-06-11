/* MyFreeAudioTool — theme toggle + scroll reveal + lazy support widget */
(function () {
  'use strict';

  // ----- Theme -----
  var saved = null;
  try { saved = localStorage.getItem('mfat-theme'); } catch (e) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('mfat-theme', theme); } catch (e) {}
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('.theme-toggle');
    if (btn) btn.addEventListener('click', toggleTheme);

    // ----- Scroll reveal -----
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  });

  // ----- Support widget (lazy, skipped in the studio where space is tight) -----
  if (!document.querySelector('.editor-app')) {
    var loadSupport = function () {
      if (document.getElementById('swScript')) return;
      var s = document.createElement('script');
      s.id = 'swScript';
      s.src = '/assets/js/support-widget.js';
      s.defer = true;
      document.body.appendChild(s);
    };
    var queueSupport = function () {
      if ('requestIdleCallback' in window) requestIdleCallback(loadSupport, { timeout: 4000 });
      else setTimeout(loadSupport, 1800);
    };
    if (document.readyState === 'complete') queueSupport();
    else window.addEventListener('load', queueSupport);
  }
})();
