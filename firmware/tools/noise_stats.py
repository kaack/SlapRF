"""Noise / hit statistics per pilot channel from the Debug console (LIVE 2 = every sweep).

Usage: python noise_stats.py COM3 [seconds]
Prints per channel: mean / spread / max reading, the firmware's floor, hits per second
(readings > floor + 10 dB), and how often readings reach -80 / -70 / -58 dBm (the default
enter threshold). Also checks the sweep counter for dropped lines.
"""
import json
import statistics as st
import sys
import time

import serial

port = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 15
s = serial.Serial()
s.port = port
s.baudrate = 115200
s.timeout = 0.1
s.dtr = False
s.rts = False
s.open()
s.write(b"LIVE 2\n")
end = time.time() + seconds
buf = b""
while time.time() < end:
    buf += s.read(16384)
s.write(b"LIVE 0\n")
s.close()

rows = [json.loads(l[1:]) for l in buf.decode("utf-8", "replace").splitlines() if l.startswith('@{"t":"live"')][5:]
if not rows:
    sys.exit("no live lines")
ns = [r["n"] for r in rows]
dropped = sum(b - a - 1 for a, b in zip(ns, ns[1:]) if b > a + 1)
dur = (ns[-1] - ns[0]) / 50
print(f"{len(rows)} lines over {dur:.1f} s ({len(rows) / max(dur, 0.1):.1f}/s), {dropped} dropped, sweep {st.mean(r['us'] for r in rows) / 1000:.2f} ms avg, {max(r['us'] for r in rows) / 1000:.2f} ms max")
names = ["R1 5658", "R2 5695", "R3 5732", "R4 5769", "R5 5806", "R6 5843", "R7 5880", "R8 5917"]
for i, n in enumerate(names):
    d = [r["dbm"][i] for r in rows]
    fl = rows[-1]["floor"][i]
    hits = sum(r["hits"][i] for r in rows)
    print(
        f"{n}: mean {st.mean(d):6.1f} sd {st.pstdev(d):3.1f} max {max(d):4d} floor {fl:4d} | "
        f"hits/s {hits / dur:4.1f} | >=-80 {sum(v >= -80 for v in d) / dur:4.1f}/s  >=-70 {sum(v >= -70 for v in d) / dur:4.1f}/s  >=-58 {sum(v >= -58 for v in d) / dur:4.1f}/s"
    )
