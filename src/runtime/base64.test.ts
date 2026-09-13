import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "./base64";

describe("base64", () => {
  it("matches the broker's encoding of the same bytes", () => {
    // Pinned by session-broker/src/base64.rs: serde_carries_bytes_as_one_string_not_an_array.
    const bytes = new TextEncoder().encode("\u001b[31mred\u001b[0m");
    expect(encodeBase64(bytes)).toBe("G1szMW1yZWQbWzBt");
    expect(Array.from(decodeBase64("G1szMW1yZWQbWzBt"))).toEqual(Array.from(bytes));
  });

  it("round-trips every byte value, including a chunk larger than one call to fromCharCode", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(Array.from(decodeBase64(encodeBase64(all)))).toEqual(Array.from(all));
    const large = new Uint8Array(200_000);
    for (let index = 0; index < large.length; index += 1) large[index] = (index * 31) & 0xff;
    expect(decodeBase64(encodeBase64(large))).toEqual(large);
    expect(encodeBase64(new Uint8Array(0))).toBe("");
  });
});
