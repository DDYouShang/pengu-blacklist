import {
  DEFAULT_LOOKBACK_GAMES,
  MAX_ENCOUNTER_GAMES,
  REMAKE_SECONDS,
  lookupEncounters,
  sameEncounterPlayer,
} from '../encounters.js'
import { warn } from '../util.js'

const REFRESH_INTERVAL = 10_000
const PAGE_SIZE = 20

export function createEncounterHistory({ lcu, config = {} }) {
  const lookbackGames = Math.min(
    MAX_ENCOUNTER_GAMES,
    Math.max(1, Math.floor(Number(config.lookbackGames) || DEFAULT_LOOKBACK_GAMES)),
  )
  let games = []
  let pending = null
  let refreshAfter = 0

  async function readGames() {
    // 多取一局，给重连时可能已经出现在战绩里的本局留出位置。
    const count = lookbackGames + 1
    const history = []
    const seen = new Set()
    for (let begIndex = 0; begIndex < count; begIndex += PAGE_SIZE) {
      const endIndex = Math.min(begIndex + PAGE_SIZE, count) - 1
      const page = await lcu.getRecentGames({ begIndex, endIndex })
      for (const game of page) {
        if (game.gameId && seen.has(game.gameId)) continue
        if (game.gameId) seen.add(game.gameId)
        history.push(game)
      }
      if (page.length < endIndex - begIndex + 1) break
    }
    return history.map((game) => ({
      ...game,
      at: game.gameCreation,
      remake: game.gameDuration > 0 && game.gameDuration < REMAKE_SECONDS,
    }))
  }

  return {
    refresh() {
      if (config.enabled === false) return null
      if (pending) return pending
      if (Date.now() < refreshAfter) return null

      const previous = games
      const request = readGames()
        .then((history) => {
          if (pending !== request) return false
          games = history
          return games.length > 0 || previous.length > 0
        })
        .catch((error) => {
          if (pending === request) warn('读取熟人战绩失败:', error?.message || error)
          return false
        })
        .finally(() => {
          if (pending !== request) return
          pending = null
          refreshAfter = Date.now() + REFRESH_INTERVAL
        })
      pending = request
      return request
    },

    lookup(players, { self, currentGameId } = {}) {
      const history = games.map((game) => ({
        ...game,
        selfTeamId: game.players.find((player) => sameEncounterPlayer(self, player, game.platformId))?.teamId || 0,
      }))
      return lookupEncounters(players, history, {
        lookbackGames,
        lookbackDays: config.lookbackDays,
        scope: config.scope,
        self: config.includeSelf === true ? null : self,
        currentGameId,
      })
    },

    reset() {
      games = []
      pending = null
      refreshAfter = 0
    },
  }
}
