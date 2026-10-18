// References to the template's own GitHub repos and the agent's name, which
// rename.rb leaves unchanged so generated apps keep working links
// (github.com/nativeapptemplate/NativeAppTemplate-iOS, not a dead
// github.com/orangebaton/OrangeBaton-iOS). Mirrors PROTECTED_REFERENCE in
// scripts/ruby/rename.rb; Layer 1 skips tokens inside these spans.
// nativeapptemplate.com domains and emails are deliberately not here: they are
// renamed to the app's own.
const PROTECTED_REFERENCE_SOURCE = [
  String.raw`github\.com[/:]nativeapptemplate(?![A-Za-z0-9_-])(?:/[^\s)\]"'<>\x60]*)?`,
  String.raw`(?<![A-Za-z0-9_-])nativeapptemplate-agent(?:-mcp)?(?![A-Za-z0-9_])`,
].join("|");

export function protectedSpans(line: string): Array<[start: number, end: number]> {
  if (!line.includes("nativeapptemplate")) return [];
  const regex = new RegExp(PROTECTED_REFERENCE_SOURCE, "g");
  return [...line.matchAll(regex)].map((m) => [m.index, m.index + m[0].length]);
}
