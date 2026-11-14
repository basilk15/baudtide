# Example capture gallery

The user delegated choosing the next feature and requested the same implementation, UI review, and testing iteration. My choice is an example gallery: existing analysis is capable, but the only synthetic capture is discoverable only in an empty library.

## Scope and approach

Use the current local bundle import path. Offer a temperature-spike example and a delimiter-based motor example with a decoder. Both contain exact recorded timing and a timestamped note. A guided workspace would add more onboarding state; tags and favorites would help established users but would not improve evaluation without hardware. The gallery is the smallest useful next step for prospective users and contributors.

An Examples action in Saved logs toggles an inline gallery, always available regardless of library contents. A selectable list sits beside details and an accurate preview trace. Each example explains its format, duration, signals, and what to inspect. Import creates an independent library copy through existing quota and recovery logic. Show success with an Open in Visualize action; never silently navigate away or connect a device. Retain retry guidance if metadata restoration fails. Prevent concurrent imports and keep the selected example stable while busy. Preserve the old empty-state example shortcut by opening the gallery.

The Electron process resolves only allowlisted example IDs to packaged filenames. Unknown IDs fail, rather than falling back to another recording. Existing calls without an ID continue to select the temperature example. Browser preview has no native import. Generate both bundles deterministically, package all example assets, and test the generated contents against the displayed catalogue.

## Direction contract

THESIS: let someone inspect the kinds of serial evidence BaudTide understands before importing it.
OWN-WORLD: preserve the existing graphite/paper/sage tokens, Ubuntu Sans and Ubuntu Mono, ruled surfaces, restrained aqua selection, and existing controls. No new visual world or decorative assets.
STORY: choose a clearly labeled synthetic recording, understand what it demonstrates, explicitly import, then open its chart.
FIRST VIEWPORT: compact heading and close action; left-hand example list; right-hand trace, description, inspection guidance, and import action. Stack at narrow widths.
FORM: an inline workbench section; seed: none (pinned by the existing design system).
FINISH: tests, rendered theme/width inspection where available, fresh code review, and documentation.

## Verification

Test allowlist/path traversal rejection, both bundle contents and decoder recovery, selection and busy states, failed and repeated imports, populated-library discovery, and opening the actual imported capture. Run frontend tests, typecheck/build, native tests, and the real sidecar round trip for both examples. Do not claim screenshot validation if capture is unavailable.
