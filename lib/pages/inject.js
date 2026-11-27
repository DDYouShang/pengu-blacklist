/**
 * 往对局名单里注入"拉黑"按钮。
 *
 * 结构（来自真实客户端）：
 *   div.player-history-object-wrapper
 *     div.player-history-champion
 *       div.player-history-champion-icon > img[src*="champion-icons/N.png"]
 *       div.player-history-lv  → 等级
 *     div.player-history-result
 *       div.player-history-result-text → 英雄名
 *       div.player-history-mode        → 玩家名（可能被 U+2066/U+2069 包裹）
 *       div.player-history-...
 *
 * 因此：
 *   1. 以英雄头像为锚点找到"只含 1 个头像"的行；
 *   2. 名字直接从行里的 .player-history-mode 读（不依赖名单是否完整）；
 *   3. 名单只用来补 puuid / 对局 / 大区，补不到就按"只有名字"保存；
 *   4. 按钮插在名字元素后面。
 */

import { cleanText, h, normalizeText } from '../dom.js'
import { displayNameOf, isSamePlayer, nameVariants } from '../model.js'

export const ADD_BUTTON_CLASS = 'pgbl-add'

const ICON_SELECTOR = [
  'img[src*="champion-icons"]',
  '[style*="champion-icons"]',
  'img[class*="champion-pic"]',
  'img[class*="champion-icon"]',
  'img[src*="/champion/"]',
].join(', ')

/** 名字可能藏在这些类名里（按优先级） */
const NAME_HINT_SELECTORS = [
  '[class*="player-history-mode"]',
  '[class*="summoner-name"]',
  '[class*="player-name"]',
  '[class*="name-text"]',
]

const MAX_BUTTONS = 40
const MAX_ROW_TEXT = 600

/** 战绩列表卡片（一局一张卡）不是玩家行，靠日期/模式名排除。 */
const CARD_PATTERN = /(\d{1,2}:\d{2}\s*[•·]\s*\d{4})|大乱斗|召唤师峡谷|云顶之弈|极地大乱斗/

/** 真正的对局玩家行一定带 KDA；选人页的英雄条/玩家列表没有。 */
const KDA_PATTERN = /\d+\s*\/\s*\d+\s*\/\s*\d+/

function iconSource(el) {
  if (!el || typeof el.getAttribute !== 'function') return ''
  return el.getAttribute('src') || el.getAttribute('style') || ''
}

function championIdOf(icon) {
  const match = String(iconSource(icon)).match(/champion-icons\/(\d+)\.(?:png|jpe?g|webp)/i)
  return match ? Number(match[1]) : 0
}

function countIcons(node) {
  try {
    return node.querySelectorAll(ICON_SELECTOR).length
  } catch (_) {
    return 0
  }
}

/**
 * 从英雄头像往上收集"候选行"：从小到大。
 * 头像外面通常套了一层只有图片的容器，名字在更上一级，所以候选都留着逐个尝试。
 */
function rowCandidates(icon) {
  const rows = []
  let node = icon.parentElement
  for (let depth = 0; node && depth < 8; depth++) {
    const count = countIcons(node)
    if (count > 1) break // 到队伍/列表容器了，再往上只会混入别人
    if (count === 1) rows.push(node)
    node = node.parentElement
  }
  return rows
}

/** 从行里读玩家名（不依赖 LCU 名单）。 */
function nameFromRow(row) {
  for (const selector of NAME_HINT_SELECTORS) {
    let nodes
    try {
      nodes = row.querySelectorAll(selector)
    } catch (_) {
      continue
    }
    for (const el of nodes) {
      if (el.closest && el.closest('#pgbl-root, .pgbl-root')) continue
      const name = cleanText(el.textContent)
      if (!name || name.length > 40) continue
      return { el, name }
    }
  }
  return null
}

function rectOf(el) {
  try {
    return el.getBoundingClientRect()
  } catch (_) {
    return null
  }
}

/** 找到这一行最后一个"纯数字单元格"（金币/伤害等），用作对齐基准。 */
function findNumberCell(row) {
  let best = null
  for (const el of row.querySelectorAll('div, span')) {
    if (el.childElementCount) continue
    const text = (el.textContent || '').trim()
    if (!/^\d{1,3}(,\d{3})*$/.test(text)) continue
    const rect = rectOf(el)
    if (!rect || rect.width < 4 || rect.height < 4) continue
    if (!best || rect.right > best.rect.right) best = { el, rect }
  }
  return best
}

