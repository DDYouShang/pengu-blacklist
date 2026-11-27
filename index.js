import './styles.css'

import { ensureRoot } from './lib/dom.js'
import { debounce, log, warn } from './lib/util.js'
import { lcu } from './lib/lcu.js'
import { displayNameOf, isSamePlayer } from './lib/model.js'
import { findHitsForPlayers, mergeHitLists } from './lib/matcher.js'
import { createStore, entryDisplayName } from './lib/store.js'
import { normalizePlatform } from './lib/region.js'
import { gamesAgoText, sameEncounterPlayer, teamText } from './lib/encounters.js'
import { notify } from './lib/ui/toast.js'
import { openReasonDialog } from './lib/ui/reasonDialog.js'
import { openHitsPanel } from './lib/ui/panel.js'
import { createLauncher } from './lib/ui/launcher.js'
import { createPrivateHint } from './lib/ui/hint.js'
import { showChatLine, hideChatLine } from './lib/ui/chatLine.js'
import { createMatchHistoryPage } from './lib/pages/matchHistory.js'
import { createEndOfGamePage } from './lib/pages/endOfGame.js'
import { removeInjectedButtons, inspectRows, pruneDetachedButtons } from './lib/pages/inject.js'
import { createChampSelectChecker } from './lib/runtime/champSelect.js'
import { createEncounterHistory } from './lib/runtime/encounterHistory.js'
import { createPartyTracker, LOBBY_PATH, QUEUE_PHASES } from './lib/runtime/party.js'
import { resetChatCache } from './lib/runtime/chat.js'
import { createTestTarget, TEST_TARGETS } from './lib/runtime/testTargets.js'

const VERSION = '1.0'
const GAME_ALERT_PHASES = new Set(['GameStart', 'InProgress'])
const FAMILIAR_LOADING_SETTINGS = {
  ally: 'familiarLoadingAllyEnabled',
  enemy: 'familiarLoadingEnemyEnabled',
}

const DEFAULT_CONFIG = {
  scanInterval: 1500,
  // 默认只在本地提醒，不往队伍聊天发送任何内容（队友可见）
  teamChatNotice: false,
  chatMessage: '⚠️ 黑名单提醒：{list}',
  privateHint: { enabled: true, top: 76, right: 12, duration: 12000 },
  chatLine: true,
  alwaysShowLauncher: false,
  launcher: { top: 96, right: 320 },
  // 最近遇到过的人：按客户端战绩查找本局玩家
  encounters: {
    enabled: true,
    lookbackGames: 5,
    lookbackDays: 90,
    scope: 'both', // both | ally | enemy
    // 调试开关：把自己也算成熟人。正常使用请保持 false
    includeSelf: false,
  },
  // 通知方式：只把客户端拉到前台并打开面板（不用系统通知、不用提示音）
  notify: {
    focusClient: true,
    delayMs: 4000,
    panelAutoCloseMs: 20000,
  },
  pages: {
    matchHistory: { selectors: [] },
    endOfGame: { selectors: [] },
  },
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value
  }
  return result
}

/**
 * 读取用户配置。
 * 先试动态 import（Pengu 的 JSON 模块），不行再 fetch，最后退回默认值 ——
 * 这样即使某个 Pengu 版本不支持 JSON 模块，插件也能正常跑。
 */
async function readUserConfig() {
  try {
    const module = await import('./config.json')
    const value = module && (module.default ?? module)
    if (isPlainObject(value)) return value
  } catch (err) {
    warn('import config.json 失败，尝试 fetch:', err?.message || err)
  }

  try {
    const url = new URL('./config.json', import.meta.url).href
    const response = await fetch(url, { cache: 'no-store' })
    if (response.ok) {
      const value = await response.json()
      if (isPlainObject(value)) return value
    }
  } catch (err) {
    warn('读取 config.json 失败，使用默认配置:', err?.message || err)
  }

  return {}
}

let config = mergeConfig(DEFAULT_CONFIG, {})

const state = {
  ready: false,
  phase: 'None',
  self: null,
  region: '',
  hits: [],
  familiar: [],
  gameId: 0,
  gameModalShown: false,
  hitsToastKey: '',
}

let store = null
let launcher = null
let hint = null
let matchHistoryPage = null
let endOfGamePage = null
let champSelect = null
let encounterHistory = null
const partyTracker = createPartyTracker({ lcu, getSelf: () => state.self })
let gameStartRequest = 0
let observer = null
let scanTimer = null
let pollTimer = null
let lastSelfTry = 0
let phaseTestKeys = new Set()
const matchTestTargets = new Map()
let detectedTestTargets = { hits: [], familiar: [] }
let activeHitsPanel = null

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

