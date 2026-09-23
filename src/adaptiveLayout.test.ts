import { describe, expect, it } from "vitest";
import { PHONE_MAX_WIDTH, TABLET_MAX_WIDTH, presentationModeForWidth } from "./adaptiveLayout";

describe("adaptive layout", () => {
  it("derives presentation from available width rather than a device name", () => {
    expect(presentationModeForWidth(PHONE_MAX_WIDTH)).toBe("phone");
    expect(presentationModeForWidth(PHONE_MAX_WIDTH + 1)).toBe("tablet");
    expect(presentationModeForWidth(TABLET_MAX_WIDTH)).toBe("tablet");
    expect(presentationModeForWidth(TABLET_MAX_WIDTH + 1)).toBe("desktop");
  });
});
