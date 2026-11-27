/**
 * 黑名单数据层。
 *
 * - 纯 JS，不碰 DOM，便于单元测试
 * - 持久化交给外部注入的 storage（插件里用 context.fs 存 JSON，
 *   同时镜像一份到 DataStore 做兜底）
 * - 所有写操作先在内存生效，再 debounce 落盘
 */

import { debounce, log, toTimestamp, warn } from './util.js'
import { displayNameOf, parseRiotId } from './model.js'
import { normalizeText } from './dom.js'
import { completeRiotIdOf, findEntryForPlayer } from './matcher.js'
import { normalizePlatform } from './region.js'
import {
  MAX_ENCOUNTER_GAMES,
  lookupEncounters as findEncountersForPlayers,
  mergeEncounterGames,
  normalizeEncounterGames,
  sanitizeEncounterGame,
} from './encounters.js'

export const STORAGE_VERSION = 3
export const MAX_REASON_LENGTH = 300

/** 生成稳定 id：puuid > 完整 Riot ID > summonerId > 名字。 */
export function entryId(entry) {
  if (!entry) return ''
  if (entry.puuid) return `p:${String(entry.puuid).toLowerCase()}`
  const riotId = completeRiotIdOf(entry)
  if (riotId) return `r:${riotId}`
  if (entry.summonerId) return `s:${entry.summonerId}`
  const name = normalizeText(entry.gameName || entry.name || entry.legacyName)
  return `n:${name}`
}

function scopedId(raw) {
  const id = String(raw.id || '').trim()
  const region = normalizePlatform(raw.region)
  const name = normalizeText(raw.gameName || raw.name || raw.legacyName)
  if (!region && id === `n:${name}`) return false
  return /^[sn]:[A-Z0-9_-]*:/i.test(id) ||
    (!!region && (id.startsWith(`s:${region}:`) || id.startsWith(`n:${region}:`)))
}

function unusedId(base, exists) {
  let id = base
  for (let number = 2; exists(id); number++) id = `${base}~${number}`
  return id
}

/**
 * 把任意来源（LCU / 用户输入 / 导入文件）的数据洗成合法记录。
 * 返回 null 表示这条数据没有身份信息，无法使用。
 */
export function sanitizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null

  const puuid = String(raw.puuid || '').trim()
  const summonerId = Number(raw.summonerId) || 0
  const rawGameName = String(raw.gameName || '').trim()
  const rawTagLine = String(raw.tagLine || '').trim()
  const name = String(raw.name || raw.displayName || '').trim()
  const riotId = rawTagLine ? null : parseRiotId(rawGameName) || parseRiotId(name)
  const gameName = riotId?.gameName || rawGameName
  const tagLine = riotId?.tagLine || rawTagLine

  if (!puuid && !summonerId && !gameName && !name) return null

  const reason = String(raw.reason || '').trim().slice(0, MAX_REASON_LENGTH)
  const createdAt = toTimestamp(raw.createdAt) || now
  const updatedAt = toTimestamp(raw.updatedAt) || createdAt

  const entry = {
    id: '',
    puuid,
    summonerId,
    gameName,
    tagLine,
    name: name || (gameName ? (tagLine ? `${gameName}#${tagLine}` : gameName) : ''),
    reason,
    createdAt,
    updatedAt,
    gameId: Number(raw.gameId) || 0,
    gameMode: String(raw.gameMode || '').trim(),
    championId: Number(raw.championId) || 0,
    championName: String(raw.championName || '').trim(),
    source: String(raw.source || '').trim(),
    note: String(raw.note || '').trim(),
  }

  const id = entryId(entry)
  const storedId = String(raw.id || '').trim()
  const legacyScopedId = scopedId(raw)
  if (!puuid && !completeRiotIdOf(entry) && (raw.legacyUnverified || raw.region || legacyScopedId && !/^[sn]::/.test(storedId))) {
    entry.legacyUnverified = true
  }
  entry.id = !storedId || legacyScopedId || (storedId.startsWith('n:') && id.startsWith('r:')) ? id : storedId
  return entry
}

