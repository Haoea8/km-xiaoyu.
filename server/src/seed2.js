'use strict';
/**
 * 扩展功能演示数据：校园墙 / 学习资源 / 拼团
 * 幂等：对应集合非空则跳过
 */
const db = require('./db');
const group = require('./group');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => Date.now() - ms;

function userByNick(nick) {
  return db.one('users', (u) => u.nickname === nick) || db.get('users')[0];
}

function anonOf(userId, salt) {
  const ADJ = ['路过的', '安静的', '勇敢的', '爱笑的', '温柔的', '神秘的', '热心的', '低调的', '认真的', '爱吃的'];
  const NOUN = ['小橘子', '胖头鱼', '银河系', '小行星', '蒲公英', '向日葵', '布丁', '气泡水', '猫咪', '柴犬'];
  const seed = (Number(userId) * 7919 + Number(salt || 0) * 104729) % 100000;
  return ADJ[seed % ADJ.length] + NOUN[Math.floor(seed / 7) % NOUN.length] + '#' + ((seed % 9000) + 1000);
}

function build() {
  const users = db.get('users').filter((u) => !u.isAI);
  if (!users.length) return { skipped: 'no users' };
  const U = {};
  for (const u of users) U[u.nickname] = u;
  const pick = (n) => U[n] || users[0];

  const out = { walls: 0, wallComments: 0, resources: 0, groups: 0 };

  /* ================= 校园墙 ================= */
  if (!db.get('walls').length) {
    const walls = [
      ['love', '图书馆四楼靠窗那个穿白色卫衣的女生，你每天下午两点都会来，我坐你斜后方第三排。想认识你，但每次走过去腿就软了……如果你看到这条，能不能在评论区留个句号？', null, '林知夏', 128, 3 * HOUR],
      ['love', '致 22 级电商 2 班的班长：军训时你帮我把晒晕的室友背去医务室，一直没找到机会说谢谢。听说你最近在准备升本，加油，你一定能上岸！', null, '苏晚', 96, 7 * HOUR],
      ['all', '求问：清远校区哪里能修电动车？后轮胎爆了，修车店老板说要换整个轮子收我 180，感觉被坑了。', null, '陈舟', 42, 1 * HOUR],
      ['all', '万能墙保佑！明天高数期中考，希望不挂科🙏 顺便问一下有没有人有第三章的课后答案，跪谢！', null, '周野', 63, 2 * HOUR],
      ['love', '暗恋了同宿舍楼下那个每天六点半跑步的男生三个月了。今天终于鼓起勇气跟跑了半圈，结果他加速了……是我跑太慢还是他害羞啊😭', null, '许一诺', 210, 9 * HOUR],
      ['all', '食堂三楼新开的麻辣烫真的绝了！老板是东北人，加的麻酱超香。推荐试试加宽粉+毛肚，人均 15 吃到扶墙。', ['/static/img/c01.jpg'], '沈砚', 154, 5 * HOUR],
      ['all', '失物招领：在体育馆二楼篮球场捡到一副 AirPods Pro，壳上贴了个小恐龙贴纸。失主联系我，我在 6 栋。', ['/static/img/c02.jpg'], '郑小满', 88, 11 * HOUR],
      ['love', '给 3 栋 502 的那个每天弹吉他的男生：你昨天弹的《晴天》我听了整整一小时，能不能换一首《七里香》？', null, '柳叶', 176, 1 * DAY],
      ['all', '吐槽：今天在食堂打饭，阿姨的手抖得比我的代码还厉害，一份土豆丝只给了三根。建议学校给阿姨配个防抖云台。', null, '顾亦', 342, 1 * DAY + 4 * HOUR],
      ['all', '有没有一起做传智杯的队友？我做前端+小程序，会点 Node，缺一个会 UI 设计或者做后端的。目标校赛一等奖冲国赛。', null, '江迟', 57, 26 * MIN]
    ];
    for (const [type, content, images, nick, likes, agoMs] of walls) {
      const u = pick(nick);
      const salt = (agoMs % 9973);
      const w = db.insert('walls', {
        type, content, images: images || [], toName: '',
        authorId: u.id,
        anonName: anonOf(u.id, salt),
        anonymous: true,
        likes: [], likeBase: likes, commentCount: 0,
        status: 'on', createdAt: ago(agoMs)
      });
      out.walls++;
      // 评论
      const pool = [
        '加油！勇敢一点，我们支持你',
        '哈哈哈哈哈笑死我了',
        '同款困惑，蹲一个答案',
        '这条我必须要顶',
        '呜呜呜好甜，祝成功',
        '我认识这个人，可以帮你问问',
        '万能的墙友果然靠谱',
        '已转发到我们班群了'
      ];
      const n = 1 + (likes % 4);
      for (let i = 0; i < n; i++) {
        const cu = users[(u.id + i * 3) % users.length];
        db.insert('wallComments', {
          wallId: w.id,
          content: pool[(likes + i * 7) % pool.length],
          authorId: cu.id,
          anonName: anonOf(cu.id, salt + i * 131),
          anonymous: true, replyToName: '',
          likes: [], likeBase: (i * 3) % 12, status: 'on',
          createdAt: ago(Math.max(5 * MIN, agoMs - (i + 1) * 22 * MIN))
        });
        out.wallComments++;
      }
      w.commentCount = n;
    }
  }

  /* ================= 学习资源 ================= */
  if (!db.get('resources').length) {
    const res = [
      ['《数据结构》期末复习提纲（含思维导图）', '整理了整学期的重点，含 8 张思维导图和 12 道典型大题解析，期末冲刺够用了。', '数据结构', 'note', ['数据结构', '期末', '思维导图'], '林知夏', 428000, '.pdf', 386, 152, 2 * DAY],
      ['高数（上）历年期末真题合集 2018-2025', '8 套真题带详细解析，标注了高频考点。第二章极限和第五章定积分是重灾区，重点看。', '高等数学', 'exam', ['高数', '真题', '期末'], '苏晚', 1250000, '.pdf', 512, 264, 3 * DAY],
      ['Java 后端学习路线 + 项目源码', '从语法到大厂面试的完整路线，附 3 个可写进简历的实战项目源码（含 SpringBoot + MyBatis）。', 'Java程序设计', 'code', ['Java', 'SpringBoot', '项目'], '陈舟', 8600000, '.zip', 673, 198, 4 * DAY],
      ['《大学英语四级》高频词汇 1500（乱序版）', '按考频排序的 1500 个核心词，每个词配真题例句。我背完从 425 提到 512。', '大学英语', 'note', ['四级', '词汇', '英语'], '周野', 312000, '.pdf', 904, 341, 5 * DAY],
      ['计算机网络课件（全 12 章 PPT 打包）', '老师上课的 PPT 原件，考前看一遍比看书快。TCP 三次握手那张图讲得很清楚。', '计算机网络', 'course', ['计网', '课件', 'PPT'], '许一诺', 24500000, '.zip', 288, 96, 6 * DAY],
      ['电子商务运营实战案例 20 个', '真实店铺数据脱敏后的运营案例，含选品、定价、活动策划全流程。做传智杯电商题目的可以看看。', '电子商务概论', 'other', ['电商', '案例', '运营'], '沈砚', 5400000, '.pdf', 176, 63, 7 * DAY],
      ['线性代数考前 3 小时速通笔记', '手写笔记扫描版，把矩阵、行列式、特征值串成一条线，考前一晚看完刚好。', '线性代数', 'note', ['线代', '速通', '手写笔记'], '郑小满', 2680000, '.pdf', 356, 142, 1 * DAY],
      ['微信小程序开发从 0 到 1（含完整 Demo）', '自己整理的入门资料，从 wxml 到云开发全流程，附一个可跑的二手交易 Demo。', '移动应用开发', 'code', ['小程序', 'Demo', '前端'], '柳叶', 4200000, '.zip', 623, 287, 9 * HOUR],
      ['毛概 / 思修 期末背诵手册', '浓缩成 30 页，考点全覆盖，按题型分好了。背完稳过。', '毛泽东思想和中国特色社会主义理论体系概论', 'note', ['思政', '背诵', '期末'], '顾亦', 186000, '.pdf', 742, 398, 2 * DAY],
      ['大学生创新创业大赛商业计划书模板', '拿过省赛银奖的 BP 模板，含财务测算表和市场分析框架，直接套用改改就能交。', '创新创业基础', 'other', ['创业', 'BP', '模板'], '江迟', 720000, '.docx', 234, 118, 12 * HOUR]
    ];
    for (const [title, desc, course, category, tags, nick, size, ext, downloads, likes, agoMs] of res) {
      const u = pick(nick);
      db.insert('resources', {
        title, desc, course, category, tags,
        fileUrl: '/static/uploads/demo' + (out.resources + 1) + ext,
        fileName: title.replace(/[《》]/g, '') + ext,
        fileSize: size, fileExt: ext,
        uploaderId: u.id,
        downloads, likes: [], likeBase: likes, likeCount: likes,
        status: 'on', createdAt: ago(agoMs)
      });
      out.resources++;
    }
  }

  /* ================= 拼团 ================= */
  if (!db.get('groups').length) {
    const groupListings = db.find('listings', (l) => l.tradeMode === 'group' && l.status === 'on');
    const now = Date.now();
    const leaders = ['林知夏', '苏晚', '陈舟', '周野'];

    groupListings.slice(0, 4).forEach((listing, idx) => {
      const target = group.parseTarget(listing);
      const leader = pick(leaders[idx % leaders.length]);
      const finished = idx === 3; // 最后一个做成「已成团」示例
      const members = [{ userId: leader.id, joinedAt: now - 8 * HOUR, qty: 1, orderId: null, paid: true }];

      // 再补几个已付款成员：进行中的团留 1~2 个空位，已成团则凑满
      const want = finished ? target : Math.max(1, target - (idx % 2 === 0 ? 2 : 1));
      for (let i = 0; members.length < want && i < users.length; i++) {
        const m = users[(leader.id + i * 3 + 1) % users.length];
        if (!m || members.some((x) => x.userId === m.id)) continue;
        members.push({ userId: m.id, joinedAt: now - (6 - Math.min(5, i)) * HOUR, qty: 1, orderId: null, paid: true });
      }

      db.insert('groups', {
        listingId: listing.id,
        leaderId: leader.id,
        targetCount: target,
        members,
        status: finished ? 'success' : 'open',
        expireAt: now + (target > 10 ? 2 * DAY : 20 * HOUR),
        successAt: finished ? now - 1 * HOUR : null,
        createdAt: now - 8 * HOUR
      });
      out.groups++;

      db.update('listings', listing.id, {
        attrs: Object.assign({}, listing.attrs, {
          已参团: members.length + ' 人',
          拼团状态: finished ? '已成团' : '拼团中'
        })
      });
    });
  }

  db.saveSoon();
  return out;
}

module.exports = { build };
