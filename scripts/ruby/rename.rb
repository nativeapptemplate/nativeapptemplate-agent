#!/usr/bin/env ruby
#
# Apply a rename plan to a Rails project tree.
# Stdin:  { "renamePlan": [{"from":"Shop","to":"Clinic"}, ...], "root": "/abs/path" }
# Stdout: { "files_scanned": N, "files_changed": N, "substitutions": N, "files_renamed": N }
#
# Rewrites file content AND renames files/directories for every
# PascalCase / snake_case / plural variant of each rename pair.
# Word-boundary matching via Regexp; crude-but-sufficient English
# pluralization. Skips .git, node_modules, tmp/, log/, vendor/bundle/.

require "json"

input = JSON.parse($stdin.read)
plan  = input.fetch("renamePlan")
root  = input.fetch("root")

stats = { files_scanned: 0, files_changed: 0, substitutions: 0, files_renamed: 0 }

SKIP_DIR_SEGMENTS = %w[.git node_modules tmp log DerivedData Pods Carthage xcuserdata .build build .gradle .idea .kotlin captures].freeze
SKIP_SUBPATHS     = %w[vendor/bundle].freeze
TEXT_EXTS         = %w[
  .rb .erb .yml .yaml .json .md .gemspec .rake .ru .txt .sample .example .conf
  .html .css .scss .js .mjs .tt .lock
  .swift .plist .strings .xcconfig .entitlements .pbxproj .xcworkspacedata .modulemap
  .kt .kts .xml .gradle .pro .toml .properties .cfg
].freeze
TEXT_BASENAMES    = %w[
  Gemfile Gemfile.lock Rakefile Procfile Procfile.dev
  .gitignore .env.sample .ruby-version .node-version
  config.ru Dockerfile
  Podfile Podfile.lock Package.swift Cartfile Makefile
  gradlew gradlew.bat gradle.properties local.properties
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

def build_patterns(from, to)
  from_snake    = snake_case(from)
  to_snake      = snake_case(to)
  from_snake_pl = pluralize(from_snake)
  to_snake_pl   = pluralize(to_snake)
  from_pl       = pluralize(from)
  to_pl         = pluralize(to)

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

  [
    [/#{pascal_l}#{Regexp.escape(from_pl)}#{pascal_r}/,     to_pl],
    [/#{pascal_l}#{Regexp.escape(from)}#{pascal_r}/,        to],
    [/#{snake_l}#{Regexp.escape(from_snake_pl)}#{snake_r}/, to_snake_pl],
    [/#{snake_l}#{Regexp.escape(from_snake)}#{snake_r}/,    to_snake],
    [/#{snake_l}#{Regexp.escape(from_pl.upcase)}(?![A-Za-z])/, to_pl.upcase],
    [/#{snake_l}#{Regexp.escape(from.upcase)}(?![A-Za-z])/,    to.upcase],
  ]
end

all_patterns = plan.flat_map { |p| build_patterns(p.fetch("from"), p.fetch("to")) }

def skip?(path)
  return true if SKIP_DIR_SEGMENTS.any? { |d| path.include?("/#{d}/") || path.end_with?("/#{d}") }
  return true if SKIP_SUBPATHS.any? { |sp| path.include?("/#{sp}") }
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
  next if skip?(path)
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
  next if skip?(path)
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
