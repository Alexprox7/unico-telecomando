"""Convert Flipper-IRDB .ir files into OpenBeken IRSend strings (Arduino-IRremote driver).

Usage: python -I build_library.py <Flipper-IRDB dir> <assets/lib output dir>
Writes index.json (catalog + protocol:address keys for model identification)
and one JSON chunk per category/brand with {model: [[button, irsend], ...]}.
"""
import json, os, re, sys

KASEIKYO_VENDORS = {0x2002: "PANASONIC", 0x3254: "KASEIKYO_DENON", 0x5AAA: "KASEIKYO_SHARP",
                    0x0103: "KASEIKYO_JVC", 0xCB23: "KASEIKYO_MITSUBISHI"}
SONY_BITS = {"SIRC": 12, "SIRC15": 15, "SIRC20": 20}


def le(hexbytes):
    """Flipper stores values as little-endian byte strings: '04 00 00 00' -> 4."""
    return int.from_bytes(bytes(int(b, 16) for b in hexbytes.split()), "little")


def nec_key(addr16):
    """Same normalisation the receiver uses: 8-bit address when the high byte is its inverse."""
    lo, hi = addr16 & 0xFF, addr16 >> 8
    return lo if hi == (~lo & 0xFF) else addr16


def convert(proto, addr, cmd):
    """Return (irsend_string, identify_key) or None if the firmware cannot send it."""
    if proto == "NEC":
        a, c = addr & 0xFF, cmd & 0xFF
        return f"NEC-{a:X}-{c:X}", f"NEC:{a:X}"
    if proto == "NECext":
        a16, c16 = addr & 0xFFFF, cmd & 0xFFFF
        lo, hi = c16 & 0xFF, c16 >> 8
        if a16 > 0xFF and hi == (~lo & 0xFF):
            code = f"NEC-{a16:X}-{lo:X}"
        else:  # Onkyo = NEC timing with raw 16-bit address and command, sends any NECext frame exactly
            code = f"ONKYO-{a16:X}-{c16:X}"
        return code, f"NEC:{nec_key(a16):X}"
    if proto == "Samsung32":
        a, c = addr & 0xFF, cmd & 0xFF
        return f"SAMSUNG-{a | a << 8:X}-{c:X}", f"SAMSUNG:{a | a << 8:X}"
    if proto in ("RC5", "RC5X"):
        a, c = addr & 0x1F, cmd & 0x3F
        if proto == "RC5X":
            c |= 0x40  # firmware clears the field bit for commands >= 0x40
        return f"RC5-{a:X}-{c:X}", f"RC5:{a:X}"
    if proto == "RC6":
        return f"RC6-{addr & 0xFF:X}-{cmd & 0xFF:X}", f"RC6:{addr & 0xFF:X}"
    if proto in SONY_BITS:
        bits = SONY_BITS[proto]
        # repeats=2 -> 3 frames, Sony devices ignore single frames; bits field is parsed as hex
        return f"SONY-{addr:X}-{cmd & 0x7F:X}-2-{bits:X}", f"SONY:{addr:X}"
    if proto == "Kaseikyo":
        vendor = (addr >> 8) & 0xFFFF
        name = KASEIKYO_VENDORS.get(vendor)
        if not name:
            return None
        genre1, genre2, ident = (addr >> 4) & 0xF, addr & 0xF, (addr >> 24) & 3
        a12 = genre1 | genre2 << 4 | (cmd & 0xF) << 8
        c8 = ident << 6 | (cmd >> 4) & 0x3F
        return f"{name}-{a12:X}-{c8:X}", f"{name}:{a12 & 0xFF:X}"
    return None  # NEC42, RCA, Pioneer, raw...: not sendable by this firmware


def near(v, target, tol=0.35):
    return abs(v - target) <= target * tol


