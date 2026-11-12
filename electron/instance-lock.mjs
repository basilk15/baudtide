export function claimApplicationInstance(app, focusExistingWindow) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', focusExistingWindow);
  return true;
}
