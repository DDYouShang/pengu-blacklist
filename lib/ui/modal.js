/**
 * 通用模态框。同一时间只允许一个。
 */

import { h, ensureRoot } from '../dom.js'

let active = null

export function closeActiveModal() {
  if (active) active.close()
}

/**
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {HTMLElement} [options.body]
 * @param {HTMLElement} [options.footer]
 * @param {number} [options.width]
 * @param {() => void} [options.onClose]
 */
export function openModal({ title, subtitle, body, footer, width = 600, onClose } = {}) {
  closeActiveModal()

  const root = ensureRoot()
  const overlay = h('div', { class: 'pgbl-overlay' })
  const dialog = h('div', {
    class: 'pgbl-modal',
    style: { width: `${width}px` },
    attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
  })

  const titleEl = h('h2', { class: 'pgbl-modal__title', text: title || '黑名单' })
  const subtitleEl = subtitle ? h('p', { class: 'pgbl-modal__subtitle', text: subtitle }) : null

  const closeButton = h('button', {
    class: 'pgbl-iconbtn',
    type: 'button',
    title: '关闭',
    text: '×',
    onclick: (event) => {
      // 面板右上角可能正好压在入口按钮/客户端按钮上，别让点击继续传播
      event.preventDefault()
      event.stopPropagation()
      close()
    },
  })

  dialog.appendChild(
    h(
      'header',
      { class: 'pgbl-modal__header' },
      h('div', { class: 'pgbl-modal__titles' }, titleEl, subtitleEl),
      closeButton,
    ),
  )

  const content = h('div', { class: 'pgbl-modal__body' })
  if (body) content.appendChild(body)
  dialog.appendChild(content)

  if (footer) dialog.appendChild(h('footer', { class: 'pgbl-modal__footer' }, footer))

  overlay.appendChild(dialog)
  root.appendChild(overlay)

  let closed = false
  function close() {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    overlay.style.pointerEvents = 'none'
    overlay.classList.remove('pgbl-overlay--open')
    overlay.classList.add('pgbl-overlay--closing')
    setTimeout(() => overlay.remove(), 120)
    if (active && active.overlay === overlay) active = null
    try {
      onClose?.()
    } catch (_) {
      /* ignore */
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      if (event.target?.matches?.('[role="combobox"][aria-expanded="true"]')) return
      event.stopPropagation()
      event.preventDefault()
      close()
    }
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })

  // 阻止点击穿透到客户端界面
  dialog.addEventListener('mousedown', (event) => event.stopPropagation())
  dialog.addEventListener('click', (event) => event.stopPropagation())

  document.addEventListener('keydown', onKeydown, true)

  const handle = {
    overlay,
    dialog,
    body: content,
    close,
    setTitle(text) {
      titleEl.textContent = text
    },
  }
  active = handle

  // 同步加上显示类（不依赖 requestAnimationFrame，客户端里 rAF 可能被节流，
  // 那样弹窗会一直停在 opacity:0，看起来就是"点了没反应"）
  void overlay.offsetWidth
  overlay.classList.add('pgbl-overlay--open')
  overlay.style.pointerEvents = 'auto'
  try {
    dialog.focus()
  } catch (_) {
    /* ignore */
  }

  return handle
}