def pd_bits(d, i, n, mark, zero, one):
    """Read n pulse-distance bits (LSB first per byte) from durations d starting at mark index i."""
    if i + 2 * n > len(d):
        return None
    bits = []
    for k in range(n):
        m, s = d[i + 2 * k], d[i + 2 * k + 1]
        if not near(m, mark):
            return None
        if near(s, zero):
            bits.append(0)
        elif near(s, one):
            bits.append(1)
        else:
            return None
    return bytes(sum(b << j for j, b in enumerate(bits[x:x + 8])) for x in range(0, n, 8))


def ends(d, i):
    """True when the frame stops at index i (stop mark), i.e. nothing or a long gap follows it.
    Rejects longer frames such as Gree/Daikin AC that merely start like NEC."""
    return i < len(d) and (i + 1 >= len(d) or d[i + 1] > 7000)


def decode_raw(d):
    """Recognise common protocols in a raw capture -> (flipper_protocol, address, command) or None."""
    if len(d) < 20:
        return None
    h0, h1 = d[0], d[1]
    if near(h0, 9000, .2) and near(h1, 4500, .2) and len(d) >= 66:  # NEC family
        b = pd_bits(d, 2, 32, 560, 560, 1690) if ends(d, 66) else None
        if not b:
            return None
        a0, a1, c0, c1 = b
        if a1 == (~a0 & 0xFF) and c1 == (~c0 & 0xFF):
            return "NEC", a0, c0
        return "NECext", a0 | a1 << 8, c0 | c1 << 8
    if near(h0, 4500, .2) and near(h1, 4500, .2) and len(d) >= 66:  # Samsung32
        b = pd_bits(d, 2, 32, 560, 560, 1690) if ends(d, 66) else None
        if b and b[0] == b[1] and b[3] == (~b[2] & 0xFF):
            return "Samsung32", b[0], b[2]
        return None
    if near(h0, 3500, .2) and near(h1, 1750, .2) and len(d) >= 98:  # Kaseikyo 48 bit
        b = pd_bits(d, 2, 48, 432, 432, 1296) if ends(d, 98) else None
        if not b or b[5] != b[2] ^ b[3] ^ b[4]:
            return None
        vendor, genre1, genre2 = b[0] | b[1] << 8, b[2] >> 4, b[3] & 0xF
        cmd, ident = (b[3] >> 4) | (b[4] & 0x3F) << 4, b[4] >> 6
        return "Kaseikyo", ident << 24 | vendor << 8 | genre1 << 4 | genre2, cmd
    if near(h0, 2400, .2) and near(h1, 600, .3):  # Sony: pulse width, LSB first
        bits, k, stopped = [], 2, False
        while k < len(d) and len(bits) < 21:
            m = d[k]
            if near(m, 1200, .3):
                bits.append(1)
            elif near(m, 600, .3):
                bits.append(0)
            else:
                return None
            gap = d[k + 1] if k + 1 < len(d) else 100000
            k += 2
            if gap > 2000:
                stopped = True
                break
        if not (stopped or k >= len(d)) or len(bits) not in (12, 15, 20):
            return None
        v = sum(b << j for j, b in enumerate(bits))
        return {12: "SIRC", 15: "SIRC15", 20: "SIRC20"}[len(bits)], v >> 7, v & 0x7F
    return None


MAX_RAW_US = 1_900_000  # Android ConsumerIrManager refuses patterns longer than 2 s


def parse_ir(text):
    sig = {}
    for line in text.splitlines() + ["#"]:
        line = line.strip()
        if line.startswith("#"):
            if sig.get("name") and (sig.get("type") == "parsed" and {"protocol", "address", "command"} <= sig.keys()
                                    or sig.get("type") == "raw" and "data" in sig):
                yield sig
            sig = {}
            continue
        k, _, v = line.partition(":")
        if v and k.strip() in ("name", "type", "protocol", "address", "command", "frequency", "data"):
            sig[k.strip()] = v.strip()


