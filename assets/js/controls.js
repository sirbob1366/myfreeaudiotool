/* MyFreeAudioTool — instrument-grade controls.
   Progressive enhancement around native inputs so keyboard handling and ARIA
   semantics stay native:
     input[type=range][data-knob]    → rotary knob (drag vertically, dblclick = reset)
     input[type=range][data-fader]   → fader with a detent (data-detent, default 0)
     input[type=checkbox][data-switch] → toggle switch
   Re-run Controls.upgrade(root) after injecting new DOM. */
(function (global) {
  'use strict';
  var Controls = {};

  // ---------- helpers ----------
  function fmt(input) {
    var v = parseFloat(input.value);
    var dp = input.dataset.decimals !== undefined
      ? parseInt(input.dataset.decimals, 10)
      : ((input.step && input.step.indexOf('.') >= 0) ? input.step.split('.')[1].length : 0);
    var unit = input.dataset.unit || '';
    var sign = input.dataset.signed !== undefined && v > 0 ? '+' : '';
    return sign + v.toFixed(dp) + (unit ? ' ' + unit : '');
  }

  function frac(input) {
    var min = parseFloat(input.min || 0), max = parseFloat(input.max || 100);
    return (parseFloat(input.value) - min) / (max - min);
  }

  // ---------- rotary knob ----------
  var A0 = -135, A1 = 135; // degrees, 270° sweep

  function polar(cx, cy, r, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function arcPath(cx, cy, r, startDeg, endDeg) {
    var s = polar(cx, cy, r, endDeg), e = polar(cx, cy, r, startDeg);
    var large = endDeg - startDeg <= 180 ? 0 : 1;
    return 'M ' + s[0] + ' ' + s[1] + ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + e[0] + ' ' + e[1];
  }

  function upgradeKnob(input) {
    if (input.__upgraded) return;
    input.__upgraded = true;
    var wrap = document.createElement('div');
    wrap.className = 'knob';
    var size = parseInt(input.dataset.size || '64', 10);

    var ticks = '';
    for (var i = 0; i <= 10; i++) {
      var a = A0 + (i / 10) * (A1 - A0);
      var p1 = polar(40, 40, 36, a), p2 = polar(40, 40, 33, a);
      ticks += '<line x1="' + p1[0] + '" y1="' + p1[1] + '" x2="' + p2[0] + '" y2="' + p2[1] + '" class="knob__tick"/>';
    }
    wrap.innerHTML =
      '<div class="knob__dial" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg viewBox="0 0 80 80" aria-hidden="true">' +
      ticks +
      '<path class="knob__track" d="' + arcPath(40, 40, 29, A0, A1) + '"/>' +
      '<path class="knob__fill" d=""/>' +
      '<circle class="knob__cap" cx="40" cy="40" r="22"/>' +
      '<line class="knob__pointer" x1="40" y1="40" x2="40" y2="21"/>' +
      '</svg></div>' +
      '<span class="knob__value"></span>' +
      '<span class="knob__label">' + (input.dataset.label || '') + '</span>';

    input.parentNode.insertBefore(wrap, input);
    wrap.querySelector('.knob__dial').appendChild(input);
    input.classList.add('knob__input');

    var fill = wrap.querySelector('.knob__fill');
    var pointer = wrap.querySelector('.knob__pointer');
    var valueEl = wrap.querySelector('.knob__value');

    function render() {
      var f = Math.max(0, Math.min(1, frac(input)));
      var ang = A0 + f * (A1 - A0);
      // bipolar knobs (data-signed) fill from 12 o'clock, others from the start
      if (input.dataset.signed !== undefined) {
        fill.setAttribute('d', ang >= 0 ? arcPath(40, 40, 29, 0, ang || 0.01) : arcPath(40, 40, 29, ang, 0));
      } else {
        fill.setAttribute('d', arcPath(40, 40, 29, A0, Math.max(ang, A0 + 0.01)));
      }
      pointer.setAttribute('transform', 'rotate(' + ang + ' 40 40)');
      valueEl.textContent = fmt(input);
    }
    input.addEventListener('input', render);
    render();

    // vertical drag
    var dial = wrap.querySelector('.knob__dial');
    var dragY = null, dragVal = 0;
    dial.addEventListener('pointerdown', function (e) {
      if (input.disabled) return;
      dragY = e.clientY;
      dragVal = parseFloat(input.value);
      dial.setPointerCapture(e.pointerId);
      input.focus({ preventScroll: true });
      e.preventDefault();
    });
    dial.addEventListener('pointermove', function (e) {
      if (dragY === null) return;
      var min = parseFloat(input.min || 0), max = parseFloat(input.max || 100);
      var fine = e.shiftKey ? 0.18 : 1;
      var next = dragVal + (dragY - e.clientY) / 150 * (max - min) * fine;
      var step = parseFloat(input.step || 1);
      next = Math.round(next / step) * step;
      next = Math.max(min, Math.min(max, next));
      if (String(next) !== input.value) {
        input.value = next;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    function endDrag() { dragY = null; }
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('dblclick', function () {
      if (input.dataset.default === undefined) return;
      input.value = input.dataset.default;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // ---------- fader with detent ----------
  function upgradeFader(input) {
    if (input.__upgraded) return;
    input.__upgraded = true;
    input.classList.add('fader');
    var detent = parseFloat(input.dataset.detent || '0');
    var min = parseFloat(input.min || 0), max = parseFloat(input.max || 100);
    var snap = (max - min) * 0.018;
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (Math.abs(v - detent) < snap && v !== detent) {
        input.value = detent;
      }
      var out = input.dataset.out && document.getElementById(input.dataset.out);
      if (out) out.textContent = fmt(input);
    });
    var out = input.dataset.out && document.getElementById(input.dataset.out);
    if (out) out.textContent = fmt(input);
  }

  // ---------- toggle switch ----------
  function upgradeSwitch(input) {
    if (input.__upgraded) return;
    input.__upgraded = true;
    var lab = input.closest('label');
    if (lab) lab.classList.add('switch');
    var slide = document.createElement('span');
    slide.className = 'switch__slide';
    slide.setAttribute('aria-hidden', 'true');
    input.insertAdjacentElement('afterend', slide);
  }

  Controls.upgrade = function (root) {
    root = root || document;
    root.querySelectorAll('input[type="range"][data-knob]').forEach(upgradeKnob);
    root.querySelectorAll('input[type="range"][data-fader]').forEach(upgradeFader);
    root.querySelectorAll('input[type="checkbox"][data-switch]').forEach(upgradeSwitch);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { Controls.upgrade(); });
  } else {
    Controls.upgrade();
  }

  global.Controls = Controls;
})(window);