function normalizeData(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.entries) ? parsed.entries : []
  const byId = new Map()
  for (const raw of list) {
    const entry = sanitizeEntry(raw, 0)
    if (!entry) continue
    if (entry.legacyUnverified && scopedId(raw)) entry.id = unusedId(entry.id, (id) => byId.has(id))
    const existing = byId.get(entry.id)
    if (!existing || entry.updatedAt > existing.updatedAt) byId.set(entry.id, entry)
  }
  const settings =
    parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
      ? { ...parsed.settings }
      : {}
  delete settings.regionName
  delete settings.developerMode

  // v1 的数据文件没有 encounters，这里补一个空分区即可，旧数据原样保留
  const rawGames =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.encounters && Array.isArray(parsed.encounters.games)
      ? parsed.encounters.games
      : []

  return {
    version: STORAGE_VERSION,
    entries: Array.from(byId.values()),
    settings,
    encounters: { games: normalizeEncounterGames(rawGames, { now: 0, maxGames: MAX_ENCOUNTER_GAMES }) },
  }
}

/**
 * @param {Object} options
 * @param {{ read: () => Promise<string|undefined>, write: (text: string) => Promise<boolean> }} options.storage
 * @param {() => number} [options.now]
 */
export function createStore({ storage, now = () => Date.now() } = {}) {
  let data = emptyData()
  let loaded = false
  const listeners = new Set()

  function emptyData() {
    return { version: STORAGE_VERSION, entries: [], settings: {}, encounters: { games: [] } }
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener()
      } catch (err) {
        warn('store listener failed:', err)
      }
    }
  }

  async function persist() {
    if (!storage) return false
    try {
      const text = JSON.stringify(data, null, 2)
      const ok = await storage.write(text)
      if (!ok) warn('写入黑名单文件失败')
      return !!ok
    } catch (err) {
      warn('写入黑名单文件异常:', err)
      return false
    }
  }

  const scheduleSave = debounce(persist, 250)

  function sorted() {
    return data.entries.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  return {
    async load() {
      if (loaded) return
      loaded = true
      try {
        const text = storage ? await storage.read() : undefined
        if (text && String(text).trim()) {
          const parsed = JSON.parse(text)
          data = normalizeData(parsed)
          const entries = Array.isArray(parsed) ? parsed : parsed?.entries
          if (parsed?.settings?.regionName !== undefined || parsed?.settings?.developerMode !== undefined ||
              (Array.isArray(entries) && entries.some((entry) => entry && ('region' in Object(entry) || scopedId(entry))))) {
            await persist()
          }
          log(`已载入 ${data.entries.length} 条黑名单`)
        }
      } catch (err) {
        warn('解析黑名单文件失败，已使用空列表:', err)
        data = emptyData()
      }
      emit()
    },

    all: sorted,

    get(id) {
      return data.entries.find((entry) => entry.id === id) || null
    },

    find(player) {
      return findEntryForPlayer(player, data.entries)
    },

    has(player) {
      return !!findEntryForPlayer(player, data.entries)
    },

    count() {
      return data.entries.length
    },

    /** 读取一个设置项。 */
    getSetting(key) {
      const value = data.settings ? data.settings[key] : ''
      return value == null ? '' : String(value)
    },

    /** 写入一个设置项。 */
    setSetting(key, value) {
      if (!data.settings) data.settings = {}
      data.settings[key] = String(value ?? '')
      emit()
      scheduleSave()
      return data.settings[key]
    },

    /**
     * 新增或更新一条记录。
     * 同一个玩家（puuid / summonerId / Riot ID 命中）再次拉黑时只更新原因与对局信息。
     */
    upsert(candidate) {
      const timestamp = now()
      const incoming = sanitizeEntry(candidate, timestamp)
      if (!incoming) return { entry: null, created: false, updated: false }

      const manualRiotId = incoming.source === 'manual' ? completeRiotIdOf(incoming) : ''
      const existing = (candidate.id && this.get(candidate.id)) || (manualRiotId
        ? data.entries.find((entry) => completeRiotIdOf(entry) === manualRiotId)
        : findEntryForPlayer(incoming, data.entries))
      if (existing) {
        existing.reason = incoming.reason || existing.reason
        existing.updatedAt = timestamp
        existing.name = incoming.name || existing.name
        if (incoming.gameId) existing.gameId = incoming.gameId
        if (incoming.championId) {
          existing.championId = incoming.championId
          existing.championName = incoming.championName || existing.championName
        }
        if (incoming.gameMode) existing.gameMode = incoming.gameMode
        if (incoming.source) existing.source = incoming.source
        emit()
        scheduleSave()
        return { entry: existing, created: false, updated: true }
      }

      incoming.id = unusedId(incoming.id, (id) => data.entries.some((entry) => entry.id === id))
      data.entries.push(incoming)
      emit()
      scheduleSave()
      return { entry: incoming, created: true, updated: false }
    },

    update(id, patch) {
      const entry = this.get(id)
      if (!entry) return null
      Object.assign(entry, sanitizeEntry({ ...entry, ...patch, id }, now()))
      entry.updatedAt = now()
      emit()
      scheduleSave()
      return entry
    },

    remove(id) {
      const index = data.entries.findIndex((entry) => entry.id === id)
      if (index < 0) return false
      data.entries.splice(index, 1)
      emit()
      scheduleSave()
      return true
    },

    removePlayer(player) {
      const entry = findEntryForPlayer(player, data.entries)
      if (!entry) return false
      return this.remove(entry.id)
    },

    clear() {
      data.entries = []
      emit()
      scheduleSave()
    },

    /* ---------------------- 最近遇到过的人 ---------------------- */

    /**
     * 记录一局 10 人快照。
     * 同一个 gameId 只会保留一份（重连 / 重复触发不会膨胀）。
     */
    recordEncounterGame(raw) {
      const game = sanitizeEncounterGame(raw, now())
      if (!game) return false
      data.encounters.games = mergeEncounterGames(data.encounters.games, [game], {
        now: now(),
        maxGames: MAX_ENCOUNTER_GAMES,
      })
      emit()
      scheduleSave()
      return true
    },

    /** 批量写入（首次从历史战绩回填时用）。返回实际新增/更新的局数。 */
    mergeEncounterGames(list) {
      const incoming = (Array.isArray(list) ? list : []).map((raw) => sanitizeEncounterGame(raw, now())).filter(Boolean)
      if (!incoming.length) return 0
      data.encounters.games = mergeEncounterGames(data.encounters.games, incoming, {
        now: now(),
        maxGames: MAX_ENCOUNTER_GAMES,
      })
      emit()
      scheduleSave()
      return incoming.length
    },

    getEncounterGames() {
      return data.encounters.games.slice()
    },

    encounterGameCount() {
      return data.encounters.games.length
    },

    /** 在最近的对局里找出这批人（选人 / 游戏内都能用）。 */
    lookupEncounters(players, options = {}) {
      return findEncountersForPlayers(players, data.encounters.games, { now: now(), ...options })
    },

    /** 结算后补这局的时长 / 重开标记。 */
    updateEncounterGame(gameId, patch = {}) {
      const id = Number(gameId)
      if (!id) return false
      const game = data.encounters.games.find((item) => item.gameId === id)
      if (!game) return false
      if (patch.gameDuration !== undefined) {
        game.gameDuration = Number(patch.gameDuration) || 0
        if (patch.remake === undefined) game.remake = game.gameDuration > 0 && game.gameDuration < 300
      }
      if (patch.remake !== undefined) game.remake = !!patch.remake
      emit()
      scheduleSave()
      return true
    },

    exportJson() {
      return JSON.stringify({ version: STORAGE_VERSION, exportedAt: now(), entries: sorted() }, null, 2)
    },

    /** 导入。merge=true 时合并（同 id 保留更新的一条），false 时整体替换。 */
    importJson(text, { merge = true } = {}) {
      const parsed = normalizeData(JSON.parse(text))
      if (!merge) {
        // 导入的是黑名单，不要把「最近遇到过的人」一起清掉
        const encounters = data.encounters
        data = { ...parsed, settings: data.settings, encounters }
        emit()
        scheduleSave()
        return { added: parsed.entries.length, updated: 0 }
      }

      let added = 0
      let updated = 0
      for (const entry of parsed.entries) {
        const existing = data.entries.find((item) => item.id === entry.id)
        if (!existing) {
          data.entries.push(entry)
          added++
        } else if (entry.updatedAt > existing.updatedAt) {
          Object.assign(existing, entry)
          updated++
        }
      }
      emit()
      scheduleSave()
      return { added, updated }
    },

    async flush() {
      scheduleSave.cancel()
      return persist()
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 给记录补上展示用的名字。 */
export function entryDisplayName(entry) {
  if (!entry) return '未知玩家'
  return entry.name || displayNameOf(entry)
}
