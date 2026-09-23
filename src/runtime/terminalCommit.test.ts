import { describe, expect, it } from "vitest";
import { serializeTerminalCommit } from "./terminalCommit";
import { createTerminalOutputWriter } from "./terminalOutputWriter";

describe("terminal commits across mounts", () => {
  it("waits for the detached mount's write and cursor before the returning mount reads them", async () => {
    let cursor = 0;
    let finishWrite = () => {};
    const painted: string[] = [];
    const oldWriter = createTerminalOutputWriter(
      (bytes, done) => {
        painted.push(new TextDecoder().decode(bytes));
        finishWrite = done;
      },
      () => {},
    );
    const oldMount = serializeTerminalCommit("returning", async () => {
      if (!(await oldWriter.write(new TextEncoder().encode("old"), false))) return false;
      cursor = 3;
      return true;
    });
    await Promise.resolve();
    await Promise.resolve();
    oldWriter.dispose();
    let readAtReturn: number | undefined;
    const newMount = serializeTerminalCommit("returning", async () => {
      readAtReturn = cursor;
      painted.push("old-new".slice(cursor));
      cursor = 7;
      return true;
    });
    await Promise.resolve();
    expect(readAtReturn).toBeUndefined();
    finishWrite();
    await expect(oldMount).resolves.toBe(true);
    await expect(newMount).resolves.toBe(true);
    expect(readAtReturn).toBe(3);
    expect(painted.join("")).toBe("old-new");
    expect(cursor).toBe(7);
  });

  it("allows another session to render while one is waiting for xterm", async () => {
    let finish = (_value: boolean) => {};
    const first = serializeTerminalCommit(
      "waiting",
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(serializeTerminalCommit("other", async () => true)).resolves.toBe(true);
    finish(true);
    await first;
  });

  it("keeps later mounts usable after a rejected write", async () => {
    const failed = serializeTerminalCommit("rejected", async () => {
      throw new Error("write failed");
    });
    const recovered = serializeTerminalCommit("rejected", async () => true);
    await expect(failed).rejects.toThrow("write failed");
    await expect(recovered).resolves.toBe(true);
  });
});
