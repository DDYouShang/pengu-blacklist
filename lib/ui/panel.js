/**
 * 黑名单面板：本局命中提醒 + 黑名单管理。
 *
 * "进入游戏后弹出提示框"和"右上角重新打开"用的都是这个面板。
 */

import { h } from '../dom.js'
import { formatDateTime } from '../util.js'
import { parseRiotId } from '../model.js'
import { entryDisplayName } from '../store.js'
import { gamesAgoText, teamText } from '../encounters.js'
import { openModal } from './modal.js'
import { createChampionPicker } from './championPicker.js'
import { createSettings } from './settings.js'

function badge(text, variant = '') {
  return h('span', { class: `pgbl-tag${variant ? ` pgbl-tag--${variant}` : ''}`, text })
}

function emptyState(text, hint) {
  return h(
    'div',
    { class: 'pgbl-empty' },
    h('div', { class: 'pgbl-empty__icon', text: '🛡' }),
    h('div', { class: 'pgbl-empty__title', text }),
    hint ? h('div', { class: 'pgbl-empty__hint', text: hint }) : null,
  )
}

function championText(championId, championName, resolveChampionName, className = '') {
  const text = championName || (championId ? `英雄 #${championId}` : '未记录')
  const value = h('span', { class: className, text })
  if (!championName && championId) {
    void resolveChampionName(championId).then((name) => {
      if (name) value.textContent = name
    })
  }
  return value
}

function featuredChampion(label, championId, championName, resolveChampionName) {
  const recorded = championId || championName
  const name = championText(championId, championName, resolveChampionName, 'pgbl-card__champion-name')
  const portrait = championId
    ? h('img', {
        class: 'pgbl-card__portrait',
        attrs: { src: `/lol-game-data/assets/v1/champion-icons/${championId}.png`, alt: '', width: 32, height: 32 },
        onerror: (event) => event.currentTarget.remove(),
      })
    : null

  return h(
    'div',
    { class: `pgbl-card__champion-history${recorded ? '' : ' pgbl-card__champion-history--empty'}` },
    h('span', { class: 'pgbl-card__champion-label', text: label }),
    recorded ? h('div', { class: 'pgbl-card__champion' }, portrait, name) : name,
  )
}

function currentChampion(championId, championName, resolveChampionName) {
  if (!championId && !championName) return null
  return featuredChampion('本局英雄', championId, championName, resolveChampionName)
}

function hitCard(hit, resolveChampionName) {
  const { player, entry } = hit
  const currentId = player.championId
  const currentName = currentId && currentId === hit.championId ? hit.championName : ''
  const meta = [
    entry.gameId ? `对局 ${entry.gameId}` : '',
  ]
    .filter(Boolean)
    .join('  ·  ')

  return h(
    'article',
    { class: 'pgbl-card pgbl-card--hit' },
    h(
      'div',
      { class: 'pgbl-card__head' },
      h('span', { class: 'pgbl-card__name', text: entryDisplayName(entry) }),
      badge('黑名单', 'danger'),
    ),
    h(
      'div',
      { class: 'pgbl-card__champions' },
      featuredChampion('拉黑时的英雄', entry.championId, entry.championName, resolveChampionName),
      currentChampion(currentId, currentName, resolveChampionName),
    ),
    h('div', { class: 'pgbl-card__reason', text: entry.reason || '（未填写原因）' }),
    h(
      'div',
      { class: 'pgbl-card__meta' },
      h('span', { text: meta }),
      h('span', { class: 'pgbl-card__time', text: `拉黑于 ${formatDateTime(entry.createdAt)}` }),
    ),
  )
}

