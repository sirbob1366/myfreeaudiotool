#!/usr/bin/env python3
"""One-shot helper for the design-elevation commit:
   1. adds meters.js to every page that loads audio-engine.js but not meters.js
   2. weaves new-tool cards into existing pages' related strips
   3. refreshes stale "13 tools" copy on the about page
Idempotent."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------- 1. meters.js on legacy pages ----------
added = []
for page in sorted(ROOT.glob('*/index.html')):
    html = page.read_text(encoding='utf-8')
    if 'audio-engine.js' in html and 'meters.js' not in html:
        html = html.replace(
            '<script src="/assets/js/audio-engine.js"></script>',
            '<script src="/assets/js/audio-engine.js"></script>\n<script src="/assets/js/meters.js"></script>')
        page.write_text(html, encoding='utf-8', newline='\n')
        added.append(page.parent.name)
print('meters.js added to:', ', '.join(added) or '(none)')

# ---------- 2. related-strip weaving ----------
CARD = '        <a class="related-card" href="/{href}/"><b>{title}</b><span>{desc}</span></a>\n'
WEAVE = {
    'trim-audio': [('silence-remover', 'Silence Remover', 'Cut dead air automatically')],
    'merge-audio': [('audio-tag-editor', 'MP3 Tag Editor', 'Tag the merged file properly')],
    'audio-recorder': [('noise-reducer', 'Noise Reducer', 'Clean hiss from your recording')],
    'audio-speed-changer': [('slowed-and-reverb', 'Slowed & Reverb', 'The aesthetic, with pitch drop + hall')],
    'pitch-shifter': [('432hz-converter', '432 Hz Converter', 'The −0.32 semitone preset with A/B')],
    'equalizer': [('bass-booster', 'Bass Booster', 'One-knob low shelf with presets')],
    'volume-booster': [('bass-booster', 'Bass Booster', 'Boost lows without clipping')],
    'reverse-audio': [('reverb', 'Reverb', 'Reversed reverb is a classic effect')],
    'bpm-key-finder': [('instrument-tuner', 'Instrument Tuner', 'Chromatic mic tuner with cents needle'),
                       ('spectrogram', 'Spectrogram', 'See the frequencies behind the key')],
    'convert-audio': [('stereo-to-mono', 'Stereo ↔ Mono', 'Downmix or widen channels')],
    'compress-audio': [('audio-tag-editor', 'MP3 Tag Editor', 'Fix tags after compressing')],
    'extract-audio-from-video': [('vocal-remover', 'Vocal Remover', 'Strip vocals from the extracted track')],
    'ringtone-maker': [('bass-booster', 'Bass Booster', 'Make the ringtone thump')],
}
for slug, cards in WEAVE.items():
    page = ROOT / slug / 'index.html'
    html = page.read_text(encoding='utf-8')
    m = re.search(r'(<div class="related-grid">)(.*?)(      </div>)', html, re.S)
    if not m:
        print('!! no related-grid in', slug)
        continue
    block = m.group(2)
    new = ''
    for href, title, desc in cards:
        if '/' + href + '/' not in block:
            new += CARD.format(href=href, title=title, desc=desc)
    if new:
        html = html[:m.end(2)] + new + html[m.end(2):]
        page.write_text(html, encoding='utf-8', newline='\n')
        print('related+ ', slug, '->', ', '.join(c[0] for c in cards))

# ---------- 3. about-page copy ----------
about = ROOT / 'about' / 'index.html'
html = about.read_text(encoding='utf-8')
html = html.replace('13 free, private, browser-based audio tools', '31 free, private, browser-based audio tools')
html = html.replace('13 free online audio tools', '31 free online audio tools')
html = html.replace(
    'a collection of thirteen free audio utilities that run entirely in your web browser — trimming, merging, converting, compressing, EQ, pitch shifting, speed changing, reversing, volume boosting, ringtone making, voice recording, video-to-audio extraction, and BPM/key analysis.',
    'a collection of thirty-one free audio utilities that run entirely in your web browser — editing (trim, merge, silence removal, tagging), conversion, effects (EQ, reverb, vocal removal, noise reduction, 8D and 3D spatial audio, slowed + reverb), generators (test tones, noise colors, metronome) and analysis (BPM/key, chromatic tuner, spectrogram, waveform art).')
about.write_text(html, encoding='utf-8', newline='\n')
print('about page refreshed')
