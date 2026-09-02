import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const appId = 'com.basil.baudtide';

if (process.platform !== 'linux') process.exit(0);

const configuredDataHome = process.env.XDG_DATA_HOME;
const dataHome = configuredDataHome && path.isAbsolute(configuredDataHome)
  ? configuredDataHome
  : path.join(os.homedir(), '.local', 'share');
const desktopEntryDirectory = path.join(dataHome, 'applications');
const desktopEntryPath = path.join(desktopEntryDirectory, `${appId}.desktop`);
const iconPath = path.join(projectRoot, 'build', 'icons', 'icon.png');
const shellQuotedProjectRoot = projectRoot.replaceAll("'", "'\\\"'\\\"'");
const desktopEntry = [
  '[Desktop Entry]',
  'Version=1.0',
  'Type=Application',
  'Name=BaudTide (Development)',
  'Comment=BaudTide development build',
  `Exec=sh -c \"cd '${shellQuotedProjectRoot}' && npm run electron\"`,
  `Icon=${iconPath}`,
  `StartupWMClass=${appId}`,
  'Terminal=false',
  'Categories=Development;Utility;',
  'Keywords=serial;monitor;UART;',
  'StartupNotify=true',
  '',
].join('\n');

fs.mkdirSync(desktopEntryDirectory, { recursive: true, mode: 0o755 });
try {
  if (fs.readFileSync(desktopEntryPath, 'utf8') === desktopEntry) process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
fs.writeFileSync(desktopEntryPath, desktopEntry, { mode: 0o644 });
