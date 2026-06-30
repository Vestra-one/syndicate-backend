/**
 * Config service client (§2).  Reads the allowlisted table templates that the
 * backend will accept for a host-created match.  The `configHash` here MUST be
 * the one passed into `create_and_deposit` — the backend rejects any other.
 *
 * Source: GET ${VITE_CONFIG_URL}/config/templates
 */
import type { Chips, TableTerms } from '@/lib/protocol'

const CONFIG_URL = (import.meta.env.VITE_DEVNET_USER as string | undefined)
  ? '/config-proxy'
  : (import.meta.env.VITE_CONFIG_URL as string | undefined)

/** Raw `config` block inside a template (superset of TableTerms). */
interface TemplateConfig {
  priceFeedId: string
  supportedFeeds: string[]
  chipsToken: string
  oracleAdapter: string
  settlementMode: string
  oracleUnavailableMessage: string
  buyIn: Chips
  maxBuyIn: Chips
  chipsPerUnit: number
  smallBlind: Chips
  bigBlind: Chips
  ante: Chips
  entryFee: Chips
  rakeBps: number
  rakeCap: Chips
  minPlayers: number
  maxPlayers: number
  actionTimerSec: number
  timeBankSec: number
  roundCount: number
  roundDurationsSec: number[]
  observationWindowsSec: number[]
  sealWindowSec: number
  beginLiveWindowSec: number
  nonsealPenaltyBps: number
  settlementWindowSec: number
  timelockTargetOffsetSec: number
  geofenceBlocklist: string[]
  allowDuplicateWalletPerMatch: false
  fillWindowSec: number
  practiceMode: boolean
}

export interface ConfigTemplate {
  templateId: string
  tierId: string
  label: string
  feed: string
  buyIn: Chips
  config: TemplateConfig
  configHash: string // 64-char hex (32 bytes)
  totalBettingDurationSec: number
}

/** All on-chain CreateParams numeric fields a host needs (derived from a template). */
export interface CreateTableParams {
  buyIn: Chips
  entryFee: Chips
  rakeBps: number
  rakeCap: Chips
  nonsealPenaltyBps: number
  minPlayers: number
  maxPlayers: number
  configHash: string
  totalBettingDurationSec: number
  sealWindowSec: number
  beginLiveWindowSec: number
  fillWindowSec: number
  /** price fixed-point decimals → on-chain oracle exponent is the negative of this. */
  decimals: number
}

let cache: { templates: ConfigTemplate[]; at: number } | null = null
const CACHE_TTL_MS = 60_000

/** Fetch (and cache for 1 min) the allowlisted templates. Throws if config is unreachable. */
export async function fetchTemplates(): Promise<ConfigTemplate[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.templates
  if (!CONFIG_URL) throw new Error('VITE_CONFIG_URL is not set — configure the config service URL')
  const res = await fetch(`${CONFIG_URL}/config/templates`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`/config/templates ${res.status}`)
  const data = (await res.json()) as { templates: ConfigTemplate[] }
  cache = { templates: data.templates ?? [], at: Date.now() }
  return cache.templates
}

/** Pick a template by feed (default BTC/USD) and tier (default lowest). */
export async function pickTemplate(feed = 'BTC/USD', tierId?: string): Promise<ConfigTemplate> {
  const templates = await fetchTemplates()
  const byFeed = templates.filter((t) => t.feed === feed)
  const pool = byFeed.length ? byFeed : templates
  const chosen = tierId ? pool.find((t) => t.tierId === tierId) : pool[0]
  if (!chosen) throw new Error(`no config template for feed=${feed} tier=${tierId ?? 'any'}`)
  return chosen
}

/** Map a template's `config` block to the client `TableTerms` view (for the lobby card). */
export function templateToTerms(t: ConfigTemplate): TableTerms {
  const c = t.config
  return {
    tableId: t.tierId,
    priceFeedId: c.priceFeedId,
    supportedFeeds: c.supportedFeeds,
    chipsToken: c.chipsToken,
    decimals: priceDecimals(c),
    oracleAdapter: 'signed-price',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: c.oracleUnavailableMessage,
    buyIn: c.buyIn,
    entryFee: c.entryFee,
    rakeBps: c.rakeBps,
    rakeCap: c.rakeCap,
    smallBlind: c.smallBlind,
    bigBlind: c.bigBlind,
    minPlayers: c.minPlayers,
    maxPlayers: c.maxPlayers,
    roundCount: c.roundCount,
    roundDurationsSec: c.roundDurationsSec,
    actionTimerSec: c.actionTimerSec,
    timeBankSec: c.timeBankSec,
    settlementWindowSec: c.settlementWindowSec,
    geofenceBlocklist: c.geofenceBlocklist,
    allowDuplicateWalletPerMatch: false,
    fillWindowSec: c.fillWindowSec,
    practiceMode: c.practiceMode,
    timelockTargetRound: 0, // the gateway supplies the real round in its tableTerms push
  }
}

/** Extract the on-chain CreateParams numeric set from a template. */
export function templateToCreateParams(t: ConfigTemplate): CreateTableParams {
  const c = t.config
  return {
    buyIn: c.buyIn,
    entryFee: c.entryFee,
    rakeBps: c.rakeBps,
    rakeCap: c.rakeCap,
    nonsealPenaltyBps: c.nonsealPenaltyBps,
    minPlayers: c.minPlayers,
    maxPlayers: c.maxPlayers,
    configHash: t.configHash,
    totalBettingDurationSec: t.totalBettingDurationSec,
    sealWindowSec: c.sealWindowSec,
    beginLiveWindowSec: c.beginLiveWindowSec,
    fillWindowSec: c.fillWindowSec,
    decimals: priceDecimals(c),
  }
}

/** Display decimals for the betting fixed-point (not the oracle WAD exponent). */
function priceDecimals(_c: TemplateConfig): number {
  return 2
}
