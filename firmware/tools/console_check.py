"""Exercise the timer's USB debug console (bench check for the Debug page protocol)."""
import json
import sys
import time

import serial

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
s = serial.Serial()
s.port = sys.argv[1]
s.baudrate = 115200
s.timeout = 0.1
s.dtr = False
s.rts = False
s.open()


def run(cmd, seconds):
    if cmd:
        s.write((cmd + "\n").encode())
    end = time.time() + seconds
    buf = b""
    while time.time() < end:
        buf += s.read(4096)
    return buf


def lines(buf):
    return [l for l in buf.decode("utf-8", "replace").splitlines() if l.strip()]


print("== STATUS?")
for l in lines(run("STATUS?", 1.0)):
    if l.startswith("@"):
        print(json.dumps(json.loads(l[1:]), indent=None))
    else:
        print("text:", l[:120])

print("== LIVE 1 (2 s)")
ls = [l for l in lines(run("LIVE 1", 2.0)) if l.startswith("@")]
print(f"{len(ls)} lines; first: {ls[1] if len(ls) > 1 else ls}")
run("LIVE 0", 0.3)

print("== SCAN 5180 5917 5")
t0 = time.time()
buf = run("SCAN 5180 5917 5", 3.0)
for l in lines(buf):
    if l.startswith('@{"t":"scan"'):
        d = json.loads(l[1:])
        pts = d["dbm"]
        peak = max(range(len(pts)), key=lambda i: pts[i])
        print(f"{len(pts)} points, start {d['start']} step {d['step']}, peak {d['start'] + peak * d['step']} MHz {pts[peak]} dBm, min {min(pts)}")
        # coarse text plot, 20 MHz buckets
        row = []
        for i in range(0, len(pts), 4):
            row.append(f"{d['start'] + i * d['step']}:{max(pts[i:i + 4])}")
        print(" ".join(row))
    elif l.startswith("@"):
        print(l[:200])

print("== LOG 1 (3 s)")
ls = lines(run("LOG 1", 3.0))
print(f"{len(ls)} lines: {ls[:4]}")
run("LOG 0", 0.3)

print("== SLAPRF?")
buf = run("SLAPRF?", 0.8)
i = buf.find(b"SLAPRF02")
print("config block at", i, buf[i:i + 20].hex() if i >= 0 else "")

print("== bad command")
print(lines(run("FOO", 0.5)))


def first_json(buf, t):
    for l in lines(buf):
        if l.startswith('@{"t":"%s"' % t):
            return json.loads(l[1:])
    return None


print("== BOOTLOG? / LASTLOG?")
for cmd in ("BOOTLOG?", "LASTLOG?"):
    d = first_json(run(cmd, 1.0), "bootlog")
    if d:
        text = d["text"].splitlines()
        print(f"{cmd} which={d['which']} boots={d['boots']} reset={d['reset']} {len(d['text'])} bytes, {len(text)} lines")
        for l in text[-3:]:
            print("   ", l[:120])
    else:
        print(cmd, "NO REPLY")

print("== CHANNELS (temporary) / hits")
print(lines(run("CHANNELS 5180,5200,5220,5240,5260,5280,5300,5320", 0.5)))
st = first_json(run("STATUS?", 0.8), "status")
print("freqs", st and st["freqs"], "temporary", st and st["freqsTemporary"])
ls = [json.loads(l[1:]) for l in lines(run("LIVE 1", 1.5)) if l.startswith('@{"t":"live"')]
run("LIVE 0", 0.3)
print("live dbm", ls[-1]["dbm"] if ls else None, "hits", ls[-1].get("hits") if ls else None)
print(lines(run("CHANNELS 1,2,3", 0.5)))
print(lines(run("CHANNELS RESET", 0.5)))
st = first_json(run("STATUS?", 0.8), "status")
print("freqs", st and st["freqs"], "temporary", st and st["freqsTemporary"])

print("== RF 0 / RF 1")
print(lines(run("RF 0", 0.5)))
ls = [json.loads(l[1:]) for l in lines(run("LIVE 1", 1.0)) if l.startswith('@{"t":"live"')]
run("LIVE 0", 0.3)
print("live while off", ls[-1]["dbm"] if ls else None)
print(lines(run("SCAN 5180 5917 5", 0.5)))
st = first_json(run("STATUS?", 0.8), "status")
print("rf", st and st["rf"])
print(lines(run("RF 1", 0.5)))
st = first_json(run("STATUS?", 0.8), "status")
print("rf", st and st["rf"], "chip", st and st.get("chip"), "net", st and st.get("net"),
      "boots", st and st.get("boots"), "budget", st and st.get("sweepBudgetUs"))
s.close()