function isSelfRecord(record, self) {
  if (!self) return false
  if (isSamePlayer(record, self)) return true

  const left = normalizeText(displayNameOf(record))
  const right = normalizeText(displayNameOf(self))
  if (left && left === right) return true

  // 只有名字的记录（从行里读出来的）也要能匹配上自己
  const leftName = normalizeText(record.gameName || record.legacyName || record.name)
  const rightName = normalizeText(self.gameName || self.legacyName)
  return !!leftName && leftName === rightName
}

/** 把「玩家 × 对局」的记录压成「每个玩家一组」。 */
function buildItems(records, self) {
  const items = new Map()

  for (const record of records) {
    if (!record) continue
    if (isSelfRecord(record, self)) continue

    const aliases = nameVariants(record)
    if (!aliases.length) continue

    const nameKey = normalizeText(displayNameOf(record))
    const key = record.puuid
      ? `p:${record.puuid}|${nameKey}`
      : record.summonerId
        ? `s:${record.summonerId}|${nameKey}`
        : `n:${nameKey}`

    const existing = items.get(key)
    if (existing) {
      existing.occurrences.push(record)
      for (const alias of aliases) existing.aliases.add(alias)
    } else {
      items.set(key, { key, aliases: new Set(aliases), occurrences: [record] })
    }
  }

  return Array.from(items.values())
}

function rowTextOf(row) {
  const text = row.textContent || ''
  return text.length > MAX_ROW_TEXT ? '' : normalizeText(text)
}

/**
 * 在一行里找出这是哪个玩家：长名字优先，其次英雄 id 对得上的记录。
 */
function pickItem(rowText, championId, items) {
  if (!rowText) return null
  let best = null

  for (const item of items) {
    let score = 0
    for (const alias of item.aliases) {
      if (alias.length > score && rowText.includes(alias)) score = alias.length
    }
    if (!score) continue

    const occurrence =
      (championId && item.occurrences.find((record) => record.championId === championId)) ||
      item.occurrences[0]
    const championMatch = !!championId && occurrence.championId === championId
    const rank = score * 10 + (championMatch ? 5 : 0)

    if (!best || rank > best.rank) best = { item, occurrence, rank }
  }

  return best
}

export function createAddButton(player, { blacklisted = false, onClick } = {}) {
  return h('button', {
    class: `pgbl-add${blacklisted ? ' is-blacklisted' : ''}`,
    type: 'button',
    text: blacklisted ? '已拉黑' : '拉黑',
    title: blacklisted ? `已拉黑：${displayNameOf(player)}（点击查看）` : `拉黑 ${displayNameOf(player)}`,
    attrs: { 'data-pgbl-add': '1' },
    onclick: (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick?.(player, event.currentTarget)
    },
  })
}

let scrollBound = false

const KDA_CELL = /^\d{1,3}\s*\/\s*\d{1,3}\s*\/\s*\d{1,3}$/

function isKdaCell(element) {
  return !element.childElementCount && KDA_CELL.test((element.textContent || '').trim())
}

/**
 * 历史战绩页：按钮停靠在**这一行最右侧**（金币右边的空白处）。
 * 必须挂在 body 上并用视口坐标：行在带 transform 的容器里，
 * 放进行内会让 fixed 以该容器为基准，产生累积偏移。
 */
function dockToRowEnd(row, button) {
  button.classList.add('pgbl-add--end')

  // 先清掉这一行上残留的旧按钮（可能是旧版本用别的定位方式留下的）
  removeButtonsForRow(row, button)

  const set = (name, value) => button.style.setProperty(name, value, 'important')
  set('position', 'fixed')
  set('right', 'auto')
  set('transform', 'translateY(-50%)')
  set('margin', '0')

  button.__pgblRow = row
  document.body.appendChild(button)

  const reposition = () => {
    try {
      const maxLeft = Math.max(8, (window.innerWidth || 1920) - 64)
      const cell = findNumberCell(row)
      if (cell) {
        const left = Math.min(Math.max(8, Math.round(cell.rect.right + 10)), maxLeft)
        set('left', `${left}px`)
        set('top', `${Math.round(cell.rect.top + cell.rect.height / 2)}px`)
        return
      }
      const box = row.getBoundingClientRect()
      if (!box.width) return
      set('left', `${Math.min(Math.round(box.right + 10), maxLeft)}px`)
      set('top', `${Math.round(box.top + box.height / 2)}px`)
    } catch (_) {
      /* ignore */
    }
  }

  const schedule =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0)
  schedule(() => {
    reposition()
    button.__pgblReposition = reposition
    bindScrollReposition()
  })
}

/**
 * 新版结算页：把按钮停在 KDA 单元格左侧的空白处。
 * 这页的行是 flex，行内元素位置固定，用 KDA 的视口坐标定位最准。
 */
