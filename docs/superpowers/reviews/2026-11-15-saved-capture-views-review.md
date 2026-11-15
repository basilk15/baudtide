# Saved capture views review

Scope: `feature/saved-capture-views`, extending the local library at cbbf4ca. The feature saves and explicitly reapplies all six existing filter fields, with local persistence, a compact selector and an inline manager.

## UI findings and changes

- The selector and Views trigger fit in the existing local-filter band at 1280px; browsing gains no additional permanent toolbar row.
- Initial actual-App rendering exposed a generic label rule overriding the name field's grid. Scoped the form label rule so its label stays above the input.
- Reduced summaries to useful current settings instead of repeating every inactive default. Retained complete-search scope disclosure and query previews.
- Long names and removal confirmation wrap at 320px; narrow save/apply/remove/retry actions have 44px targets. Capture-content horizontal overflow measured zero at 320, 390, 720, 960 and 1280px.
- Placed storage errors next to the save field while the manager is open. Drafts survive errors and Retry restores focus to the input (or the persistent Views trigger when collapsed).
- Inspected dark, light and sage states. Sampled helper/body contrast ranged from 5.62:1 to 7.06:1; headings/name labels were higher. This focused check does not constitute a full accessibility certification.

## Code review and verification

- A fresh-context reviewer found a serialized-size mismatch: valid escaped queries could exceed the reader's original cap after successful writes. Added a failing regression for 24 maximum escaped queries, then fixed it using a shared 400,000-character cap and a writer guard before mutation. Reviewer independently reran all 14 focused tests and confirmed no remaining blockers.
- `npm test`: 310 frontend/Electron tests passed, one Linux-only permission test skipped on Windows; 77 native tests passed.
- `npm run build`: typecheck and production build passed. The existing large-chunk warning remains.
- Rust formatting check passed. The combined `npm run check` initially selected an MSVC toolchain without Clippy; rerunning `npm run lint:rust` with the installed GNU toolchain explicitly selected passed with warnings denied. Formatting, linting and production build therefore all passed locally.
- `git diff --check` passed.
- Integration tests verify explicit-only startup, nonempty query and complete-search restoration through the actual native-search call, resulting capture rows, all organization fields, remount persistence, confirmed removal, failure preservation and recovery focus.

## Screenshot evidence

Current-run screenshots saved under ignored `output/saved-views-review/`, with exact saved files reopened for inspection:

| File | Evidence |
| --- | --- |
| `01-collapsed-dark.png` | Compact browsing controls |
| `02-initial-manager-dark.png` | Initial empty manager before polish |
| `03-manager-light.png` | Polished populated desktop manager |
| `04-manager-sage-390.png` | Narrow save form and list |
| `05-long-name-320.png` | Long-name wrapping |
| `06-removal-320.png` | Explicit removal confirmation |
| `07-storage-error-320.png` | Preserved draft and inline recovery |
| `08-manager-960.png` | Intermediate-width layout |

The browser runs the actual App with an isolated mock desktop bridge and representative captures; this is not native-window/hardware testing. The already documented global topbar crowding at 320px and 960px remains outside this capture-feature scope. No new feature content overflow was observed.

Guidance: repository design context, Impeccable Operate/craft/polish, screenshot-first product audit, [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md), TDD and independent code review.
