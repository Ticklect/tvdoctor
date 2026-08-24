import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

function loadPackageVersion(): string {
  let metadata: PackageMetadata;
  try {
    metadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageMetadata;
  } catch (error) {
    throw new Error("Unable to read TVDoctor package metadata.", { cause: error });
  }

  if (metadata.name !== "tvdoctor"
    || typeof metadata.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)) {
    throw new Error("TVDoctor package metadata does not contain a valid version.");
  }
  return metadata.version;
}

export const CLI_VERSION = loadPackageVersion();