function dockNearKda(row, button) {
  button.classList.add('pgbl-add--kda')

  // 先清掉这一行上残留的旧按钮（可能是旧版本用别的定位方式留下的）
  removeButtonsForRow(row, button)

  const set = (name, value) => button.style.setProperty(name, value, 'important')

  // 进 DOM 之前就脱离文档流：否则按钮会参与布局，把页面撑宽/挤歪
  set('position', 'fixed')
  set('right', 'auto')
  set('transform', 'translateY(-50%)')
  set('margin', '0')

  // 关键：挂到 body 上，而不是行里。
  // 战绩列表的行通常在带 transform 的容器里，fixed 会以那个容器为基准，
  // 导致每行叠加一次偏移（越往下越错位，最后跑出屏幕）。
  button.__pgblRow = row
  document.body.appendChild(button)

  const reposition = () => {
    try {
      const kda =
        row.querySelector('[class*="INDIVIDUAL_KDA"]') ||
        row.querySelector('[class*="scoreboard-row-stat-display-component"]') ||
        findKdaElement(row)
      if (!kda) return
      const rect = kda.getBoundingClientRect()
      if (!rect.width) return
      const maxLeft = Math.max(8, (window.innerWidth || 1920) - 64)
      const left = Math.min(Math.max(8, Math.round(rect.left - 56)), maxLeft)
      set('left', `${left}px`)
      set('top', `${Math.round(rect.top + rect.height / 2)}px`)
    } catch (_) {
      /* ignore */
    }
  }

  const schedule =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0)

  schedule(() => {
    set('position', 'fixed')
    set('right', 'auto')
    set('transform', 'translateY(-50%)')
    set('margin', '0')
    reposition()
    button.__pgblReposition = reposition
    bindScrollReposition()
  })
}

function bindScrollReposition() {
  if (scrollBound) return
  scrollBound = true
  const onScroll = () => {
    for (const el of document.querySelectorAll(`.${ADD_BUTTON_CLASS}`)) {
      try {
        el.__pgblReposition?.()
      } catch (_) {
        /* ignore */
      }
    }
  }
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll, true)
}
/** 从行往上看几层，找这一行对应的英雄头像（用于定位"这一局用的英雄"）。 */
function championIdNear(row) {
  let node = row
  for (let i = 0; i < 4 && node; i++) {
    const icon = node.querySelector(ICON_SELECTOR)
    if (icon) return championIdOf(icon)
    node = node.parentElement
  }
  return 0
}

/** 在行内找 KDA 文本（"x / x / x"）的元素，用于定位按钮。 */
function findKdaElement(row) {
  let best = null
  for (const el of row.querySelectorAll('div, span')) {
    if (!isKdaCell(el)) continue
    const rect = rectOf(el)
    if (!rect || rect.width < 4 || rect.height < 4) continue
    if (!best || rect.left > best.rect.left) best = { el, rect }
  }
  return best ? best.el : null
}

/**
 * 历史战绩页：直接按 .player-history-mode 里的名字逐行注入，
 * 不依赖英雄头像、也不依赖名单是否完整。
 */
function scanNameNodes({ root, items, self, isBlacklisted, onAdd }) {
  const nodes = root.querySelectorAll('[class*="player-history-mode"]')
  const usedRows = new Set()
  let injected = 0
  let matched = 0

  for (const node of nodes) {
    if (injected >= MAX_BUTTONS) break
    if (node.closest && node.closest('#pgbl-root')) continue

    const name = cleanText(node.textContent)
    if (!name || name.length > 40) continue

    const row =
      (node.closest && node.closest('[class*="player-history-object-wrapper"]')) ||
      (node.parentElement && node.parentElement.parentElement)
    if (!row || usedRows.has(row)) continue

    // 战绩列表卡片（一局一张卡，带日期/模式名）不是玩家行
    if (CARD_PATTERN.test(cleanText(row.textContent))) {
      usedRows.add(row)
      continue
    }

    if (row.__pgblBtn && row.__pgblBtn.isConnected && row.__pgblBtn.classList.contains('pgbl-add--end')) {
      usedRows.add(row)
      continue
    }
    if (row.__pgblBtn) row.__pgblBtn.remove()

    if (isSelfRecord({ gameName: name, name }, self)) {
      usedRows.add(row)
      continue
    }

    matched++

    const championId = championIdNear(row)
    const record = pickItem(normalizeText(name), championId, items)
    const player = record
      ? { ...record.occurrence, championId: championId || record.occurrence.championId }
      : { gameName: name, name, championId, gameId: 0, region: '', source: 'match-history' }

    const button = createAddButton(player, {
      blacklisted: !!isBlacklisted?.(player),
      onClick: onAdd,
    })
    row.__pgblBtn = button
    usedRows.add(row)
    dockToRowEnd(row, button)
    injected++
  }

  return { injected, matched }
}

