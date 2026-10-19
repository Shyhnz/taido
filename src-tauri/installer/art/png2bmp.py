"""Converts a PNG screenshot (8-bit RGB or RGBA, not interlaced) to a 24-bit BMP for NSIS.

Standard library only. Usage: python3 png2bmp.py in.png out.bmp
"""

import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    pos, idat = 8, b""
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    if depth != 8 or color not in (2, 6) or interlace:
        raise SystemExit(f"{path}: unsupported PNG (depth {depth}, color {color})")
    channels = 4 if color == 6 else 3
    raw = zlib.decompress(idat)
    stride = width * channels
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(height):
        kind, line = raw[i], bytearray(raw[i + 1 : i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = prev[x]
            up_left = prev[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + left) & 0xFF
            elif kind == 2:
                line[x] = (line[x] + up) & 0xFF
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - up_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
                pred = left if pa <= pb and pa <= pc else up if pb <= pc else up_left
                line[x] = (line[x] + pred) & 0xFF
        rows.append(line)
        prev = line
    return width, height, channels, rows


def write_bmp(path, width, height, channels, rows):
    pad = (4 - (width * 3) % 4) % 4
    pixels = bytearray()
    for line in reversed(rows):  # BMP rows go bottom-up
        for x in range(width):
            r, g, b = line[x * channels : x * channels + 3]
            if channels == 4:  # flatten on white
                a = line[x * channels + 3]
                r, g, b = ((c * a + 255 * (255 - a)) // 255 for c in (r, g, b))
            pixels += bytes((b, g, r))
        pixels += b"\0" * pad
    header = struct.pack("<2sIHHI", b"BM", 54 + len(pixels), 0, 0, 54)
    info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    open(path, "wb").write(header + info + pixels)


if __name__ == "__main__":
    write_bmp(sys.argv[2], *read_png(sys.argv[1]))
