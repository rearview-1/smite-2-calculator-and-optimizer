import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import type { AbilitySlot, RotationAction, Scenario, SimResult } from './sim/v3/types.ts'
import { useCollabBuild } from './collab/useCollabBuild.ts'
import { buildToScenario } from './collab/buildDoc.ts'
import { getFinalBuildItemExclusionReason, isRelicItem } from './catalog/itemEligibility.ts'

// ---- API types ----
interface GodRef { id: string; name: string; primaryStat?: 'STR' | 'INT' | 'hybrid' }
interface ResolvedItemStats {
  stats: Record<string, number>
  adaptiveStrength: number
  adaptiveIntelligence: number
  adaptiveChoice: { strength: number; intelligence: number } | null
}
interface ItemRef {
  key: string; internalKey: string | null; name: string | null; tier: string | null;
  totalCost: number | null; categories?: string[]; statTags?: string[]; storeFloats?: number[]; passive?: string | null;
  resolvedStats?: ResolvedItemStats;
  /** If set, this item only appears in the picker / optimizer pool when the
   *  attacker's godId matches. Used for Ratatoskr's acorns (god-locked gear). */
  godLocked?: string | null;
}

interface Snapshot {
  attacker: {
    maxHealth: number; maxMana: number
    physicalProtection: number; magicalProtection: number
    moveSpeed: number; totalAttackSpeed: number
    inhandPower: number; adaptiveStrength: number; adaptiveIntelligence: number
    cdrPercent: number; critChance: number
    penFlat: number; penPercent: number
    magicalPenFlat: number; magicalPenPercent: number
    primaryStat: string
  }
  defender: { maxHealth: number; physicalProtection: number; magicalProtection: number }
}

interface OptimizedBuild {
  items: string[]
  totals: { total: number; physical: number; magical: number; true: number }
  comboExecutionTime: number; dps: number; rankScore: number
  stats: {
    adaptiveStrength: number; adaptiveIntelligence: number; totalAttackSpeed: number
    inhandPower: number; cdrPercent: number; critChance: number
    maxHealth: number; physicalProtection: number; magicalProtection: number
    penFlat: number; penPercent: number
    magicalPenFlat: number; magicalPenPercent: number
  }
}
interface OptimizeResult { searched: number; total: number; results: OptimizedBuild[]; elapsedMs: number; warnings: string[] }
interface OptimizeRequest {
  scenario: Scenario; itemPool?: string[]; buildSize?: number;
  requireOneStarter?: boolean; maxPermutations?: number; topN?: number;
  rankBy?: 'total' | 'physical' | 'magical' | 'true' | 'dps' | 'ability' | 'brawling' | 'bruiser' | 'burst' | 'bruiserBurst'
  rankByAbilityLabel?: string
  statMin?: Record<string, number>
  statMax?: Record<string, number>
  minTotalDamage?: number; minDps?: number
  evolveStackingItems?: boolean
  activeItems?: string[]
}

// Stat-tag presets. Strict by default — only tags that directly feed
// each build's damage. Loose tags (MaxHealth, CDR, Prot) cause the pool to
// balloon with tank/utility items that dilute the top-N results.
const PHYSICAL_TAGS = new Set([
  'PhysicalPower', 'Strength',
  'PhysicalPenetrationFlat', 'PhysicalPenetrationPercent',
  'CritChance', 'CritDamageBonus',
  'AttackSpeedPercent', 'LifeStealPercent',
])
const MAGICAL_TAGS = new Set([
  'MagicalPower', 'Intelligence',
  'MagicalPenetrationFlat', 'MagicalPenetrationPercent',
  'MaxMana',  // for mana-scaling items (BoT, Transcendence)
])
const TANK_TAGS = new Set([
  'MaxHealth', 'PhysicalProtection', 'MagicalProtection',
  'CooldownReductionPercent', 'MovementSpeed',
])
// Hybrid pool for gods like Tsukuyomi / bruisers who scale off both Strength
// and Intelligence. Union of physical + magical offensive tags; items with the
// Hybrid category (Eye of the Storm, Brawler's Beat Stick, Typhon's Heart)
// get a category-based pass in the pool filter below.
const HYBRID_TAGS = new Set<string>([...PHYSICAL_TAGS, ...MAGICAL_TAGS])
const STAT_FILTER_FIELDS = [
  { key: 'adaptiveStrength', label: 'STR' },
  { key: 'adaptiveIntelligence', label: 'INT' },
  { key: 'cdrPercent', label: 'CDR' },
  { key: 'penPercent', label: 'Phys Pen' },
  { key: 'magicalPenPercent', label: 'Mag Pen' },
  { key: 'maxHealth', label: 'HP' },
  { key: 'totalAttackSpeed', label: 'AS' },
] as const
type PoolPreset = 'auto' | 'physical' | 'magical' | 'tank' | 'all' | 'custom'

// ---- API calls ----
async function fetchGods(): Promise<GodRef[]> { return (await fetch(`/api/gods`)).json() }
async function fetchItems(): Promise<ItemRef[]> { return (await fetch(`/api/items`)).json() }
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text()}`)
  return r.json()
}
const runScenarioRemote = (s: Scenario) => postJson<SimResult>('/api/scenarios/run', s)
const fetchSnapshot = (s: Scenario) => postJson<Snapshot>('/api/scenarios/snapshot', s)

// ---- Defaults ----
function defaultScenario(): Scenario {
  return {
    title: 'Custom build',
    attacker: { godId: '', level: 20, abilityRanks: { A01: 5, A02: 5, A03: 5, A04: 5 }, items: [] },
    defender: { godId: 'Kukulkan', level: 20 },
    rotation: [],
  }
}

// ---- Hash routing ----
function readBuildIdFromHash() { return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('build') }
function writeBuildIdToHash(id: string | null) {
  if (!id) { window.history.replaceState(null, '', window.location.pathname + window.location.search); return }
  const p = new URLSearchParams(); p.set('build', id)
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${p.toString()}`)
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

// ================= Top Bar =================
function TopBar(props: {
  collab: { buildId: string | null; peers: Array<{ userName: string; color?: string; isMe?: boolean }> }
  onShare: () => void; onLeave: () => void
}) {
  return (
    <div className="app-topbar">
      <div className="brand"><span className="glyph">⚔</span>SMITE 2</div>
      <div className="status">
        {props.collab.buildId ? (
          <>
            <span style={{ color: 'var(--green)' }}>● Live · {props.collab.buildId.slice(-8)}</span>
            {props.collab.peers.map((p, i) => (
              <span key={i} className={`peer-pill ${p.isMe ? 'me' : ''}`}>{p.userName}{p.isMe ? ' (you)' : ''}</span>
            ))}
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(window.location.href).catch(() => { /*noop*/ })}>Copy link</button>
            <button className="ghost" onClick={props.onLeave}>Leave</button>
          </>
        ) : (
          <button className="ghost" onClick={props.onShare}>Share build ↗</button>
        )}
      </div>
    </div>
  )
}

// ================= Tabs =================
type TabKey = 'characters' | 'sim' | 'builds'
function TabBar(props: { active: TabKey; onChange: (t: TabKey) => void }) {
  const tabs: Array<{ k: TabKey; label: string }> = [
    { k: 'characters', label: 'Characters' },
    { k: 'sim', label: 'Scenarios' },
    { k: 'builds', label: 'Saved Builds' },
  ]
  return (
    <div className="app-tabs">
      {tabs.map((t) => (
        <div key={t.k} className={`tab ${props.active === t.k ? 'active' : ''}`} onClick={() => props.onChange(t.k)}>{t.label}</div>
      ))}
    </div>
  )
}

// ================= God picker =================
function GodPicker(props: { gods: GodRef[]; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const ql = q.toLowerCase()
    return props.gods.filter((g) => g.name.toLowerCase().includes(ql) || g.id.toLowerCase().includes(ql))
  }, [props.gods, q])
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>Pick a god</h2><button className="ghost" onClick={props.onClose}>Close</button></div>
        <div className="modal-search"><input autoFocus placeholder="Search gods…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="modal-body">
          <div className="picker-grid">
            {filtered.map((g) => (
              <div className="picker-item" key={g.id} onClick={() => props.onPick(g.id)}>
                <div className="name">{g.name}</div><div className="meta">{g.id}</div>
              </div>
            ))}
          </div>
          {filtered.length === 0 && <div className="empty-state">No matches.</div>}
        </div>
      </div>
    </div>
  )
}

