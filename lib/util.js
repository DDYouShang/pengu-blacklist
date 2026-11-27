/**
 * 通用小工具。
 *
 * 这个文件不依赖 DOM，也不依赖 LCU，方便在 Node 里直接测试。
 */

export const LOG_PREFIX = '[PenguBlacklist]'

export function log(...args) {
  try {
    console.log(LOG_PREFIX, ...args)
  } catch (_) {
    /* ignore */
  }
}

export function warn(...args) {
  try {
    console.warn(LOG_PREFIX, ...args)
  } catch (_) {
    /* ignore */
  }
}

/**
 * 执行一个函数，吞掉异常（插件里到处都在跑 LCU 请求和 DOM 操作，
 * 任何一处出错都不应该把整个客户端搞挂）。
 */
export function safe(fn, fallback) {
  try {
    return fn()
  } catch (err) {
    warn('safe() caught:', err)
    return fallback
  }
}

export function isPromiseLike(value) {
  return !!value && typeof value.then === 'function'
}

/** 防抖，返回的函数带 cancel / flush。 */
export function debounce(fn, wait = 200) {
  let timer = null
  let lastArgs = []

  const wrapped = (...args) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...lastArgs)
    }, wait)
  }

  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
      fn(...lastArgs)
    }
  }

  return wrapped
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 只执行一次。 */
export function once(fn) {
  let called = false
  let result
  return (...args) => {
    if (called) return result
    called = true
    result = fn(...args)
    return result
  }
}

export function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 把各种时间值（毫秒时间戳 / 秒级时间戳 / ISO 字符串 / Date）统一成毫秒时间戳。
 * 解析不出来时返回 0。
 */
export function toTimestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳（10 位）自动补齐
    return value > 0 && value < 1e11 ? Math.round(value * 1000) : value
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return toTimestamp(asNumber)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** 格式化成 "2026-11-07 18:50"，本地时区。 */
export function formatDateTime(value) {
  const ts = toTimestamp(value)
  if (!ts) return '未知时间'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '未知时间'
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

/** "3 分钟前" / "2 天前" 之类的相对时间。 */
export function formatRelative(value, now = Date.now()) {
  const ts = toTimestamp(value)
  if (!ts) return ''
  const diff = now - ts
  if (diff < 0) return '刚刚'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return formatDateTime(ts)
}

/** 截断文本，避免把超长名字塞进 UI。 */
export function truncate(value, max = 40) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 安全地读取对象深层属性：get(obj, 'a.b.c', fallback) */
export function getPath(obj, path, fallback) {
  if (!obj) return fallback
  const parts = String(path).split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return fallback
    current = current[part]
  }
  return current === undefined ? fallback : current
}

/** 把可能是单个值也可能是数组的东西统一成数组。 */
export function toArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

/**
 * 简单的串行队列：保证同一时间只有一个写盘 / 一个 UI 操作在跑。
 * 出错不会卡死队列。
 */
export function createQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const run = tail.then(() => task())
    tail = run.catch(() => {})
    return run
  }
}
