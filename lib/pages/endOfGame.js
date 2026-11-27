/**
 * 结算页数据来源（/lol-end-of-game/v1/eog-stats-block）。
 *
 * 结算数据里有 gameId，是最"新鲜"的一份名单，优先用于结算页的按钮。
 */

import { scanAndInject } from './inject.js'
import { displayNameOf } from '../model.js'
import { warn } from '../util.js'

const EOG_PHASES = new Set(['PreEndOfGame', 'EndOfGame', 'WaitingForStats'])
const CACHE_TTL = 30_000

export function createEndOfGamePage({ lcu, store, config = {}, onPick, getPhase, getSelf }) {
  let cache = { at: 0, block: null }
  let pending = null

  async function getBlock(force = false) {
    if (!force && cache.block && Date.now() - cache.at < CACHE_TTL) return cache.block
    if (pending) return pending

    pending = lcu
      .getEogBlock()
      .then((block) => {
        if (block) cache = { at: Date.now(), block }
        return block || cache.block
      })
      .catch((err) => {
        warn('读取结算数据失败:', err?.message || err)
        return cache.block
      })
      .finally(() => {
        pending = null
      })

    return pending
  }

  async function activate() {
    const phase = typeof getPhase === 'function' ? getPhase() : ''
    // 不在结算阶段就不发请求，避免每 1.5 秒打一次 404
    if (!EOG_PHASES.has(phase) && !cache.block) return 0

    const block = await getBlock()
    if (block) {
      // 结算数据有时只带 summonerId，先补全名字再注入按钮
      await lcu.enrichPlayers(block.players)
    }

    const players = block
      ? block.players.map((player) => ({
          ...player,
          gameId: block.gameId,
          platformId: player.platformId || block.platformId,
          source: 'end-of-game',
        }))
      : []

    return scanAndInject({
      players,
      self: typeof getSelf === 'function' ? getSelf() : null,
      isBlacklisted: (player) => !!store.find(player),
      onAdd: (player) => {
        onPick?.(player, {
          gameId: block.gameId,
          championId: player.championId || 0,
          region: block.platformId || player.platformId || '',
          source: 'end-of-game',
        })
      },
    })
  }

  function stats() {
    return {
      block: !!cache.block,
      players: cache.block ? cache.block.players.length : 0,
      sample: cache.block ? cache.block.players.slice(0, 5).map(displayNameOf) : [],
    }
  }

  return { id: 'endOfGame', activate, refresh: () => getBlock(true), stats }
}