// ================= Item picker =================
// Sub-category labels are shown in the item card's meta row so base vs upgraded
// variants are visible at a glance. Upgraded relics all come from Mote of Chaos,
// so they show "MOTE UPGRADE" to distinguish from the 3 Starting Relics.
// Compact stat labels for the picker meta row. Order matters — we render in
// roughly the order you'd read a tooltip (HP / mana / power / adaptive / pen /
// crit / utility).
const STAT_LABELS: Array<[string, string, boolean?]> = [
  ['MaxHealth', 'HP'],
  ['MaxMana', 'MP'],
  ['HealthPerTime', 'HP5'],
  ['ManaPerTime', 'MP5'],
  ['PhysicalProtection', 'PhysProt'],
  ['MagicalProtection', 'MagProt'],
  ['AttackSpeedPercent', '%AS', true],
  ['CooldownReductionPercent', '%CDR', true],
  ['CritChance', '%Crit', true],
  ['PhysicalPenetrationFlat', 'PhysPen'],
  ['MagicalPenetrationFlat', 'MagPen'],
  ['PhysicalPenetrationPercent', '%PhysPen', true],
  ['MagicalPenetrationPercent', '%MagPen', true],
  ['PhysicalInhandLifestealPercent', '%LS', true],
  ['MagicalLifestealPercent', '%MagLS', true],
  ['LifeStealPercent', '%LS', true],
  ['MovementSpeed', 'MS'],
  ['InhandPower', 'IHP'],
  ['EchoItem', 'Echo'],
  ['Dampening', 'Damp'],
  ['Plating', 'Plate'],
  ['CrowdControlReduction', '%CCR', true],
]
function formatNumber(n: number): string {
  // 2.5 → "2.5", 30 → "30"; avoid trailing ".0"
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10)
}
function formatItemStats(r: ResolvedItemStats | undefined): string {
  if (!r) return ''
  const parts: string[] = []
  if (r.adaptiveStrength > 0) parts.push(`${formatNumber(r.adaptiveStrength)} STR`)
  if (r.adaptiveIntelligence > 0) parts.push(`${formatNumber(r.adaptiveIntelligence)} INT`)
  for (const [key, label, isPercent] of STAT_LABELS) {
    const v = r.stats[key]
    if (v == null || v === 0) continue
    if (isPercent) parts.push(`${formatNumber(v)} ${label}`)
    else parts.push(`${formatNumber(v)} ${label}`)
  }
  if (r.adaptiveChoice) {
    parts.push(`${formatNumber(r.adaptiveChoice.strength)} STR / ${formatNumber(r.adaptiveChoice.intelligence)} INT`)
  }
  return parts.join(' · ')
}

function itemSubCategory(it: ItemRef): { label: string; rank: number } {
  const cats = it.categories ?? []
  if (cats.includes('Consumable')) return { label: 'CONSUMABLE', rank: 9 }
  if (cats.includes('Curio')) return { label: 'CURIO', rank: 8 }
  if (cats.includes('StartingRelic')) return { label: 'STARTING RELIC', rank: 1 }
  if (cats.includes('UpgradedRelic')) return { label: 'MOTE UPGRADE', rank: 2 }
  if (cats.includes('UpgradedStarter')) return { label: 'UPGRADED STARTER', rank: 4 }
  if (it.tier === 'Starter') return { label: 'STARTER', rank: 3 }
  if (it.tier) return { label: it.tier, rank: 5 }
  return { label: '', rank: 5 }
}

function ItemPicker(props: { items: ItemRef[]; onPick: (name: string) => void; onClose: () => void; title?: string; attackerGodId?: string }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'starters' | 'relics' | 'core'>('all')
  // A "starter" for the picker is a tier=Starter that is NOT a Consumable —
  // Health Potion has tier=Starter but is a Consumable, not a build starter.
  const isStarter = (it: ItemRef) => it.tier === 'Starter' && !(it.categories ?? []).includes('Consumable')
  const filtered = useMemo(() => {
    const ql = q.toLowerCase()
    const rows = props.items.filter((it) => {
      if (!it.name) return false
      if (!it.name.toLowerCase().includes(ql)) return false
      // God-locked items (Ratatoskr's acorns) only surface when the attacker
      // is that god — otherwise they're not even pickable.
      if (it.godLocked && it.godLocked !== props.attackerGodId) return false
      if (filter === 'starters' && !isStarter(it)) return false
      if (filter === 'relics'   && !isRelicItem(it))   return false
      if (filter === 'core'     && (isStarter(it) || isRelicItem(it)
                                    || (it.categories ?? []).includes('Consumable')
                                    || (it.categories ?? []).includes('Curio'))) return false
      return true
    }).slice(0, 500)
    // Sort by sub-category rank so Starting Relics come before Mote Upgrades,
    // and base starters come before UpgradedStarters.
    return rows.slice().sort((a, b) => {
      const ra = itemSubCategory(a).rank
      const rb = itemSubCategory(b).rank
      if (ra !== rb) return ra - rb
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
  }, [props.items, q, filter])
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{props.title ?? 'Pick an item'}</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={filter === 'all' ? 'primary' : 'ghost'} onClick={() => setFilter('all')}>All</button>
            <button className={filter === 'core' ? 'primary' : 'ghost'} onClick={() => setFilter('core')}>Core</button>
            <button className={filter === 'starters' ? 'primary' : 'ghost'} onClick={() => setFilter('starters')}>Starters</button>
            <button className={filter === 'relics' ? 'primary' : 'ghost'} onClick={() => setFilter('relics')}>Relics</button>
            <button className="ghost" onClick={props.onClose}>Close</button>
          </div>
        </div>
        <div className="modal-search"><input autoFocus placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="modal-body">
          <div className="picker-grid">
            {filtered.map((it) => {
              const sub = itemSubCategory(it)
              const stats = formatItemStats(it.resolvedStats)
              return (
                <div className="picker-item" key={it.key} onClick={() => props.onPick(it.name!)}>
                  <div className="name">{it.name}</div>
                  <div className="meta">{sub.label}{it.totalCost ? ` · ${it.totalCost}g` : ''}</div>
                  {stats && <div className="meta stats">{stats}</div>}
                </div>
              )
            })}
          </div>
          {filtered.length === 0 && <div className="empty-state">No matches.</div>}
        </div>
      </div>
    </div>
  )
}

// ================= DPS chart with hover tooltip =================
const SOURCE_COLORS: Record<string, string> = {
  basic: 'var(--amber)',
  ability: 'var(--cyan)',
  item: 'var(--violet)',
  dot: 'var(--accent-hi)',
  passive: 'var(--green)',
  active: 'var(--blue)',
  relic: '#d96ce0',
  'buff-drop': '#ff7070',
}

function DpsChart({ series, events }: {
  series: { t: number; instantDps: number; cumulativeDamage: number }[]
  events?: Array<{ t: number; source: string; postMitigation: number; label: string }>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 360, h: 140 })
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(() => { if (ref.current) setSize({ w: ref.current.clientWidth, h: ref.current.clientHeight }) })
    ro.observe(ref.current); return () => ro.disconnect()
  }, [])

  const { pts, ptsCum, xs, ys, bounds, eventDots } = useMemo(() => {
    if (series.length === 0) return { pts: '', ptsCum: '', xs: [] as number[], ys: [] as number[], bounds: { maxT: 1, maxD: 1, maxCum: 1 }, eventDots: [] as Array<{ x: number; y: number; color: string; label: string; dmg: number; t: number }> }
    const maxD = Math.max(...series.map((s) => s.instantDps), 1)
    const maxT = Math.max(...series.map((s) => s.t), 1)
    const maxCum = Math.max(...series.map((s) => s.cumulativeDamage), 1)
    const pad = 4, W = size.w - pad * 2, H = size.h - pad * 2
    const xs: number[] = [], ys: number[] = []
    const partsD: string[] = [], partsC: string[] = []
    for (const s of series) {
      const x = (s.t / maxT) * W + pad
      const y = H - (s.instantDps / maxD) * H + pad
      const yC = H - (s.cumulativeDamage / maxCum) * H + pad
      xs.push(x); ys.push(y)
      partsD.push(`${x},${y}`); partsC.push(`${x},${yC}`)
    }
    // Per-event dots colored by source. Y sits just under the DPS curve so
    // big-damage events are visible without colliding with the line.
    const maxEvDmg = Math.max(1, ...(events ?? []).map((e) => e.postMitigation))
    const eventDots = (events ?? []).map((e) => ({
      x: (e.t / maxT) * W + pad,
      y: H - (e.postMitigation / maxEvDmg) * (H * 0.4) + pad + H * 0.5,
      color: SOURCE_COLORS[e.source] ?? 'var(--ink-faint)',
      label: e.label,
      dmg: e.postMitigation,
      t: e.t,
    }))
    return { pts: partsD.join(' '), ptsCum: partsC.join(' '), xs, ys, bounds: { maxT, maxD, maxCum }, eventDots }
  }, [series, events, size.w, size.h])

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!ref.current || xs.length === 0) return
    const rect = ref.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    let best = 0, bestD = Infinity
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - x)
      if (d < bestD) { bestD = d; best = i }
    }
    setHoverIdx(best)
  }

  const hovered = hoverIdx !== null ? series[hoverIdx] : null
  const hoverX = hoverIdx !== null ? xs[hoverIdx] : 0

  return (
    <div className="chart-wrap" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
      <svg>
        <polyline points={pts} fill="none" stroke="var(--amber)" strokeWidth={1.5} />
        <polyline points={ptsCum} fill="none" stroke="var(--accent-hi)" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
        {eventDots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={2.5} fill={d.color} stroke="rgba(0,0,0,0.4)" strokeWidth={0.5}>
            <title>{`t=${d.t.toFixed(2)}s · ${d.label} · ${d.dmg.toFixed(0)}`}</title>
          </circle>
        ))}
        {hovered && (
          <>
            <line className="chart-crosshair" x1={hoverX} y1={0} x2={hoverX} y2={size.h} />
            <circle className="chart-dot" cx={hoverX} cy={ys[hoverIdx!]} r={3} />
          </>
        )}
      </svg>
      {hovered && (
        <div className="chart-tooltip" style={{ left: hoverX, top: ys[hoverIdx!] }}>
          <div><span className="k">t</span><span className="v">{hovered.t.toFixed(2)}s</span></div>
          <div><span className="k">dps</span><span className="v">{hovered.instantDps.toFixed(0)}</span></div>
          <div><span className="k">cum</span><span className="v">{hovered.cumulativeDamage.toFixed(0)}</span></div>
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 2, left: 6, color: 'var(--ink-faint)', fontSize: 9, letterSpacing: '0.08em' }}>
        DPS &nbsp;|&nbsp; cum · max {bounds.maxCum.toFixed(0)} · t {bounds.maxT.toFixed(1)}s
      </div>
    </div>
  )
}

