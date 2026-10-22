'use strict';
/**
 * 演示种子数据：服务首次启动时自动构建；执行 `node seed.js` 可随时重置演示数据。
 * 覆盖：用户 / 商品（九大分区）/ 圈子 / 帖子 / 会话消息 / 订单 / 钱包 / 收藏 / 举报 / 公告
 */
const db = require('./db');

const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms) => NOW - ms;

function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

function build() {
  const data = db.load();
  for (const c of db.COLLECTIONS) data[c] = [];
  data.seq = {};
  data.meta = {
    version: 1,
    createdAt: NOW,
    admin: { username: 'admin', password: 'admin' },
    config: { platform: '科贸小鱼', subtitle: '校园生活服务与二手交易综合平台', autoApprove: true }
  };

  /* ================= 用户 ================= */
  const U = {};
  U.ai = db.insert('users', {
    nickname: '小校助手', avatar: '/static/avatars/a09.jpg', isAI: true, gender: 0,
    bio: '我是科贸小鱼的 AI 客服小助手。发布闲置、下单支付、订单售后、拼团玩法，有任何问题都可以问我！',
    college: '科贸小鱼官方', grade: '', campus: '官方', credit: 100, cert: 'official',
    balance: 0, status: 'normal'
  });
  const users = [
    ['manman', '林小满', 'a01', 2, '计算机应用技术', '大二', 96, '计应大二 | 整理控，闲置都低价出，支持以物换物～', 50500],
    ['yichen', '陈奕辰', 'a02', 1, '软件技术', '大三', 93, '数码爱好者，换机频繁，出点闲置回回血', 12000],
    ['suxiao', '苏晓', 'a03', 2, '商务英语', '大二', 95, '美妆 / 手作 / 杂货铺，支持以物换物！', 8460],
    ['zhouye', '周野', 'a04', 1, '物联网应用技术', '大三', 90, '运动装备爱好者，夜跑约起来', 21300],
    ['jiaqi', '何佳琪', 'a05', 2, '学前教育', '大一', 88, '文具控 + 手账党，多肉也卖，欢迎来逛～', 9800],
    ['dachuan', '郑大川', 'a06', 1, '机电一体化技术', '大四', 91, '骑行党，毕业清仓中，价格好商量', 33200],
    ['yinuo', '许一诺', 'a07', 2, '电子商务', '大三', 97, '拼团团长，把价格打下来！', 65400],
    ['gaoyuan', '高远', 'a08', 1, '动漫制作技术', '大二', 89, '手办 / 游戏 / 二次元，账号交易支持担保', 15600]
  ];
  for (const [key, nickname, avatar, gender, major, grade, credit, bio, balance] of users) {
    U[key] = db.insert('users', {
      nickname, avatar: '/static/avatars/' + avatar + '.jpg', gender,
      bio, college: '人工智能学院 · ' + major, grade,
      campus: '广东科贸职业学院（清远校区）', credit, cert: 'student',
      balance, status: 'normal', joinedAt: ago(rand(40, 300) * DAY)
    });
  }

  /* ================= 商品 ================= */
  function L(key, zone, title, price, img, extra) {
    const imgs = Array.isArray(img) ? img : [img];
    return db.insert('listings', Object.assign({
      sellerId: U[key].id, zone, title,
      desc: '', images: imgs.map((i) => '/static/img/' + i + '.jpg'),
      price: Math.round(price * 100), priceUnit: '件', tradeMode: 'sell', status: 'on',
      location: '学生宿舍区', tradeMethods: ['校内面交', '宿舍自提'],
      tags: [], attrs: {},
      views: rand(60, 720), favoriteCount: rand(2, 36), wantCount: rand(0, 10),
      createdAt: ago(rand(2, 130) * HOUR)
    }, extra || {}));
  }

  // —— 二手闲置 ——
  const lHeadset = L('yichen', 'used', '索尼头戴式降噪耳机 九成新', 780, 'p03', {
    originalPrice: 189900, desc: '听了两个多月，成色很好，因换了 AirPods 出。附原装收纳袋和音频线，支持当面试听验货。',
    attrs: { 成色: '95新', 购入渠道: '京东自营' }, tags: ['数码', '降噪耳机'],
    tradeMethods: ['校内面交', '快递到付'], location: '图书馆门口'
  });
  const lMonitor = L('yichen', 'used', '24寸 2K 显示器 无坏点', 520, 'p04', {
    originalPrice: 89900, desc: '自用一年，无坏点无漏光，送 HDMI 线。宿舍桌上自提，可现场验屏。',
    attrs: { 成色: '9成新', 尺寸: '24英寸' }, tags: ['数码', '宿舍必备'], location: '学生宿舍 6 栋'
  });
  const lFigure = L('gaoyuan', 'used', '动漫手办 全新未拆盒', 98, 'p12', {
    originalPrice: 19900, desc: '重复款出掉，盒况完美，非诚勿扰～可换高达模型。',
    attrs: { 成色: '全新', 盒况: '完美盒' }, tags: ['二次元', '手办'], location: '学生宿舍 8 栋'
  });
  const lPad = L('gaoyuan', 'used', '八位堂手柄 + 机械键盘 套装', 180, 'p13', {
    desc: '吃鸡神器组合，手柄仅用几次，茶轴 87 键键盘，打包出更划算。',
    attrs: { 成色: '95新' }, tags: ['外设', '吃鸡'], location: '学生宿舍 8 栋'
  });
  L('zhouye', 'used', '篮球鞋 43 码 实战九成新', 260, 'p07', {
    originalPrice: 59900, desc: '打过几次球，鞋底磨损很轻，无开胶。43 码偏小，建议 42.5 脚入。',
    attrs: { 成色: '9成新', 尺码: '43' }, tags: ['球鞋', '运动']
  });
  const lBike = L('dachuan', 'used', '山地自行车 深蓝 通勤代步', 650, 'p02', {
    originalPrice: 129900, desc: '骑了一年，刚做完全保养，刹车变速都正常，送车锁和打气筒，教学楼 B 座看车。',
    attrs: { 成色: '8成新', 变速: '27 速' }, tags: ['代步', '骑行'], location: '教学楼 B 座停车区'
  });
  L('suxiao', 'used', '化妆刷套装 + 口红礼盒 全新', 88, 'p11', {
    originalPrice: 16800, desc: '618 买多了，全新未拆，可当面拆验。带全套收纳包，送人自用都合适。',
    attrs: { 成色: '全新' }, tags: ['美妆']
  });
  L('manman', 'used', '考研英语黄皮书 + 专业课教材', 45, 'p01', {
    desc: '全套都在，笔记字迹工整，附我的思维导图和背诵清单，打包带走。',
    attrs: { 成色: '8成新', 笔记: '工整' }, tags: ['考研', '教材']
  });
  const lLamp = L('manman', 'used', '小米护眼台灯 三档调光', 35, 'p09', {
    desc: '用了一学期，功能一切正常，灯光三档可调，宿舍学习必备。',
    attrs: { 成色: '95新' }, tags: ['宿舍', '学习'], status: 'sold'
  });
  L('jiaqi', 'used', '20000mAh 充电宝 65W 快充', 59, 'p10', {
    desc: '买重了仅拆封，65W 快充，能当充电头用，带 C 口线。',
    attrs: { 成色: '全新' }, tags: ['数码']
  });
  L('jiaqi', 'used', '多肉盆栽 三盆装 状态在线', 25, 'p17', {
    desc: '自己养的，品相很好，带盆出。宿舍党的治愈小物～',
    attrs: { 成色: '实物如图' }, tags: ['绿植']
  });
  const lTablet = L('yichen', 'used', '平板电脑 + 手写笔 考研党标配', 1350, 'p18', {
    originalPrice: 289900, desc: '考研复习用完出，屏幕无划痕，电池健康 92%，带笔和壳。',
    attrs: { 成色: '9成新', 电池: '92%' }, tags: ['数码', '学习']
  });
  const lCase = L('dachuan', 'used', '24寸行李箱 万向轮 静音', 120, 'p08', {
    desc: '只用过两次，拉杆顺滑轮子静音，毕业旅行还能用。',
    attrs: { 成色: '95新', 尺寸: '24寸' }, tags: ['出行']
  });
  const lGuitar = L('gaoyuan', 'used', '民谣吉他 41寸 入门款', 280, 'p06', {
    originalPrice: 69900, desc: '学了两月放弃了，音色正，送琴包、变调夹和拨片。',
    attrs: { 成色: '9成新' }, tags: ['乐器']
  });
  const lFridge = L('manman', 'used', '宿舍小冰箱 48L 制冷正常', 150, 'p05', {
    desc: '毕业出，冷藏冷冻分区都有，制冷超快，宿舍自提（有电梯）。',
    attrs: { 成色: '8成新', 容量: '48L' }, tags: ['宿舍必备']
  });
  const lRacket = L('zhouye', 'used', '碳素羽毛球拍 带手胶', 85, 'p15', {
    desc: '打过几次，手感很好，送三只训练球，体育馆面交。',
    attrs: { 成色: '95新' }, tags: ['运动'], status: 'sold'
  });
  const lInstax = L('suxiao', 'used', '拍立得相机 mini11 白色', 330, 'p14', {
    originalPrice: 54900, desc: '拍照功能一切正常，送 20 张相纸，毕业照必备。',
    attrs: { 成色: '9成新' }, tags: ['相机', '毕业季']
  });
  L('yichen', 'used', '机械键盘 87 键 茶轴', 129, 'p13', {
    desc: '已出，谢谢关注～', attrs: { 成色: '9成新' }, tags: ['外设'], status: 'sold'
  });

  // —— 毕业季 ——
  L('manman', 'graduation', '毕业出 | 四六级 + 考研教材打包', 20, 'p01', {
    desc: '学弟学妹看过来，全部打包 20 拿走，包含真题和详细笔记。',
    attrs: { 成色: '8成新' }, tags: ['毕业季', '教材']
  });
  L('jiaqi', 'graduation', '学士服 学士帽 毕业照三件套', 35, 'p16', {
    desc: '只用过一次拍毕业照，尺码 170，清洗干净出，也可按天租（见租借专区）。',
    attrs: { 成色: '95新', 尺码: '170' }, tags: ['毕业季']
  });
  L('dachuan', 'graduation', '毕业清仓 | 小冰箱 白菜价', 99, 'p05', {
    desc: '毕业打包价，比专区更低，本周末前带走再减 10 元。',
    attrs: { 成色: '8成新' }, tags: ['毕业季', '清仓']
  });
  L('zhouye', 'graduation', '毕业出 | 台灯 + 桌面收纳架', 30, 'p09', {
    desc: '一起打包 30，宿舍自提，收纳架基本全新。',
    attrs: { 成色: '9成新' }, tags: ['毕业季']
  });
  L('gaoyuan', 'graduation', '毕业出 | 民谣吉他 附全套配件', 200, 'p06', {
    desc: '毕业出琴，比常规价低，送琴包变调夹拨片。',
    attrs: { 成色: '9成新' }, tags: ['毕业季', '乐器']
  });

  // —— 物品租借 ——
  L('jiaqi', 'rental', '学士服出租 毕业照神器', 15, 'p16', {
    priceUnit: '天', tradeMode: 'rent', desc: '毕业照档期紧俏，建议提前一天约。含帽子流苏，拍完清洗归还。',
    attrs: { 押金: '50 元', 起租: '1 天', 尺码: '160-175 可选' }, tags: ['租借', '毕业季']
  });
  L('suxiao', 'rental', '拍立得出租 含 10 张相纸', 20, 'p14', {
    priceUnit: '天', tradeMode: 'rent', desc: '出片即取，校园内可送货上门，超适合社团活动跟拍。',
    attrs: { 押金: '300 元', 起租: '1 天' }, tags: ['租借', '相机']
  });
  L('gaoyuan', 'rental', '民谣吉他出租 新手试学', 10, 'p06', {
    priceUnit: '天', tradeMode: 'rent', desc: '想学琴先租着试试，含变调夹拨片，教学视频可分享。',
    attrs: { 押金: '200 元', 起租: '3 天' }, tags: ['租借', '乐器']
  });
  L('zhouye', 'rental', '羽毛球拍出租 打球应急', 5, 'p15', {
    priceUnit: '天', tradeMode: 'rent', desc: '临时约球没带拍？体育馆门口取还，超方便。',
    attrs: { 押金: '50 元', 起租: '1 天' }, tags: ['租借', '运动']
  });
  L('dachuan', 'rental', '山地车出租 月租更划算', 8, 'p02', {
    priceUnit: '天', tradeMode: 'rent', desc: '通勤代步 / 周末骑行都可以，车况良好，含车锁。',
    attrs: { 押金: '300 元', 月租: '150 元/月' }, tags: ['租借', '骑行']
  });

  // —— 以物换物 ——
  L('jiaqi', 'barter', '多肉换绿萝 / 手账文具', 0, 'p17', {
    tradeMode: 'barter', desc: '想给窗台换个品种，手账文具也可以，差价可商量。',
    attrs: { 想换: '绿萝、手账胶带', 我的物品: '多肉三盆' }, tags: ['换物']
  });
  L('gaoyuan', 'barter', '手办换高达模型 / 盲盒', 0, 'p12', {
    tradeMode: 'barter', desc: '重复款换新收藏，盒况完美，可当面看货。',
    attrs: { 想换: '高达、盲盒', 我的物品: '动漫手办' }, tags: ['换物', '二次元']
  });
  L('manman', 'barter', '考研教材换四级真题', 0, 'p01', {
    tradeMode: 'barter', desc: '书换书，我的都有笔记，正好互补一下。',
    attrs: { 想换: '四级真题册', 我的物品: '考研教材' }, tags: ['换物', '学习']
  });
  L('suxiao', 'barter', '化妆刷套装换发饰 / JK', 0, 'p11', {
    tradeMode: 'barter', desc: '全新化妆刷，想换点可爱的小东西，看图聊！',
    attrs: { 想换: '发饰、JK 相关', 我的物品: '化妆刷套装' }, tags: ['换物', '美妆']
  });

  // —— 校园拼团 ——
  const lSnack = L('yinuo', 'group', '宿舍零食大礼包拼团 满 10 人', 19.9, 'p22', {
    tradeMode: 'group', priceUnit: '份', desc: '一整箱零食 19.9 起，薯片辣条巧克力都有，成团后统一配送到南区快递中心，拼不成自动退款。',
    attrs: { 成团人数: '10 人', 已参团: '7 人', 截止: '明天 20:00', 取货点: '南区快递中心' }, tags: ['拼团', '零食']
  });
  L('yinuo', 'group', '多肉盆栽拼团 满 8 人成团', 9.9, 'p17', {
    tradeMode: 'group', priceUnit: '盆', desc: '从花卉市场直发，比店里便宜一半，宿舍养起来！',
    attrs: { 成团人数: '8 人', 已参团: '5 人', 截止: '后天 12:00' }, tags: ['拼团', '绿植']
  });
  L('yinuo', 'group', '蓝牙耳机拼团 厂家直发', 89, 'p03', {
    tradeMode: 'group', priceUnit: '副', desc: '团长谈的厂家渠道，7 天无理由退换，性价比拉满。',
    attrs: { 成团人数: '20 人', 已参团: '13 人', 截止: '本周日' }, tags: ['拼团', '数码']
  });
  L('yinuo', 'group', '美妆蛋 + 化妆棉拼团', 12.9, 'p11', {
    tradeMode: 'group', priceUnit: '套', desc: '消耗品囤货团，亲测好用，拼满就发。',
    attrs: { 成团人数: '15 人', 已参团: '9 人', 截止: '明天 22:00' }, tags: ['拼团', '美妆']
  });

  // —— 游戏账号 ——
  L('gaoyuan', 'game', '王者荣耀 全英雄 98 皮肤 微信区', 1500, 'p19', {
    priceUnit: '个', desc: '毕业不玩了，全英雄满铭文，皮肤 98 款含典藏。走平台担保交易，改绑成功后确认收货。',
    attrs: { 区服: '微信区', 段位: '最强王者', 皮肤: '98 款', 绑定: '支持换绑', 担保: '平台担保交易' },
    tags: ['游戏账号', '王者荣耀']
  });
  L('gaoyuan', 'game', '和平精英 王牌号 稀有套装', 800, 'p21', {
    priceUnit: '个', desc: '限定套装 3 套，热力值 6w+。支持视频验号，担保交易更放心。',
    attrs: { 区服: '微信区', 段位: '王牌 5 星', 稀有: '限定套装 3 套', 担保: '平台担保交易' },
    tags: ['游戏账号', '和平精英']
  });
  L('gaoyuan', 'game', '吃鸡神器 | 手游外设手柄 + 键盘', 180, 'p13', {
    desc: '物理外设，吃鸡上分利器，手感调教好了直接能用。',
    attrs: { 成色: '95新', 适配: '主流手游' }, tags: ['游戏', '外设']
  });

  // —— 代拿代跑 ——
  L('manman', 'errand', '代拿快递 3 元/件 南区快递中心', 3, 'p20', {
    priceUnit: '单', tradeMode: 'service', desc: '本人靠谱，每天中午晚上各跑一趟南区快递中心，大件可帮搬（加价）。',
    attrs: { 服务费: '3 元/件', 时段: '今日 12:00-21:00', 大件: '另议' }, tags: ['跑腿', '快递']
  });
  L('zhouye', 'errand', '代拿外卖 / 奶茶 2 元/单', 2, 'p23', {
    priceUnit: '单', tradeMode: 'service', desc: '懒人福音，外卖到了不想下楼？我帮你取送到楼下。',
    attrs: { 服务费: '2 元/单', 时段: '全天', 范围: '校内各宿舍楼' }, tags: ['跑腿', '外卖']
  });
  L('yinuo', 'errand', '代买食堂饭 3 元/单 第一食堂', 3, 'c01', {
    priceUnit: '单', tradeMode: 'service', desc: '下课高峰排队太长？说好菜单我帮你带，饭卡 / 微信均可代付。',
    attrs: { 服务费: '3 元/单', 时段: '午/晚餐', 范围: '第一食堂' }, tags: ['跑腿', '食堂']
  });
  L('dachuan', 'errand', '大件搬运 / 代取 8 元起', 8, 'p20', {
    priceUnit: '单', tradeMode: 'service', desc: '有电动车，快递大件、搬宿舍都能帮，价格按距离协商。',
    attrs: { 服务费: '8 元起', 时段: '周末全天' }, tags: ['跑腿', '搬运']
  });

  // —— 失物招领 ——
  L('jiaqi', 'lost', '招领 | 图书馆三楼捡到一串钥匙', 0, 'p24', {
    tradeMode: 'free', desc: '带蓝色挂绳的钥匙一串，已交到三楼服务台，失主快去认领！',
    attrs: { 类型: '招领', 地点: '图书馆三楼' }, tags: ['失物招领']
  });
  L('manman', 'lost', '寻物 | 操场丢失黑色耳机盒', 0, 'c03', {
    tradeMode: 'free', desc: '昨晚跑步丢的，里面有耳机，对我很重要，捡到的同学请联系我！',
    attrs: { 类型: '寻物', 地点: '南区操场' }, tags: ['寻物']
  });
  L('suxiao', 'lost', '招领 | 捡到校园卡一张', 0, 'c02', {
    tradeMode: 'free', desc: '在图书馆门口捡到校园卡，私信核对姓氏和照片后认领。',
    attrs: { 类型: '招领', 地点: '图书馆门口' }, tags: ['失物招领']
  });

  // —— 校园服务 ——
  L('yichen', 'service', '电脑清灰 / 装系统 / 软件安装 20 起', 20, 'p25', {
    priceUnit: '次', tradeMode: 'service', desc: '专业工具齐全，清灰 + 换硅脂 + 装系统一条龙，可宿舍上门。',
    attrs: { 服务: '清灰 / 装系统', 价格: '20 元起', 时长: '约 30 分钟' }, tags: ['服务', '数码']
  });
  L('suxiao', 'service', '证件照精修 / 校园写真跟拍 30 起', 30, 'p14', {
    priceUnit: '次', tradeMode: 'service', desc: '会摄影会修图，证件照换底色精修，毕业写真也可以约～',
    attrs: { 服务: '证件照 / 写真', 价格: '30 元起' }, tags: ['服务', '摄影']
  });
  L('manman', 'service', '高数 / 线代 期末冲刺辅导 25/时', 25, 'p01', {
    priceUnit: '小时', tradeMode: 'service', desc: '高数 90+，讲题耐心，可以先来一节试听，期末冲一冲。',
    attrs: { 科目: '高数 / 线代', 价格: '25 元/小时' }, tags: ['服务', '辅导']
  });

  /* ================= 圈子 ================= */
  const C = {};
  const circles = [
    ['flea', '跳蚤市场', 'bag', '#FF7043', '校内闲置流转第一站，买卖换物都来这', 1286],
    ['study', '学习交流', 'pen', '#26A69A', '考研 / 考证 / 课程经验，一起上岸', 964],
    ['food', '吃喝玩乐', 'cup', '#FFA726', '食堂测评 / 探店 / 拼单，吃好喝好', 1420],
    ['sport', '运动健身', 'ball', '#29B6F6', '约球 / 夜跑 / 健身打卡，动起来', 738],
    ['lost', '失物招领', 'key', '#78909C', '丢东西、捡到东西都发这里', 512],
    ['tree', '吐槽树洞', 'moon', '#7C4DFF', '校园日常 / 吐槽 / 树洞，友善发言', 1103]
  ];
  for (const [key, name, icon, color, desc, memberBase] of circles) {
    C[key] = db.insert('circles', { name, icon, color, desc, memberBase, sort: circles.findIndex((c) => c[0] === key) });
  }

  /* ================= 帖子 ================= */
  function P(circleKey, authorKey, content, imgs, topics, likeBase, minsAgo, comments, likedBy) {
    const post = db.insert('posts', {
      circleId: C[circleKey].id, authorId: U[authorKey].id, content,
      images: (imgs || []).map((i) => '/static/img/' + i + '.jpg'),
      topics: topics || [], likes: (likedBy || []).map((k) => U[k].id),
      likeBase: likeBase || 0, commentCount: 0, createdAt: ago(minsAgo * MIN)
    });
    for (const [uk, text, mins] of (comments || [])) {
      db.insert('comments', { postId: post.id, authorId: U[uk].id, content: text, createdAt: ago(mins * MIN) });
    }
    post.commentCount = (comments || []).length;
    return post;
  }

  P('study', 'manman', '大二下的 Java 好难啊…求一起组队刷题的同学，图书馆四楼每晚见！', ['c02'], ['学习打卡', '组队'], 18, 260,
    [['yichen', '来！我正好在复习算法，明天四楼见', 210], ['jiaqi', '大一萌新可以围观吗 hhh', 120], ['manman', '欢迎欢迎，先进群～', 90]]);
  P('food', 'suxiao', '第一食堂新出的啵啵奶茶测评：9.9 还能免费加两份料，甜度建议三分！', ['c01'], ['食堂测评', '奶茶'], 56, 180,
    [['zhouye', '刚去试了，确实可以！', 150], ['yinuo', '下次拼单的话喊我', 60], ['suxiao', '好呀好呀', 40]], ['manman']);
  P('tree', 'manman', '毕业快乐。拍完毕业照才发现，原来四年这么快。', ['p16'], ['毕业季'], 120, 90,
    [['yichen', '毕业前记得请我们吃饭', 80], ['suxiao', '呜呜呜说到心坎里了', 60], ['zhouye', '祝前程似锦！', 30]], ['yichen', 'suxiao']);
  P('flea', 'gaoyuan', '新到的痛包挂件到货，有多余的想换同款不同色的，有人在收集吗？', ['p12'], ['好物分享', '换物'], 15, 300,
    [['manman', '包装好可爱！', 260]]);
  P('sport', 'zhouye', '今晚七点操场夜跑 5 公里，配速 6 分半左右，来偶遇。', ['c03'], ['夜跑打卡'], 27, 120,
    [['dachuan', '骑车给你加油可以吗哈哈', 100], ['zhouye', '你来我就给你看车', 80]]);
  P('study', 'jiaqi', '英语四级 500+ 经验贴：听力千万别放弃！附我的错题本整理方法。', ['c02'], ['考证', '经验贴'], 42, 400,
    [['manman', '收藏了，感谢分享！', 350], ['suxiao', '听力确实是拉分项', 300]]);
  P('tree', 'yichen', '宿舍楼下的猫又双叒来蹭饭了，谁家的快领走（不是）。', ['p23'], ['校园猫'], 88, 200,
    [['jiaqi', '我今天刚喂过它！', 180], ['suxiao', '它只吃鸡胸肉谢谢', 150]]);
  P('flea', 'yinuo', '拼团记录：宿舍零食柜已满仓，这周开了 3 个团，感谢同学们！', ['p22'], ['拼团'], 20, 240,
    [['manman', '团长辛苦了！', 200]]);
  P('food', 'zhouye', '清远大学城周边外卖红黑榜（个人向），踩雷的我都标出来了。', [], ['外卖', '测评'], 33, 500,
    [['dachuan', '真实测评，点赞', 480]]);
  P('sport', 'dachuan', '骑行社周末拉练清远大道路线，全程 30 公里，一起吗？', ['p02'], ['骑行'], 14, 360,
    [['zhouye', '报名！', 340]]);
  P('lost', 'jiaqi', '图书馆三楼捡到一串钥匙（蓝色挂绳），已交服务台～', ['p24'], ['失物招领'], 8, 320);
  P('lost', 'manman', '在南区操场丢了黑色耳机盒，里面有耳机，捡到的求联系！', ['c03'], ['寻物'], 6, 150);
  P('tree', 'suxiao', '期末周图书馆占座好严重……早八人也想有个座 QAQ', [], ['吐槽', '期末'], 64, 420,
    [['manman', '同感，只能去教学楼自习了', 400]]);
  P('study', 'yichen', '分享一份期末复习时间表模板，按 45 分钟一个番茄钟排的。', [], ['学习打卡', '模板'], 12, 700,
    [['jiaqi', '求模板！', 680]]);
  P('flea', 'manman', '整理了一下我的考研书单，政英数全都有，需要的同学评论区蹲。', ['p01'], ['考研', '好物分享'], 23, 800,
    [['jiaqi', '蹲一个专业课的！', 760], ['manman', '私聊发你～', 700]]);
  P('tree', 'gaoyuan', '宿舍改造完工！灯带一开直接起飞，显示器挂墙真香。', ['p13'], ['宿舍改造'], 45, 900,
    [['yichen', '走线怎么藏的？', 860], ['gaoyuan', '走明线扣，便宜好装', 840]]);

  /* ================= 会话与消息 ================= */
  function conv(keyA, keyB, msgs) {
    const a = U[keyA].id, b = U[keyB].id;
    const c = db.insert('conversations', { members: [a, b], lastMessage: '', lastTime: ago(msgs[msgs.length - 1][3] * MIN) });
    let last = null;
    msgs.forEach(([senderKey, type, content, mins, card], idx) => {
      const isLast = idx === msgs.length - 1;
      last = db.insert('messages', Object.assign({
        convId: c.id, senderId: U[senderKey].id, type, content: content || '',
        card: card || null,
        createdAt: ago(mins * MIN),
        readBy: isLast ? [U[senderKey].id] : [a, b]
      }));
    });
    c.lastMessage = last.type === 'listing' ? '[商品] ' + (last.card && last.card.title || '') :
      last.type === 'image' ? '[图片]' : last.content;
    return c;
  }

  conv('manman', 'yichen', [
    ['manman', 'text', '你好，降噪耳机还在吗？想收来考研用', 320],
    ['yichen', 'text', '在的，95 新，配件齐全，可以小刀', 318],
    ['manman', 'text', '700 出吗？', 300],
    ['yichen', 'text', '730 就出，送你一套全新耳套', 290],
    ['manman', 'text', '成交！明天下午图书馆门口面交可以吗', 45],
    ['yichen', 'text', '可以，4 点见，到时我提前喊你', 12]
  ]);
  conv('manman', 'suxiao', [
    ['suxiao', 'text', '姐妹，化妆刷套装还可以换吗？我看中你说的那只口红了', 1600],
    ['manman', 'text', '可以的！你发饰的图我看看', 1580],
    ['suxiao', 'image', '/static/img/p11.jpg', 1575],
    ['manman', 'text', '好看！下午宿舍楼下换？', 1500]
  ]);
  conv('manman', 'yinuo', [
    ['yinuo', 'text', '零食团还差 3 人就成团啦，你参团的那份今晚锁单', 200],
    ['manman', 'text', '好嘞，成团记得喊我', 150],
    ['yinuo', 'text', '没问题！成团后统一送到南区快递中心～', 30]
  ]);
  conv('manman', 'gaoyuan', [
    ['manman', 'text', '手办可以小小刀吗，学生党预算有限', 2400],
    ['gaoyuan', 'text', '85 最高啦，盒子完美的那种', 2390],
    ['manman', 'text', '我再想想～', 2380]
  ]);
  conv('manman', 'ai', [
    ['ai', 'text', '你好呀，我是科贸小鱼的 AI 客服「小校助手」。发布闲置、下单支付、订单售后、拼团玩法，有任何问题都可以问我！', 5000],
    ['manman', 'text', '怎么发布商品呀？', 4900],
    ['ai', 'text', '点击底部中间的「+」按钮，选择交易分区，上传图片、填好标题和价格就可以发布啦。', 4899],
    ['manman', 'text', '钱是怎么结算的？', 4800],
    ['ai', 'text', '买家付款后钱款由平台托管，确认收货后才会打给卖家，交易全程有保障。遇到问题随时找我～', 4799]
  ]);
  conv('yichen', 'zhouye', [
    ['zhouye', 'text', '键盘还在吗？想收个茶轴试试', 900],
    ['yichen', 'text', '刚出掉啦，手柄键盘套装还有一套', 880],
    ['zhouye', 'text', '那我看看套装', 860]
  ]);
  conv('yinuo', 'suxiao', [
    ['suxiao', 'text', '美妆蛋团帮我留两份！', 400],
    ['yinuo', 'text', '收到，明晚 10 点截团提醒你', 380]
  ]);

  /* ================= 订单 ================= */
  function order(buyerKey, sellerKey, listing, status, minsAgo, extra) {
    const t = (label, mins, note) => ({ status: label, time: ago(mins * MIN), note: note || '' });
    const o = db.insert('orders', Object.assign({
      orderNo: 'CY' + String(NOW).slice(-8) + rand(100, 999),
      buyerId: U[buyerKey].id, sellerId: U[sellerKey].id, listingId: listing.id,
      snapshot: { title: listing.title, image: listing.images[0], price: listing.price, priceUnit: listing.priceUnit, zone: listing.zone },
      qty: 1, amount: listing.price, payAmount: listing.price,
      status, payType: null, tradeMethod: '校内面交', location: listing.location,
      remark: '', timeline: [], createdAt: ago(minsAgo * MIN)
    }, extra || {}));
    return { o, t };
  }
  {
    const { o: o1, t } = order('manman', 'yichen', lHeadset, 'paid', 700, { payType: 'balance', remark: '明天 16:00 图书馆门口面交' });
    o1.timeline = [t('created', 700), t('paid', 690, '余额支付 ¥780.00')];
  }
  {
    const { o: o2, t } = order('zhouye', 'gaoyuan', lPad, 'shipped', 1300, { payType: 'wxpay' });
    o2.timeline = [t('created', 1300), t('paid', 1290, '微信支付 ¥180.00'), t('shipped', 900, '卖家已发货，物流：校内自提柜')];
  }
  {
    const { o: o3, t } = order('jiaqi', 'manman', lLamp, 'done', 4000, { payType: 'balance' });
    o3.timeline = [t('created', 4000), t('paid', 3990, '余额支付 ¥35.00'), t('shipped', 3600, '卖家已交付'), t('done', 3400, '买家已确认收货')];
  }
  {
    const { o: o4, t } = order('manman', 'yinuo', lSnack, 'pending', 90, { remark: '参团：宿舍零食大礼包 ×1' });
    o4.timeline = [t('created', 90)];
  }
  {
    const { o: o5, t } = order('suxiao', 'yichen', lMonitor, 'refunding', 2600, { payType: 'wxpay', remark: '临时不想要了，麻烦老板同意下' });
    o5.timeline = [t('created', 2600), t('paid', 2590, '微信支付 ¥520.00'), t('refunding', 300, '买家申请退款：临时不想要了')];
  }
  {
    const { o: o6, t } = order('dachuan', 'manman', lFridge, 'canceled', 5200, {});
    o6.timeline = [t('created', 5200), t('canceled', 5000, '买家取消：拍错了')];
  }
  {
    const { o: o7, t } = order('gaoyuan', 'zhouye', lRacket, 'done', 7000, { payType: 'balance' });
    o7.timeline = [t('created', 7000), t('paid', 6990, '余额支付 ¥85.00'), t('shipped', 6800, '卖家已交付'), t('done', 6600, '买家已确认收货')];
  }

  /* ================= 钱包流水 ================= */
  function tx(userKey, type, amount, note, minsAgo, balanceAfter) {
    db.insert('transactions', { userId: U[userKey].id, type, amount, note, balanceAfter, createdAt: ago(minsAgo * MIN) });
  }
  tx('manman', 'recharge', 120000, '充值', 8000, 120000);
  tx('manman', 'pay', -73000, '购买「索尼头戴式降噪耳机」', 690, 47000);
  tx('manman', 'income', 3500, '卖出「小米护眼台灯」', 3400, 50500);
  tx('yichen', 'income', 18000, '卖出「八位堂手柄 + 机械键盘」', 1290, 30000);
  tx('yichen', 'pay', -1300, '卖出「机械键盘 87 键」扣除平台服务费', 5000, 12000);
  tx('jiaqi', 'recharge', 10000, '充值', 6000, 13500);
  tx('jiaqi', 'pay', -3500, '购买「小米护眼台灯」', 3990, 10000);
  tx('jiaqi', 'income', 3500, '卖出「碳素羽毛球拍」', 6600, 9800);

  /* ================= 收藏 / 浏览 / 关注 / 地址 ================= */
  function fav(userKey, type, targetId, minsAgo) {
    db.insert('favorites', { userId: U[userKey].id, targetType: type, targetId, createdAt: ago(minsAgo * MIN) });
  }
  fav('manman', 'listing', lMonitor.id, 3000);
  fav('manman', 'listing', lBike.id, 2600);
  fav('manman', 'listing', lFigure.id, 900);
  fav('manman', 'listing', lGuitar.id, 500);
  fav('manman', 'post', 2, 200);
  fav('manman', 'post', 3, 100);
  fav('yichen', 'listing', lTablet.id, 1200);
  fav('jiaqi', 'listing', lFigure.id, 800);
  fav('zhouye', 'listing', lBike.id, 700);

  function his(userKey, listing, minsAgo) {
    db.insert('histories', { userId: U[userKey].id, listingId: listing.id, viewedAt: ago(minsAgo * MIN) });
  }
  his('manman', lMonitor, 200);
  his('manman', lBike, 600);
  his('manman', lCase, 1500);
  his('manman', lTablet, 45);
  his('manman', lGuitar, 30);

  function follow(a, b) { db.insert('follows', { userId: U[a].id, targetUserId: U[b].id, createdAt: ago(rand(1, 20) * DAY) }); }
  follow('manman', 'yichen'); follow('manman', 'suxiao'); follow('manman', 'yinuo');
  follow('yichen', 'manman'); follow('suxiao', 'manman'); follow('zhouye', 'manman');
  follow('yinuo', 'manman'); follow('gaoyuan', 'manman'); follow('jiaqi', 'manman');

  db.insert('addresses', { userId: U.manman.id, name: '林小满', phone: '138****6733', area: '广东科贸职业学院（清远校区）', detail: '学生宿舍 1 栋 302 室', isDefault: true });
  db.insert('addresses', { userId: U.manman.id, name: '林小满', phone: '138****6733', area: '广东科贸职业学院（清远校区）', detail: '南区快递中心代收点', isDefault: false });

  /* ================= 举报示例 ================= */
  db.insert('reports', {
    reporterId: U.jiaqi.id, targetType: 'listing', targetId: lTablet.id,
    reason: '虚假信息 / 货不对板', detail: '图片看起来太新了，怀疑是网图', status: 'pending'
  });

  /* ================= 公告 ================= */
  db.insert('notices', { title: '【平台公告】科贸小鱼正式上线啦', content: '欢迎来到科贸小鱼！这里不止二手闲置，还有代拿代跑、校园拼团、物品租借、以物换物……完善个人资料即可开始交易，祝大家都能淘到宝～', createdAt: ago(3 * DAY) });
  db.insert('notices', { title: '【安全提醒】贵重物品请务必校内面交', content: '涉及数码产品、游戏账号等贵重交易，请选择平台担保交易或在校园内公共区域面交，谨防线下转账诈骗。', createdAt: ago(2 * DAY) });
  db.insert('notices', { title: '【毕业季专区】开启毕业清仓通道', content: '毕业季专区已上线：教材、行李、小家电一键发布，标注「毕业清仓」可获得双倍曝光。', createdAt: ago(1 * DAY) });

  db.flush();
  return data;
}

if (require.main === module) {
  build();
  console.log('seed done: users=' + db.get('users').length + ', listings=' + db.get('listings').length + ', posts=' + db.get('posts').length + ', messages=' + db.get('messages').length + ', orders=' + db.get('orders').length);
}

module.exports = { build, NOW };
