import { describe, expect, it, vi } from "vitest";
import { createDirectoryPicker } from "./directoryPicker";

describe("directory picker", () => {
  it("does not call a native dialog outside the desktop shell", async () => {
    const open = vi.fn();
    const picker = createDirectoryPicker(() => false, open);

    await expect(picker.pick("", "Choose")).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("requests one directory and returns its path", async () => {
    const open = vi.fn().mockResolvedValue("/work/app");
    const picker = createDirectoryPicker(() => true, open);

    await expect(picker.pick(" /work ", "Choose folder")).resolves.toBe("/work/app");
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: "/work",
      title: "Choose folder",
    });
  });
});
