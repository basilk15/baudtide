import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, "..");
const tauriCli = path.join(
  projectRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const environment = { ...process.env };

if (process.platform === "linux") {
  // A terminal opened from another desktop app can pass its launch identity to
  // Tauri. On Wayland, GNOME would then associate the window with that app
  // rather than BaudTide's own desktop entry.
  delete environment.GIO_LAUNCHED_DESKTOP_FILE;
  delete environment.GIO_LAUNCHED_DESKTOP_FILE_PID;
  delete environment.DESKTOP_STARTUP_ID;
}

const child = spawn(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