function createStorage(fs) {
  const FILE = 'data/blacklist.json'
  const KEY = 'pengu-blacklist/data'
  const dataStore = typeof window !== 'undefined' ? window.DataStore : null
  let dirReady = null

  async function ensureDir() {
    if (!fs) return false
    if (!dirReady) dirReady = Promise.resolve(fs.mkdir('data')).catch(() => false)
    return dirReady
  }

  return {
    async read() {
      if (fs) {
        try {
          const text = await fs.read(FILE)
          if (text && String(text).trim()) return text
        } catch (err) {
          warn('读取黑名单文件失败:', err)
        }
      }
      if (dataStore && typeof dataStore.get === 'function') {
        try {
          const mirrored = dataStore.get(KEY)
          if (mirrored) return typeof mirrored === 'string' ? mirrored : JSON.stringify(mirrored)
        } catch (err) {
          warn('读取 DataStore 失败:', err)
        }
      }
      return undefined
    },

    async write(text) {
      let ok = false
      if (fs) {
        try {
          await ensureDir()
          ok = await fs.write(FILE, text)
        } catch (err) {
          warn('写入黑名单文件失败:', err)
        }
      }
      if (dataStore && typeof dataStore.set === 'function') {
        try {
          dataStore.set(KEY, text)
          ok = true
        } catch (err) {
          warn('写入 DataStore 失败:', err)
        }
      }
      return ok
    },
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export async function init(context = {}) {
  try {
    config = mergeConfig(DEFAULT_CONFIG, await readUserConfig())
    if (!isPlainObject(config.encounters)) config.encounters = { ...DEFAULT_CONFIG.encounters }

    store = createStore({ storage: createStorage(context.fs) })
    await store.load()
    const savedFamiliar = store.getSetting('familiarEnabled')
    if (savedFamiliar) config.encounters.enabled = savedFamiliar === '1'
    encounterHistory = createEncounterHistory({ lcu, config: config.encounters })

    store.onChange(() => {
      updateLauncher()
      scheduleScan(200)
      if (state.phase === 'ChampSelect') champSelect?.check()
    })

    lcu
      .getCurrentSummoner()
      .then((summoner) => {
        if (!summoner) return
        state.self = summoner
        // 重新扫一遍：把"自己"那一行误加的按钮清掉
        removeInjectedButtons()
        scheduleScan(200)
      })
      .catch(() => {})

    lcu
      .detectRegion()
      .then((region) => {
        state.region = region
      })
      .catch(() => {})

    registerSocket(context.socket)
    exposeDebugApi()

    log(`v${VERSION} 已加载，当前黑名单 ${store.count()} 条`)
    // 诊断用：客户端日志会截断长行，这里用 ASCII 单独给一条
    log(`[data] count=${store.count()} fs=${context.fs ? 1 : 0}`)

    // Pengu 1.1.x 在异步 import 之后才注册 load 处理，可能错过 window.load。
    // 如果 DOM 已经就绪，这里手动兜底挂载一次。
    if (typeof document !== 'undefined' && document.readyState === 'complete') {
      queueMicrotask(() => load())
    }
  } catch (err) {
    warn('初始化失败:', err)
  }
}

let uiLoaded = false

export function load() {
  if (uiLoaded) return
  uiLoaded = true
  try {
    if (!store) {
      // init 没有被调用（非常老的 Pengu），用纯内存模式兜底
      store = createStore({})
      store.load()
    }
    encounterHistory ||= createEncounterHistory({ lcu, config: config.encounters || undefined })

    ensureRoot()
    // 清掉上一次遗留在页面上的按钮（例如插件热更新 / 旧版本注入到昵称上的那个）
    removeInjectedButtons()
    // 清掉可能残留的透明遮罩：它会挡住客户端自己的按钮
    for (const overlay of document.querySelectorAll('.pgbl-overlay')) overlay.remove()

    let savedPosition
    try { savedPosition = JSON.parse(store.getSetting('launcherPosition')) } catch { /* First load or old settings. */ }
    launcher = createLauncher({
      onClick: openPanel,
      position: { ...config.launcher, ...(isPlainObject(savedPosition) ? savedPosition : {}) },
      onPositionChange: (position) => store.setSetting('launcherPosition', JSON.stringify(position)),
    })
    hint = createPrivateHint({
      onClick: openPanel,
      position: config.privateHint,
      duration: Number(config.privateHint?.duration) || 12000,
    })

    champSelect = createChampSelectChecker({
      lcu,
      store,
      config,
      onResult: handleChampSelectResult,
      getFamiliar: findFamiliar,
      prepareParty: partyTracker.prepareMatch,
      isPartyMember: partyTracker.has,
    })

    matchHistoryPage = createMatchHistoryPage({
      lcu,
      store,
      config,
      onPick: openPlayerDialog,
      getSelf: () => state.self,
    })
    endOfGamePage = createEndOfGamePage({
      lcu,
      store,
      config,
      onPick: openPlayerDialog,
      getPhase: () => state.phase,
      getSelf: () => state.self,
    })

    observer = new MutationObserver(onMutations)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-screen-name'],
    })

    // 快捷键兜底：即使入口被客户端 UI 挡住，也能用 Alt+B 打开面板
    document.addEventListener(
      'keydown',
      (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key !== 'b' && event.key !== 'B') return
        if (!launcher?.isCurrent()) return
        event.preventDefault()
        event.stopPropagation()
        openPanel()
      },
      true,
    )

    scanTimer = setInterval(() => scheduleScan(), Math.max(600, Number(config.scanInterval) || 1500))
    pollTimer = setInterval(() => pollPhase(), 5000)

    state.ready = true
    void pollPhase({ force: true })
    scheduleScan(500)
    log('界面已就绪')
  } catch (err) {
    warn('加载界面失败:', err)
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 / 选人                                                         */
/* ------------------------------------------------------------------ */

function registerSocket(socket) {
  if (!socket || typeof socket.observe !== 'function') {
    warn('当前 Pengu 版本没有 context.socket，改用轮询')
    return
  }
  try {
    socket.observe('/lol-gameflow/v1/gameflow-phase', (event) => {
      if (event?.data) handlePhase(event.data)
    })
    socket.observe('/lol-champ-select/v1/session', () => {
      if (state.phase === 'ChampSelect') champSelect?.check()
    })
    socket.observe(LOBBY_PATH, (event) => {
      const phase = state.phase
      if (phase !== 'None' && !QUEUE_PHASES.has(phase)) return
      if (event?.eventType === 'Delete') {
        if (phase === 'Lobby' || phase === 'None') partyTracker.reset()
        return
      }
      partyTracker.capture(event?.data)
    })
  } catch (err) {
    warn('注册 socket 监听失败:', err)
  }
}

function normalizePhase(phase) {
  if (typeof phase === 'string') return phase.replace(/"/g, '')
  if (phase && typeof phase === 'object' && typeof phase.phase === 'string') return phase.phase
  return 'None'
}

async function pollPhase({ force = false } = {}) {
  if (!state.ready) return
  const previous = state.phase
  const phase = await lcu.getGameflowPhase()
  if (!phase || state.phase !== previous) return
  handlePhase(phase, { force })
  if (force || phase !== previous) return
  if (QUEUE_PHASES.has(phase)) void partyTracker.refresh()
  if (phase === 'ChampSelect') checkChampSelect()
}

async function checkChampSelect() {
  const refresh = encounterHistory?.refresh()
  await champSelect?.check()
  if (refresh && await refresh && state.phase === 'ChampSelect') await champSelect?.check()
}

function isTestEnabled(key) {
  return store?.getSetting(TEST_TARGETS[key].setting) === '1'
}

function armedTestTargets(showOpponents = true) {
  const results = { hits: [], familiar: [] }
  for (const key of phaseTestKeys) {
    const target = TEST_TARGETS[key]
    if (target.side === 'enemy' && !showOpponents) continue
    let item = matchTestTargets.get(key)
    if (!item) {
      item = createTestTarget(target)
      matchTestTargets.set(key, item)
    }
    results[target.group].push(item)
  }
  return results
}

function updateTestPhase(previous, phase) {
  if (previous === phase || (GAME_ALERT_PHASES.has(previous) && GAME_ALERT_PHASES.has(phase))) return
  if (previous === 'ChampSelect') {
    hint?.hide()
    hideChatLine()
  }

  // InProgress 也可能是客户端重载后读到的现有对局。只有从赛前进入才测试开局提醒。
  const entered =
    phase === 'ChampSelect' || phase === 'GameStart' ||
    (phase === 'InProgress' && (previous === 'ChampSelect' || QUEUE_PHASES.has(previous)))
  phaseTestKeys = new Set(entered ? Object.keys(TEST_TARGETS).filter(isTestEnabled) : [])

  // 选人已识别的目标留到开局扫描补齐名单。
  if (previous === 'ChampSelect' && GAME_ALERT_PHASES.has(phase)) return
  matchTestTargets.clear()
  if (detectedTestTargets.hits.length || detectedTestTargets.familiar.length) {
    detectedTestTargets = { hits: [], familiar: [] }
    refreshAlertViews()
  }
}

function handlePhase(rawPhase, { force = false } = {}) {
  const phase = normalizePhase(rawPhase)
  if (!force && phase === state.phase) return

  const previous = state.phase
  state.phase = phase
  log(`游戏阶段：${previous} -> ${phase}`)
  updateTestPhase(previous, phase)

  if (QUEUE_PHASES.has(phase)) {
    if (previous !== 'None' && previous !== phase && (phase === 'Lobby' || !QUEUE_PHASES.has(previous))) {
      partyTracker.reset()
    }
    void partyTracker.refresh()
  } else if (['None', 'TerminatedInError', 'PreEndOfGame', 'EndOfGame', 'WaitingForStats'].includes(phase)) {
    partyTracker.reset()
  }

  if (phase === 'ChampSelect') {
    if (previous !== 'ChampSelect') {
      resetSession()
    }
    removeInjectedButtons()
    checkChampSelect()
    return
  }

  if (GAME_ALERT_PHASES.has(phase)) {
    removeInjectedButtons()
    void onGameStart()
    return
  }

  if (phase === 'PreEndOfGame' || phase === 'EndOfGame' || phase === 'WaitingForStats') {
    endOfGamePage?.refresh?.()
    scheduleScan(300)
    return
  }

  if (['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'TerminatedInError'].includes(phase)) {
    resetSession()
    matchHistoryPage?.refresh?.()
  }
}

function hitsSummary(hits) {
  return hits
    .map((hit) => `${entryDisplayName(hit.entry)}（${hit.entry.reason || '黑名单玩家'}）`)
    .join('、')
}

function familiarSummary(familiar) {
  return familiar
    .map((item) => {
      const meta = [gamesAgoText(item.gamesAgo), teamText(item.lastTeam)].filter(Boolean).join('')
      return `${entryDisplayName(item.player)}（${meta}）`
    })
    .join('、')
}

async function getChampionName(id) {
  if (!id) return ''
  const champion = await lcu.getChampion(id).catch(() => null)
  return champion?.name || ''
}

/** 给命中项补上"本局使用的英雄"，给熟人补上"上次 / 本局英雄"（面板、提醒卡里展示）。 */
async function enrichResultChampions(blacklist = [], familiar = []) {
  await Promise.all([
    ...blacklist.map(async (hit) => {
      if (hit.championName) return
      const id = hit.player?.championId || hit.entry?.championId || 0
      if (!id) return
      hit.championId = id
      hit.championName = await getChampionName(id)
    }),
    ...familiar.map(async (item) => {
      const currentId = item.player?.championId
      const lastId = item.lastChampionId
      const [lastName, currentName] = await Promise.all([
        getChampionName(lastId),
        currentId === lastId ? '' : getChampionName(currentId),
      ])
      item.lastChampionName = lastName
      item.currentChampionName = currentId === lastId ? lastName : currentName
    }),
  ])
}

function updateChatLine() {
  if (config.chatLine === false) {
    hideChatLine()
    return
  }

  // 只在选人界面显示：进游戏就收起来
  if (state.phase !== 'ChampSelect') {
    hideChatLine()
    return
  }

  const parts = []
  const { hits, familiar } = visibleAlerts()
  if (hits.length) parts.push(`黑名单：${hitsSummary(hits)}`)
  if (familiar.length) parts.push(`熟人：${familiarSummary(familiar)}`)

  if (parts.length) showChatLine(parts.join('；'))
  else hideChatLine()
}

function showChampSelectHint() {
  if (config.privateHint?.enabled === false) return
  const { hits, familiar } = visibleAlerts()
  hint?.show({ blacklist: hits, familiar })
}

/** 选人阶段结果：黑名单 + 最近遇到过的人。 */
function handleChampSelectResult({ blacklist = [], familiar = [], sessionKey = '', canSeeOpponents = false } = {}) {
  if (state.phase !== 'ChampSelect') return
  if (config.encounters?.enabled === false) familiar = []
  detectedTestTargets = armedTestTargets(canSeeOpponents)
  state.hits = blacklist
  state.familiar = familiar
  log(`[cs] b=${blacklist.length} f=${familiar.length}`)
  refreshAlertViews()
  updateChatLine()

  // 英雄名是异步查的：拿到之后把提醒卡再刷一遍（先用 #id 兜底显示）
  void enrichResultChampions(blacklist, familiar)
    .then(() => {
      if (state.phase !== 'ChampSelect' || state.familiar !== familiar) return
      updateChatLine()
      if (hint?.isVisible()) showChampSelectHint()
    })
    .catch(() => {})

  const alerts = visibleAlerts()
  if (!alerts.hits.length && !alerts.familiar.length) state.hitsToastKey = ''

  // 私密提醒卡：只显示在自己客户端里，不会发到聊天
  showChampSelectHint()

  const testCount = detectedTestTargets.hits.length
  const toastKey = testCount ? `${sessionKey}:test:${testCount}` : sessionKey
  if (alerts.hits.length && state.hitsToastKey !== toastKey) {
    state.hitsToastKey = toastKey
    const testNote = testCount ? `（含 ${testCount} 个测试目标）` : ''
    notify(`本局有 ${alerts.hits.length} 名黑名单玩家${testNote}`, 'warning')
  }
}

/** 进游戏后读取名单，补上选人时看不到的玩家。 */
async function refreshGameSnapshot() {
  try {
    const session = await lcu.getGameflowSession()
    if (!session) return null
    await lcu.enrichPlayers(session.players)
    const self = state.self || (await lcu.getCurrentSummoner().catch(() => null))
    return { session, self }
  } catch (err) {
    warn('读取对局信息失败:', err?.message || err)
    return null
  }
}

function findFamiliar(players, blacklist, currentGameId, self = state.self) {
  if (!self || config.encounters?.enabled === false || !encounterHistory) return []
  return encounterHistory.lookup(players, { self, currentGameId }).filter((item) => {
    if (config.encounters?.includeSelf === true && sameEncounterPlayer(item.player, self)) return true
    return !blacklist.some((hit) => sameEncounterPlayer(hit.player, item.player))
  })
}

async function onGameStart({ alert = true } = {}) {
  const request = ++gameStartRequest
  const isCurrent = () => request === gameStartRequest && GAME_ALERT_PHASES.has(state.phase)
  const refresh = encounterHistory?.refresh()
  hint?.hide()
  hideChatLine()

  const previousHits = state.hits.slice()
  const selectedPlayers = champSelect?.getPlayers() || []
  const [snapshot] = await Promise.all([refreshGameSnapshot(), partyTracker.prepareMatch({ retry: true })])
  if (!isCurrent()) return

  const roster = snapshot?.session.players || []
  const self = snapshot?.self || state.self
  const gamePlayers = roster.filter((player) => !partyTracker.has(player))
  const players = [...gamePlayers, ...selectedPlayers.filter((selected) =>
    !partyTracker.has(selected) && !gamePlayers.some((player) => sameEncounterPlayer(player, selected)),
  )]
  const draftSideOf = (player) => selectedPlayers.find((selected) => sameEncounterPlayer(selected, player))?.currentSide
  const ownTeamId = roster.find((player) => sameEncounterPlayer(player, self))?.teamId ||
    roster.find((player) => player.teamId && draftSideOf(player) === 'ally')?.teamId

  function resolveCurrentSide(player) {
    const teamId = roster.find((member) => sameEncounterPlayer(member, player))?.teamId
    if (teamId && ownTeamId) return teamId === ownTeamId ? 'ally' : 'enemy'
    return draftSideOf(player)
  }

  state.gameId = snapshot?.session.gameId || state.gameId
  state.hits = mergeHitLists(
    previousHits.filter((hit) => !partyTracker.has(hit.player)),
    findHitsForPlayers(gamePlayers, store.all()),
  )
  state.familiar = state.familiar.filter((item) => !partyTracker.has(item.player))

  const update = () => {
    if (!isCurrent()) return
    const familiar = state.gameId && players.length
      ? findFamiliar(players, state.hits, state.gameId, self)
      : state.familiar
    state.familiar = familiar.map((item) => ({
      ...item,
      currentSide: resolveCurrentSide(item.player) || item.currentSide,
    }))
    detectedTestTargets = armedTestTargets()
    void enrichResultChampions(state.hits, state.familiar).catch(() => {})
    refreshAlertViews()
    if (alert) showGameAlerts()
  }

  update()
  if (refresh) {
    if (await refresh) update()
  }
}

function showGameAlerts() {
  const stageTestKeys = phaseTestKeys
  const hasAlerts = () => {
    const { hits, familiar } = loadingAlerts()
    return hits.length || familiar.length
  }
  if (state.gameModalShown || !hasAlerts()) return

  state.gameModalShown = true
  const gameId = state.gameId
  const delay = Math.max(0, Number(config.notify?.delayMs) || 4000)
  const isCurrent = () => stageTestKeys === phaseTestKeys && GAME_ALERT_PHASES.has(state.phase) &&
    state.gameModalShown && (!gameId || gameId === state.gameId)
  setTimeout(async () => {
    if (!isCurrent()) return
    if (hasAlerts() && config.notify?.focusClient !== false) await bringClientToFront()
    if (!isCurrent()) return
    if (!hasAlerts()) {
      state.gameModalShown = false
      return
    }
    log('[focus] show')
    openPanel({ autoCloseMs: Number(config.notify?.panelAutoCloseMs) || 0, loadingAlert: true })
  }, delay)
}

/** 把客户端窗口召到前台（Riot Client 官方接口），失败再用 window.focus() 兜底。 */
async function bringClientToFront() {
  try {
    await lcu.request('/riotclient/ux-show', { method: 'POST' })
  } catch (_) {
    try {
      window.focus()
    } catch (_) {
      /* ignore */
    }
  }
}

function resetSession() {
  gameStartRequest++
  encounterHistory?.reset()
  state.hits = []
  state.familiar = []
  state.gameId = 0
  state.gameModalShown = false
  state.hitsToastKey = ''
  champSelect?.reset()
  hint?.hide()
  hideChatLine()
  refreshAlertViews()
}

/* ------------------------------------------------------------------ */
/* 页面扫描                                                            */
/* ------------------------------------------------------------------ */

const scheduleScan = debounce(() => {
  runScan().catch((err) => warn('扫描失败:', err))
}, 350)

let pruneTimer = 0

/** 插件自己的节点（面板、注入按钮）产生的变动不算页面变化。 */
function isOwnNode(node) {
  if (!node || node.nodeType !== 1) return false
  try {
    if (node.closest && node.closest('#pgbl-root')) return true
    if (node.classList && node.classList.contains('pgbl-add')) return true
  } catch (_) {
    /* ignore */
  }
  return false
}

function schedulePrune() {
  if (pruneTimer) return
  pruneTimer = setTimeout(() => {
    pruneTimer = 0
    pruneDetachedButtons()
  }, 80)
}

function onMutations(mutations) {
  const relevant = mutations.filter((mutation) => {
    if (mutation.type === 'attributes') return !isOwnNode(mutation.target)
    if (isOwnNode(mutation.target)) return false

    const changed = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
    if (!changed.length) return true
    return changed.some((node) => !isOwnNode(node))
  })

  if (!relevant.length) return

  // 只做防抖清理，避免"清理→扫描→注入→再清理"的自激循环
  schedulePrune()
  scheduleScan()
}

/** 自己的信息如果启动时没拿到，扫描时补一次——否则无法排除自己那一行。 */
async function ensureSelf() {
  if (state.self) return
  if (Date.now() - lastSelfTry < 10_000) return
  lastSelfTry = Date.now()
  try {
    const summoner = await lcu.getCurrentSummoner({ force: true })
    if (!summoner) return
    state.self = summoner
    removeInjectedButtons()
  } catch (_) {
    /* 下次再试 */
  }
}

async function runScan(force = false) {
  if (!state.ready || !store) return

  await ensureSelf()

  // 选人 / 游戏内不注入按钮：那两个界面没有"对局名单"，
  // 强行注入会把英雄选择条、玩家列表插花。
  const noInjectPhases = ['ChampSelect', 'GameStart', 'InProgress', 'Reconnect', 'GameStart']
  if (noInjectPhases.includes(state.phase)) {
    removeInjectedButtons()
    updateLauncher()
    updateChatLine()
    return
  }

  if (force) {
    await Promise.all([matchHistoryPage?.refresh?.(), endOfGamePage?.refresh?.()]).catch(() => {})
  }

  // 不再依赖"当前页面"判断：注入以英雄头像为锚点，只有真正的玩家行才会命中
  for (const page of [matchHistoryPage, endOfGamePage]) {
    if (!page) continue
    try {
      const count = await page.activate()
      if (count > 0) log(`已注入 ${count} 个拉黑按钮（${page.id}）`)
    } catch (err) {
      warn(`页面注入失败（${page.id}）:`, err)
    }
  }

  updateLauncher()
  updateChatLine()
}

/* ------------------------------------------------------------------ */
/* 界面动作                                                            */
/* ------------------------------------------------------------------ */

function visibleAlerts() {
  const { hits, familiar } = detectedTestTargets
  return {
    hits: hits.length ? state.hits.concat(hits) : state.hits,
    familiar: familiar.length ? state.familiar.concat(familiar) : state.familiar,
  }
}

function isFamiliarLoadingEnabled(side) {
  return store?.getSetting(FAMILIAR_LOADING_SETTINGS[side]) !== '0'
}

function loadingAlerts() {
  const alerts = visibleAlerts()
  const enabledSides = Object.keys(FAMILIAR_LOADING_SETTINGS).filter(isFamiliarLoadingEnabled)
  if (enabledSides.length === 2) return alerts
  return { hits: alerts.hits, familiar: alerts.familiar.filter((item) => enabledSides.includes(item.currentSide)) }
}

function refreshAlertViews() {
  updateLauncher()
  activeHitsPanel?.refreshAlerts()
}

function updateLauncher() {
  if (!launcher?.attach()) return
  const { hits, familiar } = visibleAlerts()
  launcher.setHits({ blacklist: hits.length, familiar: familiar.length })

  // 有命中、黑名单非空、或用户强制常驻时显示入口
  const show = hits.length + familiar.length > 0 || !!config.alwaysShowLauncher || (store ? store.count() > 0 : false)
  if (show) {
    launcher.show()
  } else {
    launcher.hide()
  }
}

function openPanel(options = {}) {
  if (!store || (launcher && !launcher.isCurrent())) return
  try {
    hint?.hide()

    const autoCloseMs = options && typeof options === 'object' ? Number(options.autoCloseMs) || 0 : 0

    const panel = openHitsPanel({
      getAlerts: options?.loadingAlert ? loadingAlerts : visibleAlerts,
      store,
      gameInfo: state.gameId ? `对局 ${state.gameId}` : '',
      getChampionName,
      getChampions: () => lcu.getChampions(),
      notify,
      autoCloseMs,
      onClose: () => {
        if (activeHitsPanel === panel) activeHitsPanel = null
      },
      onEdit: openEntryEditor,
      onRemove: (entry) => {
        store.remove(entry.id)
        notify('已移出黑名单', 'success')
      },
      onBlacklist: openFamiliarDialog,
      settings: {
        familiarEnabled: config.encounters.enabled !== false,
        setFamiliar(enabled) {
          config.encounters.enabled = enabled
          if (!enabled) {
            state.familiar = []
            encounterHistory?.reset()
            if (hint?.isVisible()) showChampSelectHint()
          }
          store.setSetting('familiarEnabled', enabled ? '1' : '0')
          refreshAlertViews()
          updateChatLine()
          if (enabled && state.phase === 'ChampSelect') void checkChampSelect()
          if (enabled && GAME_ALERT_PHASES.has(state.phase)) void onGameStart({ alert: false })
        },
        familiarLoadingEnabled: isFamiliarLoadingEnabled,
        setFamiliarLoading(side, enabled) {
          store.setSetting(FAMILIAR_LOADING_SETTINGS[side], enabled ? '1' : '0')
          activeHitsPanel?.refreshAlerts()
        },
        testEnabled: isTestEnabled,
        setTestEnabled(key, enabled) {
          const { setting, group } = TEST_TARGETS[key]
          if (!enabled) {
            phaseTestKeys.delete(key)
            const item = matchTestTargets.get(key)
            detectedTestTargets[group] = detectedTestTargets[group].filter((target) => target !== item)
          }
          store.setSetting(setting, enabled ? '1' : '0')
          refreshAlertViews()
          updateChatLine()
          if (hint?.isVisible()) showChampSelectHint()
        },
        resetLauncher() {
          store.setSetting('launcherPosition', '')
          launcher?.setPosition(config.launcher)
        },
      },
    })
    activeHitsPanel = panel
  } catch (err) {
    warn('打开黑名单面板失败:', err)
    notify(`打开面板失败：${err?.message || err}`, 'error')
  }
}

/** 从「最近遇到过」的卡片直接拉黑。 */
function openFamiliarDialog(item) {
  if (!item?.player || item.isTest) return
  const player = item.player
  openPlayerDialog(
    {
      puuid: player.puuid,
      summonerId: player.summonerId,
      gameName: player.gameName,
      tagLine: player.tagLine,
      name: displayNameOf(player),
      platformId: player.platformId,
    },
    {
      gameId: item.gameId,
      championId: item.lastChampionId,
      championName: item.lastChampionName,
      region: player.platformId,
      source: 'encounter',
    },
  )
}

function openEntryEditor(entry) {
  openPlayerDialog(
    {
      puuid: entry.puuid,
      summonerId: entry.summonerId,
      gameName: entry.gameName,
      tagLine: entry.tagLine,
      name: entry.name,
    },
    {
      gameId: entry.gameId,
      championId: entry.championId,
      championName: entry.championName,
      source: entry.source,
    },
    entry,
  )
}

/**
 * 打开"拉黑 / 修改"弹窗。
 * 玩家信息全部来自对局名单，用户只需要填原因。
 */
async function openPlayerDialog(player, context = {}, entry = null) {
  if (!store) return
  const existing = entry || store.find(player)
  let championName = context.championName || existing?.championName || ''
  const championId = context.championId || existing?.championId || 0

  if (!championName && championId) championName = await getChampionName(championId)

  const region = [context.region, player.platformId].map(normalizePlatform)
    .find((code) => code && code !== 'TENCENT') || ''
  const mergedContext = { ...context, championName, region }

  openReasonDialog({
    player,
    entry: existing,
    context: mergedContext,
    onSave: (reason) => {
      saveBlacklist(player, mergedContext, reason, existing)
    },
    onRemove: existing
      ? () => {
          store.remove(existing.id)
          notify('已移出黑名单', 'success')
          scheduleScan(200)
        }
      : undefined,
  })
}

function saveBlacklist(player, context, reason, existing) {
  const displayName = displayNameOf(player)
  const result = store.upsert({
    id: existing?.id,
    puuid: player.puuid || existing?.puuid,
    summonerId: player.summonerId || existing?.summonerId,
    gameName: player.gameName || existing?.gameName,
    tagLine: player.tagLine || existing?.tagLine,
    name: displayName && displayName !== '未知玩家' ? displayName : existing?.name,
    region: context.region,
    reason,
    gameId: context.gameId || existing?.gameId,
    gameMode: context.gameMode || existing?.gameMode,
    championId: context.championId || existing?.championId,
    championName: context.championName || existing?.championName,
    source: context.source || existing?.source || 'manual',
  })

  if (!result.entry) {
    notify('保存失败：缺少玩家信息', 'error')
    return
  }

  notify(result.created ? '已加入黑名单' : '黑名单已更新', 'success')
  scheduleScan(150)
}

/* ------------------------------------------------------------------ */
/* 调试接口                                                            */
/* ------------------------------------------------------------------ */

function exposeDebugApi() {
  const api = {
    version: VERSION,
    config,
    get store() {
      return store
    },
    list: () => (store ? store.all() : []),
    count: () => (store ? store.count() : 0),
    hits: () => state.hits,
    familiar: () => state.familiar,
    encounters: () => (store ? store.getEncounterGames() : []),
    state,
    testFocus: () => bringClientToFront(),
    /** 一键诊断：页面识别 / 名单 / 注入数量，排查"没有按钮"时用 */
    debug() {
      const icons = document.querySelectorAll('img[src*="champion-icons"], [style*="champion-icons"]').length
      const buttons = document.querySelectorAll('.pgbl-add').length
      const info = {
        version: VERSION,
        phase: state.phase,
        region: state.region,
        self: state.self ? displayNameOf(state.self) : null,
        icons,
        buttons,
        blacklist: store ? store.count() : 0,
        hits: state.hits.length,
        familiar: state.familiar.length,
        encounterGames: store ? store.encounterGameCount() : 0,
        launcher: launcher ? launcher.isVisible() : false,
        overlays: document.querySelectorAll('.pgbl-overlay').length,
        hint: hint ? hint.isVisible() : false,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        match: matchHistoryPage?.stats?.(),
        eog: endOfGamePage?.stats?.(),
      }
      try {
        console.log('[PenguBlacklist] 诊断:', JSON.stringify(info))
      } catch (_) {
        /* ignore */
      }
      return info
    },
    /** 逐行诊断：每行看到的文本 / 是否已加按钮 */
    inspect(limit = 40) {      const rows = inspectRows(document, limit)
      try {
        console.log('[PenguBlacklist] 行诊断:', JSON.stringify(rows))
      } catch (_) {
        /* ignore */
      }
      return rows
    },
    /** 看入口按钮中心点上最上层的是谁 */
    hitLauncher() {
      try {
        if (!launcher) return { error: 'launcher is null' }
        const el = launcher.el
        if (!el) return { error: 'launcher.el is null' }

        const rect = el.getBoundingClientRect()
        const root = document.getElementById('pgbl-root')
        const info = {
          connected: el.isConnected,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          display: getComputedStyle(el).display,
          visibility: getComputedStyle(el).visibility,
          opacity: getComputedStyle(el).opacity,
          parent: el.parentElement ? el.parentElement.id || el.parentElement.className : null,
          rootConnected: !!root && root.isConnected,
          rootDisplay: root ? getComputedStyle(root).display : null,
          rootChildren: root ? root.children.length : 0,
        }
        if (rect.width && rect.height) {
          info.hit = this.hitTest(rect.left + rect.width / 2, rect.top + rect.height / 2)
        }
        try {
          console.log('[PenguBlacklist] hitLauncher:', JSON.stringify(info))
        } catch (_) {
          /* ignore */
        }
        return info
      } catch (err) {
        return { error: String(err) }
      }
    },
    /** 看某个坐标上最上层的元素是谁（排查"点不动"用） */
    hitTest(x, y) {
      const el = document.elementFromPoint(Number(x), Number(y))
      if (!el) return null
      const info = {
        tag: el.tagName,
        id: el.id,
        cls: String(el.className || '').slice(0, 120),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      }
      try {
        console.log('[PenguBlacklist] hitTest:', JSON.stringify(info))
      } catch (_) {
        /* ignore */
      }
      return info
    },
    scan: (force = true) => runScan(force),
    panel: () => openPanel(),
    resetChatCache,
    add(name, reason = '手动添加') {
      if (!store) return null
      const result = store.upsert({ name, gameName: name, reason, source: 'manual' })
      return result.entry
    },
    /** 把自己加入黑名单，用来测试选人提醒 */
    addSelf(reason = '测试自己') {
      if (!store) return null
      if (!state.self) {
        warn('还没拿到自己的信息，稍后再试')
        return null
      }
      const name = displayNameOf(state.self)
      const result = store.upsert({
        puuid: state.self.puuid,
        summonerId: state.self.summonerId,
        gameName: state.self.gameName,
        tagLine: state.self.tagLine,
        name,
        region: state.region || state.self.platformId || '',
        reason,
        source: 'manual',
      })
      if (result.entry) {
        notify('已把自己加入黑名单（测试用），按 Alt+B 可随时打开面板', 'success')
        scheduleScan(200)
        setTimeout(() => openPanel(), 350)
      }
      return result.entry
    },
    remove(id) {
      return store ? store.remove(id) : false
    },
  }

  try {
    window.PenguBlacklist = api
  } catch (_) {
    /* ignore */
  }
}