function scanKdaRows({ root, items, isBlacklisted, onAdd }) {
  if (!items.length) return { injected: 0, matched: 0 }

  const cells = root.querySelectorAll('div, span')
  const usedRows = new Set()
  const usedKeys = new Set()
  let injected = 0
  let matched = 0

  for (const cell of cells) {
    if (injected >= MAX_BUTTONS) break
    if (!isKdaCell(cell)) continue
    if (cell.closest && cell.closest('#pgbl-root')) continue

    let row = cell.parentElement
    let picked = null
    let championId = 0

    for (let depth = 0; row && depth < 6; depth++) {
      if (usedRows.has(row)) {
        row = null
        break
      }
      const rowText = normalizeText(row.textContent)
      if (!rowText || rowText.length > 300 || CARD_PATTERN.test(cleanText(row.textContent))) {
        row = null
        break
      }
      // 包含多组 KDA 的容器已经跨出了当前玩家行。
      const otherKda = Array.from(row.querySelectorAll('div, span')).some(
        (element) => element !== cell && isKdaCell(element),
      )
      if (otherKda) {
        row = null
        break
      }
      const icons = row.querySelectorAll(ICON_SELECTOR)
      const hero = icons.length === 1 ? championIdOf(icons[0]) : 0
      const match = pickItem(rowText, hero, items)
      if (match) {
        picked = match
        championId = hero
        break
      }
      row = row.parentElement
    }

    if (!row || !picked) continue
    matched++
    if (usedKeys.has(picked.item.key)) continue

    // 这一行已经有按钮了（按钮挂在 body 上，用 __pgblBtn 关联）
    if (row.__pgblBtn && row.__pgblBtn.isConnected && row.__pgblBtn.classList.contains('pgbl-add--kda')) {
      usedRows.add(row)
      continue
    }
    if (row.__pgblBtn) row.__pgblBtn.remove()

    usedRows.add(row)
    usedKeys.add(picked.item.key)

    const player = { ...picked.occurrence, championId: championId || picked.occurrence.championId }
    const button = createAddButton(player, {
      blacklisted: !!isBlacklisted?.(player),
      onClick: onAdd,
    })
    row.__pgblBtn = button

    // 统一停在 KDA 单元格左侧
    dockNearKda(row, button)
    injected++
  }

  return { injected, matched }
}

/**
 * @param {Object} options
 * @param {Array} options.players   名单记录（可带 gameId / championId / platformId）
 * @param {Object} [options.self]   自己的 PlayerRef，用于排除
 * @param {(player: Object) => boolean} [options.isBlacklisted]
 * @param {(player: Object, anchor: Element) => void} options.onAdd
 * @param {ParentNode} [options.root]
 * @returns {number} 本次新注入的按钮数量
 */
