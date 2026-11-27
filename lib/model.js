/**
 * 把 LCU 各种接口返回的"玩家"结构归一化成统一的 PlayerRef。
 *
 * 不同补丁 / 不同接口字段名不太一样（summonerName 废弃、gameName+tagLine 上线、
 * 有的接口只给 summonerId），这里尽量宽容地取字段，取不到就留空，
 * 上层再做补全（getSummonerById）。
 */

import { cleanText, normalizeText } from './dom.js'
import { toTimestamp } from './util.js'

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function parseRiotId(value) {
  const parts = cleanText(value).normalize('NFKC').split('#')
  if (parts.length !== 2) return null
  const [gameName, tagLine] = parts.map((part) => part.trim())
  return gameName && /^[a-z\d]+$/i.test(tagLine) ? { gameName, tagLine } : null
}

/**
 * @typedef {Object} PlayerRef
 * @property {string} puuid
 * @property {number} summonerId
 * @property {string} gameName
 * @property {string} tagLine
 * @property {string} legacyName  旧版 summonerName（没有 tagLine 时使用）
 * @property {number} championId
 * @property {number} teamId
 * @property {'ally'|'enemy'} [currentSide]  选人名单给出的本局阵营
 * @property {string} platformId
 * @property {string} position    选人阶段的分配位置
 * @property {boolean} isSelf
 */

/**
 * 构造 PlayerRef。
 * 会自动处理 "gameName 里其实带着 #tag" 这种脏数据。
 */
export function playerRef(partial = {}) {
  let gameName = str(partial.gameName)
  let tagLine = str(partial.tagLine)
  const legacyName = str(partial.legacyName ?? partial.summonerName ?? partial.displayName)

  if (!tagLine && gameName.includes('#')) {
    const hashIndex = gameName.lastIndexOf('#')
    tagLine = gameName.slice(hashIndex + 1).trim()
    gameName = gameName.slice(0, hashIndex).trim()
  }
  // 旧字段里也可能带 #tag
  if (!tagLine && !gameName && legacyName.includes('#')) {
    const hashIndex = legacyName.lastIndexOf('#')
    tagLine = legacyName.slice(hashIndex + 1).trim()
    gameName = legacyName.slice(0, hashIndex).trim()
  }

  const player = {
    puuid: str(partial.puuid),
    summonerId: num(partial.summonerId),
    gameName,
    tagLine,
    legacyName,
    championId: num(partial.championId ?? partial.championPickIntent),
    teamId: num(partial.teamId),
    platformId: str(partial.platformId).toUpperCase(),
    position: str(partial.position ?? partial.assignedPosition),
    isSelf: !!partial.isSelf,
  }
  if (partial.currentSide) player.currentSide = partial.currentSide

  return player
}

/** 展示名：优先 Riot ID，其次旧 summonerName，最后用 summonerId 兜底。 */
export function displayNameOf(player) {
  if (!player) return '未知玩家'
  if (player.gameName && player.tagLine) return `${player.gameName}#${player.tagLine}`
  if (player.gameName) return player.gameName
  if (player.legacyName) return player.legacyName
  if (player.summonerId) return `召唤师 ${player.summonerId}`
  if (player.puuid) return `玩家 ${player.puuid.slice(0, 8)}`
  return '未知玩家'
}

/**
 * 一个玩家所有可用于匹配的名字写法（已归一化）。
 * 用来在 DOM 里找名字、以及做黑名单模糊匹配。
 */
export function nameVariants(player) {
  const list = []
  if (!player) return list
  if (player.gameName && player.tagLine) {
    list.push(normalizeText(`${player.gameName}#${player.tagLine}`))
    list.push(normalizeText(`${player.gameName} #${player.tagLine}`))
  }
  if (player.gameName) list.push(normalizeText(player.gameName))
  if (player.legacyName) list.push(normalizeText(player.legacyName))
  return Array.from(new Set(list.filter((v) => v && v.length >= 2)))
}

/** 该玩家是否就是自己（puuid 优先，其次 summonerId）。 */
export function isSamePlayer(a, b) {
  if (!a || !b) return false
  if (a.puuid && b.puuid) return a.puuid === b.puuid
  if (a.summonerId && b.summonerId) return a.summonerId === b.summonerId
  return false
}

class PlayerMap {
  constructor() {
    this.byPuuid = new Map()
    this.bySummonerId = new Map()
    this.byName = new Map()
  }

  set(player) {
    if (player.puuid) this.byPuuid.set(player.puuid, player)
    if (player.summonerId) this.bySummonerId.set(String(player.summonerId), player)
    for (const name of nameVariants(player)) {
      if (!this.byName.has(name)) this.byName.set(name, player)
    }
  }

  /** 把其它来源的信息合并进已有玩家（不覆盖已有非空值）。 */
  merge(extra) {
    let target =
      (extra.puuid && this.byPuuid.get(extra.puuid)) ||
      (extra.summonerId && this.bySummonerId.get(String(extra.summonerId))) ||
      null

    if (!target) {
      target = playerRef(extra)
      this.set(target)
      return target
    }

    for (const key of ['puuid', 'gameName', 'tagLine', 'legacyName', 'platformId', 'position', 'currentSide']) {
      if (!target[key] && extra[key]) target[key] = extra[key]
    }
    for (const key of ['summonerId', 'championId', 'teamId']) {
      if (!target[key] && extra[key]) target[key] = extra[key]
    }
    this.set(target)
    return target
  }
}

