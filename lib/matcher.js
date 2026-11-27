/**
 * 黑名单匹配。
 *
 * 匹配优先级：
 *   1. puuid        —— 最可靠，跨改名都稳定
 *   2. summonerId   —— 同一大区内唯一
 *   3. Riot ID      —— 按完整的 gameName#tagLine 比较
 *   4. 纯名字        —— 最后兜底（改名 / 老数据），要求大区一致
 *
 * 大区只用于区分区域内 ID 和旧版纯昵称记录。
 */

import { normalizeText } from './dom.js'
import { displayNameOf, parseRiotId } from './model.js'
import { normalizePlatform } from './region.js'

function sameText(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
}

export function regionCompatible(a, b) {
  const left = normalizePlatform(a)
  const right = normalizePlatform(b)
  if (!left || !right) return true
  return left === right
}

/** Riot ID 归一化：GameName#Tag -> "gamename#tag"。 */
export function riotIdOf(player) {
  if (!player) return ''
  const gameName = player.gameName || ''
  const tagLine = player.tagLine || ''
  if (!gameName) return ''
  return normalizeText(tagLine ? `${gameName}#${tagLine}` : gameName)
}

export function completeRiotIdOf(player) {
  if (!player) return ''
  const id = player.gameName && player.tagLine ? player :
    parseRiotId(player.gameName) || parseRiotId(player.name) || parseRiotId(player.legacyName)
  return id ? riotIdOf(id) : ''
}

/** 参与匹配的所有名字写法（归一化）。 */
export function playerAliases(player) {
  if (!player) return []
  const aliases = []
  const riotId = riotIdOf(player)
  if (riotId) aliases.push(riotId)
  if (player.gameName) aliases.push(normalizeText(player.gameName))
  if (player.legacyName) aliases.push(normalizeText(player.legacyName))
  if (player.name) aliases.push(normalizeText(player.name))
  return Array.from(new Set(aliases.filter((value) => value && value.length >= 2)))
}

/** 判断一个玩家是否命中某条黑名单记录。 */
export function matchesEntry(player, entry) {
  if (!player || !entry) return false

  // 1. puuid
  if (player.puuid && entry.puuid) return sameText(player.puuid, entry.puuid)

  const leftRegion = normalizePlatform(player.platformId || player.region)
  const rightRegion = normalizePlatform(entry.region)
  const sameRegionalId = player.summonerId && entry.summonerId &&
    Number(player.summonerId) === Number(entry.summonerId)
  if (sameRegionalId && leftRegion && leftRegion === rightRegion && leftRegion !== 'TENCENT') return true

  const entryRiotId = completeRiotIdOf(entry)
  if (entryRiotId) return completeRiotIdOf(player) === entryRiotId
  if (entry.legacyUnverified) return false

  // 旧记录只有区内 ID 或昵称时，沿用原来的同区匹配。
  if (!regionCompatible(leftRegion, rightRegion)) return false
  if (sameRegionalId) return true

  const aliases = playerAliases(player)
  if (!aliases.length) return false

  const entryAliases = new Set(playerAliases(entry))
  for (const alias of aliases) {
    if (entryAliases.has(alias)) return true
  }

  // 纯 gameName 兜底（老数据可能只有 summonerName）
  if (player.gameName && entry.gameName) {
    const left = normalizeText(player.gameName)
    const right = normalizeText(entry.gameName)
    if (left && left === right) return true
  }

  return false
}

/** 在记录列表里找出该玩家命中的那条（新的优先）。 */
export function findEntryForPlayer(player, entries) {
  if (!player || !Array.isArray(entries)) return null
  let best = null
  let bestExact = false
  for (const entry of entries) {
    if (!matchesEntry(player, entry)) continue
    const exact = !!completeRiotIdOf(entry) || sameText(player.puuid, entry.puuid)
    if (!best || (exact && !bestExact) || (exact === bestExact && (entry.createdAt || 0) > (best.createdAt || 0))) {
      best = entry
      bestExact = exact
    }
  }
  return best
}

/**
 * 批量匹配一局里的所有玩家。
 * @param {Array} players
 * @param {Array} entries
 * @param {{ self?: object }} [options]
 * @returns {Array<{player: object, entry: object}>}
 */
export function findHitsForPlayers(players, entries, options = {}) {
  const hits = []
  const seen = new Set()
  const self = options.self

  for (const player of players || []) {
    if (!player) continue
    if (self) {
      if (self.puuid && player.puuid && self.puuid === player.puuid) continue
      if (self.summonerId && player.summonerId && self.summonerId === player.summonerId) continue
    }

    const entry = findEntryForPlayer(player, entries)
    if (!entry) continue

    const key = entry.id || `${player.puuid || player.summonerId || displayNameOf(player)}`
    if (seen.has(key)) continue
    seen.add(key)

    hits.push({ player, entry })
  }

  return hits
}

function hitKey(hit) {
  if (!hit) return ''
  if (hit.entry && hit.entry.id) return hit.entry.id
  if (hit.player && hit.player.puuid) return `p:${hit.player.puuid}`
  if (hit.player && hit.player.summonerId) return `s:${hit.player.summonerId}`
  return ''
}

/**
 * 合并两份命中结果（选人阶段 + 游戏内名单）。
 *
 * 加载界面 gameflow 的 playerList 有时只给我方，
 * 直接覆盖会丢掉选人阶段已经看到的对面玩家，所以取并集。
 */
export function mergeHitLists(previous, next) {
  const map = new Map()
  for (const hit of previous || []) {
    const key = hitKey(hit)
    if (key) map.set(key, hit)
  }
  for (const hit of next || []) {
    const key = hitKey(hit)
    if (!key) continue
    const old = map.get(key)
    map.set(key, old ? { ...old, ...hit } : hit)
  }
  return Array.from(map.values())
}
