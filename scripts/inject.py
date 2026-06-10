#!/usr/bin/env python3
"""Template injection for MyFreeAudioTool.

Replaces the shared header/footer in every page with the current contents of
assets/templates/header.html and footer.html. Handles both fresh pages
(containing <!--SITE-HEADER--> / <!--SITE-FOOTER--> markers) and pages that
already carry an injected copy (matched by the outer <header class="site-header">
/ <footer class="site-footer"> blocks). Idempotent — run from repo root after
any template edit:

    python scripts/inject.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

header = (ROOT / 'assets/templates/header.html').read_text(encoding='utf-8').strip()
footer = (ROOT / 'assets/templates/footer.html').read_text(encoding='utf-8').strip()
head_common = (ROOT / 'assets/templates/head-common.html').read_text(encoding='utf-8').strip('\n')

HEADER_RE = re.compile(r'<header class="site-header">.*?</header>', re.S)
FOOTER_RE = re.compile(r'<footer class="site-footer">.*?</footer>', re.S)

pages = [ROOT / 'index.html'] + sorted(ROOT.glob('*/index.html'))
changed = 0
for page in pages:
    if 'scripts' in page.parts or 'assets' in page.parts:
        continue
    html = page.read_text(encoding='utf-8')
    orig = html
    html = html.replace('<!--HEAD-COMMON-->', head_common)
    if '<!--SITE-HEADER-->' in html:
        html = html.replace('<!--SITE-HEADER-->', header)
    else:
        html = HEADER_RE.sub(lambda m: header, html, count=1)
    if '<!--SITE-FOOTER-->' in html:
        html = html.replace('<!--SITE-FOOTER-->', footer)
    else:
        html = FOOTER_RE.sub(lambda m: footer, html, count=1)
    if html != orig:
        page.write_text(html, encoding='utf-8', newline='\n')
        changed += 1
        print(f'injected: {page.relative_to(ROOT)}')

print(f'{changed} page(s) updated.')
