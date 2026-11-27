/**
 * 大区（platformId）识别。
 *
 * LCU 里的 platformId 长这样：HN1 / NA1 / EUW1 / KR ...
 * 旧版导入数据也可能使用中文区名。
 */

const REGION_LABELS = {
  // ---- 国服 ----
  NJ100: '联盟一区',
  GZ100: '联盟二区',
  CQ100: '联盟三区',
  TJ100: '联盟四区',
  TJ101: '联盟五区',
  BGP2: '峡谷之巅',
  PBE: '体验服',
  PREPBE: '预体验服',
  HN1: '艾欧尼亚',
  HN2: '祖安',
  HN3: '诺克萨斯',
  HN4: '班德尔城',
  HN5: '皮尔特沃夫',
  HN6: '战争学院',
  HN7: '巨神峰',
  HN8: '雷瑟守备',
  HN9: '裁决之地',
  HN10: '黑色玫瑰',
  HN11: '暗影岛',
  HN12: '钢铁烈阳',
  HN13: '水晶之痕',
  HN14: '均衡教派',
  HN15: '影流',
  HN16: '守望之海',
  HN17: '征服之海',
  HN18: '卡拉曼达',
  HN19: '皮城警备',
  WT1: '比尔吉沃特',
  WT2: '德玛西亚',
  WT3: '弗雷尔卓德',
  WT4: '无畏先锋',
  WT5: '恕瑞玛',
  WT6: '扭曲丛林',
  WT7: '巨龙之巢',
  EDU1: '教育网专区',
  BGP1: '男爵领域',

  // ---- 国际服 ----
  NA1: '美服-北美',
  EUW1: '欧服-西欧',
  EUN1: '欧服-东欧',
  KR: '韩服',
  JP1: '日服',
  BR1: '巴西服',
  LA1: '拉美-北',
  LA2: '拉美-南',
  OC1: '大洋洲服',
  TR1: '土耳其服',
  RU: '俄服',
  PH2: '菲律宾服',
  SG2: '新加坡服',
  TH2: '泰国服',
  TW2: '台服',
  VN2: '越南服',
  ME1: '中东服',
  PBE1: '测试服',
}

const REGION_CODES = new Map(Object.entries(REGION_LABELS).reverse().map(([code, name]) => [name.toUpperCase(), code]))

/** 统一客户端代码、国服前缀和手填的大区名称。 */
export function normalizePlatform(code) {
  const value = String(code ?? '').trim().toUpperCase()
  const shard = value.replace(/^TENCENT[_-]/, '')
  if (Object.prototype.hasOwnProperty.call(REGION_LABELS, shard)) return shard
  return REGION_CODES.get(value) || value
}

