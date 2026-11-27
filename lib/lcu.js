/**
 * LCU 接口封装。
 *
 * 所有请求都走相对路径（客户端页面本身就由 LCU 提供），
 * 出错一律抛异常，由上层决定降级策略。
 */

import { sleep, warn } from './util.js'
import { CHINESE_CHAMPIONS } from './championCatalog.js'
import { normalizePlatform } from './region.js'
import {
  normalizeChampSelect,
  normalizeEogBlock,
  normalizeGameflowSession,
  normalizeMatchHistoryGame,
  normalizeSummoner,
  playerRef,
} from './model.js'

const DEFAULT_TIMEOUT = 8000

let currentSummonerCache = null
let currentSummonerAt = 0
let regionCache = null
const summonerCache = new Map()
const championCache = new Map()
let championList = null
const gameDetailCache = new Map()
const fallbackChampions = CHINESE_CHAMPIONS.map(([id, name, title, alias]) => ({ id, name, title, alias }))

function championRoster(summary) {
  const roster = new Map(fallbackChampions.map((champion) => [champion.id, champion]))
  for (const champion of Array.isArray(summary) ? summary : []) {
    const id = Number(champion?.id)
    if (!Number.isInteger(id) || id <= 0 || typeof champion.name !== 'string' || !champion.name.trim()) continue
    const known = roster.get(id)
    roster.set(id, {
      id,
      name: known?.name || champion.name,
      title: known?.title || champion.title || '',
      alias: champion.alias || known?.alias || '',
    })
  }
  return [...roster.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function hasMatchIdentity(player) {
  return !!(player.puuid || player.summonerId || (player.gameName && player.tagLine))
}

async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT, cache } = {}) {
  const hasAbort = typeof AbortController !== 'undefined'
  const controller = hasAbort ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null

  try {
    const response = await fetch(path, {
      method,
      cache,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      signal: controller ? controller.signal : undefined,
    })

    if (!response.ok) {
      const error = new Error(`LCU ${method} ${path} -> ${response.status}`)
      error.status = response.status
      throw error
    }

    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch (_) {
      return text
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const lcu = {
  request,

  get(path) {
    return request(path)
  },

  post(path, body) {
    return request(path, { method: 'POST', body })
  },

  /** 当前登录的召唤师。 */
  async getCurrentSummoner({ force = false } = {}) {
    const now = Date.now()
    if (!force && currentSummonerCache && now - currentSummonerAt < 60_000) {
      return currentSummonerCache
    }
    const summoner = normalizeSummoner(await request('/lol-summoner/v1/current-summoner'))
    if (summoner) {
      currentSummonerCache = summoner
      currentSummonerAt = now
    }
    return summoner
  },

  /** 按 summonerId 查玩家信息，带内存缓存。 */
  async getSummonerById(summonerId) {
    const id = Number(summonerId)
    if (!id) return null
    if (summonerCache.has(id)) return summonerCache.get(id)
    try {
      const summoner = normalizeSummoner(await request(`/lol-summoner/v1/summoners/${id}`))
      summonerCache.set(id, summoner)
      return summoner
    } catch (err) {
      warn(`查询 summonerId=${id} 失败`, err?.message || err)
      summonerCache.set(id, null)
      return null
    }
  },

  /**
   * 给缺少名字的玩家补全信息。
   * 选人阶段敌方经常只给 summonerId，结算页有时也只有 id。
   */
  async enrichPlayers(players = []) {
    const tasks = players.map(async (player) => {
      if (!player || player.gameName || player.legacyName) return
      if (!player.summonerId) return
      const summoner = await this.getSummonerById(player.summonerId)
      if (!summoner) return
      player.gameName = summoner.gameName || player.gameName
      player.tagLine = summoner.tagLine || player.tagLine
      player.legacyName = summoner.legacyName || player.legacyName
      player.puuid = summoner.puuid || player.puuid
    })
    await Promise.all(tasks)
    return players
  },

  /**
   * 识别当前大区。
   * 优先采用登录会话中的区服代码，国服总区标记不能当作具体大区。
   */
  async detectRegion({ force = false } = {}) {
    if (!force && regionCache) return regionCache

    // 登录会话里的 platformId 最准（国服是 HN1 这类，而不是 TENCENT）
    try {
      const session = await request('/lol-login/v1/session')
      const code = [session?.platformId, session?.region].map(normalizePlatform)
        .find((value) => value && value !== 'TENCENT')
      if (code) {
        regionCache = code
        return regionCache
      }
    } catch (_) {
      /* ignore */
    }

    try {
      const info = await request('//riotclient/region-locale')
      const code = [info?.platformId, info?.region].map(normalizePlatform)
        .find((value) => value && value !== 'TENCENT')
      if (code) {
        regionCache = code
        return regionCache
      }
    } catch (_) {
      /* RiotClient 接口不一定可用，继续尝试下一种 */
    }

    const codes = await Promise.all([
      this.getCurrentSummoner().then((self) => self?.platformId).catch(() => ''),
      this.getGameflowSession().then((session) => session?.platformId).catch(() => ''),
    ])
    regionCache = codes.map(normalizePlatform).find((value) => value && value !== 'TENCENT') || ''
    return regionCache
  },

  /** 最近的对局列表（原始 game 对象）。 */
  async getRecentMatches({ begIndex = 0, endIndex = 19 } = {}) {
    const data = await request(
      `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${begIndex}&endIndex=${endIndex}`,
      { cache: 'no-store' },
    )
    const games = data && data.games && Array.isArray(data.games.games) ? data.games.games : []
    return games
  },

  /** 最近的对局（已归一化）。 */
  async getRecentGames(options) {
    const games = (await this.getRecentMatches(options)).map((game) => normalizeMatchHistoryGame(game)).filter(Boolean)

    // 国服客户端的历史战绩列表有时只返回"你自己"的 participant，
    // 这里对这些人头不足的场次补拉一次对局详情（带完整 10 人），并发 4 个。
    const needDetail = games
      .filter((game) => game.players.length < 2 || !game.players.every(hasMatchIdentity))
      .slice(0, 20)
    if (needDetail.length) {
      const queue = needDetail.slice()
      const worker = async () => {
        while (queue.length) {
          const game = queue.shift()
          if (!game) continue
          const detail = await this.getGameDetail(game.gameId)
          if (detail && detail.players.filter(hasMatchIdentity).length > game.players.filter(hasMatchIdentity).length) {
            game.players = detail.players
            game.gameCreation ||= detail.gameCreation
            game.gameDuration ||= detail.gameDuration
            game.platformId ||= detail.platformId
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker))
    }

    return games
  },

  /** 单场对局详情：/lol-match-history/v1/games/{gameId}。 */
  async getGameDetail(gameId) {
    const id = Number(gameId)
    if (!id) return null
    if (gameDetailCache.has(id)) return gameDetailCache.get(id)

    try {
      const raw = await request(`/lol-match-history/v1/games/${id}`, { cache: 'no-store' })
      const detail = normalizeMatchHistoryGame(raw)
      if (!detail || detail.gameId !== id || !detail.players.length) return null
      if (detail.players.length >= 2 && detail.players.every(hasMatchIdentity)) {
        gameDetailCache.set(id, detail)
      }
      return detail
    } catch (err) {
      warn(`读取对局详情 ${id} 失败:`, err?.message || err)
      return null
    }
  },

  /** 结算页数据。 */
  async getEogBlock({ retries = 3, interval = 800 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const block = await request('/lol-end-of-game/v1/eog-stats-block')
        if (block) return normalizeEogBlock(block)
      } catch (err) {
        if (attempt === retries) warn('读取结算数据失败:', err?.message || err)
      }
      if (attempt < retries) await sleep(interval)
    }
    return null
  },

  /** 选人阶段会话；不在选人阶段时返回 null。 */
  async getChampSelectSession() {
    try {
      return await request('/lol-champ-select/v1/session')
    } catch (err) {
      if (err && err.status === 404) return null
      throw err
    }
  },

  async getChampSelect() {
    const session = await this.getChampSelectSession()
    return session ? normalizeChampSelect(session) : null
  },

  /** 当前游戏阶段：None / Lobby / Matchmaking / ReadyCheck / ChampSelect / GameStart / InProgress / ... */
  async getGameflowPhase() {
    try {
      const phase = await request('/lol-gameflow/v1/gameflow-phase')
      return typeof phase === 'string' ? phase.replace(/"/g, '') : null
    } catch (_) {
      return null
    }
  },

  async getGameflowSession() {
    return normalizeGameflowSession(await request('/lol-gameflow/v1/session'))
  },

  /** 手动添加时可选的英雄，包括尚未进入内置中文名单的新英雄。 */
  getChampions() {
    championList ||= request('/lol-game-data/assets/v1/champion-summary.json', { timeout: 3500 })
      .then(championRoster)
      .catch(() => {
        championList = null
        return championRoster([])
      })
    return championList
  },

  /** 英雄名称（结算/战绩页显示"目标玩的角色"）。 */
  async getChampion(championId) {
    const id = Number(championId)
    if (!id) return null
    if (championCache.has(id)) return championCache.get(id)
    try {
      const data = await request(`/lol-game-data/assets/v1/champions/${id}.json`)
      const champion = data && data.name ? { id, name: data.name, alias: data.alias || '' } : null
      championCache.set(id, champion)
      return champion
    } catch (_) {
      championCache.set(id, null)
      return null
    }
  },

  /** 从头像 URL 里解析英雄 id（DOM 里兜底用）。 */
  parseChampionIdFromUrl(url) {
    const match = String(url || '').match(/champion-icons\/(\d+)\.(?:png|jpe?g|webp)/i)
    return match ? Number(match[1]) : 0
  },

  resetCaches() {
    currentSummonerCache = null
    currentSummonerAt = 0
    regionCache = null
    summonerCache.clear()
    championCache.clear()
    championList = null
    gameDetailCache.clear()
  },
}

export { playerRef }
