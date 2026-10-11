import { runAgentsSubcommand } from "./agents";
import { runChannelsSubcommand } from "./channels";
import { runConnectSubcommand } from "./connect";
import { runCronSubcommand } from "./cron";
import { runLocalBackendSubcommand } from "./local-backend";
import { runMcpSubcommand } from "./mcp";
import { runMemorySubcommand } from "./memory";
import { runMessagesSubcommand } from "./messages";
import { runModelSubcommand } from "./model";
import { runModsSubcommand } from "./mods";
import { runRecallSubcommand } from "./recall";
import { runSecretSubcommand } from "./secret";
import { runServerSubcommand } from "./server";
import { runInstallSubcommand, runSkillsSubcommand } from "./skills";
import { runStepsSubcommand } from "./steps";
import { runTrajectoriesSubcommand } from "./trajectories";

async function runVersionSubcommand(): Promise<number> {
  const { getVersion } = await import("@/version");
  console.log(`${getVersion()} (Haruyuki)`);
  return 0;
}

export function subcommandNeedsEarlyBackendMode(
  command: string | undefined,
): boolean {
  switch (command) {
    case "app-server":
    case "channel-gateway":
    case "agents":
    case "connect":
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
      return runMemorySubcommand(rest);
    case "agents":
      return runAgentsSubcommand(rest);
    case "model":
    case "models": // alias
      return runModelSubcommand(rest);
    case "app-server":
      console.error(
        "Warning: `haruyuki app-server` is deprecated. Use `haruyuki server` instead.",
      );
      return runServerSubcommand(rest);
    case "messages":
      return runMessagesSubcommand(rest);
    case "steps":
      return runStepsSubcommand(rest);
    case "mcp":
      return runMcpSubcommand(rest);
    case "mods":
      return runModsSubcommand(rest);
    case "recall":
      return runRecallSubcommand(rest);
    case "secret":
      return runSecretSubcommand(rest);
    case "server":
      return runServerSubcommand(rest);
    case "connect":
      return runConnectSubcommand(rest);
    case "install":
      return runInstallSubcommand(rest);
    case "skills":
      return runSkillsSubcommand(rest);
    case "cron":
      return runCronSubcommand(rest);
    case "channels":
      return runChannelsSubcommand(rest);
    case "channel-gateway": {
      const { runChannelGatewaySubcommand } = await import("./channel-gateway");
      return runChannelGatewaySubcommand(rest);
    }
    case "local-backend":
      return runLocalBackendSubcommand(rest);
    case "trajectories":
    case "trajectory": // alias
      return runTrajectoriesSubcommand(rest);
    default:
      return null;
  }
}
