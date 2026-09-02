#!/usr/bin/env python3
"""Create a virtual serial device and stream repeatable BaudTide telemetry.

The script uses only the Python standard library. Run it, copy the printed
``/dev/pts/N`` path into BaudTide, and stop it with Ctrl-C when finished.
Anything BaudTide sends back to the virtual device is printed to the terminal.

Pass ``2`` to emit anonymous, comma-separated numeric columns. That mode is
intended for testing BaudTide custom decoder profiles.
"""

from __future__ import annotations

import argparse
import errno
import json
import math
import os
import pty
import select
import signal
import sys
import termios
import time
import tty
from threading import Event


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream dummy telemetry through a virtual serial port."
    )
    parser.add_argument(
        "mode",
        nargs="?",
        choices=("1", "2"),
        default="1",
        help="1: named JSON telemetry (default); 2: anonymous numeric columns for custom decoder testing",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.35,
        help="seconds between samples (default: 0.35)",
    )
    return parser.parse_args()


def sample_values(tick: int, elapsed: float) -> dict[str, float | int]:
    return {
        "temperature": round(23.5 + 2.8 * math.sin(elapsed / 8.0), 2),
        "humidity": round(44.0 + 8.5 * math.sin(elapsed / 11.0 + 0.7), 2),
        "voltage": round(3.30 + 0.08 * math.sin(elapsed / 5.0 + 1.1), 3),
        "rpm": round(1000 + 125 * math.sin(elapsed / 4.5), 1),
        "tick": tick,
    }


def sample(tick: int, elapsed: float, mode: str) -> bytes:
    values = sample_values(tick, elapsed)
    if mode == "2":
        # Deliberately emit no prefix or header. Automatic detection ignores
        # these anonymous columns; a custom comma decoder can map columns 1–5.
        return (
            f"{values['temperature']},{values['humidity']},{values['voltage']},"
            f"{values['rpm']},{values['tick']}\n"
        ).encode()
    return (json.dumps(values, separators=(",", ":")) + "\n").encode()


def write_all(fd: int, payload: bytes, stop: Event) -> bool:
    offset = 0
    while offset < len(payload):
        if stop.is_set():
            return False
        try:
            offset += os.write(fd, payload[offset:])
        except BlockingIOError:
            select.select([], [fd], [], 1.0)
        except OSError as error:
            if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                raise
    return True


def configure_raw(fd: int) -> None:
    tty.setraw(fd)
    attributes = termios.tcgetattr(fd)
    attributes[2] |= termios.CLOCAL | termios.CREAD
    termios.tcsetattr(fd, termios.TCSANOW, attributes)


def main() -> int:
    args = parse_args()
    if args.interval <= 0:
        print("--interval must be greater than zero", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    configure_raw(slave_fd)
    os.set_blocking(master_fd, False)
    port = os.ttyname(slave_fd)
    stop = Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    print(f"BAUDTIDE_PORT={port}", flush=True)
    print(f"Open {port} at 115200 baud in BaudTide.", flush=True)
    if args.mode == "2":
        print(
            "Streaming anonymous comma-separated columns: temperature, humidity, voltage, rpm, tick. "
            "Use a custom decoder with comma separation and columns 1–5. Ctrl-C stops it.",
            flush=True,
        )
    else:
        print("Streaming JSON temperature, humidity, voltage, rpm, and tick. Ctrl-C stops it.", flush=True)

    started = time.monotonic()
    next_sample = started
    tick = 0
    try:
        while not stop.is_set():
            now = time.monotonic()
            timeout = max(0.0, min(0.1, next_sample - now))
            readable, _, _ = select.select([master_fd], [], [], timeout)
            if readable:
                try:
                    received = os.read(master_fd, 4096)
                except BlockingIOError:
                    received = b""
                if received:
                    print(f"BaudTide sent: {received!r}", flush=True)

            now = time.monotonic()
            if now >= next_sample:
                if not write_all(master_fd, sample(tick, now - started, args.mode), stop):
                    break
                tick += 1
                next_sample += args.interval
                if next_sample < now - args.interval:
                    next_sample = now + args.interval
    except (BrokenPipeError, OSError) as error:
        if not stop.is_set():
            print(f"Virtual serial port stopped: {error}", file=sys.stderr)
            return 1
    finally:
        os.close(master_fd)
        os.close(slave_fd)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
