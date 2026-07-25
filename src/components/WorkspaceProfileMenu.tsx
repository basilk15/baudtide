import { Settings2 } from 'lucide-react';
import './phase3-controls.css';

type WorkspaceProfileMenuProps = { onPreferences?: () => void };

/** Opens real application preferences. Local workspace switching is not available yet. */
export function WorkspaceProfileMenu({ onPreferences }: WorkspaceProfileMenuProps) {
  return <button className="sd-profile-trigger" type="button" onClick={onPreferences} title="Open preferences" aria-label="Open preferences"><Settings2 size={16} /><span><strong>Preferences</strong><small>Application settings</small></span></button>;
}
