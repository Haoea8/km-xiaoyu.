const app = getApp();

Component({
  data: {
    selected: 0,
    unread: 0,
    /**
     * 注意：list 是「视觉顺序」，中间多了发布按钮（key=publish），
     * 所以它的下标和 app.json 里 tabBar.list 的下标并不一致。
     * 高亮一律按 key / pagePath 反查，页面不要传下标。
     */
    list: [
      { pagePath: '/pages/index/index', text: '首页', key: 'home' },
      { pagePath: '/pages/circle/circle', text: '圈子', key: 'circle' },
      { pagePath: '', text: '', key: 'publish' },
      { pagePath: '/pages/message/message', text: '消息', key: 'message' },
      { pagePath: '/pages/profile/profile', text: '我的', key: 'mine' }
    ]
  },

  lifetimes: {
    attached() {
      app.tabbar = this;
      // 此刻页面路由可能还没注册，syncSelected 内部会自行重试
      this.syncSelected();
      this.syncUnread();
    },
    detached() { if (app.tabbar === this) app.tabbar = null; }
  },

  pageLifetimes: {
    show() {
      this.syncSelected();
      // 每个 tab 页面各有一个 tabBar 组件实例，而 app.setBadge() 只会更新
      // 「最近 attached 的那个」。若不在这里重新同步，未读数清零后
      // 别的实例仍会挂着旧红点（例如登出后消息 tab 还显示红点）。
      this.syncUnread();
    }
  },

  methods: {
    /** 从全局状态同步未读数（切页时调用，保证不会残留旧红点） */
    syncUnread() {
      // 用 totalUnread()：角标汇总「私信 + 互动消息」两类未读，
      // 直接读 globalData.unread 会漏掉互动那部分。
      const n = typeof app.totalUnread === 'function'
        ? app.totalUnread()
        : (app.globalData.unread || 0);
      if (n !== this.data.unread) this.setData({ unread: n });
    },

    /** 供 app.setBadge() 调用，语义更明确 */
    setUnread(n) {
      const v = Number(n) || 0;
      if (v !== this.data.unread) this.setData({ unread: v });
    },
    /** 页面 onShow 时主动调用，最可靠：按 key 定位高亮 */
    setActive(key) {
      const idx = this.data.list.findIndex((it) => it.key === key);
      if (idx > -1 && idx !== this.data.selected) {
        this.setData({ selected: idx });
      }
    },

    /**
     * 兜底：按当前页面路由反查高亮。
     * 组件生命周期里 getCurrentPages() 可能为空或 route 尚未就绪，
     * 因此失败时做一次短延迟重试，避免高亮停留在初始值。
     */
    syncSelected(retried) {
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1] : null;
      const route = cur && cur.route ? '/' + cur.route : '';

      if (route) {
        const idx = this.data.list.findIndex((it) => it.pagePath === route);
        if (idx > -1) {
          if (idx !== this.data.selected) this.setData({ selected: idx });
          return;
        }
      }

      if (!retried) {
        setTimeout(() => this.syncSelected(true), 80);
      }
    },

    onTap(e) {
      const { index, item } = e.currentTarget.dataset;
      if (item.key === 'publish') {
        if (!app.guard()) return;
        wx.navigateTo({ url: '/pages/publish/publish' });
        return;
      }

      const target = Number(index);
      const current = this.data.selected;

      // 点的是当前页：无需切换
      if (target === current) return;

      // 先本地点亮（setData 会同步改 this.data.selected，
      // 所以上面必须先用 current 判断完，否则这里会把判断结果改掉）
      this.setActive(item.key);

      wx.switchTab({
        url: item.pagePath,
        fail: () => this.syncSelected(true)
      });
    }
  }
});
