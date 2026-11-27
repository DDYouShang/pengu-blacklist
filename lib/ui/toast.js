/**
 * 通知：优先用 Pengu 的 Toast，没有就退回 console。
 */

/**
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} [type]
 */
export function notify(message, type = 'info') {
  const toast = typeof window !== 'undefined' ? window.Toast : null
  if (toast) {
    // Pengu 1.1.x 只有 success / error，1.2+ 才有 info / warning
    const fn = toast[type] || toast.info || toast.success || toast.error
    if (typeof fn === 'function') {
      try {
        fn.call(toast, message, { position: 'top-right', duration: 4200, id: 'pgbl-toast' })
        return
      } catch (_) {
        /* 继续走 fallback */
      }
    }
  }
  try {
    console.log('[黑名单]', message)
  } catch (_) {
    /* ignore */
  }
}
