Component({
  options: { multipleSlots: true, addGlobalClass: true },
  properties: {
    title: { type: String, value: '' },
    /** 是否显示返回键 */
    back: { type: Boolean, value: true },
    /** 透明底色（首页用） */
    transparent: { type: Boolean, value: false },
    /** 白色文字（深色背景上） */
    light: { type: Boolean, value: false },
    /** 底部是否需要 1px 分割线 */
    line: { type: Boolean, value: false }
  },
  data: {
    statusBarHeight: 20,
    navBarHeight: 64,
    /**
     * 右侧插槽距屏幕右边缘的距离（px）。
     *
     * ⚠️ 默认值 16 是「什么都不考虑」的写法，而微信**胶囊按钮**（···和◎）就钉在右上角，
     * 胶囊宽约 87px、距右约 7px —— 所以右边距 16rpx(≈8px) 的插槽内容
     * 会**正好被胶囊压住**：点不到、看着像被截断。发布页的「发布」、
     * 圈子页的「发帖」、资料页的「上传」等 9 个页面都是这个症状。
     *
     * 解法：用 getMenuButtonBoundingClientRect() 拿到胶囊左边界，
     * 把插槽右移到「胶囊左边再留 8px」。
     */
    rightPad: 16
  },
  lifetimes: {
    attached() {
      const app = getApp();
      const patch = {
        statusBarHeight: app.globalData.statusBarHeight,
        navBarHeight: app.globalData.navBarHeight
      };
      try {
        const r = wx.getMenuButtonBoundingClientRect();
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        if (r && r.left > 0 && win && win.windowWidth > 0) {
          // 右边距 = 屏幕宽 - 胶囊左边界 + 8px 间隙
          patch.rightPad = Math.max(8, Math.round(win.windowWidth - r.left + 8));
        }
      } catch (e) { /* 拿不到胶囊信息时保留默认值，不影响渲染 */ }
      this.setData(patch);
    }
  },
  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/index/index' });
    }
  }
});
