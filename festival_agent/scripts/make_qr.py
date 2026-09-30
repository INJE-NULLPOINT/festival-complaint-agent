"""구역별 QR 코드와 인쇄용 시트를 만든다 (실사용자 검증 준비 · 할일 D6-4).

QR 은 웹 접수 화면(?v=qr)에 구역 id 를 붙인 주소를 담는다. 웹은 ?zone= 에
id·이름 둘 다 받는다 (web/src/views/report.ts presetZone). id 가 짧아 QR 이 작다.

    pip install segno                       # QR 생성 (순수 Python, 이 스크립트만 씀)
    python scripts/make_qr.py               # → ../제출_준비/qr/
    python scripts/make_qr.py --base http://192.168.0.24:5173

주소의 IP 는 `npm run dev -- --host` 를 띄운 PC 의 같은 Wi-Fi 주소다. 바뀌면 다시 만든다.
"""
import argparse
import html
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core import config, db  # noqa: E402

OUT = ROOT.parent / "제출_준비" / "qr"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://192.168.0.24:5173",
                    help="웹 개발 서버 주소 (같은 Wi-Fi 에서 폰이 접속할 주소)")
    args = ap.parse_args()
    try:
        import segno
    except ImportError:
        print("segno 가 없습니다: pip install segno")
        return 1

    db.init_db()
    OUT.mkdir(parents=True, exist_ok=True)
    cards = []
    for z in db.zones():
        url = f"{args.base.rstrip('/')}/?v=qr&zone={z['id']}"
        qr = segno.make(url, error="m")
        png = OUT / f"qr_{z['id']:02d}.png"
        qr.save(png, scale=12, border=4)
        cards.append((z["name"], url, png.name))
        print(f"  {png.name}  {z['name']}  {url}")

    festival = html.escape(config.FESTIVAL["name"])
    body = "\n".join(
        f"""  <figure>
    <img src="{png}" alt="{html.escape(name)} 접수 QR">
    <figcaption><b>{html.escape(name)}</b><span>{html.escape(url)}</span></figcaption>
  </figure>""" for name, url, png in cards)
    (OUT / "qr_sheet.html").write_text(f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>구역별 접수 QR</title>
<style>
  @page {{ size: A4; margin: 10mm; }}
  body {{ font-family: "Malgun Gothic", sans-serif; margin: 0; color: #111; background: #fff; }}
  header {{ text-align: center; margin: 4mm 0 6mm; }}
  header h1 {{ font-size: 20pt; margin: 0; }}
  header p {{ font-size: 11pt; margin: 2mm 0 0; }}
  main {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; }}
  figure {{ margin: 0; border: 1px dashed #888; padding: 3mm; text-align: center; break-inside: avoid; }}
  img {{ width: 100%; height: auto; }}
  figcaption b {{ display: block; font-size: 12pt; margin-top: 1mm; }}
  figcaption span {{ display: block; font-size: 7pt; color: #444; word-break: break-all; }}
  footer {{ font-size: 9pt; text-align: center; margin-top: 6mm; }}
</style></head>
<body>
<header><h1>{festival} 불편 신고</h1>
<p>휴대폰 카메라로 찍어 불편한 점을 한 줄로 알려 주세요. 이름·연락처는 받지 않습니다.</p></header>
<main>
{body}
</main>
<footer>점선을 따라 잘라 구역마다 붙이세요 · 주소: {html.escape(args.base)}</footer>
</body></html>
""", encoding="utf-8")
    print(f"→ {OUT / 'qr_sheet.html'} (A4 한 장, 브라우저에서 인쇄)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