def raw_code(sig):
    """'RAW:<freq>:<durations>' for the phone blaster; capped at 2 s and an even (mark/space) count."""
    try:
        d = [abs(int(x)) for x in sig["data"].split()]
        freq = int(float(sig.get("frequency", "38000")))
    except ValueError:
        return None, None
    out, total = [], 0
    for x in d:
        if total + x > MAX_RAW_US:
            break
        out.append(x)
        total += x
    if len(out) % 2 == 0 and out:
        out.pop()  # must end on a mark
    return (f"RAW:{freq}:" + ",".join(map(str, out)) if len(out) > 2 else None), d


CATEGORY_WORDS = [  # first match wins; applied to converted-archive device names
    ("ACs", r"air.?con|aircon|\bac\b|climat|split|a/c"),
    ("Projectors", r"project|beamer"),
    ("Blu-Ray", r"blu.?ray|\bbd"),
    ("DVD_Players", r"dvd"),
    ("Cable_Boxes", r"sat|cable|stb|set.?top|dvb|decoder|freeview|tivo|\bbox|dta|converter"),
    ("SoundBars", r"sound.?bar"),
    ("Audio_and_Video_Receivers", r"audio|amp|receiver|\bav|hifi|hi-fi|stereo|tuner|\bcd|speaker|home.?theat"),
    ("TVs", r"\btv|television|lcd|plasma|\bled|monitor"),
    ("Fans", r"\bfan"),
    ("LED_Lighting", r"light|lamp"),
    ("Streaming_Devices", r"media|stream|roku|apple"),
]


def guess_category(name):
    n = name.lower().replace("_", " ")
    for cat, pat in CATEGORY_WORDS:
        if re.search(pat, n):
            return cat
    return "Archive"


def safe(s):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)


def self_check():
    assert convert("NEC", 0x04, 0x08) == ("NEC-4-8", "NEC:4")
    assert convert("NECext", 0x0586, 0xF00F) == ("NEC-586-F", "NEC:586")
    assert convert("NECext", 0x00BF, 0x1234)[0] == "ONKYO-BF-1234"
    assert convert("NECext", 0xFB04, 0xF708)[1] == "NEC:4"  # inverted 16-bit address == plain NEC 4
    assert convert("Samsung32", 0x07, 0x02) == ("SAMSUNG-707-2", "SAMSUNG:707")
    assert convert("RC5X", 0x00, 0x0C)[0] == "RC5-0-4C"
    assert convert("SIRC", 0x01, 0x15)[0] == "SONY-1-15-2-C"
    assert convert("SIRC20", 0x1A3, 0x15)[0] == "SONY-1A3-15-2-14"
    # Panasonic TV power: Flipper address 80 02 20 00 / command D0 03 == Arduino Panasonic 0x8 / 0x3D
    assert convert("Kaseikyo", le("80 02 20 00"), le("D0 03 00 00"))[0] == "PANASONIC-8-3D"
    assert convert("RCA", 1, 2) is None

    def pd(header, data, mark, zero, one):  # synthesize a pulse-distance capture, LSB first
        out = list(header)
        for byte in data:
            for j in range(8):
                out += [mark, one if byte >> j & 1 else zero]
        return out + [mark]
    # NEC addr 4 cmd 8, with a little jitter like a real capture
    nec = [x + 23 for x in pd([9000, 4500], [0x04, 0xFB, 0x08, 0xF7], 560, 560, 1690)]
    assert decode_raw(nec) == ("NEC", 4, 8)
    assert decode_raw(pd([9000, 4500], [0x86, 0x05, 0x0F, 0xF0], 560, 560, 1690)) == ("NECext", 0x0586, 0xF00F)
    assert decode_raw(pd([4500, 4500], [7, 7, 2, 0xFD], 560, 560, 1690)) == ("Samsung32", 7, 2)
    # Panasonic TV power raw == the parsed Flipper value checked above
    pan = pd([3500, 1750], [0x02, 0x20, 0x80, 0x00, 0x3D, 0x80 ^ 0x00 ^ 0x3D], 432, 432, 1296)
    assert convert(*decode_raw(pan))[0] == "PANASONIC-8-3D"
    sony = [2400, 600] + sum(([1200 if (0x15 | 1 << 7) >> j & 1 else 600, 600] for j in range(12)), [])
    assert convert(*decode_raw(sony))[0] == "SONY-1-15-2-C"
    assert decode_raw([3000, 3000] + [500] * 60) is None  # unknown (e.g. AC) stays raw
    # Gree AC: NEC-like header + 32 bits, then '010' + 20 ms + 32 more bits -> must stay raw
    gree = pd([9000, 4500], [0x09, 0x08, 0x20, 0x50], 620, 540, 1600)[:-1] + [620, 540, 620, 1600, 620, 540, 620, 19980]
    gree += pd([], [0x00, 0x20, 0x00, 0x80], 620, 540, 1600)
    assert decode_raw(gree) is None
    assert decode_raw(nec + [40000] + nec[:3]) == ("NEC", 4, 8)  # repeat after a long gap is fine
    assert raw_code({"data": "100 200 300 400", "frequency": "38000"})[0] == "RAW:38000:100,200,300"


