/**
 * 私密提醒卡。
 *
 * 选人阶段只在**你自己的客户端**里显示，不会发送到聊天，
 * 队友和对手都看不到。分两组：
 *   🔴 黑名单（原因）
 *   🔵 最近遇到过（第几局前 / 队友还是对手 / 上次用的英雄）
 *
 * 点击卡片打开面板，几秒后自动收起。
 */

import { h, ensureRoot } from '../dom.js'
import { entryDisplayName } from '../store.js'
import { gamesAgoText, teamText } from '../encounters.js'

const MAX_LINES = 3

function splitInput(input) {
  if (Array.isArray(input)) return { blacklist: input, familiar: [] }
  if (input && typeof input === 'object') {
    return {
      blacklist: Array.isArray(input.blacklist) ? input.blacklist : [],
      familiar: Array.isArray(input.familiar) ? input.familiar : [],
    }
  }
  return { blacklist: [], familiar: [] }
}

/** 熟人那行的补充信息：3 局前队友 · 亚索 */
export function familiarMetaText(item) {
  if (!item) return ''
  const parts = []
  const ago = gamesAgoText(item.gamesAgo)
  if (ago) parts.push(`${ago}${teamText(item.lastTeam)}`)
  const champion = item.lastChampionName || (item.lastChampionId ? `#${item.lastChampionId}` : '')
  if (champion) parts.push(champion)
  return parts.join(' · ')
}

export function createPrivateHint({ onClick, position = {}, duration = 12_000 } = {}) {
  const titleEl = h('span', { class: 'pgbl-hint__title', text: '本局提醒' })
  const countEl = h('span', { class: 'pgbl-hint__count', text: '' })
  const listEl = h('div', { class: 'pgbl-hint__list' })
  const moreEl = h('div', { class: 'pgbl-hint__more' })
  const footerEl = h('div', { class: 'pgbl-hint__footer', text: '仅自己可见 · 点击查看详情' })

  const closeButton = h('button', {
    class: 'pgbl-hint__close',
    type: 'button',
    title: '收起',
    text: '×',
    onclick: (event) => {
      event.preventDefault()
      event.stopPropagation()
      hide()
    },
  })

  const card = h(
    'div',
    {
      class: 'pgbl-hint',
      attrs: { role: 'status', 'aria-live': 'polite' },
      style: {
        top: `${Number(position.top) || 76}px`,
        right: `${Number(position.right) || 12}px`,
      },
      onclick: (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick?.()
      },
    },
    h(
      'div',
      { class: 'pgbl-hint__head' },
      h('span', { class: 'pgbl-hint__icon', text: '🛡' }),
      titleEl,
      countEl,
      closeButton,
    ),
    listEl,
    moreEl,
    footerEl,
  )

  ensureRoot().appendChild(card)

  let timer = null
  let visible = false

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function hide() {
    clearTimer()
    if (!visible) return
    visible = false
    card.classList.remove('pgbl-hint--in')
    card.style.display = 'none'
  }

  function blacklistRow(hit) {
    return h(
      'div',
      { class: 'pgbl-hint__row pgbl-hint__row--danger' },
      h('span', { class: 'pgbl-hint__dot pgbl-hint__dot--danger' }),
      h('span', { class: 'pgbl-hint__name', text: entryDisplayName(hit.entry) }),
      h('span', { class: 'pgbl-hint__reason', text: hit.entry.reason || '黑名单玩家' }),
    )
  }

  function familiarRow(item) {
    const meta = familiarMetaText(item)
    return h(
      'div',
      { class: 'pgbl-hint__row pgbl-hint__row--familiar' },
      h('span', { class: 'pgbl-hint__dot pgbl-hint__dot--familiar' }),
      h('span', { class: 'pgbl-hint__name', text: entryDisplayName(item.player) }),
      h('span', { class: 'pgbl-hint__reason pgbl-hint__reason--familiar', text: meta }),
    )
  }

  /**
   * @param {Array|{blacklist: Array, familiar: Array}} input
   */
  function show(input) {
    const { blacklist, familiar } = splitInput(input)
    const total = blacklist.length + familiar.length

    if (!total) {
      hide()
      return
    }

    listEl.textContent = ''
    const rows = [...blacklist.map(blacklistRow), ...familiar.map(familiarRow)]
    for (const row of rows.slice(0, MAX_LINES)) listEl.appendChild(row)

    const rest = rows.length - MAX_LINES
    moreEl.textContent = rest > 0 ? `还有 ${rest} 人未显示` : ''
    moreEl.style.display = rest > 0 ? '' : 'none'
    countEl.textContent = String(total)

    card.style.display = ''
    // 同步加显示类：客户端里 requestAnimationFrame 可能被节流，
    // 卡片会卡在 opacity:0 —— 看不见却挡住下面的点击
    void card.offsetWidth
    card.classList.add('pgbl-hint--in')

    visible = true
    clearTimer()
    if (duration > 0 && Number.isFinite(duration)) {
      timer = setTimeout(() => hide(), duration)
    }
  }

  return {
    el: card,
    show,
    hide,
    isVisible: () => visible,
    destroy() {
      clearTimer()
      card.remove()
    },
  }
}
