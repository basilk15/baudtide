# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Embedded developers working at a Linux bench with ESP32, Arduino, and USB/TTY devices. They need to connect hardware, inspect noisy serial output, compare telemetry, and retain useful captures without losing concentration.

## Product Purpose

BaudTide is a focused desktop serial monitor. It discovers local ports, runs several device sessions, visualizes structured telemetry, and keeps searchable raw logs on the user's computer.

## Positioning

BaudTide combines a calm multi-session terminal workspace, local capture management, telemetry visualization, and explicitly opt-in LAN sharing in one Linux-first tool.

## Operating Context

The product is used during board bring-up, firmware debugging, sensor calibration, and repeated bench tests. Users move frequently between device discovery, live terminals, telemetry, saved logs, mobile sharing, and preferences.

## Capabilities and Constraints

- Preserve all existing React behavior, desktop bridge calls, session state, shortcuts, forms, notifications, and data flows.
- Preserve dark and light themes and responsive layouts.
- Keep raw captures local; mobile links remain read-only unless remote control is explicitly enabled.
- Do not require Arduino CLI compilation; firmware is built and uploaded separately in Arduino IDE.

## Brand Commitments

- Product name: BaudTide.
- Preserve the existing BaudTide mark at `src/assets/signaldeck-mark.png`.
- Voice: calm, direct, technically precise, and free of invented claims.
- The interface should feel like a credible instrument, not a collection of promotional cards.

## Evidence on Hand

The repository contains the implemented product flows, working UI copy, the BaudTide mark, tests, and a detailed feature inventory in `README.md`. No testimonials, adoption metrics, or commercial claims are available and none should be fabricated.

## Product Principles

- Keep the signal more prominent than the surrounding chrome.
- Make device and connection state understandable at a glance.
- Keep frequent monitoring actions close and predictable.
- Preserve user data and local-first boundaries.
- Prefer clear recovery guidance over vague system messages.