def main(src, out):
    self_check()
    os.makedirs(out, exist_ok=True)
    index, chunks = [], {}
    total = ok = 0
    stats = {"decoded": 0, "raw": 0}
    spelling = {}  # one display spelling per brand (curated folders win over converted archives)
    walk = sorted(os.walk(src), key=lambda w: os.path.relpath(w[0], src).startswith("_Converted_"))
    for root, _, files in walk:
        rel = os.path.relpath(root, src).split(os.sep)
        if rel[0] == "." or rel[0].startswith("."):
            continue
        for fn in sorted(files):
            if not fn.endswith(".ir"):
                continue
            if rel[0] == "_Converted_":
                # _Converted_/<source>/<A..Z|0-9>/<Brand>/<device...>: no categories, guess from the device name
                if len(rel) < 3:
                    continue
                b_at = 3 if len(rel) > 3 and len(rel[2]) <= 3 else 2
                brand = rel[b_at]
                model = "/".join(rel[b_at + 1:] + [fn[:-3]])
                cat = guess_category(model)
            else:
                cat = rel[0]
                brand = rel[1] if len(rel) > 1 else "Generic"
                model = "/".join(rel[2:] + [fn[:-3]])
            brand = spelling.setdefault(brand.strip().lower(), brand.strip())
            with open(os.path.join(root, fn), encoding="utf-8", errors="replace") as f:
                sigs = list(parse_ir(f.read()))
            buttons, keys, seen, n_s18 = [], set(), set(), 0
            for s in sigs:
                total += 1
                r = None
                try:
                    if s["type"] == "parsed":
                        r = convert(s["protocol"], le(s["address"]), le(s["command"]))
                    else:
                        _, dur = raw_code(s)
                        dec = decode_raw(dur) if dur else None
                        r = convert(*dec) if dec else None
                        if dec:
                            stats["decoded"] += 1
                except ValueError:
                    r = None
                if r:  # sendable by the S18 and (encoded) by the phone
                    code = r[0]
                    keys.add(r[1])
                    n_s18 += 1
                else:  # phone only
                    code = raw_code(s)[0] if s["type"] == "raw" else None
                    if not code:
                        continue
                    stats["raw"] += 1
                ok += 1
                if (s["name"], code) in seen:
                    continue
                seen.add((s["name"], code))
                buttons.append([s["name"][:40], code])
            if not buttons:
                continue
            chunk = safe(f"{cat}__{brand}").lower() + ".json"  # case-insensitive filesystems
            chunks.setdefault(chunk, {})[model] = buttons
            index.append([cat, brand, model, chunk, len(buttons), sorted(keys), n_s18])
    for name, data in chunks.items():
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"models {len(index)}, chunks {len(chunks)}, signals {ok}/{total} usable, "
          f"raw decoded for S18 {stats['decoded']}, phone-only raw {stats['raw']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
