import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_WINDOWS_INSTALL = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SMITE 2';
const OUTPUT_DIR = path.resolve('data', 'extracted', 'smite2');
const DEFAULT_FOCUS_GODS = ['Loki', 'Kali', 'Sol'];

function parseArgs(argv) {
  const parsed = {
    focusGods: DEFAULT_FOCUS_GODS,
  };

  for (const arg of argv) {
    if (arg.startsWith('--game-path=')) {
      parsed.gamePath = arg.slice('--game-path='.length);
      continue;
    }

    if (arg.startsWith('--focus=')) {
      const focus = arg
        .slice('--focus='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (focus.length > 0) {
        parsed.focusGods = focus;
      }
    }
  }

  return parsed;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveInstallPaths(requestedPath) {
  const normalized = path.resolve(requestedPath ?? DEFAULT_WINDOWS_INSTALL);
  const windowsCandidate = path.join(normalized, 'Windows');

  if (await pathExists(path.join(normalized, 'Manifest_UFSFiles_Win64.txt'))) {
    return {
      gameRoot: path.dirname(normalized),
      windowsRoot: normalized,
    };
  }

  if (await pathExists(path.join(windowsCandidate, 'Manifest_UFSFiles_Win64.txt'))) {
    return {
      gameRoot: normalized,
      windowsRoot: windowsCandidate,
    };
  }

  throw new Error(
    `Could not find Manifest_UFSFiles_Win64.txt under "${normalized}". ` +
      'Pass --game-path=<SMITE 2 install path> if the game is installed elsewhere.',
  );
}

function normalizePathSeparators(value) {
  return value.replaceAll('\\', '/');
}

function normalizeToken(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function parseManifest(content, sourceName) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawPath, updatedAt] = line.split('\t');
      const filePath = normalizePathSeparators(rawPath);

      return {
        filePath,
        updatedAt: updatedAt ?? null,
        extension: path.posix.extname(filePath),
        source: sourceName,
      };
    });
}

function classifyAsset(packagePath, basename) {
  if (basename.includes('TargetDummy')) {
    return 'TargetDummy';
  }

  if (/^EquipmentInfo_/i.test(basename)) {
    return 'EquipmentInfo';
  }

  if (/^EquipmentItem_/i.test(basename)) {
    return 'EquipmentItem';
  }

  if (/^TalentInfo_/i.test(basename)) {
    return 'TalentInfo';
  }

  if (/^AbilitySet_/i.test(basename)) {
    return 'AbilitySet';
  }

  if (/^CT_.*EffectValues/i.test(basename)) {
    return 'EffectValueCurve';
  }

  if (/^CT_/i.test(basename) || packagePath.includes('/CurveTables/')) {
    return 'CurveTable';
  }

  if (/^GE_/i.test(basename) || packagePath.includes('/GameplayEffects/')) {
    return 'GameplayEffect';
  }

  if (packagePath.includes('/DataTables/')) {
    return 'DataTable';
  }

  return 'Other';
}

function collectTags(packagePath, basename, category) {
  const tags = new Set();

  const checks = [
    ['damage', /Damage/i],
    ['cooldown', /Cooldown|CDR/i],
    ['cost', /Cost/i],
    ['effect-values', /EffectValues/i],
    ['stats', /Stats?|StatDisplays/i],
    ['talent', /Talent/i],
    ['passive', /Passive|PSV/i],
    ['starter', /Starter/i],
    ['item', /^Equipment(?:Info|Item)_Item_|^GE_Item_|^GE_Items_|^CT_Starter_|^DT_Smite_TempItemList$/i],
    ['target-dummy', /TargetDummy/i],
    ['jungle-practice', /JunglePractice/i],
    ['objective', /Titan|Tower|Phoenix|FireGiant|GoldFury|Bastion/i],
    ['training', /Training/i],
  ];

  for (const [tag, pattern] of checks) {
    if (pattern.test(basename) || pattern.test(packagePath)) {
      tags.add(tag);
    }
  }

  if (category === 'EquipmentInfo' || category === 'EquipmentItem') {
    tags.add('item');
  }

  if (category === 'EffectValueCurve') {
    tags.add('effect-values');
  }

  if (category === 'GameplayEffect') {
    tags.add('gameplay-effect');
  }

  if (category === 'DataTable') {
    tags.add('data-table');
  }

  if (category === 'CurveTable') {
    tags.add('curve-table');
  }

  return [...tags].sort();
}

