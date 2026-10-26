#!/usr/bin/env python3
"""Значки Mimikin из той же сетки 16×16, что и знак в интерфейсе (frontend/src/brandGrid.js).

Пиксельный знак рисуется клетками целого размера — без сглаживания, поэтому PNG собираются вручную,
без графических библиотек. Запуск из корня репозитория: python3 scripts/brand-icons.py
"""
import re
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'frontend' / 'public'
GOLD = (0xC9, 0xA8, 0x4C, 255)
INK = (0x0C, 0x0A, 0x0E, 255)
CLEAR = (0, 0, 0, 0)

source = (ROOT / 'frontend' / 'src' / 'brandGrid.js').read_text()
GRID = re.findall(r"'([.#]{16})'", source)
assert len(GRID) == 16, 'в brandGrid.js не нашлась сетка 16×16'


def png(path, size, cell, offset, radius):
    """Знак клетками по cell px со сдвигом offset на тёмной плитке со скруглением radius"""
    def inside_tile(x, y):
        # Скруглённые углы плитки: точка вне четверти круга в углу — прозрачная
        for cx, cy in ((radius, radius), (size - radius - 1, radius), (radius, size - radius - 1), (size - radius - 1, size - radius - 1)):
            if (x < radius or x > size - radius - 1) and (y < radius or y > size - radius - 1):
                if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2 and abs(x - cx) <= radius and abs(y - cy) <= radius:
                    if (x < radius) == (cx == radius) and (y < radius) == (cy == radius):
                        return False
        return True

    rows = []
    for y in range(size):
        row = bytearray([0])  # фильтр строки PNG: нет
        for x in range(size):
            gx, gy = (x - offset) // cell, (y - offset) // cell
            on_mark = 0 <= x - offset < cell * 16 and 0 <= y - offset < cell * 16 and GRID[gy][gx] == '#'
            row.extend(GOLD if on_mark else (INK if inside_tile(x, y) else CLEAR))
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
    path.write_bytes(data)
    print(f'{path.relative_to(ROOT)}  {size}×{size}')


def svg(path):
    runs = []
    for y, row in enumerate(GRID):
        for m in re.finditer(r'#+', row):
            runs.append(f'<rect x="{m.start()}" y="{y}" width="{m.end() - m.start()}" height="1"/>')
    path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
        '<rect width="16" height="16" rx="3" fill="#0c0a0e"/>'
        f'<g fill="#c9a84c">{"".join(runs)}</g></svg>\n')
    print(f'{path.relative_to(ROOT)}')


# Вкладка браузера: клетка = 1 и 2 пикселя, у знака по краю пустая клетка — в неё ложится скругление
png(PUBLIC / 'favicon-16.png', 16, 1, 0, 3)
png(PUBLIC / 'favicon.png', 32, 2, 0, 6)
svg(PUBLIC / 'favicon.svg')
# Домашний экран: знак примерно на три четверти плитки. iOS скругляет углы сам — плитка квадратная
png(PUBLIC / 'apple-touch-icon.png', 180, 10, 10, 0)
png(PUBLIC / 'icon-192.png', 192, 10, 16, 0)
png(PUBLIC / 'icon-512.png', 512, 26, 48, 0)
