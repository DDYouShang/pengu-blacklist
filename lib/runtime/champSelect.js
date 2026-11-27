/**
 * 选人阶段检测：本局 10 个人里有没有黑名单。
 *
 * 命中后：
 *   1. 把结果交给上层（弹 toast / 更新右上角入口）
 *   2. 往选人聊天发一条提示（可配置关闭）
 */

import { findHitsForPlayers } from '../matcher.js'
import { displayNameOf, normalizeChampSelect } from '../model.js'
import { entryDisplayName } from '../store.js'
import { warn } from '../util.js'
import { sendChampSelectMessage } from './chat.js'

const MAX_CHAT_ATTEMPTS = 3

export function createChampSelectChecker({
  lcu,
  store,
  config = {},
  onHits,
  onResult,
  getFamiliar,
  prepareParty,
  isPartyMember,
} = {}) {
  let sessionKey = ''
  let sentKeys = new Set()
  let chatAttempts = 0
  let running = false
  let lastHits = []
  let lastFamiliar = []
  let lastPlayers = []
  let generation = 0

  function buildChatText(hits) {
    const list = hits
      .slice(0, 3)
      .map((hit) => {
        const name = entryDisplayName(hit.entry) || displayNameOf(hit.player)
        return `${name}（${hit.entry.reason || '黑名单玩家'}）`
      })
      .join('；')

    const template = String(config.chatMessage || '⚠️ 黑名单提醒：{list}')
    return template.includes('{list}') ? template.replace(/\{list\}/g, list) : `${template}${list}`
  }

  async function sendChatNotices(hits) {
    // 默认走本地提醒，不往聊天里发任何东西（队友可见）。
    // 只有用户显式打开 teamChatNotice 才会真的发到队伍聊天。
    if (config.teamChatNotice !== true) return
    if (chatAttempts >= MAX_CHAT_ATTEMPTS) return

    const fresh = hits.filter((hit) => !sentKeys.has(hit.entry.id))
    if (!fresh.length) return

    chatAttempts++
    const result = await sendChampSelectMessage(buildChatText(fresh))
    if (result.ok) {
      for (const hit of fresh) sentKeys.add(hit.entry.id)
    }
  }

  async function check() {
    if (running) return lastHits
    running = true
    const checkedGeneration = generation

    try {
      const partyReady = prepareParty?.()
      const session = await lcu.getChampSelectSession()
      if (!session) return lastHits

      const normalized = normalizeChampSelect(session)
      if (!normalized || !normalized.players.length) return lastHits

      await Promise.all([lcu.enrichPlayers(normalized.players), partyReady])
      if (checkedGeneration !== generation) return lastHits

      const alertPlayers = normalized.players.filter((player) => !isPartyMember?.(player))
      // 不排除自己：方便用户把自己加进黑名单来测试提醒效果
      const hits = findHitsForPlayers(alertPlayers, store.all())

      const key = normalized.players
        .map((player) => player.puuid || (player.summonerId ? `s${player.summonerId}` : displayNameOf(player)))
        .sort()
        .join('|')

      if (key !== sessionKey) {
        sessionKey = key
        sentKeys = new Set()
        chatAttempts = 0
      }

      const familiar = getFamiliar?.(alertPlayers, hits, session.gameId) || []
      lastFamiliar = familiar

      lastHits = hits
      lastPlayers = normalized.players
      onHits?.(hits, { sessionKey: key, players: normalized.players })
      onResult?.({
        blacklist: hits,
        familiar,
        players: normalized.players,
        sessionKey: key,
        canSeeOpponents: normalized.theirTeam.some((player) =>
          player.summonerId > 0 || player.gameName || player.legacyName || /[^0-]/.test(player.puuid),
        ),
      })

      if (hits.length) await sendChatNotices(hits)
      return hits
    } catch (err) {
      warn('选人阶段检测失败:', err?.message || err)
      return lastHits
    } finally {
      running = false
    }
  }

  return {
    check,
    getHits: () => lastHits,
    getFamiliar: () => lastFamiliar,
    getPlayers: () => lastPlayers,
    reset() {
      generation++
      sessionKey = ''
      sentKeys = new Set()
      chatAttempts = 0
      lastHits = []
      lastFamiliar = []
      lastPlayers = []
    },
  }
}
