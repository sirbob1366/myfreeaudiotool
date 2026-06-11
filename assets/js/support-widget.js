/* MyFreeAudioTool — support widget.
   Lazy-loaded by site.js after the page is interactive. Fully client-side:
   searchable FAQ with keyword scoring + mailto fallback. No external calls. */
(function () {
  'use strict';
  if (document.getElementById('swFab')) return;

  var SITE = 'MyFreeAudioTool';
  var EMAIL = ['sawantrob', 'gmail', 'com'].slice(0, 2).join('@') + '.' + 'com';
  var MAILTO = 'mailto:' + EMAIL +
    '?subject=' + encodeURIComponent('Support: ' + SITE) +
    '&body=' + encodeURIComponent(
      'Hi Rob,\n\nWhat happened:\n\nWhich tool / page:\n\nBrowser & device (e.g. Chrome on Windows 11):\n\nThanks!');

  var FAQS = [
    { q: 'Is it really free?',
      a: 'Yes — all 31 tools and the multitrack editor are completely free. No signup, no watermark, no trial, no daily limits. Your own device does the processing, so the site costs almost nothing to run.',
      k: 'free cost price pay paid premium watermark signup account login trial limit catch' },
    { q: 'Are my audio files uploaded to a server?',
      a: 'No. Everything runs inside your browser using the Web Audio API and WebAssembly. There is no upload step — your files never leave your device, and we couldn’t see them even if we wanted to.',
      k: 'upload privacy private server safe secure data leave device cloud store tracking' },
    { q: 'Is there a file size limit?',
      a: 'No hard limit. Processing happens in your browser’s memory, so very long files (multi-hour recordings) depend on your device’s RAM. If a huge file struggles, try a desktop browser or cut the job into parts with the Trim tool first.',
      k: 'size limit large big long maximum mb gb hour memory ram crash cap' },
    { q: 'What audio formats can I use?',
      a: 'You can load MP3, WAV, M4A/AAC, OGG and FLAC — anything your browser can decode. Most tools export WAV or MP3, and the Convert Audio tool handles format-to-format conversion with FFmpeg running locally.',
      k: 'format mp3 wav m4a aac ogg flac opus type supported open convert extension' },
    { q: 'How do I remove vocals from a song?',
      a: 'Use the Vocal Remover (myfreeaudiotool.com/vocal-remover/). It works by phase cancellation, so it’s most effective when vocals are mixed dead-center — true for most studio recordings. Tracks with wide stereo vocals will keep more voice.',
      k: 'vocal remove voice karaoke instrumental acapella song lyrics singer' },
    { q: 'Can I record my voice over a backing track?',
      a: 'Yes — open the Audio Editor (myfreeaudiotool.com/audio-editor/), add your music, then press R. Your microphone records onto a new track while the others play, so voice-overs and harmonies land in time.',
      k: 'record microphone mic voice over backing track overdub podcast narration layer studio multitrack' },
    { q: 'How do I merge several files into one?',
      a: 'The Merge Audio tool (myfreeaudiotool.com/merge-audio/) joins any number of files back to back — drag to reorder, then export. To overlap layers (music under speech), use the multitrack Audio Editor instead.',
      k: 'merge join combine concatenate multiple files together append stitch mix' },
    { q: 'Why does exporting MP3 take a while?',
      a: 'MP3 encoding runs through the LAME encoder compiled to WebAssembly, entirely on your CPU — long files simply take longer. Keep the tab in the foreground while it works. WAV export is near-instant if you’re in a hurry.',
      k: 'export slow encode mp3 stuck freeze frozen wait render download taking forever' },
    { q: 'Does it work on phones and tablets?',
      a: 'Yes — every tool works in modern mobile browsers (Chrome, Safari, Firefox). Big multitrack projects are more comfortable on desktop, but trimming, converting and effects run fine on a phone.',
      k: 'phone mobile iphone android tablet ipad safari chrome work device' },
    { q: 'Why does my exported file sound different or smaller?',
      a: 'MP3 is a lossy format — smaller files trade away some fidelity. If you need a perfect copy of the processed audio, export WAV (lossless), or raise the MP3 bitrate where the tool offers one.',
      k: 'quality smaller bitrate lossy lossless sound worse different compressed bad muffled' }
  ];

  var css = '' +
    '.sw-fab{position:fixed;right:18px;bottom:18px;z-index:900;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;background:var(--grad);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(14,165,233,.4);transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease}' +
    '.sw-fab:hover{transform:translateY(-2px) scale(1.06);box-shadow:0 12px 30px rgba(14,165,233,.5)}' +
    '.sw-fab:focus-visible{outline:2px solid var(--accent);outline-offset:3px}' +
    '.sw-fab svg{width:22px;height:22px}' +
    '.sw-panel{position:fixed;right:18px;bottom:78px;z-index:901;width:344px;max-width:calc(100vw - 36px);max-height:min(560px,calc(100vh - 110px));display:none;flex-direction:column;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lift);overflow:hidden}' +
    '.sw-panel.open{display:flex}' +
    '.sw-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border);background:var(--bg-soft);flex:none}' +
    '.sw-head .sw-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);flex:none}' +
    '.sw-head b{font-family:var(--font-display);font-size:.95rem;color:var(--text)}' +
    '.sw-head .sw-sub{display:block;font-family:var(--font-mono);font-size:.64rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}' +
    '.sw-close{margin-left:auto;width:30px;height:30px;border:1px solid var(--border);border-radius:8px;background:none;color:var(--muted);cursor:pointer;font-size:1rem;line-height:1;flex:none}' +
    '.sw-close:hover{color:var(--text);border-color:var(--accent)}' +
    '.sw-body{padding:12px 14px 14px;overflow-y:auto;flex:1}' +
    '.sw-greet{background:var(--accent-soft);border:1px solid var(--border);border-radius:12px 12px 12px 4px;padding:10px 13px;font-size:.84rem;line-height:1.5;color:var(--text);margin:0 0 10px}' +
    '.sw-search{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--font-mono);font-size:.8rem;margin-bottom:10px}' +
    '.sw-search:focus{outline:none;border-color:var(--accent)}' +
    '.sw-list{list-style:none;margin:0;padding:0}' +
    '.sw-q{margin-bottom:8px;border:1px solid var(--border);border-radius:11px;background:var(--card);overflow:hidden}' +
    '.sw-q>button{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 13px;border:none;background:none;color:var(--text);font-family:var(--font-display);font-size:.85rem;font-weight:600;cursor:pointer}' +
    '.sw-q>button::after{content:"+";color:var(--accent);font-family:var(--font-mono);font-size:1.1rem;font-weight:500;flex:none}' +
    '.sw-q.open>button::after{content:"–"}' +
    '.sw-q>button:hover{color:var(--accent-dark)}' +
    '.sw-q>button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:11px}' +
    '.sw-a{display:none;padding:0 13px 11px;color:var(--muted);font-size:.82rem;line-height:1.55}' +
    '.sw-q.open .sw-a{display:block}' +
    '.sw-fallback{display:none;border:1px dashed var(--border);border-radius:12px;padding:14px;text-align:center;color:var(--muted);font-size:.84rem;line-height:1.5}' +
    '.sw-fallback.on{display:block}' +
    '.sw-fallback a{display:inline-block;margin-top:9px;padding:8px 16px;border-radius:10px;background:var(--grad);color:#fff;font-weight:700;font-size:.82rem;text-decoration:none}' +
    '.sw-foot{flex:none;padding:9px 14px;border-top:1px solid var(--border);background:var(--bg-soft);font-family:var(--font-mono);font-size:.68rem;color:var(--muted);text-align:center}' +
    '.sw-foot a{color:var(--accent-dark);text-decoration:none}' +
    '.sw-foot a:hover{text-decoration:underline}' +
    '@media (max-width:560px){.sw-panel{right:0;left:0;bottom:0;width:100%;max-width:none;border-radius:16px 16px 0 0;max-height:78vh}}' +
    '@media print{.sw-fab,.sw-panel{display:none!important}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  // floating button
  var fab = el('button', 'sw-fab');
  fab.id = 'swFab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Help and support');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'swPanel');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.2-.6L3 21l1.8-5.2a8.2 8.2 0 0 1-1.3-4.3A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>';

  // panel
  var panel = el('div', 'sw-panel');
  panel.id = 'swPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', SITE + ' help');

  var head = el('div', 'sw-head');
  head.appendChild(el('span', 'sw-dot'));
  head.appendChild(el('div', '', '<b>Need a hand?</b><span class="sw-sub">' + SITE + ' support</span>'));
  var closeBtn = el('button', 'sw-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close help');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var body = el('div', 'sw-body');
  body.appendChild(el('p', 'sw-greet',
    'Hi! Everything here runs on your device — nothing uploads. Search the FAQs below, or type your question.'));

  var search = el('input', 'sw-search');
  search.type = 'search';
  search.placeholder = 'Type a question…';
  search.setAttribute('aria-label', 'Search frequently asked questions');
  body.appendChild(search);

  var list = el('ul', 'sw-list');
  FAQS.forEach(function (f) {
    var li = el('li', 'sw-q');
    var btn = el('button', '', f.q);
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    var ans = el('div', 'sw-a', f.a);
    btn.addEventListener('click', function () {
      var open = li.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    li.appendChild(btn);
    li.appendChild(ans);
    list.appendChild(li);
    f.el = li;
  });
  body.appendChild(list);

  var fallback = el('div', 'sw-fallback',
    'No match for that one — sorry! Email Rob directly and he’ll get back to you, usually within a day or two.' +
    '<br><a href="' + MAILTO + '">Email ' + EMAIL + '</a>');
  body.appendChild(fallback);
  panel.appendChild(body);

  panel.appendChild(el('div', 'sw-foot',
    'no bots here — just FAQs + <a href="' + MAILTO + '">email support</a>'));

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // ----- search: simple keyword scoring -----
  function filter() {
    var terms = search.value.toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length >= 2; });
    if (!terms.length) {
      FAQS.forEach(function (f) { f.el.style.display = ''; });
      fallback.classList.remove('on');
      return;
    }
    var any = false;
    FAQS.forEach(function (f) {
      var s = 0, q = f.q.toLowerCase(), a = f.a.toLowerCase();
      terms.forEach(function (t) {
        if (q.indexOf(t) > -1) s += 3;
        if (f.k.indexOf(t) > -1) s += 2;
        if (a.indexOf(t) > -1) s += 1;
      });
      f.el.style.display = s > 0 ? '' : 'none';
      if (s > 0) any = true;
    });
    fallback.classList.toggle('on', !any);
  }
  search.addEventListener('input', filter);

  // ----- open/close + persistence -----
  function setOpen(open, focus) {
    panel.classList.toggle('open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem('mfat-support-open', open ? '1' : '0'); } catch (e) {}
    if (open && focus) search.focus();
    if (!open && focus) fab.focus();
  }
  fab.addEventListener('click', function () { setOpen(!panel.classList.contains('open'), true); });
  closeBtn.addEventListener('click', function () { setOpen(false, true); });
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false, true);
  });

  // restore previous state (without stealing focus)
  try { if (localStorage.getItem('mfat-support-open') === '1') setOpen(true, false); } catch (e) {}
})();
