import "@/utils/startup-log-boundary";

// C-24/P1-6: `schedule tick` must be a light process-level entry. Dispatch it
// before the pi-ai OAuth bootstrap and before the heavy application index, so
// the short-lived host never loads the backend, providers, tools or listener.
const [command, ...rest] = process.argv.slice(2);
if (command === "schedule") {
  const { runScheduleSubcommand } = await import("./cli/subcommands/schedule");
  process.exit(await runScheduleSubcommand(rest));
}

const { registerBunOAuthFlows } = await import(
  "@earendil-works/pi-ai/bun-oauth"
);
// pi-ai keeps Node-only OAuth implementations behind bundler-opaque imports.
// Register the statically bundled loaders before the application imports any
// provider runtime so the standalone haruyuki.js never looks for sibling files.
// This mirrors pi's standalone CLI bootstrap for the pinned pi-ai release:
// https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/bun/cli.ts#L2-L12
registerBunOAuthFlows();

await import("./index");
