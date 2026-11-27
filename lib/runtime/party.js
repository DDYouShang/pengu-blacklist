import { sameEncounterPlayer } from '../encounters.js'
import { playerRef } from '../model.js'

export const LOBBY_PATH = '/lol-lobby/v2/lobby'
export const QUEUE_PHASES = new Set(['Lobby', 'Matchmaking', 'ReadyCheck'])
const LOBBY_TIMEOUT = 2000
const MATCH_RETRY_DELAY = 5000

export function createPartyTracker({ lcu, getSelf }) {
  let members = null
  let localMember = null
  let pending = null
  let retryAfter = 0

  function capture(lobby) {
    if (!Array.isArray(lobby?.members) || !lobby.members.length) return
    // 自定义房间的 members 包括全体参赛者，不能当作预组队名单。
    members = lobby.gameConfig?.isCustom === true ? [] : lobby.members
      .filter(Boolean)
      .map((member) => playerRef(member))
      .filter((member) => member.puuid || member.summonerId > 0)
    localMember = playerRef(lobby.localMember || {})
    // 推送比已经发出的读取更新，避免迟到的响应覆盖名单。
    pending = null
  }

  function refresh() {
    if (pending) return pending
    const request = lcu.request(LOBBY_PATH, { timeout: LOBBY_TIMEOUT, cache: 'no-store' })
      .then((lobby) => {
        if (pending === request) capture(lobby)
      })
      .catch(() => {
        // 匹配成功后大厅可能暂时不可读，保留排队时已经拿到的名单。
      })
      .finally(() => {
        if (pending === request) pending = null
      })
    pending = request
    return request
  }

  return {
    capture,
    refresh,
    prepareMatch({ retry = false } = {}) {
      if (pending) return pending
      if (members !== null || (!retry && Date.now() < retryAfter)) return
      retryAfter = Date.now() + MATCH_RETRY_DELAY
      return refresh()
    },
    has(player) {
      if (!members?.length || sameEncounterPlayer(player, localMember) || sameEncounterPlayer(player, getSelf())) return false
      return members.some((member) => sameEncounterPlayer(player, member))
    },
    reset() {
      members = null
      localMember = null
      pending = null
      retryAfter = 0
    },
  }
}
