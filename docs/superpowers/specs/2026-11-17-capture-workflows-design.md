# Capture workflows
The user delegated feature selection, sequential implementation, UI review, self-review and pushing passing changes to main.

Choose a cohesive local-first experiment-library improvement rather than more chart controls (already extensive) or a new transport (larger hardware validation surface).
1. Capture notebook: optional title (80 characters) and notes (4000 characters), persisted independently of raw files. Explicit save/cancel, storage errors preserve drafts, title shown beside original capture identity. Local text filter searches title, notes and tags without scanning serial bytes. Notebook metadata stays installation-local and is excluded from portable bundles.
2. Saved views: up to 20 named, validated snapshots of query, complete-search setting, state, sort, favorites, tag and notebook filter. Restore filters only, never device connections. Explicit deletion. Corrupt storage must never be silently overwritten.
3. Inventory export: CSV of the current filtered and sorted library including notebook and organization metadata. Explicit review of included data; no raw serial bytes or filesystem paths. Escape CSV and neutralize spreadsheet formulas.

Use existing React/TypeScript, semantic theme tokens, ruled surfaces, keyboard focus, responsive 44px controls. Preserve raw files and existing native search. No new runtime dependencies.
