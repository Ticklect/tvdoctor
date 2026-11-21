import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = path.join(repositoryRoot, "fixtures", "broken-streaming-web", "dist");
const cliDist = path.join(repositoryRoot, "packages", "cli", "dist");
const destination = path.join(cliDist, "demo-fixture");

const resolvedCliDist = path.resolve(cliDist);
const resolvedDestination = path.resolve(destination);
if (path.dirname(resolvedDestination) !== resolvedCliDist
  || path.basename(resolvedDestination) !== "demo-fixture") {
  throw new Error(`Refusing to stage the demo into an unsafe path: ${resolvedDestination}`);
}

const sourceIndex = path.join(source, "index.html");
const sourceIndexMetadata = await stat(sourceIndex);
if (!sourceIndexMetadata.isFile() || sourceIndexMetadata.size === 0) {
  throw new Error("Northstar fixture build is missing. Run npm run build:fixture before staging the demo.");
}

await mkdir(resolvedCliDist, { recursive: true });
await rm(resolvedDestination, { recursive: true, force: true });
await cp(source, resolvedDestination, { recursive: true, force: false });

const stagedIndex = await stat(path.join(resolvedDestination, "index.html"));
if (!stagedIndex.isFile() || stagedIndex.size === 0) {
  throw new Error("Staged Northstar demo fixture is incomplete.");
}
process.stdout.write(`Staged Northstar demo fixture: ${resolvedDestination}\n`);
