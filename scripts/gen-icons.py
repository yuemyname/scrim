#!/usr/bin/env python3
"""
파비콘 래스터 생성기 — public/icon.svg(DESIGN.md §8 앱 아이콘)를 그대로 옮겨 그린다.
흰 배경 + 검정 라운드 베젤(#141414) + 중앙 파랑 원(#1f6bff).

외부 의존성 없이 동작해야 하므로(빌드 환경에 PIL/rsvg 없음) PNG·ICO 인코더를
직접 담고 있다. 도형이 단순해 SDF + 슈퍼샘플링으로 안티에일리어싱한다.

    python3 scripts/gen-icons.py

산출물: public/favicon.ico (16/32/48), public/favicon-16.png,
        public/favicon-32.png, public/favicon-48.png
"""

import math
import struct
import zlib
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / 'public'

WHITE = (0xFF, 0xFF, 0xFF)
INK = (0x14, 0x14, 0x14)
BLUE = (0x1F, 0x6B, 0xFF)

VIEW = 64.0  # icon.svg viewBox
SS = 8       # 축당 슈퍼샘플 수


def _rounded_rect_sdf(x, y, cx, cy, hx, hy, r):
    """라운드 사각형 경계까지의 부호 있는 거리 (내부가 음수)."""
    qx = abs(x - cx) - (hx - r)
    qy = abs(y - cy) - (hy - r)
    return min(max(qx, qy), 0.0) + math.hypot(max(qx, 0.0), max(qy, 0.0)) - r


def _sample(x, y):
    """단위 좌표(0..64) 한 점의 색. SVG의 그리기 순서를 그대로 따른다."""
    # <circle cx=32 cy=32 r=10 fill=#1f6bff> — 가장 위
    if math.hypot(x - 32.0, y - 32.0) <= 10.0:
        return BLUE
    # <rect x=6 y=6 w=52 h=52 rx=8 stroke=#141414 stroke-width=4>
    # 스트로크는 패스 중심 기준 ±2 폭을 차지한다
    if abs(_rounded_rect_sdf(x, y, 32.0, 32.0, 26.0, 26.0, 8.0)) <= 2.0:
        return INK
    return WHITE


def render(size):
    """size×size RGB 픽셀을 행 리스트로 반환."""
    scale = VIEW / size
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            r = g = b = 0
            for j in range(SS):
                y = (py + (j + 0.5) / SS) * scale
                for i in range(SS):
                    x = (px + (i + 0.5) / SS) * scale
                    sr, sg, sb = _sample(x, y)
                    r += sr
                    g += sg
                    b += sb
            n = SS * SS
            row.append((round(r / n), round(g / n), round(b / n)))
        rows.append(row)
    return rows


def _chunk(tag, data):
    return (
        struct.pack('>I', len(data))
        + tag
        + data
        + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # 필터 타입 None
        for r, g, b in row:
            raw += bytes((r, g, b))
    png = b'\x89PNG\r\n\x1a\n'
    png += _chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += _chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += _chunk(b'IEND', b'')
    path.write_bytes(png)
    return len(png)


def _ico_bmp_image(rows):
    """ICO에 담을 BMP(DIB) 이미지. PNG-in-ICO보다 호환 범위가 넓다."""
    size = len(rows)
    # 32bpp BGRA, 상하 반전(bottom-up)
    pixels = bytearray()
    for row in reversed(rows):
        for r, g, b in row:
            pixels += bytes((b, g, r, 0xFF))
    # AND 마스크 — 전부 불투명이라 0으로 채우되 행마다 4바이트 정렬
    mask_stride = ((size + 31) // 32) * 4
    mask = bytes(mask_stride * size)
    header = struct.pack(
        '<IiiHHIIiiII',
        40,             # biSize
        size,           # biWidth
        size * 2,       # biHeight (이미지 + 마스크)
        1,              # biPlanes
        32,             # biBitCount
        0,              # biCompression (BI_RGB)
        len(pixels) + len(mask),
        0, 0, 0, 0,
    )
    return header + bytes(pixels) + mask


def write_ico(path, sizes):
    images = [_ico_bmp_image(render(s)) for s in sizes]
    offset = 6 + 16 * len(images)
    out = struct.pack('<HHH', 0, 1, len(images))  # reserved, type=icon, count
    for s, img in zip(sizes, images):
        out += struct.pack(
            '<BBBBHHII',
            s if s < 256 else 0,  # width (0 = 256)
            s if s < 256 else 0,  # height
            0,                    # 팔레트 색 수 (0 = 미사용)
            0,                    # reserved
            1,                    # planes
            32,                   # bit count
            len(img),
            offset,
        )
        offset += len(img)
    out += b''.join(images)
    path.write_bytes(out)
    return len(out)


def main():
    for size in (16, 32, 48):
        n = write_png(PUBLIC / f'favicon-{size}.png', render(size))
        print(f'favicon-{size}.png  {n:>6} bytes')
    n = write_ico(PUBLIC / 'favicon.ico', (16, 32, 48))
    print(f'favicon.ico       {n:>6} bytes')


if __name__ == '__main__':
    main()