function findGodInPath(packagePath) {
  const pathMatch = packagePath.match(/\/Characters\/GODS\/([^/]+)\//i);
  return pathMatch ? pathMatch[1] : null;
}

function inferGodFromBasename(basename, knownGods) {
  const stripped = basename.replace(/^(EquipmentInfo|EquipmentItem|TalentInfo|GE|CT|AbilitySet)_/i, '');
  const normalizedStripped = normalizeToken(stripped);

  for (const god of knownGods) {
    const normalizedGod = normalizeToken(god);
    if (normalizedStripped === normalizedGod || normalizedStripped.startsWith(`${normalizedGod}`)) {
      return god;
    }
  }

  return null;
}

function scoreFormulaRelevance(record) {
  let score = 0;

  switch (record.category) {
    case 'EffectValueCurve':
      score += 60;
      break;
    case 'GameplayEffect':
      score += 45;
      break;
    case 'CurveTable':
      score += 25;
      break;
    case 'DataTable':
      score += 20;
      break;
    case 'EquipmentInfo':
    case 'EquipmentItem':
      score += 18;
      break;
    case 'TargetDummy':
      score += 30;
      break;
    default:
      break;
  }

  const tagWeights = {
    damage: 20,
    cooldown: 16,
    cost: 14,
    'effect-values': 25,
    stats: 12,
    talent: 10,
    passive: 8,
    item: 10,
    'target-dummy': 18,
    'jungle-practice': 6,
    objective: 4,
  };

  for (const tag of record.tags) {
    score += tagWeights[tag] ?? 0;
  }

  if (record.basename === 'DT_Smite_TempItemList') {
    score += 30;
  }

  if (record.basename === 'DT_CharacterStatDisplays' || record.basename === 'DT_DataDisplay_CharacterStats') {
    score += 20;
  }

  return score;
}

function summarizeCounts(records, selector) {
  return records.reduce((accumulator, record) => {
    const key = selector(record);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    }),
  );
}

