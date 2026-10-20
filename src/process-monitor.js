/**
 * Attach exit handling to a spawned VM process.
 *
 * A clean exit is still a failure for persistent desktop components: a browser
 * or display server can stop with code 0 while leaving the relay alive but
 * unusable. One-shot helper processes (for example Chromium's --new-tab
 * launcher) should leave critical=false.
 */
export function monitorProcessExit(child, command, {
  critical = false,
  isStopping = () => false,
  onCriticalExit = () => {},
  logger = console,
} = {}) {
  child.on("exit", (code, signal) => {
    if (isStopping()) return;

    const message = `VM process exited: ${command} code=${code} signal=${signal}`;
    if (critical) {
      logger.error(`Critical ${message}; restarting VM relay.`);
      onCriticalExit({ command, code, signal });
    } else if (code !== 0) {
      logger.error(message);
    }
  });

  return child;
}
