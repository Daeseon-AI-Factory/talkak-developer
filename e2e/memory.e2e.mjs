import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const projectPath = process.env.TALKAK_MACOS_PROJECT ?? process.env.TALKAK_WINDOWS_PROJECT;
if (!projectPath || !isAbsolute(projectPath))
  throw new Error("Memory E2E needs an absolute external test project");

describe("project memory in the native app", () => {
  it("saves a Korean handoff, retrieves it after reload, corrects it and selects it", async () => {
    const oldMarker = `old-memory-${Date.now()}`;
    const newMarker = `new-memory-${Date.now()}`;
    await (await $('[data-testid="add-project-global"]')).waitForClickable();
    await (await $('[data-testid="add-project-global"]')).click();
    await (await $('[data-testid="project-name"]')).setValue("Memory E2E");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();
    await (await $('[data-testid="start-session-in-page"]')).waitForClickable();
    await (await $('[data-testid="start-session-in-page"]')).click();
    try {
      await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist();
      await openMemory();
      await (await $(".project-memory__body > button")).click();
      await (await $(".project-memory__editor input")).setValue("한글 인수인계");
      await (await $(".project-memory__editor textarea")).setValue(
        `미완료 작업: 조합 입력 검증. ${oldMarker}`,
      );
      await (await $('.project-memory__editor button[type="submit"]')).click();
      await browser.waitUntil(async () =>
        (await $(".project-memory__record").getText()).includes(oldMarker),
      );
      const initial = await search(oldMarker);
      assert.equal(initial.records.length, 1);
      const firstId = initial.records[0].id;

      await browser.refresh();
      await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist();
      await openMemory();
      await (await $(".project-memory__search input")).setValue(oldMarker);
      await (await $(".project-memory__search button")).click();
      await (await $(".project-memory__list button")).waitForClickable();
      await (await $(".project-memory__list button")).click();
      await (await $(".project-memory__record")).waitForExist();
      assert.match(await $(".project-memory__record").getText(), /한글 인수인계/);
      const actions = await $$(".project-memory__record button");
      await actions[2].click();
      await (await $(".project-memory__editor textarea")).setValue(
        `새 결정: 실제 키 입력부터 검증. ${newMarker}`,
      );
      await (await $('.project-memory__editor button[type="submit"]')).click();
      await browser.waitUntil(async () => (await search(newMarker)).records.length === 1);
      const corrected = (await search(newMarker)).records[0];
      assert.notEqual(corrected.id, firstId);
      assert.equal((await search(oldMarker)).records.length, 0);
      await (await $$(".project-memory__record button"))[1].click();
      await browser.waitUntil(async () => (await search("")).selectedId === corrected.id);
      console.log("MEMORY_NATIVE_FLOW_OK: saved, reloaded, searched, corrected, selected");
      await verifyLaunchConnections(corrected.id, newMarker);
    } finally {
      const running = await browser.execute(async () =>
        window.__TAURI__.core.invoke("session_live"),
      );
      for (const session of running) {
        if (session.cwd === projectPath && session.running) {
          await browser.execute(
            async (request) => window.__TAURI__.core.invoke("session_kill", { request }),
            {
              sessionId: session.sessionId,
              runId: session.runId,
            },
          );
        }
      }
    }
  });

  it("defaults compatible profiles to memory, preserves opt-out, and retries a failed launch without it", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "talkak-memory-defaults-"));
    const source = join(fixture, "probe.rs");
    const executable = join(fixture, process.platform === "win32" ? "probe.exe" : "probe");
    writeFileSync(
      source,
      `fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let connected = args.iter().any(|arg| arg == "--mcp-config" || arg.starts_with("mcp_servers."));
        let memory_off = args.iter().any(|arg| arg.contains("--no-memory"));
        if connected && !memory_off {
          eprintln!("TEST_AGENT_REJECTED_MEMORY");
          std::process::exit(17);
        }
        println!("{}", if connected { "MEMORY_OFF_POLICY_ON" } else { "MEMORY_BYPASS_OK" });
      }`,
    );
    execFileSync("rustc", [source, "-o", executable], { timeout: 30_000 });

    for (const enabled of [true, false]) {
      const name = `Memory defaults ${enabled}`;
      await (await $('[data-testid="add-project-global"]')).click();
      await (await $('[data-testid="project-name"]')).setValue(name);
      await (await $('[data-testid="project-path"]')).setValue(projectPath);
      await (await $('[data-testid="project-command"]')).setValue(executable);
      // The embedded WKWebView driver's option-click leaves selectedIndex unchanged. Dispatch
      // the select's change event so this still exercises React, persistence, and the native IPC.
      await browser.execute(() => {
        const select = document.querySelector('[data-testid="project-agent-connection"]');
        select.value = "mcp-json";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const toggle = await $('[data-testid="project-memory-enabled"]');
      await toggle.waitForExist();
      assert.equal(await toggle.isSelected(), true, "compatible profiles default to memory");
      if (!enabled) await toggle.click();
      await (await $('[data-testid="save-project"]')).click();
      await (await $('[data-testid="start-session-in-page"]')).waitForClickable();
      await browser.refresh();
      const profile = await browser.execute((projectName) => {
        const projects = JSON.parse(localStorage.getItem("talkak.projects.v1")).projects;
        return projects.find((project) => project.name === projectName).launchProfile;
      }, name);
      assert.equal(profile.memory, "mcp-json");
      assert.equal(profile.memoryEnabled !== false, enabled);
      await (await $('[data-testid="start-session-in-page"]')).waitForClickable();
      await (await $('[data-testid="start-session-in-page"]')).click();
      await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist();
      if (enabled) {
        const retry = await $('[data-testid="retry-without-memory"]');
        await retry.waitForClickable();
        await retry.click();
      }
      await browser.waitUntil(async () =>
        browser.execute(
          (marker) => window.__talkakTest.liveTerminalLines().join("\n").includes(marker),
          enabled ? "MEMORY_BYPASS_OK" : "MEMORY_OFF_POLICY_ON",
        ),
      );
      await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist();
      assert.equal(await $('[data-testid="retry-without-memory"]').isExisting(), false);
    }
    console.log(
      "MEMORY_DEFAULTS_OK: enabled by default, explicit opt-out persisted, failed launch retried without memory",
    );
  });
});

