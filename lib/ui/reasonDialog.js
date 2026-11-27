/**
 * 拉黑原因弹窗。
 *
 * 玩家名字/大区/对局/角色都是自动带进来的（来自对局名单），
 * 用户只需要填写原因。
 */

import { h } from '../dom.js'
import { formatDateTime } from '../util.js'
import { displayNameOf } from '../model.js'
import { entryDisplayName } from '../store.js'
import { openModal } from './modal.js'

const QUICK_REASONS = ['挂机', '送人头', '辱骂队友', '演员', '消极游戏', '恶意抢位置', '结束时，发消息嘲讽']

function infoRow(label, value) {
  return h(
    'div',
    { class: 'pgbl-info__row' },
    h('span', { class: 'pgbl-info__label', text: label }),
    h('span', { class: 'pgbl-info__value', text: value }),
  )
}

/**
 * @param {Object} options
 * @param {Object} options.player   PlayerRef
 * @param {Object} [options.entry]  已存在的黑名单记录（此时为"修改"模式）
 * @param {Object} [options.context] { gameId, championId, championName, region, source }
 * @param {(reason: string) => void} options.onSave
 * @param {() => void} [options.onRemove]
 */
export function openReasonDialog({ player, entry, context = {}, onSave, onRemove }) {
  const editing = !!entry
  const gameId = context.gameId || (entry && entry.gameId) || 0
  const championId = context.championId || player.championId || (entry && entry.championId) || 0
  const championName = context.championName || (entry && entry.championName) || ''
  const when = entry ? entry.createdAt : Date.now()

  const name = entry ? entryDisplayName(entry) : displayNameOf(player)

  const textarea = h('textarea', {
    class: 'pgbl-textarea',
    attrs: {
      maxlength: '300',
      placeholder: '写下拉黑原因，例如：挂机送人头 / 辱骂队友 / 演员…',
      rows: '3',
    },
  })
  textarea.value = entry?.reason || ''

  const chips = h('div', { class: 'pgbl-chips' })
  for (const reason of QUICK_REASONS) {
    chips.appendChild(
      h('button', {
        class: 'pgbl-chip',
        type: 'button',
        text: reason,
        onclick: () => {
          const current = textarea.value.trim()
          textarea.value = current ? `${current}；${reason}` : reason
          textarea.focus()
          textarea.setSelectionRange(textarea.value.length, textarea.value.length)
        },
      }),
    )
  }

  const error = h('p', { class: 'pgbl-error' })

  const form = h(
    'div',
    { class: 'pgbl-form' },
    h(
      'div',
      { class: 'pgbl-player' },
      h('div', { class: 'pgbl-avatar', text: (name[0] || '?').toUpperCase() }),
      h(
        'div',
        { class: 'pgbl-player__main' },
        h('div', { class: 'pgbl-player__name', text: name }),
        h(
          'div',
          { class: 'pgbl-player__meta' },
          [
            gameId ? `对局 ${gameId}` : '',
            championName ? `角色 ${championName}` : championId ? `角色 #${championId}` : '',
          ]
            .filter(Boolean)
            .join('  ·  '),
        ),
      ),
    ),
    h(
      'div',
      { class: 'pgbl-info' },
      infoRow('对局', gameId ? String(gameId) : '未知对局'),
      infoRow('角色', championName || (championId ? `#${championId}` : '未知')),
      infoRow('拉黑时间', formatDateTime(when)),
    ),
    h('label', { class: 'pgbl-label', text: editing ? '修改拉黑原因' : '拉黑原因' }),
    textarea,
    chips,
    error,
    h('p', { class: 'pgbl-hint', text: '原因只保存在本机，选人阶段命中时会自动提醒你。' }),
  )

  const saveButton = h('button', {
    class: 'pgbl-btn pgbl-btn--primary',
    type: 'button',
    text: editing ? '保存修改' : '确认拉黑',
    onclick: () => submit(),
  })

  const footer = h(
    'div',
    { class: 'pgbl-footer-actions' },
    onRemove
      ? h('button', {
          class: 'pgbl-btn pgbl-btn--danger-ghost',
          type: 'button',
          text: '移出黑名单',
          onclick: () => {
            modal.close()
            onRemove()
          },
        })
      : null,
    h('span', { class: 'pgbl-spacer' }),
    h('button', {
      class: 'pgbl-btn',
      type: 'button',
      text: '取消',
      onclick: () => modal.close(),
    }),
    saveButton,
  )

  const modal = openModal({
    title: editing ? '修改黑名单' : '拉黑玩家',
    subtitle: '玩家信息已自动读取，只需填写原因',
    body: form,
    footer,
    width: 520,
  })

  function submit() {
    const reason = textarea.value.trim()
    if (!reason) {
      error.textContent = '请填写拉黑原因'
      textarea.focus()
      return
    }
    error.textContent = ''
    modal.close()
    onSave(reason)
  }

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  })

  requestAnimationFrame(() => textarea.focus())
  return modal
}
