"""제출본 다시 만들기: md 원본 → docx → PDF(Word), 쪽수 출력.

    python 제출_준비/최종/_build_docs.py            # 완료보고서·기술설명서 둘 다
    python 제출_준비/최종/_build_docs.py report     # 하나만 (report | tech | source)

- 원본: 제출_준비/완료보고서.md, 기술설명서.md, 출처신고서.md (이 파일을 고친 뒤 다시 돌린다)
- <!-- --> 주석(근거 경로)과 숫자 마커는 빠지고 마커 안의 값만 남는다.
- [사용자 입력…]·[final_check 후 갱신] 은 노란 형광으로 남는다.
- PDF 변환은 이 PC의 Microsoft Word(COM)를 쓴다.
"""
import re
import subprocess
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

HERE = Path(__file__).resolve().parent
SRC = HERE.parent
FONT = "맑은 고딕"

CONF = {
    "report": dict(src=SRC / "완료보고서.md", out=HERE / "완료보고서_철철철.docx", size=10.5, margin=18, line=1.15, img_mm=174),
    "tech": dict(src=SRC / "기술설명서.md", out=HERE / "기술설명서_철철철.docx", size=9.5, margin=10, line=1.0, img_mm=0),
    "source": dict(src=SRC / "출처신고서.md", out=HERE / "출처신고서_철철철.docx", size=10, margin=18, line=1.15, img_mm=0),
}
COVER = ["팀명: 철철철", "부문: 대학부", "지정분야: ⑤ 경남 지역혁신·공공서비스 AI Agent", "팀원: 강은진(대표) · 김동우 (인제대학교)", "2026. 10."]
MARK = re.compile(r"(\*\*[^*]+\*\*|\[사용자 입력[^\]]*\]|\[final_check 후 갱신\])")


def set_font(run, size, bold=False, mono=False):
    run.font.size = Pt(size)
    run.font.bold = bold
    name = "Consolas" if mono else FONT
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.append(fonts)
    for k in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        fonts.set(qn(k), FONT if (k == "w:eastAsia") else name)


def add_runs(p, text, size, bold=False):
    text = re.sub(r"`([^`]*)`", r"\1", text).replace("<br>", " / ")
    for part in MARK.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            set_font(p.add_run(part[2:-2]), size, True)
        elif part.startswith("["):
            r = p.add_run(part)
            set_font(r, size, bold)
            r.font.highlight_color = WD_COLOR_INDEX.YELLOW
        else:
            set_font(p.add_run(part), size, bold)


def fmt(p, after=2, line=1.15, keep=False):
    pf = p.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    pf.keep_with_next = keep


def shade(cell, fill="EDEDED"):
    tcpr = cell._element.get_or_add_tcPr()
    s = OxmlElement("w:shd")
    s.set(qn("w:val"), "clear"); s.set(qn("w:color"), "auto"); s.set(qn("w:fill"), fill)
    tcpr.append(s)


def add_table(doc, rows, c, tech, text_w):
    cells = [[x.strip() for x in r.strip().strip("|").split("|")] for r in rows]
    n = max(len(r) for r in cells)
    if tech:
        widths = [text_w * 0.17, text_w * 0.83]
    else:
        lens = [max(min(len(r[i]) if i < len(r) else 0, 60) for r in cells) + 4 for i in range(n)]
        widths = [text_w * l / sum(lens) for l in lens]
    t = doc.add_table(rows=len(cells), cols=n)
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    size = c["size"] - (0 if tech else 0.5)
    for ri, r in enumerate(cells):
        for i in range(n):
            cell = t.cell(ri, i)
            cell.width = Mm(widths[i])
            head = (i == 0) if tech else (ri == 0)
            if head:
                shade(cell)
            txt = r[i] if i < len(r) else ""
            parts = re.split(r" / (?=[-①②③④⑤⑥⑦]|\d\))", txt) if tech else txt.split("<br>")
            for k, part in enumerate(parts):
                p = cell.paragraphs[0] if k == 0 else cell.add_paragraph()
                fmt(p, 0, 1.0, ri == 0 and not tech)
                add_runs(p, part, size, head)
    gap = doc.add_paragraph()
    fmt(gap, 0, 1.0)
    set_font(gap.add_run(""), 1 if tech else 6)
    gap.paragraph_format.line_spacing = Pt(1) if tech else 1.0


