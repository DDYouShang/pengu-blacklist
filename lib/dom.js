/**
 * DOM 小工具。
 *
 * 注意：这里只用到最基础的 DOM API（createElement / textContent），
 * 目的是在 jsdom 里也能跑测试。
 */

/** 归一化文本：全角转半角、去掉双向隔离符/零宽字符与所有空白、小写。 */
export function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

/** 展示用的"干净文本"：去掉不可见控制符，但保留空格和大小写。 */
export function cleanText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 极简 h()，替代 innerHTML —— 召唤师名字/拉黑原因都是用户数据，
 * 用 textContent 拼装可以彻底避免 XSS。
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)

  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue

      if (key === 'class' || key === 'className') {
        el.className = value
      } else if (key === 'text') {
        el.textContent = String(value)
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value)
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(el.dataset, value)
      } else if (key === 'attrs' && typeof value === 'object') {
        for (const [attr, attrValue] of Object.entries(value)) {
          if (attrValue !== undefined && attrValue !== null) {
            el.setAttribute(attr, String(attrValue))
          }
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (key in el) {
        try {
          el[key] = value
        } catch (_) {
          el.setAttribute(key, String(value))
        }
      } else {
        el.setAttribute(key, String(value))
      }
    }
  }

  appendChildren(el, children)
  return el
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) {
      appendChildren(el, child)
    } else if (child instanceof Node) {
      el.appendChild(child)
    } else {
      el.appendChild(document.createTextNode(String(child)))
    }
  }
}

/** 页面是否真的有布局（jsdom 里没有，尺寸判断要跳过）。 */
export function hasLayout() {
  try {
    return !!(typeof document !== 'undefined' && document.body && document.body.getBoundingClientRect().width > 0)
  } catch (_) {
    return false
  }
}

/** 元素是否可见（jsdom 里 getBoundingClientRect 恒为 0，所以测试里会跳过尺寸判断）。 */
export function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false
  if (!el.isConnected) return false

  const rect = el.getBoundingClientRect()
  // 宽高都为 0 的元素基本是隐藏的；但 jsdom 没有布局，所以只在有真实布局时判断
  if (rect && (rect.width === 0 || rect.height === 0)) {
    const hasLayout = typeof el.getClientRects === 'function' && el.getClientRects().length > 0
    if (hasLayout) return false
  }

  const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false
    }
    if (style.opacity === '0') return false
  }

  return true
}

/** 向上找最近的匹配祖先，找不到返回 null。 */
export function closest(el, selector) {
  if (!el || typeof el.closest !== 'function') return null
  try {
    return el.closest(selector)
  } catch (_) {
    return null
  }
}

/** 确保页面里存在插件自己的根节点，并把它移到 body 末尾（保证画在最上层）。 */
export function ensureRoot(id = 'pgbl-root') {
  let root = document.getElementById(id)
  const parent = document.body || document.documentElement
  if (!root) {
    root = document.createElement('div')
    root.id = id
    root.className = 'pgbl-root'
  }
  // 客户端可能不断往 body 里追加自己的浮层，重新 append 一次确保我们最后绘制
  if (root.parentElement !== parent || parent.lastElementChild !== root) parent.appendChild(root)
  return root
}
