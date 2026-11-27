/**
 * 历史战绩 / 结算页的数据来源。
 *
 * 不再判断"当前是不是战绩页"——扫描本身以英雄头像为锚点，
 * 只有真正的玩家行才会命中，所以任何页面都可以安全扫描。
 */

import { normalizeText } from '../dom.js'
import { displayNameOf } from '../model.js'
import { warn } from '../util.js'
import { scanAndInject } from './inject.js'

const CACHE_TTL = 60_000

function samePlayer(a, b) {
  if (!a || !b) return false
  if (a.puuid && b.puuid) return a.puuid === b.puuid
  if (a.summonerId && b.summonerId) return Number(a.summonerId) === Number(b.summonerId)
  const left = normalizeText(displayNameOf(a))
  const right = normalizeText(displayNameOf(b))
  return !!left && left === right
}

export function createMatchHistoryPage({ lcu, store, config = {}, onPick, getSelf }) {
  let cache = { at: 0, games: [] }
  let pending = null
  let logged = 0

  async function getGames(force = false) {
    if (!force && cache.games.length && Date.now() - cache.at < CACHE_TTL) return cache.games
    if (pending) return pending

    pending = lcu
      .getRecentGames({ begIndex: 0, endIndex: 19 })
      .then((games) => {
        cache = { at: Date.now(), games }
        if (games.length && Date.now() - logged > 60_000) {
          logged = Date.now()
          const players = games.reduce((total, game) => total + game.players.length, 0)
          console.log(`[PenguBlacklist] 战绩名单：${games.length} 场 / ${players} 条玩家记录`)
        }
        return games
      })
      .catch((err) => {
        warn('读取历史战绩失败:', err?.message || err)
        return cache.games
      })
      .finally(() => {
        pending = null
      })

    return pending
  }

  /** 找这一局：玩家匹配 + （有英雄 id 时）英雄也匹配。 */
  function resolveGame(player, championId) {
    for (const game of cache.games) {
      const participant = game.players.find((candidate) => samePlayer(candidate, player))
      if (!participant) continue
      if (championId && participant.championId && participant.championId !== championId) continue
      return { game, participant }
    }
    return { game: null, participant: null }
  }

  async function activate() {
    const games = await getGames()

    // 老对局的身份数据可能缺名字，按需补全（已有名字不会发请求）
    if (games.length) {
      await Promise.all(games.slice(0, 5).map((game) => lcu.enrichPlayers(game.players)))
    }

    const players = []
    for (const game of games) {
      for (const player of game.players) {
        if (!player.puuid && !player.summonerId && !player.gameName && !player.legacyName) continue
        players.push({
          ...player,
          gameId: game.gameId,
          gameMode: game.gameMode,
          platformId: player.platformId || game.platformId,
          source: 'match-history',
        })
      }
    }

    return scanAndInject({
      players,
      self: typeof getSelf === 'function' ? getSelf() : null,
      isBlacklisted: (player) => !!store.find(player),
      onAdd: (player) => {
        const championId = player.championId || 0
        const { game, participant } = resolveGame(player, championId)
        onPick?.(player, {
          gameId: game?.gameId || player.gameId || 0,
          gameMode: game?.gameMode || player.gameMode || '',
          championId: championId || participant?.championId || 0,
          region: game?.platformId || player.platformId || '',
          source: 'match-history',
        })
      },
    })
  }

  function stats() {
    return {
      games: cache.games.length,
      players: cache.games.reduce((total, game) => total + game.players.length, 0),
      sample: cache.games[0] ? cache.games[0].players.slice(0, 5).map(displayNameOf) : [],
    }
  }

  return { id: 'matchHistory', activate, refresh: () => getGames(true), stats }
}