/** 最近遇到过的玩家：第几局前 / 队友对手 / 上次和本局用的英雄。 */
function familiarCard(item, { onBlacklist, resolveChampionName }) {
  const { player } = item

  return h(
    'article',
    { class: 'pgbl-card pgbl-card--familiar' },
    h(
      'div',
      { class: 'pgbl-card__head' },
      h('span', { class: 'pgbl-card__name', text: entryDisplayName(player) }),
      badge(gamesAgoText(item.gamesAgo), 'info'),
      badge(teamText(item.lastTeam), item.lastTeam === 'ally' ? 'ally' : 'enemy'),
      item.seenCount > 1 ? badge(`共 ${item.seenCount} 次`) : null,
    ),
    h(
      'div',
      { class: 'pgbl-card__champions' },
      featuredChampion('上次遇到时的英雄', item.lastChampionId, item.lastChampionName, resolveChampionName),
      currentChampion(player.championId, item.currentChampionName, resolveChampionName),
    ),
    item.isTest ? null : h(
      'div',
      { class: 'pgbl-card__actions' },
      h('button', {
        class: 'pgbl-linkbtn',
        type: 'button',
        text: '拉黑',
        onclick: () => onBlacklist?.(item),
      }),
    ),
  )
}

function entryCard(entry, { onEdit, onRemove, resolveChampionName }) {
  return h(
    'article',
    { class: 'pgbl-card' },
    h(
      'div',
      { class: 'pgbl-card__head' },
      h('span', { class: 'pgbl-card__name', text: entryDisplayName(entry) }),
    ),
    featuredChampion('拉黑时的英雄', entry.championId, entry.championName, resolveChampionName),
    h('div', { class: 'pgbl-card__reason', text: entry.reason || '（未填写原因）' }),
    h(
      'div',
      { class: 'pgbl-card__meta' },
      h('span', { text: entry.gameId ? `对局 ${entry.gameId}` : '对局未知' }),
      h('span', { class: 'pgbl-card__time', text: formatDateTime(entry.createdAt) }),
    ),
    h(
      'div',
      { class: 'pgbl-card__actions' },
      h('button', {
        class: 'pgbl-linkbtn',
        type: 'button',
        text: '修改',
        onclick: () => onEdit(entry),
      }),
      h('button', {
        class: 'pgbl-linkbtn pgbl-linkbtn--danger',
        type: 'button',
        text: '删除',
        onclick: () => onRemove(entry),
      }),
    ),
  )
}

function downloadJson(text) {
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = h('a', {
      href: url,
      download: `lol-blacklist-${new Date().toISOString().slice(0, 10)}.json`,
      style: { display: 'none' },
    })
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  } catch (_) {
    return false
  }
}

/**
 * @param {Object} options
 * @param {Array<{player: Object, entry: Object}>} options.hits
 * @param {Object} options.store
 * @param {string} [options.gameInfo]  例如 "对局 123456 · 艾欧尼亚（HN1）"
 * @param {(entry: Object) => void} [options.onEdit]
 * @param {(entry: Object) => void} [options.onRemove]
 * @param {(id: number) => Promise<string>} [options.getChampionName]
 * @param {() => Promise<Array<Object>>} [options.getChampions]
 * @param {(message: string) => void} [options.notify]
 * @param {() => void} [options.onClose]
 */
