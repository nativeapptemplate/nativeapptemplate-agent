#!/usr/bin/env ruby
#
# Apply a rename plan to a Rails project tree.
# Stdin:  { "renamePlan": [{"from":"Shop","to":"Clinic"}, ...], "root": "/abs/path" }
# Stdout: { "files_scanned": N, "files_changed": N, "substitutions": N, "files_renamed": N }
#
# Rewrites file content AND renames files/directories for every
# PascalCase / snake_case / plural variant of each rename pair.
# Word-boundary matching via Regexp; crude-but-sufficient English
# pluralization. Skips .git, node_modules, tmp/, log/, vendor/bundle/,
# and compiled build output (app/assets/builds, public/assets) — those
# are regenerated from source by the bundler, so renaming them desyncs
# them from their (un-renamed) sources, e.g. Turbo's VisitState.completed.

require "json"

input = JSON.parse($stdin.read)
plan  = input.fetch("renamePlan")
root  = input.fetch("root")

stats = { files_scanned: 0, files_changed: 0, substitutions: 0, files_renamed: 0 }

SKIP_DIR_SEGMENTS = %w[.git node_modules tmp log DerivedData Pods Carthage xcuserdata .build build .gradle .idea .kotlin captures].freeze
SKIP_SUBPATHS     = %w[vendor/bundle app/assets/builds public/assets].freeze
TEXT_EXTS         = %w[
  .rb .erb .yml .yaml .json .md .gemspec .rake .ru .txt .sample .example .conf
  .html .css .scss .js .mjs .tt .lock
  .swift .plist .strings .xcconfig .entitlements .pbxproj .xcworkspacedata .modulemap .xcscheme
  .kt .kts .xml .gradle .pro .toml .properties .cfg
  .proto
  .svg .webmanifest
].freeze
TEXT_BASENAMES    = %w[
  Gemfile Gemfile.lock Rakefile Procfile Procfile.dev
  .gitignore .env.sample .ruby-version .node-version
  config.ru Dockerfile
  Podfile Podfile.lock Package.swift Cartfile Makefile
  gradlew gradlew.bat gradle.properties local.properties
  brakeman.ignore .swiftformat
].freeze

def pluralize(word)
  if word.end_with?("y") && word.length > 1 && !%w[a e i o u].include?(word[-2])
    word[0..-2] + "ies"
  elsif word.end_with?("s", "sh", "ch", "x", "z")
    word + "es"
  else
    word + "s"
  end
end

def snake_case(pascal)
  pascal.gsub(/([a-z\d])([A-Z])/, '\1_\2')
        .gsub(/([A-Z]+)([A-Z][a-z])/, '\1_\2')
        .downcase
end

def camel_case(pascal)
  return pascal if pascal.empty?
  pascal[0].downcase + pascal[1..]
end

def humanize_lower(pascal)
  snake_case(pascal).tr("_", " ")
end

def humanize_title(pascal)
  humanize_lower(pascal).split(" ").map(&:capitalize).join(" ")
end

def first_char_up(s)
  s.empty? ? s : s[0].upcase + s[1..]
end