// ================= Characters tab (Fribbels-style single page) =================
function CharactersTab(props: {
  scenario: Scenario
  setAttacker: (a: Scenario['attacker']) => void
  setDefender: (d: Scenario['defender']) => void
  setOptions: (o: NonNullable<Scenario['options']>) => void
  addStep: (step: RotationAction) => void
  removeStep: (i: number) => void
  onRun: () => void
  running: boolean
  gods: GodRef[]
  items: ItemRef[]
  itemLookup: Map<string, ItemRef>
  snapshot: Snapshot | null
  result: SimResult | null
  error: string | null
  optimized: OptimizeResult | null
  optimizing: boolean
  /** Scaling type inferred from the attacker god's abilities. 'hybrid' means
   *  the optimizer's DPS presets auto-widen to include both stat types. */
  godPrimaryStat: 'STR' | 'INT' | 'hybrid' | null
  onOptimize: (opts: {
    pool: string[]; buildSize: number; rankBy: OptimizeRequest['rankBy'];
    rankByAbilityLabel?: string;
    requireStarter: boolean; max: number;
    statMin: Record<string, number>; statMax: Record<string, number>;
    evolveStacking: boolean; activeItems: string[];
  }) => void
  onOptimizeCancel: () => void
  pinnedBuild: OptimizedBuild | null
  setPinnedBuild: (b: OptimizedBuild | null) => void
}) {
  const [showGodPicker, setShowGodPicker] = useState(false)
  const [showEnemyPicker, setShowEnemyPicker] = useState(false)
  const [itemPickerIndex, setItemPickerIndex] = useState<number | null>(null)
  const [poolPreset, setPoolPreset] = useState<PoolPreset>('auto')
  const [buildSize, setBuildSize] = useState(6)
  const [rankBy, setRankBy] = useState<NonNullable<OptimizeRequest['rankBy']>>('total')
  const [rankByAbilityLabel, setRankByAbilityLabel] = useState<string>('')
  // Builds must always contain exactly one starter — per SMITE 2 game design,
  // every final build has an upgraded starter slot. No toggle.
  const requireStarter = true
  const [maxPerms, setMaxPerms] = useState(20000)
  const [sortCol, setSortCol] = useState<string>('total')
  const [evolveStacking, setEvolveStacking] = useState(true)
  // Item class toggles — both default ON. Turning off excludes the tagged
  // items from the pool (e.g. disable Crit if you never want RNG damage).
  const [allowCrit, setAllowCrit] = useState(true)
  const [allowEcho, setAllowEcho] = useState(true)
  // Item display-names whose active is allowed to fire. Defaults to "all items
  // in the pool that have an On Use clause" so the first run isn't a pessimistic
  // stats-only run; user can toggle off per-item.
  const [activeItems, setActiveItems] = useState<Set<string>>(new Set())

  // Stat min/max filters.
  const [statMin, setStatMin] = useState<Partial<Record<string, number>>>({})
  const [statMax, setStatMax] = useState<Partial<Record<string, number>>>({})

  const { scenario, setAttacker, setDefender, setOptions } = props
  const hasAttacker = scenario.attacker.godId.trim().length > 0
  const attackerName = hasAttacker ? scenario.attacker.godId.replace(/_/g, ' ') : 'Pick a god'
  const effectivePoolPreset: Exclude<PoolPreset, 'auto'> = poolPreset === 'auto'
    ? props.godPrimaryStat === 'INT' ? 'magical' : 'physical'
    : poolPreset
  const poolModeLabel = poolPreset === 'auto'
    ? `auto: ${props.godPrimaryStat === 'INT' ? 'magical' : props.godPrimaryStat === 'hybrid' ? 'hybrid offense' : 'physical'}`
    : poolPreset

  // Total count of items that could ever appear in a final build (any preset).
  // Shown in the pool status line so the user can tell at a glance whether the
  // active preset covers the whole catalog or is narrowing.
  const totalFinalBuildItems = useMemo(
    () => props.items.filter((it) => it.name && !getFinalBuildItemExclusionReason(it)).length,
    [props.items],
  )

  // Derive item pool from preset — filters by STAT TAGS the item actually grants.
  // The "all" preset includes every final-build item in the game; the role
  // presets narrow down to items whose stat tags match the role.
  const itemPool = useMemo(() => {
    // Auto-widen when the current god has hybrid scaling (Tsukuyomi, Da Ji,
    // certain bruisers). Their total damage pulls from both STR and INT, so the
    // strict Physical/Magical pools would systematically miss the other stat's
    // items. When hybrid, PHYSICAL/MAGICAL both include both stat sets plus the
    // Hybrid category. User doesn't need to think about it.
    const isHybridGod = props.godPrimaryStat === 'hybrid'
    const isStrictDps = effectivePoolPreset === 'physical' || effectivePoolPreset === 'magical'
    const excluded = (it: ItemRef) => {
      const cat = it.categories ?? []
      const tags = it.statTags ?? []

      const finalBuildExclusion = getFinalBuildItemExclusionReason(it)
      if (finalBuildExclusion) return true
      // God-locked items (Ratatoskr acorns) only available to their god.
      if (it.godLocked && it.godLocked !== scenario.attacker.godId) return true
      // Pure phys/mag reject Hybrid-category items — unless god is hybrid.
      if (isStrictDps && !isHybridGod && cat.includes('Hybrid')) return true
      // Strict DPS presets reject flat-defensive items regardless.
      if (isStrictDps && cat.includes('Defensive')) return true
      // Upgraded starters are eligible for DPS pools if they grant ANY
      // offensive contribution. Every upgraded starter except Heroism,
      // War Banner, and Blood-soaked Shroud provides an "Adaptive Stat:
      // +X STR / +Y INT" bonus at lv20 (mined from passive text or the
      // GE_Items_Str_/GE_Items_Int_ effects) — so for our purposes, adaptive
      // presence is the cleanest signal of "this starter contributes damage".
      if (isStrictDps && cat.includes('UpgradedStarter')) {
        const hasAdaptive = !!it.resolvedStats?.adaptiveChoice
        const hasOffensiveStat = tags.includes('PhysicalPower') || tags.includes('MagicalPower')
                              || tags.includes('Strength') || tags.includes('Intelligence')
                              || tags.includes('AttackSpeedPercent') || tags.includes('CritChance')
                              || tags.includes('CooldownReductionPercent')
                              || tags.includes('PhysicalPenetrationFlat') || tags.includes('PhysicalPenetrationPercent')
                              || tags.includes('MagicalPenetrationFlat') || tags.includes('MagicalPenetrationPercent')
        const isProtection = tags.includes('PhysicalProtectionItem') || tags.includes('MagicalProtectionItem')
                          || tags.includes('PhysicalProtection') || tags.includes('MagicalProtection')
        // No contribution at all — pure sustain or unknown-purpose starter.
        if (!hasAdaptive && !hasOffensiveStat) return true
        // Protection-heavy starter with NO adaptive stat (Heroism, War Banner)
        // — team-utility only, shouldn't compete for a damage slot.
        if (isProtection && !hasAdaptive) return true
      }
      if (!allowCrit && tags.includes('CritChance')) return true
      if (!allowEcho && tags.includes('EchoItem')) return true
      return false
    }

    if (effectivePoolPreset === 'custom') return scenario.attacker.items.slice(0, 7)
    if (effectivePoolPreset === 'all') {
      return props.items
        .filter((i) => i.name && !excluded(i))
        .map((i) => i.name!).filter(Boolean)
    }
    // For a hybrid god, widen phys/mag to the combined stat set + Hybrid cat.
    const physOrMagTagSet = isHybridGod && isStrictDps ? HYBRID_TAGS
      : effectivePoolPreset === 'physical' ? PHYSICAL_TAGS
      : effectivePoolPreset === 'magical'  ? MAGICAL_TAGS
      : TANK_TAGS
    return props.items
      .filter((it) => {
        if (!it.name || excluded(it)) return false
        const cat = it.categories ?? []
        if (isHybridGod && isStrictDps && cat.includes('Hybrid')) return true
        const tags = it.statTags ?? []
        return tags.some((t) => physOrMagTagSet.has(t))
      })
      .map((it) => it.name!)
      .filter(Boolean)
  }, [props.items, effectivePoolPreset, scenario.attacker.items, allowCrit, allowEcho, props.godPrimaryStat])

  const displayScenario = pinnedOrCurrent(scenario, props.pinnedBuild)
  const displaySnapshot = props.pinnedBuild
    ? snapshotFromPinned(props.pinnedBuild, props.snapshot)
    : props.snapshot

  return (
    <div className="tab-body">
      <div className="page">
        <div className="left-col">
          {/* Target strip (compact, at top) */}
          <div className="target-strip">
            <span className="vs">vs</span>
            <button className="ghost" onClick={() => setShowEnemyPicker(true)}>{scenario.defender.godId.replace(/_/g, ' ')}</button>
            <span className="vs">lvl</span>
            <input type="number" min={1} max={20} style={{ width: 50 }}
              value={scenario.defender.level}
              onChange={(e) => setDefender({ ...scenario.defender, level: Math.max(1, Math.min(20, Number(e.target.value))) })} />
            <span style={{ color: 'var(--ink-faint)', fontSize: 9.5, letterSpacing: '0.12em', marginLeft: 'auto' }}>
              HP {displaySnapshot?.defender.maxHealth.toFixed(0) ?? '…'} · Prot {displaySnapshot?.defender.physicalProtection.toFixed(0) ?? '…'}/{displaySnapshot?.defender.magicalProtection.toFixed(0) ?? '…'}
            </span>
          </div>

          {/* Top panel row */}
          <div className="panel-row">
            {/* Character card */}
            <div className="panel">
              <div className="panel-head"><h3>Character</h3></div>
              <div className="char-panel">
                <div className="portrait-small" onClick={() => setShowGodPicker(true)}>
                  {hasAttacker ? scenario.attacker.godId[0] : '?'}
                  <div className="hint">Change</div>
                </div>
                <div className="char-name">{attackerName}</div>
                <div className="char-meta">
                  <span>LVL</span>
                  <input type="number" min={1} max={20} value={scenario.attacker.level}
                    onChange={(e) => setAttacker({ ...scenario.attacker, level: Math.max(1, Math.min(20, Number(e.target.value))) })} />
                </div>
                <div className="ranks-row">
                  {(['A01', 'A02', 'A03', 'A04'] as AbilitySlot[]).map((slot) => (
                    <div className="rank-cell" key={slot}>
                      <div className="label">{slot}</div>
                      <div className="ranks">
                        {[1,2,3,4,5].map((n) => (
                          <div key={n} className={`pip ${n <= scenario.attacker.abilityRanks[slot] ? 'on' : ''}`}
                            onClick={() => setAttacker({ ...scenario.attacker, abilityRanks: { ...scenario.attacker.abilityRanks, [slot]: n } })} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Items + Rotation */}
            <div className="panel">
              <div className="panel-head"><h3>Items &amp; Rotation</h3></div>
              <div className="panel-body tight">
                <div className="item-chips" style={{ marginBottom: 8 }}>
                  {[0,1,2,3,4,5,6].map((i) => {
                    const name = (props.pinnedBuild?.items ?? scenario.attacker.items)[i]
                    const isStarterSlot = i === 0
                    const placeholder = isStarterSlot ? 'STARTER' : '+'
                    const emptyClass = isStarterSlot ? 'item-chip empty starter-slot' : 'item-chip empty'
                    if (!name) return <div className={emptyClass} key={i} onClick={() => setItemPickerIndex(i)}>{placeholder}</div>
                    return (
                      <div className={isStarterSlot ? 'item-chip filled starter-slot' : 'item-chip filled'}
                        key={i} onClick={() => setItemPickerIndex(i)} title={name}>
                        <span>{name}</span>
                        <span className="remove" onClick={(e) => {
                          e.stopPropagation()
                          setAttacker({ ...scenario.attacker, items: scenario.attacker.items.filter((_, j) => j !== i) })
                          props.setPinnedBuild(null)
                        }}>×</span>
                      </div>
                    )
                  })}
                </div>
                <div className="rotation-box">
                  {scenario.rotation.length === 0 ? (
                    <span style={{ color: 'var(--ink-faint)', fontSize: 10, padding: '2px 4px' }}>Add abilities below…</span>
                  ) : (
                    scenario.rotation.map((step, i) => {
                      const isCancel = step.kind === 'ability' && step.cancel === true
                      const label = step.label
                        ?? (step.kind === 'ability' ? `${step.slot}${isCancel ? ' ↯' : ''}` : step.kind === 'basic' ? 'AA' : step.kind)
                      return (
                        <div key={i} className={`rot-step ${step.kind}${isCancel ? ' cancel' : ''}`}
                          title={isCancel ? 'Auto-attack cancel — fires procs (Hydra/Poly/Bumba), no ability damage' : undefined}>
                          <span className="idx">{i + 1}</span>
                          <span>{label}</span>
                          <span className="x" onClick={() => props.removeStep(i)}>×</span>
                        </div>
                      )
                    })
                  )}
                </div>
                <div className="rot-palette">
                  {(['A01','A02','A03','A04'] as AbilitySlot[]).map((slot) => (
                    <div className={`ability-tile ${!hasAttacker ? 'disabled' : ''}`} key={slot}
                      onClick={() => { if (hasAttacker) props.addStep({ kind: 'ability', slot }) }}>
                      <div className="slot">{slot}</div><div className="lbl">ability</div>
                    </div>
                  ))}
                  <div className={`ability-tile basic ${!hasAttacker ? 'disabled' : ''}`}
                    onClick={() => { if (hasAttacker) props.addStep({ kind: 'basic' }) }}>
                    <div className="slot">AA</div><div className="lbl">basic</div>
                  </div>
                  <button className="primary" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={props.onRun} disabled={props.running || !hasAttacker}>
                    {props.running ? 'Simulating…' : 'Run Sim ▸'}
                  </button>
                </div>
                {/* Second palette row: ability cancel variants (proc items, no damage). */}
                <div className="rot-palette" style={{ marginTop: 4 }}>
                  <div style={{ color: 'var(--ink-faint)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', alignSelf: 'center', marginRight: 4 }}>
                    Cancel
                  </div>
                  {(['A01','A02','A03','A04'] as AbilitySlot[]).map((slot) => (
                    <div className={`ability-tile cancel ${!hasAttacker ? 'disabled' : ''}`} key={'c-' + slot}
                      title="Auto-attack cancel: fires on-cast item procs (Hydra, Poly, Bumba); no ability damage"
                      onClick={() => { if (hasAttacker) props.addStep({ kind: 'ability', slot, cancel: true }) }}>
                      <div className="slot">{slot} ↯</div><div className="lbl">cancel</div>
                    </div>
                  ))}
                </div>
                {/* DoT tick / multi-hit count overrides — truncate abilities to
                    N of M ticks (Loki A02 DoT, Da Ji A02 3-hit combo, etc.). */}
                <TickOverridesRow scenario={scenario} setOptions={setOptions} />
                <CombatTimeRow scenario={scenario} setOptions={setOptions} />
              </div>
            </div>

            {/* Optimizer options */}
            <div className="panel">
              <div className="panel-head"><h3>Optimizer</h3></div>
              <div className="panel-body tight">
                <label>Item pool</label>
                <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
                  {(['auto','physical','magical','tank','all','custom'] as const).map((p) => (
                    <button key={p} className={poolPreset === p ? 'active' : 'ghost'} onClick={() => setPoolPreset(p)}>
                      {p}
                    </button>
                  ))}
                </div>
                <div style={{ color: 'var(--ink-faint)', fontSize: 9.5, marginTop: -2, marginBottom: 6 }}>
                  Pool mode: {poolModeLabel}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                  <div>
                    <label title="Number of non-starter items; starter is always an additional dedicated slot.">Items (+ starter)</label>
                    <select value={buildSize} onChange={(e) => setBuildSize(Number(e.target.value))}>
                      {[3,4,5,6].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <label>Rank by</label>
                    <select value={rankBy} onChange={(e) => setRankBy(e.target.value as NonNullable<OptimizeRequest['rankBy']>)}>
                      <option value="total">Total dmg</option>
                      <option value="dps">DPS</option>
                      <option value="burst">Burst (dmg in least time)</option>
                      <option value="bruiserBurst">Bruiser Burst (EHP × burst)</option>
                      <option value="bruiser">Bruiser (EHP × dmg)</option>
                      <option value="brawling">Brawling (EHP × dmg + CDR)</option>
                      <option value="physical">Physical</option>
                      <option value="magical">Magical</option>
                      <option value="true">True</option>
                      <option value="ability">Ability label</option>
                    </select>
                  </div>
                </div>
                {rankBy === 'ability' && (
                  <div style={{ marginBottom: 6 }}>
                    <label>Ability label contains</label>
                    <input
                      placeholder="Example: Flurry"
                      value={rankByAbilityLabel}
                      onChange={(e) => setRankByAbilityLabel(e.target.value)}
                    />
                  </div>
                )}
                <div style={{ marginBottom: 6 }}>
                  <label>Stat min / max filters</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 52px', gap: 4, alignItems: 'center' }}>
                    <div style={{ color: 'var(--ink-faint)', fontSize: 9 }}>Stat</div>
                    <div style={{ color: 'var(--ink-faint)', fontSize: 9 }}>Min</div>
                    <div style={{ color: 'var(--ink-faint)', fontSize: 9 }}>Max</div>
                    {STAT_FILTER_FIELDS.map((field) => (
                      <Fragment key={field.key}>
                        <div style={{ fontSize: 10 }}>{field.label}</div>
                        <input
                          type="number"
                          value={statMin[field.key] ?? ''}
                          onChange={(e) => updateNumberFilter(setStatMin, field.key, e.target.value)}
                        />
                        <input
                          type="number"
                          value={statMax[field.key] ?? ''}
                          onChange={(e) => updateNumberFilter(setStatMax, field.key, e.target.value)}
                        />
                      </Fragment>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 4, marginBottom: 6 }}>
                  <div>
                    <label>Max perms</label>
                    <input type="number" min={100} max={50000} step={500}
                      value={maxPerms} onChange={(e) => setMaxPerms(Number(e.target.value))} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                  <div>
                    <label>Stacking items</label>
                    <button className={evolveStacking ? 'active' : 'ghost'} onClick={() => setEvolveStacking((v) => !v)}>
                      {evolveStacking ? 'Evolved (max stacks)' : 'Un-evolved (no stacks)'}
                    </button>
                  </div>
                  <div>
                    <label>Conditional passives</label>
                    <button
                      className={scenario.options?.forceConditionalItemEffects ? 'active' : 'ghost'}
                      onClick={() => setOptions({
                        ...(scenario.options ?? {}),
                        forceConditionalItemEffects: !scenario.options?.forceConditionalItemEffects,
                      })}
                      title="Items like Spirit Robe default to their baseline stats. When ON, the conditional bonus (e.g. +40 prot under CC) is added as if the trigger were permanently active."
                    >
                      {scenario.options?.forceConditionalItemEffects ? 'Force procced' : 'Baseline only'}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                  <div>
                    <label>Crit items</label>
                    <button className={allowCrit ? 'active' : 'ghost'} onClick={() => setAllowCrit((v) => !v)}
                      title="When off, items with Critical Strike Chance are excluded from the pool">
                      {allowCrit ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                  <div>
                    <label>Echo items</label>
                    <button className={allowEcho ? 'active' : 'ghost'} onClick={() => setAllowEcho((v) => !v)}
                      title="When off, Echo-family items are excluded from the pool">
                      {allowEcho ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
                <ActiveItemsPanel
                  items={props.items}
                  itemPool={itemPool}
                  activeItems={activeItems}
                  setActiveItems={setActiveItems}
                />
                <div style={{ color: 'var(--ink-faint)', fontSize: 9.5, marginTop: 4 }}>
                  Pool: {itemPool.length} / {totalFinalBuildItems} final-build items · Actives on: {activeItems.size}
                </div>
              </div>
            </div>
          </div>

          {/* Optimizer results table */}
          <div className="panel">
            <div className="panel-head">
              <h3>Optimizer Results</h3>
              <div style={{ color: 'var(--ink-faint)', fontSize: 9.5, letterSpacing: '0.1em' }}>
                {props.optimized ? `${props.optimized.searched.toLocaleString()}/${props.optimized.total.toLocaleString()} · ${props.optimized.results.length} kept · ${(props.optimized.elapsedMs / 1000).toFixed(1)}s` : '—'}
              </div>
            </div>
            <div className="panel-body pad-0">
              {props.optimized && props.optimized.warnings.length > 0 && (
                <div style={{ padding: '8px 10px' }}>
                  <div className="assumption-box">
                    <h4>Optimizer notes</h4>
                    <ul>{props.optimized.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                </div>
              )}
              <OptimizerTable
                results={props.optimized?.results ?? []}
                sortCol={sortCol} setSortCol={setSortCol}
                pinnedBuild={props.pinnedBuild} setPinnedBuild={props.setPinnedBuild}
              />
              {!props.optimized && (
                <div className="empty-state">
                  Set an item pool above and press <strong>Start Optimizer</strong> in the right sidebar.
                </div>
              )}
            </div>
          </div>

          {/* Pinned build analysis / live sim result */}
          <div className="panel">
            <div className="panel-head">
              <h3>{props.pinnedBuild ? 'Pinned Build · Analysis' : 'Current Build · Last Sim'}</h3>
              {props.pinnedBuild && (
                <button className="ghost" onClick={() => props.setPinnedBuild(null)}>Unpin</button>
              )}
            </div>
            <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <h4 style={{ marginBottom: 5 }}>DPS Timeline</h4>
                {props.result ? <DpsChart series={props.result.dpsSeries} events={props.result.damageEvents} /> : <div className="empty-state" style={{ padding: '20px 10px' }}>Run a sim to see the DPS graph.</div>}
                {props.result && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 9, color: 'var(--ink-faint)', marginTop: 2, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {['basic', 'ability', 'item', 'dot', 'passive', 'active', 'relic'].map((src) => (
                      <span key={src} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: SOURCE_COLORS[src], display: 'inline-block' }} />
                        {src}
                      </span>
                    ))}
                  </div>
                )}
                {props.result && (
                  <div style={{ marginTop: 8 }}>
                    <h4 style={{ marginBottom: 5 }}>Top Damage Sources</h4>
                    {topN(props.result.byLabel, 7).map(([lab, v]) => (
                      <div className="bar" key={lab}>
                        <div className="fill" style={{ width: `${(v / (topN(props.result!.byLabel, 1)[0]?.[1] ?? 1)) * 100}%` }} />
                        <div className="text"><span>{lab}</span><span>{v.toFixed(0)}</span></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <h4 style={{ marginBottom: 5 }}>Events</h4>
                {props.result ? (
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)' }}>
                    <table className="dmg-table">
                      <thead><tr><th>t</th><th>Event</th><th>Src</th><th>Type</th><th style={{ textAlign: 'right' }}>Dmg</th></tr></thead>
                      <tbody>
                        {props.result.damageEvents.map((e, i) => (
                          <tr key={i} className={`src-${e.source}`}>
                            <td>{e.t.toFixed(2)}</td>
                            <td><span className={`src-dot src-${e.source}`} title={`source: ${e.source}`} />{e.label}</td>
                            <td style={{ color: 'var(--ink-faint)' }}>{e.source}</td>
                            <td className={`type-${e.damageType}`}>{e.damageType}</td>
                            <td className="num">{e.postMitigation.toFixed(0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-state" style={{ padding: '20px 10px' }}>No events yet.</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="right-col">
          {/* Totals */}
          <div className="panel">
            <div className="panel-head"><h3>Totals</h3></div>
            <div className="panel-body">
              {props.result ? (
                <div className="tot-row">
                  <div className="tot-card total" style={{ gridColumn: '1 / -1' }}>
                    <div className="label">Total damage</div>
                    <div className="v">{props.result.totals.total.toFixed(0)}</div>
                  </div>
                  <div className="tot-card time"><div className="label">Combo t</div><div className="v">{props.result.comboExecutionTime.toFixed(2)}s</div></div>
                  <div className="tot-card dps"><div className="label">DPS</div><div className="v">{(props.result.totals.total / Math.max(0.01, props.result.comboExecutionTime)).toFixed(0)}</div></div>
                  <div className="tot-card phys"><div className="label">Phys</div><div className="v">{props.result.totals.physical.toFixed(0)}</div></div>
                  <div className="tot-card mag"><div className="label">Mag</div><div className="v">{props.result.totals.magical.toFixed(0)}</div></div>
                </div>
              ) : (
                <div className="empty-state" style={{ padding: '10px 0' }}>Run a sim to see totals.</div>
              )}
              {props.error && (
                <div className="warning-box" style={{ marginTop: 8 }}>
                  <h4>Sim error</h4>
                  <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 9.5 }}>{props.error}</pre>
                </div>
              )}
            </div>
          </div>

          {/* Computed stats */}
          <div className="panel">
            <div className="panel-head"><h3>Effective Stats</h3></div>
            <div className="panel-body tight">
              {displaySnapshot ? (
                <div className="stat-list">
                  <StatRow k="Max Health" v={displaySnapshot.attacker.maxHealth.toFixed(0)} cls="cyan" />
                  <StatRow
                    k="EHP (avg)"
                    v={((ehp(displaySnapshot.attacker.maxHealth, displaySnapshot.attacker.physicalProtection)
                       + ehp(displaySnapshot.attacker.maxHealth, displaySnapshot.attacker.magicalProtection)) / 2).toFixed(0)}
                    cls="amber"
                  />
                  <StatRow k="Mana" v={displaySnapshot.attacker.maxMana.toFixed(0)} />
                  <StatRow k="Phys Prot" v={displaySnapshot.attacker.physicalProtection.toFixed(0)} cls="cyan" />
                  <StatRow k="Mag Prot"  v={displaySnapshot.attacker.magicalProtection.toFixed(0)} cls="violet" />
                  <StatRow k="Inhand Power" v={displaySnapshot.attacker.inhandPower.toFixed(1)} cls="amber" />
                  <StatRow k="Strength" v={displaySnapshot.attacker.adaptiveStrength.toFixed(0)} cls="cyan" />
                  <StatRow k="Intelligence" v={displaySnapshot.attacker.adaptiveIntelligence.toFixed(0)} cls="violet" />
                  <StatRow k="Attack Speed" v={displaySnapshot.attacker.totalAttackSpeed.toFixed(2)} />
                  <StatRow k="CDR %" v={displaySnapshot.attacker.cdrPercent.toFixed(0)} />
                  <StatRow k="Crit %" v={displaySnapshot.attacker.critChance.toFixed(0)} />
                  <StatRow k="Phys Pen" v={`${displaySnapshot.attacker.penFlat.toFixed(0)} / ${displaySnapshot.attacker.penPercent.toFixed(0)}%`} cls="cyan" />
                  <StatRow k="Mag Pen"  v={`${displaySnapshot.attacker.magicalPenFlat.toFixed(0)} / ${displaySnapshot.attacker.magicalPenPercent.toFixed(0)}%`} cls="violet" />
                  <StatRow k="Primary" v={displaySnapshot.attacker.primaryStat} />
                </div>
              ) : <div className="empty-state" style={{ padding: '10px 0' }}>Loading stats…</div>}
            </div>
          </div>

          {/* Optimizer controls */}
          <div className="panel">
            <div className="panel-head"><h3>Controls</h3></div>
            <div className="ctrl-section">
              <button className="primary primary-cta" style={{ width: '100%' }}
                onClick={() => props.onOptimize({
                  pool: itemPool,
                  buildSize,
                  rankBy,
                  rankByAbilityLabel: rankBy === 'ability' ? rankByAbilityLabel : undefined,
                  requireStarter,
                  max: maxPerms,
                  statMin: compactNumberRecord(statMin),
                  statMax: compactNumberRecord(statMax),
                  evolveStacking,
                  activeItems: [...activeItems],
                })}
                disabled={props.optimizing || !hasAttacker || itemPool.length === 0}>
                {props.optimizing ? 'Optimizing…' : 'Start Optimizer ⚡'}
              </button>
              <div className="ctrl-buttons">
                <button className="ghost" onClick={props.onOptimizeCancel} disabled={!props.optimizing}>Cancel</button>
                <button className="ghost" onClick={() => props.setPinnedBuild(null)}>Reset</button>
              </div>

              {props.optimized && (
                <>
                  <div style={{ height: 10 }} />
                  <h3>Permutations</h3>
                  <div className="ctrl-row"><span className="k">Pool size</span><span className="v">{itemPool.length}</span></div>
                  <div className="ctrl-row"><span className="k">Searched</span><span className="v">{props.optimized.searched.toLocaleString()}</span></div>
                  <div className="ctrl-row"><span className="k">Total</span><span className="v">{props.optimized.total.toLocaleString()}</span></div>
                  <div className="ctrl-row"><span className="k">Results</span><span className="v">{props.optimized.results.length}</span></div>
                  <div className="ctrl-row"><span className="k">Elapsed</span><span className="v">{(props.optimized.elapsedMs / 1000).toFixed(2)}s</span></div>
                </>
              )}
            </div>
          </div>

          {displayScenario && (
            <div style={{ color: 'var(--ink-faint)', fontSize: 9.5, textAlign: 'center', padding: 6 }}>
              {props.pinnedBuild ? 'Showing pinned build stats' : 'Stats auto-update from current build'}
            </div>
          )}
        </div>
      </div>

      {showGodPicker && (
        <GodPicker gods={props.gods}
          onPick={(id) => { setAttacker({ ...scenario.attacker, godId: id }); setShowGodPicker(false) }}
          onClose={() => setShowGodPicker(false)} />
      )}
      {showEnemyPicker && (
        <GodPicker gods={props.gods}
          onPick={(id) => { setDefender({ ...scenario.defender, godId: id }); setShowEnemyPicker(false) }}
          onClose={() => setShowEnemyPicker(false)} />
      )}
      {itemPickerIndex !== null && (
        <ItemPicker items={props.items}
          attackerGodId={scenario.attacker.godId}
          onPick={(name) => {
            const next = [...scenario.attacker.items]
            next[itemPickerIndex] = name
            setAttacker({ ...scenario.attacker, items: next.filter(Boolean).slice(0, 6) })
            setItemPickerIndex(null)
            props.setPinnedBuild(null)
          }}
          onClose={() => setItemPickerIndex(null)} />
      )}
    </div>
  )
}

function pinnedOrCurrent(scenario: Scenario, pinned: OptimizedBuild | null): Scenario {
  if (!pinned) return scenario
  return { ...scenario, attacker: { ...scenario.attacker, items: pinned.items } }
}

function snapshotFromPinned(p: OptimizedBuild, base: Snapshot | null): Snapshot | null {
  if (!base) return null
  return {
    attacker: { ...base.attacker, ...p.stats, maxMana: base.attacker.maxMana, moveSpeed: base.attacker.moveSpeed, primaryStat: base.attacker.primaryStat },
    defender: base.defender,
  }
}

function compactNumberRecord(input: Partial<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

function updateNumberFilter(
  setFilter: React.Dispatch<React.SetStateAction<Partial<Record<string, number>>>>,
  key: string,
  raw: string,
): void {
  setFilter((prev) => {
    const next = { ...prev }
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value)) delete next[key]
    else next[key] = value
    return next
  })
}

// Panel listing items in the pool that have `On Use:` actives. Each has a
// checkbox — when on, the optimizer will fire that item's active during the
// combo (prepending an `activate` step). Off = stats-only.
function ActiveItemsPanel(props: {
  items: ItemRef[]
  itemPool: string[]
  activeItems: Set<string>
  setActiveItems: (s: Set<string>) => void
}) {
  const poolSet = useMemo(() => new Set(props.itemPool), [props.itemPool])
  const withActives = useMemo(
    () => props.items.filter((it) =>
      it.name && poolSet.has(it.name) && /on use:/i.test(it.passive ?? '')
    ),
    [props.items, poolSet]
  )
  if (withActives.length === 0) return null

  function toggle(name: string) {
    const next = new Set(props.activeItems)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    props.setActiveItems(next)
  }

  const allNames = withActives.map((it) => it.name!).filter(Boolean)
  const allOn = allNames.length > 0 && allNames.every((n) => props.activeItems.has(n))
  function toggleAll() {
    if (allOn) props.setActiveItems(new Set())
    else props.setActiveItems(new Set(allNames))
  }

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <label style={{ margin: 0 }}>Actives ({withActives.length} in pool)</label>
        <button
          type="button"
          className={allOn ? 'active' : 'ghost'}
          onClick={toggleAll}
          style={{ fontSize: 9.5, padding: '2px 8px', width: 'auto' }}
          title={allOn ? 'Turn all actives off — only base stats count' : 'Turn all actives on — use each item’s active passive in the calc'}
        >
          {allOn ? 'All on' : 'All off'}
        </button>
      </div>
      <div style={{
        maxHeight: 110, overflowY: 'auto',
        border: '1px solid var(--line)', background: 'var(--bg-2)',
        padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        {withActives.map((it) => {
          const on = props.activeItems.has(it.name!)
          return (
            <label key={it.key} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              cursor: 'pointer', fontSize: 10.5, color: on ? 'var(--ink)' : 'var(--ink-faint)',
              margin: 0, textTransform: 'none', letterSpacing: 0,
            }}>
              <input type="checkbox" checked={on} onChange={() => toggle(it.name!)}
                style={{ width: 'auto', margin: 0 }} />
              <span style={{ flex: 1 }}>{it.name}</span>
              {on && <span style={{ color: 'var(--amber)', fontSize: 9 }}>⚡</span>}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// Inputs that truncate a god's per-ability output. Applies to BOTH DoT ticks
// (e.g. Loki A02 — "3 of 8 ticks") AND multi-hit direct abilities (e.g. Da Ji
// A02's 3-hit combo, Ratatoskr A02 dash — "2 of 3 hits"). Empty = use the
// full tick/hit count from the game data.
function TickOverridesRow(props: {
  scenario: Scenario
  setOptions: (o: NonNullable<Scenario['options']>) => void
}) {
  const godId = props.scenario.attacker.godId
  const overrides = props.scenario.options?.tickOverrides ?? {}
  const slots: AbilitySlot[] = ['A01', 'A02', 'A03', 'A04']
  function update(slot: AbilitySlot, raw: string) {
    const key = `${godId}.${slot}`
    const next = { ...overrides }
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n) || n < 0) delete next[key]
    else next[key] = Math.floor(n)
    props.setOptions({ ...(props.scenario.options ?? {}), tickOverrides: next })
  }
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ color: 'var(--ink-faint)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2 }}>
        Tick / hit count (empty = full)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        {slots.map((slot) => {
          const key = `${godId}.${slot}`
          const val = overrides[key]
          return (
            <label key={slot} style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}>
              <span style={{ fontSize: 9.5, color: 'var(--ink-faint)', width: 28 }}>{slot}</span>
              <input
                type="number" min={0} max={20} step={1}
                value={val == null ? '' : String(val)}
                placeholder="all"
                onChange={(e) => update(slot, e.target.value)}
                style={{ width: '100%' }}
                title={`How many ticks/hits of ${slot} actually land. Leave blank to use the full count from the game data.`}
              />
            </label>
          )
        })}
      </div>
    </div>
  )
}

// Combat time slider — when set, the sim extends past the rotation steps and
// fills remaining time with basic attacks (greedyBasics). Useful for seeing
// "if I'm in a 10-second fight, what's my total damage including AA filler
// during ability cooldowns" which shows ability downtime visually via DPS chart.
function CombatTimeRow(props: {
  scenario: Scenario
  setOptions: (o: NonNullable<Scenario['options']>) => void
}) {
  const cur = props.scenario.options?.combatWindow ?? 0
  function update(raw: string) {
    const n = Number(raw)
    const opts = { ...(props.scenario.options ?? {}) }
    if (raw === '' || !Number.isFinite(n) || n <= 0) {
      delete opts.combatWindow
      delete opts.greedyBasics
    } else {
      opts.combatWindow = Math.min(60, Math.max(0.5, n))
      opts.greedyBasics = true
    }
    props.setOptions(opts)
  }
  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
      <label style={{ margin: 0, minWidth: 90 }}>Combat time</label>
      <input
        type="number" min={0} max={60} step={0.5}
        value={cur > 0 ? cur : ''}
        placeholder="rotation only"
        onChange={(e) => update(e.target.value)}
        style={{ flex: 1 }}
        title="Extend the sim to N seconds and fill remaining time with basic attacks. Shows ability downtime as AA filler during cooldowns."
      />
      <span style={{ color: 'var(--ink-faint)', fontSize: 9 }}>s</span>
    </div>
  )
}

function StatRow({ k, v, cls }: { k: string; v: string | number; cls?: string }) {
  return <div className="stat-row"><span className="k">{k}</span><span className={`v ${cls ?? ''}`}>{v}</span></div>
}

function ehp(hp: number, prot: number): number {
  return hp * (1 + prot / 100)
}

function topN(rec: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n)
}

// ================= Optimizer results table (Fribbels-style heatmap) =================
function OptimizerTable(props: {
  results: OptimizedBuild[]
  sortCol: string; setSortCol: (c: string) => void
  pinnedBuild: OptimizedBuild | null; setPinnedBuild: (b: OptimizedBuild | null) => void
}) {
  if (props.results.length === 0) return null

  const cols: Array<{ k: string; label: string; get: (b: OptimizedBuild) => number; fmt?: (n: number) => string }> = [
    { k: 'total', label: 'Total', get: (b) => b.totals.total },
    { k: 'dps',   label: 'DPS',   get: (b) => b.dps },
    { k: 'combo', label: 'Combo', get: (b) => b.comboExecutionTime, fmt: (n) => n.toFixed(2) + 's' },
    { k: 'phys',  label: 'Phys',  get: (b) => b.totals.physical },
    { k: 'mag',   label: 'Mag',   get: (b) => b.totals.magical },
    { k: 'true',  label: 'True',  get: (b) => b.totals.true },
    { k: 'str',   label: 'Str',   get: (b) => b.stats.adaptiveStrength },
    { k: 'int',   label: 'Int',   get: (b) => b.stats.adaptiveIntelligence },
    { k: 'ip',    label: 'Power', get: (b) => b.stats.inhandPower },
    { k: 'as',    label: 'AS',    get: (b) => b.stats.totalAttackSpeed, fmt: (n) => n.toFixed(2) },
    { k: 'cdr',   label: 'CDR',   get: (b) => b.stats.cdrPercent },
    { k: 'crit',  label: 'Crit',  get: (b) => b.stats.critChance },
    { k: 'ehp',   label: 'EHP',   get: (b) => b.stats.maxHealth * (1 + b.stats.physicalProtection / 100) },
  ]

  const sortCol = cols.find((c) => c.k === props.sortCol) ?? cols[0]
  const sorted = [...props.results].sort((a, b) => sortCol.get(b) - sortCol.get(a))

  // Compute min/max per column for heatmap.
  const ranges: Record<string, { min: number; max: number }> = {}
  for (const c of cols) {
    const vs = sorted.map(c.get)
    ranges[c.k] = { min: Math.min(...vs), max: Math.max(...vs) }
  }

  return (
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table className="opt-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Items</th>
            {cols.map((c) => (
              <th key={c.k} className={sortCol.k === c.k ? 'active' : ''} onClick={() => props.setSortCol(c.k)}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 200).map((b, i) => (
            <tr key={i}
              className={props.pinnedBuild?.items.join('|') === b.items.join('|') ? 'pinned' : ''}
              onClick={() => props.setPinnedBuild(b)}>
              <td className="items-col">{b.items.join(' · ')}</td>
              {cols.map((c) => {
                const v = c.get(b)
                const r = ranges[c.k]
                const frac = r.max > r.min ? (v - r.min) / (r.max - r.min) : 0.5
                const color = frac > 0.75 ? 'var(--heat-high)' : frac > 0.4 ? 'var(--heat-mid)' : 'var(--heat-low)'
                return (
                  <td className="heat" key={c.k}>
                    <div className="heat-bg" style={{ background: color, width: `${frac * 100}%` }} />
                    <span className="heat-v">{c.fmt ? c.fmt(v) : v.toFixed(0)}</span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ================= Empty tab shells =================
function ScenariosTab() {
  return (
    <div className="tab-body"><div className="page-shell">
      <h1>Scenarios</h1><p className="sub">Multi-scenario comparisons + saved combos.</p>
      <div className="coming-soon"><h2>Coming soon</h2><p>Run several scenarios side-by-side. For now use the Characters tab or <code>npm run sim</code>.</p></div>
    </div></div>
  )
}
function BuildsTab() {
  return (
    <div className="tab-body"><div className="page-shell">
      <h1>Saved Builds</h1><p className="sub">Shared builds you've opened this session.</p>
      <div className="coming-soon"><h2>Coming soon</h2><p>Persistent builds via FileBuildRepository or Postgres (tbd).</p></div>
    </div></div>
  )
}

// ================= Main =================
export default function App() {
  const [gods, setGods] = useState<GodRef[]>([])
  const [items, setItems] = useState<ItemRef[]>([])
  const itemLookup = useMemo(() => {
    const m = new Map<string, ItemRef>()
    for (const it of items) if (it.name) m.set(it.name, it)
    return m
  }, [items])

  const [localScenario, setLocalScenario] = useState<Scenario>(defaultScenario())
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('characters')

  const [optimized, setOptimized] = useState<OptimizeResult | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const optAbortRef = useRef<AbortController | null>(null)
  const [pinnedBuild, setPinnedBuild] = useState<OptimizedBuild | null>(null)

  const [buildId, setBuildId] = useState<string | null>(() => readBuildIdFromHash())
  const collab = useCollabBuild(buildId)
  useEffect(() => { writeBuildIdToHash(buildId) }, [buildId])
  useEffect(() => {
    const onHash = () => setBuildId(readBuildIdFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    fetchGods().then(setGods).catch((e) => setError(`gods: ${e.message}`))
    fetchItems().then(setItems).catch((e) => setError(`items: ${e.message}`))
  }, [])

  useEffect(() => { if (collab.doc) setLocalScenario(buildToScenario(collab.doc)) }, [collab.doc])

  const scenario = useMemo(
    () => collab.doc ? buildToScenario(collab.doc) : localScenario,
    [collab.doc, localScenario],
  )
  const debouncedScenario = useDebounced(scenario, 250)

  useEffect(() => {
    let cancelled = false
    if (!debouncedScenario.attacker.godId || !debouncedScenario.defender.godId) {
      setSnapshot(null)
      return () => { cancelled = true }
    }
    fetchSnapshot(debouncedScenario)
      .then((s) => { if (!cancelled) setSnapshot(s) })
      .catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [debouncedScenario])

  const invalidateOptimization = useCallback(() => {
    setOptimized(null)
    setPinnedBuild(null)
    setResult(null)
  }, [])

  const setAttacker = useCallback((a: Scenario['attacker']) => {
    invalidateOptimization()
    if (collab.buildId) collab.applyPatch((p) => p.setAttacker(a))
    else setLocalScenario((s) => ({ ...s, attacker: a }))
  }, [collab, invalidateOptimization])
  const setDefender = useCallback((d: Scenario['defender']) => {
    invalidateOptimization()
    if (collab.buildId) collab.applyPatch((p) => p.setDefender(d))
    else setLocalScenario((s) => ({ ...s, defender: d }))
  }, [collab, invalidateOptimization])
  const setOptions = useCallback((o: NonNullable<Scenario['options']>) => {
    invalidateOptimization()
    // Collab doc doesn't sync ScenarioOptions yet, so local-only update.
    setLocalScenario((s) => ({ ...s, options: o }))
  }, [invalidateOptimization])
  const addStep = useCallback((step: RotationAction) => {
    invalidateOptimization()
    if (collab.buildId) collab.applyPatch((p) => p.appendRotationStep(step))
    else setLocalScenario((s) => ({ ...s, rotation: [...s.rotation, step] }))
  }, [collab, invalidateOptimization])
  const removeStep = useCallback((index: number) => {
    invalidateOptimization()
    if (collab.buildId) collab.applyPatch((p) => p.removeRotationStep(index))
    else setLocalScenario((s) => ({ ...s, rotation: s.rotation.filter((_, j) => j !== index) }))
  }, [collab, invalidateOptimization])

  async function run() {
    if (!scenario.attacker.godId) {
      setError('Pick an attacker god before running the sim.')
      return
    }
    setRunning(true); setError(null)
    try { setResult(await runScenarioRemote(pinnedOrCurrent(scenario, pinnedBuild))) }
    catch (e) { setError((e as Error).message) }
    finally { setRunning(false) }
  }

  async function doOptimize(opts: {
    pool: string[]; buildSize: number; rankBy: OptimizeRequest['rankBy'];
    rankByAbilityLabel?: string;
    requireStarter: boolean; max: number;
    statMin: Record<string, number>; statMax: Record<string, number>;
    evolveStacking: boolean; activeItems: string[];
  }) {
    if (!scenario.attacker.godId) {
      setError('Pick an attacker god before optimizing.')
      return
    }
    setOptimizing(true); setError(null); setPinnedBuild(null)
    optAbortRef.current?.abort()
    const ac = new AbortController(); optAbortRef.current = ac
    try {
      const r = await fetch('/api/optimize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenario, itemPool: opts.pool, buildSize: opts.buildSize,
          rankBy: opts.rankBy, requireOneStarter: opts.requireStarter,
          rankByAbilityLabel: opts.rankByAbilityLabel,
          statMin: opts.statMin,
          statMax: opts.statMax,
          evolveStackingItems: opts.evolveStacking,
          activeItems: opts.activeItems,
          maxPermutations: opts.max, topN: 200,
        } satisfies OptimizeRequest),
        signal: ac.signal,
      })
      if (!r.ok) throw new Error(`optimize: ${r.status} ${await r.text()}`)
      const result = await r.json()
      if (optAbortRef.current === ac) setOptimized(result)
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && optAbortRef.current === ac) {
        setError(`optimizer: ${(e as Error).message}`)
      }
    } finally {
      if (optAbortRef.current === ac) {
        optAbortRef.current = null
        setOptimizing(false)
      }
    }
  }

  function cancelOptimize() { optAbortRef.current?.abort() }

  async function onShare() {
    try {
      const id = await collab.createShared({
        title: scenario.title ?? 'Shared build',
        attacker: scenario.attacker, defender: scenario.defender,
        rotation: scenario.rotation, enemies: scenario.enemies,
        options: scenario.options, teamAttackers: scenario.teamAttackers, notes: '',
      })
      setBuildId(id)
      const url = new URL(window.location.href); url.hash = new URLSearchParams({ build: id }).toString()
      navigator.clipboard?.writeText(url.toString()).catch(() => { /* ignore */ })
    } catch (err) { setError(`share failed: ${(err as Error).message}`) }
  }
  function onLeave() { setBuildId(null) }

  return (
    <div className="app-shell">
      <TopBar collab={{ buildId: collab.buildId, peers: collab.peers }} onShare={onShare} onLeave={onLeave} />
      <TabBar active={activeTab} onChange={setActiveTab} />
      {activeTab === 'characters' && (
        <CharactersTab
          scenario={scenario} setAttacker={setAttacker} setDefender={setDefender} setOptions={setOptions}
          addStep={addStep} removeStep={removeStep}
          onRun={run} running={running}
          gods={gods} items={items} itemLookup={itemLookup}
          snapshot={snapshot} result={result} error={error}
          optimized={optimized} optimizing={optimizing}
          onOptimize={doOptimize} onOptimizeCancel={cancelOptimize}
          pinnedBuild={pinnedBuild} setPinnedBuild={(b) => { setPinnedBuild(b); setResult(null) }}
          godPrimaryStat={gods.find((g) => g.id === scenario.attacker.godId)?.primaryStat ?? null}
        />
      )}
      {activeTab === 'sim' && <ScenariosTab />}
      {activeTab === 'builds' && <BuildsTab />}
    </div>
  )
}