export function openHitsPanel({
  hits = [],
  familiar = [],
  getAlerts = () => ({ hits, familiar }),
  settings,
  store,
  gameInfo = '',
  onEdit,
  onRemove,
  onBlacklist,
  getChampionName,
  getChampions,
  notify,
  onClose,
  autoCloseMs = 0,
} = {}) {
  const totalHits = () => {
    const alerts = getAlerts()
    return alerts.hits.length + alerts.familiar.length
  }
  let tab = totalHits() ? 'hits' : 'manage'
  let keyword = ''
  let addForm = null
  let settingsForm = null
  const championNames = new Map()

  function resolveChampionName(id) {
    if (!championNames.has(id)) {
      championNames.set(id, Promise.resolve().then(() => getChampionName?.(id)).catch(() => ''))
    }
    return championNames.get(id)
  }

  const tabsEl = h('div', { class: 'pgbl-tabs' })
  let hitBadge = null
  const contentEl = h('div', { class: 'pgbl-panel-content' })
  const searchEl = h('input', {
    class: 'pgbl-search',
    attrs: { type: 'search', placeholder: '搜索玩家名 / 原因' },
  })
  searchEl.addEventListener('input', () => {
    keyword = searchEl.value.trim().toLowerCase()
    render()
  })

  const fileInput = h('input', {
    attrs: { type: 'file', accept: '.json,application/json' },
    style: { display: 'none' },
  })
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0]
    fileInput.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const result = store.importJson(text)
      notify?.(`已导入：新增 ${result.added} 条，更新 ${result.updated} 条`)
      render()
    } catch (err) {
      notify?.(`导入失败：${err?.message || err}`)
    }
  })

  const tabs = [
    { id: 'hits', label: '本局命中', count: totalHits },
    { id: 'manage', label: '黑名单管理', count: () => store.count() },
  ]
  if (settings) tabs.push({ id: 'settings', label: '设置' })

  function renderTabs() {
    tabsEl.textContent = ''
    for (const item of tabs) {
      const count = item.count?.()
      const countEl = count === undefined ? null : h('span', { class: 'pgbl-tab__count', text: String(count) })
      if (item.id === 'hits') hitBadge = countEl
      tabsEl.appendChild(
        h(
          'button',
          {
            class: `pgbl-tab${tab === item.id ? ' is-active' : ''}`,
            type: 'button',
            onclick: () => {
              tab = item.id
              render()
            },
          },
          h('span', { text: item.label }),
          countEl,
        ),
      )
    }
  }

  function renderHits() {
    const { hits, familiar } = getAlerts()
    if (!hits.length && !familiar.length) {
      contentEl.appendChild(
        emptyState('本局暂无提醒'),
      )
      return
    }

    if (hits.length) {
      contentEl.appendChild(h('div', { class: 'pgbl-section-title', text: `黑名单 · ${hits.length}` }))
      const list = h('div', { class: 'pgbl-list' })
      for (const hit of hits) list.appendChild(hitCard(hit, resolveChampionName))
      contentEl.appendChild(list)
    }

    if (familiar.length) {
      contentEl.appendChild(h('div', { class: 'pgbl-section-title', text: `最近遇到过 · ${familiar.length}` }))
      const list = h('div', { class: 'pgbl-list' })
      for (const item of familiar) list.appendChild(familiarCard(item, { onBlacklist, resolveChampionName }))
      contentEl.appendChild(list)
    }
  }

  function buildAddForm() {
    const nameInput = h('input', {
      class: 'pgbl-search pgbl-add-form__input',
      attrs: {
        'aria-label': '完整 Riot ID',
        placeholder: '昵称#标签（必填）',
        spellcheck: 'false',
      },
    })
    const reasonInput = h('input', {
      class: 'pgbl-search pgbl-add-form__input',
      attrs: { placeholder: '拉黑原因（必填）' },
    })
    const error = h('span', { class: 'pgbl-error' })
    const championPicker = createChampionPicker(getChampions)

    for (const input of [nameInput, championPicker.input, reasonInput]) {
      input.addEventListener('input', () => { error.textContent = '' })
    }

    const submit = () => {
      const riotId = parseRiotId(nameInput.value)
      if (!riotId) {
        error.textContent = '请输入完整的昵称#标签'
        nameInput.focus()
        return
      }
      const reason = reasonInput.value.trim()
      if (!reason) {
        error.textContent = '请填写原因'
        reasonInput.focus()
        return
      }

      const { gameName, tagLine } = riotId
      const display = `${gameName}#${tagLine}`
      const champion = championPicker.selected()
      if (championPicker.input.value.trim() && !champion) {
        error.textContent = '请选择英雄或清空这一栏'
        championPicker.input.focus()
        return
      }
      const result = store.upsert({
        ...riotId,
        name: display,
        reason,
        championId: champion?.id,
        championName: champion?.name,
        source: 'manual',
      })

      if (!result.entry) {
        error.textContent = '保存失败：缺少玩家信息'
        return
      }

      notify?.(result.created ? `已添加 ${display}` : `已更新 ${display}`)
      addForm = null
      render()
    }

    for (const input of [nameInput, reasonInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          submit()
        }
      })
    }

    return h(
      'div',
      { class: 'pgbl-add-form' },
      h('div', { class: 'pgbl-add-form__row' }, nameInput, championPicker.el, reasonInput),
      h(
        'div',
        { class: 'pgbl-add-form__actions' },
        error,
        h('span', { class: 'pgbl-spacer' }),
        h('button', {
          class: 'pgbl-btn',
          type: 'button',
          text: '取消',
          onclick: () => {
            addForm = null
            render()
          },
        }),
        h('button', {
          class: 'pgbl-btn pgbl-btn--primary',
          type: 'button',
          text: '保存',
          onclick: submit,
        }),
      ),
    )
  }

  function renderManage() {
    const entries = store.all().filter((entry) => {
      if (!keyword) return true
      const haystack = `${entryDisplayName(entry)} ${entry.reason || ''} ${entry.championName || ''}`.toLowerCase()
      return haystack.includes(keyword)
    })

    contentEl.appendChild(searchEl)
    if (addForm) contentEl.appendChild(addForm)

    if (!entries.length) {
      contentEl.appendChild(
        store.count()
          ? emptyState('没有匹配的记录', '换个关键词试试')
          : emptyState('黑名单还是空的', '在历史战绩 / 结算页点"拉黑"就能添加'),
      )
      return
    }

    const list = h('div', { class: 'pgbl-list' })
    for (const entry of entries) {
      list.appendChild(
        entryCard(entry, {
          resolveChampionName,
          onEdit: (target) => onEdit?.(target),
          onRemove: (target) => {
            onRemove?.(target)
          },
        }),
      )
    }
    contentEl.appendChild(list)
  }

  function render() {
    renderTabs()
    manageActions.hidden = tab !== 'manage'
    contentEl.textContent = ''
    if (tab === 'hits') {
      renderHits()
    } else if (tab === 'manage') {
      renderManage()
    } else {
      settingsForm ||= createSettings(settings)
      contentEl.appendChild(settingsForm)
    }
  }

  function refreshAlerts() {
    hitBadge.textContent = String(totalHits())
    if (tab !== 'hits') return
    contentEl.textContent = ''
    renderHits()
  }

  const manageActions = h(
    'div',
    { class: 'pgbl-management-actions', hidden: tab !== 'manage' },
    h('button', {
      class: 'pgbl-btn pgbl-btn--ghost',
      type: 'button',
      text: '＋ 添加',
      onclick: () => {
        addForm ||= buildAddForm()
        render()
      },
    }),
    h('button', {
      class: 'pgbl-btn pgbl-btn--ghost',
      type: 'button',
      text: '导出',
      onclick: () => {
        const ok = downloadJson(store.exportJson())
        notify?.(ok ? '黑名单已导出' : '导出失败')
      },
    }),
    h('button', {
      class: 'pgbl-btn pgbl-btn--ghost',
      type: 'button',
      text: '导入',
      onclick: () => fileInput.click(),
    }),
  )

  const footer = h(
    'div',
    { class: 'pgbl-footer-actions' },
    manageActions,
    h('span', { class: 'pgbl-spacer' }),
    h('button', {
      class: 'pgbl-btn',
      type: 'button',
      text: '关闭',
      onclick: () => modal.close(),
    }),
  )

  const body = h('div', { class: 'pgbl-panel' }, tabsEl, contentEl)

  // 隐藏的 file input 必须挂在 DOM 里，否则部分 Chromium 版本点不开文件选择框
  body.appendChild(fileInput)

  let autoTimer = 0
  function clearAutoClose() {
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = 0
  }

  function armAutoClose() {
    clearAutoClose()
    const ms = Number(autoCloseMs) > 0 ? Number(autoCloseMs) : 0
    if (!ms) return
    autoTimer = setTimeout(() => modal.close(), ms)
  }

  const modal = openModal({
    title: '黑名单',
    subtitle: gameInfo || undefined,
    body,
    footer,
    width: 640,
    onClose: () => {
      clearAutoClose()
      unsubscribe?.()
      onClose?.()
    },
  })
  modal.dialog.classList.add('pgbl-modal--blacklist')

  const unsubscribe = store.onChange(() => {
    if (tab === 'manage') render()
    else if (tab === 'settings') renderTabs()
  })

  // 自动打开的面板：一段时间没人操作就收起，避免挡着客户端
  modal.overlay.addEventListener('pointerdown', armAutoClose)
  armAutoClose()

  render()
  return { ...modal, refreshAlerts }
}
