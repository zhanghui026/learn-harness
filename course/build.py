#!/usr/bin/env python3
"""Build the publishable page: generate navigation, then inline every illustration.

Source of truth is agent-harness-course.src.html. Two things are generated here
rather than hand-maintained, because both go stale the moment a lesson is edited:

- every lesson gets a per-lesson table of contents after its header, built from
  the `id` and tag of each beat and figure inside it;
- the floating panel's outline replaces the `<!--OUTLINE-->` marker.

Illustrations are placeholders `<img class="ill" data-src="<slug>">`; artifacts
block external requests, so the published file must carry the bytes inline.
"""
import base64
import pathlib
import re

SRC = pathlib.Path('agent-harness-course.src.html')
OUT = pathlib.Path('agent-harness-course.html')
IMG = pathlib.Path('img')

# Sections outside the lesson list, in page order.
BANDS = [
    ('method', '教法', 'Method'),
    ('roadmap', '路线图', 'Roadmap'),
    ('metaphors', '说给小孩听', 'Explain it to a child'),
    ('quiz', '自测十题', 'Ten questions'),
    ('whomakes', '谁生成了什么', 'Who produces what'),
    ('walkthrough', '一次完整的任务', 'One task, end to end'),
    ('afterclass', '课后第一步', 'After class'),
    ('termindex', '术语索引', 'Term index'),
    ('handson', '现在动手', 'Hands on'),
]

BEAT = re.compile(
    r'<div class="beat" id="([^"]+)">\s*\n\s*<span class="tag">'
    r'<span lang="zh">(.*?)</span><span lang="en">(.*?)</span>',
    re.S)
FIGURE = re.compile(r'<figure class="fig" id="([^"]+)">')


def twin(zh: str, en: str) -> str:
    return '<span lang="zh">%s</span><span lang="en">%s</span>' % (zh, en)


def lessons(page: str):
    """Yield (lesson id, title zh, title en, [(anchor, zh, en, kind)]) per lesson."""
    for match in re.finditer(r'<article class="lesson" id="\w+">', page):
        end = page.index('</article>', match.start())
        body = page[match.start():end]
        lid = re.search(r'<span class="id">(\w+)</span>', body).group(1)
        title = re.search(r'<h3><span lang="zh">(.*?)</span><span lang="en">(.*?)</span></h3>', body)
        entries = []
        for item in re.finditer('%s|%s' % (BEAT.pattern, FIGURE.pattern), body, re.S):
            if item.group(1):
                entries.append((item.group(1), item.group(2), item.group(3), 'beat'))
            else:
                n = sum(1 for e in entries if e[3] == 'fig') + 1
                entries.append((item.group(4), '图 %d' % n, 'fig %d' % n, 'fig'))
        yield lid, title.group(1), title.group(2), entries


def lesson_toc(entries) -> str:
    links = ''.join(
        '<a href="#%s"%s>%s</a>' % (anchor, ' class="figlink"' if kind == 'fig' else '', twin(zh, en))
        for anchor, zh, en, kind in entries)
    label = '<span>%s</span>' % twin('本课', 'IN THIS LESSON')
    return '<nav class="lesson-toc">%s%s</nav>' % (label, links)


def outline(page: str) -> str:
    parts = []
    for anchor, zh, en in BANDS[:2]:
        parts.append('<a href="#%s">%s</a>' % (anchor, twin(zh, en)))
    parts.append('<h4>%s</h4>' % twin('全部十三课', 'ALL LESSONS'))
    for lid, zh, en, entries in lessons(page):
        parts.append('<div class="lead"><b>%s</b><a href="#%s">%s</a></div>' % (lid, lid.lower(), twin(zh, en)))
        parts.append('<div class="kids">%s</div>' % ''.join(
            '<a href="#%s">%s</a>' % (anchor, twin(z, e))
            for anchor, z, e, kind in entries if kind == 'beat'))
    parts.append('<h4>%s</h4>' % twin('别的', 'ELSEWHERE'))
    for anchor, zh, en in BANDS[2:]:
        parts.append('<a href="#%s">%s</a>' % (anchor, twin(zh, en)))
    return ''.join(parts)


page = SRC.read_text(encoding='utf-8')

# 1. per-lesson tables of contents
out = []
pos = 0
for match in re.finditer(r'<article class="lesson" id="\w+">', page):
    end = page.index('</article>', match.start())
    body = page[match.start():end]
    _, _, _, entries = next(iter(lessons(body + '</article>')))
    header_end = body.index('</header>') + len('</header>')
    rebuilt = body[:header_end] + '\n\n      ' + lesson_toc(entries) + body[header_end:]
    out.append(page[pos:match.start()])
    out.append(rebuilt)
    pos = end
out.append(page[pos:])
page = ''.join(out)

# 2. the floating panel
if '<!--OUTLINE-->' not in page:
    raise SystemExit('outline marker missing')
page = page.replace('<!--OUTLINE-->', outline(page), 1)

# 3. illustrations
missing = []


def inline(match: re.Match) -> str:
    slug = match.group(1)
    path = IMG / (slug + '.jpg')
    if not path.exists():
        missing.append(slug)
        return match.group(0)
    data = base64.b64encode(path.read_bytes()).decode('ascii')
    return 'src="data:image/jpeg;base64,%s"' % data


page, count = re.subn(r'data-src="([^"]+)"', inline, page)
if missing:
    raise SystemExit('missing illustrations: %s' % missing)

OUT.write_text(page, encoding='utf-8')
print('inlined %d illustrations, %d lesson TOCs -> %s (%.1f MB)'
      % (count, len(re.findall(r'<nav class="lesson-toc">', page)), OUT, OUT.stat().st_size / 1e6))
