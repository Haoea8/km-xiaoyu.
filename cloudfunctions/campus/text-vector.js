'use strict';
/**
 * 轻量向量检索：TF-IDF 加权 + 余弦相似度
 *
 * 为什么要它：纯子串匹配搜不到「笔电」「四级」这类口语说法，
 * 而校园用户恰恰最爱这么打。向量化后「笔电」与「笔记本电脑」共享二元组，
 * 相似度不再为 0；再叠一层同义词归一化，覆盖「单车/自行车」这类完全不共享字的。
 *
 * 设计取舍：
 *   - 不引入向量数据库、不调外部 embedding：百级商品，索引在内存里现建 < 2ms，
 *     存算成本为零，冷启动也不用额外服务；
 *   - 中文按**二元组（bigram）**切分，不依赖分词词典，专有名词、缩写都不会被切错；
 *   - 只负责「召回打分」，不做排序决策：最终顺序仍由关键词分 + 预算 + 大模型重排决定。
 *
 * ⚠️ 与 `server/src/text-vector.js` 是镜像代码，两边必须逐字节一致（check-mirror.js 校验）。
 */

/** 同义词归一化：把口语说法映射成商品标题里更常见的写法 */
const SYNONYMS = [
  [/笔电|手提电脑|手提本|本本/g, '笔记本'],
  [/四六级|四级|六级|46级|英语四级|英语六级/g, '四六级'],
  [/脚踏车|单车|公路车|山地车/g, '自行车'],
  [/头戴耳机|耳麦|降噪耳麦/g, '耳机'],
  [/显示屏|屏幕|显示屏幕/g, '显示器'],
  [/键盘膜|机械键盘/g, '键盘'],
  [/吹风筒/g, '吹风机'],
  [/教科书|课本|书本/g, '教材'],
  [/学士袍/g, '学士服'],
  [/硬盘|移动硬盘|固态/g, '硬盘'],
  [/充电头|快充头/g, '充电器'],
  [/雨伞|折叠伞/g, '伞'],
  [/移动电源|充电宝/g, '充电宝']
];

/** 归一化：小写 + 同义词替换，两处都走这个，保证查询和文档在同一词表上 */
function normalize(s) {
  let t = String(s || '').toLowerCase();
  for (let i = 0; i < SYNONYMS.length; i++) t = t.replace(SYNONYMS[i][0], SYNONYMS[i][1]);
  return t;
}

/** 切词：英文/数字整段保留，中文按二元组展开 */
function tokenize(s) {
  const t = normalize(s);
  const out = [];
  const re = /[a-z0-9]+|[\u4e00-\u9fa5]+/g;
  let m = re.exec(t);
  while (m) {
    const seg = m[0];
    if (/^[a-z0-9]+$/.test(seg) || seg.length === 1) {
      out.push(seg);
    } else {
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    }
    m = re.exec(t);
  }
  return out;
}

function termCount(list) {
  const tf = {};
  for (let i = 0; i < list.length; i++) tf[list[i]] = (tf[list[i]] || 0) + 1;
  return tf;
}

/** 单件商品的检索文本：标题权重最高，描述次之，标签/分区兜底 */
function docText(l) {
  return [
    l.title || '',
    l.title || '',
    l.desc || '',
    (l.tags || []).join(' '),
    l.zone || '',
    l.goodsName || ''
  ].join(' ');
}

/**
 * 建索引。listings 变了就重建，商品百级时开销可忽略。
 * 返回 { docs:[{id, vec, norm}], idf }
 */
function buildIndex(listings) {
  const arr = Array.isArray(listings) ? listings : [];
  const docs = arr.map(function (l) {
    return { id: l.id, tf: termCount(tokenize(docText(l))) };
  });
  const df = {};
  const N = docs.length || 1;
  docs.forEach(function (d) {
    Object.keys(d.tf).forEach(function (k) { df[k] = (df[k] || 0) + 1; });
  });
  const idf = {};
  Object.keys(df).forEach(function (k) {
    idf[k] = Math.log((N + 1) / (df[k] + 1)) + 1;
  });
  docs.forEach(function (d) {
    const vec = {};
    let norm = 0;
    Object.keys(d.tf).forEach(function (k) {
      const w = (1 + Math.log(d.tf[k])) * (idf[k] || 1);
      vec[k] = w;
      norm += w * w;
    });
    d.vec = vec;
    d.norm = Math.sqrt(norm) || 1;
  });
  return { docs: docs, idf: idf };
}

/** 查询向量与全部文档的余弦相似度，返回 [{id, sim}] */
function score(query, index) {
  if (!index || !index.docs || !index.docs.length) return [];
  const qtf = termCount(tokenize(query));
  const qvec = {};
  let qnorm = 0;
  Object.keys(qtf).forEach(function (k) {
    const w = (1 + Math.log(qtf[k])) * (index.idf[k] || 1);
    qvec[k] = w;
    qnorm += w * w;
  });
  qnorm = Math.sqrt(qnorm) || 1;
  const keys = Object.keys(qvec);
  return index.docs.map(function (d) {
    let dot = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (d.vec[k]) dot += qvec[k] * d.vec[k];
    }
    return { id: d.id, sim: dot / (qnorm * d.norm) };
  });
}

module.exports = { normalize, tokenize, buildIndex, score, SYNONYMS };
