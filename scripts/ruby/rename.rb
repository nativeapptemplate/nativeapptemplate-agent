#!/usr/bin/env ruby
#
# Apply a rename plan to a Rails project tree.
# Stdin:  { "renamePlan": [{"from":"Shop","to":"Clinic"}, ...],
#          "japaneseRenamePlan": [{"from":"店舗","to":"医院"}, ...],  (optional)
#          "appDomain": {"domain":"orangebaton.app",                 (optional)
#                        "bundleIdPrefix":"app.orangebaton",
#                        "androidPackagePrefix":"app.orangebaton"},
#          "root": "/abs/path" }
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
require "fileutils"

input = JSON.parse($stdin.read)
plan  = input.fetch("renamePlan")
japanese_plan = input.fetch("japaneseRenamePlan", [])
app_domain = input["appDomain"]
root  = input.fetch("root")

stats = { files_scanned: 0, files_changed: 0, substitutions: 0, files_renamed: 0 }

SKIP_DIR_SEGMENTS = %w[.git node_modules tmp log DerivedData Pods Carthage xcuserdata .build build .gradle .idea .kotlin captures].freeze
SKIP_SUBPATHS     = %w[vendor/bundle app/assets/builds public/assets].freeze
TEXT_EXTS         = %w[
  .rb .erb .yml .yaml .json .md .gemspec .rake .ru .txt .sample .example .conf
  .html .css .scss .js .mjs .tt .lock
  .swift .plist .strings .xcstrings .xcconfig .entitlements .pbxproj .xcworkspacedata .modulemap .xcscheme
  .kt .kts .xml .gradle .pro .toml .properties .cfg
  .proto
  .svg .webmanifest
].freeze
TEXT_BASENAMES    = %w[
  Gemfile Gemfile.lock Rakefile Procfile Procfile.dev
  .gitignore .env.sample .ruby-version .node-version
  config.ru Dockerfile
  secrets secrets-common
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
  # SCREAMING form: the upper case of whatever its lower-case spelling becomes.
  # A one-word `from` has a single lower-case spelling (snake == flat) and the
  # snake pattern above wins for it, so `nativeapptemplateapi` becomes
  # `barber_queue_api`; NATIVEAPPTEMPLATEAPI must then become BARBER_QUEUE_API,
  # not BARBERQUEUEAPI, or code that derives one from the other breaks (the
  # API's deploy test checks `$#{SERVICE.upcase}_SENTRY_DSN` in .kamal/secrets).
  # A multi-word `from` (NativeAppTemplate) keeps the flat form, matching its
  # flat lower-case rename (NATIVEAPPTEMPLATE_API_DOMAIN -> CLINICQUEUE_API_DOMAIN).
  one_word      = from_snake == from_flat
  to_upper      = one_word ? to_snake.upcase : to.upcase
  to_upper_pl   = one_word ? to_snake_pl.upcase : to_pl.upcase
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
  # SCREAMING tokens also follow Gradle's `-P` (`-PNATIVEAPPTEMPLATE_SENTRY_DSN=...`
  # in the Android template's docs and build script comments).
  upper_l  = "(?:(?<![A-Za-z])|(?<=-P))"

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
    [/#{upper_l}#{Regexp.escape(from_pl.upcase)}(?![A-Za-z])/, to_upper_pl],
    [/#{upper_l}#{Regexp.escape(from.upcase)}(?![A-Za-z])/,    to_upper],
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

# Japanese has no word boundaries and its nouns don't inflect, so a plain
# substring covers compounds (店舗名) and every sentence the noun appears in.
# Longest first, so a noun inside another (タグ in アイテムタグ) can't win.
japanese_patterns = japanese_plan
  .sort_by { |p| -p.fetch("from").length }
  .map { |p| [/#{Regexp.escape(p.fetch("from"))}/, p.fetch("to")] }

# The template's domain and reverse-DNS prefix, when the app has a domain of
# its own (src/app-domain.ts). Matched whole before any product-name pattern
# can reach the `nativeapptemplate` inside them; the single-pass substitution
# below then renames what follows the prefix
# (com.nativeapptemplate.NativeAppTemplate.ios -> app.orangebaton.OrangeBaton.ios)
# and never re-scans the replaced text. The Android package (the lowercase
# product after the prefix, also in google-services.json and the API's FCM
# test) takes the Java-safe prefix; every other com.nativeapptemplate (iOS
# bundle IDs, keychain services, log subsystems) the plain reverse domain. Without appDomain these are absent and
# the flat product rule turns both into <flat product>.com / com.<flat product>.
def domain_patterns(app_domain)
  return [] unless app_domain

  domain  = app_domain.fetch("domain")
  bundle  = app_domain.fetch("bundleIdPrefix")
  package = app_domain.fetch("androidPackagePrefix")
  android_product = "nativeapptemplate[a-z0-9]*(?![A-Za-z0-9_])"
  [
    [/(?<![A-Za-z0-9_-])nativeapptemplate\.com(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/, domain],
    [/(?<![A-Za-z0-9_.-])com\.nativeapptemplate(?=\.#{android_product})/, package],
    [/(?<![A-Za-z0-9_-])com\/nativeapptemplate(?=\/#{android_product})/, package.tr(".", "/")],
    [/(?<![A-Za-z0-9_.-])com\.nativeapptemplate(?![A-Za-z0-9_-])/, bundle],
  ]
end

all_patterns = domain_patterns(app_domain) + japanese_patterns + plan.flat_map { |p| build_patterns(p.fetch("from"), p.fetch("to")) }

# One combined regex, applied in a single pass, so a replacement is never
# re-scanned by a later pair: with NativeAppTemplate→PetShop and Shop→Store,
# sequential gsubs would turn the fresh "PetShop" into "PetStore". At any
# position the alternation tries patterns in plan order, which preserves the
# per-pair priority above (plural before singular, snake before flat).
COMBINED = Regexp.new(all_patterns.each_with_index.map { |(regex, _), i| "(?<p#{i}>#{regex.source})" }.join("|"))
REPLACEMENTS = all_patterns.map(&:last)

def rename_all(text)
  count = 0
  result = text.gsub(COMBINED) do
    m = Regexp.last_match
    count += 1
    REPLACEMENTS[REPLACEMENTS.each_index.find { |i| m["p#{i}"] }]
  end
  [result, count]
end

# References to the template's own GitHub repos and the agent's name are left
# byte-for-byte as they are: renamed, they become dead links
# (github.com/orangebaton/OrangeBaton-iOS) and a tool that doesn't exist
# (orangebaton-agent). They are masked with placeholders before the
# substitution and restored after it, so nothing inside them is renamed: not
# the product name, nor a Shop / ItemTag token in a URL path. The product's
# domains and emails (nativeapptemplate.com) are not protected; they become
# the app's own. Mirrored in src/validation/protected-references.ts, which
# keeps Layer 1 from flagging what is left here.
PROTECTED_REFERENCE = %r{
  github\.com[/:]nativeapptemplate(?![A-Za-z0-9_-])(?:/[^\s)\]"'<>`]*)?
  |
  (?<![A-Za-z0-9_-])nativeapptemplate-agent(?:-mcp)?(?![A-Za-z0-9_])
}x
MASK_OPEN  = "\u{E000}"
MASK_CLOSE = "\u{E001}"
MASK       = /#{MASK_OPEN}(\d+)#{MASK_CLOSE}/

def rename_content(text)
  # A file that already holds the sentinel can't be masked unambiguously.
  return rename_all(text) if text.include?(MASK_OPEN)

  spans = []
  masked = text.gsub(PROTECTED_REFERENCE) do
    spans << Regexp.last_match(0)
    "#{MASK_OPEN}#{spans.length - 1}#{MASK_CLOSE}"
  end
  result, count = rename_all(masked)
  [result.gsub(MASK) { spans[Regexp.last_match(1).to_i] }, count]
end

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
  next if File.symlink?(path)
  next unless File.file?(path)
  next if skip?(path, root)
  next unless text_file?(path)

  stats[:files_scanned] += 1

  begin
    original = File.read(path, encoding: "UTF-8")
  rescue StandardError
    next
  end
  unless original.valid_encoding?
    warn "rename.rb: skipping non-UTF-8 file #{path}"
    next
  end

  content, local_subst = rename_content(original)
  next if content == original

  File.write(path, content)
  stats[:files_changed] += 1
  stats[:substitutions] += local_subst
end

# Pass 1.5 — move the Android package directories (<source root>/com/
# nativeapptemplate/nativeapptemplate) under the app's package prefix
# (app/orangebaton/nativeapptemplate; Pass 2 then renames the last segment).
# The directories made for the prefix are pinned so Pass 2 leaves them as they
# are even when a domain label happens to be a rename token (shop.example).
pinned = {}
if app_domain
  package_dirs = app_domain.fetch("androidPackagePrefix").split(".")
  Dir.glob("#{root}/**/com/nativeapptemplate", File::FNM_DOTMATCH).sort.each do |template_dir|
    next if skip?(template_dir, root)
    next unless File.directory?(template_dir) && !File.symlink?(template_dir)
    next unless Dir.children(template_dir).any? { |c| c.match?(/\Anativeapptemplate[a-z0-9]*\z/) }

    source_root = File.dirname(File.dirname(template_dir))
    target = File.join(source_root, *package_dirs)
    if File.exist?(target)
      warn "rename.rb: not moving #{template_dir}: #{target} already exists"
      next
    end
    FileUtils.mkdir_p(File.dirname(target))
    File.rename(template_dir, target)
    stats[:files_renamed] += 1
    com_dir = File.dirname(template_dir)
    # Finder's .DS_Store alone doesn't keep the template's com/ directory.
    leftovers = Dir.children(com_dir)
    if leftovers.all? { |c| c == ".DS_Store" }
      leftovers.each { |c| File.delete(File.join(com_dir, c)) }
      Dir.rmdir(com_dir)
    end
    package_dirs.each_index { |i| pinned[File.join(source_root, *package_dirs[0..i])] = true }
  end
end

# Pass 2 — rename paths. Deepest-first so renaming a parent directory
# doesn't invalidate paths we haven't visited yet.
Dir.glob("#{root}/**/*", File::FNM_DOTMATCH).sort_by { |p| -p.length }.each do |path|
  next if skip?(path, root)
  next if pinned[path]
  next unless File.exist?(path)

  old_name = File.basename(path)
  new_name, = rename_all(old_name)
  next if new_name == old_name

  new_path = File.join(File.dirname(path), new_name)
  next if File.exist?(new_path)

  File.rename(path, new_path)
  stats[:files_renamed] += 1
end

puts JSON.generate(stats)
