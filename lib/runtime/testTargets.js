import { CHINESE_CHAMPIONS } from '../championCatalog.js'

export const TEST_TARGETS = {
  enemyFamiliar: { side: 'enemy', group: 'familiar', setting: 'testEnemyEnabled', label: '添加敌方熟人测试目标' },
  allyFamiliar: { side: 'ally', group: 'familiar', setting: 'testAllyEnabled', label: '添加友方熟人测试目标' },
  enemyBlacklist: { side: 'enemy', group: 'hits', setting: 'testEnemyBlacklistEnabled', label: '添加敌方黑名单测试目标' },
  allyBlacklist: { side: 'ally', group: 'hits', setting: 'testAllyBlacklistEnabled', label: '添加友方黑名单测试目标' },
}

const NAME_PREFIXES = ['霜月', '晚风', '星河', '雾岛', '青竹', '落雪', '云海', '墨雨']
const NAME_SUFFIXES = ['旅人', '听雨', '灯塔', '小舟', '飞鸟', '风铃', '书生', '夜航']
const BLACKLIST_REASONS = ['中途挂机', '言语骚扰', '消极游戏', '故意送人头', '恶意抢位置', '赛后嘲讽']
const MINUTE = 60_000

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function sample(values) {
  return values[randomInt(0, values.length - 1)]
}

/** 生成完整的本地展示数据。真实名单、战绩和队伍聊天使用各自的原始结果。 */
export function createTestTarget({ side, group }, now = Date.now()) {
  const heroIndex = randomInt(0, CHINESE_CHAMPIONS.length - 1)
  const previousIndex = (heroIndex + randomInt(1, CHINESE_CHAMPIONS.length - 1)) % CHINESE_CHAMPIONS.length
  const [championId, championName] = CHINESE_CHAMPIONS[heroIndex]
  const [lastChampionId, lastChampionName] = CHINESE_CHAMPIONS[previousIndex]
  const team = side === 'ally' ? '友方' : '敌方'
  const gameName = `${team}测试·${sample(NAME_PREFIXES)}${sample(NAME_SUFFIXES)}`
  const tagLine = String(group === 'hits' ? randomInt(60_000, 99_999) : randomInt(10_000, 59_999))
  const player = { gameName, tagLine, championId, teamId: side === 'ally' ? 100 : 200 }
  const gameId = randomInt(9_000_000_000_000, 9_999_999_999_999)

  if (group === 'hits') {
    const name = `${gameName}#${tagLine}`
    const createdAt = now - randomInt(120, 30 * 24 * 60) * MINUTE
    return {
      player,
      championId,
      championName,
      isTest: true,
      entry: {
        id: `test:${name}`,
        name,
        gameName,
        tagLine,
        reason: sample(BLACKLIST_REASONS),
        championId: lastChampionId,
        championName: lastChampionName,
        gameId,
        gameMode: sample(['ARAM', 'CLASSIC']),
        createdAt,
        updatedAt: createdAt,
        source: 'test',
      },
    }
  }

  const gamesAgo = randomInt(1, 4)
  return {
    player,
    gamesAgo,
    seenCount: randomInt(2, 6 - gamesAgo),
    champions: [lastChampionId],
    currentSide: side,
    lastTeam: sample(['ally', 'enemy']),
    lastChampionId,
    lastChampionName,
    currentChampionName: championName,
    lastAt: now - randomInt(gamesAgo * 15, gamesAgo * 120) * MINUTE,
    gameId,
    isTest: true,
  }
}
