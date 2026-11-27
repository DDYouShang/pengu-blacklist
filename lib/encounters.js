/**
 * 「最近遇到过的人」数据层。
 *
 * 按客户端战绩的顺序查找本局玩家曾经出现过的对局。
 */

import { regionCompatible, riotIdOf } from './matcher.js'
import { toTimestamp } from './util.js'

/** 本地最多保留多少局（硬顶，跟展示用的 lookbackGames 不是一回事）。 */
export const MAX_ENCOUNTER_GAMES = 50

/** 默认回看局数。 */
export const DEFAULT_LOOKBACK_GAMES = 5

/** 默认时间窗：超过这么多天没遇到就不再提醒。 */
export const DEFAULT_LOOKBACK_DAYS = 90

/** 每个熟人最多展示几个历史英雄。 */
export const MAX_CHAMPION_HISTORY = 3

/** 一局少于这个秒数按「重开」处理，不计入回看。 */
export const REMAKE_SECONDS = 300

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 把 LCU / 旧数据里的一个玩家洗成统一结构。
 * 没有任何身份信息时返回 null。
 */
export function sanitizeEncounterPlayer(raw) {
  if (!raw || typeof raw !== 'object') return null

  const puuid = str(raw.puuid)
  const summonerId = num(raw.summonerId)
  const gameName = str(raw.gameName)
  const tagLine = str(raw.tagLine)
  const legacyName = str(raw.legacyName ?? raw.summonerName)

  if (!puuid && !summonerId && !gameName && !legacyName) return null

  return {
    puuid,
    summonerId,
    gameName,
    tagLine,
    legacyName,
    championId: num(raw.championId),
    teamId: num(raw.teamId),
  }
}

/**
 * 洗一局对局快照。
 * @param {Object} raw
 * @param {number} [now]
 * @returns {Object|null}
 */
export function sanitizeEncounterGame(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null

  const gameId = num(raw.gameId)
  const at = toTimestamp(raw.at ?? raw.gameCreation) || now
  const gameDuration = num(raw.gameDuration)

  const players = []
  const seen = new Set()
  for (const rawPlayer of raw.players || []) {
    const player = sanitizeEncounterPlayer(rawPlayer)
    if (!player) continue
    const key = player.puuid || (player.summonerId ? `s${player.summonerId}` : '')
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    players.push(player)
  }

  if (!players.length) return null

  const remake =
    raw.remake === undefined ? gameDuration > 0 && gameDuration < REMAKE_SECONDS : !!raw.remake

  return {
    gameId,
    at,
    queueId: num(raw.queueId),
    platformId: str(raw.platformId).toUpperCase(),
    selfTeamId: num(raw.selfTeamId),
    remake,
    players,
  }
}

function gameKey(game) {
  if (game.gameId) return `g:${game.gameId}`
  return `t:${game.at}`
}

/** 批量清洗：去重（同 gameId 只留人多的那份）、按时间倒序、截断。 */
export function normalizeEncounterGames(list, { now = Date.now(), maxGames = MAX_ENCOUNTER_GAMES } = {}) {
  const byKey = new Map()

  for (const raw of Array.isArray(list) ? list : []) {
    const game = sanitizeEncounterGame(raw, now)
    if (!game) continue
    const key = gameKey(game)
    const existing = byKey.get(key)
    if (!existing || game.players.length > existing.players.length) byKey.set(key, game)
  }

  return Array.from(byKey.values())
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, maxGames))
}

/** 把一批新对局合并进已有历史。 */
export function mergeEncounterGames(existing, incoming, options = {}) {
  const now = options.now ?? Date.now()
  const maxGames = options.maxGames ?? MAX_ENCOUNTER_GAMES
  return normalizeEncounterGames([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])], {
    now,
    maxGames,
  })
}

/** 双方都有可比较的账号 ID 时，以该 ID 的比较结果为准。 */
export function sameEncounterPlayer(player, candidate, platformId = '') {
  if (!player || !candidate) return false
  if (player.puuid && candidate.puuid) return player.puuid === candidate.puuid
  if (!regionCompatible(player.platformId, candidate.platformId || platformId)) return false
  if (player.summonerId && candidate.summonerId) {
    return Number(player.summonerId) === Number(candidate.summonerId)
  }
  if (!player.gameName || !candidate.gameName || !player.tagLine || !candidate.tagLine) return false
  return riotIdOf(player) === riotIdOf(candidate)
}

/**
 * 在最近的对局里找出这批玩家。
 *
 * @param {Array} players 选人 / 游戏内归一化后的 PlayerRef
 * @param {Array} games   战绩顺序（最新在前），名单缺失的对局也占一局
 * @param {Object} [options]
 * @param {number} [options.lookbackGames=5]
 * @param {number} [options.lookbackDays=90]
 * @param {'both'|'ally'|'enemy'} [options.scope='both']
 * @param {Object} [options.self]
 * @param {number} [options.currentGameId]
 * @param {boolean} [options.includeRemake=false]
 * @param {number} [options.now]
 * @returns {Array<Object>}
 */
export function lookupEncounters(players, games, options = {}) {
  const now = options.now ?? Date.now()
  const lookbackGames = Math.max(1, Number(options.lookbackGames) || DEFAULT_LOOKBACK_GAMES)
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const ageLimit = Number(lookbackDays) > 0 ? Number(lookbackDays) * 86_400_000 : 0
  const scope = options.scope === 'ally' || options.scope === 'enemy' ? options.scope : 'both'
  const includeRemake = options.includeRemake === true
  const currentGameId = Number(options.currentGameId) || 0

  const window = (Array.isArray(games) ? games : [])
    .filter((game) => game && (!currentGameId || game.gameId !== currentGameId))
    .slice(0, lookbackGames)

  if (!window.length) return []

  const results = []

  for (const player of players || []) {
    if (!player || sameEncounterPlayer(player, options.self)) continue

    let found = null
    const champions = []
    let seenCount = 0

    for (let index = 0; index < window.length; index++) {
      const game = window[index]
      if ((!includeRemake && game.remake) || (ageLimit && game.at && now - game.at > ageLimit)) continue
      const mate = game.players.find((candidate) => sameEncounterPlayer(player, candidate, game.platformId))
      if (!mate) continue

      seenCount++
      if (!found) found = { game, mate, gamesAgo: index + 1 }

      if (mate.championId > 0 && !champions.includes(mate.championId) && champions.length < MAX_CHAMPION_HISTORY) {
        champions.push(mate.championId)
      }
    }

    if (!found) continue

    const lastTeam =
      found.game.selfTeamId && found.mate.teamId
        ? found.mate.teamId === found.game.selfTeamId
          ? 'ally'
          : 'enemy'
        : 'unknown'

    if (scope === 'ally' && lastTeam !== 'ally') continue
    if (scope === 'enemy' && lastTeam !== 'enemy') continue

    results.push({
      player,
      gamesAgo: found.gamesAgo,
      seenCount,
      champions,
      lastChampionId: found.mate.championId || 0,
      lastTeam,
      lastAt: found.game.at || 0,
      gameId: found.game.gameId || 0,
    })
  }

  return results.sort((a, b) => a.gamesAgo - b.gamesAgo || a.seenCount - b.seenCount)
}

/** 「上局」「3 局前」。 */
export function gamesAgoText(gamesAgo) {
  const value = Number(gamesAgo) || 0
  if (value <= 0) return ''
  return value === 1 ? '上局' : `${value} 局前`
}

/** 「队友」「对手」。 */
export function teamText(team) {
  if (team === 'ally') return '队友'
  if (team === 'enemy') return '对手'
  return '同局'
}
