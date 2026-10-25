import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A generated app is a new product, so its first store upload is 1.0.0 (1),
// not the template's own release number.
export const FIRST_VERSION_NAME = "1.0.0";
export const FIRST_BUILD_NUMBER = 1;

export function resetPbxprojVersion(pbxproj: string): string {
  return pbxproj
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${FIRST_VERSION_NAME};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${FIRST_BUILD_NUMBER};`);
}

export function resetGradleVersion(buildGradle: string): string {
  return buildGradle
    .replace(/versionCode = \d+/, `versionCode = ${FIRST_BUILD_NUMBER}`)
    .replace(/versionName = "[^"]*"/, `versionName = "${FIRST_VERSION_NAME}"`);
}

export async function resetIosVersion(outDir: string): Promise<void> {
  const project = (await readdir(outDir)).find((name) => name.endsWith(".xcodeproj"));
  if (!project) return;
  const path = join(outDir, project, "project.pbxproj");
  await writeFile(path, resetPbxprojVersion(await readFile(path, "utf8")));
}

export async function resetAndroidVersion(outDir: string): Promise<void> {
  const path = join(outDir, "app", "build.gradle.kts");
  await writeFile(path, resetGradleVersion(await readFile(path, "utf8")));
}
