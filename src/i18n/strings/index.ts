import { runtimeMessages } from "../../runtimeMessages";
import { attention } from "./attention";
import { inspector } from "./inspector";
import { memory } from "./memory";
import { mobile } from "./mobile";
import { project } from "./project";
import { settings } from "./settings";
import { shell } from "./shell";
import { terminal } from "./terminal";
import { workspace } from "./workspace";

/**
 * One dictionary per surface, merged here. Each file carries its own ko and en side by side so a
 * string is added in both languages in one place, and so parallel work on different surfaces does
 * not collide in one 800-line file.
 */
export const ko = {
  ...memory.ko,
  ...runtimeMessages.ko,
  ...shell.ko,
  ...project.ko,
  ...workspace.ko,
  ...terminal.ko,
  ...inspector.ko,
  ...attention.ko,
  ...mobile.ko,
  ...settings.ko,
};

export type MessageKey = keyof typeof ko;

export const en: Record<MessageKey, string> = {
  ...memory.en,
  ...runtimeMessages.en,
  ...shell.en,
  ...project.en,
  ...workspace.en,
  ...terminal.en,
  ...inspector.en,
  ...attention.en,
  ...mobile.en,
  ...settings.en,
};