export function scanAndInject({ players = [], self = null, isBlacklisted, onAdd, root = document } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0

  const items = buildItems(players, self)

  // 清掉已经失效的按钮（行被 React 重绘后元素断开）
  pruneDetachedButtons()

  // 历史战绩页：优先按 .player-history-mode 的名字节点注入（按钮跟在名字后面）
  const named = scanNameNodes({ root, items, self, isBlacklisted, onAdd })
  if (named.matched > 0) return named.injected

  // 新版结算页（没有名字节点）：按 KDA 文本定位
  if (items.length) {
    const kda = scanKdaRows({ root, items, isBlacklisted, onAdd })
    if (kda.matched > 0) return kda.injected
  }

  const icons = root.querySelectorAll(ICON_SELECTOR)
  if (!icons.length) return 0

  let layoutDetected = false
  for (const icon of icons) {
    const rect = rectOf(icon)
    if (rect && (rect.width > 0 || rect.height > 0)) {
      layoutDetected = true
      break
    }
  }

  const usedRows = new Set()
  const usedKeys = new Set()
  let injected = 0

  for (const icon of icons) {
    if (injected >= MAX_BUTTONS) break
    if (icon.closest && icon.closest('#pgbl-root, .pgbl-root')) continue

    const championId = championIdOf(icon)
    let target = null

    for (const row of rowCandidates(icon)) {
      if (usedRows.has(row)) continue
      if (row.querySelector(`.${ADD_BUTTON_CLASS}`)) {
        usedRows.add(row)
        continue
      }

      const nameInfo = nameFromRow(row)
      if (nameInfo && CARD_PATTERN.test(cleanText(row.textContent))) {
        // 列表卡片上的"模式名"不要被当成玩家名
        usedRows.add(row)
        continue
      }

      const match = nameInfo
        ? pickItem(normalizeText(nameInfo.name), championId, items)
        : pickItem(rowTextOf(row), championId, items)
      const record = match ? match.occurrence : null

      if (!nameInfo && !record) continue
      target = { row, nameInfo, record }
      break
    }

    if (!target) continue
    const { row, nameInfo, record } = target

    // 只认带 KDA 的对局行，避免把选人页的英雄条当成玩家行
    const rowText = cleanText(row.textContent)
    if (!KDA_PATTERN.test(rowText)) {
      usedRows.add(row)
      continue
    }

    const identity = record || (nameInfo ? { gameName: nameInfo.name, name: nameInfo.name } : null)
    if (!identity) continue
    if (isSelfRecord(identity, self)) {
      usedRows.add(row)
      continue
    }

    const key = record
      ? record.puuid
        ? `p:${record.puuid}|${normalizeText(displayNameOf(record))}`
        : record.summonerId
          ? `s:${record.summonerId}|${normalizeText(displayNameOf(record))}`
          : `n:${normalizeText(displayNameOf(record))}`
      : `n:${normalizeText(nameInfo.name)}`
    if (usedKeys.has(key)) continue

    usedRows.add(row)
    usedKeys.add(key)

    const player = record
      ? {
          ...record,
          championId: championId || record.championId,
          name: nameInfo ? nameInfo.name : record.name,
        }
      : {
          gameName: nameInfo.name,
          name: nameInfo.name,
          championId,
          gameId: 0,
          region: '',
          source: 'match-history',
        }

    const blacklisted = !!isBlacklisted?.(player)
    const button = createAddButton(player, { blacklisted, onClick: onAdd })

    // 有名字节点时也统一停靠在行尾最右侧
    dockToRowEnd(row, button)

    injected++
  }

  return injected
}

/** 清掉同一行上的其它按钮，保证一行只有一个。 */
function removeButtonsForRow(row, except) {
  for (const el of document.querySelectorAll(`.${ADD_BUTTON_CLASS}`)) {
    if (el === except) continue
    if (el.__pgblRow === row) el.remove()
  }
}

/** 清掉行已经不在文档里、或者已经被隐藏的按钮。 */
export function pruneDetachedButtons(root = document) {
  // 只有真实客户端才做"隐藏"判断（jsdom 里所有元素尺寸都是 0）
  const layoutReady =
    typeof window !== 'undefined' && typeof window.__llver !== 'undefined' && (window.innerWidth || 0) > 0

  for (const button of root.querySelectorAll(`.${ADD_BUTTON_CLASS}`)) {
    const row = button.__pgblRow
    if (!row || !row.isConnected) {
      button.remove()
      continue
    }
    if (!layoutReady) continue
    try {
      const rect = row.getBoundingClientRect()
      if (!rect.width && !rect.height) button.remove()
    } catch (_) {
      /* ignore */
    }
  }
}

/** 清掉页面上全部注入按钮（插件加载 / 重扫时用）。 */
export function removeInjectedButtons(root = document) {
  const buttons = root.querySelectorAll(`.${ADD_BUTTON_CLASS}`)
  for (const button of buttons) button.remove()
  return buttons.length
}

/** 诊断：把页面上每一行"看到了什么"列出来。 */
export function inspectRows(root = document, limit = 40) {
  const icons = Array.from(root.querySelectorAll(ICON_SELECTOR)).slice(0, limit)

  if (!icons.length) {
    // 没有头像的页面（新版结算）：按 KDA 文本报告
    const out = []
    for (const cell of root.querySelectorAll('div, span')) {
      if (out.length >= limit) break
      if (cell.childElementCount) continue
      if (!KDA_CELL.test((cell.textContent || '').trim())) continue
      const row = cell.parentElement
      out.push({
        champion: 0,
        src: '',
        levels: 0,
        name: '',
        text: row ? (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        button: !!row?.querySelector(`.${ADD_BUTTON_CLASS}`),
      })
    }
    return out
  }

  return icons.map((icon) => {
    const rows = rowCandidates(icon)
    const row = rows[rows.length - 1] || null
    const nameInfo = row ? nameFromRow(row) : null
    return {
      champion: championIdOf(icon),
      src: String(iconSource(icon)).slice(-40),
      levels: rows.length,
      name: nameInfo ? nameInfo.name : '',
      text: row ? (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      button: rows.some((candidate) => candidate.querySelector(`.${ADD_BUTTON_CLASS}`)),
    }
  })
}
