/**
 * Subcommand dispatch.
 *
 * Every subcommand is imported on demand. The CLI entry imports this module
 * before it knows what the user asked for, so a static import here would drag
 * the whole subcommand graph (listener, backend, tools, providers) into every
 * invocation — including `haruyuki schedule tick`, which the OS timer wakes once
 * a minute and which must stay cheap when nothing is due (C-24, R-5.3.2).
 *
 * `subcommandNeedsEarlyBackendMode` stays synchronous and import-free: it runs
 * before any subcommand module is loaded.
 */

async function runVersionSubcommand(): Promise<number> {
  const { getVersion } = await import("@/version");
  console.log(`${getVersion()} (Haruyuki)`);
  return 0;
}

// The snapshot commands pull in the archive and import pipelines, and `--help`
// must stay cheap. Both read local data roots, so they also appear in
// `subcommandNeedsEarlyBackendMode`.
async function runSnapshotExportSubcommand(argv: string[]): Promise<number> {
  const { runSnapshotExport } = await import("./snapshot/cli");
  return runSnapshotExport(argv);
}

async function runSnapshotImportSubcommand(argv: string[]): Promise<number> {
  const { runSnapshotImport } = await import("./snapshot/cli");
  return runSnapshotImport(argv);
}

export function subcommandNeedsEarlyBackendMode(
  command: string | undefined,
): boolean {
  switch (command) {
    case "app-server":
    case "channel-gateway":
    case "agents":
    case "connect":
    case "export":
    case "import":
    case "install":
    case "memfs":
    case "memory":
    case "messages":
    case "steps":
    case "mcp":
    case "model":
    case "models":
    case "mods":
    case "recall":
    case "secret":
    case "server":
    case "skills":
      return true;
    default:
      return false;
  }
}

export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  if (!command) {
    return null;
  }

  switch (command) {
    case "version":
      return runVersionSubcommand();
    case "memory":
    case "memfs": // legacy alias
      return (await import("./memory")).runMemorySubcommand(rest);
    case "agents":
      return (await import("./agents")).runAgentsSubcommand(rest);
    case "model":
    case "models": // alias
      return (await import("./model")).runModelSubcommand(rest);
    case "app-server":
      console.error(
        "Warning: `haruyuki app-server` is deprecated. Use `haruyuki server` instead.",
      );
      return (await import("./server")).runServerSubcommand(rest);
    case "messages":
      return (await import("./messages")).runMessagesSubcommand(rest);
    case "steps":
      return (await import("./steps")).runStepsSubcommand(rest);
    case "mcp":
      return (await import("./mcp")).runMcpSubcommand(rest);
    case "mods":
      return (await import("./mods")).runModsSubcommand(rest);
    case "recall":
      return (await import("./recall")).runRecallSubcommand(rest);
    case "secret":
      return (await import("./secret")).runSecretSubcommand(rest);
    case "server":
      return (await import("./server")).runServerSubcommand(rest);
    case "connect":
      return (await import("./connect")).runConnectSubcommand(rest);
    case "install":
      return (await import("./skills")).runInstallSubcommand(rest);
    case "skills":
      return (await import("./skills")).runSkillsSubcommand(rest);
    case "cron":
      return (await import("./cron")).runCronSubcommand(rest);
    case "schedule":
      // Deliberately NOT in `subcommandNeedsEarlyBackendMode`: the whole point
      // of `schedule tick` is to exit before the backend is configured (C-24).
      return (await import("./schedule")).runScheduleSubcommand(rest);
    case "channels":
      return (await import("./channels")).runChannelsSubcommand(rest);
    case "channel-gateway":
      return (await import("./channel-gateway")).runChannelGatewaySubcommand(
        rest,
      );
    case "local-backend":
      return (await import("./local-backend")).runLocalBackendSubcommand(rest);
    case "export":
      return runSnapshotExportSubcommand(rest);
    case "import":
      return runSnapshotImportSubcommand(rest);
    case "trajectories":
    case "trajectory": // alias
      return (await import("./trajectories")).runTrajectoriesSubcommand(rest);
    default:
      return null;
  }
}
