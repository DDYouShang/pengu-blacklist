/**
 * 选人阶段的聊天提示。
 *
 * 聊天消息发到"英雄选择"会话（champ select chat），
 * 这条消息会跟着你进入游戏，队友在游戏内也能看到。
 */

import { lcu } from '../lcu.js'
import { warn } from '../util.js'

let cachedConversationId = ''

export function resetChatCache() {
  cachedConversationId = ''
}

function scoreConversation(conversation) {
  const type = String(conversation.type || '').toLowerCase()
  if (type.includes('champ')) return 100
  if (type === 'custom' && conversation.gameChat) return 60
  if (conversation.gameChat) return 40
  if (type === 'group') return 10
  if (type === 'custom') return 5
  return 0
}

function pickConversation(conversations) {
  const list = (Array.isArray(conversations) ? conversations : []).filter((item) => item && item.id)
  let best = null
  for (const conversation of list) {
    const score = scoreConversation(conversation)
    if (score > 0 && (!best || score > best.score)) best = { conversation, score }
  }
  return best ? best.conversation : null
}

export async function findChampSelectConversation({ force = false } = {}) {
  if (!force && cachedConversationId) return cachedConversationId
  const conversations = await lcu.get('/lol-chat/v1/conversations')
  const conversation = pickConversation(conversations)
  if (!conversation) return ''
  cachedConversationId = conversation.id
  return cachedConversationId
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendChampSelectMessage(text) {
  const body = String(text || '').trim().slice(0, 480)
  if (!body) return { ok: false, error: 'empty-message' }

  try {
    const conversationId = await findChampSelectConversation()
    if (!conversationId) {
      warn('没有找到选人聊天会话，跳过聊天提示')
      return { ok: false, error: 'no-conversation' }
    }

    await lcu.post(
      `/lol-chat/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body, type: 'chat' },
    )
    return { ok: true }
  } catch (err) {
    // 会话 id 可能已经失效，下次重新找
    cachedConversationId = ''
    warn('发送选人聊天提示失败:', err?.message || err)
    return { ok: false, error: String(err?.message || err) }
  }
}
