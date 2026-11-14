# Capture UI polish Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation and one fresh-context final review.

**Goal:** Make the example gallery and capture tags/favorites feel like a coherent, clean local capture workbench.

**Architecture:** Keep the existing components and behavior. Scope layout and visual changes to capture styles and markup; retain local-only organization and explicit example imports.

**Tech Stack:** React, TypeScript, CSS tokens, Vitest, Vite.

**Spec:** The user's UI review request and `docs/design.md`: preserve graphite, light and sage themes, Ubuntu Sans/Mono, restrained ruled surfaces, aqua selection, visible focus and 320px support.

## Global Constraints

- Preserve all existing capture actions and persistence contracts.
- Keep synthetic data and local-only labels clearly disclosed.
- Use existing tokens and icons; no added dependencies or decorative motion.

## Review Focus

- Wide content and long tags must wrap without horizontal page overflow.
- Narrow screens must retain usable controls and discoverable import actions.
- Selected, busy, error and empty states must remain readable in every theme.
- Keyboard navigation must preserve editor focus, cancellation and filtering behavior.
- Gallery previews must retain truthful labels and all instructional content.

## Tasks

- [x] Capture and inspect current screens; record concrete hierarchy/spacing findings.
- [x] Compact gallery headings, plot, facts and footer; keep all content and explicit import.
- [x] Group organization filters, quiet row labels, fix header action alignment, and label search explicitly.
- [x] Verify existing interaction tests and add useful accessibility assertions; run frontend suite and production build.
- [x] Inspect desktop/narrow rendered layouts and themes, editor/validation/empty states; fix observed defects.
- [x] Request independent code review, address findings and document evidence.

## Ledger

- Baseline: gallery height 733px at 1280x800; import ends at y997. Header actions wrap unevenly. Detached local filter band and bordered row labels add noise.
- Ruling: this is refinement of the existing approved features; no new product behavior or additional approval is required.

- Final: 300 frontend tests passed (one Windows skip); production build and whitespace check passed. Independent review found no blockers. Screenshots/limits recorded in `docs/superpowers/reviews/2026-11-14-capture-ui-review.md`.
