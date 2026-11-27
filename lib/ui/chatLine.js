/**
 * 聊天框内的本地提示行。
 *
 * 不发送任何聊天消息：只是把一行"长得像聊天记录"的提示浮在聊天输入框上方，
 * 队友/对手都看不到（它只存在于你自己的客户端 DOM 里）。
 */

import { h } from '../dom.js'

const LINE_CLASS = 'pgbl-chat-line'
const TAG_TEXT = '黑名单'

function findChatInput() {
  const nodes = document.querySelectorAll('textarea')
  for (const el of nodes) {
    const rect = el.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 8) continue
    // 排除插件自己的输入框
    if (el.closest && el.closest('#pgbl-root')) continue
    return el
  }
  return null
}

function buildLine(text) {
  return h(
    'div',
    { class: `${LINE_CLASS} ${LINE_CLASS}--float`, attrs: { 'data-pgbl-chat': '1' } },
    h('span', { class: 'pgbl-chat-line__tag', text: TAG_TEXT }),
    h('span', { class: 'pgbl-chat-line__text', text }),
  )
}

/**
 * 在聊天输入框上方显示一行本地提示。
 * @param {string} text
 * @returns {boolean} 是否成功显示（找不到聊天框时返回 false）
 */
export function showChatLine(text) {
  const input = findChatInput()
  if (!input) return false

  const rect = input.getBoundingClientRect()
  if (!rect.width || !rect.height) return false

  let line = document.querySelector(`.${LINE_CLASS}`)
  if (!line) {
    line = buildLine(text)
    document.documentElement.appendChild(line)
  } else {
    const textEl = line.querySelector('.pgbl-chat-line__text')
    if (textEl) textEl.textContent = text
  }

  line.style.left = `${Math.round(rect.left)}px`
  line.style.width = `${Math.round(rect.width)}px`
  line.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`
  line.style.display = ''
  return true
}

export function hideChatLine() {
  for (const line of document.querySelectorAll(`.${LINE_CLASS}`)) line.remove()
}
