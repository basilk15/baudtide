import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, '..');
const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const electronPackageDirectory = path.join(projectRoot, 'node_modules', 'electron');
const electronPackage = JSON.parse(fs.readFileSync(
  path.join(electronPackageDirectory, 'package.json'),
  'utf8',
));
const electronExecutable = path.join(
  electronPackageDirectory,
  'dist',
  fs.readFileSync(path.join(electronPackageDirectory, 'path.txt'), 'utf8').trim(),
);
const nativeManifest = path.join(projectRoot, 'src-native', 'Cargo.toml');
const developmentUrl = 'http://127.0.0.1:1420';
const developmentRestartExitCode = 86;
const launcherArguments = process.argv.slice(2);
const skipNativeBuild = launcherArguments.includes('--skip-native-build');
const electronArguments = launcherArguments.filter((argument) => argument !== '--skip-native-build');
const children = new Set();
let stopping = false;
let requestedExitCode = null;

function sandboxCompatibleElectronExecutable(executable) {
  if (process.platform !== 'linux' || !/\s/.test(executable)) {
    return executable;
  }

  // Chromium's Linux SUID sandbox currently truncates an executable path at
  // its first space. Launch the same inode from a private, no-space cache path
  // while keeping Electron's resources linked to the installed distribution.
  const cacheRootCandidates = [
    path.join(os.homedir(), '.cache'),
    process.env.XDG_CACHE_HOME,
  ];
  const cacheRoot = cacheRootCandidates.find((candidate) => (
    candidate
    && path.isAbsolute(candidate)
    && !/\s/.test(candidate)
  ));
  if (!cacheRoot) {
    throw new Error(
      'Electron\'s Linux sandbox cannot launch from a path containing spaces, and no no-space cache directory is available.',
    );
  }

  const sourceStats = fs.statSync(executable);
  const safeVersion = String(electronPackage.version).replaceAll(/[^a-zA-Z0-9._-]/g, '-');
  const launcherDirectory = path.join(
    cacheRoot,
    'baudtide-electron-launcher',
    `${safeVersion}-${sourceStats.dev}-${sourceStats.ino}`,
  );
  fs.mkdirSync(launcherDirectory, { recursive: true, mode: 0o700 });

  const launcherExecutable = path.join(launcherDirectory, 'electron');
  if (!fs.existsSync(launcherExecutable)) {
    try {
      fs.linkSync(executable, launcherExecutable);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'EXDEV') throw error;
      fs.copyFileSync(executable, launcherExecutable);
      fs.chmodSync(launcherExecutable, sourceStats.mode);
    }
  }

  const distributionDirectory = path.dirname(executable);
  for (const entry of fs.readdirSync(distributionDirectory, { withFileTypes: true })) {
    if (entry.name === path.basename(executable)) continue;
    const destination = path.join(launcherDirectory, entry.name);
    try {
      fs.lstatSync(destination);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
    }
    fs.symlinkSync(
      path.join(distributionDirectory, entry.name),
      destination,
      entry.isDirectory() ? 'dir' : 'file',
    );
  }

  return launcherExecutable;
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  children.add(child);
  child.once('error', (error) => {
    child.launchError = error;
  });
  child.once('exit', () => children.delete(child));
  return child;
}

function waitForExit(child, label, { allowExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`${label} failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (allowExitCodes.includes(code)) resolve(code);
      else reject(new Error(`${label} stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function waitForVite(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.launchError) {
      throw new Error(`Vite failed to start: ${child.launchError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Vite stopped before becoming ready (exit code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(developmentUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not become ready at ${developmentUrl} within 30 seconds.`);
}

function stopChildren(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    requestedExitCode = signal === 'SIGINT' ? 130 : 143;
    stopChildren(signal);
    process.exitCode = requestedExitCode;
  });
}

try {
  if (!skipNativeBuild) {
    const cargo = run('cargo', ['build', '--manifest-path', nativeManifest, '--locked']);
    await waitForExit(cargo, 'Native backend build');
  }

  const vite = run(process.execPath, [viteBin, '--host', '127.0.0.1']);
  await waitForVite(vite);

  const electronLaunchExecutable = sandboxCompatibleElectronExecutable(electronExecutable);
  while (true) {
    const electron = run(electronLaunchExecutable, [projectRoot, ...electronArguments], {
      env: {
        ...process.env,
        BAUDTIDE_DEV_SERVER_URL: developmentUrl,
      },
    });
    const exitCode = await waitForExit(electron, 'Electron', { allowExitCodes: [0, developmentRestartExitCode] });
    if (exitCode !== developmentRestartExitCode) break;
  }
  stopChildren();
} catch (error) {
  if (requestedExitCode === null) {
    console.error(error instanceof Error ? error.message : error);
  }
  stopChildren();
  process.exitCode = requestedExitCode ?? 1;
}