async function invoke(command, request) {
  return browser.execute(
    async (name, input) => window.__TAURI__.core.invoke(name, { request: input }),
    command,
    request,
  );
}

async function verifyLaunchConnections(noteId, marker) {
  // A configurable executable records the actual PTY arguments, without calling any model.
  // Rust is already required by both native CI jobs; the installed product does not need it.
  const fixture = mkdtempSync(join(tmpdir(), "talkak-memory-launch-"));
  const source = join(fixture, "probe.rs");
  const executable = join(fixture, process.platform === "win32" ? "probe.exe" : "probe");
  writeFileSync(
    source,
    `fn main() {
      let args: Vec<String> = std::env::args().skip(1).collect();
      if args.windows(2).any(|pair| pair == ["debug", "prompt-input"]) {
        println!("{}", r#"[{"role":"developer","content":[{"text":"USER_STARTUP_RULE"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["generic.developer_instructions"]}}]"#);
        return;
      }
      for arg in args { println!("{}", arg.replace('\\n', "\\u{1e}")); }
    }`,
  );
  execFileSync("rustc", [source, "-o", executable], { timeout: 30_000 });
  for (const memory of ["mcp-json", "mcp-toml"]) {
    const sessionId = `memory-probe-${memory}-${Date.now()}`;
    await invoke("session_spawn", {
      sessionId,
      cwd: projectPath,
      command: executable,
      args: ["user-argument-preserved"],
      memory,
      cols: 160,
      rows: 24,
    });
    try {
      let output;
      await browser.waitUntil(async () => {
        output = await invoke("session_read", { sessionId, after: 0 });
        return output.readClosed;
      });
      assert.equal(output.exitCode, 0);
      const args = Buffer.from(output.bytes, "base64")
        .toString("utf8")
        .trim()
        .split(/\r?\n/)
        .map((arg) => arg.replaceAll("\u001e", "\n"));
      assert.ok(args.includes("user-argument-preserved"));
      const policy =
        memory === "mcp-json"
          ? args[args.indexOf("--append-system-prompt") + 1]
          : JSON.parse(
              args
                .find((arg) => arg.startsWith("developer_instructions="))
                .slice("developer_instructions=".length),
            );
      assert.ok(
        policy.includes("Stop when the requested outcome and its necessary checks are satisfied."),
      );
      assert.ok(policy.includes(noteId));
      assert.ok(!policy.includes(marker));
      if (memory === "mcp-toml") assert.ok(policy.includes("USER_STARTUP_RULE"));
      let server;
      if (memory === "mcp-json") {
        assert.equal(args[0], "--mcp-config");
        server = JSON.parse(args[1]).mcpServers.talkak_memory;
      } else {
        assert.equal(args[0], "-c");
        assert.equal(args[2], "-c");
        server = {
          command: JSON.parse(args[1].slice("mcp_servers.talkak_memory.command=".length)),
          args: JSON.parse(args[3].slice("mcp_servers.talkak_memory.args=".length)),
        };
      }
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "memory_read", arguments: { id: noteId } },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n");
      const response = spawnSync(server.command, server.args, {
        input: `${input}\n`,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(response.status, 0, response.stderr || response.error?.message);
      const replies = response.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(replies.length, 2);
      assert.ok(replies[0].result.instructions.includes(noteId));
      assert.ok(!replies[0].result.instructions.includes(marker));
      assert.ok(replies[0].result.instructions.includes("Talkak session defaults."));
      assert.ok(Buffer.byteLength(JSON.stringify(replies[0]), "utf8") <= 8192);
      const record = JSON.parse(replies[1].result.content[0].text);
      assert.equal(record.id, noteId);
      assert.ok(record.body.includes(marker));
    } finally {
      await invoke("session_discard", { sessionId });
    }
  }
  console.log(
    "MEMORY_NATIVE_MCP_OK: both launch adapters read the selected UI note without auto-injecting its body",
  );
}

async function search(query) {
  return browser.execute(async (args) => window.__TAURI__.core.invoke("memory_search", args), {
    projectPath,
    query,
  });
}

async function openMemory() {
  if (!(await $(".project-memory").isExisting())) {
    await (await $('button[data-testid="open-summary"]')).click();
  }
  const details = await $(".project-memory");
  await details.waitForExist();
  if ((await details.getAttribute("open")) === null) await (await details.$("summary")).click();
  await (await $(".project-memory__search")).waitForExist();
}
