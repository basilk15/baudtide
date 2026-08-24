#!/usr/bin/env python3
"""Stream one or all supported telemetry shapes through a virtual serial port.

Run this helper, copy the printed PTY path into BaudTide, and open Visualize.
The default stream emits five records for each format in sequence, which is
enough to exercise format detection while keeping the run easy to inspect.
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
import termios
import time
import tty
from threading import Event


FORMAT_NAMES = (
    "json-object",
    "json-prefixed",
    "json-string-units",
    "json-measurements",
    "json-array",
    "json-data-batch",
    "key-value-pairs",
    "csv-header",
    "tsv-header",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream BaudTide telemetry format fixtures through a virtual serial port."
    )
    parser.add_argument(
        "--format",
        choices=("all", *FORMAT_NAMES),
        default="all",
        help="format to stream (default: all, one format after another)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.35,
        help="seconds between records (default: 0.35)",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=5,
        help="records per format before the helper exits (default: 5)",
    )
    parser.add_argument(
        "--startup-delay",
        type=float,
        default=2.0,
        help="seconds to wait after printing the PTY path (default: 2)",
    )
    return parser.parse_args()


def values(tick: int) -> dict[str, float]:
    elapsed = tick / 3.0
    return {
        "temperature": round(20.5 + 1.6 * math.sin(elapsed / 2.0), 2),
        "humidity": round(42.0 + 5.0 * math.sin(elapsed / 3.0 + 0.7), 2),
        "voltage": round(3.30 + 0.04 * math.sin(elapsed / 1.8), 3),
        "rpm": round(995.0 + 85.0 * math.sin(elapsed / 1.5), 1),
    }


def json_line(sample: dict[str, float]) -> str:
    return json.dumps(sample, separators=(",", ":"))


def format_header(name: str) -> str | None:
    if name == "csv-header":
        return "temperature (°C),humidity (%),voltage (V),rpm (rpm)"
    if name == "tsv-header":
        return "temperature [°C]\thumidity [%]\tvoltage [V]\trpm [rpm]"
    return None


def format_record(name: str, tick: int) -> str:
    sample = values(tick)
    if name == "json-object":
        return json_line(sample)
    if name == "json-prefixed":
        return "[sensor] tick=" + str(tick) + " " + json_line(sample)
    if name == "json-string-units":
        return json.dumps({
            "temperature": f"{sample['temperature']} °C",
            "humidity": f"{sample['humidity']} %",
            "voltage": f"{sample['voltage']} V",
            "rpm": f"{sample['rpm']} rpm",
        }, separators=(",", ":"))
    if name == "json-measurements":
        return json.dumps({
            "temperature": {"value": sample["temperature"], "unit": "°C"},
            "humidity": {"value": str(sample["humidity"]), "unit": "%"},
            "voltage": {"value": sample["voltage"], "units": "V"},
            "rpm": {"reading": sample["rpm"], "unit": "rpm"},
        }, separators=(",", ":"))
    if name == "json-array":
        return json.dumps([sample, values(tick + 1)], separators=(",", ":"))
    if name == "json-data-batch":
        return json.dumps({"data": [sample, values(tick + 1)]}, separators=(",", ":"))
    if name == "key-value-pairs":
        return (
            f"temperature={sample['temperature']} °C; "
            f"humidity:{sample['humidity']} % | "
            f"voltage={sample['voltage']} V rpm:{sample['rpm']} rpm"
        )
    if name == "csv-header":
        return ",".join(str(sample[key]) for key in ("temperature", "humidity", "voltage", "rpm"))
    if name == "tsv-header":
        return "\t".join(str(sample[key]) for key in ("temperature", "humidity", "voltage", "rpm"))
    raise ValueError(f"Unknown telemetry format: {name}")


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


def wait_between_records(master_fd: int, interval: float) -> None:
    readable, _, _ = select.select([master_fd], [], [], interval)
    if not readable:
        return
    try:
        received = os.read(master_fd, 4096)
    except BlockingIOError:
        received = b""
    if received:
        print(f"BaudTide sent: {received!r}", flush=True)


def main() -> int:
    args = parse_args()
    if args.interval <= 0:
        print("--interval must be greater than zero")
        return 2
    if args.samples <= 0:
        print("--samples must be greater than zero")
        return 2
    if args.startup_delay < 0:
        print("--startup-delay cannot be negative")
        return 2

    formats = list(FORMAT_NAMES) if args.format == "all" else [args.format]
    master_fd, slave_fd = pty.openpty()
    configure_raw(slave_fd)
    stop = Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    port = os.ttyname(slave_fd)
    print(f"BAUDTIDE_FORMATS_PORT={port}", flush=True)
    print("Formats: " + ", ".join(formats), flush=True)
    print("Connect this port in BaudTide, then open Visualize.", flush=True)
    time.sleep(args.startup_delay)

    tick = 0
    try:
        for name in formats:
            if stop.is_set():
                break
            print(f"--- streaming {name} ---", flush=True)
            header = format_header(name)
            if header and not write_all(master_fd, (header + "\n").encode(), stop):
                break
            for _ in range(args.samples):
                if not write_all(master_fd, (format_record(name, tick) + "\n").encode(), stop):
                    break
                tick += 1
                wait_between_records(master_fd, args.interval)
    except (BrokenPipeError, OSError) as error:
        if not stop.is_set():
            print(f"Virtual serial port stopped: {error}")
            return 1
    finally:
        os.close(master_fd)
        os.close(slave_fd)

    print("Telemetry fixture stream finished.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
