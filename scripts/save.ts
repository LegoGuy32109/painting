/**
 * Formats, checks, commits, and pushes the current branch.
 *
 * Usage: deno task save "feat: describe the change"
 */

const message = Deno.args.join(" ").trim();
if (!message) {
  throw new Error('usage: deno task save "commit message"');
}

async function run(command: string, args: string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function output(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, { args }).output();
  if (!result.success) throw new Error(`${command} ${args.join(" ")} failed`);
  return new TextDecoder().decode(result.stdout).trim();
}

const branch = await output("git", ["branch", "--show-current"]);
if (!branch) throw new Error("cannot save from a detached HEAD");
if (branch === "master") console.warn("WARNING: saving directly to master");

await run(Deno.execPath(), ["fmt"]);
await run(Deno.execPath(), ["task", "check"]);
await run("git", ["add", "-A"]);

const staged = await new Deno.Command("git", {
  args: ["diff", "--cached", "--quiet"],
}).output();
if (staged.code === 0) throw new Error("nothing to commit");
if (staged.code !== 1) throw new Error("could not inspect staged changes");

await run("git", ["commit", "-m", message]);
await run("git", ["push", "origin", branch]);
