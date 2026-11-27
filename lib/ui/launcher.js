/**
 * 可拖动的黑名单入口。
 *
 * 关闭提示框之后，点它就能重新打开黑名单面板。
 */

import { h, ensureRoot } from '../dom.js'

const DRAG_THRESHOLD = 5
const LAUNCHER_OWNER = Symbol.for('pengu.blacklist.launcher')

function offset(value, fallback) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? number : fallback
}

export function createLauncher({ onClick, onPositionChange, position = {}, title = '黑名单' } = {}) {
  window[LAUNCHER_OWNER]?.destroy()
  let preferred = { top: offset(position.top, 44), right: offset(position.right, 12) }
  let visible = false
  let gesture = null
  let suppressClick = false

  function openPanel() {
    try {
      onClick?.()
    } catch (err) {
      console.error('[PenguBlacklist] 打开面板失败:', err)
    }
  }

  const countEl = h('span', { class: 'pgbl-launcher__count', text: '0' })
  const button = h(
    'button',
    {
      class: 'pgbl-launcher',
      type: 'button',
      title: '打开黑名单（Alt+B），按住可拖动',
      attrs: { 'aria-label': title, 'data-pgbl-launcher-current': '' },
      style: {
        top: `${preferred.top}px`,
        right: `${preferred.right}px`,
      },
    },
    h('span', { class: 'pgbl-launcher__icon', text: '🛡' }),
    h('span', { class: 'pgbl-launcher__label', text: title }),
    countEl,
  )

  button.style.display = 'none'

  function place({ top, right }) {
    const maxTop = Math.max(0, window.innerHeight - button.offsetHeight)
    const maxRight = Math.max(0, window.innerWidth - button.offsetWidth)
    const placed = {
      top: Math.round(Math.min(maxTop, Math.max(0, top))),
      right: Math.round(Math.min(maxRight, Math.max(0, right))),
    }
    button.style.top = `${placed.top}px`
    button.style.right = `${placed.right}px`
    return placed
  }

  function resize() {
    if (visible && !gesture) place(preferred)
  }

  function hitBounds(event) {
    if (!visible || !button.isConnected) return null
    if (document.querySelector('.pgbl-overlay--open:not(.pgbl-overlay--closing)')) return null
    const rect = button.getBoundingClientRect()
    if (button.contains(event.target)) return rect
    // 客户端的装饰层可能盖在按钮上。保留位置命中，跳过插件自己的互动控件。
    if (event.target?.closest?.('.pgbl-modal, .pgbl-hint, .pgbl-overlay--open, .pgbl-launcher')) return null
    if (rect.width && rect.height && event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom) return rect
    return null
  }

  function mouseDown(event) {
    if (event.button !== 0) return
    suppressClick = false
    cancelGesture()
    const rect = hitBounds(event)
    if (!rect) return
    gesture = {
      x: event.clientX, y: event.clientY,
      top: button.offsetTop, right: window.innerWidth - rect.right,
      position: null,
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function mouseMove(event) {
    if (!gesture) return
    if (!(event.buttons & 1)) {
      cancelGesture()
      return
    }
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    if (!gesture.position && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    button.classList.add('is-dragging')
    gesture.position = place({ top: gesture.top + dy, right: gesture.right - dx })
    event.preventDefault()
    event.stopPropagation()
  }

  function cancelGesture() {
    if (!gesture) return
    gesture = null
    button.classList.remove('is-dragging')
    resize()
  }

  function mouseUp(event) {
    if (!gesture || event.button !== 0) return
    const { position } = gesture
    gesture = null
    button.classList.remove('is-dragging')
    suppressClick = true
    event.preventDefault()
    event.stopPropagation()
    if (position) {
      preferred = position
      onPositionChange?.(preferred)
      return
    }
    if (hitBounds(event)) openPanel()
  }

  function captureClick(event) {
    if (suppressClick && event.detail) {
      suppressClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!event.detail && !button.contains(event.target)) return
    if (!hitBounds(event)) return
    event.preventDefault()
    event.stopPropagation()
    openPanel()
  }

  const handlers = {
    mousedown: mouseDown, mousemove: mouseMove, mouseup: mouseUp,
    click: captureClick, blur: cancelGesture, resize,
  }
  for (const [event, handler] of Object.entries(handlers)) window.addEventListener(event, handler, true)

  const launcher = {
    el: button,
    isCurrent() {
      return window[LAUNCHER_OWNER] === launcher
    },
    attach() {
      if (!this.isCurrent()) return false
      for (const other of document.querySelectorAll('.pgbl-launcher')) {
        if (other !== button) other.remove()
      }
      if (!button.isConnected) ensureRoot().appendChild(button)
      return true
    },
    setCount(count) {
      const value = Number(count) || 0
      countEl.textContent = String(value)
      countEl.style.display = value > 0 ? '' : 'none'
      button.classList.toggle('has-hits', value > 0)
      resize()
    },
    /** 分开显示黑名单与熟人：有黑名单保持红色，只有熟人时用蓝色。 */
    setHits({ blacklist = 0, familiar = 0 } = {}) {
      const red = Number(blacklist) || 0
      const blue = Number(familiar) || 0
      this.setCount(red + blue)
      button.classList.toggle('has-hits', red > 0)
      button.classList.toggle('has-familiar', red === 0 && blue > 0)
    },
    show() {
      if (visible) return
      visible = true
      button.style.display = ''
      button.classList.add('pgbl-launcher--in')
      resize()
    },
    hide() {
      if (!visible) return
      cancelGesture()
      visible = false
      button.style.display = 'none'
      button.classList.remove('pgbl-launcher--in')
    },
    isVisible() {
      return visible
    },
    setPosition(position) {
      cancelGesture()
      preferred = { top: offset(position?.top, 44), right: offset(position?.right, 12) }
      resize()
    },
    destroy() {
      cancelGesture()
      for (const [event, handler] of Object.entries(handlers)) window.removeEventListener(event, handler, true)
      visible = false
      button.remove()
      if (this.isCurrent()) delete window[LAUNCHER_OWNER]
    },
  }
  window[LAUNCHER_OWNER] = launcher
  launcher.attach()
  return launcher
}
