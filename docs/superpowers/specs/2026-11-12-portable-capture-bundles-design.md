# Portable capture bundles

## Purpose

Let a person share one completed serial capture with a collaborator, who can import it into a separate BaudTide installation and investigate the same raw output, available receive timing, notes, and selected decoder. The transfer is local and user initiated.

## Scope

- Export a single, inactive capture with its exact raw bytes, optional valid timing companion, capture notes, and an explicitly selected decoder profile. Do not add device paths, serial numbers, commands, or other captures as bundle metadata. Raw output and notes may themselves contain sensitive identifiers and are not automatically scrubbed.
- Preserve the original start/end or fallback modification time used for approximate replay, without inventing a reconnectable port or baud rate.
- Import into the saved-log library under a new identity. Preserve raw bytes and recorded receive timing; if timing is missing or unusable, retain an explicitly approximate timing state. Restore notes against the new path and offer the included decoder without replacing an existing profile.
- Preview what is included and explain that raw output and notes may contain sensitive information. The application never uploads or transmits a bundle.
- Provide a small synthetic example that ships with the packaged application and can exercise import and replay without hardware.
- Saved comparisons, multiple captures, arbitrary text/CSV import, automatic redaction, and cloud sharing are outside this version.

## Design choices

One versioned, bounded container stores a manifest plus raw and timing byte streams. A custom framed container avoids archive entry names and path traversal; length and SHA-256 digest checks cover the manifest and both streams to detect truncation and accidental corruption. These checks are not signatures and do not authenticate the sender. Unlike a plain log, it preserves timing and annotations. Unlike an unrestricted workspace export, it limits the initial implementation to one understandable artifact.

Electron owns file dialogs and streaming container I/O; the native backend remains the authority on capture-library paths, active sessions, and storage quota. Renderer storage remains the authority for existing notes and decoder profiles. Import must preserve the original bundle when any step fails and surface incomplete metadata restoration rather than claiming full success. Neither import nor viewing starts a serial connection or sends commands.

The saved-logs screen gains an Import bundle action and a per-capture Export bundle action. An export review explains the contents, offers a decoder choice, and keeps destructive or unrelated controls out of the flow. Use existing semantic color tokens, typography, controls, focus behavior, and dark/light/sage themes. The UI should remain usable at narrow widths and with keyboard input.

## Integrity and recovery

Reject unsupported versions, invalid lengths, malformed metadata, unexpected trailing bytes, invalid timing, and incorrect digests before publishing an imported capture. Stream large data rather than loading captures into the renderer. Bound the manifest to 256 KiB and report when the selected notes exceed that limit; never silently truncate. Use new unique names, staged writes, cleanup on failure, and no replacement of capture files. Include raw and timing bytes in quota reservations. Reject active and closing captures as export sources, and guard export destinations against captures, timing files, app-data files, and symlinks. Omit unavailable or incomplete source timing with an explicit approximate label; reject a bundle claiming recorded timing whose index is invalid. Sensitive content is not automatically removed; review and redaction remain the sender's responsibility.

Persist a small import-recovery record alongside the imported capture until notes and the decoder are restored. Restoration reads both local libraries strictly, checks capacity, assigns fresh IDs, and is idempotent; a storage error leaves the recovery record available for retry rather than silently discarding metadata or duplicating the capture.
If notes cannot be restored, the user may explicitly confirm skipping note import; the original bundle and any previously restored notes remain untouched. Incomplete capture states travel with the bundle so comparison checks cannot mistake uncertain evidence for a complete capture.

## Verification

Round-trip byte-level fixtures with recorded and absent timing, notes, and a decoder through isolated source/destination libraries. Exercise invalid files, destination collisions, interrupted writes, quota, active sessions, repeated imports, and storage failures. Check frontend flows and responsive themes; run the repository's frontend/native checks where the environment supports them.
