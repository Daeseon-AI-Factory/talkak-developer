export type TerminalOutputWriter = (
  bytes: Uint8Array,
  suppressProtocolInput: boolean,
) => Promise<boolean>;

interface TerminalOutputWriterController {
  write: TerminalOutputWriter;
  dispose: () => void;
}

/**
 * Feeds xterm one chunk at a time. A submitted write is allowed to finish after the pane detaches
 * because the emulator is retained; writes still waiting in this controller are abandoned.
 */
export function createTerminalOutputWriter(
  writeToTerminal: (bytes: Uint8Array, done: () => void) => void,
  setProtocolInputSuppressed: (suppressed: boolean) => void,
): TerminalOutputWriterController {
  let disposed = false;
  let tail = Promise.resolve();

  const write: TerminalOutputWriter = (bytes, suppressProtocolInput) => {
    const current = tail.then(
      () =>
        new Promise<boolean>((resolve, reject) => {
          if (disposed) {
            resolve(false);
            return;
          }
          setProtocolInputSuppressed(suppressProtocolInput);
          try {
            writeToTerminal(bytes, () => {
              setProtocolInputSuppressed(false);
              resolve(true);
            });
          } catch (cause: unknown) {
            setProtocolInputSuppressed(false);
            reject(cause);
          }
        }),
    );
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  return {
    write,
    dispose: () => {
      disposed = true;
    },
  };
}
