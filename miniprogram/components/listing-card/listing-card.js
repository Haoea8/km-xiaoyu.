const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONE_MAP, TRADE_MODES } = require('../../utils/const');

Component({
  options: { addGlobalClass: true },
  properties: {
    item: { type: Object, value: null },
    /** 布局：grid（瀑布流卡片）/ row（横向列表） */
    mode: { type: String, value: 'grid' },
    /** 是否显示卖家信息 */
    showSeller: { type: Boolean, value: true }
  },
  data: {
    cover: '',
    /** 卖家头像（已转成云存储路径）。wxml 不能直接用 item.seller.avatar，
        因为里面存的是 /static/avatars/xx.jpg 这类相对路径，必须过 api.abs。 */
    sellerAvatar: '',
    priceText: '0',
    zone: null,
    modeText: '',
    soldOut: false
  },
  observers: {
    item(v) {
      if (!v) return;
      const zone = ZONE_MAP[v.zone] || null;
      this.setData({
        cover: api.abs((v.images && v.images[0]) || ''),
        sellerAvatar: api.abs((v.seller && v.seller.avatar) || ''),
        priceText: util.fmtPrice(v.price),
        zone,
        modeText: TRADE_MODES[v.tradeMode] || '',
        soldOut: v.status === 'sold' || v.status === 'off'
      });
    }
  },
  methods: {
    onTap() {
      const it = this.data.item;
      if (!it) return;
      wx.navigateTo({ url: '/pages/detail/detail?id=' + it.id });
    }
  }
});
