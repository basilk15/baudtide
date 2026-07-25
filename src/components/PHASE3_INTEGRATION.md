# Supporting-control integration

The application shell already integrates these components with the native serial, preference, and local-notification flows. This file is a compact reference for their intended placement, not a setup guide for mock controls.

Import the shared stylesheet once with the components (each component already imports it) and place controls in the existing app shell as follows:

```tsx
import { SidebarNavigation } from './components/SidebarNavigation';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsPanel } from './components/NotificationsPanel';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import { PreferencesScreen } from './components/PreferencesScreen';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
```

- Keep `SidebarNavigation` controlled by the application page state.
- Keep `CommandPalette`, `NotificationsPanel`, and `WorkspaceProfileMenu` in the top-bar actions.
- Render `PreferencesScreen` for the `preferences` page and `HelpFeedbackPanel` for the `help` page, passing current native/session state where needed.
- Provide real commands through `CommandPalette`'s `onAction`; add actions only when they are backed by application data and handlers.
- `WorkspaceProfileMenu` is a compact Preferences trigger. It deliberately does not imply workspace switching or account support.
