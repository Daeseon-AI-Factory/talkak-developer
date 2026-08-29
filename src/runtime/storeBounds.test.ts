import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sessionRecoveryOutputPolicy } from "./sessionRecovery";

/**
 * The renderer states the store's bounds so recovery can describe what it kept. Those numbers live
 * in Rust; the copy here is a mirror, and a mirror nothing checks is a lie waiting to happen.
 *
 * The existing test compared this module's constants with the same literals written out again in
 * the test file — TypeScript against TypeScript, passing whatever Rust said. `MAX_LOG_BYTES` was
 * then raised from 4 MiB to 8 MiB on the Rust side and every test still passed, with the app
 * telling users it retains half what it does. This reads the Rust.
 */
const STORE = fileURLToPath(new URL("../../session-broker/src/store.rs", import.meta.url));

function rustConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name}:\\s*\\w+\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`${name} not found in store.rs — was it renamed?`);
  const expression = match[1].trim();
  // The constants are written as byte arithmetic, e.g. `8 * 1024 * 1024`.
  if (!/^[\d*\s+]+$/.test(expression)) {
    throw new Error(`${name} is no longer a plain byte expression: ${expression}`);
  }
  return expression
    .split("+")
    .map((term) =>
      term
        .split("*")
        .map((factor) => Number(factor.trim()))
        .reduce((product, factor) => product * factor, 1),
    )
    .reduce((sum, term) => sum + term, 0);
}

describe("the retained-output bounds this app reports", () => {
  const source = readFileSync(STORE, "utf8");

  it("states the same maximum the Rust store actually enforces", () => {
    expect(sessionRecoveryOutputPolicy.maximumBytes).toBe(rustConstant(source, "MAX_LOG_BYTES"));
  });

  it("states the same retained tail the Rust store actually keeps", () => {
    expect(sessionRecoveryOutputPolicy.retainedBytesAfterRotation).toBe(
      rustConstant(source, "LOG_RETAINED_BYTES"),
    );
  });

  it("keeps the retained tail no larger than the maximum, or rotation cannot shrink anything", () => {
    expect(sessionRecoveryOutputPolicy.retainedBytesAfterRotation).toBeLessThanOrEqual(
      sessionRecoveryOutputPolicy.maximumBytes,
    );
  });
});
