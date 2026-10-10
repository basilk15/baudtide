"""An isolated PTY fixture for the desktop smoke server; never touches hardware."""
import json
import os
import pty
import select
import sys
import time
import tty

master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)
temperature = 20.0
sequence = 0
next_emit = time.monotonic()
while True:
    readable, _, _ = select.select([sys.stdin, master], [], [], 0.02)
    if sys.stdin in readable:
        line = sys.stdin.readline()
        if not line:
            break
        command = json.loads(line)
        if 'temperature' in command:
            temperature = float(command['temperature'])
        if command.get('burst'):
            count = int(command['burst'])
            for i in range(count):
                os.write(master, (json.dumps({'temperature': temperature, 'voltage': 3.3, 'tick': sequence}) + '\n').encode())
                sequence += 1
        if command.get('stop'):
            break
    if master in readable:
        data = os.read(master, 65536)
        print(json.dumps({'receivedHex': data.hex()}), flush=True)
    if time.monotonic() >= next_emit:
        os.write(master, (json.dumps({'temperature': temperature, 'voltage': 3.3, 'tick': sequence}) + '\n').encode())
        sequence += 1
        next_emit = time.monotonic() + 0.1
os.close(master)
os.close(slave)