def build(kind):
    c = CONF[kind]
    tech = kind == "tech"
    src = c["src"].read_text(encoding="utf-8").replace("\r\n", "\n")
    src = re.sub(r"<!--[\s\S]*?-->", "", src)
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    for side in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(sec, side, Mm(c["margin"]))
    text_w = 210 - 2 * c["margin"]
    size = c["size"]

    if kind == "report":  # 표지
        p = doc.add_paragraph(); fmt(p, 0); p.paragraph_format.space_before = Pt(150)
        for text, sz, b, after in [("제4회 경남 AI·SW 경진대회", 14, False, 14), ("개발완료보고서", 26, True, 28), ("실시간 축제 민원 관제 AI Agent", 18, True, 110)]:
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fmt(p, after); set_font(p.add_run(text), sz, b)
        for text in COVER:
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fmt(p, 8); set_font(p.add_run(text), 13)
        p.add_run().add_break(WD_BREAK.PAGE)

    lines = src.split("\n")
    i, skip = 0, kind == "report"
    while i < len(lines):
        l = lines[i]
        if l.startswith("# "):
            if kind != "report":
                title = "AI Agent 기술설명서" if tech else l[2:]
                p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fmt(p, 4); set_font(p.add_run(title), 13, True)
            i += 1; continue
        if skip:  # 보고서: 첫 '---' 까지는 표지로 대신
            skip = l.strip() != "---"; i += 1; continue
        if l.startswith("## "):
            p = doc.add_paragraph(); fmt(p, 3, 1.0, True); p.paragraph_format.space_before = Pt(8)
            set_font(p.add_run(l[3:]), size + 2.5, True); i += 1; continue
        if l.startswith("### "):
            p = doc.add_paragraph(); fmt(p, 2, 1.0, True); p.paragraph_format.space_before = Pt(5)
            set_font(p.add_run(l[4:]), size + 0.5, True); i += 1; continue
        if l.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                if not re.fullmatch(r"\|[\s|:-]+\|", lines[i].strip()):
                    rows.append(lines[i])
                i += 1
            add_table(doc, rows, c, tech, text_w); continue
        if l.startswith("```"):
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                p = doc.add_paragraph(); fmt(p, 0, 1.0, True); set_font(p.add_run(lines[i] or " "), size - 1.5, mono=True)
                i += 1
            i += 1; continue
        m = re.match(r"!\[[^\]]*\]\(([^)]+)\)", l)
        if m:
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fmt(p, 2, 1.0)
            p.add_run().add_picture(str(SRC / m.group(1)), width=Mm(c["img_mm"]))
            i += 1; continue
        if l.strip() == "---" or l.startswith("> ") or not l.strip():
            i += 1; continue
        if l.startswith("- "):
            p = doc.add_paragraph(style="List Bullet"); fmt(p, 1, c["line"]); add_runs(p, l[2:], size)
            i += 1; continue
        p = doc.add_paragraph(); fmt(p, 3, c["line"]); add_runs(p, l, size)
        i += 1
    doc.save(c["out"])
    return c["out"]


def to_pdf(paths):
    files = ",".join("'" + str(p).replace("'", "''") + "'" for p in paths)
    ps = (
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $w = New-Object -ComObject Word.Application; $w.Visible = $false; try { "
        f"foreach ($f in @({files})) {{ $d = $w.Documents.Open($f, $false, $true); $n = $d.ComputeStatistics(2); "
        "$pdf = [System.IO.Path]::ChangeExtension($f, '.pdf'); $d.SaveAs2($pdf, 17); $d.Close($false); "
        "Write-Output \"$n`t$pdf\" } } finally { $w.Quit() }"
    )
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(out.stdout.strip() or out.stderr.strip())


if __name__ == "__main__":
    kinds = sys.argv[1:] or ["report", "tech", "source"]
    to_pdf([build(k) for k in kinds])
