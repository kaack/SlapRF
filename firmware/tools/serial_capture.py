"""Read a board's USB serial console for a few seconds after a reset (bench smoke tests).

Usage: python serial_capture.py COM3 [seconds] [--no-reset] [--send TEXT]
"""
import sys
import time

import serial

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

port = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else 8.0
reset = "--no-reset" not in sys.argv
send = sys.argv[sys.argv.index("--send") + 1] if "--send" in sys.argv else None

# Configure the control lines before opening, so opening the port doesn't glitch reset/boot.
s = serial.Serial()
s.port = port
s.baudrate = 115200
s.timeout = 0.1
s.dtr = False
s.rts = False
s.open()
def set_rts(state):
    # Windows usbser.sys only sends the line state when DTR is written too (same as esptool).
    s.rts = state
    s.dtr = s.dtr


if reset:
    # esptool's hard reset for USB-Serial-JTAG: EN low for 200 ms with DTR low, then release.
    s.dtr = False
    set_rts(True)
    time.sleep(0.2)
    set_rts(False)
    time.sleep(0.05)
if send:
    time.sleep(1.5)
    s.write(send.encode().decode("unicode_escape").encode("latin-1"))

end = time.time() + seconds
buf = b""
while time.time() < end:
    buf += s.read(4096)
s.close()
text = buf.decode("utf-8", "replace")
print(text)
if send:
    i = buf.find(b"SLAPRF02")
    print(f"\n[SLAPRF02 block in reply at byte {i}]" if i >= 0 else "\n[no SLAPRF02 block in reply]")
    if i >= 0:
        print(buf[i:i + 160].hex())