function formatSectionRows(rows) {
  return rows.map((row) => `- \`${row.basename}\` (${row.category}) - ${row.packagePath}`).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { gameRoot, windowsRoot } = await resolveInstallPaths(args.gamePath ?? process.env.SMITE2_PATH);

  const ufsManifestPath = path.join(windowsRoot, 'Manifest_UFSFiles_Win64.txt');
  const nonUfsManifestPath = path.join(windowsRoot, 'Manifest_NonUFSFiles_Win64.txt');

  const [ufsManifest, nonUfsManifest] = await Promise.all([
    fs.readFile(ufsManifestPath, 'utf8'),
    fs.readFile(nonUfsManifestPath, 'utf8'),
  ]);

  const ufsEntries = parseManifest(ufsManifest, 'UFS');
  const nonUfsEntries = parseManifest(nonUfsManifest, 'NonUFS');
  const allEntries = [...ufsEntries, ...nonUfsEntries];

  const knownGods = new Set(
    ufsEntries
      .map((entry) => findGodInPath(entry.filePath))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  );

  const packageMap = new Map();

  for (const entry of allEntries) {
    const packagePath = entry.extension
      ? entry.filePath.slice(0, -entry.extension.length)
      : entry.filePath;
    const basename = path.posix.basename(packagePath);
    const existing = packageMap.get(packagePath);

    if (existing) {
      existing.extensions.push(entry.extension);
      continue;
    }

    const category = classifyAsset(packagePath, basename);
    const tags = collectTags(packagePath, basename, category);
    const god = findGodInPath(packagePath) ?? inferGodFromBasename(basename, [...knownGods]);

    packageMap.set(packagePath, {
      packagePath,
      basename,
      updatedAt: entry.updatedAt,
      source: entry.source,
      extensions: [entry.extension],
      category,
      tags,
      god,
    });
  }

  const packages = [...packageMap.values()]
    .map((record) => ({
      ...record,
      extensions: [...new Set(record.extensions)].sort(),
    }))
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));

  const formulaCandidates = packages
    .map((record) => ({
      ...record,
      formulaRelevance: scoreFormulaRelevance(record),
    }))
    .filter((record) => record.formulaRelevance > 0)
    .sort((left, right) => {
      if (right.formulaRelevance !== left.formulaRelevance) {
        return right.formulaRelevance - left.formulaRelevance;
      }

      return left.packagePath.localeCompare(right.packagePath);
    });

  const focusMatches = Object.fromEntries(
    args.focusGods.map((godName) => {
      const normalizedFocus = normalizeToken(godName);
      const matches = formulaCandidates
        .filter((record) => normalizeToken(record.god ?? record.basename).includes(normalizedFocus))
        .slice(0, 25);

      return [godName, matches];
    }),
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    install: {
      gameRoot,
      windowsRoot,
      ufsManifestPath,
      nonUfsManifestPath,
    },
    totals: {
      ufsEntries: ufsEntries.length,
      nonUfsEntries: nonUfsEntries.length,
      packages: packages.length,
      formulaCandidates: formulaCandidates.length,
      knownGods: knownGods.size,
    },
    categoryCounts: sortCounts(summarizeCounts(packages, (record) => record.category)),
    tagCounts: sortCounts(
      packages.flatMap((record) => record.tags).reduce((accumulator, tag) => {
        accumulator[tag] = (accumulator[tag] ?? 0) + 1;
        return accumulator;
      }, {}),
    ),
    godCounts: sortCounts(
      summarizeCounts(
        packages.filter((record) => record.god),
        (record) => record.god,
      ),
    ),
    topFormulaCandidates: formulaCandidates.slice(0, 100),
    focusMatches,
    notableAssets: {
      itemTables: packages.filter((record) => /DT_Smite_TempItemList|Inventory|CharacterStat/i.test(record.basename)).slice(0, 25),
      targetDummy: packages.filter((record) => record.category === 'TargetDummy').slice(0, 25),
      effectValueCurves: packages.filter((record) => record.category === 'EffectValueCurve').slice(0, 100),
      gameplayDamageEffects: packages
        .filter((record) => record.category === 'GameplayEffect' && record.tags.includes('damage'))
        .slice(0, 100),
    },
    packages,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const jsonOutputPath = path.join(OUTPUT_DIR, 'manifest-asset-index.json');
  const markdownOutputPath = path.join(OUTPUT_DIR, 'manifest-asset-summary.md');

  await fs.writeFile(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const focusSections = Object.entries(focusMatches)
    .map(([godName, matches]) => {
      if (matches.length === 0) {
        return `## ${godName}\n\nNo high-signal manifest matches found.`;
      }

      return `## ${godName}\n\n${formatSectionRows(matches)}`;
    })
    .join('\n\n');

  const markdown = `# SMITE 2 Install Asset Summary

Generated: ${summary.generatedAt}

Install root: \`${summary.install.gameRoot}\`

Windows manifest root: \`${summary.install.windowsRoot}\`

## Totals

- UFS manifest entries: ${summary.totals.ufsEntries}
- Non-UFS manifest entries: ${summary.totals.nonUfsEntries}
- Unique packages: ${summary.totals.packages}
- Formula-relevant packages: ${summary.totals.formulaCandidates}
- Known gods inferred from package paths: ${summary.totals.knownGods}

## Category Counts

${Object.entries(summary.categoryCounts)
  .map(([key, value]) => `- ${key}: ${value}`)
  .join('\n')}

## Highest-Signal Formula Sources

- \`DT_Smite_TempItemList\` suggests a packaged item list table exists.
- \`DT_CharacterStatDisplays\` and \`DT_DataDisplay_CharacterStats\` suggest a stat-display layer exists.
- \`CT_*_EffectValues\` assets strongly suggest table-driven coefficients for abilities, talents, or item levels.
- \`GE_*Damage\`, \`GE_*Cooldown\`, and \`GE_*Cost\` assets strongly suggest Unreal GameplayEffect-driven damage, cooldown, and resource rules.
- \`S_TargetDummyDPS\` is present, which is useful for target-dummy or practice-mode related research.

## Top Formula Candidates

${formatSectionRows(summary.topFormulaCandidates.slice(0, 40))}

## Focus Gods

${focusSections}
`;

  await fs.writeFile(markdownOutputPath, markdown, 'utf8');

  console.log(`Wrote ${jsonOutputPath}`);
  console.log(`Wrote ${markdownOutputPath}`);
  console.log(`Indexed ${summary.totals.packages} unique packages from the local install.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
