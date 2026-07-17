# Phase 3 control integration

These components are UI-only. They contain local React state and deliberately do not call Tauri, serial APIs, storage APIs, or accounts.

Import the shared stylesheet once with the components (each component already imports it) and place controls in the existing app shell as follows:

```tsx
import { SidebarNavigation } from './components/SidebarNavigation';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsPanel } from './components/NotificationsPanel';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import { PreferencesScreen } from './components/PreferencesScreen';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
```

- Replace the current sidebar with `SidebarNavigation`, storing `activePage` in `App` and passing `onNavigate`.
- Place `CommandPalette`, `NotificationsPanel`, and `WorkspaceProfileMenu` in the top-bar actions.
- Render `PreferencesScreen` for the `preferences` page and `HelpFeedbackPanel` for the `help` page.
- In the future, pass a real handler through `CommandPalette`'s `onAction`; use its `actions` prop to add sessions/devices/logs from application data.
- `WorkspaceProfileMenu` is intentionally a local-workspace mock. If local workspaces are deferred, omit it rather than exposing an account-like control.