def build_patterns(from, to)
  from_snake    = snake_case(from)
  to_snake      = snake_case(to)
  from_snake_pl = pluralize(from_snake)
  to_snake_pl   = pluralize(to_snake)
  from_pl       = pluralize(from)
  to_pl         = pluralize(to)
  from_flat     = from.downcase
  to_flat       = to.downcase
  from_flat_pl  = from_flat + "s"
  to_flat_pl    = to_flat + "s"
  from_camel    = camel_case(from)
  to_camel      = camel_case(to)
  from_camel_pl = pluralize(from_camel)
  to_camel_pl   = pluralize(to_camel)
  from_human_lo    = humanize_lower(from)
  to_human_lo      = humanize_lower(to)
  from_human_ti    = humanize_title(from)
  to_human_ti      = humanize_title(to)
  from_human_se    = first_char_up(from_human_lo)
  to_human_se      = first_char_up(to_human_lo)
  from_human_lo_pl = from_snake_pl.tr("_", " ")
  to_human_lo_pl   = to_snake_pl.tr("_", " ")
  from_human_ti_pl = from_human_lo_pl.split(" ").map(&:capitalize).join(" ")
  to_human_ti_pl   = to_human_lo_pl.split(" ").map(&:capitalize).join(" ")
  from_human_se_pl = first_char_up(from_human_lo_pl)
  to_human_se_pl   = first_char_up(to_human_lo_pl)

  # Ruby's \b treats `_` as a word char, so \bshop\b doesn't fire
  # inside `shop_id` or `accounts_shopkeeper`. Hand-rolled boundaries:
  #   - PascalCase token: preceded by non-letter OR lowercase letter
  #     (PascalCase compound like `LoggedInShopkeeper`); followed by
  #     non-letter OR uppercase (next PascalCase word).
  #   - snake_case / lowercase token: preceded by non-letter;
  #     followed by non-letter OR uppercase (camelCase compound
  #     like `shopId`).
  #
  # Order matters: plural forms first so "Shops" isn't partially-
  # matched as "Shop" + residual "s".
  pascal_l = "(?:(?<![A-Za-z])|(?<=[a-z]))"
  pascal_r = "(?:(?![A-Za-z])|(?=[A-Z]))"
  snake_l  = "(?<![A-Za-z])"
  snake_r  = "(?:(?![A-Za-z])|(?=[A-Z]))"

  patterns = [
    [/#{pascal_l}#{Regexp.escape(from_pl)}#{pascal_r}/,     to_pl],
    [/#{pascal_l}#{Regexp.escape(from)}#{pascal_r}/,        to],
    [/#{snake_l}#{Regexp.escape(from_snake_pl)}#{snake_r}/, to_snake_pl],
    [/#{snake_l}#{Regexp.escape(from_snake)}#{snake_r}/,    to_snake],
    # flat-lowercase (runs AFTER snake so single-word rename pairs
    # where flat == snake can't win over snake's replacement; catches
    # multi-word compounds collapsed in URLs / package names /
    # email addresses, e.g. `nativeapptemplate.com`).
    [/#{snake_l}#{Regexp.escape(from_flat_pl)}#{snake_r}/,  to_flat_pl],
    [/#{snake_l}#{Regexp.escape(from_flat)}#{snake_r}/,     to_flat],
    # camelCase — first char lowercased, rest PascalCase. Catches
    # the common Kotlin/Swift field-accessor form like `itemTag`
    # (from `ItemTag`) or `itemTagInfoFromNdefMessage`.
    [/#{snake_l}#{Regexp.escape(from_camel_pl)}#{snake_r}/, to_camel_pl],
    [/#{snake_l}#{Regexp.escape(from_camel)}#{snake_r}/,    to_camel],
    [/#{snake_l}#{Regexp.escape(from_pl.upcase)}(?![A-Za-z])/, to_pl.upcase],
    [/#{snake_l}#{Regexp.escape(from.upcase)}(?![A-Za-z])/,    to.upcase],
  ]

  # Humanized display forms — three case shapes per number:
  #   lower    "item tag"  / "item tags"  (UI body text, prose)
  #   title    "Item Tag"  / "Item Tags"  (headings, button labels)
  #   sentence "Item tag"  / "Item tags"  (sentence start, error messages,
  #                                        OpenAPI descriptions)
  # Only meaningful when the PascalCase token is multi-word; for single
  # words all three humanized forms collapse to the flat / Pascal forms
  # already handled above. Plural patterns come first so "item tags"
  # isn't partially matched as "item tag" + residual "s".
  if from_human_lo.include?(" ")
    boundary = "(?<![A-Za-z])"
    boundary_r = "(?![A-Za-z])"
    human_patterns = [
      [/#{boundary}#{Regexp.escape(from_human_ti_pl)}#{boundary_r}/, to_human_ti_pl],
      [/#{boundary}#{Regexp.escape(from_human_ti)}#{boundary_r}/,    to_human_ti],
      [/#{boundary}#{Regexp.escape(from_human_se_pl)}#{boundary_r}/, to_human_se_pl],
      [/#{boundary}#{Regexp.escape(from_human_se)}#{boundary_r}/,    to_human_se],
      [/#{boundary}#{Regexp.escape(from_human_lo_pl)}#{boundary_r}/, to_human_lo_pl],
      [/#{boundary}#{Regexp.escape(from_human_lo)}#{boundary_r}/,    to_human_lo],
    ]
    patterns = human_patterns + patterns
  end

  patterns
end

all_patterns = plan.flat_map { |p| build_patterns(p.fetch("from"), p.fetch("to")) }

def skip?(path, root)
  # Compare against the path RELATIVE to the project root, not the absolute
  # path. Otherwise SKIP_DIR_SEGMENTS like "tmp" / "log" / "build" silently
  # match user-cwd ancestors (e.g. /tmp/myproject/...) and skip every file.
  rel = path.sub(/\A#{Regexp.escape(root)}\/?/, "")
  return false if rel == path  # path wasn't under root; don't skip
  segments = rel.split("/")
  return true if segments.any? { |seg| SKIP_DIR_SEGMENTS.include?(seg) }
  return true if SKIP_SUBPATHS.any? { |sp| rel.include?(sp) || rel.start_with?(sp) }
  false
end

def text_file?(path)
  basename = File.basename(path)
  return true if TEXT_BASENAMES.include?(basename)
  return true if TEXT_EXTS.include?(File.extname(path))
  false
end

# Pass 1 — rewrite file contents.
Dir.glob("#{root}/**/*", File::FNM_DOTMATCH).each do |path|
  next unless File.file?(path)
  next if skip?(path, root)
  next unless text_file?(path)

  stats[:files_scanned] += 1

  begin
    content = File.read(path, encoding: "UTF-8")
  rescue StandardError
    next
  end

  original = content.dup
  local_subst = 0
  all_patterns.each do |regex, replacement|
    content = content.gsub(regex) { local_subst += 1; replacement }
  end

  next if content == original

  File.write(path, content)
  stats[:files_changed] += 1
  stats[:substitutions] += local_subst
end

# Pass 2 — rename paths. Deepest-first so renaming a parent directory
# doesn't invalidate paths we haven't visited yet.
Dir.glob("#{root}/**/*", File::FNM_DOTMATCH).sort_by { |p| -p.length }.each do |path|
  next if skip?(path, root)
  next unless File.exist?(path)

  old_name = File.basename(path)
  new_name = old_name.dup
  all_patterns.each { |regex, replacement| new_name = new_name.gsub(regex, replacement) }
  next if new_name == old_name

  new_path = File.join(File.dirname(path), new_name)
  next if File.exist?(new_path)

  File.rename(path, new_path)
  stats[:files_renamed] += 1
end

puts JSON.generate(stats)