/** 把一局 match-history 的 game 对象转成 { gameId, players }。 */
export function normalizeMatchHistoryGame(game) {
  if (!game || typeof game !== 'object') return null

  const identities = new Map()
  for (const identity of game.participantIdentities || []) {
    if (identity && identity.participantId !== undefined) {
      identities.set(Number(identity.participantId), identity.player || {})
    }
  }

  const players = []
  const map = new PlayerMap()

  for (const participant of game.participants || []) {
    if (!participant) continue
    const identity = identities.get(Number(participant.participantId)) || {}
    const player = map.merge({
      puuid: participant.puuid || identity.puuid,
      summonerId: num(participant.summonerId) || num(identity.summonerId),
      gameName: identity.gameName,
      tagLine: identity.tagLine,
      legacyName: identity.summonerName ?? identity.displayName,
      championId: participant.championId,
      teamId: participant.teamId,
      platformId: game.platformId ?? identity.platformId,
    })
    players.push(player)
  }

  return {
    gameId: num(game.gameId),
    gameCreation: toTimestamp(game.gameCreation) || toTimestamp(game.gameStartTimestamp),
    gameDuration: num(game.gameDuration),
    gameMode: str(game.gameMode),
    queueId: num(game.queueId),
    platformId: str(game.platformId).toUpperCase(),
    players,
  }
}

/** 结算页 /lol-end-of-game/v1/eog-stats-block 的归一化。 */
export function normalizeEogBlock(block) {
  if (!block || typeof block !== 'object') return null
  const map = new PlayerMap()

  for (const team of block.teams || []) {
    for (const teammate of team.players || []) {
      if (!teammate) continue
      map.merge({
        puuid: teammate.puuid,
        summonerId: teammate.summonerId ?? teammate.accountId,
        gameName: teammate.gameName,
        tagLine: teammate.tagLine,
        legacyName: teammate.summonerName ?? teammate.displayName,
        championId: teammate.championId,
        teamId: teammate.teamId ?? team.teamId,
        platformId: block.platformId ?? team.platformId,
      })
    }
  }

  return {
    gameId: num(block.gameId ?? block.gameID),
    platformId: str(block.platformId).toUpperCase(),
    players: uniquePlayers(map),
  }
}

/** 把 PlayerMap 里所有出现过的玩家去重后取出。 */
function uniquePlayers(map) {
  const seen = new Set()
  const players = []
  const add = (player) => {
    if (seen.has(player)) return
    seen.add(player)
    players.push(player)
  }
  for (const player of map.byPuuid.values()) add(player)
  for (const player of map.bySummonerId.values()) add(player)
  for (const player of map.byName.values()) add(player)
  return players
}

/** 选人阶段 /lol-champ-select/v1/session。 */
export function normalizeChampSelect(session) {
  if (!session || typeof session !== 'object') return null
  const map = new PlayerMap()

  for (const member of session.myTeam || []) {
    if (!member) continue
    map.merge({
      puuid: member.puuid,
      summonerId: member.summonerId,
      gameName: member.gameName,
      tagLine: member.tagLine,
      legacyName: member.summonerName,
      championId: member.championId || member.championPickIntent,
      position: member.assignedPosition,
      teamId: member.teamId,
      currentSide: 'ally',
    })
  }

  for (const member of session.theirTeam || []) {
    if (!member) continue
    map.merge({
      puuid: member.puuid,
      summonerId: member.summonerId,
      gameName: member.gameName,
      tagLine: member.tagLine,
      legacyName: member.summonerName,
      championId: member.championId || member.championPickIntent,
      position: member.assignedPosition,
      teamId: member.teamId,
      currentSide: 'enemy',
    })
  }

  return {
    localPlayerCellId: num(session.localPlayerCellId),
    myTeam: (session.myTeam || []).map((m) => playerRef({ ...m, championId: m.championId || m.championPickIntent })),
    theirTeam: (session.theirTeam || []).map((m) => playerRef({ ...m, championId: m.championId || m.championPickIntent })),
    players: uniquePlayers(map),
  }
}

/** 游戏内（InProgress）的 /lol-gameflow/v1/session。 */
export function normalizeGameflowSession(session) {
  if (!session || typeof session !== 'object') return null
  const gameData = session.gameData || {}
  const map = new PlayerMap()

  for (const entry of gameData.playerList || []) {
    if (!entry) continue
    map.merge({
      puuid: entry.puuid,
      summonerId: entry.summonerId,
      gameName: entry.gameName,
      tagLine: entry.tagLine,
      legacyName: entry.summonerName ?? entry.displayName,
      championId: entry.championId,
      teamId: num(entry.team) || num(entry.teamId),
      platformId: gameData.platformId ?? session.platformId,
    })
  }

  return {
    gameId: num(gameData.gameId),
    queueId: num(gameData.queueId ?? session.queueId),
    platformId: str(gameData.platformId ?? session.platformId).toUpperCase(),
    players: uniquePlayers(map),
  }
}

/** /lol-summoner/v1/summoners/{id} 的返回值。 */
export function normalizeSummoner(summoner) {
  if (!summoner || typeof summoner !== 'object') return null
  return playerRef({
    puuid: summoner.puuid,
    summonerId: summoner.summonerId ?? summoner.id,
    gameName: summoner.gameName,
    tagLine: summoner.tagLine,
    legacyName: summoner.displayName ?? summoner.summonerName,
    platformId: summoner.platformId,
  })
}
