import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The templates are signed with their author's Apple team, and their
// SAMPLE_CODE_DISAMBIGUATOR is ${DEVELOPMENT_TEAM}, so the team also ends the
// Debug bundle ID. A generated app is someone else's product: clear the team,
// and Xcode asks for the developer's own on the first device build (simulator
// builds need none).
export function clearPbxprojTeam(pbxproj: string): string {
  return pbxproj.replace(/DEVELOPMENT_TEAM = [^;]+;/g, 'DEVELOPMENT_TEAM = "";');
}

export async function clearIosTeam(outDir: string): Promise<void> {
  const project = (await readdir(outDir)).find((name) => name.endsWith(".xcodeproj"));
  if (!project) return;
  const path = join(outDir, project, "project.pbxproj");
  await writeFile(path, clearPbxprojTeam(await readFile(path, "utf8")));
}
