import { h, normalizeText } from '../dom.js'

export function createChampionPicker(getChampions) {
  const label = '拉黑时的英雄'
  const options = h('div', {
    id: 'pgbl-champion-options',
    class: 'pgbl-champion-options',
    attrs: { role: 'listbox', 'aria-label': label },
  })
  const input = h('input', {
    class: 'pgbl-search',
    attrs: {
      role: 'combobox',
      'aria-label': label,
      'aria-autocomplete': 'list',
      'aria-controls': options.id,
      'aria-expanded': 'false',
      placeholder: '搜索或选择英雄（可留空）',
      autocomplete: 'off',
    },
  })
  const el = h('div', { class: 'pgbl-champion-picker' },
    h('div', { class: 'pgbl-champion-picker__field' }, input, h('span', { attrs: { 'aria-hidden': 'true' }, text: '⌄' })),
    options,
  )

  let champions = []
  let results = []
  let selected = null
  let active = -1
  let expanded = false
  let loading = true

  function select(champion) {
    selected = champion
    input.value = champion.name
    expanded = false
    render()
  }

  function render() {
    input.setAttribute('aria-expanded', String(expanded))
    input.removeAttribute('aria-activedescendant')
    options.hidden = !expanded
    if (!expanded) return

    const query = normalizeText(input.value)
    results = champions.filter((champion) => champion.search.some((value) => value.includes(query)))
    if (!results.length) {
      const message = loading ? '正在读取英雄列表…' : '没有找到英雄'
      options.replaceChildren(h('div', { class: 'pgbl-champion-options__status', text: message }))
      return
    }

    options.replaceChildren(...results.map((champion, index) => h('button', {
      id: `pgbl-champion-option-${champion.id}`,
      type: 'button',
      tabIndex: -1,
      class: 'pgbl-champion-options__option',
      attrs: { role: 'option', 'aria-selected': String(index === active) },
      text: champion.label,
      onmousedown: (event) => event.preventDefault(),
      onclick: () => select(champion),
    })))
    const activeOption = options.children[active]
    if (activeOption) {
      input.setAttribute('aria-activedescendant', activeOption.id)
      activeOption.scrollIntoView({ block: 'nearest' })
    }
  }

  function open() {
    if (expanded) return
    expanded = true
    active = -1
    render()
  }
  input.addEventListener('focus', open)
  input.addEventListener('click', open)
  input.addEventListener('blur', () => { expanded = false; render() })
  input.addEventListener('input', () => {
    selected = null
    expanded = true
    active = -1
    render()
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      open()
      if (!results.length) return
      const advance = event.key === 'ArrowDown' ? 1 : -1
      active = active < 0 && advance < 0 ? results.length - 1 : (active + advance + results.length) % results.length
      render()
    } else if (event.key === 'Enter' && expanded) {
      event.preventDefault()
      const champion = results[active] || (results.length === 1 ? results[0] : null)
      if (champion) select(champion)
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      expanded = false
      render()
    }
  })

  render()
  void Promise.resolve().then(() => getChampions?.()).then((list) => {
    champions = (list || []).map((champion) => ({
      ...champion,
      label: champion.title && champion.title !== champion.name ? `${champion.name} · ${champion.title}` : champion.name,
      search: [champion.name, champion.title, champion.alias, champion.id].map(normalizeText),
    }))
  }).catch(() => {}).finally(() => {
    loading = false
    render()
  })

  return {
    el,
    input,
    selected() {
      const query = normalizeText(input.value)
      return selected || (query ? champions.find((champion) => champion.search.includes(query)) : null)
    },
  }
}
