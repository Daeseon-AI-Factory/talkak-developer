/** Windows reports this unsigned NTSTATUS when a console control event interrupts a process. */
export const WINDOWS_CONTROL_C_EXIT = 0xc000_013a;

export function exitWasInterrupted(exitCode: number | null | undefined): boolean {
  return exitCode === WINDOWS_CONTROL_C_EXIT;
}
