import { h } from '../dom.js'
import { TEST_TARGETS } from '../runtime/testTargets.js'

function settingToggle(label, checked, onChange, { className, ariaLabel }) {
  const input = h('input', {
    type: 'checkbox',
    checked,
    attrs: { 'aria-label': ariaLabel },
    onchange: (event) => onChange(event.currentTarget.checked),
  })
  return h('label', { class: className }, h('span', { text: label }), input)
}

function settingsDisclosure(title, className, ...content) {
  const status = h('span', { class: 'pgbl-settings-group__status', attrs: { 'aria-live': 'polite' } })
  const element = h('details', { class: `pgbl-settings-group ${className}` },
    h('summary', { class: 'pgbl-settings-group__summary' }, h('span', { text: title }), status),
    content,
  )
  return {
    element,
    setStatus(text, enabled) {
      status.textContent = text
      status.classList.toggle('is-enabled', enabled)
    },
  }
}

function createFamiliarSettings({ familiarEnabled, setFamiliar, familiarLoadingEnabled, setFamiliarLoading }) {
  const choices = Object.entries({ ally: '友方', enemy: '敌方' }).map(([side, label]) =>
    settingToggle(label, familiarLoadingEnabled(side), (enabled) => setFamiliarLoading(side, enabled), {
      className: 'pgbl-familiar-loading__option',
      ariaLabel: `加载时弹窗 ${label}熟人`,
    }),
  )

  const section = settingsDisclosure('熟人识别', 'pgbl-familiar-settings',
    settingToggle('启用熟人识别', familiarEnabled, (enabled) => {
      setFamiliar(enabled)
      updateStatus(enabled)
    }, { className: 'pgbl-familiar-settings__toggle' }),
    h('div', { class: 'pgbl-familiar-loading', attrs: { role: 'group', 'aria-label': '熟人加载提醒' } },
      h('span', { text: '加载时弹窗' }),
      h('div', { class: 'pgbl-familiar-loading__choices' }, choices),
    ),
  )

  function updateStatus(enabled) {
    section.setStatus(enabled ? '已启用' : '未启用', enabled)
  }
  updateStatus(familiarEnabled)
  return section.element
}

function createTestSettings(testEnabled, setTestEnabled) {
  function updateStatus() {
    const count = Object.keys(TEST_TARGETS).filter(testEnabled).length
    section.setStatus(count ? `已启用 ${count} 项` : '未启用', count > 0)
  }

  function testCell(key) {
    return h('td', null,
      h('label', { class: 'pgbl-test-settings__cell' },
        h('input', {
          type: 'checkbox',
          checked: testEnabled(key),
          attrs: { 'aria-label': TEST_TARGETS[key].label },
          onchange: (event) => {
            setTestEnabled(key, event.currentTarget.checked)
            updateStatus()
          },
        }),
      ),
    )
  }

  const rows = [
    ['熟人', 'allyFamiliar', 'enemyFamiliar'],
    ['黑名单', 'allyBlacklist', 'enemyBlacklist'],
  ]
  const section = settingsDisclosure('测试目标', 'pgbl-test-settings',
    h('table', { class: 'pgbl-test-settings__matrix', attrs: { 'aria-label': '测试目标' } },
      h('thead', null,
        h('tr', null,
          h('td'),
          h('th', { scope: 'col', text: '友方' }),
          h('th', { scope: 'col', text: '敌方' }),
        ),
      ),
      h('tbody', null, rows.map(([label, ally, enemy]) =>
        h('tr', null, h('th', { scope: 'row', text: label }), testCell(ally), testCell(enemy)),
      )),
    ),
  )
  updateStatus()
  return section.element
}

export function createSettings(settings) {
  const { testEnabled, setTestEnabled, resetLauncher } = settings
  const status = h('span', { class: 'pgbl-settings-status', attrs: { role: 'status' } })

  return h('div', { class: 'pgbl-settings' },
    createFamiliarSettings(settings),
    createTestSettings(testEnabled, setTestEnabled),
    h('div', { class: 'pgbl-settings-actions' },
      h('button', {
        class: 'pgbl-btn',
        type: 'button',
        text: '重置按钮位置',
        onclick: () => {
          resetLauncher()
          status.textContent = '入口位置已恢复'
        },
      }),
      status))
}
