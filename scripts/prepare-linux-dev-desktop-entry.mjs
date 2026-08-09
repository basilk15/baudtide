import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptsDirectory, "..");
  const dataDirectory =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const applicationsDirectory = path.join(dataDirectory, "applications");
  const iconPath = path.join(projectRoot, "src-tauri", "icons", "icon.png");
  const desktopEntryPath = path.join(
    applicationsDirectory,
    "com.basil.baudtide.desktop",
  );
  const projectRootForShell = projectRoot.replaceAll("'", "'\\\"'\\\"'");

  const desktopEntry = `[Desktop Entry]
Type=Application
Name=BaudTide (Development)
Comment=BaudTide development build
Exec=sh -c "cd '${projectRootForShell}' && npm run tauri dev"
Icon=${iconPath}
StartupWMClass=com.basil.baudtide
Terminal=true
`;

  await mkdir(applicationsDirectory, { recursive: true });
  await writeFile(desktopEntryPath, desktopEntry, "utf8");
}
