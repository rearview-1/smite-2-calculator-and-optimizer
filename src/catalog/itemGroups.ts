/**
 * Item mutual-exclusion registry.
 *
 * Some SMITE 2 items share a "unique" passive that doesn't stack with other
 * items in the same family — the game only applies one of them. An optimizer
 * that treats those items as independent will happily put both in a build and
 * double-count the effect, producing bogus top results.
 *
 * Two sources feed the registry:
 *   1. Auto-detected from passive text ("does not stack with other similar
 *      effects" — the anti-heal family uses this phrasing explicitly).
 *   2. Hardcoded supplements for groups whose rule isn't in the catalog's
 *      passive text (e.g. %-Penetration items have the rule in game code, not
 *      tooltip). When the user flags a new conflict, add it to
 *      HARDCODED_GROUPS below.
 */
import type { ItemCatalogEntry } from './loadCatalogs.ts'

export interface ExclusionGroup {
  id: string
  label: string
  members: string[]   // display names
}

/** Groups whose anti-stack rule isn't in catalog passive text. Keep short and
 *  justified so it's obvious when to add/remove entries. */
const HARDCODED_GROUPS: Array<Omit<ExclusionGroup, 'members'> & { displayNames: string[] }> = [
  {
    id: 'percent-pen-35',
    label: '35% Penetration (unique)',
    // Obsidian Shard and Titan's Bane both grant 35% PhysicalPen + 35% MagicalPen.
    // In-game the pen effect is unique — only one applies. Their passive text is
    // empty in the catalog so this rule has to live here.
    displayNames: ["Obsidian Shard", "Titan's Bane"],
  },
]

/** Phrasing patterns that indicate a passive belongs to an anti-stack family.
 *  Each match extracts a family name from the surrounding text. */
const TEXT_EXCLUSION_PATTERNS: Array<{ re: RegExp; familyId: string; label: string }> = [
  {
    re: /Healing Reduction (?:does not|doesn'?t|cannot) stack with/i,
    familyId: 'anti-heal',
    label: 'Healing Reduction (unique)',
  },
]

export function computeExclusionGroups(items: ItemCatalogEntry[]): ExclusionGroup[] {
  const nameSet = new Set<string>()
  for (const it of items) if (it.displayName) nameSet.add(it.displayName)

  const groups: ExclusionGroup[] = []

  // Hardcoded — only emit a group if at least two of its members exist in the
  // loaded catalog; a singleton group has no effect and cluttering the output
  // helps no one.
  for (const hc of HARDCODED_GROUPS) {
    const members = hc.displayNames.filter((n) => nameSet.has(n))
    if (members.length >= 2) groups.push({ id: hc.id, label: hc.label, members })
  }

  // Auto-detected from passive text.
  for (const pat of TEXT_EXCLUSION_PATTERNS) {
    const family: string[] = []
    for (const it of items) {
      if (!it.displayName) continue
      if (pat.re.test(it.passive ?? '')) family.push(it.displayName)
    }
    if (family.length >= 2) groups.push({ id: pat.familyId, label: pat.label, members: family })
  }

  return groups
}

/** Build a fast lookup: item display name → set of group ids it belongs to.
 *  A combo violates a group iff it contains ≥2 items sharing a group id. */
export function buildExclusionIndex(groups: ExclusionGroup[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const g of groups) {
    for (const name of g.members) {
      const existing = index.get(name) ?? new Set<string>()
      existing.add(g.id)
      index.set(name, existing)
    }
  }
  return index
}

/** True if the combo violates any mutual-exclusion group. */
export function comboViolatesExclusion(
  comboNames: string[],
  index: Map<string, Set<string>>,
): boolean {
  const seen = new Set<string>()
  for (const name of comboNames) {
    const gids = index.get(name)
    if (!gids) continue
    for (const gid of gids) {
      if (seen.has(gid)) return true
      seen.add(gid)
    }
  }
  return false
}
